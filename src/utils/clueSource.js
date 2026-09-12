// Where a clue at a given difficulty comes from.
//
// Three sources, ordered by quality and cost:
//
//   1. The corpus. It already holds up to five scored, human-written clues per answer.
//      Free, instant, and better than anything a model will write — 36% of answers have
//      an Easy clue already, so a third of any "make this easier" job needs no LLM at all.
//   2. Generation, then scoring. Asking the model for a difficulty does NOT reliably
//      produce it: asked for EASY clues for ORBIT it returned ones scoring at the 11th,
//      12th, 12th and 38th percentile, and asked for DIFFICULT it returned 28th-47th.
//      So candidates are over-generated, scored locally, and filtered.
//   3. Honest refusal. For 64% of answers the easiest published clue is still above the
//      Easy band, and for 32% the hardest is still below Hard — the answer sets the
//      range, and ERNE cannot be given a Monday clue. Saying so beats silently returning
//      something else.

import { isClueUsableFor } from './clueFilters.js';
import { cluesForWord } from './clueIndex.js';
import { cluePercentile, scoreClue, scorePercentile, answerFeaturesFrom } from './clueScore.js';
import { generateCluesBatch, embedTexts, discoverSenses } from './ollama.js';

/** The three bands offered for generation, as percentile windows. */
export const BANDS = {
  easy: { label: 'Easy', min: 0, max: 33, target: 0.12 },
  medium: { label: 'Medium', min: 33, max: 67, target: 0.5 },
  hard: { label: 'Hard', min: 67, max: 101, target: 0.88 },
};

export const bandOf = (percentile) => (
  percentile < BANDS.easy.max ? 'easy' : percentile < BANDS.medium.max ? 'medium' : 'hard'
);

/**
 * The difficulty window an answer can actually reach, judged by its real published clues.
 * `null` when the corpus has nothing for it.
 */
export function answerRange(corpus, model, word) {
  const clues = cluesForWord(corpus?.clueStore, word);
  if (!clues.length) return null;
  const af = answerFeaturesFrom(corpus, word);
  const ps = clues.map((c) => cluePercentile(model, word, c.clue, af));
  return { min: Math.min(...ps), max: Math.max(...ps), count: ps.length };
}

/** Existing corpus clues for an answer, scored and annotated, best-in-band first. */
export function corpusCandidates(corpus, model, word, { band = 'medium', exclude } = {}) {
  const af = answerFeaturesFrom(corpus, word);
  const want = BANDS[band] || BANDS.medium;
  return cluesForWord(corpus?.clueStore, word)
    .filter((c) => isClueUsableFor(c.clue, word))
    .filter((c) => !exclude?.has(c.clue.toLowerCase()))
    .map((c) => {
      const percentile = cluePercentile(model, word, c.clue, af);
      return {
        clue: c.clue,
        percentile,
        band: bandOf(percentile),
        source: 'corpus',
        inBand: percentile >= want.min && percentile < want.max,
      };
    })
    .sort((a, b) => (b.inBand - a.inBand)
      || Math.abs(a.percentile - want.target * 100) - Math.abs(b.percentile - want.target * 100));
}

/** Score, filter and annotate freshly generated clue text for one answer. */
export function scoreCandidates(corpus, model, word, clues, { band = 'medium', exclude } = {}) {
  const af = answerFeaturesFrom(corpus, word);
  const want = BANDS[band] || BANDS.medium;
  const seen = new Set();
  return (clues || [])
    .map((c) => String(c).trim())
    .filter((c) => c && isClueUsableFor(c, word))
    .filter((c) => {
      const k = c.toLowerCase();
      if (seen.has(k) || exclude?.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((clue) => {
      const percentile = cluePercentile(model, word, clue, af);
      return {
        clue,
        percentile,
        band: bandOf(percentile),
        source: 'generated',
        inBand: percentile >= want.min && percentile < want.max,
      };
    })
    .sort((a, b) => (b.inBand - a.inBand)
      || Math.abs(a.percentile - want.target * 100) - Math.abs(b.percentile - want.target * 100));
}

const PLAUSIBLE_MIN = 0.70;
// A sense whose gloss sits this close to the answer's published clues is the sense the
// corpus already uses. Lower than PLAUSIBLE_MIN because a one-line gloss is a looser
// match to a set of terse clues than another clue would be.
const SENSE_MATCH_MIN = 0.60;

function cosine(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * Flag generated clues that look factually wrong.
 *
 * A model asked to clue ERNE offered "Old British coin" — confident and completely wrong.
 * Nothing in the difficulty model can see that. Comparing a candidate against the centroid
 * of the answer's KNOWN clues can: on a hand-labelled sample every correct clue scored
 * >= 0.77 and every wrong one <= 0.64.
 *
 * Only works for answers the corpus knows, needs a local embedding server, and annotates
 * rather than removes — it is a warning for the author, not a verdict.
 */
export async function flagImplausible(corpus, word, candidates, { baseUrl, model, signal } = {}) {
  if (!baseUrl || !candidates.length) return candidates;
  // Fewer than three published clues makes a noisy centroid -- RAZER has only "Leveler"
  // and "Home wrecker", and correct generated clues were being flagged against them.
  const known = cluesForWord(corpus?.clueStore, word).map((c) => c.clue);
  if (known.length < 3) return candidates;
  try {
    const vecs = await embedTexts({
      baseUrl, model, signal, texts: [...candidates.map((c) => c.clue), ...known],
    });
    if (vecs.length !== candidates.length + known.length) return candidates;
    const kn = vecs.slice(candidates.length);
    const dim = kn[0].length;
    const centroid = new Array(dim).fill(0);
    for (const v of kn) for (let i = 0; i < dim; i++) centroid[i] += v[i] / kn.length;
    return candidates.map((c, i) => {
      const similarity = cosine(vecs[i], centroid);
      return { ...c, similarity, suspect: c.source === 'generated' && similarity < PLAUSIBLE_MIN };
    });
  } catch {
    return candidates; // the check is a bonus; never let it fail the whole request
  }
}

/** A sense, phrased the way generateCluesBatch wants it. */
export const senseText = (sense) => (
  !sense ? '' : [sense.label, sense.gloss].filter(Boolean).join(' — ')
    + (sense.domain ? ` (vocabulary: ${sense.domain})` : '')
);

/**
 * The distinct meanings an answer could be clued as, each marked with whether the corpus
 * corroborates it.
 *
 * The model invents senses for obscure answers — asked about RAZER it produced a "Vampire
 * character in D&D", and labelled a made-up "fictional weapon" sense as the one the corpus
 * uses. So its own claim about which sense is established is ignored; instead each sense's
 * gloss is compared against the centroid of the answer's published clues, the same check
 * that catches wrong clues. A sense that matches is marked published; everything else is
 * explicitly unverified, and the UI must not present the two alike.
 *
 * @returns {Promise<Array<{label,gloss,domain,similarity,corroborated}>>}
 */
export async function sensesForAnswer(corpus, word, { baseUrl, model, embedUrl, signal } = {}) {
  const known = cluesForWord(corpus?.clueStore, word).map((c) => c.clue);
  const senses = await discoverSenses({ baseUrl, model, word, known, signal });
  if (!senses.length) return [];
  if (!embedUrl || known.length < 3) {
    return senses.map((s) => ({ ...s, similarity: null, corroborated: null }));
  }
  try {
    const vecs = await embedTexts({
      baseUrl: embedUrl, signal,
      texts: [...senses.map((s) => `${s.label}. ${s.gloss}`), ...known],
    });
    if (vecs.length !== senses.length + known.length) {
      return senses.map((s) => ({ ...s, similarity: null, corroborated: null }));
    }
    const kn = vecs.slice(senses.length);
    const dim = kn[0].length;
    const centroid = new Array(dim).fill(0);
    for (const v of kn) for (let i = 0; i < dim; i++) centroid[i] += v[i] / kn.length;
    return senses.map((s, i) => {
      const similarity = cosine(vecs[i], centroid);
      return { ...s, similarity, corroborated: similarity >= SENSE_MATCH_MIN };
    });
  } catch {
    return senses.map((s) => ({ ...s, similarity: null, corroborated: null }));
  }
}

/**
 * Candidates for a single answer: corpus first, then generation to fill the gap.
 *
 * @returns {Promise<{word, band, candidates, range, reachable, usedLLM}>}
 */
export async function cluesForAnswer(corpus, model, word, {
  band = 'medium', exclude, generate = null, want = 6, sense = '',
} = {}) {
  const range = answerRange(corpus, model, word);
  const win = BANDS[band] || BANDS.medium;
  const candidates = corpusCandidates(corpus, model, word, { band, exclude });
  const haveInBand = candidates.filter((c) => c.inBand).length;

  let usedLLM = false;
  let reading = '';
  // Generate whenever the corpus cannot fill the band, regardless of the published range.
  if (generate && haveInBand < want) {
    usedLLM = true;
    // Hand over how this answer has actually been clued. Without it the model picks a
    // meaning at random -- ISITME became "Time to check one's watch?" rather than
    // "Am I the issue?" -- and for a concatenated phrase it often misreads the answer
    // entirely.
    const known = cluesForWord(corpus?.clueStore, word).map((c) => c.clue);
    const fresh = await generate([{ word, sense, known }], band);
    const got = fresh.get(word) || { clues: [], reading: '' };
    reading = got.reading || '';
    candidates.push(...scoreCandidates(corpus, model, word, got.clues, { band, exclude }));
    candidates.sort((a, b) => (b.inBand - a.inBand)
      || Math.abs(a.percentile - win.target * 100) - Math.abs(b.percentile - win.target * 100));
  }

  return {
    word,
    band,
    candidates,
    range,
    // "Reachable" means the corpus itself has ever managed a clue in this band for this
    // answer. When it hasn't, the UI should say so rather than present a near miss as a hit.
    reachable: !range || (range.min < win.max && range.max >= win.min),
    usedLLM,
    // What the model thought the answer says. Shown so a wrong reading is visible rather
    // than silently producing clues for a different word.
    reading,
  };
}

/**
 * Re-clue a whole puzzle at a target band.
 *
 * Corpus swaps happen first and for free; only the answers that still need help go to the
 * model, in batches. Nothing is applied — the caller reviews and accepts.
 *
 * @returns {Promise<{results, summary}>}
 */
export async function recluePuzzle(corpus, model, entries, {
  band = 'medium', generate = null, onProgress,
} = {}) {
  const win = BANDS[band] || BANDS.medium;
  const used = new Set();
  const results = [];
  const needsLLM = [];

  for (const e of entries) {
    const af = answerFeaturesFrom(corpus, e.word);
    const current = e.clue
      ? { clue: e.clue, percentile: cluePercentile(model, e.word, e.clue, af), source: 'current' }
      : null;
    const range = answerRange(corpus, model, e.word);
    const reachable = !range || (range.min < win.max && range.max >= win.min);
    const pick = corpusCandidates(corpus, model, e.word, { band, exclude: used })
      .find((c) => c.inBand);

    if (current && current.percentile >= win.min && current.percentile < win.max) {
      used.add(current.clue.toLowerCase());
      results.push({ ...e, current, chosen: null, status: 'already', range, reachable });
    } else if (pick) {
      used.add(pick.clue.toLowerCase());
      results.push({ ...e, current, chosen: pick, status: 'corpus', range, reachable });
    } else {
      // Always try generating, even when no PUBLISHED clue for this answer reaches the
      // band. The published range is evidence, not a ceiling — asked for hard clues for
      // PUZZLE the model produced ones scoring p53 while its published clues topped out
      // lower. Whether the band is truly out of reach is decided after trying, not before.
      results.push({ ...e, current, chosen: null, status: 'pending', range, reachable });
      needsLLM.push(e);
    }
  }
  onProgress?.({ phase: 'corpus', done: entries.length, total: entries.length, needsLLM: needsLLM.length });

  if (generate && needsLLM.length) {
    const withContext = needsLLM.map((e) => ({
      ...e,
      known: cluesForWord(corpus?.clueStore, e.word).map((c) => c.clue),
    }));
    const fresh = await generate(withContext, band, (p) => onProgress?.({ phase: 'generate', ...p }));
    for (const r of results) {
      if (r.status !== 'pending') continue;
      const got = fresh.get(r.word) || { clues: [], reading: '' };
      r.reading = got.reading || '';
      const scored = scoreCandidates(corpus, model, r.word, got.clues, { band, exclude: used });
      const best = scored.find((c) => c.inBand) || scored[0];
      if (best) {
        used.add(best.clue.toLowerCase());
        r.chosen = best;
        // A miss where the answer's published clues never reached this band either is
        // the honest "this answer can't be that hard/easy" case; a miss inside the
        // published range just means this attempt fell short.
        r.status = best.inBand ? 'generated' : (r.reachable ? 'missed' : 'unreachable');
      } else {
        r.status = r.reachable ? 'failed' : 'unreachable';
      }
    }
  }

  const count = (s) => results.filter((r) => r.status === s).length;
  return {
    results,
    summary: {
      total: results.length,
      already: count('already'),
      corpus: count('corpus'),
      generated: count('generated'),
      missed: count('missed'),
      unreachable: count('unreachable'),
      failed: count('failed') + count('pending'),
    },
  };
}

/** Bind the Ollama client into the `generate` callback the two functions above expect. */
export const makeGenerator = ({ baseUrl, model, perWord = 4, signal }) => (
  async (entries, band, onProgress) => generateCluesBatch({
    baseUrl, model, entries, band, perWord, signal, onProgress,
  })
);

export { scorePercentile, scoreClue };
