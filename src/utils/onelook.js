// OneLook (onelook.com) as the LAST resort for a fill.
//
// The packed corpus is always tried first, on its own. Only when that fill fails does the
// worker ask OneLook for answers matching the slots that ran dry, and solve once more with
// those answers added. That second run still ranks them below every corpus word (see
// SUPPLEMENT_PENALTY in solver.js), so a supplement only lands where nothing else fitted.
//
// The usual cause is the author's own letters: a theme entry or a typed word whose
// crossings leave a slot with no corpus answer at all ("Q _ _ _ X"). Those slots are what
// get queried, by their FIXED letters, plus whatever the failed run's best partial grid
// says starved.
//
// Every supplement needs a clue, so a word only counts if OneLook also has a definition
// it can be clued from. Its clue is that definition, tagged clueSource 'onelook' so the
// author knows to look at it.

import { findSlots } from './crosswordUtils.js';
import { popcount32 } from './bitset.js';
import { clueRevealsAnswerStrict } from './clueFilters.js';

const API = 'https://www.onelook.com/api/words';
const MIN_LEN = 3;
const MAX_LEN = 15;
const QUERY_LIMIT = 16;        // patterns asked per failed fill
const CONCURRENCY = 6;
const FETCH_TIMEOUT_MS = 6000;
const RESULTS_PER_QUERY = 100;
const KEEP_PER_QUERY = 40;
// A slot whose fixed letters leave this few corpus answers is worth widening. Above it the
// corpus has the slot covered and the failure is somewhere else.
const THIN_DOMAIN = 40;
const MIN_FREQ = 0.01;         // OneLook's f: tag, occurrences per million words

const A_CODE = 65;

/** Corpus answers matching `pattern` ('?' = blank), from the bitset index. */
export function countMatches(index, pattern) {
  const len = pattern.length;
  const li = index?.byLen?.[len];
  if (!li) return 0;
  const { W } = li;
  const acc = new Uint32Array(li.all.subarray(0, W));
  for (let p = 0; p < len; p++) {
    const ch = pattern.charCodeAt(p);
    if (ch === 63) continue; // '?'
    const row = (p * 26 + (ch - A_CODE)) * W;
    for (let w = 0; w < W; w++) acc[w] &= li.byLetter[row + w];
  }
  let n = 0;
  for (let w = 0; w < W; w++) n += popcount32(acc[w]);
  return n;
}

function slotPattern(slot, grid) {
  let s = '';
  for (let i = 0; i < slot.length; i++) {
    const r = slot.direction === 'across' ? slot.row : slot.row + i;
    const c = slot.direction === 'across' ? slot.col + i : slot.col;
    const v = grid?.[r]?.[c];
    s += v && /^[A-Za-z]$/.test(String(v)) ? String(v).toUpperCase() : '?';
  }
  return s;
}

const hasLetter = (p) => /[A-Z]/.test(p);
const hasBlank = (p) => p.includes('?');

/**
 * Which patterns to ask OneLook about after a failed fill, tightest first.
 *
 *  - every slot the author's letters constrain to a thin corpus domain, by those letters
 *    alone (they are the constraints no re-search can move);
 *  - every slot the failed run left unfilled with no corpus answer for its partial
 *    pattern, by that pattern.
 */
export function planQueries({ index, layout, presetGrid, failed }) {
  const rowsArr = (layout || []).map((r) => (Array.isArray(r) ? r : String(r).split('')));
  if (!rowsArr.length) return [];
  const slots = findSlots(rowsArr).filter((s) => s.length >= MIN_LEN && s.length <= MAX_LEN);
  const placed = new Set((failed?.placements || [])
    .map((p) => `${p.slot.direction}-${p.slot.row}-${p.slot.col}`));
  const want = new Map(); // pattern -> corpus matches (lower = more urgent)
  const add = (p, n) => { if (!want.has(p) || want.get(p) > n) want.set(p, n); };

  for (const slot of slots) {
    const fixed = slotPattern(slot, presetGrid);
    if (hasLetter(fixed) && hasBlank(fixed)) {
      const n = countMatches(index, fixed);
      if (n < THIN_DOMAIN) add(fixed, n);
    }
    if (!failed?.grid || placed.has(`${slot.direction}-${slot.row}-${slot.col}`)) continue;
    const partial = slotPattern(slot, failed.grid);
    if (partial !== fixed && hasLetter(partial) && hasBlank(partial)) {
      const n = countMatches(index, partial);
      if (n === 0) add(partial, n);
    }
  }
  return [...want.entries()]
    .sort((a, b) => a[1] - b[1] || b[0].replace(/\?/g, '').length - a[0].replace(/\?/g, '').length)
    .slice(0, QUERY_LIMIT)
    .map(([pattern]) => pattern);
}

// ---- definitions -> clues ---------------------------------------------------

// Wiktionary labels a sense with leading parentheticals: "(countable, nautical) A ...",
// and OneLook marks its cross-linked words with a leading underscore: "A _wreath".
const stripLabels = (t) => t.replace(/(^|[\s([])_(?=\w)/g, '$1')
  .replace(/^(\s*\([^)]*\)\s*)+/, '').trim();
// A person's name is no answer to clue: "A German surname", "A Polish given name".
const NAME_SENSE = /\b(surname|given name|placename|place name|patronymic|diminutive of)\b/i;
const INFLECTION = /^(plural|simple past|past participle|simple past and past participle|present participle|third-person singular simple present indicative|comparative|superlative) (form )?of \S+\s*\[([^\]]+)\]/i;
const TAGS = {
  plural: 'pl.', 'simple past': 'past', 'past participle': 'past',
  'simple past and past participle': 'past', 'present participle': '-ing',
  'third-person singular simple present indicative': 'verb', comparative: 'more',
  superlative: 'most',
};

function tidy(t) {
  let s = t.split(/;\s/)[0].trim();      // first sense only
  if (s.length > 90) s = `${s.slice(0, 87).replace(/[\s,]+\S*$/, '')}…`;
  s = s.replace(/\.\s*$/, '');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** A crossword-style clue from OneLook's definitions, or null if none is usable. */
export function clueFromDefinitions(word, defs) {
  for (const raw of defs || []) {
    const text = String(raw).split('\t').pop() || '';
    const infl = text.match(INFLECTION);
    let clue;
    if (infl) {
      const gloss = stripLabels(infl[3]);
      if (!gloss) continue;
      clue = `${tidy(gloss)} (${TAGS[infl[1].toLowerCase()] || infl[1]})`;
    } else {
      const body = stripLabels(text);
      if (!body || NAME_SENSE.test(body)) continue;
      if (/^(alternative|obsolete|archaic|misspelling|abbreviation|initialism|acronym|clipping|ellipsis) (form |spelling )?of\b/i.test(body)) continue;
      clue = tidy(body);
    }
    if (clue.length < 3 || clueRevealsAnswerStrict(clue, word)) continue;
    return clue;
  }
  return null;
}

// ---- fetching ----------------------------------------------------------------

// OneLook's CDN caches a response WITH the Access-Control-Allow-Origin of whoever asked
// first, and does not Vary on Origin. So a second site asking the same URL in the next week
// gets another site's CORS header and a "Failed to fetch". (Measured 2026-10-17: localhost
// asked for sp=cat, krosalita.vercel.app was then served "Allow-Origin: localhost".) An
// alphanumeric key per origin gives this site its own cache entries; OneLook ignores the
// parameter (identical results). Its value must not look like a URL (the firewall 403s
// "http://..."), and its name must not be `v`, which OneLook uses itself (HTTP 500).
function originKey() {
  const o = String(globalThis.location?.origin || 'node');
  let h = 0x811c9dc5;
  for (let i = 0; i < o.length; i++) { h ^= o.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `k${(h >>> 0).toString(36)}`;
}

// Datamuse is the engine behind OneLook (same scores, same Wiktionary defs) and Varies on
// Origin correctly, so it is the fallback when onelook.com itself can't be reached.
const DATAMUSE = 'https://api.datamuse.com/words';

async function fetchJson(url, fetchImpl) {
  const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = ctl ? setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS) : null;
  try {
    const res = await fetchImpl(url, ctl ? { signal: ctl.signal } : undefined);
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchPattern(pattern, fetchImpl) {
  const q = `sp=${encodeURIComponent(pattern.toLowerCase())}&md=df&max=${RESULTS_PER_QUERY}`;
  return (await fetchJson(`${API}?${q}&ck=${originKey()}`, fetchImpl))
    || (await fetchJson(`${DATAMUSE}?${q}`, fetchImpl))
    || []; // offline, blocked, slow: the fill just goes without
}

const matchesPattern = (word, pattern) => {
  if (word.length !== pattern.length) return false;
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] !== '?' && pattern[i] !== word[i]) return false;
  }
  return true;
};

/**
 * Ask OneLook for answers to each pattern. Returns Map word -> { clue, pattern }, holding
 * only words the corpus does not already have, that fit their pattern letter for letter,
 * and that came with a definition usable as a clue.
 *
 * OneLook treats spaces and punctuation as matching a '?', so "a team" comes back for
 * A?EAM. Squeezed to letters it is five long, not six, and is dropped.
 */
export async function fetchSupplements(patterns, {
  index, fetchImpl = globalThis.fetch, isCancelled = () => false,
} = {}) {
  const out = new Map();
  if (!fetchImpl || !patterns.length) return out;
  let next = 0;
  const work = async () => {
    while (next < patterns.length && !isCancelled()) {
      const pattern = patterns[next++];
      const rows = await fetchPattern(pattern, fetchImpl);
      let kept = 0;
      for (const row of rows) {
        if (kept >= KEEP_PER_QUERY) break;
        const word = String(row?.word || '').toUpperCase().replace(/[^A-Z]/g, '');
        if (!matchesPattern(word, pattern) || out.has(word)) continue;
        if (index?.lookup?.[word.length]?.get(word) !== undefined) continue;
        const f = Number((row.tags || []).find((t) => String(t).startsWith('f:'))?.slice(2));
        if (Number.isFinite(f) && f < MIN_FREQ) continue;
        const clue = clueFromDefinitions(word, row.defs);
        if (!clue) continue;
        out.set(word, { clue, pattern, freq: Number.isFinite(f) ? f : 0 });
        kept++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, patterns.length) }, work));
  return out;
}

/**
 * fetchSupplements' map as solver input, best known first: the order they claim the
 * reserved index tail in, and a score so the solver prefers KLOTZ to KRITZ. All of it sits
 * far below a corpus answer (score 16000 at most, and SUPPLEMENT_PENALTY on top).
 */
export function supplementList(supplements) {
  return [...supplements]
    .sort((a, b) => b[1].freq - a[1].freq)
    .map(([word, s]) => ({ word, score: Math.min(16000, Math.round(Math.log1p(s.freq) * 4000)) }));
}

/** The line telling the author which answers OneLook supplied, or '' if none did. */
export function describeOnelook(onelook) {
  const used = onelook?.used || [];
  if (!used.length) return '';
  const one = used.length === 1;
  return `${one ? '1 answer' : `${used.length} answers`} came from OneLook because the word `
    + `list had nothing that fit: ${used.join(', ')}. ${one ? 'Its clue is a' : 'Their clues are'} `
    + `dictionary ${one ? 'definition' : 'definitions'}, worth a look.`;
}
