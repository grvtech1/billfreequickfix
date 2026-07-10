// scripts/eval-kb.mjs — KB matching eval harness.
//
// Two modes:
//   (default)  OFFLINE findability eval — deterministic, free, CI-safe.
//              For each case, ranks records by keyword overlap and checks that
//              an expected record lands in the top-N. Catches coverage gaps
//              (no matching record) and searchability gaps (record exists but
//              its symptom/tags lack the words agents actually type).
//
//   --ai <BASE>  LIVE AI eval — sends each case to <BASE>/api/diagnose (the real
//              Gemini proxy) with a grounded prompt and checks the returned match
//              ids. Opt-in: needs the server configured (GEMINI_API_KEY) and, if
//              gated, the shared secret in env KB_SECRET. Spaces calls out to
//              respect the 20-req/min rate limit.
//
// Flags:
//   --min <pct>   exit 1 if pass-rate < pct (e.g. --min 80). Default: report only.
//   --delay <ms>  gap between live AI calls (default 3200).
//   --verbose     show ranking detail for misses.
//
// Examples:
//   node scripts/eval-kb.mjs
//   node scripts/eval-kb.mjs --min 80
//   KB_SECRET=xxx node scripts/eval-kb.mjs --ai https://billfreequickfix.vercel.app
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? (args[i + 1] ?? true) : undefined; };
const AI_BASE = flag('--ai');
const MIN = flag('--min') !== undefined ? Number(flag('--min')) : null;
const DELAY = Number(flag('--delay') ?? 3200);
const VERBOSE = args.includes('--verbose');

const master = JSON.parse(readFileSync(join(ROOT, 'kb', 'billfree-kb.json'), 'utf8'));
const RECORDS = master.records;
const byId = new Map(RECORDS.map((r) => [r.id, r]));
const suite = JSON.parse(readFileSync(join(ROOT, 'evals', 'cases.json'), 'utf8'));
const TOPN = suite.topN || 3;

// ---- validate the suite itself (dead expected ids are a real regression) ----
let deadRefs = 0;
for (const c of suite.cases) {
  for (const id of c.expect) if (!byId.has(id)) { console.error(`✗ case "${c.q}" expects unknown id "${id}"`); deadRefs++; }
}
if (deadRefs) { console.error(`\n${deadRefs} case(s) reference records that no longer exist — fix evals/cases.json.`); process.exit(1); }

// ---- offline scorer: transparent keyword overlap over weighted fields -------
const STOP = new Set('a an the to in on of for and or is are it my we how do i you your be with not no there here this that at as set get'.split(' '));
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ');
const toks = (s) => norm(s).split(' ').filter((t) => t.length > 1 && !STOP.has(t));

function searchable(r) {
  return {
    symptom: toks(r.symptom).concat(toks(r.category)),
    tags: (r.tags || []).flatMap(toks),
    system: toks(r.system),
    body: toks(r.cause).concat((r.solution || []).flatMap(toks)),
  };
}
const INDEX = RECORDS.map((r) => ({ id: r.id, f: searchable(r) }));

function rank(query) {
  const qt = new Set(toks(query));
  const scored = INDEX.map(({ id, f }) => {
    let s = 0;
    for (const t of qt) {
      if (f.symptom.includes(t)) s += 5;
      if (f.tags.includes(t)) s += 4;
      if (f.system.includes(t)) s += 3;
      if (f.body.includes(t)) s += 1;
    }
    return { id, s };
  }).filter((x) => x.s > 0);
  scored.sort((a, b) => b.s - a.s);
  return scored;
}

// ---- live AI mode -----------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function groundedPrompt() {
  // mirror the app contract: match ONLY against known ids, return JSON
  const list = RECORDS.filter((r) => r.visibility !== 'internal')
    .map((r) => `- ${r.id} [${r.system}]: ${r.symptom}`).join('\n');
  return `You are a BillFree L1 KB matcher. Given a support problem, return STRICT JSON:
{"matches":[{"id":"<record-id>","confidence":"high|medium|low"}]}
Use ONLY these record ids (never invent one). Return the 1-3 best matches, best first.

RECORDS:
${list}`;
}

async function aiMatch(base, query) {
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.KB_SECRET) headers['x-kb-secret'] = process.env.KB_SECRET;
  const res = await fetch(base.replace(/\/$/, '') + '/api/diagnose', {
    method: 'POST', headers,
    body: JSON.stringify({ system: groundedPrompt(), max_tokens: 300, messages: [{ role: 'user', content: query }] }),
  });
  const j = await res.json();
  if (!res.ok) throw new Error(j.error || ('HTTP ' + res.status));
  const text = j.content?.[0]?.text || '';
  let parsed; try { parsed = JSON.parse(text); } catch { throw new Error('model did not return JSON: ' + text.slice(0, 80)); }
  return (parsed.matches || []).map((m) => m.id);
}

// ---- run --------------------------------------------------------------------
console.log(`KB matching eval — ${suite.cases.length} cases, top-${TOPN} pass bar` + (AI_BASE ? `  [LIVE AI: ${AI_BASE}]` : '  [offline findability]'));
console.log('─'.repeat(62));

let pass = 0, errors = 0;
for (const c of suite.cases) {
  let hitRank = -1, returned = [], err = null;
  try {
    if (AI_BASE) {
      returned = await aiMatch(AI_BASE, c.q);
      const idx = returned.findIndex((id) => c.expect.includes(id));
      hitRank = idx >= 0 ? idx + 1 : -1;
      await sleep(DELAY);
    } else {
      const ranked = rank(c.q);
      returned = ranked.slice(0, TOPN).map((x) => x.id);
      const idx = ranked.findIndex((x) => c.expect.includes(x.id));
      hitRank = idx >= 0 && idx < TOPN ? idx + 1 : -1;
    }
  } catch (e) { err = e.message; errors++; }

  const okHit = hitRank > 0;
  if (okHit) pass++;
  const mark = err ? '⚠' : okHit ? '✓' : '✗';
  const detail = err ? `ERROR: ${err}` : okHit ? `#${hitRank}` : 'MISS';
  console.log(`${mark} [${detail}] ${c.q}`);
  if (!okHit && !err) {
    console.log(`    expected: ${c.expect.join(' | ')}`);
    console.log(`    got:      ${returned.slice(0, TOPN).join(' | ') || '(nothing)'}`);
    if (VERBOSE && !AI_BASE) console.log(`    ranking:  ${rank(c.q).slice(0, 5).map((x) => `${x.id}(${x.s})`).join(', ')}`);
  }
}

const total = suite.cases.length;
const rate = Math.round((pass / total) * 100);
console.log('─'.repeat(62));
console.log(`pass@${TOPN}: ${pass}/${total} = ${rate}%` + (errors ? `  (${errors} errors)` : ''));

if (MIN !== null && rate < MIN) { console.error(`FAIL: below --min ${MIN}%`); process.exit(1); }
if (errors && AI_BASE) process.exit(1);
