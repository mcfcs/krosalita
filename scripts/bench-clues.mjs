// Does asking for a difficulty actually deliver it?
//
//   node scripts/bench-clues.mjs                  # corpus only, no Ollama needed
//   node scripts/bench-clues.mjs --generate       # also exercise the model
//   node scripts/bench-clues.mjs --generate --n 20
//
// The baseline to beat was measured before any of this existed: asking qwen3.5:27b for
// EASY clues for ORBIT returned ones at the 11th, 12th, 12th and 38th percentile, and
// asking for DIFFICULT returned 28th-47th. The hint alone misses. This reports how often
// the corpus-first + score-and-filter pipeline lands in the band that was requested, and
// how much of that came free from the corpus.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;

const { decodeCorpus } = await import(url('src/utils/wordIndex.js'));
const { loadClueModel, cluePercentile, answerFeaturesFrom } = await import(url('src/utils/clueScore.js'));
const {
  BANDS, recluePuzzle, answerRange, corpusCandidates, scoreCandidates,
} = await import(url('src/utils/clueSource.js'));

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const N = Number(arg('--n', 60));
const DO_GEN = argv.includes('--generate');
const OLLAMA = process.env.KROSALITA_OLLAMA || 'http://100.102.10.69:11434';
const GEN_MODEL = arg('--model', 'qwen3.5:27b');

const buf = fs.readFileSync(path.join(ROOT, 'public', 'corpus', 'corpus.bin'));
const corpus = decodeCorpus(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const model = loadClueModel(JSON.parse(
  fs.readFileSync(path.join(ROOT, 'public', 'corpus', 'clue-model.json'), 'utf8')));

let failures = 0;
const fail = (m) => { failures++; console.log(`   FAIL  ${m}`); };

// A spread of answers: common, mid, obscure — not just the easy end of the corpus.
const pool = corpus.entries.filter((e) => e.word.length >= 4 && e.word.length <= 8);
const step = Math.max(1, Math.floor(pool.length / N));
const words = [];
for (let i = 0; i < pool.length && words.length < N; i += step) words.push(pool[i].word);

console.log(`corpus ${corpus.entries.length.toLocaleString()} answers · sampling ${words.length}\n`);

// ---------------------------------------------------------------- reachability
console.log('=== what the corpus alone can do ===');
console.log('band      in-band from corpus     unreachable    median span');
for (const band of ['easy', 'medium', 'hard']) {
  let hit = 0;
  let unreachable = 0;
  const spans = [];
  for (const w of words) {
    const range = answerRange(corpus, model, w);
    const win = BANDS[band];
    if (range) spans.push(range.max - range.min);
    const reachable = !range || (range.min < win.max && range.max >= win.min);
    if (!reachable) unreachable++;
    if (corpusCandidates(corpus, model, w, { band }).some((c) => c.inBand)) hit++;
  }
  spans.sort((a, b) => a - b);
  console.log(`${band.padEnd(10)}${String(`${hit}/${words.length}`).padStart(10)}`
    + `${String(`${Math.round((100 * hit) / words.length)}%`).padStart(10)}`
    + `${String(`${unreachable}`).padStart(15)}`
    + `${String(spans[Math.floor(spans.length / 2)] ?? 0).padStart(15)}`);
}

// ---------------------------------------------------------------- full pipeline
if (DO_GEN) {
  let up = false;
  try {
    const c = new AbortController();
    const to = setTimeout(() => c.abort(), 4000);
    up = (await fetch(`${OLLAMA}/api/tags`, { signal: c.signal })).ok;
    clearTimeout(to);
  } catch { up = false; }
  if (!up) {
    console.log(`\nskip: generation (${OLLAMA} unreachable)`);
  } else {
    const { makeGenerator } = await import(url('src/utils/clueSource.js'));
    const generate = makeGenerator({ baseUrl: OLLAMA, model: GEN_MODEL, perWord: 4 });

    console.log(`\n=== full pipeline, ${GEN_MODEL} ===`);
    for (const band of ['easy', 'medium', 'hard']) {
      const entries = words.slice(0, Math.min(30, words.length))
        .map((word, i) => ({ word, number: i + 1, direction: 'across', clue: '' }));
      const t = Date.now();
      const { results, summary } = await recluePuzzle(corpus, model, entries, { band, generate });
      const secs = ((Date.now() - t) / 1000).toFixed(0);

      const landed = results.filter((r) => r.chosen?.inBand || r.status === 'already').length;
      console.log(`\n  ${band}: ${landed}/${summary.total} landed in band in ${secs}s`);
      console.log(`     from corpus ${summary.corpus} · generated ${summary.generated} · `
        + `already ${summary.already} · missed ${summary.missed} · `
        + `unreachable ${summary.unreachable} · failed ${summary.failed}`);

      // Compare against the raw hint: how would the generated clues have scored if we
      // had simply trusted the model's difficulty hint and taken its first answer?
      const gen = results.filter((r) => r.status === 'generated' || r.status === 'missed');
      if (gen.length) {
        const chosenOk = gen.filter((r) => r.chosen?.inBand).length;
        console.log(`     of ${gen.length} generated answers, scoring-and-filtering placed `
          + `${chosenOk} in band (${Math.round((100 * chosenOk) / gen.length)}%)`);
      }
      for (const r of results.filter((x) => x.chosen).slice(0, 4)) {
        console.log(`       p${String(Math.round(r.chosen.percentile)).padStart(3)} `
          + `${r.status.padEnd(10)}${r.word.padEnd(10)}${r.chosen.clue.slice(0, 48)}`);
      }
      if (summary.failed > 0) fail(`${band}: ${summary.failed} answers got no clue at all`);
    }
  }
}

// ---------------------------------------------------------------- invariants
console.log('\n=== invariants ===');
{
  // Every candidate the pipeline offers must be usable as a clue for its answer.
  const { clueRejectReason, clueRevealsAnswer } = await import(url('src/utils/clueFilters.js'));
  let bad = 0;
  for (const w of words.slice(0, 40)) {
    for (const c of corpusCandidates(corpus, model, w, { band: 'medium' })) {
      if (clueRejectReason(c.clue) || clueRevealsAnswer(c.clue, w)) bad++;
    }
  }
  if (bad) fail(`${bad} corpus candidates would not be usable as clues`); else console.log('   PASS  every corpus candidate passes the clue filters');

  // Generated text containing the answer must be dropped, not merely ranked low.
  const scored = scoreCandidates(corpus, model, 'ORBIT',
    ['Path of a planet', 'An ORBIT, essentially', 'See 14-Across', ''], { band: 'easy' });
  if (scored.length !== 1) fail(`expected 1 usable candidate, got ${scored.length}: ${JSON.stringify(scored.map((s) => s.clue))}`);
  else console.log('   PASS  answer-revealing, cross-reference and empty candidates are dropped');

  // Ranking must be monotone: a plainly easy clue below a plainly hard one.
  const af = answerFeaturesFrom(corpus, 'ORBIT');
  const easy = cluePercentile(model, 'ORBIT', 'Path of a planet', af);
  const hard = cluePercentile(model, 'ORBIT', 'Revolve: a ring of gold?', af);
  if (!(easy < hard)) fail(`ranking inverted: "Path of a planet" p${easy} vs wordplay p${hard}`);
  else console.log(`   PASS  ranking is sane (p${Math.round(easy)} plain < p${Math.round(hard)} wordplay)`);
}

console.log('');
if (failures) { console.log(`FAILED — ${failures} problem${failures === 1 ? '' : 's'}`); process.exit(1); }
console.log('PASSED');
