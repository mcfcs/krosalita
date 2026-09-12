// Proves the browser clue scorer agrees with the Python model that trained it.
//
//   node scripts/test-clue-score.mjs
//
// The failure this exists to prevent is silent: if src/utils/clueScore.js and
// pipeline/stages/s2_features.py stop computing identical features, the model is fed
// numbers it was never trained on and every score is quietly wrong, with nothing throwing.
// So this recomputes the features for real (answer, clue) pairs in JS and asserts they
// equal the Python ones, then asserts the JS tree walker reproduces Python's predictions.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;

const {
  loadClueModel, extractFeatures, scoreFeatures, scoreClue, scorePercentile,
  explainClue, FEATURE_ORDER,
} = await import(url('src/utils/clueScore.js'));

const modelPath = path.join(ROOT, 'public', 'corpus', 'clue-model.json');
const parityPath = path.join(ROOT, 'pipeline', 'out', 'feature-parity.json');
for (const p of [modelPath, parityPath]) {
  if (!fs.existsSync(p)) {
    console.error(`missing ${p}\nrun: python pipeline/stages/s8_coldstart.py`);
    process.exit(1);
  }
}

const raw = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
const fixture = JSON.parse(fs.readFileSync(parityPath, 'utf8'));

let failures = 0;
const fail = (msg) => { failures++; console.log(`  FAIL  ${msg}`); };
const ok = (msg) => console.log(`  PASS  ${msg}`);

// ---------------------------------------------------------------- model loads
let model;
try {
  model = loadClueModel(raw);
  ok(`model loaded — ${model.roots.length} trees, ${model.featureIdx.length} nodes, `
     + `${(fs.statSync(modelPath).size / 1024).toFixed(0)} KB`);
} catch (e) {
  fail(`model did not load: ${e.message}`);
  process.exit(1);
}

if (fixture.features.join(',') !== FEATURE_ORDER.join(',')) {
  fail('fixture feature order differs from clueScore.js');
} else {
  ok(`feature order agrees (${FEATURE_ORDER.length} features)`);
}

// ---------------------------------------------------------------- feature parity
// The fixture carries the Python-computed vectors. The answer-dependent features come
// from the corpus in the app, so take them from the fixture here and re-derive the rest.
const ANSWER_IDX = Object.fromEntries(
  ['CorpusFreqLog', 'ZipfEn', 'Crosswordese', 'DistinctCluesForWord']
    .map((n) => [n, FEATURE_ORDER.indexOf(n)]),
);
const TOL = 1e-6;
let worst = 0;
let worstAt = '';
let mismatches = 0;

for (const row of fixture.rows) {
  const py = row.values.map((v) => (v === null ? NaN : v));
  const js = extractFeatures(row.word, row.clue, {
    corpusFreqLog: py[ANSWER_IDX.CorpusFreqLog],
    zipf: py[ANSWER_IDX.ZipfEn],
    crosswordese: py[ANSWER_IDX.Crosswordese],
    distinctClues: py[ANSWER_IDX.DistinctCluesForWord],
  });
  for (let i = 0; i < FEATURE_ORDER.length; i++) {
    const a = py[i];
    const b = js[i];
    if (Number.isNaN(a) && Number.isNaN(b)) continue;
    const d = Math.abs(a - b);
    if (!(d <= TOL)) {
      mismatches++;
      if (d > worst || Number.isNaN(d)) {
        worst = d;
        worstAt = `${FEATURE_ORDER[i]} — py=${a} js=${b}  "${row.clue}" (${row.word})`;
      }
    }
  }
}
if (mismatches) fail(`${mismatches} feature mismatches over ${fixture.rows.length} rows; worst: ${worstAt}`);
else ok(`feature parity on ${fixture.rows.length} rows (max delta < ${TOL})`);

// ---------------------------------------------------------------- prediction parity
let maxErr = 0;
for (const row of fixture.rows) {
  const py = row.values.map((v) => (v === null ? NaN : v));
  maxErr = Math.max(maxErr, Math.abs(scoreFeatures(model, py) - row.score));
}
if (maxErr > 1e-5) fail(`JS tree walker differs from Python by up to ${maxErr.toFixed(7)}`);
else ok(`prediction parity — max |JS − Python| = ${maxErr.toExponential(1)}`);

// ---------------------------------------------------------------- behaviour
// Ordering is what the feature is actually used for, so check it directly rather than
// trusting a correlation number computed elsewhere.
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'corpus', 'manifest.json'), 'utf8'));
const q = manifest.difficultyQuantiles;
const corpusBuf = fs.readFileSync(path.join(ROOT, 'public', 'corpus', 'corpus.bin'));
const { decodeCorpus } = await import(url('src/utils/wordIndex.js'));
const corpus = decodeCorpus(corpusBuf.buffer.slice(corpusBuf.byteOffset,
  corpusBuf.byteOffset + corpusBuf.byteLength));
const { answerFeaturesFrom } = await import(url('src/utils/clueScore.js'));

const CASES = [
  ['OREO', 'Sandwich cookie', 'easy'],
  ['IDEA', 'Brainstorm result', 'easy'],
  ['ORBIT', 'Path of a planet', 'easy'],
  ['ESNE', 'Anglo-Saxon serf', 'hard'],
  ['ETUI', 'Needle case', 'hard'],
  ['ANOA', 'Wild ox of Celebes', 'hard'],
];
console.log('');
let bandErrors = 0;
for (const [word, clue, want] of CASES) {
  const p = scorePercentile(q, scoreClue(model, word, clue, answerFeaturesFrom(corpus, word)));
  const got = p < 40 ? 'easy' : p >= 60 ? 'hard' : 'middling';
  const mark = got === want ? '   ' : ' ! ';
  console.log(`  ${mark}p${String(Math.round(p)).padStart(3)}  ${word.padEnd(6)}${clue}`);
  if (got !== want) bandErrors++;
}
if (bandErrors) fail(`${bandErrors}/${CASES.length} known pairs landed in the wrong half`);
else ok(`${CASES.length} known easy/hard pairs ranked correctly`);

// Unknown answers must degrade, not break.
const unknown = scoreClue(model, 'ZYXWQP', 'A word nobody has ever used', {});
if (!Number.isFinite(unknown)) fail(`unknown answer produced ${unknown}`);
else ok(`unknown answer scores ${(unknown * 100).toFixed(0)} rather than NaN`);

// An empty clue must not throw or produce NaN.
const empty = scoreClue(model, 'OREO', '', answerFeaturesFrom(corpus, 'OREO'));
if (!Number.isFinite(empty)) fail(`empty clue produced ${empty}`);
else ok('empty clue handled');

const ex = explainClue(model, 'ESNE', 'Anglo-Saxon serf', answerFeaturesFrom(corpus, 'ESNE'));
if (!ex.drivers.length) fail('explainClue returned no drivers');
else ok(`explainClue: ${ex.drivers.map((d) => d.feature).join(', ')}`);

// Speed is the whole point of shipping a model rather than calling the LLM.
const t0 = Date.now();
const N = 20000;
for (let i = 0; i < N; i++) scoreClue(model, 'ORBIT', 'Path of a planet', {});
const perMs = N / Math.max(1, Date.now() - t0);
ok(`${Math.round(perMs)} scores/ms — live scoring while typing is free`);

console.log('');
if (failures) { console.log(`FAILED — ${failures} problem${failures === 1 ? '' : 's'}`); process.exit(1); }
console.log('PASSED — JS scorer matches the Python model');
