"""SQLite-backed pipeline state: checkpoints, progress, labels, control flags.

Everything long-running writes here so (a) --resume never loses work to a reboot,
and (b) the monitor on :11211 can read live progress without touching the workers.

WAL mode so the monitor can read while a stage writes.
"""
import json, os, sqlite3, time, threading

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "state.sqlite")

SCHEMA = """
CREATE TABLE IF NOT EXISTS stage (
  name        TEXT PRIMARY KEY,
  status      TEXT NOT NULL DEFAULT 'pending',  -- pending|running|done|error|paused
  done        INTEGER NOT NULL DEFAULT 0,
  total       INTEGER NOT NULL DEFAULT 0,
  started_at  REAL, updated_at REAL, finished_at REAL,
  message     TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS control (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS metric (
  stage TEXT NOT NULL, ts REAL NOT NULL, done INTEGER NOT NULL, rate REAL
);
CREATE INDEX IF NOT EXISTS metric_stage_ts ON metric(stage, ts);

-- s1: why each row was dropped, for the monitor's filter-audit panel
CREATE TABLE IF NOT EXISTS filter_drop (
  rule TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, sample TEXT
);

-- s4: LLM labels. pair_id is a stable hash of (word, clue).
CREATE TABLE IF NOT EXISTS label (
  pair_id TEXT PRIMARY KEY,
  word    TEXT NOT NULL,
  clue    TEXT NOT NULL,
  score   REAL NOT NULL,
  model   TEXT NOT NULL,
  batch   INTEGER,
  ts      REAL NOT NULL,
  pass    INTEGER NOT NULL DEFAULT 1   -- 2 = consistency re-label slice
);
CREATE INDEX IF NOT EXISTS label_ts ON label(ts);

CREATE TABLE IF NOT EXISTS label_batch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts REAL NOT NULL, model TEXT, n INTEGER, ok INTEGER, secs REAL,
  raw TEXT, error TEXT
);

-- s5: validation metrics, rendered by the monitor
CREATE TABLE IF NOT EXISTS validation (k TEXT PRIMARY KEY, v TEXT NOT NULL, ts REAL NOT NULL);
"""

_local = threading.local()


def connect():
    c = getattr(_local, "conn", None)
    if c is None:
        c = sqlite3.connect(DB_PATH, timeout=30, isolation_level=None)
        c.row_factory = sqlite3.Row
        c.execute("PRAGMA journal_mode=WAL")
        c.execute("PRAGMA synchronous=NORMAL")
        c.executescript(SCHEMA)
        _local.conn = c
    return c


# ---------- stage progress ----------

def stage_start(name, total=0, message=""):
    c = connect(); now = time.time()
    c.execute(
        "INSERT INTO stage(name,status,done,total,started_at,updated_at,message) "
        "VALUES(?,'running',0,?,?,?,?) "
        "ON CONFLICT(name) DO UPDATE SET status='running',total=excluded.total,"
        "started_at=excluded.started_at,updated_at=excluded.updated_at,message=excluded.message,error=NULL",
        (name, total, now, now, message))


def stage_progress(name, done, total=None, message=None, sample_metric=True):
    c = connect(); now = time.time()
    if total is None:
        c.execute("UPDATE stage SET done=?,updated_at=?,message=COALESCE(?,message) WHERE name=?",
                  (done, now, message, name))
    else:
        c.execute("UPDATE stage SET done=?,total=?,updated_at=?,message=COALESCE(?,message) WHERE name=?",
                  (done, total, now, message, name))
    if sample_metric:
        c.execute("INSERT INTO metric(stage,ts,done) VALUES(?,?,?)", (name, now, done))


def stage_done(name, message=""):
    c = connect(); now = time.time()
    c.execute("UPDATE stage SET status='done',finished_at=?,updated_at=?,message=? WHERE name=?",
              (now, now, message, name))


def stage_error(name, err):
    c = connect(); now = time.time()
    c.execute("UPDATE stage SET status='error',updated_at=?,error=? WHERE name=?", (now, str(err), name))


def stage_row(name):
    return connect().execute("SELECT * FROM stage WHERE name=?", (name,)).fetchone()


# ---------- control flags (the monitor's pause/stop buttons) ----------

def set_control(k, v):
    connect().execute("INSERT INTO control(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v",
                      (k, json.dumps(v)))


def get_control(k, default=None):
    r = connect().execute("SELECT v FROM control WHERE k=?", (k,)).fetchone()
    return json.loads(r["v"]) if r else default


class Stopped(Exception):
    """Raised inside a worker loop when the monitor asks it to stop."""


def check_control(poll_every=1.0, _last=[0.0]):
    """Call from inside long loops. Blocks while paused, raises Stopped on stop."""
    now = time.time()
    if now - _last[0] < poll_every:
        return
    _last[0] = now
    if get_control("stop", False):
        raise Stopped("stopped from monitor")
    while get_control("pause", False):
        if get_control("stop", False):
            raise Stopped("stopped from monitor")
        time.sleep(1.0)
        _last[0] = time.time()


# ---------- validation ----------

def set_validation(k, v):
    connect().execute("INSERT INTO validation(k,v,ts) VALUES(?,?,?) "
                      "ON CONFLICT(k) DO UPDATE SET v=excluded.v,ts=excluded.ts",
                      (k, json.dumps(v), time.time()))


def all_validation():
    return {r["k"]: json.loads(r["v"]) for r in connect().execute("SELECT k,v FROM validation")}
