"""Stage 7 -- pack the runtime corpus artifact.

Emits public/corpus/corpus.bin, replacing the 24 MB crosswords.csv fetch that parses
into 552k JS objects (~300 MB heap, three copies at peak).

Deliberately does NOT prebuild the bitset index. Building it from the packed word list
costs only ~40-80 ms in the worker, and the worker needs that code path anyway for
user-uploaded CSVs and Tagalog mode -- so there is exactly ONE index builder (in JS)
rather than a Python one that must stay byte-compatible with it.

File layout (all little-endian):

    magic   "KRSC"                                  4 B
    version u32                                     4 B
    hlen    u32                                     4 B
    header  utf-8 JSON, hlen bytes
    --- sections, in header-declared order, each 4-byte aligned ---
    words   per length group: count * len bytes of A-Z ASCII, no separators
    meta    per word, in the same order (13 B):
                u16 score, u16 freq, u8 diff,
                u16 zipf*1000, u16 crosswordese*10000, u16 corpusFreqLog*10000,
                u16 distinctClues
            The last four are the answer-side inputs the browser clue scorer needs
            (src/utils/clueScore.js). Quantised so they round-trip EXACTLY to the values
            the model was trained on -- see s2_features' 3/4-dp rounding.
    cidx    per word: u32 clueOffset, u8 clueCount                      (5 B)
    cblob   per clue: u8 diff, u16 byteLen, utf-8 bytes

`score` is the static quality used for value ordering: log-scaled corpus frequency,
rescaled to 0..65535. Words are emitted in DESCENDING score order within each length
group, which is the invariant the solver relies on -- "top-K candidates" becomes
"first K set bits", an O(K) scan instead of sorting 12k words.

`diff` is 0..255 difficulty. Until s6 lands it is PROVISIONAL: derived from the same
weekday+recurrence signal the old pipeline used, so the app behaves no worse than today
while the LLM-distilled model is still training. manifest.difficultySource says which.
"""
import csv, json, math, os, struct, sys, time
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import state  # noqa: E402

NAME = "s7_pack"
PIPE = os.path.dirname(HERE)
ROOT = os.path.dirname(PIPE)
PAIRS = os.path.join(PIPE, "out", "pairs.csv")
SCORES = os.path.join(PIPE, "out", "scores.csv")          # from s6, optional
OUT_DIR = os.path.join(ROOT, "public", "corpus")
OUT = os.path.join(OUT_DIR, "corpus.bin")

MAX_CLUES_PER_WORD = 5
META_STRIDE = 13   # bytes per word in the meta section; see the layout note above
MIN_LEN, MAX_LEN = 3, 15


def _provisional_difficulty(weekday_mean, pair_count, word_count, pre2000):
    """The OLD signal, kept only until s6 replaces it.

    NYT weekday is the only real difficulty evidence available pre-model: Mon easiest,
    Sat hardest, Sun ~ Thursday. Recurrence shrinks toward neutral because a clue seen
    once carries far less information than one seen forty times.
    """
    wd = weekday_mean if weekday_mean is not None else 3.0
    # Mon0 Tue1 Wed2 Thu3 Fri4 Sat5 Sun6 -> difficulty ramp; Sunday sits near Thursday.
    ramp = [0.00, 0.18, 0.36, 0.54, 0.78, 1.00, 0.50]
    lo, hi = int(math.floor(wd)), min(6, int(math.floor(wd)) + 1)
    frac = wd - lo
    base = ramp[lo] * (1 - frac) + ramp[hi] * frac
    # Pre-2001 puzzles skew hard (dated cluing), but far more weakly than the old
    # pipeline's hard floor of 4.
    base = min(1.0, base + 0.10 * (pre2000 or 0.0))
    # Rarity: a word seen twice in 30 years is harder than one seen 400 times.
    rarity = 1.0 - min(1.0, math.log1p(word_count) / math.log1p(2000))
    raw = 0.72 * base + 0.28 * rarity
    # Confidence shrink toward neutral for thin evidence.
    conf = min(1.0, math.log1p(pair_count) / math.log1p(40))
    return max(0.0, min(1.0, conf * raw + (1 - conf) * 0.5))


def _load_answer_features():
    """Per-answer features the browser scorer needs, keyed by answer.

    Scoring a freshly written clue needs the same answer-side numbers the model saw in
    training. They live in features.csv; this lifts them into the artifact so the browser
    has them without shipping the whole feature table.
    """
    feats = os.path.join(PIPE, "out", "features.csv")
    if not os.path.exists(feats):
        return {}
    out = {}
    with open(feats, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            w = row["Word"]
            if w in out:
                continue
            def num(k, d=0.0):
                v = (row.get(k) or "").strip()
                try:
                    return float(v) if v else d
                except ValueError:
                    return d
            out[w] = (num("ZipfEn"), num("Crosswordese", 0.5),
                      num("CorpusFreqLog"), num("DistinctCluesForWord", 1))
    return out


def _load_word_quality():
    """Per-answer fill quality for the solver's value ordering.

    Raw corpus frequency -- what this used to be -- ranks crosswordese first, because
    ASEA/EPEE/ETUI/OLIO genuinely are among the most frequent crossword entries. Grids
    filled that way are technically valid and miserable to solve.

    Blending in general-English frequency fixes it, but only for SHORT answers: a long
    entry is usually a phrase (DEADASADOORNAIL), which has no English word frequency at
    all, so the penalty is tapered out by length rather than sinking every good long fill.
    """
    feats = os.path.join(PIPE, "out", "features.csv")
    if not os.path.exists(feats):
        return None
    out = {}
    with open(feats, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            w = row["Word"]
            if w in out:
                continue
            z = row.get("ZipfEn") or ""
            out[w] = (float(z) if z else 0.0, float(row.get("Crosswordese") or 0.5))
    return out


def _load_model_scores():
    if not os.path.exists(SCORES):
        return None
    out = {}
    with open(SCORES, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            out[(row["Word"], row["Clue"])] = float(row["Difficulty"])
    return out


def _f(row, key):
    v = (row.get(key) or "").strip()
    if not v:
        return None
    try:
        return float(v)
    except ValueError:
        return None


def run(pairs_path=PAIRS, out=OUT, max_clues=MAX_CLUES_PER_WORD):
    os.makedirs(OUT_DIR, exist_ok=True)
    t0 = time.time()
    state.stage_start(NAME, total=0, message="reading pairs")

    model = _load_model_scores()
    diff_source = "model" if model else "provisional-weekday"

    # word -> list of (difficulty, clue, pair_count, last_date)
    clues = defaultdict(list)
    word_freq = {}
    n = 0
    with open(pairs_path, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            n += 1
            if (n & 16383) == 0:
                state.check_control()
                state.stage_progress(NAME, n, message=f"{len(clues):,} words")
            w, c = row["Word"], row["Clue"]
            pc = int(row["PairCount"] or 1)
            wc = int(row["WordCount"] or 1)
            word_freq[w] = wc
            d = model.get((w, c)) if model else None
            if d is None:
                d = _provisional_difficulty(_f(row, "WeekdayMean"), pc, wc,
                                            _f(row, "Pre2000Frac"))
            clues[w].append((d, c, pc, row.get("LastDate") or ""))

    state.stage_progress(NAME, n, message="selecting clues")

    # Keep the best few clues per word. Rank by recurrence then recency -- the OPPOSITE
    # of today's behaviour, where parseCSV's stable sort over an oldest-first CSV means
    # every word gets its 1993-era clue.
    kept = {}
    for w, lst in clues.items():
        lst.sort(key=lambda t: (-t[2], t[3]), reverse=False)
        lst.sort(key=lambda t: (-t[2], t[3] or "0000-00-00"), reverse=False)
        best = lst[:max_clues]
        best.sort(key=lambda t: t[0])          # store ascending by difficulty
        kept[w] = best

    # Group by length, ordered by DESCENDING static quality score.
    by_len = defaultdict(list)
    for w in kept:
        if MIN_LEN <= len(w) <= MAX_LEN:
            by_len[len(w)].append(w)

    max_freq = max(word_freq.values()) if word_freq else 1
    lf_max = math.log1p(max_freq)
    wq = _load_word_quality()
    afeat = _load_answer_features()
    quality_source = "corpus+english" if wq else "corpus-frequency"

    def quality(w):
        corpus = math.log1p(word_freq.get(w, 1)) / lf_max if lf_max else 0.0
        if not wq:
            return corpus
        z, cwese = wq.get(w, (0.0, 0.5))
        # Taper: full English weighting for short answers (where crosswordese lives),
        # none by 9 letters (where entries are phrases with no zipf at all).
        taper = 1.0 if len(w) <= 5 else max(0.0, (9 - len(w)) / 4.0)
        if z <= 0:
            # Unknown to English frequency: a phrase, a name, or genuinely obscure.
            # Lean on corpus attestation instead of punishing it outright.
            return corpus * (1 - 0.25 * taper)
        zn = min(1.0, z / 6.0)
        return (1 - 0.55 * taper) * corpus + (0.55 * taper) * zn - 0.20 * taper * cwese

    lengths = []
    words_buf = bytearray()
    meta_buf = bytearray()
    cidx_buf = bytearray()
    cblob = bytearray()

    total_words = 0
    for L in sorted(by_len):
        ws = by_len[L]
        ws.sort(key=lambda w: (-quality(w), w))
        lengths.append({"len": L, "count": len(ws), "wordIndex": total_words})
        total_words += len(ws)
        for w in ws:
            words_buf += w.encode("ascii")
            q = int(round(max(0.0, min(1.0, quality(w))) * 65535))
            fr = min(65535, word_freq.get(w, 1))
            cl = kept[w]
            wd = int(round(sum(c[0] for c in cl) / len(cl) * 255)) if cl else 128
            z, cw, cfl, dc = afeat.get(w, (0.0, 0.5, 0.0, 1.0))
            meta_buf += struct.pack(
                "<HHBHHHH", q, fr, max(0, min(255, wd)),
                max(0, min(65535, int(round(z * 1000)))),
                max(0, min(65535, int(round(cw * 10000)))),
                max(0, min(65535, int(round(cfl * 10000)))),
                max(0, min(65535, int(round(dc)))))
            cidx_buf += struct.pack("<IB", len(cblob), len(cl))
            for d, c, _pc, _dt in cl:
                b = c.encode("utf-8")
                if len(b) > 65535:
                    b = b[:65535]
                cblob += struct.pack("<BH", max(0, min(255, int(round(d * 255)))), len(b))
                cblob += b

    def pad(buf):
        return buf + b"\x00" * ((-len(buf)) % 4)

    words_buf, meta_buf, cidx_buf, cblob = map(pad, (words_buf, meta_buf, cidx_buf, cblob))

    # Difficulty quantiles over the answers actually shipped. The nominal 0-100 scale is
    # absolute (and stays that way for display), but it is NOT uniformly populated: only
    # ~5% of answers score below 21, so a 78-entry grid can never average 10 no matter
    # how the solver is steered. Asking for "easy" has to mean "the easiest this corpus
    # can do", and that needs the real distribution, not the nominal range.
    diffs = sorted(int(meta_buf[i * META_STRIDE + 4]) / 255 for i in range(total_words))
    quantiles = [round(diffs[min(len(diffs) - 1, int(len(diffs) * q / 100))], 5)
                 for q in range(101)] if diffs else []

    header = {
        "version": 2,
        "metaStride": META_STRIDE,
        "createdAt": int(time.time()),
        "difficultyQuantiles": quantiles,
        "difficultySource": diff_source,
        "qualitySource": quality_source,
        "maxCluesPerWord": max_clues,
        "totalWords": total_words,
        "lengths": lengths,
        "sections": {},
    }
    # Offsets are relative to the end of the header; two passes because the header's own
    # length depends on the numbers it carries.
    for _ in range(2):
        off = 0
        secs = {}
        for nm, buf in (("words", words_buf), ("meta", meta_buf),
                        ("cidx", cidx_buf), ("cblob", cblob)):
            secs[nm] = {"offset": off, "length": len(buf)}
            off += len(buf)
        header["sections"] = secs
        hjson = json.dumps(header, separators=(",", ":")).encode("utf-8")
        hjson += b" " * ((-len(hjson)) % 4)

    with open(out, "wb") as f:
        f.write(b"KRSC")
        f.write(struct.pack("<II", 2, len(hjson)))
        f.write(hjson)
        for buf in (words_buf, meta_buf, cidx_buf, cblob):
            f.write(buf)

    size = os.path.getsize(out)
    manifest = {
        "version": 1,
        "file": "corpus.bin",
        "bytes": size,
        "totalWords": total_words,
        "totalClues": sum(len(v) for v in kept.values()),
        "difficultySource": diff_source,
        "qualitySource": quality_source,
        "maxCluesPerWord": max_clues,
        "byLength": {str(d["len"]): d["count"] for d in lengths},
        "difficultyQuantiles": quantiles,
        "createdAt": header["createdAt"],
    }
    with open(os.path.join(OUT_DIR, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2)

    msg = (f"{total_words:,} words, {manifest['totalClues']:,} clues, "
           f"{size/1e6:.2f} MB, difficulty={diff_source}, quality={quality_source} "
           f"({time.time()-t0:.0f}s)")
    state.set_validation("s7_bytes", size)
    state.set_validation("s7_words", total_words)
    state.set_validation("s7_difficulty_source", diff_source)
    state.stage_done(NAME, msg)
    print(msg)
    print("sections:", {k: v["length"] for k, v in header["sections"].items()})
    return manifest


if __name__ == "__main__":
    run()
