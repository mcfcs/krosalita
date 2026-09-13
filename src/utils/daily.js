// Deterministic "Puzzle of the Day" + solve-streak tracking.
import { loadJSON, saveJSON } from './storage.js';

// Local calendar day as YYYY-MM-DD (uses the device's local timezone).
export const todayKey = (d = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// A stable 32-bit seed derived from a string (FNV-1a). Same day -> same seed.
export const seedFromString = (str) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
};

// Mulberry32 — a tiny seeded PRNG so a given day always produces the same shuffle.
export const makeRng = (seed) => {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// Seeded shuffle (Fisher–Yates) — used to pick the day's word slice deterministically.
export const seededShuffle = (arr, rng) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

const STREAK_KEY = 'streak';

// { current, best, lastSolved } — lastSolved is a YYYY-MM-DD day key.
export const getStreak = () => loadJSON(STREAK_KEY, { current: 0, best: 0, lastSolved: null });

const dayDiff = (a, b) => {
  const da = new Date(a + 'T00:00:00');
  const db = new Date(b + 'T00:00:00');
  return Math.round((db - da) / 86400000);
};

// Call when the daily puzzle is solved. Returns the updated streak record.
export const recordDailySolve = (day = todayKey()) => {
  const s = getStreak();
  if (s.lastSolved === day) return s; // already counted today
  let current = 1;
  if (s.lastSolved && dayDiff(s.lastSolved, day) === 1) current = (s.current || 0) + 1;
  const next = { current, best: Math.max(current, s.best || 0), lastSolved: day };
  saveJSON(STREAK_KEY, next);
  return next;
};

// Whether today's daily has been solved already.
export const isDailySolved = (day = todayKey()) => getStreak().lastSolved === day;
