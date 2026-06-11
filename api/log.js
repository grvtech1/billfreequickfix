// /api/log.js — lightweight event log. Primary value: zero-result searches = your KB gap backlog.
// Body: { event: "search"|"open", q?: string, results?: number, id?: string }
import { kv, kvReady } from './_kv.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  try {
    const { event, q, results, id } = req.body || {};
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
