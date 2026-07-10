// scripts/smoke-test.mjs — deploy gate. Pure Node, no dependencies.
// Fails (exit 1) if anything that would silently break the live tool is wrong:
//   • KB won't parse / a record is malformed
//   • duplicate ids, bad enum values, bad last_verified format
//   • a `related` link or image `src` points at something that doesn't exist
//   • the generated api/_kbdata.js is out of sync with kb/billfree-kb.json
//   • an `internal` record leaked into the public EMBEDDED_KB fallback
//   • an /api/*.js module fails to import
// Run: `npm test`  (also runs automatically as the Vercel build step).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const p = (...a) => join(ROOT, ...a);
// Windows-safe dynamic import: absolute paths must be file:// URLs.
const imp = (abs) => import(pathToFileURL(abs).href + `?t=${Date.now()}`);

let failures = 0;
const fail = (msg) => { console.error('  ✗ ' + msg); failures++; };
const ok = (msg) => console.log('  ✓ ' + msg);
const section = (t) => console.log('\n' + t);

const REQUIRED = ['id', 'category', 'system', 'type', 'symptom', 'cause', 'solution', 'tags', 'level', 'visibility'];
const LEVELS = new Set(['L1', 'L2', 'L3']);
const VIS = new Set(['public', 'internal']);
const YM = /^\d{4}-\d{2}$/;

// ---- 1. KB master parses + is structurally sound ----------------------------
section('KB master (kb/billfree-kb.json)');
let master;
try {
  master = JSON.parse(readFileSync(p('kb', 'billfree-kb.json'), 'utf8'));
  ok('parses as JSON');
} catch (e) {
  fail('does not parse: ' + e.message);
  console.error('\nFATAL: cannot continue.'); process.exit(1);
}
const records = master.records || [];
if (!Array.isArray(records) || records.length === 0) fail('records[] is empty');
else ok(`${records.length} records`);

const ids = new Set();
const dupes = new Set();
for (const r of records) {
  if (ids.has(r.id)) dupes.add(r.id);
  ids.add(r.id);
}
dupes.size ? fail('duplicate ids: ' + [...dupes].join(', ')) : ok('all ids unique');

for (const r of records) {
  const where = r.id || '(missing id)';
  for (const f of REQUIRED) {
    if (r[f] === undefined || r[f] === null || r[f] === '') fail(`${where}: missing required field "${f}"`);
  }
  if (!Array.isArray(r.solution) || r.solution.length === 0) fail(`${where}: solution[] empty`);
  if (!Array.isArray(r.tags)) fail(`${where}: tags must be an array`);
  if (r.level && !LEVELS.has(r.level)) fail(`${where}: bad level "${r.level}"`);
  if (r.visibility && !VIS.has(r.visibility)) fail(`${where}: bad visibility "${r.visibility}"`);
  if (r.last_verified !== undefined && !YM.test(r.last_verified)) fail(`${where}: last_verified "${r.last_verified}" not YYYY-MM`);
}
if (!failures) ok('every record has required fields + valid enums');

// ---- 2. related[] links resolve + are bidirectional -------------------------
section('related[] integrity');
let relOk = true;
for (const r of records) {
  for (const t of r.related || []) {
    if (!ids.has(t)) { fail(`${r.id}: related -> "${t}" does not exist`); relOk = false; }
    else if (t === r.id) { fail(`${r.id}: related -> itself`); relOk = false; }
    else {
      const target = records.find((x) => x.id === t);
      if (!(target.related || []).includes(r.id)) { fail(`${r.id} <-> ${t}: related link not bidirectional`); relOk = false; }
    }
  }
}
if (relOk) ok('all related links resolve + are bidirectional');

// ---- 3. image src references exist on disk ----------------------------------
section('image references (public/kb-images/)');
const imgDir = p('public', 'kb-images');
const onDisk = new Set(existsSync(imgDir) ? readdirSync(imgDir) : []);
const referenced = new Set();
let imgOk = true;
for (const r of records) {
  for (const im of r.images || []) {
    const src = typeof im === 'string' ? im : im.src;
    if (!src) { fail(`${r.id}: image with no src`); imgOk = false; continue; }
    const base = src.replace(/^kb-images\//, '');
    referenced.add(base);
    if (!onDisk.has(base)) { fail(`${r.id}: image "${src}" missing on disk`); imgOk = false; }
  }
}
if (imgOk) ok(`all ${referenced.size} referenced images exist`);
const unused = [...onDisk].filter((f) => !referenced.has(f));
if (unused.length) console.log(`  ⚠ ${unused.length} image file(s) unused (not a failure): ${unused.slice(0, 5).join(', ')}${unused.length > 5 ? '…' : ''}`);

// ---- 4. schema.fields declares everything used ------------------------------
section('schema declaration');
const declared = new Set(master.schema?.fields || []);
const usedFields = new Set();
records.forEach((r) => Object.keys(r).forEach((k) => usedFields.add(k)));
const undeclared = [...usedFields].filter((f) => !declared.has(f));
undeclared.length ? fail('fields used but not in schema.fields: ' + undeclared.join(', ')) : ok('schema.fields covers every used field');

// Deep content equality — not just ids/counts. Catches editing the master's
// step text and forgetting to regenerate (ids/counts would still match).
const canon = (r) => JSON.stringify(r);

// ---- 5. generated api/_kbdata.js is in FULL sync ----------------------------
section('generated api/_kbdata.js sync (deep)');
try {
  const mod = await imp(p('api', '_kbdata.js'));
  const bundled = mod.KB?.records || [];
  if (bundled.length !== records.length) fail(`_kbdata.js has ${bundled.length} records, master has ${records.length} — run "npm run build:kb"`);
  else {
    const mismatches = records.filter((r, i) => canon(r) !== canon(bundled[i]));
    mismatches.length
      ? fail(`_kbdata.js content differs from master in ${mismatches.length} record(s) (e.g. "${mismatches[0].id}") — run "npm run build:kb"`)
      : ok('_kbdata.js is byte-for-byte in sync with master');
  }
} catch (e) {
  fail('cannot import api/_kbdata.js: ' + e.message);
}

// ---- 6. public EMBEDDED_KB fallback is PUBLIC-ONLY + in FULL sync ------------
section('public EMBEDDED_KB fallback (index.html)');
const html = readFileSync(p('public', 'index.html'), 'utf8');
const line = html.split('\n').find((l) => l.startsWith('const EMBEDDED_KB = '));
if (!line) fail('EMBEDDED_KB line not found in index.html');
else {
  try {
    const embed = JSON.parse(line.slice('const EMBEDDED_KB = '.length).replace(/;\s*$/, ''));
    const internalIds = new Set(records.filter((r) => r.visibility === 'internal').map((r) => r.id));
    const leaked = embed.filter((r) => internalIds.has(r.id)).map((r) => r.id);
    leaked.length ? fail('INTERNAL records leaked into public fallback: ' + leaked.join(', ')) : ok(`${embed.length} public records, no internal leak`);
    const publicRecs = records.filter((r) => r.visibility !== 'internal');
    if (embed.length !== publicRecs.length) fail(`embed has ${embed.length} records, expected ${publicRecs.length} public — run "npm run build:kb"`);
    else {
      const drift = publicRecs.filter((r, i) => canon(r) !== canon(embed[i]));
      if (drift.length) fail(`EMBEDDED_KB content differs from master in ${drift.length} record(s) (e.g. "${drift[0].id}") — run "npm run build:kb"`);
      else ok('EMBEDDED_KB is in full sync with the public records');
    }
  } catch (e) {
    fail('EMBEDDED_KB is not valid JSON: ' + e.message);
  }
}

// ---- 7. every /api function imports cleanly ---------------------------------
section('api/*.js import check');
const apiFiles = readdirSync(p('api')).filter((f) => f.endsWith('.js') && !f.startsWith('_kbdata'));
for (const f of apiFiles) {
  try { await imp(p('api', f)); ok(`${f} imports`); }
  catch (e) { fail(`${f} fails to import: ${e.message}`); }
}

// ---- verdict ----------------------------------------------------------------
console.log('\n' + '─'.repeat(52));
if (failures) { console.error(`SMOKE TEST FAILED — ${failures} problem(s). Deploy blocked.`); process.exit(1); }
console.log('SMOKE TEST PASSED — safe to deploy.');
