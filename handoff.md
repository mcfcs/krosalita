# handoff.md — Krosalita, current state

_Last updated 2026-10-17. Read `rules.md` first for the rules; this file covers where things stand._

## What this is

Krosalita is a crossword studio built with React 19, Vite 7 and Tailwind. You can
**generate** a puzzle from a 62k-answer corpus, **create** one by hand, **import**
puzzles from crosswithfriends, and **play** solo or in real-time multiplayer.

- **Production:** Vercel, auto-deployed from every push to `master` on
  github.com/mcfcs/krosalita.
- **Local:** `start.bat` serves the app on :9995 and the pipeline monitor on :9996. Use
  this when the owner wants the local Ollama AI clue tools, which the deployed site can't
  reach.

## Map of the code

| Path | What it is |
|---|---|
| `src/App.jsx` (~4.2k lines) | Nearly all state and behaviour: Generate, Create, Play, persistence, worker bridge |
| `src/components/ManualEditor.jsx` | The Create workspace UI: tools, size, grid, health strip, selection/clue panel, clue list |
| `src/components/PdfExportModal.jsx` | "Save as PDF" dialog with a live preview |
| `src/utils/pdfExport.js` | Newspaper-style PDF layout (jsPDF, lazy-loaded) |
| `src/utils/crosswordUtils.js` | Slots, numbering, `layoutOfGrid`, `cluesForLayout`, `analyzeGrid`, `mirrorOf` |
| `src/utils/cellColors.js` | Shade palette (screen, print and grey hex values per colour id) |
| `src/utils/solver.js`, `src/worker/crosswordWorker.js` | Bitset CSP fill. The worker owns the corpus |
| `src/utils/clueSource.js`, `clueScore.js`, `ollama.js` | Clue Studio, difficulty scorer, local LLM |
| `src/components/{PlayView,GameView,CrosswordGrid}.jsx` | Solving UI |
| `src/multiplayer/*`, `src/lib/*`, `supabase/` | Multiplayer and accounts (Supabase) |
| `api/cwf/*` | Vercel functions that proxy crosswithfriends |
| `pipeline/` | Python corpus build (`python pipeline/build.py --stage all`) |
| `scripts/*` | Benches and headless-Edge e2e suites (see rules.md for which to run) |
| `docs/solver-v2-spec.md` | Solver design notes |

## Done in the 2026-10-17 session

### OneLook as the last-resort word source
When a fill fails because the corpus has no answer for a slot (usually because the author's
own letters or theme words cross it into an impossible pattern), the worker now asks
OneLook (`https://www.onelook.com/api/words?sp=<pattern>&md=df`) and solves again.
- **Order.** The corpus-only solve always runs first. OneLook is asked only when that
  fails with `SLOT_EMPTY_AFTER_AC`, `CELL_NO_LETTER`, `NO_SOLUTION`, `TIMEOUT` or
  `INSUFFICIENT_WORDS_FOR_LENGTH`. A grid the corpus can fill sends no requests at all.
- **What gets asked** (`planQueries`): slots whose fixed letters leave fewer than 40 corpus
  answers, plus unfilled slots in the failed run's best partial grid that have no corpus
  answer. At most 16 patterns, 6 at a time, with a 6 s timeout each.
- **What gets kept** (`fetchSupplements`): words not already in the corpus that fit the
  pattern letter for letter. Phrases squeezed to the wrong length are dropped. Words must
  have a frequency of at least 0.01 per million and a definition usable as a clue. Names,
  surnames and "alternative form of" senses are rejected. At most 40 per pattern.
- **Retry.** Supplements go into the index's ad-hoc tail with score 0–16000 (ranked by
  frequency) plus a `SUPPLEMENT_PENALTY`. They only win where nothing from the corpus fits.
  The retry is kept if it is complete or places more answers than the first run.
- **Clues.** A supplement's clue is its first usable definition (for example, KLOTZ is
  clued "A clumsy, awkward person"). The placement carries `clueSource: 'onelook'`. Create
  and Generate list the OneLook answers in the status line so the author can review them.
- **Off by:** CSV uploads and Tagalog mode (no packed clue store), `payload.onelook:
  false`, or the network being down (the fill then fails with the corpus's own reason).
- `ADHOC_CAPACITY` went from 32 to 128 per length to make room.
- **CORS trap (found by the browser e2e, invisible to Node):** OneLook's CloudFront caches
  each response together with the first requester's `Access-Control-Allow-Origin`, and
  does not `Vary: Origin`. So for up to a week, every other site asking the same URL got
  "Failed to fetch". Each request therefore carries `&ck=<hash of origin>`, which gives
  this site its own cache entries (OneLook ignores the parameter; the results are
  byte-identical). Don't name it `v`: OneLook uses that itself and returns HTTP 500. Don't
  pass a URL-shaped value either: the firewall returns 403.
- **Fallback:** if onelook.com fails, the same query goes to `api.datamuse.com`. Datamuse
  is OneLook's engine, with the same scores, and handles CORS per origin. It has fewer
  definitions (KLOTZ has none there, so it's dropped).

Verification: `test-onelook` 4 scenarios (new; real worker module, live network) ·
`bench-solver` 2760/2760 · `create-e2e` 26/26 (3 new KLOTZ checks in real Edge) ·
`generate-e2e` 23/23 · `editor-e2e` 28/28 · `eslint` (only the 4 known issues).

## Done in the 2026-10-11 session

### 1. Free-form Create editor
Create used to take its black squares from a fixed preset layout, so the author could only
type letters. Now:
- **It opens on a blank 15×15 grid.** Resize at any time from 3 to 25 in each direction
  (rows × columns, presets 5–21). Resizing is anchored at the top-left and keeps whatever
  still fits. "New blank" starts over at the chosen size.
- **Tools:**
  - **Letters** (the default). Typing works as before, and `.` toggles a black square at
    the cursor.
  - **Blocks.** Click or drag to toggle black squares.
  - **Circles.**
  - **Shade**, with six colours (grey, yellow, blue, green, pink, orange).
  - A drag paints every square it crosses to the state of the first square.
- **Symmetric blocks** (on by default) mirrors each block through the centre.
- **Templates** loads one of the saved layouts as a starting block pattern, asking first if
  there are letters to lose.
- **"Clear Letters"** replaced "Clear Grid". It keeps the blocks, circles and shades.
- **Grid check (`analyzeGrid`).**
  - These stop the fill, and their squares are outlined in red: 2-letter entries and
    white squares that belong to no entry.
  - Entries over 15 letters are allowed. The fill works around one you've typed in, and
    asks you to type it if it's blank.
  - These are listed but don't block the fill: unchecked squares and disconnected areas.
  - Fill Remaining refuses an unfillable grid and says why.
- **The Create grid, its clues, shades and symmetry setting are saved in the session.**
  Before this, a reload lost the grid but kept its pins.
- **Shade colours reach Play and multiplayer.** They travel as `shades` (keys) plus the new
  optional `shadeColors` (`{"r,c": colourId}`). They are included in export JSON, saved
  puzzles and share codes, and older readers still see grey.
- **Fixed:** Create's fill now hands the solver's measured difficulty to the label, as
  Generate does. Before, a fill asked for "easy" was re-labelled from the clue text alone.

### 2. Newspaper PDF export
The old **Download** button made a PNG and a .txt file. It is now **PDF** (also on the
Play toolbar).
- **Dialog fields:** title, byline and dateline (all remembered), US Letter or A4, an
  answer key on page 2, shades in colour or grey, and the difficulty label.
- **Preview:** a live preview on desktop. On a phone, the share sheet is used instead.
- **Layout:** a Times masthead with a double rule, the grid at the top right, and clues
  flowing through five newspaper columns. The type shrinks to fit (9.5pt down to 6.5pt);
  past that the clues continue on another page.
- **Answer key:** the filled grid plus an answer list.
- **The PNG is still available** from a link in the dialog.
- **Fonts:** jsPDF's standard fonts cover Windows-1252 only, so emoji and ♪ are dropped
  from clues in the PDF.

### Verification run this session
`editor-e2e` 28/28 · `create-e2e` 23/23 · `generate-e2e` 23/23 · `responsive-e2e` 17/17 ·
`bench-solver` passed · `test:pdf` passed (8 PDFs, every page rendered and inspected).

To look at PDF pages, install PyMuPDF into a temp target
(`python -m pip install --target %TEMP%\pymupdf pymupdf`), render at about 110 dpi, and
view the PNGs.

## Open items / ideas (not started)

- **Auto-place blocks:** suggest a fillable block pattern for a given size and word count.
  Today the author draws the blocks or starts from a template.
- **PDF typography:** embedding a TTF font (e.g. Libre Franklin) would cover characters
  outside Windows-1252 and match the app's type.
- **Main bundle size:** the main bundle is about 700 kB; jsPDF is already split out. Code-
  splitting App.jsx by tab would help mobile.
- **Template list:** `LayoutSelector` lists all 23 layouts in one scrolling menu. Grouping
  them by size would read better.
- **OneLook toggle:** the fallback is always on for the English corpus. A settings switch
  (and a per-clue "from OneLook" badge in the clue list, using `clueSource`) would let the
  author opt out or spot those clues later. Today the status line is the only signal, and
  `clueSource` is not persisted with the puzzle.
- **Not yet live-tested:** the real crosswithfriends fetch, 2-device multiplayer and
  Supabase auth (carried over from earlier sessions).
