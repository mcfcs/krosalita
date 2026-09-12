"""Stage 8 -- the cold-start clue scorer, exported for the browser.

s5/s6 score clues that already EXIST in the corpus, using features that describe how often
and when each (answer, clue) pair was published. A clue someone just wrote has none of
that. This trains a second model restricted to what a brand-new clue can actually have, and
exports it small enough to evaluate in the browser with no Ollama and no latency.

Measured on the same labels and the same answer-grouped split:

    full shipped model (32 features, provenance + embeddings)   rho 0.555
    no clue provenance (28)                                     rho 0.527
    no provenance, no embeddings (26)  <- portable to JS        rho 0.509
    same 26 features but only 60 trees at depth 4               rho 0.522

The small model scores BETTER than the 400-tree one -- it overfits less -- and comes to
~1,700 nodes, so the whole thing ships as a ~25 KB JSON.

Two numbers are reported, not one: accuracy with the answer features present (a word the
corpus knows) and with them set to NaN (a word the user invented). The second is the
honest floor for custom dictionaries, and it should be published rather than assumed.

Outputs:
    public/corpus/clue-model.json      the model, for src/utils/clueScore.js
    pipeline/out/feature-parity.json   fixture proving the JS feature code matches this one
"""
import csv, json, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)
import state  # noqa: E402
from s5_fit import _spearman  # noqa: E402

NAME = "s8_coldstart"
PIPE = os.path.dirname(HERE)
ROOT = os.path.dirname(PIPE)
FEATURES = os.path.join(PIPE, "out", "features.csv")
MODEL_OUT = os.path.join(ROOT, "public", "corpus", "clue-model.json")
PARITY_OUT = os.path.join(PIPE, "out", "feature-parity.json")

# Features a clue that has never been published cannot have: every one of them describes
# the publication history of that exact (answer, clue) pair.
PROVENANCE = {"PairCount", "WeekdayMean", "WeekdayLast", "Pre2000Frac"}

# Features describing the ANSWER rather than the clue. Available for corpus answers (they
# ship in corpus.bin), NaN for a word the user invented -- hence the second metric.
ANSWER_FEATURES = {
    "WordLen", "CorpusFreqLog", "ZipfEn", "Crosswordese",
    "VowelRatio", "IsAllCons", "DistinctCluesForWord",
}

PARITY_ROWS = 400
SKIP = {"Word", "Clue"}


def _load():
    import numpy as np

    conn = state.connect()
    labels = {(r["word"], r["clue"]): r["score"]
              for r in conn.execute("SELECT word,clue,score FROM label WHERE pass=1")}
    if len(labels) < 200:
        raise SystemExit(f"only {len(labels)} labels -- run s4_label first")

    keys, X, y, groups = [], [], [], []
    with open(FEATURES, encoding="utf-8", newline="") as f:
        rdr = csv.DictReader(f)
        cols = [c for c in rdr.fieldnames if c not in SKIP and c not in PROVENANCE]
        for row in rdr:
            k = (row["Word"], row["Clue"])
            if k not in labels:
                continue
            vec = []
            for c in cols:
                v = row.get(c)
                try:
                    vec.append(float(v) if v not in (None, "") else np.nan)
                except ValueError:
                    vec.append(np.nan)
            keys.append(k)
            X.append(vec)
            y.append(labels[k] / 100.0)
            groups.append(row["Word"])
    return cols, keys, np.array(X), np.array(y), groups


def _export(model, cols):
    """Flatten sklearn's predictors into plain arrays a JS walker can evaluate.

    Only six node fields matter. `missing_go_to_left` is load-bearing rather than an
    optimisation: ZipfEn is NaN for any answer outside the corpus, so the NaN path is a
    normal case, not an edge case. Verified there are no categorical splits (all features
    are numeric), so bitset handling is not needed.
    """
    import numpy as np

    feat, thr, left, right, value, missing, roots = [], [], [], [], [], [], []
    for stage in model._predictors:           # noqa: SLF001 -- sklearn has no public API
        for pred in stage:
            roots.append(len(feat))
            nodes = pred.nodes
            base = len(feat)
            for nd in nodes:
                leaf = bool(nd["is_leaf"])
                feat.append(-1 if leaf else int(nd["feature_idx"]))
                thr.append(0.0 if leaf else float(nd["num_threshold"]))
                left.append(-1 if leaf else base + int(nd["left"]))
                right.append(-1 if leaf else base + int(nd["right"]))
                value.append(float(nd["value"]) if leaf else 0.0)
                missing.append(1 if (not leaf and nd["missing_go_to_left"]) else 0)
    return {
        "version": 1,
        "baseline": float(np.ravel(model._baseline_prediction)[0]),  # noqa: SLF001
        # The JS extractor asserts this matches its own feature order. Silent drift
        # between the two would feed the model garbage without anything failing.
        "features": cols,
        "answerFeatures": sorted(ANSWER_FEATURES),
        "roots": roots,
        "featureIdx": feat,
        "threshold": [round(t, 6) for t in thr],
        "left": left,
        "right": right,
        "value": [round(v, 7) for v in value],
        "missingGoesLeft": missing,
    }


def run():
    import numpy as np
    from sklearn.ensemble import HistGradientBoostingRegressor

    cols, keys, X, y, groups = _load()
    state.stage_start(NAME, total=len(y), message=f"{len(y):,} rows x {len(cols)} features")

    uniq = sorted(set(groups))
    rng = np.random.default_rng(11)
    rng.shuffle(uniq)
    test_words = set(uniq[: max(1, len(uniq) // 5)])
    te = np.array([g in test_words for g in groups])
    tr = ~te

    model = HistGradientBoostingRegressor(
        max_iter=60, max_depth=4, learning_rate=0.06,
        min_samples_leaf=20, l2_regularization=1.0, random_state=11,
    )
    model.fit(X[tr], y[tr])

    pred = model.predict(X[te])
    rho = _spearman(pred.tolist(), y[te].tolist())
    mae = float(np.mean(np.abs(pred - y[te])) * 100)

    # Same model, answer features blanked: this is what a user's own word gets.
    ans_idx = [i for i, c in enumerate(cols) if c in ANSWER_FEATURES]
    X_cold = X[te].copy()
    X_cold[:, ans_idx] = np.nan
    pred_cold = model.predict(X_cold)
    rho_cold = _spearman(pred_cold.tolist(), y[te].tolist())
    mae_cold = float(np.mean(np.abs(pred_cold - y[te])) * 100)

    bundle = _export(model, cols)
    os.makedirs(os.path.dirname(MODEL_OUT), exist_ok=True)
    with open(MODEL_OUT, "w", encoding="utf-8") as f:
        json.dump(bundle, f, separators=(",", ":"))

    # Parity fixture: the JS side recomputes these features from (word, clue) and must
    # land on the same numbers, and the same predictions.
    step = max(1, len(keys) // PARITY_ROWS)
    sample = list(range(0, len(keys), step))[:PARITY_ROWS]
    parity = {
        "features": cols,
        "rows": [{
            "word": keys[i][0],
            "clue": keys[i][1],
            "values": [None if np.isnan(v) else round(float(v), 6) for v in X[i]],
            "score": round(float(model.predict(X[i:i + 1])[0]), 6),
        } for i in sample],
    }
    with open(PARITY_OUT, "w", encoding="utf-8") as f:
        json.dump(parity, f, separators=(",", ":"))

    size = os.path.getsize(MODEL_OUT)
    metrics = {
        "rows": len(y), "features": len(cols),
        "trees": len(bundle["roots"]), "nodes": len(bundle["featureIdx"]),
        "bytes": size,
        "rho_heldout": round(rho, 4), "mae_points": round(mae, 2),
        "rho_unknown_answer": round(rho_cold, 4), "mae_unknown_answer": round(mae_cold, 2),
        "parity_rows": len(parity["rows"]),
    }
    for k, v in metrics.items():
        state.set_validation(f"s8_{k}", v)

    msg = (f"rho={rho:.3f} (unknown answer {rho_cold:.3f}) · "
           f"{len(bundle['roots'])} trees / {len(bundle['featureIdx']):,} nodes · "
           f"{size/1024:.0f} KB")
    state.stage_done(NAME, msg)
    print(json.dumps(metrics, indent=2))
    print("\n" + msg)
    return metrics


if __name__ == "__main__":
    try:
        run()
    except Exception as e:  # noqa: BLE001
        state.stage_error(NAME, e)
        raise
