// Solve history: local-first, synced on sign-in.
//
// Every solve is written to localStorage, so the feature works signed-out, offline
// and with Supabase not configured at all. When the user is signed in the same
// record is pushed to public.solves fire-and-forget; when they sign in later,
// syncOnSignIn() uploads what the server lacks and pulls what the device lacks.
// The merge is a pure function (mergeSolves) so nothing is ever lost to a race
// between the two directions.
//
// This complements utils/daily.js rather than replacing it. That module owns the
// streak (one counter, one key, updated by the daily-completion effect). This one
// owns the log of *which puzzles* were solved and how. Recording a daily solve here
// does not touch the streak, and recordDailySolve() does not touch this log.

import { loadJSON, saveJSON } from '../utils/storage.js';
import { todayKey } from '../utils/daily.js';
import { supabase } from './supabase.js';

const KEY = 'solves';

// ---------------------------------------------------------------------------
// Storage cap
// ---------------------------------------------------------------------------
// saveJSON swallows quota errors, so an uncapped array would stop persisting
// silently once localStorage filled — the worst possible failure for a "no solve is
// ever lost" feature. A record serialises to roughly 200-260 bytes, so 750 records
// is about 180KB: comfortably inside the ~5MB budget even alongside the saved
// session blob, and more history than any UI is going to page through. When the cap
// is hit the OLDEST records are dropped, keeping the newest activity.
export const SOLVE_CAP = 750;

// ---------------------------------------------------------------------------
// Content hash
// ---------------------------------------------------------------------------
// cyrb128: four independent 32-bit accumulators over the same input, concatenated
// to 128 bits and rendered as 32 lowercase hex characters. Not cryptographic — it
// is an identity/dedupe key, not a security boundary — but it avalanches well and
// 128 bits makes an accidental collision between two crosswords impossible in
// practice. Deterministic: same string in, same digest out, on every device and
// every run, with no dependency on Math.random, Date, or platform hashing.
export function hash128(str) {
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  const mix = [h1 ^ h2 ^ h3 ^ h4, h2 ^ h1, h3 ^ h1, h4 ^ h1];
  return mix.map((n) => (n >>> 0).toString(16).padStart(8, '0')).join('');
}

// Canonical text for a grid. Accepts the two shapes the app actually produces:
// an array of row strings ("CAT#DOG") and an array of arrays of cells. Cells are
// uppercased, empties become '.', and a null grid yields null so the caller can
// skip hashing rather than hash the string "null".
export function canonicalGrid(grid) {
  if (!Array.isArray(grid) || grid.length === 0) return null;
  const rows = grid.map((row) => {
    if (typeof row === 'string') return row.toUpperCase();
    if (!Array.isArray(row)) return '';
    return row.map((cell) => {
      if (cell == null || cell === '') return '.';
      if (typeof cell === 'string') return cell.toUpperCase();
      // Defensive: a cell object such as { letter } from the play grid.
      const letter = cell.letter ?? cell.answer ?? cell.value;
      return typeof letter === 'string' && letter ? letter.toUpperCase() : '.';
    }).join('');
  });
  return rows.join('/');
}

/**
 * A deterministic 128-bit digest of a puzzle's answer grid, or null when no grid
 * was supplied. Two devices holding the same puzzle produce the same digest; two
 * different puzzles do not.
 */
export function contentHashOf(grid) {
  const canonical = canonicalGrid(grid);
  return canonical ? hash128(canonical) : null;
}

// ---------------------------------------------------------------------------
// Puzzle identity — the crux
// ---------------------------------------------------------------------------
// The requirement is an id that is the SAME on two devices for the same puzzle and
// different for different puzzles, without a server round trip. No single rule
// covers every way a puzzle enters the app, so identity is TIERED: the strongest
// available naming wins, and a content hash is always computed alongside as a
// cross-tier bridge.
//
//   remote  p:<uuid>                 A puzzle row in public.puzzles — someone saved
//                                    or shared it, so the database already assigned
//                                    a globally unique name. Strongest possible.
//   source  x:<source>:<id>          An imported puzzle with an upstream id, e.g.
//                                    x:crosswithfriends:<pid>. Stable by definition.
//   daily   d:<YYYY-MM-DD>           The daily is defined *as* its date: App.jsx
//                                    seeds it from seedFromString(todayKey()), so
//                                    the date is the identity that two devices agree
//                                    on. Note this is the device's LOCAL day, so two
//                                    users in different timezones can hold different
//                                    puzzles under the same key — acceptable,
//                                    because the daily is per-user progress, and the
//                                    streak in utils/daily.js already uses local days.
//   seed    g:<layout>:<difficulty>:<seed>
//                                    A generated puzzle IS reproducible from those
//                                    three inputs — but only against an identical
//                                    corpus. The solver already threads a
//                                    corpusFingerprint, so when one is supplied it
//                                    joins the tuple; without it the tuple is a
//                                    same-device-and-build claim only, which is why
//                                    it ranks below the tiers above and why a
//                                    content hash is recorded beside it.
//   hash    h:<128-bit hex>          Everything else, and the majority of generated
//                                    puzzles in practice: App.jsx passes seed=null
//                                    for an ordinary Generate, so there is nothing
//                                    reproducible to name. The answer grid is then
//                                    the only thing two devices can agree on, and it
//                                    is a perfectly good one — same grid means same
//                                    puzzle.
//   adhoc   a:<random>               Last resort: no grid, no ids. Local-only and
//                                    never merged across devices, but recorded
//                                    rather than dropped.
//
// The content hash is stored on EVERY record that has a grid, not just the h: tier.
// That is what makes the scheme robust to a puzzle arriving by two different routes
// on two devices — generated on one, imported on the other. See mergeSolves for how
// it is used, and for why it is only allowed to collapse the weak tiers.

const TIER = { remote: 0, source: 1, daily: 2, seed: 3, hash: 4, adhoc: 5 };
export const WEAK_TIERS = new Set(['seed', 'hash']);

const slug = (v) => String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * Compute a puzzle's identity from whatever the caller knows.
 *
 * @param {object} desc
 * @param {string} [desc.remoteId]    public.puzzles.id (uuid)
 * @param {string} [desc.sourceId]    upstream id, e.g. a crosswithfriends pid
 * @param {string} [desc.sourceName]  upstream name, defaults to 'cwf'
 * @param {string} [desc.source]      daily | generated | imported | shared
 * @param {string} [desc.day]         YYYY-MM-DD, for source === 'daily'
 * @param {number} [desc.seed]        generator seed, when one was used
 * @param {string} [desc.layoutName]  layout the puzzle was built on
 * @param {number} [desc.layoutIndex] fallback when layoutName is absent
 * @param {string} [desc.difficulty]  difficulty choice the puzzle was built at
 * @param {string} [desc.corpusFingerprint]
 * @param {Array}  [desc.grid]        answer grid, for the content hash
 * @returns {{ id: string, kind: string, contentHash: string|null }}
 */
export function puzzleIdentity(desc = {}) {
  const contentHash = desc.contentHash || contentHashOf(desc.grid);

  if (desc.remoteId) {
    return { id: `p:${String(desc.remoteId).toLowerCase()}`, kind: 'remote', contentHash };
  }
  if (desc.sourceId) {
    const name = slug(desc.sourceName || 'cwf') || 'cwf';
    return { id: `x:${name}:${String(desc.sourceId).trim().toLowerCase()}`, kind: 'source', contentHash };
  }
  if (desc.source === 'daily') {
    return { id: `d:${desc.day || todayKey()}`, kind: 'daily', contentHash };
  }
  if (desc.seed != null && desc.seed !== '') {
    const layout = slug(desc.layoutName) || (desc.layoutIndex != null ? `i${desc.layoutIndex}` : 'auto');
    const diff = slug(desc.difficulty) || 'random';
    const corpus = desc.corpusFingerprint ? `:${slug(desc.corpusFingerprint)}` : '';
    return { id: `g:${layout}:${diff}:${desc.seed}${corpus}`, kind: 'seed', contentHash };
  }
  if (contentHash) {
    return { id: `h:${contentHash}`, kind: 'hash', contentHash };
  }
  // Nothing to name it by. Deterministic within the record (it carries its own id
  // forever) but not across devices — which is honest, since there is nothing to
  // match on.
  return { id: `a:${hash128(`${desc.title || ''}|${desc.day || todayKey()}|${desc.seconds || 0}`)}`, kind: 'adhoc', contentHash };
}

/** Convenience: just the id string. */
export const puzzleId = (desc) => puzzleIdentity(desc).id;

// ---------------------------------------------------------------------------
// Local store
// ---------------------------------------------------------------------------

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v) => (num(v) == null ? null : Math.round(v));

const SOURCES = new Set(['daily', 'generated', 'imported', 'shared']);

/** Normalise a caller-supplied entry into the canonical record shape. */
export function makeRecord(entry = {}) {
  const { id, kind, contentHash } = puzzleIdentity(entry);
  const now = entry.solvedAt || new Date().toISOString();
  const seconds = int(entry.seconds);
  const gridRows = Array.isArray(entry.grid) ? entry.grid.length : null;
  const firstRow = Array.isArray(entry.grid) ? entry.grid[0] : null;
  const gridCols = firstRow ? firstRow.length : null; // rows are strings or arrays; both have .length
  return {
    id,
    kind,
    contentHash: contentHash || null,
    source: SOURCES.has(entry.source) ? entry.source : 'generated',
    title: entry.title ? String(entry.title).slice(0, 120) : null,
    seconds,
    bestSeconds: int(entry.bestSeconds) ?? seconds,
    usedHelp: Boolean(entry.usedHelp),
    difficultyScore: num(entry.difficultyScore),
    difficultyLabel: entry.difficultyLabel ? String(entry.difficultyLabel).slice(0, 40) : null,
    rows: int(entry.rows) ?? gridRows,
    cols: int(entry.cols) ?? gridCols,
    count: int(entry.count) ?? 1,
    day: entry.day || todayKey(),
    firstSolvedAt: entry.firstSolvedAt || now,
    solvedAt: now,
  };
}

/** Every locally stored record, newest first. Never throws. */
export function loadLocal() {
  const raw = loadJSON(KEY, []);
  return Array.isArray(raw) ? raw.filter((r) => r && typeof r.id === 'string') : [];
}

function persist(records) {
  const sorted = [...records].sort((a, b) => String(b.solvedAt).localeCompare(String(a.solvedAt)));
  const capped = sorted.slice(0, SOLVE_CAP);
  saveJSON(KEY, capped);
  return capped;
}

/** Drop the local log. Exposed for a "clear history" control and for tests. */
export function clearLocalSolves() {
  saveJSON(KEY, []);
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

const earliest = (a, b) => (!a ? b : !b ? a : (String(a) <= String(b) ? a : b));
const latest = (a, b) => (!a ? b : !b ? a : (String(a) >= String(b) ? a : b));
const minNum = (a, b) => (a == null ? b : b == null ? a : Math.min(a, b));

/** Fold two records that refer to the same puzzle into one. Commutative. */
export function mergeRecord(a, b) {
  if (!a) return b;
  if (!b) return a;
  // The record with the more recent solve supplies the descriptive fields, so a
  // later rename or re-scored difficulty wins; the other fills in any nulls.
  // Ties go to `b`: recordSolve passes (existing, incoming), and two solves inside
  // the same millisecond must still let the incoming one supply `seconds`.
  const [recent, older] = String(a.solvedAt) > String(b.solvedAt) ? [a, b] : [b, a];
  const pick = (field) => (recent[field] != null ? recent[field] : older[field]);
  return {
    // Keep the stronger identity tier's id, so a device that only had the weak
    // hash-tier name adopts the strong one instead of keeping a duplicate.
    id: (TIER[a.kind] ?? 9) <= (TIER[b.kind] ?? 9) ? a.id : b.id,
    kind: (TIER[a.kind] ?? 9) <= (TIER[b.kind] ?? 9) ? a.kind : b.kind,
    contentHash: pick('contentHash') || null,
    source: pick('source') || 'generated',
    title: pick('title'),
    seconds: recent.seconds != null ? recent.seconds : older.seconds,
    bestSeconds: minNum(minNum(a.bestSeconds, b.bestSeconds), minNum(a.seconds, b.seconds)),
    // A puzzle solved unaided on ANY device counts as solved unaided.
    usedHelp: Boolean(a.usedHelp) && Boolean(b.usedHelp),
    difficultyScore: pick('difficultyScore'),
    difficultyLabel: pick('difficultyLabel'),
    rows: pick('rows'),
    cols: pick('cols'),
    // max, not sum: the two sides usually describe the same solves seen twice.
    // Under genuinely concurrent offline solving this under-counts rather than
    // double-counting, which is the safer direction for a "times solved" figure.
    count: Math.max(a.count || 1, b.count || 1),
    day: earliest(a.day, b.day),
    firstSolvedAt: earliest(a.firstSolvedAt, b.firstSolvedAt),
    solvedAt: latest(a.solvedAt, b.solvedAt),
  };
}

/**
 * Merge two lists of records into one deduped list, newest first.
 *
 * Dedupe runs in two passes:
 *   1. by id — the normal case, and the only one allowed to touch strong tiers.
 *   2. by contentHash, but ONLY between records whose tier is weak (seed/hash).
 *      This is what lets a puzzle that one device named g:mini:hard:1234 and
 *      another named h:<digest> collapse to a single entry. It deliberately does
 *      NOT apply to the strong tiers: a daily and a separately generated puzzle can
 *      share a grid, and collapsing those would erase the daily record. A remote or
 *      imported puzzle already has an authoritative name and must keep it.
 */
export function mergeSolves(listA = [], listB = []) {
  const byId = new Map();
  for (const rec of [...listA, ...listB]) {
    if (!rec || typeof rec.id !== 'string') continue;
    byId.set(rec.id, mergeRecord(byId.get(rec.id), rec));
  }

  const byHash = new Map();
  const out = [];
  for (const rec of byId.values()) {
    const weak = WEAK_TIERS.has(rec.kind) && rec.contentHash;
    if (!weak) { out.push(rec); continue; }
    const prior = byHash.get(rec.contentHash);
    if (prior) {
      byHash.set(rec.contentHash, mergeRecord(prior, rec));
    } else {
      byHash.set(rec.contentHash, rec);
    }
  }
  out.push(...byHash.values());
  out.sort((a, b) => String(b.solvedAt).localeCompare(String(a.solvedAt)));
  return out;
}

// ---------------------------------------------------------------------------
// Server backend (injectable so the merge can be tested without a live Supabase)
// ---------------------------------------------------------------------------

export const toRow = (rec, userId) => ({
  user_id: userId,
  puzzle_key: rec.id,
  content_hash: rec.contentHash,
  source: rec.source,
  title: rec.title,
  seconds: rec.seconds,
  best_seconds: rec.bestSeconds,
  used_help: rec.usedHelp,
  difficulty_score: rec.difficultyScore,
  difficulty_label: rec.difficultyLabel,
  rows: rec.rows,
  cols: rec.cols,
  solve_count: rec.count,
  day: rec.day,
  first_solved_at: rec.firstSolvedAt,
  solved_at: rec.solvedAt,
});

export const fromRow = (row) => ({
  id: row.puzzle_key,
  // The tier is recoverable from the id prefix, so it never needs a column.
  kind: kindFromId(row.puzzle_key),
  contentHash: row.content_hash ?? null,
  source: row.source || 'generated',
  title: row.title ?? null,
  seconds: row.seconds ?? null,
  bestSeconds: row.best_seconds ?? row.seconds ?? null,
  usedHelp: Boolean(row.used_help),
  difficultyScore: row.difficulty_score ?? null,
  difficultyLabel: row.difficulty_label ?? null,
  rows: row.rows ?? null,
  cols: row.cols ?? null,
  count: row.solve_count ?? 1,
  day: row.day ?? null,
  firstSolvedAt: row.first_solved_at || row.solved_at,
  solvedAt: row.solved_at,
});

/** Recover the identity tier from an id prefix, so `kind` need not be persisted. */
export function kindFromId(id) {
  switch (String(id || '').slice(0, 2)) {
    case 'p:': return 'remote';
    case 'x:': return 'source';
    case 'd:': return 'daily';
    case 'g:': return 'seed';
    case 'h:': return 'hash';
    default: return 'adhoc';
  }
}

/** The real Supabase-backed store. Every method is a no-op when unavailable. */
export const supabaseBackend = {
  async userId() {
    if (!supabase) return null;
    try {
      const { data } = await supabase.auth.getUser();
      return data?.user?.id || null;
    } catch { return null; }
  },
  async list(userId) {
    if (!supabase || !userId) return [];
    const { data, error } = await supabase
      .from('solves').select('*').eq('user_id', userId)
      .order('solved_at', { ascending: false }).limit(SOLVE_CAP);
    if (error) throw error;
    return (data || []).map(fromRow);
  },
  async upsert(userId, records) {
    if (!supabase || !userId || !records.length) return;
    const { error } = await supabase
      .from('solves')
      .upsert(records.map((r) => toRow(r, userId)), { onConflict: 'user_id,puzzle_key' });
    if (error) throw error;
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a solve. Writes locally and returns the stored record synchronously, so a
 * caller can render immediately; the server push is fire-and-forget and its failure
 * (offline, signed out, Supabase unconfigured) is not the caller's problem — the
 * next syncOnSignIn will carry the row up.
 */
export function recordSolve(entry = {}, backend = supabaseBackend) {
  const incoming = makeRecord(entry);
  const existing = loadLocal().find((r) => r.id === incoming.id);
  const record = existing
    ? mergeRecord({ ...existing, count: (existing.count || 1) + 1 }, incoming)
    : incoming;
  const merged = mergeSolves(loadLocal().filter((r) => r.id !== record.id), [record]);
  persist(merged);

  // Fire and forget.
  (async () => {
    try {
      const uid = await backend.userId();
      if (uid) await backend.upsert(uid, [record]);
    } catch { /* offline or RLS-rejected; syncOnSignIn reconciles later */ }
  })();

  return record;
}

/** Local records only. Synchronous, always available. */
export function listLocalSolves({ limit = 100, source = null } = {}) {
  let rows = loadLocal();
  if (source) rows = rows.filter((r) => r.source === source);
  rows.sort((a, b) => String(b.solvedAt).localeCompare(String(a.solvedAt)));
  return limit ? rows.slice(0, limit) : rows;
}

/**
 * The merged local + server view. Falls back to the local list when signed out,
 * offline or unconfigured, so the UI has one code path either way.
 */
export async function listSolves({ limit = 100, source = null } = {}, backend = supabaseBackend) {
  const local = loadLocal();
  let remote = [];
  try {
    const uid = await backend.userId();
    if (uid) remote = await backend.list(uid);
  } catch { remote = []; }

  let rows = remote.length ? mergeSolves(local, remote) : mergeSolves(local, []);
  if (source) rows = rows.filter((r) => r.source === source);
  return limit ? rows.slice(0, limit) : rows;
}

/**
 * Whether a puzzle has been solved. Accepts either an id string or the same
 * descriptor object puzzleIdentity() takes, so Browse can ask about a puzzle it has
 * only metadata for. Local-only and synchronous — call after syncOnSignIn so the
 * local store already holds the server's rows.
 */
export function hasSolved(idOrDesc) {
  if (!idOrDesc) return false;
  const identity = typeof idOrDesc === 'string'
    ? { id: idOrDesc, kind: kindFromId(idOrDesc), contentHash: null }
    : puzzleIdentity(idOrDesc);
  const rows = loadLocal();
  if (rows.some((r) => r.id === identity.id)) return true;
  // Weak-tier bridge, same rule as the merge: a grid we have solved under another
  // weak name still counts.
  if (identity.contentHash && WEAK_TIERS.has(identity.kind)) {
    return rows.some((r) => r.contentHash === identity.contentHash && WEAK_TIERS.has(r.kind));
  }
  return false;
}

/** Map of id -> record, for a list view that wants to badge many rows at once. */
export function solvedIndex() {
  const map = new Map();
  for (const r of loadLocal()) map.set(r.id, r);
  return map;
}

/**
 * Reconcile local and server after sign-in. Uploads rows the server lacks, pulls
 * rows the device lacks, writes the union back to both. Idempotent: running it
 * twice changes nothing.
 *
 * Returns { merged, uploaded, downloaded, skipped } — `skipped` is true when there
 * was no backend to talk to, in which case the local store is untouched.
 */
export async function syncOnSignIn(userId, backend = supabaseBackend) {
  const local = loadLocal();
  const uid = userId || (await backend.userId().catch(() => null));
  if (!uid) return { merged: local, uploaded: 0, downloaded: 0, skipped: true };

  let remote = [];
  try {
    remote = await backend.list(uid);
  } catch {
    // Server unreachable: keep local intact rather than "merging" against nothing.
    return { merged: local, uploaded: 0, downloaded: 0, skipped: true };
  }

  const merged = mergeSolves(local, remote);
  const capped = persist(merged);

  const remoteById = new Map(remote.map((r) => [r.id, r]));
  const localById = new Map(local.map((r) => [r.id, r]));

  // Push anything the server is missing or holds a stale version of. Comparing the
  // merged record against the server's lets a merge result (better bestSeconds, an
  // adopted stronger id) travel up too, not just brand-new rows.
  const toPush = capped.filter((rec) => {
    const server = remoteById.get(rec.id);
    if (!server) return true;
    return server.solvedAt !== rec.solvedAt
      || server.bestSeconds !== rec.bestSeconds
      || server.count !== rec.count
      || server.usedHelp !== rec.usedHelp;
  });
  let uploaded = 0;
  try {
    if (toPush.length) {
      await backend.upsert(uid, toPush);
      uploaded = toPush.length;
    }
  } catch { uploaded = 0; }

  const downloaded = capped.filter((rec) => !localById.has(rec.id)).length;
  return { merged: capped, uploaded, downloaded, skipped: false };
}
