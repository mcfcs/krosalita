"""Stage 3 -- semantic features from a local embedding model.

Adds the one thing no hand-written rule captures: how DIRECTLY a clue points at its
answer. A plain definition ("Sandwich cookie" -> OREO) sits close in embedding space; a
wordplay or trivia clue ("Fire place?" -> HELL) sits far away. That distance separates
Monday cluing from Saturday cluing for the *same* answer, which the weekday signal
fundamentally cannot do -- weekday is a property of the puzzle, not of the clue.

Two features per (Word, Clue):
    CosClueAnswer    cosine(clue, answer). High = direct definition = easier.
    CosClueCentroid  cosine(clue, mean of all this answer's clues). Low = an unusual
                     angle on a familiar word = harder.

Runs against Ollama on localhost (qwen3-embedding:0.6b, 1024-dim, ~64 texts/sec warm),
so the whole corpus takes roughly 2.5h. Embeddings are NEVER stored -- 551k x 1024 x f32
would be 2.2 GB -- only the two derived scalars. Work is grouped by answer so a word and
its clues are embedded together and discarded immediately.

Resumable: --resume skips answers already written.
"""
import argparse, csv, json, math, os, sys, time, urllib.error, urllib.request
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import state  # noqa: E402

NAME = "s3_embed"
PIPE = os.path.dirname(HERE)
IN = os.path.join(PIPE, "out", "pairs.csv")
OUT = os.path.join(PIPE, "out", "embed.csv")

DEFAULT_URL = "http://localhost:11434"
DEFAULT_MODEL = "qwen3-embedding:0.6b"
BATCH_TEXTS = 64


def embed(base_url, model, texts, timeout=180, retries=4):
    body = json.dumps({"model": model, "input": texts}).encode()
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(f"{base_url.rstrip('/')}/api/embed", data=body,
                                         headers={"Content-Type": "application/json"})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                out = json.loads(r.read())
            vecs = out.get("embeddings")
            if not vecs or len(vecs) != len(texts):
                raise ValueError(f"expected {len(texts)} vectors, got {len(vecs) if vecs else 0}")
            return vecs
        except Exception as e:  # noqa: BLE001 -- network flakiness is expected overnight
            last = e
            time.sleep(min(30, 2 ** attempt))
    raise RuntimeError(f"embedding failed after {retries} tries: {last}")


def _norm(v):
    n = math.sqrt(sum(x * x for x in v))
    return n or 1.0


def _cos(a, b, na=None, nb=None):
    na = na or _norm(a)
    nb = nb or _norm(b)
    return sum(x * y for x, y in zip(a, b)) / (na * nb)


def run(src=IN, out=OUT, base_url=DEFAULT_URL, model=DEFAULT_MODEL, resume=True, limit=None):
    if not os.path.exists(src):
        raise SystemExit(f"missing {src} -- run s1_clean first")

    by_word = defaultdict(list)
    with open(src, encoding="utf-8", newline="") as f:
        for row in csv.DictReader(f):
            by_word[row["Word"]].append(row["Clue"])

    done_words = set()
    if resume and os.path.exists(out):
        with open(out, encoding="utf-8", newline="") as f:
            for row in csv.DictReader(f):
                done_words.add(row["Word"])

    words = [w for w in sorted(by_word) if w not in done_words]
    if limit:
        words = words[:limit]
    total_pairs = sum(len(by_word[w]) for w in words)
    already = sum(len(by_word[w]) for w in done_words if w in by_word)

    state.stage_start(NAME, total=total_pairs + already,
                      message=f"{model} @ {base_url} · {len(words):,} answers to go")
    t0 = time.time()
    written = already

    mode = "a" if (resume and os.path.exists(out)) else "w"
    with open(out, mode, encoding="utf-8", newline="") as fout:
        w = csv.writer(fout)
        if mode == "w":
            w.writerow(["Word", "Clue", "CosClueAnswer", "CosClueCentroid"])

        jobs, ntexts = [], 0

        def flush():
            nonlocal jobs, ntexts, written
            if not jobs:
                return
            texts = []
            for word, clues in jobs:
                texts.append(word.capitalize())   # a bare uppercase token embeds poorly
                texts.extend(clues)
            vecs = embed(base_url, model, texts)
            k = 0
            for word, clues in jobs:
                wv = vecs[k]; k += 1
                cvs = vecs[k:k + len(clues)]; k += len(clues)
                wn = _norm(wv)
                cns = [_norm(c) for c in cvs]
                dim = len(wv)
                centroid = [sum(c[i] for c in cvs) / len(cvs) for i in range(dim)]
                cen_n = _norm(centroid)
                for clue, cv, cn in zip(clues, cvs, cns):
                    w.writerow([word, clue,
                                round(_cos(cv, wv, cn, wn), 5),
                                round(_cos(cv, centroid, cn, cen_n), 5)])
                written += len(clues)
            fout.flush()
            jobs, ntexts = [], 0
            state.stage_progress(NAME, written,
                                 message=f"{written/max(1e-9, time.time()-t0):.1f} pairs/s")

        for word in words:
            state.check_control()
            clues = by_word[word]
            jobs.append((word, clues))
            ntexts += 1 + len(clues)
            if ntexts >= BATCH_TEXTS:
                flush()
        flush()

    msg = f"{written:,} pairs embedded ({(time.time()-t0)/60:.1f} min)"
    state.set_validation("s3_pairs", written)
    state.stage_done(NAME, msg)
    print(msg)
    return {"pairs": written, "out": out}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--limit", type=int, default=None, help="only N answers (smoke test)")
    ap.add_argument("--no-resume", action="store_true")
    a = ap.parse_args()
    try:
        run(base_url=a.url, model=a.model, resume=not a.no_resume, limit=a.limit)
    except state.Stopped:
        state.stage_error(NAME, "stopped from monitor")
        print("stopped")
    except Exception as e:  # noqa: BLE001
        state.stage_error(NAME, e)
        raise
