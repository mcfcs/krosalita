"""Stage 4 -- LLM difficulty labels for a stratified sample.

This is the ground truth the distilled model (s5) learns from. It is the expensive stage
and the reason the monitor on :11211 exists.

Why an LLM at all: the only difficulty signal the corpus carries is the puzzle's WEEKDAY,
which is a property of the whole puzzle, not of an individual clue. A Saturday puzzle's
easiest clue still inherits "Saturday". Asking a model that knows crosswords to rate
clue/answer pairs one at a time gives a per-clue label the corpus simply does not contain.

Model choice was measured, not assumed (20 pairs/request, temperature 0):
    gpt-oss:20b    7s/batch  but compresses everything into 5-25 -- ERNE 10, OLIO 10,
                             ETUI 20. Almost no discrimination where it matters.
    qwen3.5:27b   31s/batch  with real spread -- OREO 10, IDEA 5, ERNE 70, ETUI 75,
                             IRAE 80, SMEE 85, ANOA 90, ESNE 95.
So qwen3.5:27b, ~2,300 pairs/hour per stream.

Sampling is stratified across answer length x weekday x corpus-frequency decile (x
clue-directness quartile when s3 has run), so the training set covers the hard corners
instead of 12,000 four-letter Mondays.

Everything lands in SQLite as it arrives: --resume skips already-labelled pairs, raw
responses are kept for auditing, and a re-label slice measures the label noise floor.
"""
import argparse, csv, json, math, os, random, re, sys, threading, time
import urllib.error, urllib.request
from collections import defaultdict
from queue import Queue

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import state  # noqa: E402

NAME = "s4_label"
PIPE = os.path.dirname(HERE)
PAIRS = os.path.join(PIPE, "out", "pairs.csv")
FEATURES = os.path.join(PIPE, "out", "features.csv")
EMBED = os.path.join(PIPE, "out", "embed.csv")

DEFAULT_URL = os.environ.get("KROSALITA_OLLAMA", "http://localhost:11434")
DEFAULT_MODEL = "qwen3.5:27b"
BATCH = 20

RUBRIC = """You are a veteran New York Times crossword editor.

Rate how hard each clue/answer pair is for a solver, 0-100, using the NYT weekday scale:
  0-15   Monday: a plain definition of a word everyone knows.
  16-35  Tuesday/Wednesday: common word, slight indirection.
  36-55  Thursday: wordplay, a pun, or a "?" clue.
  56-75  Friday: obscure vocabulary, or a very indirect clue.
  76-100 Saturday: crosswordese, rare proper nouns, deep trivia, heavy misdirection.

Judge the PAIR, not the answer alone: a familiar word can carry a brutal clue, and an
obscure word can carry a gentle one.

Calibration examples:
  OREO  "Sandwich cookie"            -> 10
  IDEA  "Brainstorm result"          -> 5
  ERNE  "Sea eagle"                  -> 70
  ETUI  "Needle case"                -> 75
  ANOA  "Wild ox of Celebes"         -> 90
  ESNE  "Anglo-Saxon serf"           -> 95
  HELL  "Fire place?"                -> 45

Reply with ONLY a JSON array of {"i":<index>,"d":<0-100>}. No prose, no code fences."""


def _post(url, payload, timeout):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def _parse_scores(text, n):
    """Pull the JSON array out of whatever the model wrapped it in."""
    if not text:
        return None
    text = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    m = re.search(r"\[.*\]", text, re.S)
    if not m:
        return None
    try:
        arr = json.loads(m.group(0))
    except json.JSONDecodeError:
        return None
    out = {}
    for item in arr:
        if not isinstance(item, dict):
            continue
        try:
            i = int(item.get("i"))
            d = float(item.get("d"))
        except (TypeError, ValueError):
            continue
        if 1 <= i <= n:
            out[i] = max(0.0, min(100.0, d))
    return out or None


def label_batch(base_url, model, pairs, timeout=600):
    lines = "\n".join(f'{i+1}. "{c}" -> {w}' for i, (w, c) in enumerate(pairs))
    payload = {
        "model": model,
        "prompt": f"{RUBRIC}\n\n{lines}",
        "stream": False,
        "think": False,
        "options": {"temperature": 0, "num_predict": 1200},
    }
    t0 = time.time()
    data = _post(f"{base_url.rstrip('/')}/api/generate", payload, timeout)
    raw = data.get("response", "")
    return _parse_scores(raw, len(pairs)), raw, time.time() - t0


def pair_id(word, clue):
    h = 0x811c9dc5
    for ch in f"{word}␟{clue}":
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return f"{word}:{h:08x}"


def _load_strata():
    """Everything needed to stratify, from whichever stages have finished."""
    rows = []
    with open(PAIRS, encoding="utf-8", newline="") as f:
        for r in csv.DictReader(f):
            rows.append({"Word": r["Word"], "Clue": r["Clue"],
                         "WordCount": int(r["WordCount"] or 1),
                         "WeekdayLast": r.get("WeekdayLast") or ""})
    cos = {}
    if os.path.exists(EMBED):
        with open(EMBED, encoding="utf-8", newline="") as f:
            for r in csv.DictReader(f):
                cos[(r["Word"], r["Clue"])] = float(r["CosClueAnswer"])
    return rows, cos


def build_sample(n, seed=7):
    rows, cos = _load_strata()
    freqs = sorted(r["WordCount"] for r in rows)

    def decile(v):
        import bisect
        return min(9, bisect.bisect_left(freqs, v) * 10 // max(1, len(freqs)))

    buckets = defaultdict(list)
    for r in rows:
        L = len(r["Word"])
        lb = 3 if L <= 3 else 4 if L <= 4 else 5 if L <= 5 else 6 if L <= 7 else 8 if L <= 10 else 11
        c = cos.get((r["Word"], r["Clue"]))
        cq = "?" if c is None else str(min(3, int(c * 4)))
        buckets[(lb, r["WeekdayLast"], decile(r["WordCount"]), cq)].append(r)

    rnd = random.Random(seed)
    per = max(1, n // max(1, len(buckets)))
    out = []
    for k in sorted(buckets, key=lambda x: str(x)):
        b = buckets[k]
        rnd.shuffle(b)
        out.extend(b[:per])
    rnd.shuffle(out)
    if len(out) < n:                      # top up from the remainder
        have = {(r["Word"], r["Clue"]) for r in out}
        rest = [r for r in rows if (r["Word"], r["Clue"]) not in have]
        rnd.shuffle(rest)
        out.extend(rest[: n - len(out)])
    return out[:n], len(buckets)


def run(n=12000, base_url=DEFAULT_URL, model=DEFAULT_MODEL, concurrency=2,
        resume=True, consistency=500):
    conn = state.connect()
    sample, nbuckets = build_sample(n)

    done = set()
    if resume:
        for r in conn.execute("SELECT pair_id FROM label WHERE pass=1"):
            done.add(r["pair_id"])

    todo = [r for r in sample if pair_id(r["Word"], r["Clue"]) not in done]
    state.stage_start(NAME, total=len(sample),
                      message=f"{model} · {nbuckets:,} strata · {len(done):,} already labelled")
    state.stage_progress(NAME, len(done))

    batches = [todo[i:i + BATCH] for i in range(0, len(todo), BATCH)]
    q = Queue()
    for b in batches:
        q.put(b)

    lock = threading.Lock()
    counters = {"done": len(done), "bad": 0}
    t0 = time.time()
    stop_flag = {"stop": False}

    def worker():
        wconn = state.connect()          # thread-local connection
        while not stop_flag["stop"]:
            try:
                batch = q.get_nowait()
            except Exception:  # noqa: BLE001 -- queue.Empty
                return
            try:
                state.check_control()
            except state.Stopped:
                stop_flag["stop"] = True
                return
            pairs = [(r["Word"], r["Clue"]) for r in batch]
            err = None
            scores = None
            raw = ""
            secs = 0.0
            try:
                scores, raw, secs = label_batch(base_url, model, pairs)
            except Exception as e:  # noqa: BLE001
                err = str(e)
            with lock:
                wconn.execute(
                    "INSERT INTO label_batch(ts,model,n,ok,secs,raw,error) VALUES(?,?,?,?,?,?,?)",
                    (time.time(), model, len(pairs), 1 if scores else 0, secs,
                     (raw or "")[:4000], err))
                if not scores:
                    counters["bad"] += 1
                else:
                    for i, r in enumerate(batch, start=1):
                        d = scores.get(i)
                        if d is None:
                            continue
                        wconn.execute(
                            "INSERT OR REPLACE INTO label"
                            "(pair_id,word,clue,score,model,ts,pass) VALUES(?,?,?,?,?,?,1)",
                            (pair_id(r["Word"], r["Clue"]), r["Word"], r["Clue"],
                             d, model, time.time()))
                        counters["done"] += 1
                rate = (counters["done"] - len(done)) / max(1e-9, time.time() - t0)
                state.stage_progress(
                    NAME, counters["done"],
                    message=f"{rate*3600:.0f} pairs/hr · {counters['bad']} bad batches")

    threads = [threading.Thread(target=worker, daemon=True) for _ in range(max(1, concurrency))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    # Re-label a slice to measure test-retest agreement: without knowing the label noise
    # floor there is no way to tell a weak model from a noisy target in s5.
    if consistency and not stop_flag["stop"]:
        rows = [dict(r) for r in conn.execute(
            "SELECT word,clue FROM label WHERE pass=1 ORDER BY RANDOM() LIMIT ?", (consistency,))]
        for i in range(0, len(rows), BATCH):
            try:
                state.check_control()
            except state.Stopped:
                break
            chunk = rows[i:i + BATCH]
            try:
                scores, _raw, _s = label_batch(base_url, model,
                                               [(r["word"], r["clue"]) for r in chunk])
            except Exception:  # noqa: BLE001
                continue
            if not scores:
                continue
            for j, r in enumerate(chunk, start=1):
                d = scores.get(j)
                if d is None:
                    continue
                conn.execute("INSERT OR REPLACE INTO label"
                             "(pair_id,word,clue,score,model,ts,pass) VALUES(?,?,?,?,?,?,2)",
                             (pair_id(r["word"], r["clue"]) + ":p2", r["word"], r["clue"],
                              d, model, time.time()))

    total = conn.execute("SELECT COUNT(*) n FROM label WHERE pass=1").fetchone()["n"]
    msg = (f"{total:,} labels · {counters['bad']} failed batches · "
           f"{(time.time()-t0)/60:.0f} min")
    state.set_validation("s4_labels", total)
    state.set_validation("s4_model", model)
    state.stage_done(NAME, msg)
    print(msg)
    return {"labels": total}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("-n", type=int, default=12000)
    ap.add_argument("--url", default=DEFAULT_URL)
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--concurrency", type=int, default=2)
    ap.add_argument("--consistency", type=int, default=500)
    ap.add_argument("--no-resume", action="store_true")
    a = ap.parse_args()
    try:
        run(n=a.n, base_url=a.url, model=a.model, concurrency=a.concurrency,
            resume=not a.no_resume, consistency=a.consistency)
    except state.Stopped:
        state.stage_error(NAME, "stopped from monitor")
        print("stopped")
    except Exception as e:  # noqa: BLE001
        state.stage_error(NAME, e)
        raise
