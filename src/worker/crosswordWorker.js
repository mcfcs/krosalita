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
import { assignClues, buildClueIndexFromRows, cluesForWord } from '../utils/clueIndex.js';
import {
  decodeCorpus, buildWordIndex, entriesFromRows, fingerprintOf,
} from '../utils/wordIndex.js';
import { randomSeed } from '../utils/rng.js';

let cancelled = false;
let cached = null; // { fingerprint, index, clueStore, rowIndex, quantiles }

// The 0..1 difficulty scale is absolute, but it is not uniformly populated: in the
// shipped corpus only ~5% of answers sit below 0.21, so a 78-entry grid cannot average
// 0.10 however the solver is steered. Asking for "easy" therefore has to mean "the
// easiest this word list can actually do". These two functions convert between the
// nominal band the user picked and the difficulty that band corresponds to here.
const quantilesOf = (entries) => {
  const d = entries.map((e) => (e.diff || 0) / 255).sort((a, b) => a - b);
  if (!d.length) return null;
  return Array.from({ length: 101 },
    (_, q) => d[Math.min(d.length - 1, Math.floor((d.length * q) / 100))]);
};

/** Nominal 0..1 band -> the difficulty value at that quantile of this corpus. */
const targetFor = (band, quantiles) => {
  if (band == null) return null;
  if (!quantiles || !quantiles.length) return band;
  return quantiles[Math.max(0, Math.min(100, Math.round(band * 100)))];
};

/** An achieved difficulty -> where it sits in this corpus, as 0..100. */
const percentileOf = (value, quantiles) => {
  if (value == null) return null;
  if (!quantiles || !quantiles.length) return value * 100;
  let lo = 0, hi = 100;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (quantiles[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
};

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
    stats: { distinct: corpus.entries.length, difficultySource: corpus.header.difficultySource },
  };
}

function loadFromRows(rows, sourceTag) {
  const fingerprint = fingerprintOf(sourceTag || 'rows', rows.length,
    rows.length ? `${rows[0].word}:${rows[rows.length - 1].word}` : '');
  const entries = entriesFromRows(rows);
  return {
    fingerprint,
    index: buildWordIndex(entries, { fingerprint }),
    clueStore: null,
    rowIndex: buildClueIndexFromRows(rows),
    quantiles: quantilesOf(entries),
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
      difficultyTarget: targetFor(p.difficultyTarget, cached.quantiles),
      onProgress: (text) => self.postMessage({ type: 'progress', text }),
      onBest: (best) => self.postMessage({ type: 'best', result: best }),
      now: () => performance.now(),
      isCancelled: () => cancelled,
    });

    // Clues are chosen after the fill, so selection can weigh difficulty and variety
    // instead of always taking a word's oldest clue.
    result.placements = assignClues(result.placements, {
      store: cached.clueStore,
      rowIndex: cached.rowIndex,
      presetClues: p.presetClues || {},
      difficultyTarget: targetFor(p.difficultyTarget, cached.quantiles),
      rng: (() => { let s = (seed ^ 0x9e3779b9) >>> 0;
        return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })(),
    });

    // Report the puzzle's difficulty as a percentile of this corpus, so the band the
    // user asked for and the band they are shown mean the same thing.
    result.difficultyPercentile = percentileOf(
      result.difficultyMean == null ? null : result.difficultyMean / 100, cached.quantiles);

    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
