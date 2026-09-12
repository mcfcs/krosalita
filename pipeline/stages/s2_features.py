"""Stage 2 -- hand-built features for every (Word, Clue) pair.

These are the inputs the distilled difficulty model (s5) learns from. The old pipeline
had effectively two signals -- publication weekday and recurrence counts -- and nothing
at all from the clue text. Both are kept here as FEATURES; neither is the label any more.

The single most valuable addition is the crosswordese score:

    crosswordese = (how often this answer appears in crosswords)
                 - (how common the word is in ordinary English)

ERNE, ETUI, ANOA and ESNE are frequent in crossword grids and near-absent from English
(zipf 2.12, 1.21, 1.19, 0.00), while IDEA, AREA and APPLE are common in both (5.36, 5.46,
4.76). Corpus frequency alone cannot tell those apart -- which is exactly why the old
"ease by appearance" term rated crosswordese as easy, and why the solver, ranking answers
by raw corpus frequency, fills grids with it.

Output: pipeline/out/features.csv
"""
import csv, math, os, re, sys, time
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import state  # noqa: E402

NAME = "s2_features"
PIPE = os.path.dirname(HERE)
IN = os.path.join(PIPE, "out", "pairs.csv")
OUT = os.path.join(PIPE, "out", "features.csv")

try:
    from wordfreq import zipf_frequency
except ImportError:  # degrade rather than fail; the model just loses its best feature
    zipf_frequency = None

# Clue-surface markers. Each is a genuine signal a crossword editor uses on purpose.
#
# re.ASCII on every one of these is load-bearing, not tidiness: JavaScript's , \w and
# \d are ASCII-only while Python 3's are Unicode-aware, and the browser scorer
# (src/utils/clueScore.js) must compute byte-identical features or it feeds the model
# numbers it never trained on. Measured before the fix: 294 of 551,653 clues where
# ProperNounCount differed between the two, all around curly quotes and accents.
A = re.ASCII
MARKERS = [
    ("q_wordplay",  re.compile(r"\?\s*$", A)),                       # "?" = wordplay, harder
    ("fitb",        re.compile(r"_{2,}|\b___\b", A)),                # fill-in-the-blank, easier
    ("abbr",        re.compile(r":\s*Abbr\.?|,\s*for short|,\s*in brief|\bacronym\b", re.I | A)),
    ("variant",     re.compile(r":\s*Var\.?|\bvar\.\b", re.I | A)),
    ("by_example",  re.compile(r",\s*e\.g\.|\bperhaps\b|\bmaybe\b|\bsay\b\s*$|\bfor one\b", re.I | A)),
    ("quoted",      re.compile(r'"[^"]{2,}"', A)),
    ("foreign",     re.compile(r"\bin (?:Paris|Spain|France|Italy|Germany|Rome|Madrid)\b"
                               r"|\b(?:French|Spanish|German|Italian|Latin|Greek) (?:for|word)\b"
                               r"|:\s*(?:Fr|Sp|Ger|It|Lat)\.", re.I | A)),
    ("year",        re.compile(r"\b(?:1[5-9]\d{2}|20[0-2]\d)\b", A)),  # trivia anchor
    ("prefix_sfx",  re.compile(r"\b(?:prefix|suffix|combining form)\b", re.I | A)),
    ("brand_name",  re.compile(r"\b(?:brand|maker|company|co\.|inc\.)\b", re.I | A)),
    ("roman",       re.compile(r"\bRoman numeral|\bin Roman\b", re.I | A)),
    ("crossword_of",re.compile(r"\bpartner\b|\bcompanion\b|\bfollower\b|\bword (?:before|after)\b", re.I | A)),
]

DIGIT = re.compile(r"[0-9]", A)
CAP_WORD = re.compile(r"\b[A-Z][a-z]{2,}", A)
TOKEN = re.compile(r"[A-Za-z']+", A)


def _f(row, key, default=None):
    v = (row.get(key) or "").strip()
    if not v:
        return default
    try:
        return float(v)
    except ValueError:
        return default


def run(src=IN, out=OUT):
    if not os.path.exists(src):
        raise SystemExit(f"missing {src} -- run s1_clean first")

    total = sum(1 for _ in open(src, encoding="utf-8")) - 1
    state.stage_start(NAME, total=total, message="scoring clue + answer features")
    t0 = time.time()

    # Pass 1: corpus frequency per answer (needed to normalise crosswordese).
    word_rows = defaultdict(int)
    with open(src, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            word_rows[row["Word"]] += int(row["PairCount"] or 1)
    max_rows = max(word_rows.values()) if word_rows else 1
    log_max = math.log1p(max_rows)

    zipf_cache = {}

    def zipf(w):
        if zipf_frequency is None:
            return None
        v = zipf_cache.get(w)
        if v is None:
            v = zipf_frequency(w.lower(), "en")
            zipf_cache[w] = v
        return v

    cols = [
        "Word", "Clue",
        # answer
        "WordLen", "CorpusFreqLog", "ZipfEn", "Crosswordese", "VowelRatio",
        "IsAllCons", "DistinctCluesForWord",
        # clue surface
        "ClueChars", "ClueTokens", "ClueAvgTokenLen", "SingleWordClue",
        "ProperNounCount", "ProperNounDensity", "ClueHasDigit",
        # provenance (features, NOT the label)
        "PairCount", "WeekdayMean", "WeekdayLast", "Pre2000Frac",
    ] + [m[0] for m in MARKERS]

    n = 0
    with open(src, encoding="utf-8", newline="") as fin, \
         open(out, "w", encoding="utf-8", newline="") as fout:
        w = csv.writer(fout)
        w.writerow(cols)
        for row in csv.DictReader(fin):
            n += 1
            if (n & 16383) == 0:
                state.check_control()
                state.stage_progress(NAME, n)

            word, clue = row["Word"], row["Clue"]
            L = len(word)
            cf = word_rows.get(word, 1)
            cf_log = math.log1p(cf) / log_max if log_max else 0.0
            z = zipf(word)
            # Both terms on a 0..1 scale; positive means "crosswords like it more than
            # English does". ESNE ~ 1.0, IDEA ~ 0.
            zn = (z / 7.0) if z is not None else 0.5
            crosswordese = max(0.0, min(1.0, cf_log - zn + 0.5))

            vowels = sum(1 for ch in word if ch in "AEIOU")
            tokens = TOKEN.findall(clue)
            ntok = len(tokens)
            proper = len(CAP_WORD.findall(clue))

            rec = [
                word, clue,
                L, round(cf_log, 4),
                "" if z is None else round(z, 3),
                round(crosswordese, 4),
                round(vowels / L, 4) if L else 0,
                1 if vowels == 0 else 0,
                row.get("DistinctCluesForWord") or 1,
                len(clue), ntok,
                round(sum(len(t) for t in tokens) / ntok, 3) if ntok else 0,
                1 if ntok <= 1 else 0,
                proper,
                round(proper / ntok, 4) if ntok else 0,
                1 if DIGIT.search(clue) else 0,
                row.get("PairCount") or 1,
                row.get("WeekdayMean") or "",
                row.get("WeekdayLast") or "",
                row.get("Pre2000Frac") or 0,
            ]
            for _name, rx in MARKERS:
                rec.append(1 if rx.search(clue) else 0)
            w.writerow(rec)

    msg = f"{n:,} pairs featurised, {len(zipf_cache):,} answers looked up ({time.time()-t0:.0f}s)"
    if zipf_frequency is None:
        msg += " -- WARNING: wordfreq missing, Crosswordese degraded"
    state.set_validation("s2_pairs", n)
    state.stage_done(NAME, msg)
    print(msg)
    return {"pairs": n, "out": out}


if __name__ == "__main__":
    run()
