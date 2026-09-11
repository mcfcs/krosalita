// Flat Uint32Array bitset primitives for the solver's candidate sets.
//
// Every function takes (array, offset, wordCount) and allocates nothing, because these
// run millions of times per solve. A slot's candidate set lives as a window inside one
// shared arena rather than as its own object.
//
// The win over the old Set<string> representation: intersecting a 6-letter slot's
// candidates with "words having E at position 2" is 397 u32 ANDs instead of 12,642
// string comparisons.

/** Bits set in a 32-bit word. */
export function popcount32(n) {
  n = n - ((n >>> 1) & 0x55555555);
  n = (n & 0x33333333) + ((n >>> 2) & 0x33333333);
  n = (n + (n >>> 4)) & 0x0f0f0f0f;
  return (Math.imul(n, 0x01010101) >>> 24);
}

/** Index of the lowest set bit (count trailing zeros). Undefined for 0. */
export function ctz32(n) {
  return 31 - Math.clz32(n & -n);
}

export function popcountRange(a, off, w) {
  let t = 0;
  for (let i = 0; i < w; i++) t += popcount32(a[off + i]);
  return t;
}

/** dst &= src over [first,last]. Returns bits removed. */
export function andIntoRange(dst, dOff, src, sOff, first, last) {
  let removed = 0;
  for (let i = first; i <= last; i++) {
    const o = dst[dOff + i];
    if (o === 0) continue;
    const n = o & src[sOff + i];
    if (n !== o) {
      removed += popcount32(o & ~n);
      dst[dOff + i] = n;
    }
  }
  return removed;
}

/** dst &= ~src over [first,last]. Returns bits removed. */
export function andNotIntoRange(dst, dOff, src, sOff, first, last) {
  let removed = 0;
  for (let i = first; i <= last; i++) {
    const o = dst[dOff + i];
    if (o === 0) continue;
    const n = o & ~src[sOff + i];
    if (n !== o) {
      removed += popcount32(o & ~n);
      dst[dOff + i] = n;
    }
  }
  return removed;
}

/** dst |= src over [first,last]. */
export function orIntoRange(dst, dOff, src, sOff, first, last) {
  for (let i = first; i <= last; i++) dst[dOff + i] |= src[sOff + i];
}

/**
 * Does `a` intersect `b` anywhere in [first,last]? Early-exits on the first hit,
 * which is the whole point: this is the arc-consistency test and it usually answers
 * on the first or second word.
 */
export function anyAnd(a, aOff, b, bOff, first, last) {
  for (let i = first; i <= last; i++) {
    if ((a[aOff + i] & b[bOff + i]) !== 0) return true;
  }
  return false;
}

/**
 * |a & b|, but give up early. `cap` bounds the answer (we only need "how many, roughly"
 * for value ordering) and `maxWords` bounds the work. Returns at least 1 if any overlap
 * was found, so 0 unambiguously means "wipes this slot out".
 */
export function andCountCapped(a, aOff, b, bOff, first, last, maxWords, cap) {
  let t = 0;
  const stop = Math.min(last, first + maxWords - 1);
  for (let i = first; i <= stop; i++) {
    const v = a[aOff + i] & b[bOff + i];
    if (v !== 0) {
      t += popcount32(v);
      if (t >= cap) return cap;
    }
  }
  // Scanned only a prefix and found nothing — confirm it really is empty before
  // reporting a wipeout, otherwise we would reject sound values.
  if (t === 0 && stop < last) {
    return anyAnd(a, aOff, b, bOff, stop + 1, last) ? 1 : 0;
  }
  return t;
}

export function setBit(a, off, i) { a[off + (i >>> 5)] |= (1 << (i & 31)); }
export function clearBit(a, off, i) { a[off + (i >>> 5)] &= ~(1 << (i & 31)); }
export function testBit(a, off, i) { return (a[off + (i >>> 5)] & (1 << (i & 31))) !== 0; }

/** First set bit at or after `from`, or -1. */
export function nextSetBit(a, off, w, from) {
  let i = from >>> 5;
  if (i >= w) return -1;
  let word = a[off + i] & (0xffffffff << (from & 31));
  for (;;) {
    if (word !== 0) return (i << 5) + ctz32(word);
    if (++i >= w) return -1;
    word = a[off + i];
  }
}

/** Index of the first non-zero 32-bit word in [first,last], or -1. */
export function firstNonZeroWord(a, off, first, last) {
  for (let i = first; i <= last; i++) if (a[off + i] !== 0) return i;
  return -1;
}

export function lastNonZeroWord(a, off, first, last) {
  for (let i = last; i >= first; i--) if (a[off + i] !== 0) return i;
  return -1;
}

/** Collect up to `max` set bits into `out`. Returns how many were written. */
export function collectSetBits(a, off, w, out, max, from = 0) {
  let n = 0;
  let b = nextSetBit(a, off, w, from);
  while (b >= 0 && n < max) {
    out[n++] = b;
    b = nextSetBit(a, off, w, b + 1);
  }
  return n;
}
