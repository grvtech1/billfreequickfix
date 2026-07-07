// /api/log.js — lightweight event log. Primary value: zero-result searches = your KB gap backlog.
// Body: { event: "search"|"open", q?: string, results?: number, id?: string }
import { kv, kvReady } from './_kv.js';
import { applyCors, denySecret, clientIp, rateLimited } from './_gate.js';

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (denySecret(req, res)) return;
  if (await rateLimited(clientIp(req), { max: 120, windowSec: 60 })) {
    return res.status(429).json({ error: 'rate limit' });
  }

  try {
    const { event, q, results, id } = req.body || {};
    if (event !== 'search' && event !== 'open') return res.status(400).json({ error: 'bad event' });
    console.log(JSON.stringify({ kind: 'event', t: Date.now(), event, q: (q || '').slice(0, 120), results, id }));

    if (kvReady) {
      if (event === 'search' && q) {
        const term = q.toLowerCase().slice(0, 80);
        await kv.zincr('stats:searches', term, 1).catch(() => {});
        if (typeof results === 'number' && results === 0) {
          await kv.zincr('stats:zero_results', term, 1).catch(() => {});  // the gap backlog
        }
      }
      if (event === 'open' && id) await kv.zincr('stats:opens', id, 1).catch(() => {});
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
