// Corpus index: packed words + per-(length, position, letter) bitsets.
//
// This replaces `wordsByLength` in the old solver, which bucketed raw CSV ROWS rather
// than distinct words — 156,013 entries for 6,301 distinct 4-letter words. The old
// per-attempt setup shuffled and Set-ified that duplicated bucket once per slot, which
// for the Classic 15x15 layout is ~33.5 million string operations before a single word
// is placed, repeated on every restart for the full 120s budget.
//
// Here the same setup is ~19,000 u32 operations, and it happens ONCE per corpus rather
// than once per attempt.
//
// There is exactly one index builder (this file) for both the prebuilt corpus.bin and
// user-uploaded CSVs, so the two can't drift apart.

import { setBit } from './bitset.js';

export const MIN_WORD_LEN = 3;
export const MAX_WORD_LEN = 15;
export const ADHOC_CAPACITY = 32; // reserved bit-slots per length for off-dictionary words

const A_CODE = 65;

/**
 * @typedef {Object} LenIndex
 * @property {number} len
 * @property {number} count   real words
 * @property {number} extra   ad-hoc words currently in the reserved tail
 * @property {number} W       32-bit words per bitset
 * @property {Uint8Array}  letters     letter codes 0..25, word i at [i*len, i*len+len)
 * @property {Uint32Array} all         bits 0..count-1 (+ live ad-hoc), tail zeroed
 * @property {Uint32Array} byLetter    row (pos*26+letter) at offset (pos*26+letter)*W
 * @property {Uint16Array} score       static quality, DESCENDING by index
 * @property {Uint16Array} freq
 * @property {Uint8Array}  diff        difficulty 0..255
 * @property {Int32Array}  posAlphabet 26-bit mask of letters occurring at each position
 * @property {string[]}    words       decoded strings, for result assembly
 */

function makeLenIndex(len, count) {
  const W = Math.ceil((count + ADHOC_CAPACITY) / 32);
  const cap = W * 32;
  return {
    len,
    count,
    extra: 0,
    W,
    letters: new Uint8Array(cap * len),
    all: new Uint32Array(W),
    byLetter: new Uint32Array(len * 26 * W),
    score: new Uint16Array(cap),
    freq: new Uint16Array(cap),
    diff: new Uint8Array(cap),
    posAlphabet: new Int32Array(len),
    words: new Array(count),
  };
}

function writeWord(li, idx, word, score, freq, diff) {
  const { len, W } = li;
  for (let p = 0; p < len; p++) {
    const code = word.charCodeAt(p) - A_CODE;
    li.letters[idx * len + p] = code;
    setBit(li.byLetter, (p * 26 + code) * W, idx);
    li.posAlphabet[p] |= (1 << code);
  }
  setBit(li.all, 0, idx);
  li.score[idx] = score;
  li.freq[idx] = freq;
  li.diff[idx] = diff;
  li.words[idx] = word;
}

/**
 * Build from entries already sorted DESCENDING by score within each length.
 * That ordering is load-bearing: the solver takes "the top K candidates" as "the first
 * K set bits", which is an O(K) bit scan instead of sorting a 12,000-word domain.
 *
 * @param {Array<{word:string,score:number,freq:number,diff:number}>} entries
 */
export function buildWordIndex(entries, { fingerprint = '', presorted = false } = {}) {
  const groups = new Map();
  for (const e of entries) {
    const w = e.word;
    if (!w || w.length < MIN_WORD_LEN || w.length > MAX_WORD_LEN) continue;
    let g = groups.get(w.length);
    if (!g) groups.set(w.length, (g = []));
    g.push(e);
  }

  const byLen = new Array(MAX_WORD_LEN + 1).fill(null);
  const lookup = new Array(MAX_WORD_LEN + 1).fill(null);
  let total = 0;

  for (const [len, list] of groups) {
    if (!presorted) {
      list.sort((a, b) => (b.score - a.score) || (a.word < b.word ? -1 : a.word > b.word ? 1 : 0));
    }
    const li = makeLenIndex(len, list.length);
    const map = new Map();
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      writeWord(li, i, e.word, e.score | 0, e.freq | 0, e.diff | 0);
      if (!map.has(e.word)) map.set(e.word, i);
    }
    byLen[len] = li;
    lookup[len] = map;
    total += list.length;
  }

  return { fingerprint, byLen, lookup, total, minLen: MIN_WORD_LEN, maxLen: MAX_WORD_LEN };
}

/**
 * Add a word that isn't in the corpus (a user-typed required word, or a fully-preset
 * out-of-dictionary slot string) into the reserved tail. Returns its index, or -1 if the
 * tail is full — which preflight reports as TOO_MANY_CUSTOM_WORDS rather than silently
 * dropping the user's word.
 */
export function addAdHocWord(index, word) {
  const len = word.length;
  if (len < MIN_WORD_LEN || len > MAX_WORD_LEN) return -1;
  let li = index.byLen[len];
  if (!li) {
    li = makeLenIndex(len, 0);
    index.byLen[len] = li;
    index.lookup[len] = new Map();
  }
  const existing = index.lookup[len].get(word);
  if (existing !== undefined) return existing;
  if (li.extra >= ADHOC_CAPACITY) return -1;
  const idx = li.count + li.extra;
  li.extra++;
  // Score 65535 so a required word is always among the first candidates tried.
  writeWord(li, idx, word, 65535, 0, 128);
  index.lookup[len].set(word, idx);
  return idx;
}

/** Drop every ad-hoc word, restoring the index to its on-disk state. */
export function resetAdHoc(index) {
  for (let len = MIN_WORD_LEN; len <= MAX_WORD_LEN; len++) {
    const li = index.byLen[len];
    if (!li || li.extra === 0) continue;
    const { W, count } = li;
    for (let i = count; i < count + li.extra; i++) {
      const w = li.words[i];
      if (w) {
        for (let p = 0; p < len; p++) {
          const code = w.charCodeAt(p) - A_CODE;
          li.byLetter[(p * 26 + code) * W + (i >>> 5)] &= ~(1 << (i & 31));
        }
        index.lookup[len].delete(w);
        li.words[i] = undefined;
      }
      li.all[i >>> 5] &= ~(1 << (i & 31));
      li.score[i] = 0; li.freq[i] = 0; li.diff[i] = 0;
    }
    li.extra = 0;
  }
}

// ---------------------------------------------------------------------------
// corpus.bin  (see pipeline/stages/s7_pack.py for the writer)
// ---------------------------------------------------------------------------

const MAGIC = 0x4353524b; // "KRSC" little-endian

/**
 * Decode the packed artifact into index entries plus the clue store.
 * The format is deliberately trivial to parse — no per-row string splitting, no
 * 552k-object intermediate — so a cold start costs a few tens of ms instead of
 * 1.5-3s of CSV parsing.
 */
export function decodeCorpus(buffer) {
  const dv = new DataView(buffer);
  if (dv.getUint32(0, true) !== MAGIC) throw new Error('corpus.bin: bad magic');
  const version = dv.getUint32(4, true);
  if (version !== 1 && version !== 2) throw new Error(`corpus.bin: unsupported version ${version}`);
  const hlen = dv.getUint32(8, true);
  const headerBytes = new Uint8Array(buffer, 12, hlen);
  const header = JSON.parse(new TextDecoder().decode(headerBytes));
  const base = 12 + hlen;
  const sec = (name) => {
    const s = header.sections[name];
    return { off: base + s.offset, len: s.length };
  };

  const wordsSec = sec('words');
  const metaSec = sec('meta');
  const cidxSec = sec('cidx');
  const cblobSec = sec('cblob');

  const wordBytes = new Uint8Array(buffer, wordsSec.off, wordsSec.len);
  const metaDv = new DataView(buffer, metaSec.off, metaSec.len);
  const cidxDv = new DataView(buffer, cidxSec.off, cidxSec.len);

  // v2 widened the per-word meta from 5 to 13 bytes to carry the answer-side features
  // the browser clue scorer needs (see src/utils/clueScore.js).
  const stride = header.metaStride || 5;
  const entries = new Array(header.totalWords);
  const clueOffsets = new Uint32Array(header.totalWords);
  const clueCounts = new Uint8Array(header.totalWords);

  let byteCursor = 0;
  for (const g of header.lengths) {
    const { len, count, wordIndex } = g;
    for (let i = 0; i < count; i++) {
      const gi = wordIndex + i;
      let s = '';
      for (let p = 0; p < len; p++) s += String.fromCharCode(wordBytes[byteCursor + p]);
      byteCursor += len;
      const mo = gi * stride;
      entries[gi] = {
        word: s,
        score: metaDv.getUint16(mo, true),
        freq: metaDv.getUint16(mo + 2, true),
        diff: metaDv.getUint8(mo + 4),
        // Quantised so they recover EXACTLY the values the difficulty model was trained
        // on -- s2_features rounds zipf to 3dp and the other two to 4dp.
        zipf: stride >= 13 ? metaDv.getUint16(mo + 5, true) / 1000 : undefined,
        crosswordese: stride >= 13 ? metaDv.getUint16(mo + 7, true) / 10000 : undefined,
        corpusFreqLog: stride >= 13 ? metaDv.getUint16(mo + 9, true) / 10000 : undefined,
        distinctClues: stride >= 13 ? metaDv.getUint16(mo + 11, true) : undefined,
      };
      clueOffsets[gi] = cidxDv.getUint32(gi * 5, true);
      clueCounts[gi] = cidxDv.getUint8(gi * 5 + 4);
    }
  }

  return {
    header,
    entries,
    // Words are already in descending-score order per length group.
    presorted: true,
    clueStore: {
      blob: new DataView(buffer, cblobSec.off, cblobSec.len),
      offsets: clueOffsets,
      counts: clueCounts,
      wordIndexOf: buildWordIndexMap(entries),
    },
  };
}

function buildWordIndexMap(entries) {
  const m = new Map();
  for (let i = 0; i < entries.length; i++) {
    if (!m.has(entries[i].word)) m.set(entries[i].word, i);
  }
  return m;
}

/** Stable id for a corpus, so the worker rebuilds only when the source actually changes. */
export function fingerprintOf(tag, size, sample = '') {
  let h = 0x811c9dc5;
  const s = `${tag}:${size}:${sample}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${tag}:${size}:${(h >>> 0).toString(36)}`;
}

/**
 * Build index entries from parsed CSV rows (the user-upload / Tagalog path).
 * Dedupes to distinct words — the thing the old solver never did — and derives the
 * static quality score from corpus frequency, which is what makes common, fair entries
 * get tried before obscure ones.
 */
export function entriesFromRows(rows) {
  const freq = new Map();
  const diffSum = new Map();
  const diffN = new Map();
  const DIFF = { EASY: 0, FAIR: 0.3, MODERATE: 0.5, HARD: 0.7, DIFFICULT: 1.0 };
  for (const r of rows) {
    const w = r.word;
    if (!w || w.length < MIN_WORD_LEN || w.length > MAX_WORD_LEN) continue;
    freq.set(w, (freq.get(w) || 0) + 1);
    const d = DIFF[(r.difficulty || '').toUpperCase()];
    if (d !== undefined) {
      diffSum.set(w, (diffSum.get(w) || 0) + d);
      diffN.set(w, (diffN.get(w) || 0) + 1);
    }
  }
  let maxFreq = 1;
  for (const n of freq.values()) if (n > maxFreq) maxFreq = n;
  const lfMax = Math.log1p(maxFreq);
  const out = [];
  for (const [word, n] of freq) {
    const q = lfMax > 0 ? Math.log1p(n) / lfMax : 0;
    const dn = diffN.get(word) || 0;
    const d = dn ? diffSum.get(word) / dn : 0.5;
    out.push({
      word,
      score: Math.round(q * 65535),
      freq: Math.min(65535, n),
      diff: Math.round(d * 255),
    });
  }
  return out;
}
