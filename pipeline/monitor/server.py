"""Pipeline monitor -- stdlib HTTP server on 0.0.0.0:11211.

Read-only view of pipeline/state.sqlite plus pause/resume/stop controls, so an
overnight LLM labelling run can be watched (and stopped) from a phone over
Tailscale.

    python pipeline/monitor/server.py            # http://0.0.0.0:11211
    python pipeline/monitor/server.py --port 11211

Endpoints:
    GET  /             the page
    GET  /status       JSON: stages, throughput, recent labels, filter drops, validation
    POST /control      {"pause":true} | {"stop":true} | {"pause":false,"stop":false}
"""
import argparse, json, os, sys, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import state  # noqa: E402

STAGES = [
    ("s1_clean",    "Clean"),
    ("s2_features", "Features"),
    ("s3_embed",    "Embeddings"),
    ("s4_label",    "LLM labels"),
    ("s5_fit",      "Fit"),
    ("s6_score",    "Score"),
    ("s7_pack",     "Pack"),
    ("s8_coldstart","Clue scorer"),
]


def _rate(conn, name, window=180.0):
    """items/sec over the last `window` seconds, from the metric table."""
    now = time.time()
    rows = conn.execute(
        "SELECT ts,done FROM metric WHERE stage=? AND ts>=? ORDER BY ts", (name, now - window)
    ).fetchall()
    if len(rows) < 2:
        return None
    dt = rows[-1]["ts"] - rows[0]["ts"]
    dn = rows[-1]["done"] - rows[0]["done"]
    return (dn / dt) if dt > 0.5 and dn >= 0 else None


def _spark(conn, name, points=40, window=1800.0):
    now = time.time()
    rows = conn.execute(
        "SELECT ts,done FROM metric WHERE stage=? AND ts>=? ORDER BY ts", (name, now - window)
    ).fetchall()
    if len(rows) < 3:
        return []
    step = max(1, len(rows) // points)
    s = rows[::step]
    out = []
    for a, b in zip(s, s[1:]):
        dt = b["ts"] - a["ts"]
        out.append(round((b["done"] - a["done"]) / dt, 3) if dt > 0 else 0.0)
    return out


def build_status():
    conn = state.connect()
    stages = []
    for name, label in STAGES:
        r = conn.execute("SELECT * FROM stage WHERE name=?", (name,)).fetchone()
        d = dict(r) if r else {"name": name, "status": "pending", "done": 0, "total": 0,
                               "started_at": None, "updated_at": None, "finished_at": None,
                               "message": None, "error": None}
        d["label"] = label
        rate = _rate(conn, name) if d["status"] == "running" else None
        d["rate"] = rate
        remaining = (d["total"] or 0) - (d["done"] or 0)
        d["eta_s"] = (remaining / rate) if (rate and rate > 0 and remaining > 0) else None
        d["elapsed_s"] = ((d["finished_at"] or time.time()) - d["started_at"]) if d["started_at"] else None
        d["spark"] = _spark(conn, name) if d["status"] == "running" else []
        stages.append(d)

    labels = [dict(r) for r in conn.execute(
        "SELECT word,clue,score,model,ts FROM label ORDER BY ts DESC LIMIT 50")]
    nlabels = conn.execute("SELECT COUNT(*) n FROM label").fetchone()["n"]
    batches = conn.execute(
        "SELECT COUNT(*) n, SUM(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) bad, "
        "AVG(secs) avg_s FROM label_batch").fetchone()
    drops = [dict(r) for r in conn.execute(
        "SELECT rule,n,sample FROM filter_drop ORDER BY n DESC")]
    hist = [dict(r) for r in conn.execute(
        "SELECT CAST(score/10 AS INT)*10 AS bucket, COUNT(*) n FROM label GROUP BY bucket ORDER BY bucket")]

    return {
        "now": time.time(),
        "stages": stages,
        "control": {"pause": state.get_control("pause", False),
                    "stop": state.get_control("stop", False)},
        "labels": labels,
        "label_count": nlabels,
        "label_hist": hist,
        "batches": {"n": batches["n"] or 0, "bad": batches["bad"] or 0,
                    "avg_s": round(batches["avg_s"], 1) if batches["avg_s"] else None},
        "filter_drops": drops,
        "validation": state.all_validation(),
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass  # quiet

    def _send(self, code, body, ctype):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path in ("/", "/index.html"):
            try:
                with open(os.path.join(HERE, "index.html"), "rb") as f:
                    return self._send(200, f.read(), "text/html; charset=utf-8")
            except OSError as e:
                return self._send(500, str(e), "text/plain")
        if path == "/status":
            try:
                return self._send(200, json.dumps(build_status()), "application/json")
            except Exception as e:  # never let the monitor 500 the whole page
                return self._send(200, json.dumps({"error": str(e), "stages": []}), "application/json")
        return self._send(404, "not found", "text/plain")

    def do_POST(self):
        if self.path != "/control":
            return self._send(404, "not found", "text/plain")
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError:
            return self._send(400, "bad json", "text/plain")
        for k in ("pause", "stop"):
            if k in body:
                state.set_control(k, bool(body[k]))
        return self._send(200, json.dumps({"ok": True, "control": {
            "pause": state.get_control("pause", False),
            "stop": state.get_control("stop", False)}}), "application/json")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=11211)
    ap.add_argument("--host", default="0.0.0.0")
    a = ap.parse_args()
    state.connect()
    srv = ThreadingHTTPServer((a.host, a.port), Handler)
    srv.daemon_threads = True
    print(f"monitor: http://{a.host}:{a.port}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")


if __name__ == "__main__":
    main()
