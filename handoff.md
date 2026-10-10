# handoff.md — Krosalita, current state

_Last updated 2026-10-11. Read `rules.md` first for the rules; this file covers where things stand._

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
  - These stop the fill, and their squares are outlined in red: 2-letter entries, entries
    over 15 letters, and white squares that belong to no entry.
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
`editor-e2e` 26/26 · `create-e2e` 23/23 · `generate-e2e` 23/23 · `responsive-e2e` 17/17 ·
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
- **Not yet live-tested:** the real crosswithfriends fetch, 2-device multiplayer and
  Supabase auth (carried over from earlier sessions).
