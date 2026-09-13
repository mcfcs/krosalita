// Fill-VARIETY benchmark.
//
//   node scripts/bench-variety.mjs                 # default sweep
//   node scripts/bench-variety.mjs --runs 20
//   node scripts/bench-variety.mjs --json out.json # also dump raw numbers
//   node scripts/bench-variety.mjs --window 2 --jitter 0.05 --slot-jitter 0.08
//                                                  # override solver.js's variety knobs
//   node scripts/bench-variety.mjs --solver x.js    # measure some other copy of the
//                                                  # solver (e.g. `git show` output)
//   node scripts/bench-variety.mjs --avoid          # also measure the Regenerate path:
//                                                  # re-solve passing the first fill's
//                                                  # answers as avoidWords
//
// Solves the SAME layout N times with N different seeds and asks: how much does the
// fill actually change? Reports, per (layout, difficulty) case:
//
//   overlap   mean pairwise Jaccard of the answer SETS (1.00 = every run identical)
//   ident     fraction of runs byte-identical to some other run
//   uniq      number of DISTINCT filled grids out of N
//   qual      mean static word quality of placed answers (li.score/65535) -- the guard
//             against buying variety with junk fill
//   zipf      mean corpus zipf of placed answers -- the guard against variety-by-obscurity
//   diff      mean answer difficulty (li.diff/255) -- watches for difficulty-target drift
//   p50/p95   solve time
//
// Quality and zipf come from the corpus itself, not from anything invented here.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(path.isAbsolute(p) ? p : path.join(ROOT, p)).href;

const { decodeCorpus, buildWordIndex } = await import(url('src/utils/wordIndex.js'));
// --solver lets the same measurement run against another copy of the solver (e.g. one
// extracted from git), so before/after timings come from the same process conditions.
const SOLVER = (() => { const i = process.argv.indexOf('--solver'); return i >= 0 ? process.argv[i + 1] : null; })();
const { solveCrossword } = await import(SOLVER ? pathToFileURL(path.resolve(SOLVER)).href : url('src/utils/solver.js'));
const { DEFAULT_LAYOUTS } = await import(url('src/data/layouts.js'));

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const RUNS = Number(arg('--runs', 16));
const TIMEOUT = Number(arg('--timeout', 10000));
const JSON_OUT = arg('--json', null);
const LABEL = arg('--label', 'current');
// Optional tuning overrides, so the variety knobs can be swept without editing solver.js.
const TUNE = {};
for (const [flag, key] of [['--window', 'varietyWindow'], ['--jitter', 'varietyJitter'],
                           ['--slot-jitter', 'slotJitter']]) {
  const v = arg(flag, null);
  if (v != null) TUNE[key] = Number(v);
}
// --avoid re-solves each case a second time with the first fill's answers passed as
// avoidWords, and reports the overlap between the pair -- the Regenerate-button path.
const AVOID = argv.includes('--avoid');

const binPath = path.join(ROOT, 'public', 'corpus', 'corpus.bin');
if (!fs.existsSync(binPath)) { console.error(`missing ${binPath}`); process.exit(1); }
const buf = fs.readFileSync(binPath);
const corpus = decodeCorpus(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const index = buildWordIndex(corpus.entries, { presorted: true, fingerprint: 'variety' });

// word -> zipf, straight off the packed corpus.
const zipfOf = new Map();
let haveZipf = 0;
for (const e of corpus.entries) {
  if (e.zipf !== undefined && !zipfOf.has(e.word)) { zipfOf.set(e.word, e.zipf); haveZipf++; }
}

console.log(`corpus  ${corpus.entries.length.toLocaleString()} answers · zipf on ${haveZipf.toLocaleString()}`);
console.log(`node    ${process.version} · ${os.cpus()[0]?.model?.trim() || 'cpu'}`);
console.log(`runs    ${RUNS} seeds per case · label "${LABEL}"\n`);

const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
const L = (name) => DEFAULT_LAYOUTS.find((l) => l.name === name).grid;

const CASES = [
  ['Mini 5x5 - Cross', L('Mini 5x5 - Cross'), null],
  ['Mini 5x5 - Open', L('Mini 5x5 - Open'), null],
  ['Classic 15x15', L('Classic 15x15'), null],
  ['Standard 15x15', L('Standard 15x15'), null],
  ['Open 15x15', L('Open 15x15'), null],
  ['Diamond 15x15', L('Diamond 15x15'), null],
  ['Classic @0.5', L('Classic 15x15'), 0.5],
  ['Classic @0.9', L('Classic 15x15'), 0.9],
];

const jaccard = (a, b) => {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
};

const rows = [];
console.log('case                  overlap  ident uniq    qual    zipf    diff    p50     p95   ok');
for (const [name, layout, dtarget] of CASES) {
  const sets = [], sigs = [], times = [];
  let qSum = 0, qN = 0, zSum = 0, zN = 0, dSum = 0, ok = 0;
  for (let s = 0; s < RUNS; s++) {
    const seed = 100003 + s * 7919;
    const st = Date.now();
    const r = solveCrossword({ index, layout, seed, timeoutMs: TIMEOUT, difficultyTarget: dtarget, ...TUNE });
    times.push(Date.now() - st);
    if (!r.complete) { console.log(`   (seed ${seed} did not fill: ${r.error?.code})`); continue; }
    ok++;
    const set = new Set();
    for (const p of r.placements) {
      set.add(p.word);
      const li = index.byLen[p.word.length];
      qSum += li.score[p.wordIndex] / 65535; qN++;
      dSum += li.diff[p.wordIndex] / 255;
      const z = zipfOf.get(p.word);
      if (z !== undefined) { zSum += z; zN++; }
    }
    sets.push(set);
    // byte-identical = the filled grid itself, not just the answer set
    sigs.push(r.grid.map((row) => row.map((c) => c || '.').join('')).join('/'));
  }
  // Regenerate path: same seed is NOT reused -- a Regenerate press gets a new seed AND
  // the previous answers to avoid. Measure how different the second fill is.
  let avoidOv = null, avoidIdent = null, avoidQual = null, avoidP95 = null;
  if (AVOID) {
    let aOv = 0, aN = 0, aSame = 0, aQ = 0, aQN = 0;
    const aTimes = [];
    for (let s = 0; s < RUNS; s++) {
      const seed = 100003 + s * 7919;
      const r1 = solveCrossword({ index, layout, seed, timeoutMs: TIMEOUT, difficultyTarget: dtarget, ...TUNE });
      if (!r1.complete) continue;
      const prev = r1.placements.map((p) => p.word);
      const st = Date.now();
      const r2 = solveCrossword({
        index, layout, seed: (seed * 2654435761) >>> 0, timeoutMs: TIMEOUT,
        difficultyTarget: dtarget, avoidWords: prev, ...TUNE,
      });
      aTimes.push(Date.now() - st);
      if (!r2.complete) continue;
      const s1 = new Set(prev), s2 = new Set(r2.placements.map((p) => p.word));
      aOv += jaccard(s1, s2); aN++;
      const sig = (r) => r.grid.map((row) => row.map((c) => c || '.').join('')).join('/');
      if (sig(r1) === sig(r2)) aSame++;
      for (const p of r2.placements) { aQ += index.byLen[p.word.length].score[p.wordIndex] / 65535; aQN++; }
    }
    avoidOv = aN ? aOv / aN : 0;
    avoidIdent = aN ? aSame / aN : 0;
    avoidQual = aQN ? aQ / aQN : 0;
    avoidP95 = pct(aTimes, 0.95);
  }

  let ov = 0, pairs = 0;
  for (let i = 0; i < sets.length; i++) {
    for (let j = i + 1; j < sets.length; j++) { ov += jaccard(sets[i], sets[j]); pairs++; }
  }
  const counts = new Map();
  for (const s of sigs) counts.set(s, (counts.get(s) || 0) + 1);
  let dup = 0;
  for (const [, c] of counts) if (c > 1) dup += c;

  const row = {
    name,
    overlap: pairs ? ov / pairs : 0,
    ident: sigs.length ? dup / sigs.length : 0,
    distinct: counts.size,
    qual: qN ? qSum / qN : 0,
    zipf: zN ? zSum / zN : 0,
    diff: qN ? dSum / qN : 0,
    p50: pct(times, 0.5),
    p95: pct(times, 0.95),
    ok,
    runs: RUNS,
    avoidOv, avoidIdent, avoidQual, avoidP95,
  };
  rows.push(row);
  console.log(
    `${name.padEnd(22)}${row.overlap.toFixed(3).padStart(7)}`
    + `${row.ident.toFixed(2).padStart(7)}`
    + `${String(row.distinct + '/' + RUNS).padStart(6)}`
    + `${row.qual.toFixed(4).padStart(8)}`
    + `${row.zipf.toFixed(3).padStart(8)}`
    + `${row.diff.toFixed(3).padStart(8)}`
    + `${String(row.p50 + 'ms').padStart(8)}${String(row.p95 + 'ms').padStart(8)}`
    + `${String(ok + '/' + RUNS).padStart(7)}`
    + (AVOID ? `   avoid: ov ${row.avoidOv.toFixed(3)} ident ${row.avoidIdent.toFixed(2)} `
      + `qual ${row.avoidQual.toFixed(4)} p95 ${row.avoidP95}ms` : ''));
}

const mean = (f) => rows.reduce((a, r) => a + f(r), 0) / rows.length;
console.log(`\nMEAN                  ${mean((r) => r.overlap).toFixed(3).padStart(5)}`
  + `${mean((r) => r.ident).toFixed(2).padStart(7)}`
  + `${mean((r) => r.qual).toFixed(4).padStart(8)}`
  + `${mean((r) => r.zipf).toFixed(3).padStart(8)}`
  + `${String(Math.max(...rows.map((r) => r.p95)) + 'ms').padStart(16)} (worst p95)`);

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify({ label: LABEL, runs: RUNS, rows }, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
