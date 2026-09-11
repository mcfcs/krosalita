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
 *   3. prefer the clue closest to the target difficulty;
 *   4. never reuse clue text already used elsewhere in this puzzle;
 *   5. break ties with the seeded rng so repeat generations vary.
 *
 * @param {Array} placements      from solveCrossword
 * @param {Object} opts
 * @param {Object} [opts.store]         packed clue store (corpus.bin)
 * @param {Object} [opts.rowIndex]      buildClueIndexFromRows result
 * @param {Object} [opts.presetClues]   keyed `${direction}-${row}-${col}`
 * @param {number|null} [opts.difficultyTarget]
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

  for (const p of placements) {
    const key = `${p.slot.direction}-${p.slot.row}-${p.slot.col}`;
    const preset = presetClues[key];
    if (preset) {
      out.push({ ...p, clue: preset });
      continue;
    }

    let candidates = cluesForWord(store, p.word);
    if ((!candidates || !candidates.length) && rowIndex) candidates = rowIndex.get(p.word);

    const usable = (candidates || []).filter(
      (c) => isClueUsableFor(c.clue, p.word) && !usedClues.has(c.clue.toLowerCase()),
    );

    let chosen = '';
    if (usable.length) {
      if (difficultyTarget == null) {
        // No target: the packed store is ordered best-first by recurrence, so take from
        // the front, with a little seeded jitter for variety across regenerations.
        chosen = usable[Math.min(usable.length - 1, Math.floor(rng() * Math.min(3, usable.length)))].clue;
      } else {
        let best = usable[0];
        let bestD = Infinity;
        for (const c of usable) {
          const d = Math.abs(c.diff - difficultyTarget) + rng() * 0.02;
          if (d < bestD) { bestD = d; best = c; }
        }
        chosen = best.clue;
      }
      usedClues.add(chosen.toLowerCase());
    }

    out.push({ ...p, clue: chosen });
  }

  return out;
}
