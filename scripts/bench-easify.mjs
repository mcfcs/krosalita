// "I generated an EASY puzzle, but some answers only have HARD clues. Can the LLM write
//  an easier one — or is that too hard?"
//
//   node scripts/bench-easify.mjs                       # corpus only, no Ollama needed
//   node scripts/bench-easify.mjs --generate            # + the model
//   node scripts/bench-easify.mjs --generate --n 48 --band easy --per-word 8
//   KROSALITA_OLLAMA=http://host:11434 node scripts/bench-easify.mjs --generate
//
// Unlike bench-clues.mjs, which samples the corpus evenly, this reproduces the user's
// actual situation: solve real grids at the Easy setting through the same path the worker
// uses (solveCrossword -> assignClues), then take exactly the entries whose ASSIGNED clue
// landed out of band. Those are the answers the user is complaining about. For each, try
//
//   1. the corpus  — is there already an easier published clue selection didn't pick?
//   2. the model   — over-generate, score every candidate locally, keep what lands.
//
// and report what fraction each fixes, what stays unreachable and why, how long it takes,
// and how many generated clues are factually suspect.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;

const { decodeCorpus, buildWordIndex } = await import(url('src/utils/wordIndex.js'));
const { solveCrossword } = await import(url('src/utils/solver.js'));
const { assignClues } = await import(url('src/utils/clueIndex.js'));
const { DEFAULT_LAYOUTS } = await import(url('src/data/layouts.js'));
const { difficultyTargetOf } = await import(url('src/utils/difficulty.js'));
const { loadClueModel, cluePercentile, answerFeaturesFrom } = await import(url('src/utils/clueScore.js'));
const {
  BANDS, corpusCandidates, scoreCandidates, flagImplausible, makeGenerator, answerRange,
} = await import(url('src/utils/clueSource.js'));

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const N = Number(arg('--n', 48));
const BAND = arg('--band', 'easy');
const PER_WORD = Number(arg('--per-word', 8));
const DO_GEN = argv.includes('--generate');
const OLLAMA = arg('--ollama', process.env.KROSALITA_OLLAMA || 'http://localhost:11434');
const EMBED = arg('--embed', process.env.KROSALITA_EMBED || 'http://localhost:11434');
const GEN_MODEL = arg('--model', 'qwen3.5:27b');
const WIN = BANDS[BAND] || BANDS.easy;

const buf = fs.readFileSync(path.join(ROOT, 'public', 'corpus', 'corpus.bin'));
const corpus = decodeCorpus(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const model = loadClueModel(JSON.parse(
  fs.readFileSync(path.join(ROOT, 'public', 'corpus', 'clue-model.json'), 'utf8')));
const index = buildWordIndex(corpus.entries, { presorted: true, fingerprint: 'easify' });
const quantiles = corpus.header.difficultyQuantiles || null;

// The worker converts the nominal band into this corpus's difficulty scale before both
// solving and clue selection; do the same or the puzzles here are not the user's puzzles.
const targetFor = (band) => {
  if (band == null) return null;
  if (!quantiles?.length) return band;
  return quantiles[Math.max(0, Math.min(100, Math.round(band * 100)))];
};
const nominal = difficultyTargetOf(BAND === 'easy' ? 'easy' : BAND === 'hard' ? 'hard' : 'moderate');
const dTarget = targetFor(nominal);

const pct1 = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : '—');
const p = (x) => `p${String(Math.round(x)).padStart(3)}`;

console.log(`corpus ${corpus.entries.length.toLocaleString()} answers · band ${WIN.label} `
  + `(${WIN.min}–${WIN.max}) · solver target ${nominal} -> ${dTarget?.toFixed(3)}`);

// ---------------------------------------------------------------- the real scenario
// Solve Easy puzzles until N distinct out-of-band answers have accumulated.
const LAYOUTS = ['Classic 15x15', 'Standard 15x15', 'Open 15x15', 'Diamond 15x15']
  .map((n) => DEFAULT_LAYOUTS.find((l) => l.name === n)).filter(Boolean);

const cases = new Map(); // word -> { word, clue, percentile, puzzle, used }
const puzzleStats = [];
let seed = 424243;
for (let pz = 0; cases.size < N && pz < 24; pz++) {
  const layout = LAYOUTS[pz % LAYOUTS.length].grid;
  seed += 7919;
  const r = solveCrossword({ index, layout, seed, timeoutMs: 15000, difficultyTarget: dTarget });
  if (!r.complete) continue;
  const rng = (() => { let s = (seed ^ 0x9e3779b9) >>> 0;
    return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })();
  const placed = assignClues(r.placements, {
    store: corpus.clueStore, difficultyTarget: dTarget, rng,
  });
  const usedHere = new Set(placed.map((x) => (x.clue || '').toLowerCase()).filter(Boolean));
  let out = 0;
  // Cap per puzzle so the sample spans several grids: one 15x15 alone offers enough
  // out-of-band entries to fill N, and its particular glue would then be the whole result.
  let taken = 0;
  const capPerPuzzle = Math.ceil(N / 6);
  for (const pl of placed) {
    if (!pl.clue) continue;
    const percentile = cluePercentile(model, pl.word, pl.clue, answerFeaturesFrom(corpus, pl.word));
    if (percentile >= WIN.max || percentile < WIN.min) {
      out++;
      if (!cases.has(pl.word) && cases.size < N && taken < capPerPuzzle) {
        taken++;
        cases.set(pl.word, { word: pl.word, clue: pl.clue, percentile, puzzle: pz, used: usedHere });
      }
    }
  }
  puzzleStats.push({ n: placed.filter((x) => x.clue).length, out });
}

const list = [...cases.values()];
const meanOut = puzzleStats.reduce((a, s) => a + s.out, 0) / (puzzleStats.length || 1);
const meanN = puzzleStats.reduce((a, s) => a + s.n, 0) / (puzzleStats.length || 1);
console.log(`\n=== the scenario ===\n${puzzleStats.length} ${WIN.label} puzzles solved · `
  + `${meanN.toFixed(0)} clued entries each · ${meanOut.toFixed(1)} land OUT of band `
  + `(${pct1(meanOut, meanN)}) — that is the job\n`);
if (!list.length) { console.log('nothing out of band; nothing to measure'); process.exit(0); }

// ---------------------------------------------------------------- 1. corpus alone
const fixedByCorpus = [];
const stillBad = [];
for (const c of list) {
  const pick = corpusCandidates(corpus, model, c.word, { band: BAND, exclude: c.used })
    .find((x) => x.inBand);
  c.range = answerRange(corpus, model, c.word);
  c.af = answerFeaturesFrom(corpus, c.word);
  if (pick) { c.corpusPick = pick; fixedByCorpus.push(c); } else stillBad.push(c);
}
console.log(`=== 1. corpus alone (free, instant, human-written) ===`);
console.log(`fixed ${fixedByCorpus.length}/${list.length} (${pct1(fixedByCorpus.length, list.length)}) `
  + `— an in-band published clue existed that selection simply did not pick`);
for (const c of fixedByCorpus.slice(0, 6)) {
  console.log(`   ${c.word.padEnd(10)}${p(c.percentile)} "${c.clue}"`);
  console.log(`   ${''.padEnd(10)}${p(c.corpusPick.percentile)} "${c.corpusPick.clue}"  <- corpus`);
}

// ---------------------------------------------------------------- 2. the model
let genFixed = [];
let genMissed = [];
let genSecs = 0;
let allGenerated = [];
if (DO_GEN && stillBad.length) {
  let up = false;
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 4000);
    up = (await fetch(`${OLLAMA}/api/tags`, { signal: ctl.signal })).ok;
    clearTimeout(to);
  } catch { up = false; }
  if (!up) console.log(`\nskip: generation (${OLLAMA} unreachable)`);
  else {
    const generate = makeGenerator({ baseUrl: OLLAMA, model: GEN_MODEL, perWord: PER_WORD });
    const { cluesForWord } = await import(url('src/utils/clueIndex.js'));
    const entries = stillBad.map((c) => ({
      word: c.word, clue: c.clue,
      known: cluesForWord(corpus.clueStore, c.word).map((k) => k.clue),
    }));
    console.log(`\n=== 2. the model (${GEN_MODEL}, ${PER_WORD} candidates per answer, scored locally) ===`);
    const t0 = Date.now();
    const fresh = await generate(entries, BAND, (pr) => process.stdout.write(`\r   ${pr.done}/${pr.total}   `));
    genSecs = (Date.now() - t0) / 1000;
    process.stdout.write('\r');

    for (const c of stillBad) {
      const got = fresh.get(c.word) || { clues: [], reading: '' };
      c.reading = got.reading;
      c.raw = got.clues;
      const scored = scoreCandidates(corpus, model, c.word, got.clues, { band: BAND, exclude: c.used });
      c.scored = scored;
      c.best = scored.find((x) => x.inBand) || scored[0] || null;
      allGenerated.push(...scored.map((s) => ({ ...s, word: c.word })));
      if (c.best?.inBand) genFixed.push(c); else genMissed.push(c);
    }
    console.log(`fixed ${genFixed.length}/${stillBad.length} (${pct1(genFixed.length, stillBad.length)}) `
      + `of what the corpus could not · ${genSecs.toFixed(0)}s total, `
      + `${(genSecs / stillBad.length).toFixed(1)}s per answer`);
    console.log(`yield: ${allGenerated.length} usable candidates from `
      + `${stillBad.length * PER_WORD} requested `
      + `(${pct1(allGenerated.length, stillBad.length * PER_WORD)} survive the filters + dedupe)`);
    console.log(`per puzzle: ~${meanOut.toFixed(1)} out-of-band entries, of which `
      + `~${(meanOut * (stillBad.length / list.length)).toFixed(1)} reach the model `
      + `-> ~${(genSecs / stillBad.length * meanOut * (stillBad.length / list.length)).toFixed(0)}s`);
  }
}

// ---------------------------------------------------------------- what is left
const unreachable = DO_GEN ? genMissed : stillBad;
console.log(`\n=== 3. what stays out of reach ===`);
console.log(`${unreachable.length}/${list.length} (${pct1(unreachable.length, list.length)}) still out of band`);
if (unreachable.length) {
  console.log(`\n   answer     zipf  cwese  published  best try  short by   best attempt`);
  for (const c of unreachable.slice(0, 14)) {
    const range = c.range ? `${Math.round(c.range.min)}-${Math.round(c.range.max)}` : 'none';
    const best = c.best ? Math.round(c.best.percentile) : Math.round(c.percentile);
    const gap = Math.max(0, best - WIN.max + 1);
    console.log(`   ${c.word.padEnd(11)}${(c.af.zipf ?? 0).toFixed(2).padStart(5)}`
      + `${(c.af.crosswordese ?? 0).toFixed(2).padStart(7)}${range.padStart(11)}`
      + `${String(`p${best}`).padStart(10)}${String(gap).padStart(10)}   `
      + `${(c.best?.clue || c.clue).slice(0, 34)}`);
  }
  const gaps = unreachable.map((c) => Math.max(0,
    (c.best ? c.best.percentile : c.percentile) - WIN.max + 1)).sort((a, b) => a - b);
  const zipfs = unreachable.map((c) => c.af.zipf).filter((z) => z != null).sort((a, b) => a - b);
  const allZipf = list.map((c) => c.af.zipf).filter((z) => z != null).sort((a, b) => a - b);
  console.log(`\n   median short-by ${Math.round(gaps[gaps.length >> 1] ?? 0)} percentile points · `
    + `within 10 points: ${gaps.filter((g) => g <= 10).length}/${gaps.length}`);
  console.log(`   median zipf of the stuck ${(zipfs[zipfs.length >> 1] ?? 0).toFixed(2)} `
    + `vs ${(allZipf[allZipf.length >> 1] ?? 0).toFixed(2)} across all out-of-band answers `
    + `(lower = rarer word)`);

  // Was the band ever reachable? A published range that already sits entirely above the
  // band says the corpus never managed it either, in decades of print.
  const never = unreachable.filter((c) => c.range && c.range.min >= WIN.max).length;
  const noData = unreachable.filter((c) => !c.range).length;
  console.log(`   ${never}/${unreachable.length} have NO published clue in this band either, `
    + `across every printing in the corpus — the band was never reachable for them`
    + `${noData ? ` (${noData} more have no published clue at all)` : ''}`);
}

// ------------------------------------------------- is it the clue, or is it the answer?
// The decisive measurement. If eight different clues for one answer all score within a
// few points of each other, the clue text is not what is being measured — the answer is,
// and no amount of rewriting moves it.
if (DO_GEN) {
  const spreads = [];
  const floors = [];
  for (const c of stillBad) {
    if (!c.scored || c.scored.length < 4) continue;
    const ps = c.scored.map((s) => s.percentile);
    spreads.push(Math.max(...ps) - Math.min(...ps));
    floors.push(Math.min(...ps));
  }
  if (spreads.length) {
    spreads.sort((a, b) => a - b);
    floors.sort((a, b) => a - b);
    const med = (a) => a[a.length >> 1];
    console.log(`\n=== is it the clue, or is it the answer? ===`);
    console.log(`   over ${spreads.length} answers with >= 4 scored candidates each:`);
    console.log(`     median spread across one answer's candidates   ${Math.round(med(spreads))} points`);
    console.log(`     median floor (easiest of the 8)                p${Math.round(med(floors))}`);
    console.log(`     answers whose floor already clears p${WIN.max}           `
      + `${floors.filter((f) => f < WIN.max).length}/${floors.length}`);
    console.log(`   The band is ${WIN.max} points wide. When an answer's whole candidate cloud sits`);
    console.log(`   ${Math.round(med(floors))}+ and only moves ${Math.round(med(spreads))} points however it is worded, rewriting the clue`);
    console.log(`   cannot get there. That is a property of the ANSWER, not of the model.`);
  }
}

// ---------------------------------------------------------------- quality control
if (DO_GEN && allGenerated.length) {
  console.log(`\n=== 4. are the generated clues any good? ===`);
  const byWord = new Map();
  for (const g of allGenerated) {
    if (!byWord.has(g.word)) byWord.set(g.word, []);
    byWord.get(g.word).push(g);
  }
  let checked = 0;
  let suspect = 0;
  const flagged = [];
  const clean = [];
  for (const [word, cands] of byWord) {
    const res = await flagImplausible(corpus, word, cands, { baseUrl: EMBED });
    if (res[0]?.similarity === undefined) continue; // too few published clues to judge
    checked += res.length;
    for (const r of res) {
      if (r.suspect) { suspect++; flagged.push({ ...r, word }); } else clean.push({ ...r, word });
    }
  }
  if (!checked) console.log('   no embedding check ran (server unreachable, or too few published clues)');
  else {
    console.log(`   ${suspect}/${checked} (${pct1(suspect, checked)}) flagged as likely WRONG `
      + `by the embedding check — and it only covers answers with >= 3 published clues`);
    flagged.sort((a, b) => a.similarity - b.similarity);
    clean.sort((a, b) => b.similarity - a.similarity);
    console.log(`\n   worst (low similarity to how this answer is really clued):`);
    for (const f of flagged.slice(0, 8)) {
      console.log(`     ${f.similarity.toFixed(2)} ${p(f.percentile)} ${f.word.padEnd(10)}"${f.clue}"`);
    }
    console.log(`\n   best:`);
    for (const f of clean.slice(0, 8)) {
      console.log(`     ${f.similarity.toFixed(2)} ${p(f.percentile)} ${f.word.padEnd(10)}"${f.clue}"`);
    }
  }

  // Answer leaks the filters do NOT catch. clueRevealsAnswer requires non-letter
  // boundaries, so "Attaboy start" for ATTA, "Treos" for TREO and "S.R.O.s" for SROS all
  // pass it — the model reaches for the answer itself far more often than a human editor.
  const flat = (s) => s.toUpperCase().replace(/[^A-Z]/g, '');
  const leaks = allGenerated.filter((g) => g.word.length >= 4 && flat(g.clue).includes(g.word));
  console.log(`\n   answer leaks that got through the filters: ${leaks.length}/${allGenerated.length}`
    + ` (${pct1(leaks.length, allGenerated.length)})`);
  for (const l of leaks.slice(0, 8)) console.log(`     ${l.word.padEnd(10)}"${l.clue}"`);

  // Everything the model wrote for a handful of answers, unfiltered, so the raw quality
  // is visible rather than only the winners.
  console.log(`\n   raw output, three answers, every candidate:`);
  for (const c of [...genFixed.slice(0, 2), ...genMissed.slice(0, 1)]) {
    console.log(`\n     ${c.word}  (was ${p(c.percentile)} "${c.clue}")`
      + `${c.reading ? `  model read it as: ${c.reading}` : ''}`);
    for (const s of (c.scored || [])) {
      console.log(`       ${p(s.percentile)} ${s.inBand ? 'IN ' : '   '} "${s.clue}"`);
    }
    const dropped = (c.raw || []).filter((r) => !(c.scored || []).some((s) => s.clue === r));
    for (const d of dropped) console.log(`       ---  DROP "${d}"`);
  }
}

// ---------------------------------------------------------------- invariants
// The guarantees recluePuzzle has to hold whatever the model does.
{
  const { recluePuzzle } = await import(url('src/utils/clueSource.js'));
  let bad = 0;
  const fail = (m) => { bad++; console.log(`   FAIL  ${m}`); };
  const entries = list.map((c, i) => ({
    key: `k${i}`, word: c.word, clue: c.clue, number: i + 1, direction: 'across',
  }));

  console.log(`\n=== invariants ===`);

  // 1. Corpus-only must work and must never leave an entry in limbo.
  const offline = await recluePuzzle(corpus, model, entries, { band: BAND, generate: null });
  const limbo = offline.results.filter((r) => r.status === 'pending' || !r.why);
  if (limbo.length) fail(`${limbo.length} entries left with no verdict when AI is off`);
  else console.log(`   PASS  AI off: every entry gets a verdict and a reason`);

  // 2. Never propose something further from the band than the clue already there.
  const miss = (x) => (x == null ? Infinity
    : x >= WIN.min && x < WIN.max ? 0 : x < WIN.min ? WIN.min - x : x - (WIN.max - 1));
  const worse = offline.results.filter((r) => r.chosen
    && miss(r.chosen.percentile) >= miss(r.current?.percentile));
  if (worse.length) {
    fail(`${worse.length} proposals are no better than the current clue, e.g. `
      + `${worse[0].word} p${Math.round(worse[0].current.percentile)} -> p${Math.round(worse[0].chosen.percentile)}`);
  } else console.log(`   PASS  no proposal is further from the band than the clue it replaces`);

  // 3. Nothing proposed may reveal its own answer or reference another entry.
  const { clueRejectReason, clueRevealsAnswer } = await import(url('src/utils/clueFilters.js'));
  const leaky = offline.results.filter((r) => r.chosen
    && (clueRejectReason(r.chosen.clue) || clueRevealsAnswer(r.chosen.clue, r.word)));
  if (leaky.length) fail(`${leaky.length} proposals are unusable as clues`);
  else console.log(`   PASS  every proposal passes the clue filters`);

  // 4. No two entries may be proposed the same clue text.
  const texts = offline.results.filter((r) => r.chosen).map((r) => r.chosen.clue.toLowerCase());
  if (new Set(texts).size !== texts.length) fail('a clue was proposed for two different entries');
  else console.log(`   PASS  proposals are distinct from each other`);

  // 5. The LLM branch, driven by a stub so it is deterministic and needs no server.
  // A model that writes something WORSE than the clue already on the puzzle must be
  // refused, not proposed — this is the regression that matters most.
  const stub = (fed) => async (es) => new Map(es.map((e) => [e.word, { clues: fed, reading: '' }]));
  const one = [{ key: 'k', word: 'SLED', clue: 'Snow rider', number: 1, direction: 'across' }];
  const worseRun = await recluePuzzle(corpus, model, one,
    { band: 'easy', generate: stub(['A vehicle used for riding down snowy hills']) });
  const wr = worseRun.results[0];
  // "Snow rider" is already easy, so this entry should not be touched at all.
  if (wr.chosen) fail(`an already-in-band entry was given a replacement: "${wr.chosen.clue}"`);
  else console.log(`   PASS  an entry already in band is left alone (${wr.status})`);

  const hard = [{ key: 'k', word: 'SLED', clue: 'Iditarod vehicle', number: 1, direction: 'across' }];
  const refused = await recluePuzzle(corpus, model, hard,
    { band: 'easy', generate: stub(['A vehicle used for riding down snowy hills', 'Winter transport pulled by dogs across the snow']) });
  const rf = refused.results[0];
  if (rf.chosen && miss(rf.chosen.percentile) >= miss(rf.current.percentile)) {
    fail(`a worse generated clue was proposed: p${Math.round(rf.current.percentile)} -> p${Math.round(rf.chosen.percentile)}`);
  } else if (rf.chosen?.source === 'generated' && !rf.chosen.inBand) {
    fail(`an out-of-band generated clue was proposed over a better published one`);
  } else {
    console.log(`   PASS  a worse generated clue is refused (${rf.status}: ${rf.why})`);
  }

  const better = await recluePuzzle(corpus, model, hard,
    { band: 'easy', generate: stub(['Snow rider']) });
  const bt = better.results[0];
  if (bt.status !== 'generated' || bt.chosen?.clue !== 'Snow rider') {
    fail(`a genuinely easier generated clue was not taken (${bt.status}, ${bt.chosen?.clue})`);
  } else console.log(`   PASS  a genuinely easier generated clue is taken (p${Math.round(bt.chosen.percentile)})`);

  console.log(`   corpus-only summary: ${JSON.stringify(offline.summary)}`);
  if (bad) process.exitCode = 1;
}

// ---------------------------------------------------------------- the answer
const corpusPctOfAll = fixedByCorpus.length / list.length;
const llmPctOfAll = DO_GEN ? genFixed.length / list.length : 0;
console.log(`\n=== verdict over ${list.length} answers whose Easy-puzzle clue was out of band ===`);
console.log(`   corpus alone      ${String(fixedByCorpus.length).padStart(3)}  ${pct1(fixedByCorpus.length, list.length).padStart(4)}  free, instant, human-written`);
if (DO_GEN) {
  console.log(`   + the model       ${String(genFixed.length).padStart(3)}  ${pct1(genFixed.length, list.length).padStart(4)}  ${(genSecs / Math.max(1, stillBad.length)).toFixed(1)}s/answer, needs QC`);
}
console.log(`   still stuck       ${String(unreachable.length).padStart(3)}  ${pct1(unreachable.length, list.length).padStart(4)}`);
console.log(`   total fixed       ${String(Math.round((corpusPctOfAll + llmPctOfAll) * list.length)).padStart(3)}  ${pct1(fixedByCorpus.length + (DO_GEN ? genFixed.length : 0), list.length).padStart(4)}\n`);
