# Krosalita — Crossword Studio

Krosalita is a full-stack crossword studio: **generate** puzzles from a word list, **build** them by hand, **import** real published puzzles from crosswithfriends, and **play** them solo or with friends in real time — as a clean, installable web app. It started as a client-side generator and grew into a React + Vite front end backed by Vercel serverless functions and Supabase (Postgres · Auth · Realtime), with an optional local‑LLM clue assistant.

> Clean, NYT / LA Times–style solving UI · mobile‑first & installable (PWA) · real‑time multiplayer · zero paid dependencies to run locally.

---

## Highlights

**Create & generate**
- **Generate mode** — fill a whole crossword automatically from a 62k‑answer corpus. The solver is a bitset CSP in a Web Worker and returns in single‑digit milliseconds (p50 6 ms, p95 15 ms), so the UI never waits.
- **Create mode** — hand‑edit a grid + clues, auto‑fill the rest, force in required words, and target a difficulty band.
- **Rich clues** — `**bold**` / `*italic*` markup and symbols/accents render across play, create, mobile, and export.
- **Clues that stand alone** — cross‑references ("See 60 Across") and grid‑dependent clues ("the circled letters") are stripped when the corpus is built and re‑checked at runtime, and no answer can repeat within a puzzle.
- **AI clue assist (local, private)** — draft clues with a self‑hosted [Ollama](https://ollama.com) model; nothing leaves your machine.

**Play**
- **Clean solving UI** — NYT / LA Times palette (blue active word · yellow cell), a grid that fits any screen width, and legible correct/wrong/revealed states.
- **Mobile‑first** — on‑screen keyboard + sticky current‑clue bar; installable **PWA** ("Add to Home Screen") that works offline and resumes your last solve.
- **Solving tools** — pause the clock, one‑off **Check** cell/word/board (with confirmation), **Reveal**, a **smart cursor** (skips filled squares, jumps to the next empty clue), **rebus** entry, and a **clean‑solve** badge + confetti result card.
- **Circles & shades** — themed‑puzzle markings are preserved and rendered.
- **Today's Puzzle + streaks**, sound effects, share‑as‑image, and a print stylesheet.

**Import from crosswithfriends**
- Search the crosswithfriends catalogue and play any puzzle right in Krosalita — a serverless "middle‑man" that reproduces the site's Socket.IO fetch and normalises it into Krosalita's format (handy when the site misbehaves outside iOS).

**Multiplayer**
- **5‑digit lobby codes** and one‑tap **invite links** (auto‑join). Co‑solve any puzzle (generated, imported, or Tagalog) with live cursors, everyone's highlights shown in their colour, and a shared board.
- **Host controls** (auto‑check, reveal, check board, game mode) and two modes: cooperative solve or **points** (first correct letter scores).

**Profiles**
- Guest‑first: play/host/join with just a display name. Optional email + Google sign‑in to **save your created puzzles** and history across devices.

---

## Tech stack

- **Front end:** React 19, Vite 7, Tailwind CSS (no component library — a small hand‑built design system).
- **Solver:** custom bitset CSP fill running in a Web Worker.
- **Words:** a packed binary corpus (`public/corpus/corpus.bin`) produced by a Python pipeline.
- **Back end:** Vercel serverless (Node) functions for the crosswithfriends proxy (`socket.io-client`), and **Supabase** for Auth, Postgres, and Realtime (multiplayer + saved puzzles).
- **AI:** optional local Ollama over HTTP(S) — configurable, off by default.
- **PWA:** web manifest + service worker + generated icons.

### Architecture

```
Browser SPA (Vite/React, PWA)
   ├── Worker       → /corpus/corpus.bin → bitset index (built once, cached) → fill
   ├── /api/cwf/*   → Vercel serverless → crosswithfriends REST + downforacross Socket.IO
   ├── Supabase     → Auth · Postgres (games, players, profiles, puzzles) · Realtime
   └── Ollama       → local model over HTTP(S) (optional, private)
```

### The fill

The generator is a constraint solver over bitsets: MRV / dom‑wdeg variable ordering, incremental AC‑3 propagation, trail‑based undo, conflict‑directed backjumping, Luby restarts, and a seeded PRNG (`mulberry32`) so any fill — the daily puzzle included — is reproducible from its seed. Placing an answer clears it from every other same‑length slot's candidate bitset, so **duplicate answers are structurally impossible** rather than filtered after the fact. Difficulty biases value ordering toward a running residual target instead of pre‑filtering the word list, which is what used to starve the search. A preflight pass rejects impossible requests in milliseconds with a specific reason (a hand‑drawn 2‑letter slot, say — the corpus has no 2‑letter answers) instead of grinding out the whole time budget.

`node scripts/bench-solver.mjs` measures it: **1200 / 1200 fills** across 10 layouts × 6 difficulty settings × 20 seeds, **p50 6 ms, p95 15 ms**, with gates on duplicate answers and clue filters. For comparison, the previous wave‑function‑collapse fill took **16.8 s** on Classic 15×15 and never completed Standard 15×15 (37 of 78 answers at a 30 s timeout). Design notes: [`docs/solver-v2-spec.md`](docs/solver-v2-spec.md).

---

## Getting started

```bash
npm ci
npm run dev            # Vite dev server on http://localhost:7891
# or, to also run the /api serverless functions locally:
npx vercel dev
```

The dev/preview server also binds to your LAN / Tailscale address, so you can open it on a phone on the same network.

### Scripts

```bash
npm run dev       # dev server (7891)
npm run build     # production build
npm run preview   # preview the production build
npm run lint      # ESLint

node scripts/bench-solver.mjs    # solver sweep: every layout × difficulty × seed, with pass/fail gates
node scripts/generate-e2e.mjs    # headless-browser check: build, click Generate, read the grid back
```

### Environment (optional — for multiplayer & profiles)

Copy `.env.example` → `.env` and add a [Supabase](https://supabase.com) project's keys:

```
VITE_SUPABASE_URL=...
VITE_SUPABASE_ANON_KEY=...
```

Apply `supabase/migrations/0001_init.sql` in the Supabase SQL editor. Without these, the app still runs fully as a guest (generate / create / import / solo play); multiplayer and saved puzzles simply prompt you to configure Supabase. On the deployed site, set the same variables in Vercel → Project → Environment Variables and add your domain to Supabase → Auth → URL Configuration.

### AI clue assist (Ollama)

1. `ollama pull llama3.1`
2. In the header open **AI**, enable it, set the server URL (default `http://localhost:11434`), pick a model, **Test connection**.
3. In Create mode, select a filled word → **AI Clue**.

Reaching Ollama from another device / over Tailscale: run it with `OLLAMA_HOST=0.0.0.0:11434` and `OLLAMA_ORIGINS=<your app origin>`, and point the URL at the host's Tailscale address (the Settings dialog shows the exact origin to allow). For a deployed HTTPS site, expose Ollama over HTTPS via `tailscale serve`.

---

## Word corpus

Generation reads `public/corpus/corpus.bin` — a packed artifact holding **62,866 answers and 209,427 clues in 5.59 MB**. The worker decodes it in ~14 ms and builds its bitset index in ~13 ms, once per session. It replaces a 24 MB CSV that parsed into 552k JS objects and cost ~591 ms just to parse, on every load.

Clues that can't stand alone in a generated puzzle — cross‑references by grid number, and clues about the grid, its theme or its markings — are dropped when the corpus is built (9,996 rows, 1.28%). `src/utils/clueFilters.js` mirrors `pipeline/clue_filters.py` and re‑applies the same rules at runtime, so uploaded CSVs get the same treatment.

### Corpus pipeline

```bash
python pipeline/build.py --stage all      # clean → features → embeddings → labels → fit → score → pack
python pipeline/build.py --stage s1 s2 s7 # just the fast path
python pipeline/build.py --list           # stage status
python pipeline/monitor/server.py         # monitor UI on 0.0.0.0:11211
```

Stages run from raw CSV to `corpus.bin`, checkpointing into `pipeline/state.sqlite` so a run can be resumed. The long ones (local embeddings, then LLM difficulty labelling) take hours, so there's a monitor: a small web UI on port 11211 — reachable over Tailscale, i.e. from a phone — with pause/stop controls, live throughput, sample labels as they're produced, and validation metrics. `s1 s2 s7` alone yield a working corpus with the older weekday‑based difficulty signal, so the app is never blocked on the slow stages.

### CSV dictionary format

Uploaded word lists and Tagalog mode still use CSV, indexed by the same builder at runtime:

```csv
Date,Word,Clue,Difficulty
2026-01-01,APPLE,Common red fruit,EASY
```

`Date,Word,Clue` are required; `Difficulty` is optional (used for filtering/scoring). If present in `public/`, `crosswords.csv` (browse/search) and `tagalogcrosswordfinal_test.csv` (Tagalog mode) auto‑load.

## Project structure

```text
api/cwf/            # Vercel serverless: crosswithfriends search + puzzle fetch/transform
docs/               # solver-v2-spec.md — the fill algorithm in detail
pipeline/           # corpus pipeline: stages/, clue_filters.py, monitor/ (web UI)
public/corpus/      # corpus.bin + manifest.json — the packed word/clue artifact
scripts/            # solver benchmark, generate e2e, multiplayer e2e
src/
  App.jsx           # app state, generation, play logic
  components/       # views & modals (Play, Create, Browse, Multiplayer, Auth, …)
  multiplayer/      # Supabase Realtime client + state-adapter hook
  lib/              # supabase client, api client, saved-puzzles
  utils/            # solver + bitset/word index/clue index/filters/rng, grid utils, sound, rich text
  worker/           # Web Worker: owns the corpus index, runs the fill, picks clues
supabase/migrations # Postgres schema + RLS
```

---

## Notes

Puzzle imports are for personal, on‑demand use; published crosswords are the copyright of their respective publishers. Krosalita doesn't cache or redistribute them.

*Built with React, Vite, Tailwind, Supabase, and Vercel.*
