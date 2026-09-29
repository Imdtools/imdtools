// IMD Tools relay: lets the browser read IMD's public API from this site's own domain.
// IMD only allows cross-site reads on a few routes, so the site asks this function instead.
// Reads only (GET), plus the free, no-payment quote check used by the request builder.
import { randomBytes, randomUUID } from 'node:crypto';

const IMD = 'https://api.imd.fun';
const READ = [
  /^swarm$/, /^health$/, /^skills$/, /^jobs$/, /^jobs\/[0-9a-f-]{36}(\/(result|submissions|panel|records|assessments))?$/,
  /^workflows(\/[0-9a-f-]{36})?$/, /^launches(\/[0-9a-f-]{36})?$/, /^publications$/, /^sites$/,
  /^oracle\/requests(\/[0-9a-f-]{36}(\/attestation)?)?$/, /^seats\/(records|owners)$/, /^seats\/\d{1,6}(\/standing)?$/,
  /^wallets\/0x[0-9a-fA-F]{40}\/earnings$/, /^pair\/wallet\/0x[0-9a-fA-F]{40}$/, /^requests\/capabilities$/,
];
const CACHE = { swarm: 10, 'seats/owners': 120, skills: 600 };

export default async function handler(req, res) {
  const path = String(req.query.path || '').replace(/^\/+|\/+$/g, '');
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query)) if (k !== 'path') params.set(k, Array.isArray(v) ? v[0] : String(v));
  res.setHeader('X-Content-Type-Options', 'nosniff');

  try {
    if (req.method === 'GET') {
      if (!READ.some((r) => r.test(path))) return res.status(404).json({ error: 'not_allowed' });
      const q = params.toString();
      const r = await fetch(`${IMD}/${path}${q ? `?${q}` : ''}`, { headers: { Accept: 'application/json' } });
      const body = await r.text();
      const ttl = CACHE[path] ?? (/attestation$/.test(path) ? 3600 : 15);
      res.setHeader('Cache-Control', r.ok ? `public, s-maxage=${ttl}, stale-while-revalidate=${ttl * 4}` : 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(r.status).send(body);
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
        headers: { Authorization: `Bearer ${randomBytes(32).toString('hex')}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestKey: randomUUID(), action, input }),
      });
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      return res.status(r.status).send(await r.text());
    }
    return res.status(405).json({ error: 'method_not_allowed' });
  } catch (e) {
    return res.status(502).json({ error: 'imd_unreachable' });
  }
}
