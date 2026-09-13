"""Stage 1 -- clean.

Reads the RAW corpus (pipeline/data/nytcrosswordspure.csv, 781,573 rows) rather than the
already-processed crosswords.csv, so the broken cross-reference filter is redone from
scratch instead of patched.

What it fixes versus the old notebook pipeline:
  * Real CSV parsing. crosswordUtils.parseCSV strips every quote character, destroying
    meaningful quotation marks in 57,861 rows -- e.g. the clue
        Action done while saying <doubled-quote>Good dog<doubled-quote>
    loses its quoted speech. csv.DictReader unescapes doubled quotes correctly.
  * clue_filters instead of str.contains('-across|-down'), which missed every
    space-separated and plural cross-reference (~9,996 rows total, vs ~200 caught before).
  * Keeps ALL distinct (Word, Clue) pairs with their occurrence counts and date spread.
    The old pipeline collapsed to one row per pair and then discarded every count at
    export, leaving the runtime unable to prefer a common clue over a one-off.

Output: pipeline/out/pairs.csv
    Word, Clue, PairCount, WordCount, FirstDate, LastDate,
    WeekdayMean, WeekdayLast, Pre2000Frac, DistinctCluesForWord

The weekday columns are the OLD difficulty signal. They are kept as *features* for the
model in s5 -- never again as the label.
"""
import csv, os, sys, time
from collections import defaultdict
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import state                      # noqa: E402
from clue_filters import reject_reason  # noqa: E402

NAME = "s1_clean"
ROOT = os.path.dirname(os.path.dirname(HERE))
# Lives in pipeline/data/, NOT public/: everything under public/ is copied into dist/ and
# deployed, so a 28 MB raw scrape sitting there was being served from the live site. The
# old location is still accepted so an existing checkout keeps working.
SRC = os.path.join(ROOT, "pipeline", "data", "nytcrosswordspure.csv")
if not os.path.exists(SRC):
    _legacy = os.path.join(ROOT, "public", "nytcrosswordspure.csv")
    if os.path.exists(_legacy):
        SRC = _legacy
OUT_DIR = os.path.join(os.path.dirname(HERE), "out")
OUT = os.path.join(OUT_DIR, "pairs.csv")

MIN_LEN, MAX_LEN = 3, 15


def _parse_date(s):
    s = (s or "").strip()
    for fmt in ("%m/%d/%Y", "%Y-%m-%d", "%m/%d/%y"):
        try:
            return datetime.strptime(s, fmt)
        except ValueError:
            pass
    return None


def _count_rows(path):
    with open(path, "rb") as f:
        return max(0, sum(buf.count(b"\n") for buf in iter(lambda: f.read(1 << 20), b"")) - 1)


def run(src=SRC, out=OUT, limit=None):
    os.makedirs(OUT_DIR, exist_ok=True)
    total = _count_rows(src)
    state.stage_start(NAME, total=total, message=f"reading {os.path.basename(src)}")
    conn = state.connect()
    conn.execute("DELETE FROM filter_drop")

    drops = defaultdict(int)
    drop_sample = {}
    # (word, clue) -> [n, first_dt, last_dt, weekday_sum, weekday_last, pre2000_n]
    pairs = {}
    word_n = defaultdict(int)
    word_clues = defaultdict(set)

    kept_rows = skipped_word = skipped_same = 0
    t0 = time.time()

    with open(src, encoding="latin-1", newline="") as f:
        for i, row in enumerate(csv.DictReader(f)):
            if limit and i >= limit:
                break
            if (i & 8191) == 0:
                state.check_control()
                state.stage_progress(NAME, i, message=f"{len(pairs):,} pairs kept")

            word = (row.get("Word") or "").strip().upper()
            clue = (row.get("Clue") or "").strip()

            if not word.isalpha() or not (MIN_LEN <= len(word) <= MAX_LEN):
                skipped_word += 1
                continue
            if not clue:
                drops["empty"] += 1
                continue
            # A clue that IS the answer teaches nothing and breaks the solve.
            if clue.strip().upper() == word:
                skipped_same += 1
                continue

            reason = reject_reason(clue)
            if reason:
                drops[reason] += 1
                drop_sample.setdefault(reason, f"{word}: {clue}")
                continue

            dt = _parse_date(row.get("Date"))
            wd = dt.weekday() if dt else None      # Mon=0 .. Sun=6
            pre2000 = 1 if (dt and dt.year < 2001) else 0

            kept_rows += 1
            word_n[word] += 1
            word_clues[word].add(clue)

            k = (word, clue)
            rec = pairs.get(k)
            if rec is None:
                pairs[k] = [1, dt, dt, (wd if wd is not None else 0),
                            (wd if wd is not None else -1), pre2000,
                            1 if wd is not None else 0]
            else:
                rec[0] += 1
                if dt:
                    if rec[1] is None or dt < rec[1]:
                        rec[1] = dt
                    if rec[2] is None or dt > rec[2]:
                        rec[2] = dt
                        if wd is not None:
                            rec[4] = wd
                if wd is not None:
                    rec[3] += wd
                    rec[6] += 1
                rec[5] += pre2000

    state.stage_progress(NAME, total, message=f"writing {len(pairs):,} pairs")

    with open(out, "w", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        w.writerow(["Word", "Clue", "PairCount", "WordCount", "FirstDate", "LastDate",
                    "WeekdayMean", "WeekdayLast", "Pre2000Frac", "DistinctCluesForWord"])
        for (word, clue), r in sorted(pairs.items()):
            n, first, last, wsum, wlast, pre, wn = r
            w.writerow([
                word, clue, n, word_n[word],
                first.strftime("%Y-%m-%d") if first else "",
                last.strftime("%Y-%m-%d") if last else "",
                round(wsum / wn, 3) if wn else "",
                wlast if wlast >= 0 else "",
                round(pre / n, 3),
                len(word_clues[word]),
            ])

    for rule, n in sorted(drops.items(), key=lambda kv: -kv[1]):
        conn.execute("INSERT INTO filter_drop(rule,n,sample) VALUES(?,?,?)",
                     (rule, n, drop_sample.get(rule, "")))

    dropped = sum(drops.values())
    summary = (f"{len(pairs):,} pairs / {len(word_n):,} words from {kept_rows:,} rows; "
               f"dropped {dropped:,} by filter, {skipped_word:,} bad answers, "
               f"{skipped_same:,} clue==answer ({time.time()-t0:.0f}s)")
    state.set_validation("s1_rows_in", total)
    state.set_validation("s1_pairs_out", len(pairs))
    state.set_validation("s1_words_out", len(word_n))
    state.set_validation("s1_filter_dropped", dropped)
    state.stage_done(NAME, summary)
    print(summary)
    return {"pairs": len(pairs), "words": len(word_n), "dropped": dropped, "out": out}


if __name__ == "__main__":
    run()
