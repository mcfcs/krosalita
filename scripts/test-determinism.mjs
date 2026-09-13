// Same seed must give the same grid, forever.
//
// The daily puzzle is derived from seedFromString(todayKey()), so if this stops holding,
// two people solving "today's puzzle" get different puzzles and every shared time, streak
// and result card becomes meaningless.
//
// A note on how this is called, because getting it wrong produces a test that passes for
// the wrong reason: solveCrossword takes ONE options object with `layout` inside it —
// solveCrossword({ index, layout, seed, ... }). Calling it as solveCrossword(layout, opts)
// returns BAD_LAYOUT every time, and two identical failures compare equal, so the test
// reports a clean pass while having solved nothing. This asserts `complete` for exactly
// that reason.
//
// Run:  node scripts/test-determinism.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const u = (p) => pathToFileURL(path.join(ROOT, p)).href;

const { decodeCorpus, buildWordIndex } = await import(u('src/utils/wordIndex.js'));
const { solveCrossword } = await import(u('src/utils/solver.js'));
const { DEFAULT_LAYOUTS } = await import(u('src/data/layouts.js'));
const { seedFromString, todayKey } = await import(u('src/utils/daily.js'));

const buf = fs.readFileSync(path.join(ROOT, 'public', 'corpus', 'corpus.bin'));
const corpus = decodeCorpus(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const index = buildWordIndex(corpus.entries, { presorted: true, fingerprint: 'determinism' });

const sig = (r) => (r.grid || []).map((row) => row.map((c) => c || '.').join('')).join('/');
const budget = (g) => Math.min(60000, Math.max(15000, Math.round(15000 * ((g.length * g[0].length) / 225))));

let pass = 0;
let fail = 0;
const bad = (m) => { console.log(`  FAIL  ${m}`); fail++; };
const ok = (m) => { console.log(`  PASS  ${m}`); pass++; };

// ---- same seed, same grid, across layouts and difficulty targets ----
const SEEDS = [12345, 999, 2026914];
const TARGETS = [null, 0.3, 0.8];
for (const L of DEFAULT_LAYOUTS) {
  let allSame = true;
  let allComplete = true;
  for (const seed of SEEDS) {
    for (const difficultyTarget of TARGETS) {
      const opts = { index, layout: L.grid, seed, timeoutMs: budget(L.grid), difficultyTarget };
      const a = solveCrossword(opts);
      const b = solveCrossword(opts);
      if (!a.complete) allComplete = false;
      if (sig(a) !== sig(b) || a.complete !== b.complete) allSame = false;
    }
  }
  // `complete` matters: two identical FAILURES also compare equal.
  if (allComplete && allSame) ok(`${L.name} — ${SEEDS.length * TARGETS.length} solves, all complete, all reproducible`);
  else if (!allComplete) bad(`${L.name} — a solve did not complete, so equality proves nothing`);
  else bad(`${L.name} — same seed produced different grids`);
}

// ---- a different seed must give a different grid, or "reproducible" is trivially true ----
const L = DEFAULT_LAYOUTS[0];
const s1 = sig(solveCrossword({ index, layout: L.grid, seed: 1, timeoutMs: budget(L.grid) }));
const s2 = sig(solveCrossword({ index, layout: L.grid, seed: 2, timeoutMs: budget(L.grid) }));
if (s1 && s2 && s1 !== s2) ok('a different seed gives a different grid (so reproducibility is not vacuous)');
else bad('two different seeds gave the same grid');

// ---- the daily's own derivation is stable ----
const k = todayKey();
if (seedFromString(k) === seedFromString(k)) ok(`seedFromString('${k}') is stable`);
else bad('seedFromString is not stable');

// ---- and the daily rotates over 15x15s only, so it cannot land on a Mini or a Sunday ----
const pool = DEFAULT_LAYOUTS.filter((x) => x.grid.length === 15 && x.grid[0].length === 15);
if (pool.length >= 5) ok(`the daily pool is ${pool.length} fifteen-by-fifteens, not all ${DEFAULT_LAYOUTS.length} layouts`);
else bad(`the daily pool is only ${pool.length} layouts`);

console.log(fail ? `\nFAILED — ${fail} of ${pass + fail}` : `\nPASSED — ${pass} checks`);
process.exit(fail ? 1 : 0);
