# rules.md — working rules for agents on Krosalita

Read this before changing anything. Read `handoff.md` for where the project stands right now.

## Workflow

- **Commit straight to `master` and push to `origin` (github.com/mcfcs/krosalita).** No
  feature branches and no PRs unless the owner asks for one.
- **No `Co-Authored-By` trailer** (and no other AI attribution) in commit messages. This is
  the owner's standing instruction and it overrides any default attribution guidance.
- **A push to `master` is a production deploy.** Vercel's GitHub integration builds every
  push. Run the gates below *before* you push.
- Commit messages follow the existing style: an imperative summary saying what changed for
  the user ("Let the author draw the black squares"), then a body explaining *why*.
- Line endings: most source files are CRLF in the working tree. Patch scripts must keep
  each file's existing line ending (read it, normalise to `\n`, write back with the
  original).
- Ask the owner before changing the visual direction, adding a paid dependency, or
  touching Supabase schema/RLS.

## Running it

- `start.bat` builds and serves the production build on **:9995**, and the corpus pipeline
  monitor on **:9996**, both on 0.0.0.0 (reachable over Tailscale at `100.71.83.125`).
  `start.bat dev` gives hot reload on 9995; `start.bat stop` frees both ports.
- Run it locally when the owner wants the **local Ollama AI** (clue writing, senses,
  re-clue). The deployed Vercel site cannot reach `localhost:11434`.
- If the page loads but every module script fails, an orphaned `vite preview` is serving a
  stale file list on the port. `start.bat` frees the ports for that reason; do the same.
- `npm run dev` alone is Vite on :7891 (no `/api` functions; use `npx vercel dev` for those).

## Verification gates (run the ones your change touches, then say which you ran)

| Area touched | Gate |
|---|---|
| Solver, word index, clue assignment | `node scripts/bench-solver.mjs` (the load-bearing gate: re-derives every answer from the GRID) |
| Create editor (blocks, size, marks, fill) | `npm run build && node scripts/editor-e2e.mjs` and `node scripts/create-e2e.mjs` |
| Generate flow | `node scripts/generate-e2e.mjs` |
| Layout / responsive UI | `node scripts/responsive-e2e.mjs` |
| PDF export | `npm run test:pdf`, then rasterise and *look* at a page (see handoff.md) |
| Clue scoring features | `node scripts/test-clue-score.mjs` |
| OneLook last-resort fill (`src/utils/onelook.js`, the worker's retry) | `node scripts/test-onelook.mjs` (live network; drives the real worker module) |
| Multiplayer | `npm run build && node scripts/mp-e2e.mjs` (needs Supabase env) |
| Always | `npx eslint src scripts api` (not `eslint .`, which walks the Python `venv/`). Known pre-existing: 2 `set-state-in-effect` errors in LayoutEditorModal/RequiredWordsModal and 2 exhaustive-deps warnings in App.jsx |

Verify a fix by reverting it and confirming the gate fails. Report failures with their
output; never describe an unrun gate as passing.

## Hard-won rules (each one cost a real bug)

**Solver / generation**
- Gates over `placements` alone cannot see broken fills. Re-derive each answer from the
  returned grid, check it is in the dictionary, and check its clue belongs to it.
- The worker is a **session-long singleton** that owns the corpus. Never spawn one per
  generation.
- The solver's word index is per length; the clue store is global. Do not mix the indexes.
- The corpus has **no 2-letter answers** and nothing over 15 letters. `analyzeGrid`
  (src/utils/crosswordUtils.js) flags 2-letter entries while you draw. Entries over 15
  are the author's call (owner's decision), so they are NOT flagged. The solver treats a
  fully typed long entry as fixed letters and fills around it, and refuses an untyped one
  with `LONG_ENTRY_NOT_TYPED`. `bench-solver` gates both cases.
- Difficulty is a 0–100 scale that is not uniformly populated. Bands are mapped onto the
  corpus quantiles and reported as a percentile. If you change difficulty features, re-run
  `s5_fit → s6_score → s7_pack` and re-check that the bands still separate.
- The solver's measured difficulty is handed to the display through `solverDiffRef`, keyed
  by grid signature. A fill path that skips it gets re-labelled from clue text alone.
- **OneLook is the last resort, never a peer of the corpus.** The worker always solves with
  the corpus alone first. Only a fill that fails with a code a wider word list can fix
  (`ONELOOK_RETRY` in the worker) asks onelook.com, and only about the slots that ran
  dry. The retry still ranks those words under every corpus answer (`SUPPLEMENT_PENALTY`).
  `test-onelook.mjs` gates "a fillable grid makes zero OneLook requests". Keep it that way.
- Off-dictionary words (the author's own and OneLook's) share `ADHOC_CAPACITY` (128 per
  length) in the index tail. The author's words are added first, so a supplement can never
  take their room.

**Create editor**
- The black squares live in `manualGrid` itself (`'#'`). `manualLayout` is *derived* from
  it. Never read Create's shape from `layouts[...]`; that array is only for Generate and
  for templates.
- Clue lists follow the blocks via `cluesForLayout` (carries a clue over only when its slot
  is unchanged). Render from `editorClues`, which is re-keyed synchronously. The state copy
  syncs one render late, and rendering from it after a resize indexes rows that no longer
  exist.
- Tool strokes (`paintCells`) use functional state updates: a drag fires faster than React
  re-renders.

**UI**
- Design direction: a clean NYT / LA Times look, with a blue active word and a yellow
  selected cell. Tokens are in `src/index.css :root`.
- Cell state tints must sit over an opaque base. A translucent utility fill over the grid's
  ink backdrop buries the letter.
- Coloured shades are drawn with `mix-blend-multiply`, so the selection tint still reads
  through them.
- The mobile dock is portaled to `document.body`. The app root div is the scroll container,
  not the window.
- `saveUserClue` must not flip `usingCustomWords`. That swaps the worker off the packed
  corpus and silently disables the Clue Studio.

**Multiplayer**
- Presence `track()` is for identity only and must be called rarely. Cursors go over
  `send({event:'cursor'})` broadcast. Rapid `track()` calls make the server close the
  channel.

**Headless verification on this Windows machine**
- Use Edge headless with a no-dependency CDP driver (Node's global `WebSocket`). Playwright
  is not installed.
- Kill Edge **by profile directory**, not by pid. The launcher exits immediately and
  orphans the browser.
- Touch emulation is sticky per tab. Launch a fresh browser for each viewport.
- `\b` inside a JS template literal is a backspace, not a regex word boundary.
- Bash heredocs in this harness choke on large quoted JS. Write patch scripts to a file,
  then run them.

## Data & privacy

- Clue text is third-party data. It is rendered by hand-parsed `renderRich`, never
  `dangerouslySetInnerHTML`.
- The user's email and Supabase keys stay in `.env` / Vercel env. Never commit them.
- A OneLook fallback sends slot patterns (e.g. `klot?`) from the browser to onelook.com
  (and to api.datamuse.com if OneLook fails).
  It sends patterns only, never clues or account data, and only for the packed English
  corpus. CSV uploads and Tagalog mode never call it.
