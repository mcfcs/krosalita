// Difficulty-BAND benchmark.
//
//   node scripts/bench-difficulty.mjs                     # default sweep, both modes
//   node scripts/bench-difficulty.mjs --runs 12
//   node scripts/bench-difficulty.mjs --mode answer       # answer-quantile target only
//   node scripts/bench-difficulty.mjs --mode clue         # clue-quantile target only
//   node scripts/bench-difficulty.mjs --legacy old.js     # add a "before" row that uses
//                                                         # another copy of clueIndex.js
//                                                         # (e.g. git show HEAD:...)
//   node scripts/bench-difficulty.mjs --layouts "Classic 15x15,Mini 5x5 - Cross"
//   node scripts/bench-difficulty.mjs --json out.json
//
// The user-visible complaint is "choosing a difficulty doesn't generate a puzzle of that
// difficulty". Difficulty is experienced in the CLUES, so that is what this measures.
//
// For each (layout, band) it generates N puzzles through the exact path the worker uses
// -- solveCrossword() for the fill, then the real assignClues() for the clues -- and
// reports:
//
//   cdiff    mean packed clue difficulty of the ASSIGNED clues (0..1, corpus scale)
//   cpct     that mean's percentile in the corpus CLUE-difficulty distribution
//   mdlp     mean per-clue percentile from the real cold-start scorer
//            (src/utils/clueScore.js + public/corpus/clue-model.json). Independent of
//            the packed label the selector optimises, so it is the honest check.
//   adiff    mean ANSWER difficulty of the fill
//   shown    the percentile App.jsx displays = percentileIn(difficultyMean/100, answerQ)
//
// The bar is separation: Easy and Difficult must not be the same puzzle.
//
// Modes, all sharing one fill per seed so they differ ONLY in clue assignment:
//   answer   current assignClues, target taken from the ANSWER difficulty quantiles
//   clue     current assignClues, target taken from the CLUE difficulty quantiles
//   before   --legacy <path>'s assignClues with the answer-quantile target, i.e. the
//            shipped behaviour, loaded rather than reimplemented:
//              git show HEAD:src/utils/clueIndex.js > /tmp/old-clueIndex.js

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(path.isAbsolute(p) ? p : path.join(ROOT, p)).href;

const { decodeCorpus, buildWordIndex } = await import(url('src/utils/wordIndex.js'));
const { solveCrossword } = await import(url('src/utils/solver.js'));
const { DEFAULT_LAYOUTS } = await import(url('src/data/layouts.js'));
const { difficultyTargetOf, DIFFICULTY_BANDS } = await import(url('src/utils/difficulty.js'));
// The SAME helpers the worker calls -- not a copy. If these drift, both drift together.
const {
  assignClues, cluesForWord, clueDiffQuantiles, targetForBand, percentileIn,
} = await import(url('src/utils/clueIndex.js'));
const {
  loadClueModel, scoreClue, scorePercentile, answerFeaturesFrom,
} = await import(url('src/utils/clueScore.js'));

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const RUNS = Number(arg('--runs', 8));
const TIMEOUT = Number(arg('--timeout', 10000));
const JSON_OUT = arg('--json', null);
const MODE = arg('--mode', 'both'); // answer | clue | both
const LEGACY = arg('--legacy', null);
const LAYOUT_ARG = arg('--layouts', null);

const binPath = path.join(ROOT, 'public', 'corpus', 'corpus.bin');
const modelPath = path.join(ROOT, 'public', 'corpus', 'clue-model.json');
for (const p of [binPath, modelPath]) {
  if (!fs.existsSync(p)) { console.error(`missing ${p}`); process.exit(1); }
}

const buf = fs.readFileSync(binPath);
const corpus = decodeCorpus(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const index = buildWordIndex(corpus.entries, { presorted: true, fingerprint: 'difficulty' });
const model = loadClueModel(JSON.parse(fs.readFileSync(modelPath, 'utf8')));

const answerQ = corpus.header.difficultyQuantiles || null;
const tq0 = Date.now();
const clueQ = clueDiffQuantiles(corpus.clueStore, corpus.entries);
const tq = Date.now() - tq0;

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const pctOf = (a, p) => (a.length
  ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);
const sd = (a) => { const u = mean(a); return Math.sqrt(mean(a.map((x) => (x - u) ** 2))); };

console.log(`corpus   ${corpus.entries.length.toLocaleString()} answers · max `
  + `${corpus.header.maxCluesPerWord || 0} clues/word · difficultySource ${corpus.header.difficultySource}`);
console.log(`node     ${process.version} · ${os.cpus()[0]?.model?.trim() || 'cpu'}`);
console.log(`runs     ${RUNS} seeds per (layout, band) · timeout ${TIMEOUT}ms`);
console.log(`quantiles  answer q10 ${answerQ[10].toFixed(4)} q50 ${answerQ[50].toFixed(4)} q90 ${answerQ[90].toFixed(4)}`);
console.log(`           clue   q10 ${clueQ[10].toFixed(4)} q50 ${clueQ[50].toFixed(4)} q90 ${clueQ[90].toFixed(4)}`
  + `   (built in ${tq}ms)`);
console.log('');

// Where the shipped ANSWER-quantile target actually lands on the CLUE scale. If these
// two columns matched, the answer-vs-clue distinction would be cosmetic.
console.log('band         nominal  answerQ target   that value is clue pct    clueQ target');
for (const b of DIFFICULTY_BANDS) {
  const band = difficultyTargetOf(b.key);
  const ta = targetForBand(band, answerQ);
  const tc = targetForBand(band, clueQ);
  console.log(`${b.key.padEnd(12)}${band.toFixed(2).padStart(6)}`
    + `${ta.toFixed(4).padStart(16)}${String(percentileIn(ta, clueQ)).padStart(24)}`
    + `${tc.toFixed(4).padStart(15)}`);
}
console.log('');

const LAYOUTS = LAYOUT_ARG
  ? LAYOUT_ARG.split(',').map((s) => s.trim())
  : ['Mini 5x5 - Cross', 'Midi 7x7 - Open', 'Midi 9x9 - Open', 'Classic 15x15', 'Standard 15x15'];
const gridOf = (name) => {
  const l = DEFAULT_LAYOUTS.find((x) => x.name === name);
  if (!l) { console.error(`unknown layout ${name}`); process.exit(1); }
  return l.grid;
};

const legacyAssign = LEGACY
  ? (await import(pathToFileURL(path.resolve(LEGACY)).href)).assignClues : null;
const MODES = MODE === 'both' ? ['answer', 'clue'] : [MODE];
if (legacyAssign) MODES.unshift('before');
const assignFor = (mode) => (mode === 'before' ? legacyAssign : assignClues);

// Packed diff of an assigned clue, by text. The store is ascending by difficulty and
// holds at most 5 clues per word, so a linear scan is free.
function packedDiffOf(word, clueText) {
  if (!clueText) return null;
  for (const c of cluesForWord(corpus.clueStore, word)) {
    if (c.clue === clueText) return c.diff;
  }
  return null;
}

const rows = [];
for (const layoutName of LAYOUTS) {
  const layout = gridOf(layoutName);
  console.log(`--- ${layoutName} `.padEnd(78, '-'));
  console.log('mode    band         cdiff   cpct   c-p10  c-p90   mdlp   adiff  shown  clues    ok');
  for (const b of DIFFICULTY_BANDS) {
    const band = difficultyTargetOf(b.key);
    // One fill per seed, shared by every mode: clue assignment is the only variable, so
    // before/after differ ONLY in the clue target.
    const fills = [];
    for (let s = 0; s < RUNS; s++) {
      const seed = 100003 + s * 7919;
      // NOTE: solveCrossword takes ONE options object with `layout` inside it. Calling it
      // as solveCrossword(layout, opts) returns BAD_LAYOUT every single time, and two
      // identical failures compare equal -- a careless bench then reports a clean pass
      // having solved nothing. Hence the completeness check below.
      const r = solveCrossword({
        index,
        layout,
        seed,
        timeoutMs: TIMEOUT,
        difficultyTarget: targetForBand(band, answerQ),
      });
      if (!r.complete) {
        console.log(`   (seed ${seed} did not fill: ${r.error?.code || 'incomplete'})`);
        continue;
      }
      fills.push({ seed, r });
    }
    if (!fills.length) {
      console.error(`FAIL: ${layoutName} / ${b.key} produced no complete fill in ${RUNS} runs`);
      process.exitCode = 1;
      continue;
    }

    for (const mode of MODES) {
      const target = targetForBand(band, mode === 'clue' ? clueQ : answerQ);
      const assign = assignFor(mode);
      const cdiffs = [];   // packed clue difficulty, per assigned clue
      const mdlPct = [];   // real-scorer percentile, per assigned clue
      const adiffs = [];   // answer difficulty, per placement
      const shown = [];    // the percentile App.jsx would display, per puzzle
      let unclued = 0;
      for (const { seed, r } of fills) {
        const rng = (() => {
          let x = (seed ^ 0x9e3779b9) >>> 0;
          return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
        })();
        const placed = assign(r.placements, {
          store: corpus.clueStore, presetClues: {}, difficultyTarget: target, rng,
        });
        for (const p of placed) {
          adiffs.push(index.byLen[p.word.length].diff[p.wordIndex] / 255);
          if (!p.clue) { unclued++; continue; }
          const d = packedDiffOf(p.word, p.clue);
          if (d != null) cdiffs.push(d);
          mdlPct.push(scorePercentile(model.rawQuantiles,
            scoreClue(model, p.word, p.clue, answerFeaturesFrom(corpus, p.word))));
        }
        shown.push(percentileIn(r.difficultyMean / 100, answerQ));
      }
      const row = {
        layout: layoutName,
        mode,
        band: b.key,
        cdiff: mean(cdiffs),
        cpct: percentileIn(mean(cdiffs), clueQ),
        cp10: pctOf(cdiffs, 0.10),
        cp90: pctOf(cdiffs, 0.90),
        csd: sd(cdiffs),
        mdlp: mean(mdlPct),
        adiff: mean(adiffs),
        shown: mean(shown),
        clues: cdiffs.length,
        unclued,
        ok: fills.length,
        runs: RUNS,
      };
      rows.push(row);
      console.log(
        `${mode.padEnd(8)}${b.key.padEnd(12)}`
        + `${row.cdiff.toFixed(4).padStart(6)}`
        + `${String(row.cpct).padStart(7)}`
        + `${row.cp10.toFixed(3).padStart(8)}`
        + `${row.cp90.toFixed(3).padStart(7)}`
        + `${row.mdlp.toFixed(1).padStart(7)}`
        + `${row.adiff.toFixed(3).padStart(8)}`
        + `${row.shown.toFixed(1).padStart(7)}`
        + `${String(row.clues).padStart(7)}`
        + `${`${row.ok}/${RUNS}`.padStart(6)}`
        + (unclued ? `  ${unclued} UNCLUED` : ''));
    }
  }
  console.log('');
}

// ---- verdict: do the five bands actually separate? --------------------------
console.log('='.repeat(78));
console.log('SEPARATION -- mean clue-difficulty percentile per band, pooled over layouts');
console.log('mode    easy   fair   mod    hard   diff   easy->diff  monotonic');
const verdict = [];
for (const mode of MODES) {
  const per = DIFFICULTY_BANDS.map((b) => {
    const rs = rows.filter((r) => r.mode === mode && r.band === b.key);
    return mean(rs.map((r) => r.cpct));
  });
  const monotonic = per.every((v, i) => i === 0 || v >= per[i - 1] - 0.001);
  const spread = per[4] - per[0];
  verdict.push({ mode, per, monotonic, spread });
  console.log(`${mode.padEnd(8)}${per.map((v) => v.toFixed(1).padStart(6)).join(' ')}`
    + `${spread.toFixed(1).padStart(12)}  ${monotonic ? 'yes' : 'NO'}`);
}
console.log('');
console.log('SEPARATION -- mean cold-scorer percentile per band (independent check)');
console.log('mode    easy   fair   mod    hard   diff   easy->diff  monotonic');
for (const mode of MODES) {
  const per = DIFFICULTY_BANDS.map((b) => {
    const rs = rows.filter((r) => r.mode === mode && r.band === b.key);
    return mean(rs.map((r) => r.mdlp));
  });
  const monotonic = per.every((v, i) => i === 0 || v >= per[i - 1] - 0.001);
  console.log(`${mode.padEnd(8)}${per.map((v) => v.toFixed(1).padStart(6)).join(' ')}`
    + `${(per[4] - per[0]).toFixed(1).padStart(12)}  ${monotonic ? 'yes' : 'NO'}`);
}

// Per-layout reachability: a band nobody can hit should be a measured statement.
console.log('');
console.log('REACHABILITY -- clue-percentile gap between easy and difficult, per layout');
for (const mode of MODES) {
  for (const layoutName of LAYOUTS) {
    const g = (k) => (rows.find(
      (r) => r.mode === mode && r.layout === layoutName && r.band === k) || {}).cpct;
    const e = g('easy'); const d = g('difficult');
    if (e == null || d == null) continue;
    console.log(`${mode.padEnd(8)}${layoutName.padEnd(20)}easy ${String(e).padStart(3)}`
      + `  difficult ${String(d).padStart(3)}  gap ${String(d - e).padStart(4)}`
      + `${d - e < 20 ? '   <-- weak' : ''}`);
  }
}

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify({ runs: RUNS, answerQ, clueQ, rows, verdict }, null, 2));
  console.log(`\nwrote ${JSON_OUT}`);
}
