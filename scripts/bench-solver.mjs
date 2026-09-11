// Generator benchmark + correctness gates.
//
//   node scripts/bench-solver.mjs              # full sweep
//   node scripts/bench-solver.mjs --seeds 5    # quicker
//   node scripts/bench-solver.mjs --old        # also run the pre-rewrite solver
//
// Gates (exit 1 on failure):
//   * every shipped layout fills, at every difficulty setting, for every seed
//   * p95 fill time under the budget
//   * zero duplicate answers in any grid
//   * zero clues matching the cross-reference / grid-dependent filters
//   * every adversarial layout resolves fast — solved or refused, never grinding
//
// The --old comparison exists so the before/after numbers are measurements rather than
// claims. It reads the previous solver out of git, so nothing needs to be kept around.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(path.isAbsolute(p) ? p : path.join(ROOT, p)).href;

const { decodeCorpus, buildWordIndex } = await import(url('src/utils/wordIndex.js'));
const { solveCrossword } = await import(url('src/utils/solver.js'));
const { assignClues } = await import(url('src/utils/clueIndex.js'));
const { clueRejectReason } = await import(url('src/utils/clueFilters.js'));
const { DEFAULT_LAYOUTS } = await import(url('src/data/layouts.js'));
const { mulberry32 } = await import(url('src/utils/rng.js'));

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const SEEDS = Number(arg('--seeds', 20));
const TIMEOUT = Number(arg('--timeout', 10000));
const P95_BUDGET = Number(arg('--budget', 2000));
const RUN_OLD = argv.includes('--old');

const DIFFICULTIES = [
  ['random', null], ['easy', 0.1], ['fair', 0.3],
  ['moderate', 0.5], ['hard', 0.7], ['difficult', 0.9],
];

// ---------------------------------------------------------------- corpus
const binPath = path.join(ROOT, 'public', 'corpus', 'corpus.bin');
if (!fs.existsSync(binPath)) {
  console.error(`missing ${binPath}\nrun: python pipeline/stages/s1_clean.py && python pipeline/stages/s7_pack.py`);
  process.exit(1);
}
const buf = fs.readFileSync(binPath);
const t0 = Date.now();
const corpus = decodeCorpus(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const decodeMs = Date.now() - t0;
const t1 = Date.now();
const index = buildWordIndex(corpus.entries, { presorted: true, fingerprint: 'bench' });
const buildMs = Date.now() - t1;

console.log(`corpus  ${(buf.length / 1e6).toFixed(2)} MB · ${corpus.entries.length.toLocaleString()} answers`);
console.log(`load    decode ${decodeMs}ms + index ${buildMs}ms = ${decodeMs + buildMs}ms`);
console.log(`node    ${process.version} · ${os.cpus()[0]?.model?.trim() || 'cpu'}\n`);

const pct = (a, p) => (a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);

let failures = [];
const note = (msg) => { failures.push(msg); console.log(`   FAIL  ${msg}`); };

// Ground truth for "does this clue belong to this answer", read straight from the
// pipeline's own output rather than from the artifact under test.
const pairSet = new Set();
{
  const pairsPath = path.join(ROOT, 'pipeline', 'out', 'pairs.csv');
  if (fs.existsSync(pairsPath)) {
    const text = fs.readFileSync(pairsPath, 'utf8');
    const LF = String.fromCharCode(10);
    let i = text.indexOf(LF) + 1;            // skip the header row
    while (i < text.length) {
      const nl = text.indexOf(LF, i);
      const line = text.slice(i, nl < 0 ? text.length : nl).replace(/\r$/, '');
      i = nl < 0 ? text.length : nl + 1;
      if (!line) continue;
      const comma = line.indexOf(',');
      if (comma < 0) continue;
      const word = line.slice(0, comma);
      let rest = line.slice(comma + 1);
      // clue is either quoted (with "" escapes) or runs to the next comma
      let clue;
      if (rest.startsWith('"')) {
        let j = 1, out = '';
        while (j < rest.length) {
          if (rest[j] === '"') {
            if (rest[j + 1] === '"') { out += '"'; j += 2; continue; }
            break;
          }
          out += rest[j++];
        }
        clue = out;
      } else {
        const c2 = rest.indexOf(',');
        clue = c2 < 0 ? rest : rest.slice(0, c2);
      }
      pairSet.add(`${word} ${clue}`);
    }
  } else {
    console.log('  note: pipeline/out/pairs.csv missing — clue-ownership gate disabled');
  }
}
console.log(`ground truth  ${pairSet.size.toLocaleString()} known (answer, clue) pairs
`);

// ---------------------------------------------------------------- sweep
console.log('=== fill sweep ===');
console.log('layout              difficulty   ok      p50     p95    nodes    bt   rs');

const allTimes = [];
let totalRuns = 0, totalOk = 0, dupTotal = 0, badClueTotal = 0, emptyClueTotal = 0, mismatchTotal = 0;
let gridMismatchTotal = 0, notInDictTotal = 0;
const dictionary = new Set(corpus.entries.map((e) => e.word));

for (const layout of DEFAULT_LAYOUTS) {
  for (const [dname, dtarget] of DIFFICULTIES) {
    const times = [], nodes = [], bts = [], rss = [];
    let ok = 0;
    for (let s = 0; s < SEEDS; s++) {
      const seed = 1000 + s * 7919;
      const st = Date.now();
      const r = solveCrossword({
        index, layout: layout.grid, seed, timeoutMs: TIMEOUT,
        difficultyTarget: dtarget,
      });
      const ms = Date.now() - st;
      totalRuns++;
      times.push(ms); allTimes.push(ms);
      nodes.push(r.stats.nodes); bts.push(r.stats.backtracks); rss.push(r.stats.restarts);
      if (!r.complete) {
        note(`${layout.name} / ${dname} / seed ${seed}: ${r.error?.code} ${r.error?.message}`);
        continue;
      }
      ok++; totalOk++;

      // gate: the GRID must agree with the placements, and every entry read off the
      // grid must be a real dictionary word.
      //
      // This is the gate that matters most and the one that was missing: a propagation
      // bug let two assigned slots disagree on a shared letter, so the grid contained
      // strings like COATT where the placement said COAST. Duplicate and clue checks
      // both passed throughout, because they only ever looked at `placements`.
      const gridOf = (row, col, dir, len) => {
        let s = '';
        for (let i = 0; i < len; i++) {
          const ch = r.grid[dir === 'across' ? row : row + i][dir === 'across' ? col + i : col];
          if (!ch || ch === '#') return null;
          s += ch;
        }
        return s;
      };
      for (const p of r.placements) {
        const fromGrid = gridOf(p.slot.row, p.slot.col, p.slot.direction, p.slot.length);
        if (fromGrid !== p.word) {
          gridMismatchTotal++;
          note(`${layout.name}/${dname}/seed ${seed}: grid reads ${fromGrid} where the placement says ${p.word}`);
        } else if (!dictionary.has(p.word)) {
          notInDictTotal++;
          note(`${layout.name}/${dname}/seed ${seed}: ${p.word} is not in the word list`);
        }
      }

      // gate: no repeated answers
      const seen = new Set();
      for (const p of r.placements) {
        if (seen.has(p.word)) { dupTotal++; note(`${layout.name}/${dname}/seed ${seed}: duplicate answer ${p.word}`); }
        seen.add(p.word);
      }

      // gate: no cross-reference / grid-dependent clues
      const rng = mulberry32(seed);
      const withClues = assignClues(r.placements, {
        store: corpus.clueStore, difficultyTarget: dtarget, rng,
      });
      for (const p of withClues) {
        if (!p.clue) { emptyClueTotal++; continue; }
        const why = clueRejectReason(p.clue);
        if (why) { badClueTotal++; note(`${layout.name}/${dname}: clue rejected (${why}) for ${p.word}: ${p.clue}`); }
        // The clue must actually belong to this answer. Without this, an off-by-index
        // lookup hands every answer some other word's clue and every other gate still
        // passes — the puzzle is simply unsolvable.
        if (!pairSet.has(`${p.word} ${p.clue}`)) {
          mismatchTotal++;
          note(`${layout.name}/${dname}: clue does not belong to ${p.word}: "${p.clue}"`);
        }
      }
    }
    const p50 = pct(times, 0.5), p95 = pct(times, 0.95);
    const flag = ok === SEEDS ? ' ' : '!';
    console.log(
      `${layout.name.padEnd(20)}${dname.padEnd(11)}${String(ok + '/' + SEEDS).padStart(6)}`
      + `${String(p50 + 'ms').padStart(8)}${String(p95 + 'ms').padStart(8)}`
      + `${String(Math.round(nodes.reduce((a, b) => a + b, 0) / nodes.length)).padStart(8)}`
      + `${String(Math.round(bts.reduce((a, b) => a + b, 0) / bts.length)).padStart(6)}`
      + `${String(Math.max(...rss)).padStart(5)} ${flag}`);
  }
}

const P50 = pct(allTimes, 0.5), P95 = pct(allTimes, 0.95), PMAX = Math.max(...allTimes);
console.log(`\noverall  ${totalOk}/${totalRuns} filled · p50 ${P50}ms · p95 ${P95}ms · max ${PMAX}ms`);
console.log(`         grid/placement mismatches: ${gridMismatchTotal} · answers not in word list: ${notInDictTotal}`);
console.log(`         duplicate answers: ${dupTotal} · rejected clues: ${badClueTotal} · mismatched clues: ${mismatchTotal} · unclued answers: ${emptyClueTotal}`);

if (P95 > P95_BUDGET) note(`p95 ${P95}ms exceeds ${P95_BUDGET}ms budget`);

// ---------------------------------------------------------------- adversarial
console.log('\n=== adversarial (must resolve fast, either way) ===');
const G = (n) => Array.from({ length: n }, () => Array(n).fill(null));
const ADVERSARIAL = [
  ['2-letter slot (no such words)', { layout: ['...#.', '.##..', '.....', '..##.', '.#...'] }],
  ['fully-open 5x5 word square', { layout: ['.....', '.....', '.....', '.....', '.....'] }],
  ['open 15x15 @ easy', { layout: DEFAULT_LAYOUTS.find((l) => l.name === 'Open 15x15').grid, difficultyTarget: 0.1 }],
  ['no slots', { layout: ['#.#', '.#.', '#.#'] }],
  ['ragged layout', { layout: ['.....', '....', '.....'] }],
  ['impossible preset _QQ__', { layout: ['.....', '.....', '.....', '.....', '.....'], presetGrid: (() => { const p = G(5); p[0][1] = 'Q'; p[0][2] = 'Q'; return p; })() }],
  ['required word too long', { layout: ['#....', '.....', '.....', '.....', '....#'], requiredWordsList: ['ABCDEFGHIJ'] }],
  ['requireds oversubscribed', { layout: ['#....', '.....', '.....', '.....', '....#'], requiredWordsList: ['ARENA', 'ERASE', 'EERIE', 'SNIDE', 'STADT', 'TRADE', 'SPARE'] }],
];
for (const [name, opts] of ADVERSARIAL) {
  const st = Date.now();
  const r = solveCrossword({ index, seed: 42, timeoutMs: TIMEOUT, ...opts });
  const ms = Date.now() - st;
  const verdict = r.error ? `refused [${r.error.code}]` : `solved ${r.placements.length} answers`;
  console.log(`${name.padEnd(32)}${String(ms + 'ms').padStart(8)}  ${verdict}`);
  if (ms > 2000) note(`${name}: took ${ms}ms — must resolve in under 2s`);
  if (r.error && ms > 200 && !r.placements.length && r.error.code !== 'TIMEOUT' && r.error.code !== 'NO_SOLUTION') {
    note(`${name}: preflight refusal took ${ms}ms — must be under 200ms`);
  }
}

// ---------------------------------------------------------------- old solver
if (RUN_OLD) {
  console.log('\n=== previous solver (from git HEAD) ===');
  const tmp = path.join(os.tmpdir(), `old-solver-${Date.now()}.mjs`);
  try {
    let src = execSync('git show HEAD:src/utils/solver.js', { cwd: ROOT, encoding: 'utf8' });
    src = src.replace(/from '\.\/crosswordUtils\.js'/, `from ${JSON.stringify(url('src/utils/crosswordUtils.js'))}`);
    fs.writeFileSync(tmp, src);
    const { solveCrossword: oldSolve } = await import(url(tmp));

    // The old solver ate raw CSV rows, so feed it exactly what the app fed it.
    const csv = fs.readFileSync(path.join(ROOT, 'public', 'crosswords.csv'), 'latin1');
    const { parseCSV } = await import(url('src/utils/crosswordUtils.js'));
    const pt = Date.now();
    const rows = parseCSV(csv);
    console.log(`  parseCSV: ${Date.now() - pt}ms for ${rows.length.toLocaleString()} rows `
      + `(new path: ${decodeMs + buildMs}ms for ${corpus.entries.length.toLocaleString()} answers)`);

    for (const name of ['Mini 5x5 - Cross', 'Classic 15x15', 'Standard 15x15']) {
      const layout = DEFAULT_LAYOUTS.find((l) => l.name === name).grid;
      const st = Date.now();
      const r = oldSolve({ wordList: rows, layout, timeoutMs: 30000 });
      const ms = Date.now() - st;
      const seen = new Set(); let dups = 0;
      for (const p of (r.placements || [])) { if (seen.has(p.word)) dups++; seen.add(p.word); }
      console.log(`  ${name.padEnd(18)}${String(ms + 'ms').padStart(9)}  `
        + `${r.complete ? 'ok' : 'INCOMPLETE'} ${(r.placements || []).length} answers, `
        + `${r.attempts} attempts, ${dups} duplicates`);
    }
  } catch (e) {
    console.log('  skipped:', e.message.split('\n')[0]);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------- verdict
console.log('');
if (failures.length) {
  console.log(`FAILED — ${failures.length} problem${failures.length === 1 ? '' : 's'}`);
  process.exit(1);
}
console.log('PASSED — all gates met');
