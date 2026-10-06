// IMD Tools relay: lets the browser read IMD's public API from this site's own domain.
// IMD only allows cross-site reads on a few routes, so the site asks this function instead.
// Reads only (GET), plus the free, no-payment quote check used by the request builder.
import { randomBytes, randomUUID } from 'node:crypto';

const IMD = 'https://api.imd.fun';
const READ = [
  /^swarm$/, /^health$/, /^skills$/, /^jobs$/, /^jobs\/[0-9a-f-]{36}(\/(result|submissions|panel|records|assessments))?$/,
  /^workflows(\/[0-9a-f-]{36})?$/, /^launches(\/[0-9a-f-]{36})?$/, /^publications$/, /^sites$/,
  /^oracle\/requests(\/[0-9a-f-]{36}(\/attestation)?)?$/, /^seats\/(records|owners)$/, /^seats\/\d{1,6}(\/standing)?$/,
  /^workers$/, /^contributors$/,
  /^wallets\/0x[0-9a-fA-F]{40}\/earnings$/, /^pair\/wallet\/0x[0-9a-fA-F]{40}$/, /^requests\/capabilities$/,
];
// Seconds a copy of each IMD answer is reused inside this server. Nothing is cached by the CDN,
// so visitors always get data at most this old; IMD is spared repeat requests.
const CACHE = { swarm: 8, 'seats/owners': 60, skills: 600, workers: 10, contributors: 30 };
const memo = new Map(); // key -> { t, status, body }
async function cachedUpstream(key, url, ttlSec) {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.t < ttlSec * 1000) return hit;
  const r = await upstream(url);
  const entry = { t: Date.now(), status: r.status, body: await r.text(), retryAfter: r.headers.get('retry-after') };
  if (r.ok) memo.set(key, entry);
  else if (hit) return { ...hit, stale: true }; // IMD failed: keep serving the last good answer
  if (memo.size > 500) memo.delete(memo.keys().next().value);
  return entry;
}
const NO_CDN = 'no-store, max-age=0';
const EDGE = 'public, max-age=0, s-maxage=20, stale-while-revalidate=120';
// IMD's own edge keeps stale copies (and sometimes stored errors) of a few plain addresses.
// Adding a parameter that changes every 5 seconds makes IMD compute them fresh.
const FRESH = new Set(['swarm', 'seats/owners', 'seats/records', 'health', 'workers', 'contributors']);
const freshen = (path, q) => (FRESH.has(path) ? [q, `_t=${Math.floor(Date.now() / 5000)}`].filter(Boolean).join('&') : q);
const HEADERS = { Accept: 'application/json', 'User-Agent': 'IMD-Tools/1.1 (community front end; +https://imd.fun/docs/)' };

// One upstream call, retried once on rate limits, server errors and network failures.
async function upstream(url, init = {}) {
  let last;
  for (let i = 0; i < 2; i++) {
    if (i) await new Promise((r) => setTimeout(r, 600));
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(url, { ...init, headers: { ...HEADERS, ...(init.headers || {}) }, signal: ctl.signal }).finally(() => clearTimeout(t));
      if (r.status !== 429 && r.status < 500) return r;
      last = r;
    } catch (e) { last = e; }
  }
  if (last instanceof Response) return last;
  throw last;
}

// Public Ethereum mainnet endpoints, tried in order, for treasury balances.
const RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.llamarpc.com', 'https://cloudflare-eth.com'];
async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctl.signal }).finally(() => clearTimeout(t));
      const j = await r.json();
      if (j && 'result' in j) return j.result;
      last = new Error(j?.error?.message || 'rpc_error');
    } catch (e) { last = e; }
  }
  throw last;
}
// The agents list only needs presence and version per agent; IMD's full list also carries every
// agent's skill names, which would make each refresh several hundred KB.
function slimWorkers(text) {
  try {
    const b = JSON.parse(text);
    const workers = (b.workers || []).map((w) => ({
      deviceKey: w.deviceKey, seat: w.seat, working: w.working, paused: w.paused, daemonVersion: w.daemonVersion,
      runtimes: (w.runtimes || []).map((r) => ({ id: r.id, version: r.version, model: r.premiumModel?.model })),
      skills: Array.isArray(w.skills) ? w.skills.length : null, maxConcurrency: w.maxConcurrency,
      connectedAt: w.connectedAt, lastHeartbeatAt: w.lastHeartbeatAt,
      platform: w.platform ? { os: w.platform.os || null, arch: w.platform.arch || null } : null,
    }));
    return JSON.stringify({ count: b.count ?? workers.length, at: Date.now(), workers });
  } catch { return text; }
}
// The newest IMD worker release, read from the worker repository's build record. Agents running
// anything else are on an older version.
let releaseCache = null; // { t, body }
async function latestWorker() {
  if (releaseCache && Date.now() - releaseCache.t < 300e3) return releaseCache.body;
  const r = await upstream('https://raw.githubusercontent.com/Identity-md/worker/main/build.json', { headers: { Accept: 'text/plain' } });
  if (!r.ok) { if (releaseCache) return releaseCache.body; throw new Error(`github_${r.status}`); }
  const b = JSON.parse(await r.text());
  if (typeof b.daemonVersion !== 'string') throw new Error('no_version');
  const body = { daemonVersion: b.daemonVersion, version: b.version || null, commit: b.sourceCommit || null, checkedAt: new Date().toISOString() };
  releaseCache = { t: Date.now(), body };
  return body;
}
const ADDR = /^0x[0-9a-f]{40}$/;
const SEATS = '0x0000ec93127baa929e58e97dd0095a2bfb38ec1d'; // IMD seat NFT collection (Ethereum mainnet)

// IMD's owner list is an array. To be certain which array position is which seat, compare it with
// ownerOf() read straight from the seat contract for a few seats, and keep the offset that matches.
let offsetCache = null; // { offset, at }
async function ownerOf(tokenId) {
  const hex = BigInt(tokenId).toString(16).padStart(64, '0');
  const r = await rpc('eth_call', [{ to: SEATS, data: '0x6352211e' + hex }, 'latest']);
  return r && r.length >= 66 ? '0x' + r.slice(-40).toLowerCase() : null;
}
async function verifiedOffset(list) {
  if (offsetCache && Date.now() - offsetCache.at < 6 * 3600e3) return offsetCache.offset;
  const samples = [1, 2, 3, 777, 1500];
  const truth = await Promise.all(samples.map((t) => ownerOf(t).catch(() => null)));
  for (const off of [0, 1, -1]) {
    let checked = 0, ok = 0;
    samples.forEach((t, i) => {
      if (!truth[i]) return;
      checked++;
      const a = list[t - off]; const addr = typeof a === 'string' ? a : a?.owner;
      if (addr && addr.toLowerCase() === truth[i]) ok++;
    });
    if (checked >= 3 && ok === checked) { offsetCache = { offset: off, at: Date.now() }; return off; }
  }
  return null; // could not confirm: callers must not map positions to seat numbers
}
async function treasury(address, token) {
  const pad = (a) => a.slice(2).padStart(64, '0');
  const [ethHex, tokHex, decHex, owners] = await Promise.all([
    rpc('eth_getBalance', [address, 'latest']).catch(() => null),
    token ? rpc('eth_call', [{ to: token, data: '0x70a08231' + pad(address) }, 'latest']).catch(() => null) : null,
    token ? rpc('eth_call', [{ to: token, data: '0x313ce567' }, 'latest']).catch(() => null) : null,
    cachedUpstream('seats/owners', `${IMD}/seats/owners?${freshen('seats/owners', '')}`, CACHE['seats/owners']).then((c) => (c.status === 200 ? JSON.parse(c.body) : null)).catch(() => null),
  ]);
  const list = Array.isArray(owners?.owners) ? owners.owners : [];
  const off = list.length ? await verifiedOffset(list).catch(() => null) : null;
  const seats = [];
  if (off !== null) list.forEach((o, i) => { const a = typeof o === 'string' ? o : o?.owner; if (a && a.toLowerCase() === address) seats.push(String(i + off)); });
  const heldHex = await rpc('eth_call', [{ to: SEATS, data: '0x70a08231' + pad(address) }, 'latest']).catch(() => null);
  const big = (h) => (h && h !== '0x' ? BigInt(h).toString() : null);
  return {
    address, at: new Date().toISOString(),
    ethWei: big(ethHex), token: token || null, tokenRaw: big(tokHex), tokenDecimals: decHex && decHex !== '0x' ? Number(BigInt(decHex)) : null,
    seats, seatsVerified: off !== null, seatsHeldOnChain: heldHex ? Number(BigInt(heldHex)) : null,
    seatsTotal: list.length || 2000, ownersAvailable: list.length > 0,
  };
}

export default async function handler(req, res) {
  const path = String(req.query.path || '').replace(/^\/+|\/+$/g, '');
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) if (k !== 'path') params.set(k, Array.isArray(v) ? v[0] : String(v));
  res.setHeader('X-Content-Type-Options', 'nosniff');

  try {
    if (req.method === 'GET' && path === '_status') {
      const started = Date.now();
      const r = await upstream(`${IMD}/version`).catch((e) => ({ status: 0, error: String(e?.message || e) }));
      res.setHeader('Cache-Control', 'no-store');
      return res.status(200).json({ relay: 'ok', imdStatus: r.status, ms: Date.now() - started, error: r.error || null });
    }
    if (req.method === 'GET' && path === 'worker/latest') {
      const body = await latestWorker();
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=120, stale-while-revalidate=600');
      return res.status(200).json(body);
    }
    if (req.method === 'GET' && path === 'treasury') {
      const address = String(req.query.address || '').toLowerCase();
      const token = String(req.query.token || '').toLowerCase();
      if (!ADDR.test(address) || (token && !ADDR.test(token))) return res.status(400).json({ error: 'invalid_address' });
      const body = await treasury(address, token || null);
      // Balances and seats change slowly; one read per half minute is shared by every visitor.
      res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=120');
      return res.status(200).json(body);
    }
    if (req.method === 'GET' && path === 'seats/owners') {
      const c = await cachedUpstream('seats/owners', `${IMD}/seats/owners?${freshen('seats/owners', '')}`, CACHE['seats/owners']);
      res.setHeader('Cache-Control', NO_CDN);
      if (c.status < 200 || c.status >= 300) return res.status(c.status).send(c.body);
      const body = JSON.parse(c.body);
      const list = Array.isArray(body.owners) ? body.owners : [];
      const tokenOffset = list.length ? await verifiedOffset(list).catch(() => null) : null; // tokenId = index + tokenOffset
      if (tokenOffset !== null) res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=30, stale-while-revalidate=120');
      return res.status(200).json({ tokenOffset, ...body });
    }
    if (req.method === 'GET') {
      if (!READ.some((r) => r.test(path))) return res.status(404).json({ error: 'not_allowed' });
      const q = params.toString();
      const ttl = CACHE[path] ?? (/attestation$/.test(path) ? 3600 : 10);
      const uq = freshen(path, q);
      const c = await cachedUpstream(`${path}?${q}`, `${IMD}/${path}${uq ? `?${uq}` : ''}`, ttl);
      if (c.retryAfter) res.setHeader('Retry-After', c.retryAfter);
      res.setHeader('Cache-Control', NO_CDN);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      // Good answers may be kept at Vercel's edge for a few seconds, so most visitors are answered at once.
      if (c.status === 200 && !c.stale) res.setHeader('Cache-Control', EDGE);
      if (path === 'workers' && c.status === 200) return res.status(200).send(slimWorkers(c.body));
      return res.status(c.status).send(c.body);
    }
    if (req.method === 'POST' && path === 'requests/quote') {
      const { action, input } = req.body || {};
      if (!['job.open', 'launch.open', 'workflow.open', 'oracle.request'].includes(action) || typeof input !== 'object') {
        return res.status(400).json({ error: 'invalid_request' });
      }
      if (JSON.stringify(input).length > 16000) return res.status(413).json({ error: 'too_large' });
      // A throwaway token: this only checks the request. Nothing is paid, and the order simply expires.
      const r = await fetch(`${IMD}/requests/quote`, {
        method: 'POST',
        headers: { ...HEADERS, Authorization: `Bearer ${randomBytes(32).toString('hex')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestKey: randomUUID(), action, input }),
      });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(r.status).send(await r.text());
    }
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    return res.status(502).json({ error: 'imd_unreachable', detail: String(e?.message || e).slice(0, 200) });
  }
}
