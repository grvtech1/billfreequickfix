// /api/kb.js — serves the knowledge base. Replaces the old world-readable
// public/billfree-kb.json static asset.
//
// Access model (fails CLOSED):
//   • Public records are returned to everyone.
//   • Records flagged `visibility: "internal"` are included ONLY when the caller
//     presents a valid KB_SHARED_SECRET (via the x-kb-secret header). If no secret
//     is configured, internal records are NEVER served — set KB_SHARED_SECRET (and
//     supply it on the client via ?k= or the KB_SECRET constant) to unlock them.
//
// The full KB (including internal records) lives in _kbdata.js, which is bundled
// into this function and is NOT under public/, so it can't be fetched directly.
import { applyCors, hasValidSecret } from './_gate.js';
import { KB } from './_kbdata.js';

export default function handler(req, res) {
  if (applyCors(req, res, 'GET, OPTIONS')) return;

  const authed = hasValidSecret(req);
  const records = authed ? KB.records : KB.records.filter((r) => r.visibility !== 'internal');

  // Never let a shared cache (CDN/browser) hold the authorized copy.
  res.setHeader('Cache-Control', 'private, no-store');
  return res.status(200).json({
    version: KB.version,
    updated: KB.updated,
    audience: KB.audience,
    schema: KB.schema,
    restricted: !authed,           // client can show "internal records hidden" if true
    records,
  });
}
