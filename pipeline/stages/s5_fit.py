"""Stage 5 -- distil the LLM's judgement into a model that can score all 551k pairs.

Running qwen3.5:27b over the whole corpus would take weeks. Instead s4 labels a
stratified ~12k sample and this fits a gradient-boosted regressor over the cheap features
from s2 (+ s3), which then scores everything in seconds.

The split is GROUPED BY ANSWER, so the same word never appears in both train and test.
Without that, the model can memorise "ERNE is hard" from the training half and look far
better than it is.

Three numbers decide whether this is actually an improvement, and all three are reported:
  * rho vs held-out LLM labels    -- did the distillation work?
  * rho vs the source puzzle's WEEKDAY -- an INDEPENDENT check. Weekday is never a
    feature target, so agreeing with it means the model learned real difficulty rather
    than the labeller's quirks.
  * rho of the OLD weekday+recurrence formula against the same held-out labels -- the
    baseline this has to beat to be worth shipping.

Also reports test-retest agreement on s4's re-labelled slice: that is the noise floor,
and no model can beat it.
"""
import csv, json, math, os, pickle, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import state  # noqa: E402

NAME = "s5_fit"
PIPE = os.path.dirname(HERE)
FEATURES = os.path.join(PIPE, "out", "features.csv")
EMBED = os.path.join(PIPE, "out", "embed.csv")
MODEL_OUT = os.path.join(PIPE, "out", "difficulty_model.pkl")

# Columns fed to the model. Word/Clue are identifiers; everything else is numeric.
SKIP = {"Word", "Clue"}


def _spearman(a, b):
    n = len(a)
    if n < 3:
        return float("nan")

    def ranks(v):
        order = sorted(range(n), key=lambda i: v[i])
        r = [0.0] * n
        i = 0
        while i < n:
            j = i
            while j + 1 < n and v[order[j + 1]] == v[order[i]]:
                j += 1
            avg = (i + j) / 2.0 + 1
            for k in range(i, j + 1):
                r[order[k]] = avg
            i = j + 1
        return r

    ra, rb = ranks(a), ranks(b)
    ma, mb = sum(ra) / n, sum(rb) / n
    num = sum((x - ma) * (y - mb) for x, y in zip(ra, rb))
    da = math.sqrt(sum((x - ma) ** 2 for x in ra))
    db = math.sqrt(sum((y - mb) ** 2 for y in rb))
    return num / (da * db) if da and db else float("nan")


def _old_formula(row):
    """The pipeline this replaces: weekday ramp + recurrence, nothing from the clue."""
    try:
        wd = float(row.get("WeekdayMean") or 3)
    except ValueError:
        wd = 3.0
    ramp = [0.0, 0.18, 0.36, 0.54, 0.78, 1.0, 0.5]
    lo = max(0, min(6, int(wd)))
    hi = min(6, lo + 1)
    base = ramp[lo] * (1 - (wd - lo)) + ramp[hi] * (wd - lo)
    try:
        pc = float(row.get("PairCount") or 1)
    except ValueError:
        pc = 1.0
    rarity = 1.0 - min(1.0, math.log1p(pc) / math.log1p(40))
    return 0.75 * base + 0.25 * rarity


def run():
    import numpy as np
    from sklearn.ensemble import HistGradientBoostingRegressor
    from sklearn.inspection import permutation_importance

    conn = state.connect()
    labels = {(r["word"], r["clue"]): r["score"]
              for r in conn.execute("SELECT word,clue,score FROM label WHERE pass=1")}
    if len(labels) < 200:
        raise SystemExit(f"only {len(labels)} labels — run s4_label first")

    state.stage_start(NAME, total=len(labels), message="joining features")

    cos = {}
    if os.path.exists(EMBED):
        with open(EMBED, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                cos[(r["Word"], r["Clue"])] = (float(r["CosClueAnswer"]),
                                               float(r["CosClueCentroid"]))

    feat_names, X, y, groups, weekday, old = None, [], [], [], [], []
    with open(FEATURES, encoding="utf-8", newline="") as f:
        rdr = csv.DictReader(f)
        cols = [c for c in rdr.fieldnames if c not in SKIP]
        feat_names = cols + ["CosClueAnswer", "CosClueCentroid"]
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
            ca, cc = cos.get(k, (np.nan, np.nan))
            vec.extend([ca, cc])
            X.append(vec)
            y.append(labels[k] / 100.0)
            groups.append(row["Word"])
            try:
                weekday.append(float(row.get("WeekdayLast") or row.get("WeekdayMean") or 3))
            except ValueError:
                weekday.append(3.0)
            old.append(_old_formula(row))

    X = np.array(X, dtype=np.float64)
    y = np.array(y, dtype=np.float64)
    if len(y) < 200:
        raise SystemExit(f"only {len(y)} labelled rows joined to features")

    state.stage_progress(NAME, len(y), message=f"fitting on {len(y):,} rows × {X.shape[1]} features")

    # Grouped split by answer.
    uniq = sorted(set(groups))
    rng = np.random.default_rng(11)
    rng.shuffle(uniq)
    test_words = set(uniq[: max(1, len(uniq) // 5)])
    te = np.array([g in test_words for g in groups])
    tr = ~te

    model = HistGradientBoostingRegressor(
        max_iter=400, learning_rate=0.06, max_depth=None,
        min_samples_leaf=20, l2_regularization=1.0, random_state=11,
    )
    model.fit(X[tr], y[tr])
    pred = model.predict(X[te])

    yt = y[te].tolist()
    rho_llm = _spearman(pred.tolist(), yt)
    mae = float(np.mean(np.abs(pred - y[te])) * 100)
    wd_te = [weekday[i] for i in range(len(weekday)) if te[i]]
    old_te = [old[i] for i in range(len(old)) if te[i]]
    rho_weekday_model = _spearman(pred.tolist(), wd_te)
    rho_weekday_llm = _spearman(yt, wd_te)
    rho_old_llm = _spearman(old_te, yt)

    # Test-retest noise floor from s4's second pass.
    p1 = {r["word"] + "␟" + r["clue"]: r["score"]
          for r in conn.execute("SELECT word,clue,score FROM label WHERE pass=1")}
    p2 = [(r["word"] + "␟" + r["clue"], r["score"])
          for r in conn.execute("SELECT word,clue,score FROM label WHERE pass=2")]
    pairs = [(p1[k], v) for k, v in p2 if k in p1]
    rho_retest = _spearman([a for a, _ in pairs], [b for _, b in pairs]) if len(pairs) > 10 else None

    try:
        imp = permutation_importance(model, X[te], y[te], n_repeats=4, random_state=11)
        top = sorted(zip(feat_names, imp.importances_mean), key=lambda t: -t[1])[:12]
    except Exception:  # noqa: BLE001
        top = []

    with open(MODEL_OUT, "wb") as f:
        pickle.dump({"model": model, "features": feat_names}, f)

    metrics = {
        "rows": len(y), "features": X.shape[1],
        "train": int(tr.sum()), "test": int(te.sum()),
        "rho_vs_llm_heldout": round(rho_llm, 4),
        "mae_points": round(mae, 2),
        "rho_vs_weekday_model": round(rho_weekday_model, 4),
        "rho_vs_weekday_llm": round(rho_weekday_llm, 4),
        "rho_vs_llm_OLD_formula": round(rho_old_llm, 4),
        "rho_label_retest": None if rho_retest is None else round(rho_retest, 4),
        "top_features": [[n, round(v, 5)] for n, v in top],
    }
    for k, v in metrics.items():
        state.set_validation(f"s5_{k}", v)

    msg = (f"rho(model,LLM)={rho_llm:.3f} vs old formula {rho_old_llm:.3f} · "
           f"MAE {mae:.1f}pts · rho(model,weekday)={rho_weekday_model:.3f}")
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
