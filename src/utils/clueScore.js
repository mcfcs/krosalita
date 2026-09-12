// Instant, offline difficulty scoring for a clue that has never been published.
//
// The corpus scorer (pipeline s5/s6) uses features describing how often and when each
// (answer, clue) pair appeared in print. A clue the user just wrote has none of that, so
// pipeline/stages/s8_coldstart.py trains a second model on only what a new clue can have
// and exports it here: 60 trees, ~1,700 nodes, ~41 KB. Measured Spearman 0.522 against
// held-out LLM labels — 94% of the full model's rank correlation, with no Ollama call and
// no latency, which is what makes live feedback while typing possible.
//
// For an answer the corpus doesn't know, four of the features are unavailable and accuracy
// drops to 0.374 (also measured, reported by s8). Still useful, and the NaN path is a
// normal case here rather than an edge case — hence `missingGoesLeft` in the export.
//
// IMPORTANT: the feature code below must stay identical to s2_features.py's. Drift would
// feed the model garbage while everything still appeared to work, so the model carries its
// own feature-name list and `loadClueModel` refuses to load if it disagrees with this file.
// scripts/test-clue-score.mjs checks the numbers themselves against a Python fixture.

// Ported verbatim from pipeline/stages/s2_features.py MARKERS — same order, same patterns.
export const CLUE_MARKERS = [
  ['q_wordplay', /\?\s*$/],
  ['fitb', /_{2,}|\b___\b/],
  ['abbr', /:\s*Abbr\.?|,\s*for short|,\s*in brief|\bacronym\b/i],
  ['variant', /:\s*Var\.?|\bvar\.\b/i],
  ['by_example', /,\s*e\.g\.|\bperhaps\b|\bmaybe\b|\bsay\b\s*$|\bfor one\b/i],
  ['quoted', /"[^"]{2,}"/],
  ['foreign', /\bin (?:Paris|Spain|France|Italy|Germany|Rome|Madrid)\b|\b(?:French|Spanish|German|Italian|Latin|Greek) (?:for|word)\b|:\s*(?:Fr|Sp|Ger|It|Lat)\./i],
  ['year', /\b(?:1[5-9]\d{2}|20[0-2]\d)\b/],
  ['prefix_sfx', /\b(?:prefix|suffix|combining form)\b/i],
  ['brand_name', /\b(?:brand|maker|company|co\.|inc\.)\b/i],
  ['roman', /\bRoman numeral|\bin Roman\b/i],
  ['crossword_of', /\bpartner\b|\bcompanion\b|\bfollower\b|\bword (?:before|after)\b/i],
];

// s2_features.py rounds several features before the model ever sees them, so the browser
// must round identically or it feeds the model numbers it was never trained on. Python's
// round() is banker's rounding (half to even) — Math.round is half-up, and the tie case is
// reachable here (e.g. a 16-token clue of 55 letters gives ClueAvgTokenLen 3.4375).
function roundPy(value, digits) {
  if (!Number.isFinite(value)) return value;
  const f = 10 ** digits;
  const x = value * f;
  const r = Math.round(x);
  // Exactly halfway: Python picks the even neighbour.
  return (Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r) / f;
}

const TOKEN = /[A-Za-z']+/g;
const CAP_WORD = /\b[A-Z][a-z]{2,}/g;

/** The feature order this file produces. Must equal the model's `features`. */
export const FEATURE_ORDER = [
  'WordLen', 'CorpusFreqLog', 'ZipfEn', 'Crosswordese', 'VowelRatio', 'IsAllCons',
  'DistinctCluesForWord', 'ClueChars', 'ClueTokens', 'ClueAvgTokenLen', 'SingleWordClue',
  'ProperNounCount', 'ProperNounDensity', 'ClueHasDigit',
  ...CLUE_MARKERS.map(([name]) => name),
];

/**
 * Features for one (answer, clue) pair.
 *
 * `answer` supplies the four features that depend on the corpus —
 * { corpusFreqLog, zipf, crosswordese, distinctClues } — and may be omitted or partial for
 * a word the corpus has never seen; missing entries become NaN, which the trees handle.
 * The other three answer features are derived from the string itself and always present.
 */
export function extractFeatures(word, clueText, answer = {}) {
  const w = String(word || '').toUpperCase();
  const clue = String(clueText || '');
  const len = w.length;
  let vowels = 0;
  for (let i = 0; i < len; i++) if ('AEIOU'.includes(w[i])) vowels++;

  const tokens = clue.match(TOKEN) || [];
  const nTok = tokens.length;
  const proper = (clue.match(CAP_WORD) || []).length;
  const num = (v) => (v === undefined || v === null ? NaN : Number(v));

  const f = [
    len,
    num(answer.corpusFreqLog),
    num(answer.zipf),
    num(answer.crosswordese),
    len ? roundPy(vowels / len, 4) : 0,
    vowels === 0 ? 1 : 0,
    num(answer.distinctClues),
    clue.length,
    nTok,
    nTok ? roundPy(tokens.reduce((a, t) => a + t.length, 0) / nTok, 3) : 0,
    nTok <= 1 ? 1 : 0,
    proper,
    nTok ? roundPy(proper / nTok, 4) : 0,
    /\d/.test(clue) ? 1 : 0,
  ];
  for (const [, rx] of CLUE_MARKERS) f.push(rx.test(clue) ? 1 : 0);
  return f;
}

/** Validate and prepare an exported model for use. */
export function loadClueModel(json) {
  if (!json || !Array.isArray(json.features)) throw new Error('clue model: malformed');
  const mine = FEATURE_ORDER.join(',');
  const theirs = json.features.join(',');
  if (mine !== theirs) {
    // Loud on purpose: a mismatch means the model is being fed different numbers than it
    // was trained on, and every score would be quietly wrong.
    throw new Error(`clue model: feature mismatch.\n  model: ${theirs}\n  code:  ${mine}`);
  }
  return {
    ...json,
    featureIdx: Int32Array.from(json.featureIdx),
    threshold: Float64Array.from(json.threshold),
    left: Int32Array.from(json.left),
    right: Int32Array.from(json.right),
    value: Float64Array.from(json.value),
    missingGoesLeft: Uint8Array.from(json.missingGoesLeft),
    roots: Int32Array.from(json.roots),
  };
}

function walk(m, root, f) {
  let i = root;
  for (;;) {
    const fi = m.featureIdx[i];
    if (fi < 0) return m.value[i];
    const v = f[fi];
    // NaN means the feature is unavailable, not zero — the trained direction decides.
    i = Number.isNaN(v)
      ? (m.missingGoesLeft[i] ? m.left[i] : m.right[i])
      : (v <= m.threshold[i] ? m.left[i] : m.right[i]);
  }
}

/** Predicted difficulty on the absolute 0..1 scale. */
export function scoreFeatures(model, features) {
  let sum = model.baseline;
  for (let t = 0; t < model.roots.length; t++) sum += walk(model, model.roots[t], features);
  return Math.max(0, Math.min(1, sum));
}

export function scoreClue(model, word, clueText, answer) {
  return scoreFeatures(model, extractFeatures(word, clueText, answer));
}

/**
 * Where a score sits in the shipped corpus, 0..100. The raw scale is absolute but only
 * sparsely populated (only ~5% of answers score below 0.21), so the percentile is what
 * the UI should show — it matches the bands used everywhere else.
 */
export function scorePercentile(quantiles, value) {
  if (value == null) return null;
  if (!quantiles || !quantiles.length) return value * 100;
  let lo = 0;
  let hi = quantiles.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (quantiles[mid] < value) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * Which features moved this clue's score most, for a tooltip. Measured by ablation:
 * re-score with each feature blanked and report the swing.
 */
export function explainClue(model, word, clueText, answer, top = 4) {
  const f = extractFeatures(word, clueText, answer);
  const base = scoreFeatures(model, f);
  const out = [];
  for (let i = 0; i < f.length; i++) {
    if (Number.isNaN(f[i])) continue;
    const saved = f[i];
    f[i] = NaN;
    const delta = scoreFeatures(model, f) - base;
    f[i] = saved;
    if (delta !== 0) out.push({ feature: FEATURE_ORDER[i], value: saved, effect: -delta });
  }
  out.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
  return { score: base, drivers: out.slice(0, top) };
}

/** Pull the four corpus-dependent answer features out of a decoded corpus. */
export function answerFeaturesFrom(corpus, word) {
  const i = corpus?.clueStore?.wordIndexOf?.get(word);
  if (i === undefined) return {};
  const e = corpus.entries[i];
  return {
    corpusFreqLog: e.corpusFreqLog,
    zipf: e.zipf,
    crosswordese: e.crosswordese,
    distinctClues: e.distinctClues,
  };
}
