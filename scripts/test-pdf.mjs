// Builds the newspaper-style PDFs for a spread of grid sizes and sanity-checks them.
//
//   node scripts/test-pdf.mjs [outDir]      (default: the OS temp dir)
//
// The checks are structural (non-empty, PDF mime type, right page count) plus a few on the
// text path; whether the page LOOKS like a newspaper is a human call — open the PDFs it
// writes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCrosswordPdf, pdfFileName, clueRuns, toWinAnsi } from '../src/utils/pdfExport.js';
import { ALL_LAYOUTS } from '../src/data/layouts.js';

const outDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), 'krosalita-pdf'));
fs.mkdirSync(outDir, { recursive: true });

let failures = 0;
const check = (ok, msg) => {
  if (!ok) { failures++; console.error(`  FAIL ${msg}`); }
};

// Realistic clue lengths: mostly short, some long, a few with markup and odd characters.
const CLUE_BANK = [
  'Opposite of WSW',
  'Pinot ___ (white wine)',
  'Like some **bold** predictions',
  'Sound of disapproval',
  'Actress Thompson of *Love Actually*',
  'Where the action is, so to speak, in a long and winding metaphorical sense',
  'Crème brûlée ingredient',
  'Señor’s “sí”',
  'Tic-___-toe',
  'Wordsworth works &mdash; or Keats ones',
  'Beethoven’s “Für ___”',
  'Hum along ♪ to a tune you half remember',
  '<i>White Men Can’t Jump</i> star Wesley',
  'Feature of a 1-Across, often',
  'Some are “golden” in retirement planning brochures',
  'Hawaiian garland',
  '_Très_ chic',
  '“Yikes!” 😂',
  'Ocean motion',
  'Shade of blue named for a Mediterranean sea that sounds like a gemstone',
  'Org. with a “Most Wanted” list',
  'Cry from a crow\'s nest',
  'E.R. figures',
  'Classic ***bold italic*** ending',
  '',
  'Mozart’s “Così fan ___”',
  'Like a well-made bed',
  '&hearts; symbol, informally, in a text',
];

const ALPHA = 'ETAOINSHRDLUCMFWYPGBVK';

/** Fill a layout with dummy letters and number its slots like the app does. */
function makePuzzle(layoutGrid, { rebus = [], bank = CLUE_BANK } = {}) {
  const rows = layoutGrid.length;
  const cols = layoutGrid[0].length;
  const grid = layoutGrid.map((row, r) =>
    [...row].map((ch, c) => (ch === '#' ? '#' : ALPHA[(r * 7 + c * 3) % ALPHA.length])));
  for (const [r, c, s] of rebus) grid[r][c] = s;

  const open = (r, c) => r >= 0 && r < rows && c >= 0 && c < cols && grid[r][c] !== '#';
  const across = [];
  const down = [];
  let n = 0;
  let k = 0;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (!open(r, c)) continue;
      const a = !open(r, c - 1) && open(r, c + 1);
      const d = !open(r - 1, c) && open(r + 1, c);
      if (!a && !d) continue;
      n++;
      if (a) {
        let len = 0; while (open(r, c + len)) len++;
        across.push({ number: n, row: r, col: c, length: len, clue: bank[k++ % bank.length] });
      }
      if (d) {
        let len = 0; while (open(r + len, c)) len++;
        down.push({ number: n, row: r, col: c, length: len, clue: bank[(k++ * 5) % bank.length] });
      }
    }
  }
  return { grid, clues: { across, down }, circles: [], shades: [], shadeColors: {} };
}

const layout = (name) => {
  const l = ALL_LAYOUTS.find((x) => x.name === name);
  if (!l) throw new Error(`no layout ${name}`);
  return l.grid;
};

/** Page count straight from the PDF objects. */
async function pageCount(blob) {
  const text = Buffer.from(await blob.arrayBuffer()).toString('latin1');
  return (text.match(/\/Type\s*\/Page(?!s)/g) || []).length;
}

const themed = makePuzzle(layout('Classic 15x15'), { rebus: [[0, 1, 'JAM'], [7, 7, 'HEART']] });
themed.circles = ['3,3', '3,4', '3,5', '3,6', '11,8', '11,9', '11,10'];
themed.shades = ['5,5', '5,6', '5,7', '9,7', '9,8', '9,9', '12,0', '12,1', '12,2', '1,13'];
themed.shadeColors = { '5,5': 'yellow', '5,6': 'yellow', '5,7': 'yellow', '9,7': 'blue', '9,8': 'blue', '9,9': 'blue', '12,0': 'pink', '12,1': 'green', '12,2': 'orange' };

const CASES = [
  {
    file: '15x15-letter', puzzle: makePuzzle(layout('Classic 15x15')),
    options: { title: 'Out of Left Field', author: 'Gio Pascua', dateLabel: 'Sunday, October 11, 2026', difficultyLabel: 'Medium', pageSize: 'letter', answerKey: true },
    pages: 2,
  },
  {
    file: '15x15-a4-nokey', puzzle: makePuzzle(layout('Classic 15x15')),
    options: { title: 'Out of Left Field', author: 'Gio Pascua', dateLabel: '11 October 2026', pageSize: 'a4', answerKey: false },
    pages: 1,
  },
  {
    file: 'mini-5x5', puzzle: makePuzzle(layout('Mini 5x5 - Corner')),
    options: { title: 'The Mini', author: 'Gio', difficultyLabel: 'Easy', answerKey: true },
    pages: 2,
  },
  {
    file: '21x21-letter', puzzle: makePuzzle(layout('Sunday 21x21 - Long')),
    options: { title: 'Sunday Puzzle — Crossed Wires', author: 'Gio Pascua', dateLabel: 'Sunday, October 11, 2026', difficultyLabel: 'Hard', answerKey: true },
    pages: 2,
  },
  {
    file: '21x21-a4-dense', puzzle: makePuzzle(layout('Sunday 21x21 - Dense')),
    options: { pageSize: 'a4', answerKey: false },
    pages: 1,
  },
  {
    // Overflow path: a 25x25 of nothing but long clues cannot fit on one page even at the
    // smallest size, so the clues must continue onto a second page before the key.
    file: 'overflow-25x25',
    puzzle: makePuzzle(layout('Stress 25x25'), { bank: CLUE_BANK.filter((c) => c.length > 40) }),
    options: { title: 'Stress Test', answerKey: true },
    minPages: 3,
  },
  {
    file: 'themed-color', puzzle: themed,
    options: { title: 'Circles & Shades', author: 'Gio Pascua', dateLabel: 'Monday, October 12, 2026', difficultyLabel: 'Easy', answerKey: true, color: true },
    pages: 2,
  },
  {
    file: 'themed-grey', puzzle: themed,
    options: { title: 'Circles & Shades', author: 'Gio Pascua', answerKey: true, color: false, pageSize: 'a4' },
    pages: 2,
  },
];

// Unit checks on the text path, independent of layout.
const runs = clueRuns('<i>White Men</i> **Can’t** Jump &mdash; ♪ é 😂');
check(runs.length === 4, `clueRuns split into styled runs (got ${JSON.stringify(runs)})`);
check(runs[0].italic && runs[0].text === 'White Men', 'clueRuns: <i> is italic');
check(runs[2].bold && runs[2].text === 'Can’t', 'clueRuns: ** is bold');
check(!/[♪😂]/u.test(runs.map((r) => r.text).join('')), 'clueRuns: non-cp1252 dropped');
check(toWinAnsi('ā → ♥') === 'a -> heart', `toWinAnsi fallbacks (got "${toWinAnsi('ā → ♥')}")`);
check(pdfFileName({ title: 'Crème de la Crème!' }) === 'krosalita-creme-de-la-creme.pdf', 'pdfFileName slug');
check(pdfFileName({}) === 'krosalita-crossword.pdf', 'pdfFileName default');

for (const c of CASES) {
  const t0 = performance.now();
  const blob = await buildCrosswordPdf(c.puzzle, c.options);
  const ms = performance.now() - t0;
  const pages = await pageCount(blob);
  const file = path.join(outDir, `${c.file}.pdf`);
  fs.writeFileSync(file, Buffer.from(await blob.arrayBuffer()));
  console.log(`${c.file.padEnd(16)} ${String(blob.size).padStart(7)} B  ${pages} page(s)  ${ms.toFixed(0)}ms  ${file}`);
  check(blob.size > 1000, `${c.file}: blob is non-trivial`);
  check(blob.type === 'application/pdf', `${c.file}: mime type (${blob.type})`);
  if (c.minPages) check(pages >= c.minPages, `${c.file}: expected >= ${c.minPages} pages, got ${pages}`);
  else check(pages === c.pages, `${c.file}: expected ${c.pages} page(s), got ${pages}`);
}

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall PDF checks passed');
