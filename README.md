# BillFree QuickFix — deploy guide

Search-first L1 troubleshooting console with live AI diagnosis (Google Gemini Flash).
Single Vercel project: static front-end + serverless functions. The Gemini API key stays
server-side; the proxy is an adapter, so the front-end is provider-agnostic.

```
billfree-deploy/
├── kb/
│   └── billfree-kb.json   ← KB SOURCE OF TRUTH — edit this, then `npm run build:kb`
├── scripts/
│   ├── build-kb.mjs       ← regenerates api/_kbdata.js + the public-only fallback (runs on every deploy)
│   ├── smoke-test.mjs     ← deploy gate: KB integrity, deep generated-file sync, api imports
│   └── eval-kb.mjs        ← KB matching eval (offline findability + opt-in live AI)
├── evals/cases.json       ← real L1 queries → expected record (drives eval-kb.mjs)
├── public/
│   ├── index.html         ← the app (loads KB from /api/kb; embedded PUBLIC-only copy as fallback)
│   └── kb-images/         ← screenshots, mapped to records
├── api/
│   ├── kb.js              ← serves the KB; internal records gated behind the shared secret
│   ├── _kbdata.js         ← GENERATED full KB, bundled server-side (never a public asset)
│   ├── health.js          ← cheap AI/KV capability probe (no upstream call)
│   ├── _gate.js           ← CORS + secret gate + trusted-IP + 2-tier rate limiter + PII redaction
│   ├── diagnose.js        ← Gemini proxy/adapter (holds key, rate-limit, secret)
│   ├── feedback.js        ← 👍/👎 per fix → re-authoring queue (gated, PII-redacted)
│   ├── log.js             ← search/open events (gated, PII-redacted); zero-results = KB gaps
│   ├── stats.js           ← read aggregates for the Insights panel (gated)
│   └── _kv.js             ← Upstash Redis REST helper (2s timeout, no npm dependency)
├── .github/workflows/ci.yml  ← runs the smoke test on every push
├── package.json
├── vercel.json            ← buildCommand runs build-kb + smoke test (deploy gate)
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
- **Two-tier rate limit**: per-agent (the client sends a random, PII-free `x-kb-client` id it
  persists locally) so several agents behind ONE office IP don't starve each other, plus a higher
  per-IP backstop against id-rotation abuse. Redis-backed (shared across instances) when KV is set.
  Client IP is read from Vercel's trusted `x-vercel-forwarded-for`.
- **PII redaction**: 6+ digit runs (mobile numbers, MIDs, licenses) are stripped from search
  queries and feedback notes before they touch logs or KV.
- The status-line **AI probe hits `/api/health`** (reports whether the key is configured) instead
  of firing a real Gemini request per page load — no wasted quota or rate-limit slots.
- CORS defaults to **same-origin only** (no `Access-Control-Allow-Origin: *`). To allow another
  origin, set `ALLOWED_ORIGINS` (comma-separated).
- `diagnose` caps `max_tokens` server-side, uses `BLOCK_ONLY_HIGH` safety (not `BLOCK_NONE`), times
  out upstream calls at 25 s, and returns generic errors (no key/quota leakage). KV calls time out
  at 2 s so a hung Upstash never holds the function open.

## Updating the KB
1. Edit **`kb/billfree-kb.json`** (the single source of truth).
2. Run **`npm run build:kb`** — regenerates `api/_kbdata.js` (the full KB the `/api/kb` function
   serves) and the **public-only** `EMBEDDED_KB` offline fallback in `index.html`. It also runs
   automatically as part of the deploy (`npm run build`), so a forgotten rebuild can't ship — the
   smoke test **fails the deploy** if the generated files drift from the master, and refuses to let
   any `visibility:"internal"` record reach the public fallback.
3. Redeploy.

Run **`npm test`** anytime for the full integrity check, and **`npm run eval`** to check that real
L1 queries still surface the right record (add cases to `evals/cases.json`; `--min 80` makes it a
gate, `--ai <url>` runs it against live Gemini).

Keep record `id`s immutable (they're the join key for AI matches, deep links, feedback, and
analytics). The KB is **no longer a static file** — `public/billfree-kb.json` was removed so the
internal records aren't world-readable; the browser loads the KB from the gated `/api/kb` endpoint
(sending the shared secret via `apiHeaders()`), and internal records are only returned to callers
that present a valid secret.

> Note: if this GitHub repo is **public**, the internal records are still visible in
> `api/_kbdata.js` and `kb/billfree-kb.json` on GitHub. Make the repo **private** if that matters.

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
