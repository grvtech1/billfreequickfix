// /api/stats.js — read-only aggregates for the in-app Insights panel.
// Returns top searches, zero-result searches (KB gaps), most-opened records,
// per-record feedback, the re-authoring queue, and diagnose volume.
// If KV isn't configured, returns { ready:false } and the UI shows a setup hint.
import { kv, kvReady } from './_kv.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!kvReady) return res.status(200).json({ ready: false });

  const pairs = (flat) => {
    const out = [];
    for (let i = 0; i < (flat || []).length; i += 2) out.push({ k: flat[i], n: Number(flat[i + 1]) });
    return out;
  };
  try {
    const [searches, zero, opens, diagnose, queue] = await Promise.all([
      kv.zrevrange('stats:searches', 0, 14),
      kv.zrevrange('stats:zero_results', 0, 19),
      kv.zrevrange('stats:opens', 0, 14),
      kv.hgetall('stats:diagnose'),
      kv.lrange('queue:reauthor', 0, 49),
    ]);
    return res.status(200).json({
      ready: true,
      topSearches: pairs(searches),
      zeroResults: pairs(zero),
      topOpens: pairs(opens),
      diagnoseByDay: diagnose || {},
      reauthorQueue: (queue || []).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean),
    });
  } catch (err) {
    return res.status(500).json({ ready: true, error: err.message });
  }
}
