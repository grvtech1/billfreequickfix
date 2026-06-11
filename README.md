# BillFree QuickFix — deploy guide

Search-first L1 troubleshooting console with live AI diagnosis. Single Vercel project:
static front-end + serverless functions. The Anthropic key stays server-side.

```
billfree-deploy/
├── public/
│   ├── index.html         ← the app (loads KB from billfree-kb.json, embedded copy as fallback)
│   ├── billfree-kb.json   ← KB source of truth — edit this to update content, no code change
│   └── kb-images/         ← 133 screenshots, mapped to records
├── api/
│   ├── diagnose.js        ← Anthropic proxy (holds key, rate-limit, optional secret)
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
vercel                                       # press Enter on "./" for the directory
vercel env add ANTHROPIC_API_KEY production  # paste key from console.anthropic.com
vercel --prod                                # redeploy so the key takes effect
```
No-CLI path: push to GitHub → import on vercel.com → add the env var under Settings → redeploy.

## 2. Turn on Insights + feedback storage (optional, 5 min)
Without this, the app works fully and every search/feedback event still lands in your
Vercel function logs. To get the in-app **Insights** dashboard (top searches, KB gaps,
most-opened fixes, 👎 re-authoring queue):

- Vercel → your project → **Storage → Create / Connect** an Upstash Redis (KV) database.
- Vercel auto-injects `KV_REST_API_URL` and `KV_REST_API_TOKEN`. Redeploy. Done — no code change.

## 3. Lock the link (recommended — internal data inside)
The KB contains internal-only material (the Busy default password, dongle/license steps,
backend MID checks — these records are flagged `visibility: internal`). The AI endpoint also
spends your Anthropic credits. Pick one:
- **Vercel password protection** (Pro): Settings → Deployment Protection → Password.
- **Shared secret** (free): set env `KB_SHARED_SECRET`, then add `"x-kb-secret": "<same value>"`
  to the headers of the three `fetch()` calls in `index.html` (`/api/diagnose`). The proxy already
  enforces it when the env var is present, plus a 20-req/min per-IP rate limit.

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
