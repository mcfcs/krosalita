"""Stage 6 -- score every (Word, Clue) pair with the distilled model.

Output: pipeline/out/scores.csv  (Word, Clue, Difficulty 0..1)

The scale is ABSOLUTE. The old pipeline percentile-ranked within each word length and cut
quintiles, which forced exactly 20% of every length into "EASY" and 20% into "DIFFICULT"
whether or not they were -- so "easy" meant "easier than other 11-letter answers", not
easy. Here 0.1 means Monday and 0.9 means Saturday, whatever the length.

s7_pack picks this file up automatically and stamps difficultySource=model.
"""
import csv, os, pickle, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import state  # noqa: E402

NAME = "s6_score"
PIPE = os.path.dirname(HERE)
FEATURES = os.path.join(PIPE, "out", "features.csv")
EMBED = os.path.join(PIPE, "out", "embed.csv")
MODEL_IN = os.path.join(PIPE, "out", "difficulty_model.pkl")
OUT = os.path.join(PIPE, "out", "scores.csv")

CHUNK = 50000
SKIP = {"Word", "Clue"}


def run():
    import numpy as np

    if not os.path.exists(MODEL_IN):
        raise SystemExit("no model — run s5_fit first")
    with open(MODEL_IN, "rb") as f:
        bundle = pickle.load(f)
    model, feat_names = bundle["model"], bundle["features"]

    total = sum(1 for _ in open(FEATURES, encoding="utf-8")) - 1
    state.stage_start(NAME, total=total, message="loading embeddings")

    cos = {}
    if os.path.exists(EMBED):
        with open(EMBED, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                cos[(r["Word"], r["Clue"])] = (float(r["CosClueAnswer"]),
                                               float(r["CosClueCentroid"]))

    t0 = time.time()
    n = 0
    with open(FEATURES, encoding="utf-8", newline="") as fin, \
         open(OUT, "w", encoding="utf-8", newline="") as fout:
        rdr = csv.DictReader(fin)
        cols = [c for c in rdr.fieldnames if c not in SKIP]
        w = csv.writer(fout)
        w.writerow(["Word", "Clue", "Difficulty"])

        batch_rows, batch_X = [], []

        def flush():
            nonlocal batch_rows, batch_X, n
            if not batch_rows:
                return
            preds = model.predict(np.array(batch_X, dtype=np.float64))
            for (word, clue), p in zip(batch_rows, preds):
                w.writerow([word, clue, round(float(min(1.0, max(0.0, p))), 4)])
            n += len(batch_rows)
            batch_rows, batch_X = [], []
            state.stage_progress(NAME, n, message=f"{n/max(1e-9, time.time()-t0):.0f} rows/s")

        for row in rdr:
            state.check_control()
            vec = []
            for c in cols:
                v = row.get(c)
                try:
                    vec.append(float(v) if v not in (None, "") else np.nan)
                except ValueError:
                    vec.append(np.nan)
            ca, cc = cos.get((row["Word"], row["Clue"]), (np.nan, np.nan))
            vec.extend([ca, cc])
            batch_rows.append((row["Word"], row["Clue"]))
            batch_X.append(vec)
            if len(batch_rows) >= CHUNK:
                flush()
        flush()

    msg = f"{n:,} pairs scored ({time.time()-t0:.0f}s) -> {os.path.basename(OUT)}"
    state.set_validation("s6_scored", n)
    state.stage_done(NAME, msg)
    print(msg)
    print("next: python pipeline/stages/s7_pack.py   (picks up scores.csv automatically)")
    return {"scored": n}


if __name__ == "__main__":
    try:
        run()
    except Exception as e:  # noqa: BLE001
        state.stage_error(NAME, e)
        raise
