// How large a grid can this corpus HONESTLY fill?
//
//   node scripts/bench-bigrid.mjs                     # every shipped layout
//   node scripts/bench-bigrid.mjs --seeds 8
//   node scripts/bench-bigrid.mjs --only 21,25        # only these grid sizes
//   node scripts/bench-bigrid.mjs --candidates c.json # screen gen-layouts.mjs output
//   node scripts/bench-bigrid.mjs --json out.json
//
// bench-solver.mjs asks "do the shipped layouts still fill, fast, correctly". This asks
// the different question: WHERE IS THE CEILING, and when a grid is past it, WHY.
//
// "It failed" is useless. So every failed run is decomposed by slot length, using the
// solver's own starvation report (solver.js -> error.detail.starvation):
//
//   slots      how many slots of that length the layout has
//   filled     how many the best partial fill managed
//   starved    unfilled slots with ZERO answers left once crossing letters are applied
//   deadEnds   how many times the search backtracked out of a slot of that length
//   cand med   median answers still fitting an unfilled slot of that length
//   corpus     how many answers of that length EXIST at all
//
// The last two columns are the point: a length whose corpus number is large but whose
// candidate median is 0 is a crossing problem; a length whose corpus number is itself
// tiny is a word-list problem and no amount of search time fixes it.
//
// Timeouts default to a generous budget that scales with grid area (30s at 15x15, ~60s
// at 21x21), because the question here is feasibility, not latency. Per-case wall time
// is printed so the cost of that generosity is visible.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(path.isAbsolute(p) ? p : path.join(ROOT, p)).href;

const { decodeCorpus, buildWordIndex } = await import(url('src/utils/wordIndex.js'));
const { solveCrossword } = await import(url('src/utils/solver.js'));
const { findSlots, getLayoutStats } = await import(url('src/utils/crosswordUtils.js'));
const layoutsMod = await import(url('src/data/layouts.js'));

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SEEDS = Number(arg('--seeds', 5));
const ONLY = (arg('--only', '') || '').split(',').filter(Boolean).map(Number);
const CANDIDATES = arg('--candidates', null);
const JSON_OUT = arg('--json', null);
const FIXED_TIMEOUT = arg('--timeout', null);
const DIFFS = (arg('--diffs', 'random,easy,moderate,hard') || '').split(',');

const DIFF_TARGETS = { random: null, easy: 0.1, fair: 0.3, moderate: 0.5, hard: 0.7, difficult: 0.9 };

// 30s at 15x15, scaled by area, capped. Generous on purpose: a grid that needs a minute
// is a different verdict from one that cannot be filled at all, and this has to tell
// them apart rather than call both "timeout".
const timeoutFor = (size) => (FIXED_TIMEOUT ? Number(FIXED_TIMEOUT)
  : Math.min(120000, Math.max(15000, Math.round(30000 * ((size * size) / 225)))));

// ---------------------------------------------------------------- corpus
const binPath = path.join(ROOT, 'public', 'corpus', 'corpus.bin');
if (!fs.existsSync(binPath)) { console.error(`missing ${binPath}`); process.exit(1); }
const buf = fs.readFileSync(binPath);
const corpus = decodeCorpus(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const index = buildWordIndex(corpus.entries, { presorted: true, fingerprint: 'bigrid' });

console.log(`corpus  ${corpus.entries.length.toLocaleString()} distinct answers`);
console.log(`node    ${process.version} · ${os.cpus()[0]?.model?.trim() || 'cpu'}`);
console.log(`seeds   ${SEEDS} per case · difficulties ${DIFFS.join(', ')}\n`);

console.log('answers per length (the hard ceiling on any layout):');
{
  const cells = [];
  for (let L = index.minLen; L <= index.maxLen; L++) {
    const li = index.byLen[L];
    cells.push(`${String(L).padStart(2)}:${String(li ? li.count : 0).padStart(6)}`);
  }
  for (let i = 0; i < cells.length; i += 7) console.log('  ' + cells.slice(i, i + 7).join('  '));
}
console.log('');

// ---------------------------------------------------------------- layouts
const SHIPPED = [
  ...(layoutsMod.DEFAULT_LAYOUTS || []),
  ...(layoutsMod.EXTRA_LAYOUTS || []),
];
let LAYOUTS = SHIPPED.map((l) => ({ name: l.name, grid: l.grid }));
if (CANDIDATES) {
  const c = JSON.parse(fs.readFileSync(CANDIDATES, 'utf8'));
  LAYOUTS = c.map((x, i) => ({ name: `cand-${x.size}x${x.size}#${i}`, grid: x.grid }));
}
const sizeOf = (g) => g.length;
if (ONLY.length) LAYOUTS = LAYOUTS.filter((l) => ONLY.includes(sizeOf(l.grid)));
// A layout list with duplicates in it would double every measurement below.
LAYOUTS = LAYOUTS.filter((l, i, a) => a.findIndex((x) => x.name === l.name) === i);
LAYOUTS.sort((a, b) => sizeOf(a.grid) - sizeOf(b.grid) || a.name.localeCompare(b.name));

const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
const hist = (grid) => Object.entries(getLayoutStats(grid).lengthCounts || {})
  .sort((a, b) => a[0] - b[0]).map(([l, n]) => `${l}x${n}`).join(' ');

// ---------------------------------------------------------------- sweep
console.log('=== fill sweep ===');
console.log('layout                    size  slots  difficulty   filled     p50     p95     max  timeouts');

const results = [];
const started = Date.now();

for (const layout of LAYOUTS) {
  const size = sizeOf(layout.grid);
  const slots = findSlots(layout.grid.map((r) => (Array.isArray(r) ? r : r.split(''))));
  const timeoutMs = timeoutFor(size);
  const perLayout = {
    name: layout.name, size, slots: slots.length, timeoutMs,
    lengthHistogram: getLayoutStats(layout.grid).lengthCounts,
    cases: [],
  };
  for (const dname of DIFFS) {
    const dtarget = DIFF_TARGETS[dname];
    const times = [];
    let ok = 0, timeouts = 0;
    const starveAgg = new Map();     // len -> aggregate row
    const codes = new Map();
    let bestPartial = 0;
    for (let s = 0; s < SEEDS; s++) {
      const seed = 1000 + s * 7919;
      const st = Date.now();
      const r = solveCrossword({ index, layout: layout.grid, seed, timeoutMs, difficultyTarget: dtarget });
      const ms = Date.now() - st;
      times.push(ms);
      if (r.complete) { ok++; continue; }
      codes.set(r.error?.code, (codes.get(r.error?.code) || 0) + 1);
      if (r.error?.code === 'TIMEOUT') timeouts++;
      bestPartial = Math.max(bestPartial, r.placements.length);
      for (const row of r.starvation?.byLength || []) {
        let a = starveAgg.get(row.len);
        if (!a) starveAgg.set(row.len, (a = { len: row.len, slots: row.slots, corpus: row.corpus,
          filled: 0, starved: 0, deadEnds: 0, med: [], n: 0 }));
        a.n++;
        a.filled += row.filled;
        a.starved += row.starved;
        a.deadEnds += row.deadEnds;
        if (row.medianCandidates != null) a.med.push(row.medianCandidates);
      }
    }
    const rate = `${ok}/${SEEDS}`;
    console.log(
      `${layout.name.padEnd(26)}${String(size + 'x' + size).padStart(5)}`
      + `${String(slots.length).padStart(7)}  ${dname.padEnd(11)}${rate.padStart(7)}`
      + `${String(pct(times, 0.5) + 'ms').padStart(8)}${String(pct(times, 0.95) + 'ms').padStart(8)}`
      + `${String(Math.max(...times) + 'ms').padStart(8)}${String(timeouts).padStart(10)}`);

    const why = [...starveAgg.values()].map((a) => ({
      len: a.len, slots: a.slots, corpus: a.corpus,
      avgFilled: +(a.filled / a.n).toFixed(1),
      avgStarved: +(a.starved / a.n).toFixed(1),
      avgDeadEnds: Math.round(a.deadEnds / a.n),
      medCandidates: a.med.length ? pct(a.med, 0.5) : null,
    })).sort((x, y) => y.avgStarved - x.avgStarved || y.avgDeadEnds - x.avgDeadEnds);

    perLayout.cases.push({
      difficulty: dname, ok, seeds: SEEDS, timeouts, bestPartial,
      p50: pct(times, 0.5), p95: pct(times, 0.95), max: Math.max(...times),
      codes: Object.fromEntries(codes), why,
    });
  }
  perLayout.histogram = hist(layout.grid);
  results.push(perLayout);
}

// ---------------------------------------------------------------- why it failed
console.log('\n=== why the failures failed (per layout, worst difficulty first) ===');
for (const L of results) {
  const bad = L.cases.filter((c) => c.ok < c.seeds);
  if (!bad.length) continue;
  console.log(`\n${L.name}  (${L.size}x${L.size}, ${L.slots} slots, lengths ${L.histogram}, budget ${(L.timeoutMs / 1000).toFixed(0)}s)`);
  for (const c of bad.sort((a, b) => a.ok - b.ok)) {
    const codes = Object.entries(c.codes).map(([k, v]) => `${k}x${v}`).join(' ');
    console.log(`  ${c.difficulty.padEnd(10)} ${c.ok}/${c.seeds} filled · best partial ${c.bestPartial}/${L.slots} · ${codes}`);
    console.log('     len  slots  filled  starved  deadEnds  cand med  corpus');
    for (const w of c.why.slice(0, 6)) {
      console.log(`    ${String(w.len).padStart(4)}${String(w.slots).padStart(7)}`
        + `${String(w.avgFilled).padStart(8)}${String(w.avgStarved).padStart(9)}`
        + `${String(w.avgDeadEnds).padStart(10)}${String(w.medCandidates ?? '-').padStart(10)}`
        + `${String(w.corpus).padStart(8)}`);
    }
  }
}

// ---------------------------------------------------------------- verdict
console.log('\n=== verdict ===');
console.log('layout                    size  slots   fill    p95     max  verdict');
for (const L of results) {
  const okAll = L.cases.reduce((a, c) => a + c.ok, 0);
  const runs = L.cases.reduce((a, c) => a + c.seeds, 0);
  const p95 = Math.max(...L.cases.map((c) => c.p95));
  const max = Math.max(...L.cases.map((c) => c.max));
  const rate = okAll / runs;
  // Reliable means "fills every seed at every difficulty, fast enough to wait for".
  // Marginal means "fills, but not always, or not quickly". Hopeless means the corpus,
  // not the search, is the limit -- read the starvation table above for which lengths.
  const verdict = rate === 1 && p95 <= 3000 ? 'reliable'
    : rate === 1 ? 'reliable (slow)'
      : rate >= 0.8 ? 'marginal'
        : rate > 0 ? 'unreliable'
          : 'hopeless';
  console.log(`${L.name.padEnd(26)}${String(L.size + 'x' + L.size).padStart(5)}`
    + `${String(L.slots).padStart(7)}${String(Math.round(rate * 100) + '%').padStart(7)}`
    + `${String(p95 + 'ms').padStart(8)}${String(max + 'ms').padStart(8)}  ${verdict}`);
}
console.log(`\ntotal wall time ${((Date.now() - started) / 1000).toFixed(1)}s`);

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify({ seeds: SEEDS, diffs: DIFFS, results }, null, 1));
  console.log(`wrote ${JSON_OUT}`);
}
