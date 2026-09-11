// Seeded PRNG. The solver must be deterministic given a seed so that the daily
// puzzle is genuinely reproducible (it wasn't: the old solver called Math.random()
// directly at solver.js:98 and :237, so seededShuffle upstream bought nothing) and
// so a failing fill can be replayed exactly.

// mulberry32 — 32-bit state, good distribution, ~2^32 period. Plenty here.
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// FNV-1a, so a date key or puzzle id maps to a stable seed.
export function seedFromString(str) {
  let h = 0x811c9dc5;
  const s = String(str);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const randInt = (rng, n) => (n <= 0 ? 0 : Math.floor(rng() * n) % n);

// Fisher-Yates on a copy, seeded.
export function shuffled(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(rng, i + 1);
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

export const randomSeed = () => ((Date.now() ^ (Math.random() * 0xffffffff)) >>> 0);
