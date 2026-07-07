# BillFree QuickFix — deploy guide

Search-first L1 troubleshooting console with live AI diagnosis (Google Gemini Flash).
Single Vercel project: static front-end + serverless functions. The Gemini API key stays
server-side; the proxy is an adapter, so the front-end is provider-agnostic.

```
billfree-deploy/
├── public/
│   ├── index.html         ← the app (loads KB from billfree-kb.json, embedded copy as fallback)
│   ├── billfree-kb.json   ← KB source of truth — edit this to update content, no code change
│   └── kb-images/         ← 133 screenshots, mapped to records
├── api/
│   ├── diagnose.js        ← Gemini proxy/adapter (holds key, rate-limit, optional secret)
│   ├── feedback.js        ← 👍/👎 per fix → re-authoring queue
│   ├── log.js             ← search/open events (zero-result searches = KB gaps)
│   ├── stats.js           ← read aggregates for the Insights panel
│   └── _kv.js             ← Upstash Redis REST helper (no npm dependency)
├── vercel.json
└── README.md
```

## 1. Deploy (5 min)
```bash
npm i -g vercel
cd billfree-deploy
vercel                                    # press Enter on "./" for the directory
vercel env add GEMINI_API_KEY production  # paste key from aistudio.google.com/apikey
vercel --prod                             # redeploy so the key takes effect
```
No-CLI path: push to GitHub → import on vercel.com → add the env var under Settings → redeploy.

Optional: set `GEMINI_MODEL` to pin a model (default `gemini-2.5-flash`; e.g.
`gemini-2.5-flash-lite` for lower cost). Note `gemini-2.0-flash` has no free-tier quota on
many keys. The proxy reads the key from `GEMINI_API_KEY` (or `GOOGLE_API_KEY`).

## 2. Turn on Insights + feedback storage (optional, 5 min)
Without this, the app works fully and every search/feedback event still lands in your
Vercel function logs. To get the in-app **Insights** dashboard (top searches, KB gaps,
most-opened fixes, 👎 re-authoring queue):

- Vercel → your project → **Storage → Create / Connect** an Upstash Redis (KV) database.
- Vercel auto-injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`. Redeploy. Done — no code change.

## 3. Lock the link (IMPORTANT — internal tool)
This is an internal L1 agent tool: it shows every record, including internal-only material
(dongle/license steps, backend MID checks — flagged `visibility: internal`). The AI endpoint
also spends your Gemini API quota.

> ⚠️ **The KB file itself (`/billfree-kb.json`) is served statically, so it is world-readable
> regardless of the shared secret** — the secret only gates the `/api/*` functions, not static
> assets. For genuinely sensitive material, **Vercel Deployment Protection is the only real
> lock.** (No plaintext credentials live in the KB anymore — the Busy password was removed and
> now references the L2 secrets vault.)

Pick your protection:
- **Vercel password protection** (Pro, strongest): Settings → Deployment Protection → Password.
  Protects the static KB *and* the API.
- **Shared secret** (free, API-only): set env `KB_SHARED_SECRET`, then supply the same value to
  the client — set the `KB_SECRET` constant in `index.html` or pass `?k=<value>` in the URL. The
  client attaches it to every `/api` call via `apiHeaders()`. When set, **all four endpoints**
  (`diagnose`, `stats`, `log`, `feedback`) enforce it — not just `diagnose`.

**Hardening applied** (all automatic):
- Rate limit is **Redis-backed** (shared across instances) when KV is configured, falling back to
  per-instance only in dev. Client IP is read from Vercel's trusted `x-vercel-forwarded-for`.
- CORS defaults to **same-origin only** (no `Access-Control-Allow-Origin: *`). To allow another
  origin, set `ALLOWED_ORIGINS` (comma-separated).
- `diagnose` caps `max_tokens` server-side, uses `BLOCK_ONLY_HIGH` safety (not `BLOCK_NONE`), times
  out upstream calls at 25 s, and returns generic errors (no key/quota leakage).

## Updating the KB
Edit `public/billfree-kb.json` and redeploy — the app fetches it at load. Keep record `id`s
immutable (they're the join key for AI matches, deep links, feedback, and analytics).
The embedded copy in `index.html` is only the offline fallback; regenerate it if you want the
fallback current, but the JSON is the source of truth.

### Adding / fixing screenshots
Drop images in `public/kb-images/` and reference them in a record:
`"images": [{"src": "kb-images/your-file.jpg", "caption": "optional"}]`.
The current 133 were auto-mapped from the source doc by section heading — spot-check and
recaption as needed.

## Features
- Search-first landing + quick-tiles for the top issues; two-pane reading view (list ↔ fix).
- Live AI diagnosis, **multi-turn** ("tried that, still failing") grounded on the KB; only
  returns real record ids (hallucinated ids are dropped).
- Per-step and copy-all-steps buttons; lightbox screenshots.
- 👍/👎 feedback; 👎 + note → re-authoring queue.
- `last_verified` staleness badges; `visibility: internal` badges.
- Escalation block: when AI flags L2/L3, copy a pre-filled handoff (MID, POS+version, OS,
  logs path, repro) straight into the ticket.
- Insights dashboard (KV-gated): top searches, **zero-result KB gaps**, most-opened fixes,
  AI volume, re-authoring queue.
- Offline-safe: search + guided triage work with no API at all.
