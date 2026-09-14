// Crossword fill — bitset CSP with MRV/dom-wdeg ordering, incremental AC-3,
// trail-based undo, conflict-directed backjumping and Luby restarts.
//
// Replaces the wave-function-collapse solver, which hung for the full 120s budget on
// hard layouts. Three compounding causes, all addressed here:
//
//   1. Candidate sets were Sets of strings rebuilt per slot per attempt from RAW CSV
//      ROWS (156,013 entries for 6,301 distinct 4-letter words) — ~33.5M string ops of
//      setup per attempt for the Classic layout, before placing anything. Now: domains
//      are bitset windows in one arena, and a restart is a 77 KB TypedArray.set().
//   2. saveState() deep-cloned all ~78 candidate Sets on every decision AND every
//      backtrack. Now: a trail records only the bits actually cleared.
//   3. Chronological backtracking enumerated all ~10,000 candidates of the deepest slot
//      when the real conflict was 10 levels up — literally "tries all the other words".
//      Now: conflict-directed backjumping goes straight to the culprit.
//
// Plus: a preflight pass that fails in milliseconds with an actionable reason instead of
// spinning (a hand-drawn 2-letter slot was a guaranteed 120s hang — the dictionary has
// zero 2-letter words), structural dedup so an answer can never repeat, and a seeded
// PRNG so daily puzzles are reproducible and failures replayable.

import { findSlots } from './crosswordUtils.js';
import { mulberry32, randInt } from './rng.js';
import {
  popcount32, ctz32, popcountRange, anyAnd,
  andCountCapped, nextSetBit, firstNonZeroWord, lastNonZeroWord,
} from './bitset.js';
import { addAdHocWord, resetAdHoc } from './wordIndex.js';

const MAXLEN = 15;
const A_CODE = 65;

// Tunables. Defaults chosen so a 15x15 fills in well under a second; see
// scripts/bench-solver.mjs for the measurements behind them.
const K_TOP = 48;              // best-by-quality candidates considered per node
const K_RAND = 16;             // extra random candidates, for variety across seeds
// With a difficulty target the pool has to be wider: candidates enter it by quality,
// so a narrow pool can simply contain nothing near the requested difficulty.
const K_TOP_TARGETED = 128;
const K_RAND_TARGETED = 64;
// Variety. Clicking Generate again used to hand back the same puzzle: the candidate pool
// was EXACTLY the first kTop set bits (the corpus is stored in descending quality order),
// so a fresh seed competed over an identical shortlist and MRV ordering walked it to the
// same fill. Two seeded knobs fix that:
//
//   VARIETY_WINDOW  draw kTop candidates at random from the best kTop*window of the
//                   domain. This is the strong lever, and the cheap one for quality:
//                   every candidate still comes from the top of the ranking, only WHICH
//                   of them compete changes per seed.
//   VARIETY_JITTER  +/- this many q units on each candidate's ranking score, so near-ties
//                   break differently per seed. q is dominated by the crossing-support
//                   term (0..4.2) rather than by quality (ALPHA_QUALITY * 0..1), so
//                   jitter here spends search guidance, not answer quality -- but it does
//                   spend guidance, so keep it small.
//
// Tuned on scripts/bench-variety.mjs; that file's header says what is measured.
const VARIETY_WINDOW = 2;
const VARIETY_JITTER = 0.05;
const SLOT_JITTER = 0.08;      // slot-order tie-break noise: path variety at no quality cost
// Variety costs search guidance, and on the most open layouts that guidance is exactly
// what the search needs (Open 15x15: p50 0.9s greedy against 4.5s with the window wide
// open). So it is spent where it is free: full strength while the fill is going in
// cleanly, then decayed as the search starts to thrash, which hands a layout that fights
// back the old greedy ordering instead of a ten-second fill. Decay keys off BACKTRACKS,
// not restarts -- a hard fill here blows its time inside a single run (Open 15x15 solves
// with 0 restarts and 200 backtracks), so a restart counter never fires at all.
const VARIETY_BACKTRACKS = 8;   // backtracks that halve the variety knobs
// ...and the point where variety is abandoned outright: the search restarts greedy, from
// clean dom-wdeg weights (see the bail-out itself). Needed because on a
// tight layout the damage is done by the FIRST few picks -- Open 15x15 fills in 9
// backtracks greedily and 200+ when an early slot takes a different (equally good) word,
// which is 5s of work -- so decaying variety after the fact cannot undo it. Bailing out
// early caps the wasted effort at a few hundred milliseconds. (Confining variety to the
// first quarter of the fill instead was measured and did nothing: the expensive choices
// ARE the early ones.)
//
// The budget is in work units -- backtracks x slots -- not backtracks, because what a
// backtrack costs scales with the grid: on Open 15x15 one costs ~25ms and 12 of them are
// the whole budget, while a 5x5 mini can take 90 and still finish in a tenth of a second.
// Measured on a flat 12-backtrack rule, minis lost variety (2 of 16 fills coincided) for
// no speed they needed.
const VARIETY_GIVEUP_WORK = 900;
// Penalty on an answer the caller asked to steer away from (`avoidWords`). Big enough to
// lose a near-tie, small enough that a clearly better word still wins, and never a hard
// exclusion -- so a grid with only one possible fill still fills.
const AVOID_PENALTY = 0.6;
const LOOKAHEAD_WORDS = 32;    // u32 words scanned when sizing a crossing domain
const LOOKAHEAD_CAP = 64;      // enough resolution for ordering; more is wasted work
// Skip an arc whose allowed-letter set is this wide: it prunes little for its cost.
// Sound because propagation is pure pruning -- and the arc that actually enforces
// cross-letter agreement is always the singleton one, which is never skipped.
// Tuned on the full sweep: 8 -> p95 55ms, 12 -> 41ms, 18 -> 31ms / max 107ms, 27 -> 80ms.
const REVISE_MAX_LETTERS = 18;
const LUBY_BASE = 200;         // backtracks per restart unit
const REQUIRED_RETRY_RESTARTS = 24; // restarts spent chasing every required word
// Weight of static word quality in value ordering. Exposed as `qualityWeight` so it can be
// swept; the sweep has been done and the answer was NO, so don't repeat it. Raising it
// 1.2 -> 4.5 over four layouts x three seeds barely moved the fill: answers with zipf < 2
// (IOWE, HTEN, IERE, OSEE — words that barely occur in English) went 23% -> 21%, mean
// answer score 27,145 -> 28,250, and p50 solve time got worse. Quality already separates
// junk cleanly (junk scores 5k-19k, good fill 30k-52k) — the problem is that a
// tightly-crossed slot often has only a handful of candidates, so the ranking has nothing
// better to promote. Improving that fill means a better word list or a kinder grid, not a
// bigger coefficient.
const ALPHA_QUALITY = 1.2;
const DEFAULT_BETA_DIFF = 6.0; // weight of difficulty-target matching

const ABORT = Symbol('abort');

function luby(i) {
  // 1,1,2,1,1,2,4,1,1,2,1,1,2,4,8,...
  let k = 1;
  while (k <= i + 1) {
    if (k === i + 1) return (k >>> 1) || 1;
    k <<= 1;
  }
  k >>>= 1;
  return luby(i + 1 - k);
}

function err(code, message, detail) {
  return { code, message, detail: detail || null };
}

const dirLabel = (d) => (d === 'across' ? 'Across' : 'Down');

/**
 * @param {Object} opts
 * @param {Object} opts.index        CorpusIndex from wordIndex.js
 * @param {string[][]|string[]} opts.layout
 * @param {number} [opts.seed]
 * @param {number} [opts.difficultyTarget] 0..1, or null to ignore difficulty
 */
export function solveCrossword(opts) {
  const {
    index,
    layout,
    presetGrid = null,
    requiredWordsList = [],
    requiredModeArg = 'anchor',
    timeoutMs = 10000,
    seed = 1,
    difficultyTarget = null,
    difficultyWeight = DEFAULT_BETA_DIFF,
    qualityWeight = ALPHA_QUALITY,
    // Answers to steer away from -- pass the previous fill's words so a Regenerate press
    // cannot hand back the same grid. A soft bias, never a constraint.
    avoidWords = [],
    varietyWindow = VARIETY_WINDOW,
    varietyJitter = VARIETY_JITTER,
    varietyBacktracks = VARIETY_BACKTRACKS,
    varietyGiveupWork = VARIETY_GIVEUP_WORK,
    slotJitter = SLOT_JITTER,
    onProgress = () => {},
    onBest = () => {},
    now = () => Date.now(),
    isCancelled = () => false,
  } = opts;

  const t0 = now();
  const rng = mulberry32(seed >>> 0);
  const stats = {
    nodes: 0, backtracks: 0, backjumps: 0, restarts: 0,
    propagations: 0, seed: seed >>> 0, ms: 0,
  };

  // ---- layout / topology -------------------------------------------------
  const rowsArr = (layout || []).map((r) => (Array.isArray(r) ? r : String(r).split('')));
  const rows = rowsArr.length;
  const cols = rows ? rowsArr[0].length : 0;

  const fail = (e) => ({
    grid: null, placements: [], complete: false, attempts: 0, requiredPlaced: 0,
    failedWord: null, failedSlot: null, difficultyScore: null, starvation: null,
    error: e, stats: { ...stats, ms: now() - t0 },
  });

  if (!rows || !cols) return fail(err('BAD_LAYOUT', 'The layout is empty.'));
  for (let r = 0; r < rows; r++) {
    if (rowsArr[r].length !== cols) {
      return fail(err('BAD_LAYOUT',
        `Layout row ${r + 1} has ${rowsArr[r].length} cells, expected ${cols}.`));
    }
  }

  const slots = findSlots(rowsArr);
  const S = slots.length;
  if (S === 0) {
    return fail(err('NO_SLOTS',
      'This layout has no word slots — every run of white cells is a single square.'));
  }

  // slotCellOf/crossSlot are strided by MAXLEN, so a longer run would write into the
  // NEXT slot's rows and silently corrupt the topology -- before preflight could reject
  // it. Unreachable with the shipped 15-wide layouts; reachable with a hand-drawn grid.
  for (const sl of slots) {
    if (sl.length > MAXLEN) {
      return fail(err('NO_WORDS_FOR_LENGTH',
        `This layout has a ${sl.length}-letter slot, longer than the ${MAXLEN}-letter maximum.`,
        { len: sl.length }));
    }
  }

  const CELLS = rows * cols;
  const cellIndex = (r, c) => r * cols + c;

  const slotLen = new Int32Array(S);
  const slotCellOf = new Int32Array(S * MAXLEN).fill(-1);
  const crossSlot = new Int32Array(S * MAXLEN).fill(-1);
  const crossPos = new Int32Array(S * MAXLEN).fill(-1);
  // At most two slots cross any cell (one across, one down).
  const cellSlot = new Int32Array(CELLS * 2).fill(-1);
  const cellSlotPos = new Int32Array(CELLS * 2).fill(-1);

  for (let s = 0; s < S; s++) {
    const sl = slots[s];
    slotLen[s] = sl.length;
    for (let i = 0; i < sl.length; i++) {
      const r = sl.direction === 'across' ? sl.row : sl.row + i;
      const c = sl.direction === 'across' ? sl.col + i : sl.col;
      const ci = cellIndex(r, c);
      slotCellOf[s * MAXLEN + i] = ci;
      const k = cellSlot[ci * 2] === -1 ? 0 : 1;
      cellSlot[ci * 2 + k] = s;
      cellSlotPos[ci * 2 + k] = i;
    }
  }
  for (let s = 0; s < S; s++) {
    for (let i = 0; i < slotLen[s]; i++) {
      const ci = slotCellOf[s * MAXLEN + i];
      const a = cellSlot[ci * 2];
      const b = cellSlot[ci * 2 + 1];
      const other = a === s ? b : a;
      crossSlot[s * MAXLEN + i] = other;
      if (other >= 0) {
        crossPos[s * MAXLEN + i] = cellSlot[ci * 2] === s ? cellSlotPos[ci * 2 + 1]
                                                          : cellSlotPos[ci * 2];
      }
    }
  }

  const clueNumbers = numberSlots(slots);
  const slotName = (s) => `${clueNumbers[s]}-${dirLabel(slots[s].direction)}`;

  // ---- ad-hoc words (required + fully-preset, off-dictionary) ------------
  const requiredWords = [...new Set(requiredWordsList.map((w) => String(w).toUpperCase().trim()))]
    .filter(Boolean);
  const requiredMode = requiredModeArg || 'anchor';

  resetAdHoc(index);
  const cleanup = () => resetAdHoc(index);

  for (const w of requiredWords) {
    if (!/^[A-Z]+$/.test(w) || w.length < 3 || w.length > MAXLEN) {
      cleanup();
      return fail(err('REQUIRED_WORD_UNKNOWN',
        `"${w}" can't be placed — required words must be 3–15 letters, A–Z only.`, { word: w }));
    }
    if (!index.byLen[w.length] || index.lookup[w.length]?.get(w) === undefined) {
      if (addAdHocWord(index, w) < 0) {
        cleanup();
        return fail(err('TOO_MANY_CUSTOM_WORDS',
          `At most 32 custom ${w.length}-letter words are supported per puzzle.`, { word: w }));
      }
    }
  }

  // Preset letters, and fully-preset slot strings that aren't in the dictionary.
  const presetCharAt = (r, c) => {
    const v = presetGrid && presetGrid[r] && presetGrid[r][c];
    return v && v !== '#' ? String(v).toUpperCase() : null;
  };
  const presetWordOfSlot = [];
  if (presetGrid) {
    for (let s = 0; s < S; s++) {
      let str = '';
      for (let i = 0; i < slotLen[s]; i++) {
        const ci = slotCellOf[s * MAXLEN + i];
        const ch = presetCharAt((ci / cols) | 0, ci % cols);
        if (!ch || !/^[A-Z]$/.test(ch)) { str = ''; break; }
        str += ch;
      }
      presetWordOfSlot[s] = str || null;
      if (str && index.lookup[str.length]?.get(str) === undefined) {
        if (addAdHocWord(index, str) < 0) {
          cleanup();
          return fail(err('TOO_MANY_CUSTOM_WORDS',
            `At most 32 custom ${str.length}-letter words are supported per puzzle.`,
            { word: str }));
        }
      }
    }
    // Two identical fully-preset entries can never both stand — answers must be distinct.
    const seen = new Map();
    for (let s = 0; s < S; s++) {
      const w = presetWordOfSlot[s];
      if (!w) continue;
      if (seen.has(w)) {
        cleanup();
        return fail(err('DUPLICATE_PRESET_WORD',
          `"${w}" appears twice in the grid (${slotName(seen.get(w))} and ${slotName(s)}).`,
          { word: w }));
      }
      seen.set(w, s);
    }
  }

  // ---- preflight: length availability ------------------------------------
  const slotsOfLength = new Map();
  for (let s = 0; s < S; s++) {
    slotsOfLength.set(slotLen[s], (slotsOfLength.get(slotLen[s]) || 0) + 1);
  }
  for (const [len, n] of slotsOfLength) {
    const li = index.byLen[len];
    const have = li ? li.count + li.extra : 0;
    if (have === 0) {
      cleanup();
      return fail(err('NO_WORDS_FOR_LENGTH',
        `This layout needs ${n} ${len}-letter ${n === 1 ? 'word' : 'words'}, but the word list has none.`,
        { len, need: n, have }));
    }
    if (have < n) {
      cleanup();
      return fail(err('INSUFFICIENT_WORDS_FOR_LENGTH',
        `This layout needs ${n} different ${len}-letter words but only ${have} ${have === 1 ? 'is' : 'are'} available — answers can't repeat.`,
        { len, need: n, have }));
    }
  }
  const reqByLen = new Map();
  for (const w of requiredWords) reqByLen.set(w.length, (reqByLen.get(w.length) || 0) + 1);
  for (const [len, k] of reqByLen) {
    const n = slotsOfLength.get(len) || 0;
    if (n === 0) {
      const w = requiredWords.find((x) => x.length === len);
      cleanup();
      return fail(err('REQUIRED_WORD_NO_SLOT',
        `"${w}" is ${len} letters, but this layout has no ${len}-letter slot.`, { word: w, len }));
    }
    if (k > n) {
      cleanup();
      return fail(err('REQUIRED_WORDS_OVERSUBSCRIBED',
        `${k} required words are ${len} letters, but there ${n === 1 ? 'is' : 'are'} only ${n} ${len}-letter ${n === 1 ? 'slot' : 'slots'}.`,
        { len, need: k, have: n }));
    }
  }
  if (timeoutMs <= 0) {
    cleanup();
    return fail(err('NO_TIME', 'Out of time budget before the search could start.'));
  }

  // ---- domain arena ------------------------------------------------------
  const domOff = new Int32Array(S);
  const domW = new Int32Array(S);
  let arenaWords = 0;
  for (let s = 0; s < S; s++) {
    domW[s] = index.byLen[slotLen[s]].W;
    domOff[s] = arenaWords;
    arenaWords += domW[s];
  }
  const domArena = new Uint32Array(arenaWords);
  const dom0 = new Uint32Array(arenaWords);
  const domCount = new Int32Array(S);
  const domCount0 = new Int32Array(S);
  const domFirst = new Int32Array(S);
  const domLast = new Int32Array(S);
  const domVersion = new Int32Array(S);
  let tick = 1;

  const cellMask = new Int32Array(CELLS);
  const cellMask0 = new Int32Array(CELLS);
  const cellLevel = new Int32Array(CELLS);
  const cellWeight = new Float32Array(CELLS).fill(1);

  const posCache = new Int32Array(S * MAXLEN);
  const posStamp = new Int32Array(S * MAXLEN).fill(-1);

  const assign = new Int32Array(S).fill(-1);
  const assignOrder = new Int32Array(S + 2).fill(-1);
  const assignVal = new Int32Array(S + 2).fill(-1);
  const countStamp = new Int32Array(S).fill(-1);
  const domLevel = new Int32Array(S);

  const CW = Math.ceil(S / 32) || 1;
  const conflict = new Uint32Array(S * CW);

  // Trail: three flat arrays, grown by doubling.
  let trailW = new Int32Array(1 << 16); let twTop = 0;
  let trailC = new Int32Array(1 << 12); let tcTop = 0;
  let trailM = new Int32Array(1 << 14); let tmTop = 0;
  const markW = new Int32Array(S + 2);
  const markC = new Int32Array(S + 2);
  const markM = new Int32Array(S + 2);

  const grow = (a, need) => {
    if (need <= a.length) return a;
    let n = a.length;
    while (n < need) n <<= 1;
    const b = new Int32Array(n);
    b.set(a);
    return b;
  };

  // Scratch, reused; never allocated in the hot path.
  const maxW = Math.max(...Array.from(domW));
  const scratch = new Uint32Array(maxW);
  const candBuf = new Int32Array(K_TOP_TARGETED + K_RAND_TARGETED);
  const valBuf = new Int32Array(K_TOP_TARGETED + K_RAND_TARGETED);
  const valQ = new Float64Array(K_TOP_TARGETED + K_RAND_TARGETED);
  const queue = new Int32Array(CELLS * 4);
  const inQueue = new Uint8Array(CELLS);

  let level = 0;
  let placedCount = 0;
  let placedDiffSum = 0;
  const valueStack = new Array(S + 2);
  const valueStackN = new Int32Array(S + 2);
  const valueStackI = new Int32Array(S + 2);

  // ---- clock -------------------------------------------------------------
  function checkClock() {
    if (isCancelled() || now() - t0 > timeoutMs) throw ABORT;
  }

  // ---- domain helpers ----------------------------------------------------
  function recomputeWindow(s) {
    const off = domOff[s];
    const f = firstNonZeroWord(domArena, off, 0, domW[s] - 1);
    if (f < 0) { domFirst[s] = 0; domLast[s] = -1; return; }
    domFirst[s] = f;
    domLast[s] = lastNonZeroWord(domArena, off, f, domW[s] - 1);
  }

  function noteCountChange(s) {
    if (countStamp[s] !== level) {
      countStamp[s] = level;
      trailC = grow(trailC, tcTop + 3);
      trailC[tcTop++] = s;
      trailC[tcTop++] = domCount[s];
      trailC[tcTop++] = domLevel[s];
    }
    // A domain can shrink without any of its cells' masks shrinking -- structural dedup
    // strikes a word from non-crossing slots, and reviseSlot often halves a domain while
    // lettersAt() stays the same 26-bit set. cellLevel therefore under-reports who is
    // responsible, and a backjump computed from it alone can skip the real culprit and
    // permanently prune a value that was never proven inconsistent.
    domLevel[s] = level;
  }

  /** dom[s] &= src, trailed. Returns bits removed. */
  function andIntoTrailed(s, src, sOff) {
    const off = domOff[s];
    const first = domFirst[s];
    const last = domLast[s];
    let removed = 0;
    for (let i = first; i <= last; i++) {
      const o = domArena[off + i];
      if (o === 0) continue;
      const n = o & src[sOff + i];
      if (n !== o) {
        if (removed === 0) noteCountChange(s);
        trailW = grow(trailW, twTop + 2);
        trailW[twTop++] = off + i;
        trailW[twTop++] = o;
        domArena[off + i] = n;
        removed += popcount32(o & ~n);
      }
    }
    if (removed > 0) {
      domCount[s] -= removed;
      domVersion[s] = ++tick;
      recomputeWindow(s);
    }
    return removed;
  }

  function removeValueTrailed(s, w) {
    const off = domOff[s] + (w >>> 5);
    const bit = 1 << (w & 31);
    const o = domArena[off];
    if ((o & bit) === 0) return false;
    noteCountChange(s);
    trailW = grow(trailW, twTop + 2);
    trailW[twTop++] = off;
    trailW[twTop++] = o;
    domArena[off] = o & ~bit;
    domCount[s] -= 1;
    domVersion[s] = ++tick;
    recomputeWindow(s);
    return true;
  }

  function narrowToSingleton(s, w) {
    const off = domOff[s];
    const kw = w >>> 5;
    const bit = 1 << (w & 31);
    let removed = 0;
    for (let i = domFirst[s]; i <= domLast[s]; i++) {
      const o = domArena[off + i];
      if (o === 0) continue;
      const n = i === kw ? (o & bit) : 0;
      if (n !== o) {
        if (removed === 0) noteCountChange(s);
        trailW = grow(trailW, twTop + 2);
        trailW[twTop++] = off + i;
        trailW[twTop++] = o;
        domArena[off + i] = n;
        removed += popcount32(o & ~n);
      }
    }
    if (removed > 0) {
      domCount[s] -= removed;
      domVersion[s] = ++tick;
      recomputeWindow(s);
    }
    return domCount[s] > 0;
  }

  function setCellMask(ci, nm) {
    const o = cellMask[ci];
    if (o === nm) return;
    trailM = grow(trailM, tmTop + 3);
    trailM[tmTop++] = ci;
    trailM[tmTop++] = o;
    trailM[tmTop++] = cellLevel[ci];
    cellMask[ci] = nm;
    cellLevel[ci] = level;
  }

  function undoToMark(mw, mc, mm) {
    for (let t = twTop - 2; t >= mw; t -= 2) domArena[trailW[t]] = trailW[t + 1];
    twTop = mw;
    for (let t = tcTop - 3; t >= mc; t -= 3) {
      const s = trailC[t];
      domCount[s] = trailC[t + 1];
      domLevel[s] = trailC[t + 2];
      recomputeWindow(s);
      // Bumped, never restored — this is what invalidates posCache for free.
      domVersion[s] = ++tick;
      countStamp[s] = -1;
    }
    tcTop = mc;
    for (let t = tmTop - 3; t >= mm; t -= 3) {
      cellMask[trailM[t]] = trailM[t + 1];
      cellLevel[trailM[t]] = trailM[t + 2];
    }
    tmTop = mm;
  }

  // ---- propagation -------------------------------------------------------

  /**
   * 26-bit mask of letters that can sit at position `i` of slot `s`, given its current
   * domain. Memoised on domVersion, and deliberately NOT masked by cellMask — that would
   * make the memo unsound.
   */
  function lettersAt(s, i) {
    const k = s * MAXLEN + i;
    if (posStamp[k] === domVersion[s]) return posCache[k];
    const li = index.byLen[slotLen[s]];
    const W = li.W;
    const off = domOff[s];
    const base = i * 26 * W;
    const first = domFirst[s];
    const last = domLast[s];
    let m = 0;
    let cand = li.posAlphabet[i];
    while (cand !== 0) {
      const l = ctz32(cand);
      cand &= cand - 1;
      if (anyAnd(domArena, off, li.byLetter, base + l * W, first, last)) m |= (1 << l);
    }
    posStamp[k] = domVersion[s];
    posCache[k] = m;
    return m;
  }

  const WIPEOUT = -1, NO_CHANGE = 0, CHANGED = 1;

  function reviseSlot(s, i, allowed) {
    if (allowed === 0) return WIPEOUT;
    const n = popcount32(allowed);
    // A near-full letter set prunes almost nothing; skipping the arc is sound because
    // propagation is optional pruning, never a source of solutions.
    if (n >= REVISE_MAX_LETTERS) return NO_CHANGE;
    const li = index.byLen[slotLen[s]];
    const W = li.W;
    const base = i * 26 * W;
    let removed;
    if (n === 1) {
      removed = andIntoTrailed(s, li.byLetter, base + ctz32(allowed) * W);
    } else {
      const first = domFirst[s];
      const last = domLast[s];
      if (last < first) return WIPEOUT;
      scratch.fill(0, first, last + 1);
      let cand = allowed;
      while (cand !== 0) {
        const l = ctz32(cand);
        cand &= cand - 1;
        const o = base + l * W;
        for (let w = first; w <= last; w++) scratch[w] |= li.byLetter[o + w];
      }
      removed = andIntoTrailed(s, scratch, 0);
    }
    if (domCount[s] === 0) return WIPEOUT;
    return removed > 0 ? CHANGED : NO_CHANGE;
  }

  const shuffledRequired = () => {
    const a = [...requiredList];
    for (let i = a.length - 1; i > 0; i--) {
      const j = randInt(rng, i + 1);
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  };

  let wipeoutSlot = -1;
  // Budget state lives here, not in solveOnce: almost all backtracking happens inside
  // handleFailure's recursion, which only ever bumped the global stat. The Luby restart
  // schedule -- and with it the carried-forward wdeg weights -- therefore never fired on
  // exactly the hard instances it exists for.
  let btCount = 0;
  let btBudget = Infinity;
  let needRestart = false;

  function propagate(seedSlot) {
    stats.propagations++;
    // `qh`/`qt` are call-locals but `inQueue` is not, and the three early returns below
    // (empty cell mask, revise wipeout, emptied cell) all abandon a non-empty queue.
    // Any flag left set makes that cell permanently un-pushable for the rest of the
    // restart, which silently disables the ONLY thing enforcing letter agreement between
    // two assigned slots -- producing grids whose entries are not words at all.
    // CELLS <= 225, so clearing up front is free.
    inQueue.fill(0);
    let qh = 0, qt = 0;
    const push = (ci) => {
      if (inQueue[ci]) return;
      inQueue[ci] = 1;
      queue[qt++ % queue.length] = ci;
    };
    for (let i = 0; i < slotLen[seedSlot]; i++) push(slotCellOf[seedSlot * MAXLEN + i]);

    let ops = 0;
    while (qh !== qt) {
      if ((++ops & 255) === 0) checkClock();
      const ci = queue[qh++ % queue.length];
      inQueue[ci] = 0;
      const m = cellMask[ci];
      if (m === 0) {
        wipeoutSlot = cellSlot[ci * 2] >= 0 ? cellSlot[ci * 2] : cellSlot[ci * 2 + 1];
        return false;
      }
      for (let k = 0; k < 2; k++) {
        const s = cellSlot[ci * 2 + k];
        if (s < 0 || assign[s] >= 0) continue;
        const r = reviseSlot(s, cellSlotPos[ci * 2 + k], m);
        if (r === WIPEOUT) { wipeoutSlot = s; return false; }
        if (r !== CHANGED) continue;
        // Push the slot's newly narrowed letter sets back onto its cells.
        for (let j = 0; j < slotLen[s]; j++) {
          const c2 = slotCellOf[s * MAXLEN + j];
          const nm = cellMask[c2] & lettersAt(s, j);
          if (nm !== cellMask[c2]) {
            setCellMask(c2, nm);
            if (nm === 0) { wipeoutSlot = s; return false; }
            push(c2);
          }
        }
      }
    }
    return true;
  }

  // ---- placement ---------------------------------------------------------
  function placeValue(s, w) {
    if (!narrowToSingleton(s, w)) { wipeoutSlot = s; return false; }
    assign[s] = w;
    placedCount++;
    const li = index.byLen[slotLen[s]];
    placedDiffSum += li.diff[w] / 255;

    // Structural dedup: strike this answer from every other unassigned slot of the same
    // length. Trailed, so it unwinds on backtrack. Because every placement path routes
    // through here — anchors and preset fills included — an answer cannot repeat.
    const kw = w >>> 5;
    const bit = 1 << (w & 31);
    for (let t = 0; t < S; t++) {
      if (t === s || assign[t] >= 0 || slotLen[t] !== slotLen[s]) continue;
      const off = domOff[t] + kw;
      const o = domArena[off];
      if ((o & bit) === 0) continue;
      noteCountChange(t);
      trailW = grow(trailW, twTop + 2);
      trailW[twTop++] = off;
      trailW[twTop++] = o;
      domArena[off] = o & ~bit;
      domCount[t] -= 1;
      domVersion[t] = ++tick;
      recomputeWindow(t);
      if (domCount[t] === 0) { wipeoutSlot = t; return false; }
    }

    for (let i = 0; i < slotLen[s]; i++) {
      setCellMask(slotCellOf[s * MAXLEN + i], 1 << li.letters[w * slotLen[s] + i]);
    }
    return propagate(s);
  }

  function unassign(s) {
    if (assign[s] < 0) return;
    const li = index.byLen[slotLen[s]];
    placedDiffSum -= li.diff[assign[s]] / 255;
    assign[s] = -1;
    placedCount--;
  }

  // ---- ordering ----------------------------------------------------------
  const requiredIdx = new Map(); // len -> Set(wordIdx)
  for (const w of requiredWords) {
    const i = index.lookup[w.length]?.get(w);
    if (i === undefined) continue;
    let set = requiredIdx.get(w.length);
    if (!set) requiredIdx.set(w.length, (set = new Set()));
    set.add(i);
  }
  // Soft "different from last time" bias, resolved to per-length word indices once so the
  // hot path is a Set.has on an integer.
  const avoidIdx = new Map();
  for (const raw of (avoidWords || [])) {
    const w = String(raw || '').toUpperCase().trim();
    if (!w) continue;
    const wi = index.lookup[w.length]?.get(w);
    if (wi === undefined) continue;
    let set = avoidIdx.get(w.length);
    if (!set) avoidIdx.set(w.length, (set = new Set()));
    set.add(wi);
  }

  const requiredList = requiredWords
    .map((w) => ({ word: w, len: w.length, idx: index.lookup[w.length]?.get(w) }))
    .filter((r) => r.idx !== undefined);
  // Keyed by length AND index: word indices are per-length, so a bare index would let
  // the 4-letter word #5 mark the 6-letter word #5 as already used.
  const usedRequired = new Set();
  const reqKey = (len, wi) => len * 1000000 + wi;

  function slotHasRequired(s) {
    const set = requiredIdx.get(slotLen[s]);
    if (!set) return false;
    const off = domOff[s];
    for (const wi of set) {
      if (usedRequired.has(reqKey(slotLen[s], wi))) continue;
      if ((domArena[off + (wi >>> 5)] & (1 << (wi & 31))) !== 0) return true;
    }
    return false;
  }

  function residualDiffTarget() {
    if (difficultyTarget == null) return null;
    const remaining = S - placedCount;
    if (remaining <= 0) return difficultyTarget;
    const want = difficultyTarget * S - placedDiffSum;
    return Math.max(0, Math.min(1, want / remaining));
  }

  function selectSlot() {
    let best = -1;
    let bestScore = Infinity;
    let bestCross = -1;
    for (let s = 0; s < S; s++) {
      if (assign[s] >= 0) continue;
      if (domCount[s] === 0) return s; // wipeout — caller handles
      let w = 0;
      let nCross = 0;
      for (let i = 0; i < slotLen[s]; i++) {
        const t = crossSlot[s * MAXLEN + i];
        if (t >= 0 && assign[t] < 0) {
          w += cellWeight[slotCellOf[s * MAXLEN + i]];
          nCross++;
        }
      }
      if (w < 1) w = 1;
      let sc = domCount[s] / w;
      if (requiredMode !== 'off' && slotHasRequired(s)) {
        sc *= requiredMode === 'anchor' ? 0.001 : 0.05;
      }
      sc *= 1 + slotJitter * rng();
      if (sc < bestScore || (sc === bestScore && nCross > bestCross)) {
        bestScore = sc; best = s; bestCross = nCross;
      }
    }
    return best;
  }

  let varietyActive = true;
  const varietyGiveup = Math.max(6, Math.round(varietyGiveupWork / S));
  const varietyScale = () => (varietyActive
    ? 1 / (1 + stats.backtracks / varietyBacktracks + stats.restarts)
    : 0);

  /**
   * A uniformly random value from dom[s], by RANK. Selecting a rank used to mean walking
   * set bits one at a time -- up to ~12,000 nextSetBit calls per sample, per node; this
   * skips whole 32-bit words by popcount, so it is O(W) with the same distribution.
   */
  function randomValue(s) {
    const off = domOff[s];
    let target = randInt(rng, domCount[s]);
    for (let i = domFirst[s]; i <= domLast[s]; i++) {
      const wv = domArena[off + i];
      if (wv === 0) continue;
      const c = popcount32(wv);
      if (target < c) {
        let v = wv;
        for (let k = 0; k < target; k++) v &= v - 1;
        return (i << 5) + ctz32(v);
      }
      target -= c;
    }
    return -1;
  }

  function orderValues(s) {
    const li = index.byLen[slotLen[s]];
    const off = domOff[s];
    const W = li.W;
    const len = slotLen[s];

    let nc = 0;

    // Required words first, unconditionally. They can sit anywhere in the index — and
    // ad-hoc (off-dictionary) words are appended at the very END — so the top-K scan
    // below would never reach them.
    const reqHere = requiredIdx.get(len);
    if (reqHere) {
      for (const wi of reqHere) {
        if (usedRequired.has(reqKey(len, wi))) continue;
        if ((domArena[off + (wi >>> 5)] & (1 << (wi & 31))) !== 0) {
          candBuf[nc++] = wi;
          if (nc >= candBuf.length) break;
        }
      }
    }

    const nReq = nc;

    // Indices are stored in descending quality order, so the best candidates are simply
    // the first set bits — an O(K) scan instead of ranking the whole domain. Taking
    // exactly the first kTop of them is what made every seed converge on one fill, so
    // reservoir-sample kTop out of the first kTop*varietyWindow instead: uniform over a
    // window that is still entirely the top of the ranking.
    const kTop = difficultyTarget == null ? K_TOP : K_TOP_TARGETED;
    const capTop = Math.min(kTop, candBuf.length - nReq);
    const vs = varietyScale();
    const windowN = Math.max(capTop, Math.round(capTop * (1 + (varietyWindow - 1) * vs)));
    let nStream = 0;                     // how many candidates the window has offered
    let b = nextSetBit(domArena, off, W, 0);
    while (b >= 0 && nStream < windowN) {
      let dup = false;
      for (let j = 0; j < nReq; j++) if (candBuf[j] === b) { dup = true; break; }
      if (!dup) {
        if (nc - nReq < capTop) candBuf[nc++] = b;
        else {
          // Algorithm R: the item at stream position nStream survives with probability
          // capTop/(nStream+1), which makes the kept set uniform over the window.
          const j = randInt(rng, nStream + 1);
          if (j < capTop) candBuf[nReq + j] = b;
        }
        nStream++;
      }
      b = nextSetBit(domArena, off, W, b + 1);
    }
    const total = domCount[s];
    if (total > nc) {
      const kRand = difficultyTarget == null ? K_RAND : K_RAND_TARGETED;
      for (let k = 0; k < kRand && nc < candBuf.length; k++) {
        const hit = randomValue(s);
        if (hit < 0) break;
        let dup = false;
        for (let j = 0; j < nc; j++) if (candBuf[j] === hit) { dup = true; break; }
        if (!dup) candBuf[nc++] = hit;
      }
    }

    const target = residualDiffTarget();
    const reqSet = requiredIdx.get(len);
    const avoidSet = avoidIdx.get(len);
    const jitter = varietyJitter * vs;
    let n = 0;
    for (let ci = 0; ci < nc; ci++) {
      if ((ci & 63) === 63) checkClock();
      const w = candBuf[ci];
      let supp = 0;
      let nSupp = 0;
      let ok = true;
      for (let i = 0; i < len; i++) {
        const t = crossSlot[s * MAXLEN + i];
        if (t < 0 || assign[t] >= 0) continue;
        const l = li.letters[w * len + i];
        const lt = index.byLen[slotLen[t]];
        const row = (crossPos[s * MAXLEN + i] * 26 + l) * lt.W;
        const c = andCountCapped(domArena, domOff[t], lt.byLetter, row,
                                 domFirst[t], domLast[t], LOOKAHEAD_WORDS, LOOKAHEAD_CAP);
        if (c === 0) { ok = false; break; } // would wipe a crossing slot
        supp += Math.log1p(c);
        nSupp++;
      }
      if (!ok) { removeValueTrailed(s, w); continue; }
      // Average, not sum. Summing over up to 15 crossings reaches ~60, which dwarfed
      // both the quality and difficulty terms -- difficulty was effectively ignored, and
      // asking for "easy" moved the finished puzzle's rating by about two points.
      const suppAvg = nSupp ? supp / nSupp : Math.log1p(LOOKAHEAD_CAP);
      let q = suppAvg + qualityWeight * (li.score[w] / 65535);
      if (jitter > 0) q += jitter * (rng() * 2 - 1);
      if (avoidSet !== undefined && avoidSet.has(w)) q -= AVOID_PENALTY;
      if (reqSet && reqSet.has(w) && !usedRequired.has(reqKey(len, w))) q += 1000;
      if (target != null) q -= difficultyWeight * Math.abs(li.diff[w] / 255 - target);
      // insertion sort, descending
      let j = n++;
      while (j > 0 && valQ[j - 1] < q) { valQ[j] = valQ[j - 1]; valBuf[j] = valBuf[j - 1]; j--; }
      valQ[j] = q; valBuf[j] = w;
    }
    return n;
  }

  // ---- failure handling --------------------------------------------------
  function conflictAdd(dst, src) {
    const a = dst * CW, b = src * CW;
    for (let i = 0; i < CW; i++) conflict[a + i] |= conflict[b + i];
  }
  const conflictSet = (s, other) => { conflict[s * CW + (other >>> 5)] |= 1 << (other & 31); };
  const conflictClear = (s) => { for (let i = 0; i < CW; i++) conflict[s * CW + i] = 0; };
  function conflictMaxLevel(s) {
    let m = 0;
    for (let i = 0; i < CW; i++) {
      let v = conflict[s * CW + i];
      while (v !== 0) {
        const b = (i << 5) + ctz32(v);
        v &= v - 1;
        for (let lv = 1; lv <= level; lv++) if (assignOrder[lv] === b && lv > m) m = lv;
      }
    }
    return m;
  }

  // Which slot LENGTHS the search actually starved on, counted at the one place every
  // dead end routes through. On a big grid this is the difference between "it failed"
  // and "every 9-letter slot ran dry" — see the starvation report assembled at the end.
  const starveEvents = new Int32Array(MAXLEN + 1);

  /** @returns {boolean} false when this restart is exhausted. */
  function handleFailure(t) {
    if (t < 0) return false;
    starveEvents[slotLen[t]]++;
    for (let i = 0; i < slotLen[t]; i++) cellWeight[slotCellOf[t * MAXLEN + i]] += 1;

    let jump = 0;
    for (let i = 0; i < slotLen[t]; i++) {
      const lv = cellLevel[slotCellOf[t * MAXLEN + i]];
      if (lv > jump) jump = lv;
    }
    const cj = conflictMaxLevel(t);
    if (cj > jump) jump = cj;
    if (domLevel[t] > jump) jump = domLevel[t];
    if (jump <= 0 || jump > level) return false;

    if (jump < level) stats.backjumps++;
    while (level > jump) {
      undoToMark(markW[level], markC[level], markM[level]);
      const s = assignOrder[level];
      if (s >= 0) {
        if (assign[s] >= 0) usedRequired.delete(reqKey(slotLen[s], assign[s]));
        unassign(s);
      }
      valueStack[level] = null;
      level--;
    }

    const d = assignOrder[jump];
    if (d < 0) return false;
    conflictAdd(d, t);
    for (let i = 0; i < slotLen[t]; i++) {
      const ci = slotCellOf[t * MAXLEN + i];
      for (let k = 0; k < 2; k++) {
        const o = cellSlot[ci * 2 + k];
        if (o >= 0 && o !== d && assign[o] >= 0) conflictSet(d, o);
      }
    }
    conflict[d * CW + (d >>> 5)] &= ~(1 << (d & 31));

    // Undo the failed decision at `jump` and try its next alternative.
    undoToMark(markW[jump], markC[jump], markM[jump]);
    if (assign[d] >= 0) { usedRequired.delete(reqKey(slotLen[d], assign[d])); unassign(d); }
    removeValueTrailed(d, assignVal[jump]);

    const vals = valueStack[jump];
    let next = -1;
    while (valueStackI[jump] < valueStackN[jump]) {
      const cand = vals[valueStackI[jump]++];
      if ((domArena[domOff[d] + (cand >>> 5)] & (1 << (cand & 31))) !== 0) { next = cand; break; }
    }
    if (next < 0) {
      level = jump;
      const lower = jump - 1;
      if (lower <= 0) return false;
      level = jump;
      return handleFailureAt(d, jump);
    }
    assignVal[jump] = next;
    level = jump;
    if (!placeValue(d, next)) {
      stats.backtracks++;
      if (++btCount > btBudget) { needRestart = true; return false; }
      return handleFailure(wipeoutSlot);
    }
    if (requiredIdx.get(slotLen[d])?.has(next)) usedRequired.add(reqKey(slotLen[d], next));
    return true;
  }

  /** All values at `lv` are exhausted — propagate the failure one level further up. */
  function handleFailureAt(d, lv) {
    undoToMark(markW[lv], markC[lv], markM[lv]);
    if (assign[d] >= 0) { usedRequired.delete(reqKey(slotLen[d], assign[d])); unassign(d); }
    valueStack[lv] = null;
    level = lv - 1;
    if (level <= 0) return false;
    const parent = assignOrder[level];
    if (parent < 0) return false;
    conflictAdd(parent, d);
    conflictClear(d);
    return handleFailure(parent);
  }

  // ---- initial arc consistency ------------------------------------------
  function initialise() {
    domArena.fill(0);
    for (let s = 0; s < S; s++) {
      const li = index.byLen[slotLen[s]];
      domArena.set(li.all, domOff[s]);
      domCount[s] = popcountRange(domArena, domOff[s], domW[s]);
      recomputeWindow(s);
      domVersion[s] = ++tick;
    }
    for (let ci = 0; ci < CELLS; ci++) {
      cellMask[ci] = cellSlot[ci * 2] >= 0 ? 0x3ffffff : 0;
      cellLevel[ci] = 0;
    }
    // Preset letters pin their cells; the AC pass below turns fully-preset slots into
    // singletons on its own, so no special-case pre-placement loop is needed.
    if (presetGrid) {
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const ch = presetCharAt(r, c);
          if (!ch || !/^[A-Z]$/.test(ch)) continue;
          const ci = cellIndex(r, c);
          if (cellSlot[ci * 2] < 0) continue;
          cellMask[ci] = 1 << (ch.charCodeAt(0) - A_CODE);
        }
      }
    }
  }

  function initialAC() {
    // Run every slot's letter sets into its cells, then fixpoint.
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 64) {
      changed = false;
      for (let s = 0; s < S; s++) {
        checkClock();
        for (let i = 0; i < slotLen[s]; i++) {
          const ci = slotCellOf[s * MAXLEN + i];
          const nm = cellMask[ci] & lettersAt(s, i);
          if (nm !== cellMask[ci]) {
            cellMask[ci] = nm;
            changed = true;
            if (nm === 0) return { ok: false, cell: ci, slot: s };
          }
        }
      }
      for (let s = 0; s < S; s++) {
        for (let i = 0; i < slotLen[s]; i++) {
          const r = reviseSlot(s, i, cellMask[slotCellOf[s * MAXLEN + i]]);
          if (r === WIPEOUT) return { ok: false, slot: s, cell: -1 };
          if (r === CHANGED) changed = true;
        }
      }
    }
    return { ok: true };
  }

  function patternOf(s) {
    let out = '';
    for (let i = 0; i < slotLen[s]; i++) {
      const m = cellMask[slotCellOf[s * MAXLEN + i]];
      out += popcount32(m) === 1 ? String.fromCharCode(A_CODE + ctz32(m)) : '_';
    }
    return out;
  }

  // ---- failure diagnosis -------------------------------------------------
  // "It failed" is not actionable. What a caller can act on is WHICH slot lengths ran out
  // of answers and how many the word list really offers at those lengths ONCE THE
  // CROSSING LETTERS ARE APPLIED — the number that collapses from "8,031 eight-letter
  // answers" to "none that start B-L-_-_-Z". Both numbers are reported.

  /** Answers of slot `s`'s length still consistent with the letters standing in `g`. */
  function candidatesForSlot(s, g, usedIdx) {
    const len = slotLen[s];
    const li = index.byLen[len];
    if (!li) return 0;
    const W = li.W;
    for (let i = 0; i < W; i++) scratch[i] = li.all[i];
    for (let i = 0; i < len; i++) {
      const ci = slotCellOf[s * MAXLEN + i];
      const ch = g?.[(ci / cols) | 0]?.[ci % cols];
      if (!ch || ch === '#' || ch.length !== 1) continue;
      const l = ch.charCodeAt(0) - A_CODE;
      if (l < 0 || l > 25) continue;
      const row = (i * 26 + l) * W;
      for (let w = 0; w < W; w++) scratch[w] &= li.byLetter[row + w];
    }
    let n = 0;
    for (let w = 0; w < W; w++) n += popcount32(scratch[w]);
    // Answers can't repeat, so one already standing in the grid is not available here.
    if (usedIdx) {
      for (const wi of usedIdx) {
        if ((scratch[wi >>> 5] & (1 << (wi & 31))) !== 0) n--;
      }
    }
    return n < 0 ? 0 : n;
  }

  function diagnoseStarvation(g, placed) {
    const usedByLen = new Map();
    for (const p of placed) {
      const L = p.word.length;
      let set = usedByLen.get(L);
      if (!set) usedByLen.set(L, (set = new Set()));
      set.add(p.wordIndex);
    }
    const placedIds = new Set(placed.map((p) => p.slot.id));
    const byLen = new Map();
    for (let s = 0; s < S; s++) {
      const L = slotLen[s];
      let e = byLen.get(L);
      if (!e) {
        const li = index.byLen[L];
        byLen.set(L, (e = {
          len: L, slots: 0, filled: 0, unfilled: 0, starved: 0,
          corpus: li ? li.count + li.extra : 0,
          deadEnds: starveEvents[L] || 0,
          _cand: [],
        }));
      }
      e.slots++;
      if (placedIds.has(slots[s].id)) { e.filled++; continue; }
      e.unfilled++;
      const n = candidatesForSlot(s, g, usedByLen.get(L));
      e._cand.push(n);
      if (n === 0) e.starved++;
    }
    const rows = [...byLen.values()].sort((a, b) => a.len - b.len).map((e) => {
      const c = e._cand.sort((a, b) => a - b);
      delete e._cand;
      return {
        ...e,
        minCandidates: c.length ? c[0] : null,
        medianCandidates: c.length ? c[c.length >> 1] : null,
        maxCandidates: c.length ? c[c.length - 1] : null,
      };
    });
    const worst = rows.filter((r) => r.starved > 0)
      .sort((a, b) => b.starved - a.starved || a.len - b.len);
    const phrase = (r) => `${r.starved} slot${r.starved === 1 ? '' : 's'} of length ${r.len} `
      + `(${r.medianCandidates.toLocaleString()} candidate${r.medianCandidates === 1 ? '' : 's'} left after crossings; `
      + `the word list has ${r.corpus.toLocaleString()} ${r.len}-letter answers)`;
    // A timeout usually stops with a SPARSE best grid, where almost nothing has starved
    // yet — the honest account there is where the search kept dying, not where the best
    // partial happens to be tight. Both are reported; the summary picks whichever
    // actually describes this failure.
    const thrash = rows.filter((r) => r.deadEnds > 0)
      .sort((a, b) => b.deadEnds - a.deadEnds || a.len - b.len);
    const thrashPhrase = (r) => `length ${r.len} (${r.deadEnds.toLocaleString()} dead ends; `
      + `${r.medianCandidates.toLocaleString()} of the word list's ${r.corpus.toLocaleString()} `
      + `${r.len}-letter answers still fit the crossings)`;
    let summary = null;
    if (worst.length) {
      summary = `Ran out of answers for ${worst.slice(0, 3).map(phrase).join(', ')}`
        + (worst.length > 3 ? `, and ${worst.length - 3} more lengths` : '') + '.';
    } else if (thrash.length) {
      summary = `The search kept dead-ending on ${thrash.slice(0, 2).map(thrashPhrase).join(' and ')}.`;
    }
    return {
      filledSlots: placed.length,
      totalSlots: S,
      byLength: rows,
      worstLengths: worst.map((r) => r.len),
      deadEndLengths: thrash.map((r) => r.len),
      summary,
    };
  }

  // ---- best-partial tracking --------------------------------------------
  let bestPlaced = -1;
  let bestSnapshot = null;

  function snapshotGrid() {
    const g = [];
    for (let r = 0; r < rows; r++) {
      const row = [];
      for (let c = 0; c < cols; c++) {
        if (rowsArr[r][c] === '#') { row.push('#'); continue; }
        const m = cellMask[cellIndex(r, c)];
        row.push(popcount32(m) === 1 ? String.fromCharCode(A_CODE + ctz32(m)) : null);
      }
      g.push(row);
    }
    return g;
  }

  function collectPlacements() {
    const out = [];
    for (let s = 0; s < S; s++) {
      if (assign[s] < 0) continue;
      const li = index.byLen[slotLen[s]];
      out.push({ slot: slots[s], word: li.words[assign[s]], wordIndex: assign[s], clue: '' });
    }
    return out;
  }

  function recordBest() {
    if (placedCount <= bestPlaced) return;
    bestPlaced = placedCount;
    bestSnapshot = { grid: snapshotGrid(), placements: collectPlacements() };
    onBest({
      grid: bestSnapshot.grid,
      placements: bestSnapshot.placements,
      requiredPlaced: usedRequired.size,
      attempts: stats.restarts + 1,
      complete: false,
      failedWord: null,
    });
  }

  // ---- one search run ----------------------------------------------------
  function solveOnce(budget) {
    domArena.set(dom0);
    domCount.set(domCount0);
    cellMask.set(cellMask0);
    for (let s = 0; s < S; s++) { recomputeWindow(s); domVersion[s] = ++tick; countStamp[s] = -1; }
    for (let ci = 0; ci < CELLS; ci++) cellLevel[ci] = 0;
    assign.fill(-1);
    conflict.fill(0);
    usedRequired.clear();
    inQueue.fill(0);
    placedCount = 0;
    placedDiffSum = 0;
    level = 0;
    twTop = tcTop = tmTop = 0;
    domLevel.fill(0);
    btCount = 0;
    btBudget = budget;
    needRestart = false;
    let backtracks = 0;

    // Anchor the required words as real decisions before the free search starts.
    // Nudging slot selection and value ordering (the 0.001 multiplier and the +1000
    // bonus) is not enough on its own: the search can still finish a valid grid that
    // simply never used one of them. Placing them first makes them part of the problem
    // rather than a preference, and because these are ordinary trailed decisions the
    // search can still backjump through them if they turn out to be unsatisfiable.
    if (requiredMode === 'anchor' && requiredList.length) {
      for (const req of shuffledRequired()) {
        if (usedRequired.has(reqKey(req.len, req.idx))) continue;
        // Most-constrained slot that can still take it, so the tightest corner is
        // committed while the rest of the grid is still open.
        let bestSlot = -1;
        let bestCount = Infinity;
        for (let t = 0; t < S; t++) {
          if (assign[t] >= 0 || slotLen[t] !== req.len) continue;
          if ((domArena[domOff[t] + (req.idx >>> 5)] & (1 << (req.idx & 31))) === 0) continue;
          if (domCount[t] < bestCount) { bestCount = domCount[t]; bestSlot = t; }
        }
        if (bestSlot < 0) continue;
        level++;
        markW[level] = twTop; markC[level] = tcTop; markM[level] = tmTop;
        assignOrder[level] = bestSlot;
        assignVal[level] = req.idx;
        valueStack[level] = Int32Array.of(req.idx);
        valueStackN[level] = 1;
        valueStackI[level] = 1;
        conflictClear(bestSlot);
        if (placeValue(bestSlot, req.idx)) {
          usedRequired.add(reqKey(req.len, req.idx));
        } else {
          // Undo and leave it to value ordering; a later restart will try another slot.
          undoToMark(markW[level], markC[level], markM[level]);
          unassign(bestSlot);
          valueStack[level] = null;
          level--;
        }
      }
    }

    for (;;) {
      checkClock();
      stats.nodes++;
      // Variety is a first-attempt luxury. Once the search is thrashing, drop it and
      // restart greedy rather than pay for a diverse fill in seconds.
      if (varietyActive && stats.backtracks > varietyGiveup) {
        varietyActive = false;
        // Drop the dom-wdeg weights too. They were learned about a search that is being
        // abandoned, and carrying them into the greedy retry mis-orders its slots -- the
        // measured difference between a ~1s fallback fill and a 10s timeout.
        cellWeight.fill(1);
        return 'RESTART';
      }
      if (placedCount === S) {
        // A full grid that quietly dropped one of the user's required words is not a
        // success -- "required" has to mean required. Anchoring re-shuffles its order
        // each restart, so retrying is productive rather than a rerun of the same
        // search. Bounded so a near-impossible request still returns its best grid
        // instead of burning the whole budget.
        if (requiredMode === 'anchor'
            && usedRequired.size < requiredList.length
            && stats.restarts < REQUIRED_RETRY_RESTARTS
            && now() - t0 < timeoutMs * 0.6) {
          needRestart = true;
          return 'RESTART';
        }
        return 'SOLVED';
      }

      if ((stats.nodes & 511) === 0) {
        onProgress(`${placedCount}/${S} filled · ${stats.backtracks} backtracks · `
          + `${stats.restarts} restarts · ${((now() - t0) / 1000).toFixed(1)}s`);
      }

      const s = selectSlot();
      if (s < 0) return 'SOLVED';
      if (domCount[s] === 0) {
        stats.backtracks++;
        if (++backtracks > budget) return 'RESTART';
        if (!handleFailure(s)) return needRestart ? 'RESTART' : 'EXHAUSTED';
        continue;
      }

      level++;
      markW[level] = twTop; markC[level] = tcTop; markM[level] = tmTop;
      assignOrder[level] = s;
      conflictClear(s);

      const n = orderValues(s);
      if (n === 0) {
        level--;
        stats.backtracks++;
        if (++backtracks > budget) return 'RESTART';
        if (!handleFailure(s)) return needRestart ? 'RESTART' : 'EXHAUSTED';
        continue;
      }
      valueStack[level] = Int32Array.from(valBuf.subarray(0, n));
      valueStackN[level] = n;
      valueStackI[level] = 1;
      assignVal[level] = valBuf[0];

      if (!placeValue(s, valBuf[0])) {
        stats.backtracks++;
        if (++backtracks > budget) return 'RESTART';
        if (!handleFailure(wipeoutSlot)) return needRestart ? 'RESTART' : 'EXHAUSTED';
      } else {
        if (requiredIdx.get(slotLen[s])?.has(valBuf[0])) usedRequired.add(reqKey(slotLen[s], valBuf[0]));
        if (placedCount > bestPlaced) recordBest();
      }
    }
  }

  // ---- drive -------------------------------------------------------------
  let outcome = 'EXHAUSTED';
  let preflightError = null;

  try {
    initialise();
    const ac = initialAC();
    if (!ac.ok) {
      if (ac.cell >= 0) {
        const r = (ac.cell / cols) | 0;
        const c = ac.cell % cols;
        const a = cellSlot[ac.cell * 2];
        const b = cellSlot[ac.cell * 2 + 1];
        const names = [a, b].filter((x) => x >= 0).map(slotName).join(' and ');
        preflightError = err('CELL_NO_LETTER',
          `No letter works for both ${names} at row ${r + 1}, column ${c + 1}.`,
          { row: r, col: c });
      } else {
        preflightError = err('SLOT_EMPTY_AFTER_AC',
          `${slotName(ac.slot)} (${slotLen[ac.slot]} letters) has no possible answer given the crossing letters "${patternOf(ac.slot)}".`,
          { slot: ac.slot });
      }
    }

    if (!preflightError) {
      // Preset letter that no word of that length can carry — a clearer message than a
      // generic empty-domain failure.
      for (let s = 0; s < S && !preflightError; s++) {
        if (domCount[s] !== 0) continue;
        preflightError = err('SLOT_EMPTY_AFTER_AC',
          `${slotName(s)} (${slotLen[s]} letters) has no possible answer given the crossing letters "${patternOf(s)}".`,
          { slot: s });
      }
    }

    if (!preflightError) {
      for (const w of requiredWords) {
        const wi = index.lookup[w.length]?.get(w);
        let placeable = false;
        if (wi !== undefined) {
          for (let s = 0; s < S; s++) {
            if (slotLen[s] !== w.length) continue;
            if ((domArena[domOff[s] + (wi >>> 5)] & (1 << (wi & 31))) !== 0) { placeable = true; break; }
          }
        }
        if (!placeable) {
          preflightError = err('REQUIRED_WORD_UNPLACEABLE',
            `"${w}" doesn't fit any ${w.length}-letter slot with the current letters in the grid.`,
            { word: w });
          break;
        }
      }
    }

    if (!preflightError) {
      dom0.set(domArena);
      domCount0.set(domCount);
      cellMask0.set(cellMask);

      for (let run = 0; ; run++) {
        checkClock();
        if (run > 0) stats.restarts++;
        outcome = solveOnce(LUBY_BASE * luby(run));
        if (outcome === 'SOLVED') break;
        if (outcome === 'EXHAUSTED' && run > 0) break;
        if (now() - t0 > timeoutMs) break;
      }
    }
  } catch (e) {
    if (e !== ABORT) { cleanup(); throw e; }
    outcome = 'ABORTED';
  }

  stats.ms = now() - t0;

  if (preflightError) {
    cleanup();
    return {
      grid: null, placements: [], complete: false, attempts: 0, requiredPlaced: 0,
      failedWord: null, failedSlot: preflightError.detail?.slot ?? null,
      difficultyScore: null, starvation: null, error: preflightError, stats,
    };
  }

  const complete = outcome === 'SOLVED' && placedCount === S;
  const placements = complete ? collectPlacements() : (bestSnapshot?.placements || []);
  const grid = complete ? snapshotGrid() : (bestSnapshot?.grid || snapshotGrid());

  // Puzzle difficulty is not the mean of its answers. A solver's experience is dominated
  // by the hardest fifth, and worst of all by two hard entries CROSSING each other --
  // that is where a puzzle stops being solvable rather than merely slow. A flat average
  // (what this used to be) rates a grid with four brutal crossings the same as one with
  // four brutal entries scattered safely apart.
  let difficultyScore = null;
  let difficultyMean = null;
  if (placements.length) {
    const diffOf = new Map();
    const vals = [];
    for (const p of placements) {
      const d = index.byLen[p.word.length].diff[p.wordIndex] / 255;
      diffOf.set(p.slot.id, d);
      vals.push(d);
    }
    vals.sort((a, b) => a - b);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const p80 = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.8))];

    let worstCross = 0;
    for (let s = 0; s < S; s++) {
      const ds = diffOf.get(slots[s].id);
      if (ds === undefined) continue;
      for (let i = 0; i < slotLen[s]; i++) {
        const t = crossSlot[s * MAXLEN + i];
        if (t < 0) continue;
        const dt = diffOf.get(slots[t].id);
        if (dt === undefined) continue;
        const pair = Math.min(ds, dt); // both must be hard for the crossing to be unfair
        if (pair > worstCross) worstCross = pair;
      }
    }
    difficultyScore = (0.5 * mean + 0.3 * p80 + 0.2 * worstCross) * 100;
    // Also report the plain mean. The composite above is the better description of how a
    // puzzle FEELS, but it is not comparable to a per-answer difficulty distribution --
    // being a blend of mean, p80 and worst crossing it always sits above the mean, so
    // ranking it against per-answer quantiles reads every puzzle as harder than it is.
    difficultyMean = mean * 100;
  }

  let failedSlot = null;
  if (!complete) {
    let worst = -1;
    for (let s = 0; s < S; s++) {
      if (assign[s] < 0 && (worst < 0 || domCount[s] < domCount[worst])) worst = s;
    }
    failedSlot = worst >= 0 ? worst : null;
  }

  // A failed fill carries its diagnosis: the slot lengths that starved, and how many
  // answers the word list still offers at those lengths with the crossing letters in
  // place. Computed only on failure, and only once — it is a few thousand u32 ANDs.
  let starvation = null;
  let failError = null;
  if (!complete) {
    starvation = diagnoseStarvation(grid, placements);
    const tail = starvation.summary ? ` ${starvation.summary}` : '';
    failError = outcome === 'ABORTED'
      ? err('TIMEOUT',
        `Couldn't fill this grid in ${(timeoutMs / 1000).toFixed(0)}s — got ${placements.length} of ${S} answers.${tail}`,
        { starvation })
      : err('NO_SOLUTION',
        `No complete fill exists for this layout with the current word list — got ${placements.length} of ${S} answers.${tail}`,
        { starvation });
  }

  cleanup();
  return {
    grid,
    placements,
    complete,
    attempts: stats.restarts + 1,
    requiredPlaced: usedRequired.size,
    failedWord: null,
    failedSlot: failedSlot != null ? slots[failedSlot]?.id ?? null : null,
    difficultyScore,
    difficultyMean,
    starvation,
    error: failError,
    stats,
  };
}

/** NYT-style clue numbers, so preflight messages can say "34-Across" not "slot 57". */
function numberSlots(slots) {
  const starts = new Map();
  const ordered = [...slots].sort((a, b) => (a.row - b.row) || (a.col - b.col));
  let n = 1;
  for (const s of ordered) {
    const k = `${s.row},${s.col}`;
    if (!starts.has(k)) starts.set(k, n++);
  }
  return slots.map((s) => starts.get(`${s.row},${s.col}`));
}
