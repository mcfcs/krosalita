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
import { assignClues, buildClueIndexFromRows } from '../utils/clueIndex.js';
import {
  decodeCorpus, buildWordIndex, entriesFromRows, fingerprintOf,
} from '../utils/wordIndex.js';
import { randomSeed } from '../utils/rng.js';

let cancelled = false;
let cached = null; // { fingerprint, index, clueStore, rowIndex }

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
    rowIndex: null,
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
      difficultyTarget: p.difficultyTarget,
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
      difficultyTarget: p.difficultyTarget,
      rng: (() => { let s = (seed ^ 0x9e3779b9) >>> 0;
        return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; })(),
    });

    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
