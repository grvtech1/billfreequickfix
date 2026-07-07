// /api/stats.js — read-only aggregates for the in-app Insights panel.
// Returns top searches, zero-result searches (KB gaps), most-opened records,
// per-record feedback, the re-authoring queue, and diagnose volume.
// If KV isn't configured, returns { ready:false } and the UI shows a setup hint.
import { kv, kvReady } from './_kv.js';
import { applyCors, denySecret } from './_gate.js';

export default async function handler(req, res) {
  if (applyCors(req, res, 'GET, OPTIONS')) return;
  // Insights expose internal search analytics + the re-authoring queue (which can
  // contain staff notes with customer MIDs/numbers) — require the shared secret.
  if (denySecret(req, res)) return;
  if (!kvReady) return res.status(200).json({ ready: false });

  const pairs = (flat) => {
    const out = [];
    const a = flat || [];
    for (let i = 0; i + 1 < a.length; i += 2) out.push({ k: a[i], n: Number(a[i + 1]) || 0 });
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
