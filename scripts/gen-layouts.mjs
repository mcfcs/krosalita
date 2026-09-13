// Symmetric crossword-grid generator + validator.
//
//   node scripts/gen-layouts.mjs --size 21 --blocks 68 --count 4 --seed 7
//
// Produces American-style layouts: 180-degree rotational block symmetry, every white run
// >= 3 (which also means every white square is CHECKED -- it is in both an across and a
// down entry), all white squares connected, and no run longer than the corpus's
// MAX_WORD_LEN. Candidates are validated with the app's own findSlots/getLayoutStats
// before they are printed, so what comes out of here is what the solver will see.
//
// The search is plain hill-climbing: drop a symmetric block pair, keep it if the grid is
// still legal, stop at the target block count. Hand-drawing a 21x21 and getting all four
// invariants right is not realistic; this is.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;
const { findSlots, getLayoutStats } = await import(url('src/utils/crosswordUtils.js'));
const { MAX_WORD_LEN } = await import(url('src/utils/wordIndex.js'));
const { mulberry32 } = await import(url('src/utils/rng.js'));

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const SIZE = Number(arg('--size', 15));
const BLOCKS = Number(arg('--blocks', Math.round(SIZE * SIZE * 0.16)));
const COUNT = Number(arg('--count', 2));
const SEED = Number(arg('--seed', 1));
const MAXRUN = Number(arg('--maxrun', MAX_WORD_LEN));
const MINRUN = 3;

const key = (r, c) => r * SIZE + c;

/** every maximal white run in both directions is >= MINRUN and <= MAXRUN */
function runsOk(g) {
  for (let r = 0; r < SIZE; r++) {
    let n = 0;
    for (let c = 0; c <= SIZE; c++) {
      if (c < SIZE && g[key(r, c)] === 0) { n++; continue; }
      if (n > 0 && (n < MINRUN || n > MAXRUN)) return false;
      n = 0;
    }
  }
  for (let c = 0; c < SIZE; c++) {
    let n = 0;
    for (let r = 0; r <= SIZE; r++) {
      if (r < SIZE && g[key(r, c)] === 0) { n++; continue; }
      if (n > 0 && (n < MINRUN || n > MAXRUN)) return false;
      n = 0;
    }
  }
  return true;
}

function connected(g) {
  let start = -1;
  let white = 0;
  for (let i = 0; i < SIZE * SIZE; i++) if (g[i] === 0) { white++; if (start < 0) start = i; }
  if (start < 0) return false;
  const seen = new Uint8Array(SIZE * SIZE);
  const stack = [start];
  seen[start] = 1;
  let n = 0;
  while (stack.length) {
    const i = stack.pop(); n++;
    const r = (i / SIZE) | 0, c = i % SIZE;
    const nb = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
    for (const [rr, cc] of nb) {
      if (rr < 0 || cc < 0 || rr >= SIZE || cc >= SIZE) continue;
      const j = key(rr, cc);
      if (g[j] !== 0 || seen[j]) continue;
      seen[j] = 1; stack.push(j);
    }
  }
  return n === white;
}

const legal = (g) => runsOk(g) && connected(g);

function generate(rng) {
  const g = new Uint8Array(SIZE * SIZE);
  // Seed the grid so long rows get broken up at all (a blank 21x21 has 21-long runs,
  // which no 15-letter corpus can fill).
  let blocks = 0;
  let stall = 0;
  while (blocks < BLOCKS && stall < 4000) {
    const r = (rng() * SIZE) | 0;
    const c = (rng() * SIZE) | 0;
    const i = key(r, c);
    const j = key(SIZE - 1 - r, SIZE - 1 - c);
    if (g[i] === 1) { stall++; continue; }
    g[i] = 1; g[j] = 1;
    if (!legal(g) && !(blocks + 2 < BLOCKS && !runsOk(g) && relaxed(g))) {
      g[i] = 0; g[j] = 0; stall++; continue;
    }
    blocks = g.reduce((a, b) => a + b, 0);
    stall = 0;
  }
  return legal(g) ? g : null;
}

// While the grid still has over-long runs, an illegal intermediate is allowed as long as
// it breaks no MINRUN rule and stays connected -- otherwise the first block pair in a
// 21x21 can never be placed.
function relaxed(g) {
  for (let r = 0; r < SIZE; r++) {
    let n = 0;
    for (let c = 0; c <= SIZE; c++) {
      if (c < SIZE && g[key(r, c)] === 0) { n++; continue; }
      if (n > 0 && n < MINRUN) return false;
      n = 0;
    }
  }
  for (let c = 0; c < SIZE; c++) {
    let n = 0;
    for (let r = 0; r <= SIZE; r++) {
      if (r < SIZE && g[key(r, c)] === 0) { n++; continue; }
      if (n > 0 && n < MINRUN) return false;
      n = 0;
    }
  }
  return connected(g);
}

const toRows = (g) => {
  const out = [];
  for (let r = 0; r < SIZE; r++) {
    let s = '';
    for (let c = 0; c < SIZE; c++) s += g[key(r, c)] ? '#' : '.';
    out.push(s);
  }
  return out;
};

const rng = mulberry32(SEED >>> 0);
const found = [];
const seen = new Set();
for (let attempt = 0; attempt < 4000 && found.length < COUNT; attempt++) {
  const g = generate(rng);
  if (!g) continue;
  const rows = toRows(g);
  const sig = rows.join('/');
  if (seen.has(sig)) continue;
  seen.add(sig);
  // Validate with the app's own code, not with the generator's private notion of a slot.
  const slots = findSlots(rows.map((r) => r.split('')));
  if (slots.some((s) => s.length < MINRUN || s.length > MAXRUN)) continue;
  const stats = getLayoutStats(rows);
  found.push({ rows, slots, stats });
}

for (const f of found) {
  const hist = Object.entries(f.stats.lengthCounts).sort((a, b) => a[0] - b[0])
    .map(([l, n]) => `${l}:${n}`).join(' ');
  console.log(`\n// ${SIZE}x${SIZE} · ${f.slots.length} slots · ${f.stats.blackCells} blocks `
    + `(${((f.stats.blackCells / (SIZE * SIZE)) * 100).toFixed(0)}%) · ${hist}`);
  console.log('grid: [');
  console.log(f.rows.map((r) => `      "${r}"`).join(',\n'));
  console.log(']');
}
if (!found.length) console.log('no valid grid found — loosen --blocks or raise --maxrun');

// --json <file> also dumps the candidates so scripts/bench-bigrid.mjs can screen them.
const JSON_OUT = arg('--json', null);
if (JSON_OUT) {
  const fs = await import('node:fs');
  fs.writeFileSync(JSON_OUT, JSON.stringify(found.map((f) => ({
    size: SIZE, blocks: f.stats.blackCells, slots: f.slots.length,
    lengthCounts: f.stats.lengthCounts, grid: f.rows,
  })), null, 1));
  console.log(`\nwrote ${found.length} candidates to ${JSON_OUT}`);
}
