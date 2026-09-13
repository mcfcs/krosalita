"""Krosalita corpus pipeline.

    python pipeline/build.py --stage all            # everything, in order
    python pipeline/build.py --stage s1 s2 s7       # just the fast path
    python pipeline/build.py --list                 # stage status

Watch it (including from a phone over Tailscale):

    python pipeline/monitor/server.py               # http://localhost:11211

Stages
    s1_clean     raw NYT csv -> deduped (Word, Clue) pairs, cross-reference clues removed
    s2_features  hand-built clue/answer features (incl. the crosswordese score)
    s3_embed     local embeddings -> how directly each clue points at its answer   (~2.5h)
    s4_label     LLM difficulty labels for a stratified sample                     (~2-3h)
    s5_fit       distil those labels into a model over the cheap features
    s6_score     score all 551k pairs with it
    s7_pack      emit public/corpus/corpus.bin for the app
    s8_coldstart train + export the browser clue scorer (public/corpus/clue-model.json)

s1+s2+s7 alone produce a working corpus (difficulty falls back to the old weekday
signal), so the app is never blocked on the long stages. Re-run s7 after s6 to swap in
the model's scores.
"""
import argparse, os, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "stages"))
import state  # noqa: E402

ORDER = ["s1_clean", "s2_features", "s3_embed", "s4_label", "s5_fit", "s6_score",
         "s7_pack", "s8_coldstart"]
ALIAS = {s.split("_")[0]: s for s in ORDER}


def run_stage(name):
    mod = __import__(name)
    t0 = time.time()
    print(f"\n=== {name} ===")
    try:
        mod.run()
    except state.Stopped:
        print(f"{name}: stopped from the monitor")
        state.stage_error(name, "stopped from monitor")
        return False
    except Exception as e:  # noqa: BLE001
        state.stage_error(name, e)
        print(f"{name}: FAILED — {e}")
        return False
    print(f"--- {name} done in {time.time()-t0:.0f}s")
    return True


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--stage", nargs="*", default=["all"])
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()

    if a.list:
        conn = state.connect()
        for s in ORDER:
            r = conn.execute("SELECT * FROM stage WHERE name=?", (s,)).fetchone()
            if not r:
                print(f"  {s:14} pending")
            else:
                print(f"  {s:14} {r['status']:8} {r['done']:>8,}/{r['total']:<8,} {r['message'] or ''}")
        return

    state.set_control("stop", False)
    state.set_control("pause", False)

    stages = ORDER if a.stage == ["all"] else [ALIAS.get(s, s) for s in a.stage]
    for s in stages:
        if s not in ORDER:
            print(f"unknown stage: {s} (choose from {', '.join(ORDER)})")
            return 2
    for s in stages:
        if not run_stage(s):
            return 1
    print("\nall requested stages complete")
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
