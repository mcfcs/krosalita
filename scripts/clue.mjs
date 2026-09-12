// Write and score clues for one answer, from the command line.
//
//   node scripts/clue.mjs GHAST
//   node scripts/clue.mjs GHAST --band hard --count 8
//   node scripts/clue.mjs ORBIT --band easy --no-generate     # published clues only
//   node scripts/clue.mjs GHAST --sense "the Minecraft mob"   # disambiguate the answer
//
// The same pipeline the Clue Studio uses, without the browser: published clues first,
// then generation to fill the gap, everything scored by the local model. Handy for trying
// a word that isn't in a grid yet.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const url = (p) => pathToFileURL(path.join(ROOT, p)).href;

const { decodeCorpus } = await import(url('src/utils/wordIndex.js'));
const { loadClueModel, answerFeaturesFrom } = await import(url('src/utils/clueScore.js'));
const {
  BANDS, corpusCandidates, scoreCandidates, flagImplausible, makeGenerator, answerRange,
} = await import(url('src/utils/clueSource.js'));

const argv = process.argv.slice(2);
const flag = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const word = (argv.find((a) => !a.startsWith('--') && !/^\d+$/.test(a)) || '').toUpperCase().replace(/[^A-Z]/g, '');
const band = flag('--band', 'medium');
const count = Number(flag('--count', 6));
const sense = flag('--sense', '');
const doGen = !argv.includes('--no-generate');
const OLLAMA = process.env.KROSALITA_OLLAMA || 'http://100.102.10.69:11434';
const GEN_MODEL = flag('--model', 'qwen3.5:27b');

if (!word) {
  console.error('usage: node scripts/clue.mjs WORD [--band easy|medium|hard] [--count N] [--no-generate]');
  process.exit(2);
}
if (!BANDS[band]) {
  console.error(`unknown band "${band}" — choose easy, medium or hard`);
  process.exit(2);
}

const buf = fs.readFileSync(path.join(ROOT, 'public', 'corpus', 'corpus.bin'));
const corpus = decodeCorpus(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const model = loadClueModel(JSON.parse(
  fs.readFileSync(path.join(ROOT, 'public', 'corpus', 'clue-model.json'), 'utf8')));

const inCorpus = corpus.clueStore.wordIndexOf.has(word);
const af = answerFeaturesFrom(corpus, word);
const range = answerRange(corpus, model, word);
const win = BANDS[band];

console.log(`\n${word}  ·  aiming ${win.label} (${win.min}–${win.max === 101 ? 100 : win.max} of 100)`
  + (sense ? `  ·  meaning: ${sense}` : ''));
if (inCorpus) {
  console.log(`in the corpus · zipf ${af.zipf?.toFixed(2)} · crosswordese ${af.crosswordese?.toFixed(2)}`
    + (range ? ` · published clues run ${Math.round(range.min)}–${Math.round(range.max)}` : ''));
  if (range && (range.max < win.min || range.min >= win.max)) {
    console.log(`  note: no published clue for ${word} is ${win.label.toLowerCase()} — the answer itself`);
    console.log('        sets most of the difficulty, so this band may not be reachable.');
  }
} else {
  // Worth stating plainly: four of the model's features describe the answer, and they are
  // all unavailable here, which is a measured accuracy drop rather than a rounding error.
  console.log('NOT in the corpus — no published clues, and the scorer runs on clue text alone');
  console.log('  (Spearman 0.373 rather than 0.521; treat the numbers as a rough sort, not a verdict)');
}

const show = (list, title) => {
  if (!list.length) return;
  console.log(`\n  ${title}`);
  for (const c of list) {
    const mark = c.inBand ? ' ' : '·';
    const flags = [c.source === 'corpus' ? 'published' : '', c.suspect ? 'CHECK ACCURACY' : '']
      .filter(Boolean).join(' ');
    console.log(`   ${mark} ${String(Math.round(c.percentile)).padStart(3)}  ${c.clue}`
      + (flags ? `   [${flags}]` : ''));
  }
};

let candidates = corpusCandidates(corpus, model, word, { band });
show(candidates.filter((c) => c.inBand), `published, in band`);
show(candidates.filter((c) => !c.inBand), `published, outside the band`);

if (doGen) {
  let up = false;
  try {
    const c = new AbortController();
    const to = setTimeout(() => c.abort(), 4000);
    up = (await fetch(`${OLLAMA}/api/tags`, { signal: c.signal })).ok;
    clearTimeout(to);
  } catch { up = false; }

  if (!up) {
    console.log(`\n  (${OLLAMA} unreachable — skipping generation)`);
  } else {
    process.stdout.write(`\n  asking ${GEN_MODEL}…`);
    const t = Date.now();
    const generate = makeGenerator({ baseUrl: OLLAMA, model: GEN_MODEL, perWord: count });
    const knownClues = corpusCandidates(corpus, model, word, { band }).map((c) => c.clue);
    const fresh = await generate([{ word, sense, known: knownClues }], band);
    const got = fresh.get(word) || { clues: [], reading: '' };
    // Compare as written, not normalised: "AM IN OT" collapses back to AMINOT, and that
    // mis-split is precisely what you need to see.
    if (got.reading && got.reading.toUpperCase().trim() !== word) {
      console.log(`  the model read this as: ${got.reading}`);
    }
    let scored = scoreCandidates(corpus, model, word, got.clues, {
      band, exclude: new Set(candidates.map((c) => c.clue.toLowerCase())),
    });
    // Only meaningful when the corpus knows the answer — the check compares against its
    // real clues, and GHAST-like words have none.
    if (inCorpus) scored = await flagImplausible(corpus, word, scored, { baseUrl: 'http://localhost:11434' });
    console.log(` ${((Date.now() - t) / 1000).toFixed(0)}s`);
    show(scored.filter((c) => c.inBand), 'written, in band');
    show(scored.filter((c) => !c.inBand), 'written, outside the band');
    candidates = [...candidates, ...scored];
  }
}

const hits = candidates.filter((c) => c.inBand).length;
console.log(`\n  ${hits} of ${candidates.length} land in ${win.label}.`
  + (hits ? '' : `  Try another band — ${word} may not reach this one.`));
console.log('');
