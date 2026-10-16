// OneLook last-resort gate. Drives the REAL worker module (src/worker/crosswordWorker.js)
// under Node with a stand-in `self`, against the shipped corpus and the live OneLook API.
//
//   node scripts/test-onelook.mjs
//
// Gates (exit 1 on failure):
//   * a grid the corpus can fill makes ZERO OneLook requests (corpus first, always)
//   * an author's letters the corpus can't honour ("KLOT_") fail corpus-only, and fill
//     once OneLook is asked, with the author's letters intact
//   * every answer re-derived from the GRID is a corpus word or a OneLook supplement,
//     no answer repeats, and every supplement carries a non-empty clue tagged 'onelook'
//   * onelook.com unreachable: Datamuse (OneLook's engine) answers instead
//   * both unreachable: the fill fails with the corpus's own reason, no crash
//
// Needs network for the live cases; they are skipped (not passed) without it.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;

const { findSlots } = await import(url('src/utils/crosswordUtils.js'));
const { DEFAULT_LAYOUTS } = await import(url('src/data/layouts.js'));
const { decodeCorpus } = await import(url('src/utils/wordIndex.js'));

const CORPUS = path.join(ROOT, 'public', 'corpus', 'corpus.bin');
const corpusBuf = fs.readFileSync(CORPUS);
const corpusWords = new Set(decodeCorpus(
  corpusBuf.buffer.slice(corpusBuf.byteOffset, corpusBuf.byteOffset + corpusBuf.byteLength),
).entries.map((e) => e.word));

// ---- worker harness ------------------------------------------------------------
const realFetch = globalThis.fetch;
let onelookCalls = 0;
let onelookMode = 'live'; // 'live' | 'onelook-down' | 'all-down'
let datamuseCalls = 0;
globalThis.fetch = async (u, init) => {
  const s = String(u);
  if (s.endsWith('corpus.bin')) {
    return new Response(corpusBuf, { status: 200 });
  }
  if (s.includes('onelook.com')) {
    onelookCalls++;
    if (onelookMode !== 'live') throw new TypeError('network down');
  }
  if (s.includes('datamuse.com')) {
    datamuseCalls++;
    if (onelookMode === 'all-down') throw new TypeError('network down');
  }
  return realFetch(u, init);
};

let pending = null;
globalThis.self = { postMessage: (m) => pending?.(m) };
await import(url('src/worker/crosswordWorker.js'));
const send = (data, until) => new Promise((resolve) => {
  pending = (m) => { if (until.includes(m.type)) { pending = null; resolve(m); } };
  globalThis.self.onmessage({ data });
});

const ready = await send({ type: 'loadCorpus', payload: { url: '/corpus/corpus.bin' } }, ['corpusReady', 'error']);
if (ready.type !== 'corpusReady') { console.error('corpus load failed', ready); process.exit(1); }
const fingerprint = ready.fingerprint;
const solve = (payload) => send({ type: 'start', payload: { corpusFingerprint: fingerprint, timeoutMs: 15000, seed: 7, ...payload } }, ['done', 'error']);

// ---- helpers -------------------------------------------------------------------
const failures = [];
const check = (ok, msg) => { console.log(`   ${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failures.push(msg); };

const blankPreset = (layout) => layout.map((row) => [...row].map((c) => (c === '#' ? '#' : null)));
const wordAt = (grid, s) => {
  let w = '';
  for (let i = 0; i < s.length; i++) {
    w += grid[s.direction === 'across' ? s.row : s.row + i][s.direction === 'across' ? s.col + i : s.col] || '?';
  }
  return w;
};

/** The load-bearing check: everything read back off the GRID, not the placements. */
function auditGrid(result, layout, preset, supplements) {
  const slots = findSlots(layout.map((r) => [...r]));
  const seen = new Set();
  const bad = [];
  for (const s of slots) {
    const w = wordAt(result.grid, s);
    if (seen.has(w)) bad.push(`${w} repeats`);
    seen.add(w);
    if (!corpusWords.has(w) && !supplements.has(w)) bad.push(`${w} is in neither the corpus nor the supplement`);
  }
  for (let r = 0; r < preset.length; r++) {
    for (let c = 0; c < preset[r].length; c++) {
      const v = preset[r][c];
      if (v && v !== '#' && result.grid[r][c] !== v) bad.push(`author's ${v} at ${r},${c} became ${result.grid[r][c]}`);
    }
  }
  for (const p of result.placements) {
    if (wordAt(result.grid, p.slot) !== p.word) bad.push(`placement ${p.word} disagrees with the grid`);
    if (supplements.has(p.word) && (!p.clue || p.clueSource !== 'onelook')) bad.push(`${p.word} has no OneLook clue`);
  }
  return bad;
}

// ---- 1. corpus-first: a fillable grid never calls OneLook -----------------------
console.log('\n1. fillable grid: corpus only');
{
  const layout = DEFAULT_LAYOUTS[0].grid;
  onelookCalls = 0;
  const m = await solve({ layout });
  check(m.type === 'done' && m.result.complete, `fills (${m.result?.placements?.length} answers)`);
  check(onelookCalls === 0, `OneLook requests: ${onelookCalls}`);
  check(!m.result?.onelook, 'no OneLook words reported');
}

// ---- 2. the author's letters starve a slot: OneLook rescues it -------------------
const STARVED = [
  { name: 'KLOT_ in a 5-letter across', len: 5, dir: 'across', letters: 'KLOT' },
  { name: 'KLEZME_ in a 7-letter down', len: 7, dir: 'down', letters: 'KLEZME' },
];
let online = true;
try { online = (await realFetch('https://www.onelook.com/api/words?sp=cat&max=1')).ok; } catch { online = false; }

for (const sc of STARVED) {
  console.log(`\n2. ${sc.name}`);
  if (!online) { console.log('   SKIP  OneLook unreachable from here'); continue; }
  const lay = DEFAULT_LAYOUTS.find((l) => l.grid.length === 15
    && findSlots(l.grid.map((r) => [...r])).some((s) => s.length === sc.len && s.direction === sc.dir));
  const layout = lay.grid;
  const slot = findSlots(layout.map((r) => [...r])).find((s) => s.length === sc.len && s.direction === sc.dir);
  const preset = blankPreset(layout);
  for (let i = 0; i < sc.letters.length; i++) {
    preset[sc.dir === 'across' ? slot.row : slot.row + i][sc.dir === 'across' ? slot.col + i : slot.col] = sc.letters[i];
  }

  onelookCalls = 0;
  const off = await solve({ layout, presetGrid: preset, onelook: false });
  check(m2ok(off) === false, `corpus alone fails: ${off.result?.error?.code}`);
  check(onelookCalls === 0, 'onelook:false makes no requests');

  onelookCalls = 0;
  const on = await solve({ layout, presetGrid: preset });
  const r = on.result || {};
  check(r.complete, `fills with OneLook (${onelookCalls} requests, ${r.onelook?.offered ?? 0} words offered)`);
  const used = r.onelook?.used || [];
  check(used.length > 0, `used: ${used.map((w) => `${w} = "${r.placements.find((p) => p.word === w)?.clue}"`).join('; ')}`);
  if (r.complete) {
    const bad = auditGrid(r, layout, preset, new Set(used));
    check(bad.length === 0, bad.length ? bad.join('; ') : 'grid audit: every answer is a corpus or OneLook word, none repeat, author letters kept');
  }
}

function m2ok(m) { return m.type === 'done' && !!m.result.complete; }

// ---- 3. onelook.com down: Datamuse stands in --------------------------------------
console.log('\n3. onelook.com unreachable, Datamuse up');
if (!online) console.log('   SKIP  no network');
else {
  const layout = DEFAULT_LAYOUTS.find((l) => l.grid.length === 15
    && findSlots(l.grid.map((r) => [...r])).some((sl) => sl.length === 7 && sl.direction === 'down')).grid;
  const slot = findSlots(layout.map((r) => [...r])).find((sl) => sl.length === 7 && sl.direction === 'down');
  const preset = blankPreset(layout);
  'KLEZME'.split('').forEach((ch, i) => { preset[slot.row + i][slot.col] = ch; });
  onelookMode = 'onelook-down';
  datamuseCalls = 0;
  const m = await solve({ layout, presetGrid: preset });
  onelookMode = 'live';
  check(datamuseCalls > 0 && !!m.result?.complete, `fills via Datamuse (${datamuseCalls} requests)`);
  check((m.result?.onelook?.used || []).includes('KLEZMER'), `used: ${(m.result?.onelook?.used || []).join(', ')}`);
}

// ---- 4. no network at all: same failure as without it, no crash ------------------
console.log('\n4. OneLook and Datamuse both unreachable');
{
  const layout = DEFAULT_LAYOUTS[0].grid;
  const slot = findSlots(layout.map((r) => [...r])).find((s) => s.length === 5 && s.direction === 'across');
  const preset = blankPreset(layout);
  'KLOT'.split('').forEach((ch, i) => { preset[slot.row][slot.col + i] = ch; });
  onelookMode = 'all-down';
  onelookCalls = 0;
  const m = await solve({ layout, presetGrid: preset });
  onelookMode = 'live';
  check(m.type === 'done' && !m.result.complete && !!m.result.error, `fails cleanly: ${m.result?.error?.code}`);
  check(onelookCalls > 0, `tried OneLook (${onelookCalls} requests)`);
}

console.log(failures.length ? `\nFAILED: ${failures.length}` : '\nall OneLook gates passed');
process.exit(failures.length ? 1 : 0);
