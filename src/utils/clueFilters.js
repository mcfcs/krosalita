// Runtime backstop for clues that cannot stand alone in a generated puzzle.
//
// Mirrors pipeline/clue_filters.py — keep the two in sync. The packed corpus is already
// filtered at build time, so this exists for user-uploaded CSVs and for the legacy
// crosswords.csv path, where ~200 unsolvable clues still ship.
//
// Two families:
//   crossref       — points at another entry by grid number ("See 60 Across",
//                    "With 74 Across, ...", "Those with 48-Acrosses"). The number refers
//                    to a DIFFERENT puzzle's grid and is meaningless in a generated one.
//   gridDependent  — depends on the physical grid, its theme, or its markings
//                    ("this puzzle's theme", "the circled letters", "the starred clues").

export const CLUE_FILTER_RULES = [
  // Plurals matter: a bare /\b(?:across|down)\b/ misses 94 real cross-references in the
  // NYT corpus ("Like monkeys and 59-Downs", "Those with 48-Acrosses").
  ['num_dir', /\b\d+\s*-?\s*(?:across(?:es)?|down[sz]?)\b/i],
  ['see_num', /\bsee\s+\d+\b/i],
  ['num_dir_poss', /\b\d+\s+(?:across|down)\b['\u2019]?s\b/i],
  ['anagram_num', /\banagram of \d+\b/i],
  ['this_puzzle', /\bthis puzzle\b/i],
  ['this_grid', /\b(?:this|the) grid\b/i],
  // "starred" alone would reject "Ming-Na who starred as Mulan" — require a grid noun.
  ['starred', /\bstarred\s+(?:clue|answer|entry|entries|square|word)/i],
  ['circled', /\bcircled\s+(?:letter|square|word|box)/i],
  ['shaded', /\bshaded\s+(?:letter|square|word|box)/i],
  ['hint_to', /\bhint to\b/i],
  ['theme_of', /\btheme of this\b/i],
  ['this_answer', /\bthis (?:answer|clue|entry)\b/i],
  ['other_answers', /\b(?:other|remaining)\s+(?:\w+\s+)?(?:answers|entries|clues)\b/i],
  ['literally', /\bas (?:seen|found|shown|spelled) in (?:this|the) (?:puzzle|grid)\b/i],
];

/** The rule that rejects `clue`, or null when it is usable. */
export function clueRejectReason(clue) {
  if (!clue || !clue.trim()) return 'empty';
  for (const [name, rx] of CLUE_FILTER_RULES) if (rx.test(clue)) return name;
  return null;
}

export const isClueUsable = (clue) => clueRejectReason(clue) === null;

/**
 * A clue must not give the answer away, and must not be the answer.
 *
 * Matched on word boundaries, not as a bare substring: KEL is spelled out inside
 * "Kenan's NICKELodeon pal" and OINGO inside "Rock's ___ BOINGO", and rejecting those
 * left both answers with no usable clue at all — which is worse than the leak it was
 * guarding against, since an unclued answer is unsolvable.
 */
export function clueRevealsAnswer(clue, word) {
  if (!clue || !word) return false;
  const c = clue.toUpperCase();
  const w = word.toUpperCase();
  if (c.trim() === w) return true;
  if (w.length < 3) return false;
  return new RegExp(`(^|[^A-Z])${w}([^A-Z]|$)`).test(c);
}

/** Usable for THIS puzzle: passes the filters and doesn't leak the answer. */
export const isClueUsableFor = (clue, word) =>
  isClueUsable(clue) && !clueRevealsAnswer(clue, word);
