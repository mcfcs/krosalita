// Clue selection, decoupled from grid filling.
//
// The old solver baked cluing into placement: solver.js:53-55 kept only the FIRST
// dictionary row per word, and parseCSV's stable sort over an oldest-first CSV made that
// "first" the earliest-dated one. Every answer therefore got its 1993-era clue — which
// is also precisely the era the surviving cross-reference clues came from.
//
// Here the solver returns answers, and this picks clues afterwards, so it can consider
// difficulty, variety, and whether a clue is usable at all.

import { isClueUsableFor } from './clueFilters.js';

/**
 * Read the packed clue store for one answer.
 *
 * Looked up by the WORD, not by the solver's word index: the solver's index is relative
 * to its length group, while the clue store is indexed globally across all lengths, so
 * passing the solver's index straight through silently returns another word's clues.
 *
 * @returns {Array<{clue:string,diff:number}>} ascending by difficulty
 */
export function cluesForWord(store, word) {
  if (!store || !word) return [];
  // An in-memory store, built from data the worker handed over. The packed store reads
  // bytes out of corpus.bin, which only the worker holds, so the main thread needs a
  // shape it can populate itself rather than a second copy of the 6 MB artifact.
  if (store.__mem) return store.__mem.get(word) || [];
  const wordIndex = store.wordIndexOf.get(word);
  if (wordIndex === undefined) return [];
  const n = store.counts[wordIndex];
  if (!n) return [];
  const dv = store.blob;
  let p = store.offsets[wordIndex];
  const out = [];
  const dec = new TextDecoder();
  for (let i = 0; i < n; i++) {
    const diff = dv.getUint8(p);
    const len = dv.getUint16(p + 1, true);
    p += 3;
    const bytes = new Uint8Array(dv.buffer, dv.byteOffset + p, len);
    out.push({ clue: dec.decode(bytes), diff: diff / 255 });
    p += len;
  }
  return out;
}

/**
 * Null out a quantile table that carries no information.
 *
 * A CSV upload with no difficulty column gives every clue the same 0.5, so every entry of
 * the table is identical. percentileIn() against such a table answers 0 for everything,
 * which would label every puzzle "Easy" — worse than having no table at all, because the
 * caller cannot tell the two apart. Returning null lets the caller fall back.
 */
const spread = (q) => (q && q.length && q[q.length - 1] > q[0] ? q : null);

/**
 * 101-point quantile table (q0..q100) over a sorted-in-place array of numbers.
 * Shared so every difficulty scale in the app is bucketed the same way.
 */
export function quantilesFromValues(values) {
  if (!values || !values.length) return null;
  // Copy: callers pass arrays they still own, and an in-place sort here would silently
  // reorder them.
  const a = Array.from(values).sort((x, y) => x - y);
  return Array.from({ length: 101 },
    (_, q) => a[Math.min(a.length - 1, Math.floor((a.length * q) / 100))]);
}

/**
 * Quantiles of the per-CLUE difficulty in a clue store.
 *
 * The answer-difficulty quantiles shipped in the corpus header are NOT a stand-in for
 * these. s7_pack writes a word's `diff` byte as the MEAN of its kept clues, so the answer
 * distribution is the clue distribution with the within-word variance averaged out: same
 * scale, visibly narrower (sd 0.124 vs 0.143 in the shipped corpus). Ranking a clue
 * against the answer table therefore squeezes the requested range at both ends.
 *
 * Reads the packed blob directly instead of going through cluesForWord, because decoding
 * 209k clue STRINGS to look at one leading byte each costs ~20x what this does.
 */
export function clueDiffQuantiles(store, entries = null) {
  if (!store) return null;
  if (store.blob && store.offsets && store.counts) {
    // The packed difficulty is a single BYTE, so a 256-bucket histogram gives the exact
    // quantiles with no allocation and no sort. Measured on the shipped corpus: 3-5 ms
    // for 209k clues, against ~45 ms for collect-then-sort -- small enough to run on
    // every corpus load without being felt at startup.
    const hist = new Int32Array(256);
    const dv = store.blob;
    const n = store.counts.length;
    let total = 0;
    for (let i = 0; i < n; i++) {
      let p = store.offsets[i];
      for (let k = store.counts[i]; k > 0; k--) {
        hist[dv.getUint8(p)]++;
        total++;
        p += 3 + dv.getUint16(p + 1, true);
      }
    }
    if (!total) return null;
    const out = new Array(101);
    let bucket = 0;
    let seen = hist[0];
    for (let q = 0; q <= 100; q++) {
      const want = Math.min(total - 1, Math.floor((total * q) / 100));
      while (seen <= want && bucket < 255) { bucket++; seen += hist[bucket]; }
      out[q] = bucket / 255;
    }
    return spread(out);
  }
  const vals = [];
  if (store.__mem) {
    for (const list of store.__mem.values()) for (const c of list) vals.push(c.diff);
  } else if (entries) {
    for (const e of entries) for (const c of cluesForWord(store, e.word)) vals.push(c.diff);
  }
  return spread(quantilesFromValues(vals));
}

/** Quantiles of the per-clue difficulty in a buildClueIndexFromRows index. */
export function clueDiffQuantilesFromRowIndex(rowIndex) {
  if (!rowIndex || !rowIndex.byWord) return null;
  const vals = [];
  for (const list of rowIndex.byWord.values()) for (const c of list) vals.push(c.diff);
  return spread(quantilesFromValues(vals));
}

/**
 * Nominal 0..1 band -> the difficulty value sitting at that quantile of `quantiles`.
 *
 * The 0..1 scale is absolute but not uniformly populated (only ~5% of answers sit below
 * 0.21), so "easy" has to mean "the easiest this corpus can actually do", not 0.10.
 */
export function targetForBand(band, quantiles) {
  if (band == null) return null;
  if (!quantiles || !quantiles.length) return band;
  return quantiles[Math.max(0, Math.min(100, Math.round(band * 100)))];
}

/** An achieved difficulty -> where it sits in `quantiles`, as 0..100. */
export function percentileIn(value, quantiles) {
  if (value == null) return null;
  if (!quantiles || !quantiles.length) return value * 100;
  let lo = 0;
  let hi = quantiles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (quantiles[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * A clue store backed by a plain Map, for data fetched from the worker.
 * Same read API as the packed store, so everything in clueSource.js works against either.
 */
export function memoryClueStore(byWord) {
  return {
    __mem: byWord,
    wordIndexOf: new Map([...byWord.keys()].map((w, i) => [w, i])),
  };
}

/** Clue store backed by parsed CSV rows, for user uploads and Tagalog mode. */
export function buildClueIndexFromRows(rows) {
  const DIFF = { EASY: 0, FAIR: 0.3, MODERATE: 0.5, HARD: 0.7, DIFFICULT: 1.0 };
  const byWord = new Map();
  for (const r of rows) {
    if (!r.word || !r.clue) continue;
    let list = byWord.get(r.word);
    if (!list) byWord.set(r.word, (list = []));
    list.push({
      clue: r.clue,
      diff: DIFF[(r.difficulty || '').toUpperCase()] ?? 0.5,
      date: r.date || '',
    });
  }
  return {
    byWord,
    get(word) { return byWord.get(word) || []; },
  };
}

/**
 * Assign a clue to every placement.
 *
 * Selection order, per answer:
 *   1. a clue the user typed for that slot wins outright;
 *   2. it must pass the cross-reference / grid-dependent filters and not leak the answer;
 *   3. prefer the clue that steers the PUZZLE's mean clue difficulty to the target;
 *   4. never reuse clue text already used elsewhere in this puzzle;
 *   5. break ties with the seeded rng so repeat generations vary.
 *
 * On (3): this used to pick, for every answer independently, the clue nearest the target.
 * That systematically undershoots, because an answer whose clues all sit above an "easy"
 * target contributes its excess and nothing ever pays it back — the finished puzzle drifts
 * toward the middle at both ends, which is exactly the "I picked Easy and got Fair"
 * complaint. So track the running mean instead and aim each remaining answer at the
 * RESIDUAL the puzzle still needs (the same trick solver.js uses for answer difficulty):
 * an answer that is forced high pushes every later answer lower to compensate.
 *
 * `difficultyTarget` is a value on the CLUE difficulty scale — see clueDiffQuantiles.
 * Passing an ANSWER-difficulty quantile here is a scale error: s7_pack writes a word's
 * difficulty byte as the MEAN of its clues, so the answer distribution is the clue
 * distribution with the within-word variance averaged out (sd 0.124 vs 0.143 in the
 * shipped corpus) and the two tables disagree by up to 7 percentile points.
 *
 * Each returned placement carries `clueDiff` — the chosen clue's difficulty, or null for a
 * preset/unclued slot — so the caller can report what the puzzle actually achieved rather
 * than what it asked for.
 *
 * @param {Array} placements      from solveCrossword
 * @param {Object} opts
 * @param {Object} [opts.store]         packed clue store (corpus.bin)
 * @param {Object} [opts.rowIndex]      buildClueIndexFromRows result
 * @param {Object} [opts.presetClues]   keyed `${direction}-${row}-${col}`
 * @param {number|null} [opts.difficultyTarget] on the CLUE difficulty scale, 0..1
 * @param {() => number} [opts.rng]
 */
export function assignClues(placements, {
  store = null,
  rowIndex = null,
  presetClues = {},
  difficultyTarget = null,
  rng = Math.random,
} = {}) {
  const usedClues = new Set();
  const out = [];

  // Pass 1: resolve each answer's usable clues once. The residual target needs to know up
  // front how many answers are left to steer with, and re-reading the packed store twice
  // would decode every clue string twice.
  const prepared = placements.map((p) => {
    const key = `${p.slot.direction}-${p.slot.row}-${p.slot.col}`;
    const preset = presetClues[key];
    if (preset) return { p, preset };
    let candidates = cluesForWord(store, p.word);
    if ((!candidates || !candidates.length) && rowIndex) candidates = rowIndex.get(p.word);
    return { p, preset: null, valid: (candidates || []).filter((c) => isClueUsableFor(c.clue, p.word)) };
  });

  const nSteer = prepared.reduce((a, x) => a + (!x.preset && x.valid.length ? 1 : 0), 0);
  let picked = 0;
  let diffSum = 0;

  for (const { p, preset, valid } of prepared) {
    if (preset) {
      out.push({ ...p, clue: preset, clueDiff: null });
      continue;
    }

    // Prefer a clue not already used elsewhere in this puzzle, but never at the cost of
    // leaving an answer unclued — a repeated clue is a blemish, an unclued answer is
    // unsolvable. (Measured: this fired for 7 answers across ~72,000 assignments.)
    const fresh = valid.filter((c) => !usedClues.has(c.clue.toLowerCase()));
    const usable = fresh.length ? fresh : valid;

    let chosen = '';
    let chosenDiff = null;
    if (usable.length) {
      if (difficultyTarget == null) {
        // No target: pick freely among the answer's kept clues. They are already ranked
        // for recurrence and recency at pack time, so an even draw here gives real
        // variety between regenerations instead of always serving the same few.
        const c = usable[Math.floor(rng() * usable.length)];
        chosen = c.clue;
        chosenDiff = c.diff;
      } else {
        const remaining = nSteer - picked;
        // What the answers still to be clued must average for the whole puzzle to land on
        // target. Clamped to [0,1]: once the target is out of reach the residual pins to
        // an end and every remaining answer simply takes its easiest / hardest clue —
        // best effort, and the caller reports the achieved value, not the requested one.
        const residual = remaining > 0
          ? Math.max(0, Math.min(1, (difficultyTarget * nSteer - diffSum) / remaining))
          : difficultyTarget;
        let best = usable[0];
        let bestD = Infinity;
        for (const c of usable) {
          const d = Math.abs(c.diff - residual) + rng() * 0.02;
          if (d < bestD) { bestD = d; best = c; }
        }
        chosen = best.clue;
        chosenDiff = best.diff;
      }
      usedClues.add(chosen.toLowerCase());
      picked++;
      diffSum += chosenDiff;
    }

    out.push({ ...p, clue: chosen, clueDiff: chosenDiff });
  }

  return out;
}
