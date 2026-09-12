"""Clue filters: reject clues that cannot stand alone in a generated puzzle.

Single source of truth for the cross-reference / grid-dependent rules. Mirrored in
JS at src/utils/clueFilters.js as a runtime backstop for user-uploaded CSVs --
keep the two in sync.

Why this exists: the old notebook filter was
    df['Clue'].str.contains('-across|-down', case=False)
which requires a literal hyphen, so "See 60 Across" and "With 74 Across, ..."
survived into public/crosswords.csv (~200 rows). Those clues reference grid
numbers from a DIFFERENT puzzle and are unsolvable in a generated one.
"""
import re

# Clues that point at another entry by grid number.
CROSSREF = [
    # Plurals matter: "Those with 48-Acrosses" and "Like monkeys and 59-Downs" are real
    # cross-references, and a bare \b(?:across|down)\b misses 94 of them in the NYT corpus.
    ("num_dir",      r"\b\d+\s*-?\s*(?:across(?:es)?|down[sz]?)\b"),  # "72-Across", "72 Across", "59-Downs"
    ("see_num",      r"\bsee\s+\d+\b"),                               # "See 60 Across"
    ("num_dir_poss", r"\b\d+\s+(?:across|down)\b['\u2019]?s\b"),      # "22 Across's capital"
    ("anagram_num",  r"\banagram of \d+\b"),
]

# Clues that depend on the physical grid, its theme, or its markings.
GRID_DEPENDENT = [
    ("this_puzzle",  r"\bthis puzzle\b"),
    ("this_grid",    r"\b(?:this|the) grid\b"),
    # "starred" alone would reject "Ming-Na who starred as Mulan" -- require a grid noun.
    ("starred",      r"\bstarred\s+(?:clue|answer|entry|entries|square|word)"),
    ("circled",      r"\bcircled\s+(?:letter|square|word|box)"),
    ("shaded",       r"\bshaded\s+(?:letter|square|word|box)"),
    ("hint_to",      r"\bhint to\b"),
    ("theme_of",     r"\btheme of this\b"),
    ("this_answer",  r"\bthis (?:answer|clue|entry)\b"),
    ("other_answers",r"\b(?:other|remaining)\s+(?:\w+\s+)?(?:answers|entries|clues)\b"),
    ("literally",    r"\bas (?:seen|found|shown|spelled) in (?:this|the) (?:puzzle|grid)\b"),
]

ALL_RULES = [("crossref", n, p) for n, p in CROSSREF] + \
            [("grid", n, p) for n, p in GRID_DEPENDENT]

_COMPILED = [(kind, name, re.compile(pat, re.IGNORECASE)) for kind, name, pat in ALL_RULES]


def reject_reason(clue):
    """Return the rule name that rejects `clue`, or None if it is usable."""
    if not clue:
        return "empty"
    for _kind, name, rx in _COMPILED:
        if rx.search(clue):
            return name
    return None


def is_usable(clue):
    return reject_reason(clue) is None


def rule_names():
    return [name for _k, name, _p in ALL_RULES]
