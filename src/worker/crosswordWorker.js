// Web Worker host for the crossword solver.
//
// The worker now owns the corpus. It builds the word index once and caches it at module
// scope, keyed by a fingerprint, so repeated generations reuse it. Previously App.jsx
// spawned a fresh Worker per run and structured-cloned the entire 552k-row word list
// into it — three times per "Generate" click when a difficulty band was selected.
//
// Protocol:
//   -> { type:'loadCorpus', payload:{ url } | { rows, sourceTag } }
//   <- { type:'corpusReady', fingerprint, stats }
//   -> { type:'start', payload:{ layout, corpusFingerprint, seed, ... } }
//   <- { type:'progress'|'best'|'done'|'error'|'needCorpus' }
//   -> { type:'cancel' }

import { solveCrossword } from '../utils/solver.js';
import {
  assignClues, buildClueIndexFromRows, cluesForWord, clueDiffQuantiles,
  clueDiffQuantilesFromRowIndex, quantilesFromValues, targetForBand, percentileIn,
} from '../utils/clueIndex.js';
import {
  decodeCorpus, buildWordIndex, entriesFromRows, fingerprintOf,
} from '../utils/wordIndex.js';
import { randomSeed } from '../utils/rng.js';

let cancelled = false;
let cached = null; // { fingerprint, index, clueStore, rowIndex, quantiles, clueQuantiles }

// The 0..1 difficulty scale is absolute, but it is not uniformly populated: in the
// shipped corpus only ~5% of answers sit below 0.21, so a 78-entry grid cannot average
// 0.10 however the solver is steered. Asking for "easy" therefore has to mean "the
// easiest this word list can actually do" — hence targetForBand/percentileIn, which
// convert between the nominal band the user picked and this corpus's own distribution.
//
// There are TWO such distributions and they are not interchangeable:
//
//   answerQuantiles  over the per-ANSWER difficulty byte. What the solver compares against
//                    when it steers the fill, so it is the right scale for its target.
//   clueQuantiles    over the per-CLUE difficulty byte. What assignClues compares against,
//                    and what a solver actually experiences.
//
// s7_pack writes a word's difficulty as the MEAN of its kept clues, so the answer table is
// the clue table with the within-word variance averaged out — same units, narrower spread
// (sd 0.124 vs 0.143). Feeding the answer-scale target to assignClues (what this file used
// to do) squeezed the request: "easy" asked for the 16th clue percentile instead of the
// 10th, "fair" for the 37th instead of the 30th.
const quantilesOf = (entries) => quantilesFromValues(entries.map((e) => (e.diff || 0) / 255));

async function loadFromUrl(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load the word list (${res.status}).`);
  const buf = await res.arrayBuffer();
  const corpus = decodeCorpus(buf);
  const fingerprint = fingerprintOf('corpus', buf.byteLength,
    String(corpus.header.createdAt || ''));
  return {
    fingerprint,
    index: buildWordIndex(corpus.entries, { fingerprint, presorted: true }),
    clueStore: corpus.clueStore,
    entries: corpus.entries,
    rowIndex: null,
    quantiles: corpus.header.difficultyQuantiles || null,
    // One histogram pass over the packed clue blob. Measured 3-5 ms for the shipped
    // corpus's 209k clues, against ~60 ms to decode and build the word index, so it is
    // not a startup cost anyone can feel.
    clueQuantiles: clueDiffQuantiles(corpus.clueStore),
    stats: { distinct: corpus.entries.length, difficultySource: corpus.header.difficultySource },
  };
}

function loadFromRows(rows, sourceTag) {
  const fingerprint = fingerprintOf(sourceTag || 'rows', rows.length,
    rows.length ? `${rows[0].word}:${rows[rows.length - 1].word}` : '');
  const entries = entriesFromRows(rows);
  const rowIdx = buildClueIndexFromRows(rows);
  return {
    fingerprint,
    index: buildWordIndex(entries, { fingerprint }),
    clueStore: null,
    rowIndex: rowIdx,
    quantiles: quantilesOf(entries),
    clueQuantiles: clueDiffQuantilesFromRowIndex(rowIdx),
    stats: { distinct: entries.length, difficultySource: 'csv-labels' },
  };
}

self.onmessage = async (e) => {
  const msg = e.data || {};

  if (msg.type === 'cancel') {
    cancelled = true;
    return;
  }

  if (msg.type === 'loadCorpus') {
    try {
      const p = msg.payload || {};
      const next = p.rows ? loadFromRows(p.rows, p.sourceTag) : await loadFromUrl(p.url);
      cached = next;
      self.postMessage({ type: 'corpusReady', fingerprint: next.fingerprint, stats: next.stats });
    } catch (err) {
      self.postMessage({ type: 'error', message: String((err && err.message) || err) });
    }
    return;
  }

  // The corpus lives here, but the clue scorer runs on the main thread (it has to score
  // every keystroke while someone types a clue). So the worker hands over just the raw
  // per-answer material — the four model features and the answer's known clues — and the
  // main thread does the scoring. Cheap: a 15x15 puzzle is ~80 answers.
  if (msg.type === 'clueData') {
    const words = [...new Set((msg.payload?.words || []).filter(Boolean))];
    const data = {};
    for (const w of words) {
      const i = cached?.clueStore?.wordIndexOf?.get(w);
      const e = i === undefined ? null : cached.entries?.[i];
      // An uploaded CSV or Tagalog mode has no packed clue store, only rowIndex. Without
      // this fallback the Studio showed no candidates at all in those modes -- silently,
      // since an empty list is indistinguishable from an answer with no clues.
      const clues = cached?.clueStore
        ? cluesForWord(cached.clueStore, w)
        : (cached?.rowIndex?.get(w) || []).slice(0, 8);
      data[w] = {
        answerFeatures: e ? {
          corpusFreqLog: e.corpusFreqLog,
          zipf: e.zipf,
          crosswordese: e.crosswordese,
          distinctClues: e.distinctClues,
        } : null,
        clues,
      };
    }
    self.postMessage({ type: 'clueDataResult', data });
    return;
  }

  if (msg.type !== 'start') return;

  cancelled = false;
  const p = msg.payload || {};

  if (!cached || (p.corpusFingerprint && p.corpusFingerprint !== cached.fingerprint)) {
    self.postMessage({ type: 'needCorpus' });
    return;
  }

  try {
    const seed = p.seed != null ? p.seed : randomSeed();
    const result = solveCrossword({
      index: cached.index,
      layout: p.layout,
      presetGrid: p.presetGrid,
      requiredWordsList: p.requiredWordsList,
      requiredModeArg: p.requiredModeArg,
      timeoutMs: p.timeoutMs,
      seed,
      // The solver compares against the per-ANSWER difficulty byte, so the ANSWER
      // quantiles are the right scale here. A hard answer really is harder, and this
      // steering is what makes the clue targeting below reachable in the first place.
      difficultyTarget: targetForBand(p.difficultyTarget, cached.quantiles),
      onProgress: (text) => self.postMessage({ type: 'progress', text }),
      onBest: (best) => self.postMessage({ type: 'best', result: best }),
      now: () => performance.now(),
      isCancelled: () => cancelled,
    });

    // Clues are chosen after the fill, so selection can weigh difficulty and variety
    // instead of always taking a word's oldest clue.
    const clueTarget = targetForBand(p.difficultyTarget, cached.clueQuantiles);
    result.placements = assignClues(result.placements, {
      store: cached.clueStore,
      rowIndex: cached.rowIndex,
      presetClues: p.presetClues || {},
      // CLUE scale, not the answer scale. See the note at the top of this file.
      difficultyTarget: clueTarget,
      rng: (() => { let s = (seed ^ 0x9e3779b9) >>> 0;
        return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })(),
    });

    // ---- what the puzzle ACTUALLY came out as -------------------------------
    //
    // The difficulty a solver experiences is in the clues, so that is what gets reported.
    // `difficultyPercentile` — which App.jsx renders as the puzzle's score and label — is
    // now the percentile of the mean ASSIGNED CLUE difficulty within this corpus's clue
    // distribution. It used to be the mean ANSWER difficulty's percentile, which
    // described the fill rather than the solve and disagreed with the requested band by
    // up to a whole label on small grids.
    //
    // The old number is still reported as `difficultyAnswerPercentile`, and
    // `difficultyReport` carries the request/achievement pair so an unreachable band can
    // be stated rather than silently drifted into.
    let clueSum = 0;
    let clueN = 0;
    for (const pl of result.placements) {
      if (typeof pl.clueDiff === 'number') { clueSum += pl.clueDiff; clueN++; }
    }
    const clueMean = clueN ? clueSum / clueN : null;

    result.difficultyAnswerPercentile = percentileIn(
      result.difficultyMean == null ? null : result.difficultyMean / 100, cached.quantiles);
    result.difficultyCluePercentile = clueMean == null
      ? null : percentileIn(clueMean, cached.clueQuantiles);
    // Fall back to the answer percentile when there are no clue quantiles at all (a CSV
    // upload with no difficulty column), so this never regresses to nothing.
    result.difficultyPercentile = result.difficultyCluePercentile != null
      ? result.difficultyCluePercentile : result.difficultyAnswerPercentile;

    const requested = p.difficultyTarget == null ? null : Math.round(p.difficultyTarget * 100);
    const achieved = result.difficultyPercentile;
    result.difficultyReport = {
      requestedPercentile: requested,
      achievedPercentile: achieved,
      achievedAnswerPercentile: result.difficultyAnswerPercentile,
      clueTarget,
      clueMean,
      cluesScored: clueN,
      // A band is only honestly "hit" if the achieved percentile lands inside it. The
      // bands are 20 points wide (see DIFFICULTY_BANDS), and a request sits at the
      // midpoint, so anything further than 10 points away has fallen out of the band.
      onTarget: requested == null || achieved == null ? null : Math.abs(achieved - requested) <= 10,
      shortfall: requested == null || achieved == null ? null : achieved - requested,
    };

    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
