// Printable crossword, laid out like a newspaper puzzle page.
//
// Page 1: a section-head masthead (title, byline, date/difficulty, thick-over-thin rule),
// the blank grid in the top-right corner, and the clues flowing through narrow columns
// around and under it — the NYT / LA Times print arrangement. Optional page 2: the
// filled grid and an answer list.
//
// jsPDF is ~350KB, and only someone pressing "Download PDF" needs it, so it is imported
// inside buildCrosswordPdf rather than at the top of the module.
//
// All units are points. The 14 standard PDF fonts only cover WinAnsi (cp1252), so every
// string is passed through toWinAnsi() before it is measured or drawn: jsPDF maps the
// cp1252 characters (— ’ é €) itself, but anything outside that set comes out as garbage.

import { decodeEntities } from './entities.js';
import { shadeColor } from './cellColors.js';

const PAGE_SIZES = { letter: [612, 792], a4: [595.28, 841.89] };
const MARGIN = 36;
const GUTTER = 10;
const INK = '#111111';
const GRID_LINE = '#222222';
const FOOTER_GREY = '#8a8a8a';

// Clue text sizes tried, largest first, until everything fits on page 1.
const MAX_CLUE_SIZE = 9.5;
const MIN_CLUE_SIZE = 6.5;
const SIZE_STEP = 0.25;

// ---------------------------------------------------------------------------
// Text: markup → styled runs → WinAnsi-safe strings
// ---------------------------------------------------------------------------

// The cp1252 characters that live in 0x80–0x9F; everything else allowed is Latin-1.
const CP1252_EXTRA = new Set('€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ');

// Symbols the corpus actually uses (via &hearts; &rarr; …) that have a readable stand-in.
const FALLBACK = {
  '♥': 'heart', '♡': 'heart', '♠': 'spade', '♦': 'diamond', '♣': 'club',
  '←': '<-', '→': '->', '↑': '^', '↓': 'v', '↔': '<->',
  '−': '-', '‐': '-', '‑': '-', '‒': '-', '―': '—', '′': "'", '″': '"',
  '★': '*', '☆': '*', '✱': '*', '≈': '~', '≠': '/=', '≤': '<=', '≥': '>=',
  '◯': 'O', '○': 'O', '△': 'triangle', 'ł': 'l', 'Ł': 'L', 'đ': 'd', 'Đ': 'D', 'ı': 'i',
  '\u2009': ' ', '\u200a': ' ', '\u2002': ' ', '\u2003': ' ', '\u202f': ' ',
};

/**
 * Keep what the standard fonts can draw. Accented letters outside Latin-1 (ā, ş, ő) keep
 * their base letter; emoji, music notes and other pictographs are dropped rather than
 * printed as mojibake.
 */
export function toWinAnsi(text) {
  if (!text) return '';
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 9 || cp === 10 || cp === 13) { out += ' '; continue; }
    if ((cp >= 0x20 && cp < 0x7f) || (cp >= 0xa0 && cp <= 0xff) || CP1252_EXTRA.has(ch)) {
      out += ch;
      continue;
    }
    if (FALLBACK[ch] !== undefined) { out += FALLBACK[ch]; continue; }
    const base = ch.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (base && base !== ch && [...base].every((b) => b.codePointAt(0) < 0x7f)) out += base;
  }
  return out;
}

// ***x*** first, so bold-italic does not leave a stray asterisk on each side.
const MARKDOWN = /(\*\*\*[^*]+\*\*\*|\*\*[^*]+\*\*|\*[^*]+\*|_[^_]+_)/g;
const TAG_RE = /<\s*(\/?)\s*([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g;

/**
 * Clue markup as styled runs: [{ text, bold, italic }]. Same vocabulary as renderRich in
 * richText.jsx — **bold**, *italic*, _italic_, and the <i>/<em>/<b>/<strong> tags —
 * with every other tag dropped and its text kept. Text is already WinAnsi-safe.
 */
export function clueRuns(text) {
  if (!text || typeof text !== 'string') return [];
  const runs = [];
  let bold = 0;
  let italic = 0;
  const add = (t, b, i) => {
    const s = toWinAnsi(t);
    if (!s) return;
    const prev = runs[runs.length - 1];
    if (prev && prev.bold === b && prev.italic === i) prev.text += s;
    else runs.push({ text: s, bold: b, italic: i });
  };
  const addMarkdown = (raw) => {
    const s = decodeEntities(raw);
    let last = 0;
    let m;
    MARKDOWN.lastIndex = 0;
    while ((m = MARKDOWN.exec(s)) !== null) {
      if (m.index > last) add(s.slice(last, m.index), bold > 0, italic > 0);
      const tok = m[0];
      if (tok.startsWith('***')) add(tok.slice(3, -3), true, true);
      else if (tok.startsWith('**')) add(tok.slice(2, -2), true, italic > 0);
      else add(tok.slice(1, -1), bold > 0, true);
      last = m.index + tok.length;
    }
    if (last < s.length) add(s.slice(last), bold > 0, italic > 0);
  };

  let i = 0;
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text)) !== null) {
    if (m.index > i) addMarkdown(text.slice(i, m.index));
    i = m.index + m[0].length;
    const delta = m[1] === '/' ? -1 : 1;
    const name = m[2].toLowerCase();
    if (name === 'br') add(' ', bold > 0, italic > 0);
    else if (name === 'i' || name === 'em') italic = Math.max(0, italic + delta);
    else if (name === 'b' || name === 'strong') bold = Math.max(0, bold + delta);
  }
  if (i < text.length) addMarkdown(text.slice(i));

  // Collapse whitespace across run boundaries and trim the ends.
  let prevSpace = true;
  for (const r of runs) {
    r.text = r.text.replace(/\s+/g, ' ');
    if (prevSpace) r.text = r.text.replace(/^ /, '');
    if (r.text) prevSpace = r.text.endsWith(' ');
  }
  while (runs.length && /^ *$/.test(runs[runs.length - 1].text)) runs.pop();
  if (runs.length) runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/ +$/, '');
  return runs.filter((r) => r.text);
}

/** "krosalita-my-puzzle.pdf" — the title, slugified. */
export function pdfFileName(options = {}) {
  const slug = String(options.title || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return `krosalita-${slug || 'crossword'}.pdf`;
}

// ---------------------------------------------------------------------------
// Measuring and wrapping
// ---------------------------------------------------------------------------

const styleOf = (bold, italic) =>
  (bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'normal');

function makeMeasure(doc) {
  // Widths at 1pt, cached: the fitting loop re-wraps every clue at a dozen sizes.
  const cache = new Map();
  return (text, style, size) => {
    const key = `${style}|${text}`;
    let w = cache.get(key);
    if (w === undefined) {
      doc.setFont('helvetica', style);
      doc.setFontSize(100);
      w = doc.getTextWidth(text) / 100;
      cache.set(key, w);
    }
    return w * size;
  };
}

/**
 * Greedy word wrap over styled runs. A "word" is everything between spaces, so
 * "*Hamlet*'s" stays one unbreakable unit even though it spans two styles.
 * Returns lines of words; each word is [{ text, style, w }].
 */
function wrapRuns(runs, width, size, measure) {
  const words = [];
  let cur = null;
  for (const run of runs) {
    const style = styleOf(run.bold, run.italic);
    for (const part of run.text.split(/( +)/)) {
      if (!part) continue;
      if (part.trim() === '') { cur = null; continue; }
      if (!cur) { cur = { pieces: [], w: 0 }; words.push(cur); }
      // Italic correction: an oblique word's last letter leans into the following space.
      const w = measure(part, style, size) + (run.italic ? size * 0.08 : 0);
      cur.pieces.push({ text: part, style, w });
      cur.w += w;
    }
  }

  const space = measure(' ', 'normal', size);
  const lines = [];
  let line = [];
  let lineW = 0;
  const flush = () => { if (line.length) lines.push(line); line = []; lineW = 0; };

  for (const word of words) {
    if (word.w > width) {
      // A single token wider than the column (a URL, a long rebus string): hard-break it.
      flush();
      for (const chunk of breakWord(word, width, size, measure)) {
        if (lineW && lineW + chunk.w > width) flush();
        line.push(chunk);
        lineW += chunk.w;
      }
      continue;
    }
    const need = line.length ? lineW + space + word.w : word.w;
    if (need > width && line.length) flush();
    lineW = line.length ? lineW + space + word.w : word.w;
    line.push(word);
  }
  flush();
  return lines.map((ws) => ws.map((w) => w.pieces));
}

function breakWord(word, width, size, measure) {
  const chunks = [];
  let pieces = [];
  let w = 0;
  for (const p of word.pieces) {
    for (const ch of p.text) {
      const cw = measure(ch, p.style, size);
      if (w + cw > width && w > 0) { chunks.push({ pieces, w }); pieces = []; w = 0; }
      const last = pieces[pieces.length - 1];
      if (last && last.style === p.style) { last.text += ch; last.w += cw; }
      else pieces.push({ text: ch, style: p.style, w: cw });
      w += cw;
    }
  }
  if (pieces.length) chunks.push({ pieces, w });
  return chunks;
}

// ---------------------------------------------------------------------------
// Newspaper column flow
// ---------------------------------------------------------------------------

/**
 * Metrics for one clue size. Everything vertical scales with the type so a shrunken
 * page keeps the same proportions.
 */
function flowMetrics(size) {
  return {
    size,
    lineH: size * 1.16,
    entryGap: size * 0.28,
    headSize: size * 1.08,
    headH: size * 1.55,       // heading line plus the hairline and space under it
    headGapBefore: size * 1.1, // space above a heading that follows clues in the same column
  };
}

/**
 * Pour items ({ kind: 'head', text } | { kind: 'entry', num, runs }) into the columns of
 * each page in turn. Entries never split across columns, and a heading is only placed
 * where its first entry fits under it. Returns null if pages run out.
 */
function flow(items, pages, metrics, numW, measure, { breakBeforeDown = false } = {}) {
  const { size, lineH, entryGap, headH, headGapBefore } = metrics;
  const colW = pages[0][0].w;
  const indent = numW + size * 0.5;

  const blocks = items.map((it) => {
    if (it.kind === 'head') return { it, h: headH };
    const lines = wrapRuns(it.runs, colW - indent, size, measure);
    if (!lines.length) lines.push([]);
    return { it, lines, h: lines.length * lineH };
  });

  const placed = [];
  let p = 0;
  let c = 0;
  let y = pages[0][0].top;
  let atTop = true;
  const advance = () => {
    c += 1;
    if (c >= pages[p].length) { p += 1; c = 0; }
    if (p >= pages.length) return false;
    y = pages[p][c].top;
    atTop = true;
    return true;
  };

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (p >= pages.length) return null;
    if (b.it.kind === 'head') {
      // Never orphan a heading: it travels with the entry under it.
      const next = blocks[i + 1];
      const need = (atTop ? 0 : headGapBefore) + b.h + (next ? next.h : 0);
      let col = pages[p][c];
      if (breakBeforeDown && placed.length && !atTop) {
        if (!advance()) return null;
        col = pages[p][c];
      } else if (y + need > col.bottom && !atTop) {
        if (!advance()) return null;
        col = pages[p][c];
      }
      if (y + b.h + (next ? next.h : 0) > col.bottom) {
        // Does not fit even in an empty column; try the next one.
        if (!advance()) return null;
        col = pages[p][c];
        if (y + b.h + (next ? next.h : 0) > col.bottom) return null;
      }
      if (!atTop) y += headGapBefore;
      placed.push({ ...b, page: p, x: col.x, y, w: col.w });
      y += b.h;
      atTop = true; // no extra gap between a heading and its first entry
      continue;
    }
    let col = pages[p][c];
    const gap = atTop ? 0 : entryGap;
    if (y + gap + b.h > col.bottom) {
      // Skip columns too short for this entry (e.g. a sliver left under a tall grid).
      do {
        if (!advance()) return null;
        col = pages[p][c];
      } while (y + b.h > col.bottom);
    } else {
      y += gap;
    }
    placed.push({ ...b, page: p, x: col.x, y, w: col.w });
    y += b.h;
    atTop = false;
  }
  return { placed, indent };
}

function drawFlow(doc, result, metrics, numW, pageOffset) {
  const { size, lineH, headSize } = metrics;
  for (const blk of result.placed) {
    doc.setPage(pageOffset + blk.page + 1);
    doc.setTextColor(INK);
    if (blk.it.kind === 'head') {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(headSize);
      const base = blk.y + headSize * 0.92;
      doc.text(blk.it.text, blk.x, base, { charSpace: headSize * 0.12 });
      doc.setDrawColor(INK);
      doc.setLineWidth(0.4);
      const ruleY = base + headSize * 0.32;
      doc.line(blk.x, ruleY, blk.x + blk.w, ruleY);
      continue;
    }
    const lead = lineH * 0.8;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(size);
    doc.text(blk.it.num, blk.x + numW, blk.y + lead, { align: 'right' });
    const space = doc.getTextWidth(' ');
    blk.lines.forEach((words, li) => {
      let x = blk.x + result.indent;
      const base = blk.y + lead + li * lineH;
      for (const pieces of words) {
        for (const pc of pieces) {
          doc.setFont('helvetica', pc.style);
          doc.text(pc.text, x, base);
          x += pc.w;
        }
        x += space;
      }
    });
  }
}

// ---------------------------------------------------------------------------
// Grid
// ---------------------------------------------------------------------------

const isBlock = (v) => v === '#';
const cellText = (v) => (typeof v === 'string' && v !== '#' && v !== '.' ? v.trim() : '');

/** "r,c" → clue number, from the clue lists; computed from the grid if there are none. */
function cellNumbers(grid, clues) {
  const nums = new Map();
  for (const dir of ['across', 'down']) {
    for (const cl of clues?.[dir] || []) {
      if (cl && Number.isFinite(cl.row) && Number.isFinite(cl.col)) nums.set(`${cl.row},${cl.col}`, cl.number);
    }
  }
  if (nums.size) return nums;
  let n = 0;
  const rows = grid.length;
  for (let r = 0; r < rows; r++) {
    const cols = grid[r].length;
    for (let c = 0; c < cols; c++) {
      if (isBlock(grid[r][c])) continue;
      const open = (rr, cc) => rr >= 0 && rr < rows && cc >= 0 && cc < cols && !isBlock(grid[rr][cc]);
      const across = !open(r, c - 1) && open(r, c + 1);
      const down = !open(r - 1, c) && open(r + 1, c);
      if (across || down) nums.set(`${r},${c}`, ++n);
    }
  }
  return nums;
}

function drawGrid(doc, puzzle, x0, y0, cell, { letters, color }) {
  const { grid } = puzzle;
  const rows = grid.length;
  const cols = Math.max(...grid.map((r) => r.length));
  const W = cols * cell;
  const H = rows * cell;
  const shades = new Set(puzzle.shades || []);
  const circles = new Set(puzzle.circles || []);
  const shadeIds = puzzle.shadeColors || {};
  const nums = cellNumbers(grid, puzzle.clues);

  // Fills first, so the lines and numbers sit on top of them.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = grid[r][c];
      const x = x0 + c * cell;
      const y = y0 + r * cell;
      if (v === undefined || isBlock(v)) {
        doc.setFillColor('#000000');
        doc.rect(x, y, cell, cell, 'F');
      } else if (shades.has(`${r},${c}`)) {
        const pal = shadeColor(shadeIds[`${r},${c}`]);
        doc.setFillColor(color ? pal.print : pal.grey);
        doc.rect(x, y, cell, cell, 'F');
      }
    }
  }

  doc.setDrawColor(GRID_LINE);
  doc.setLineWidth(Math.max(0.35, Math.min(0.6, cell * 0.025)));
  for (let r = 1; r < rows; r++) doc.line(x0, y0 + r * cell, x0 + W, y0 + r * cell);
  for (let c = 1; c < cols; c++) doc.line(x0 + c * cell, y0, x0 + c * cell, y0 + H);

  if (circles.size) {
    doc.setDrawColor('#000000');
    doc.setLineWidth(Math.max(0.35, cell * 0.022));
    for (const key of circles) {
      const [r, c] = key.split(',').map(Number);
      if (!(r >= 0 && r < rows && c >= 0 && c < cols) || isBlock(grid[r][c])) continue;
      doc.circle(x0 + (c + 0.5) * cell, y0 + (r + 0.5) * cell, cell * 0.45, 'S');
    }
  }

  // Numbers sit over the circle line; a little white knock-out behind them would be
  // nicer on a shaded square but costs legibility on cheap printers, so none.
  const numSize = Math.max(4.5, cell * 0.28);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(numSize);
  doc.setTextColor(INK);
  for (const [key, n] of nums) {
    const [r, c] = key.split(',').map(Number);
    if (r >= rows || c >= cols) continue;
    doc.text(String(n), x0 + c * cell + cell * 0.07, y0 + r * cell + cell * 0.06 + numSize * 0.78);
  }

  if (letters) {
    doc.setFont('helvetica', 'bold');
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const t = toWinAnsi(cellText(grid[r][c])).toUpperCase();
        if (!t) continue;
        let size = cell * 0.55;
        doc.setFontSize(size);
        // Rebus squares: shrink until the whole entry fits inside the square.
        const maxW = cell * 0.84;
        const w = doc.getTextWidth(t);
        if (w > maxW) { size *= maxW / w; doc.setFontSize(size); }
        // Shrunken rebus text drops a little lower, clear of the clue number.
        const cy = y0 + r * cell + cell * (t.length > 1 ? 0.66 : 0.6);
        doc.text(t, x0 + (c + 0.5) * cell, cy + size * 0.36, { align: 'center' });
      }
    }
  }

  // Heavy outer border last, so it covers the half-width of the edge cells' lines.
  doc.setDrawColor('#000000');
  doc.setLineWidth(1.5);
  doc.rect(x0, y0, W, H, 'S');
  return { W, H };
}

// ---------------------------------------------------------------------------
// Page furniture
// ---------------------------------------------------------------------------

/** Masthead: title + byline on the left, date/difficulty on the right, double rule. */
function drawHeader(doc, pageW, { title, byline, rightLines, titleSize = 26 }) {
  const contentW = pageW - 2 * MARGIN;
  doc.setTextColor(INK);

  // Right block first: the title gets whatever width it leaves.
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  let rightW = 0;
  for (const l of rightLines) rightW = Math.max(rightW, doc.getTextWidth(l.text) + (l.spacing || 0) * l.text.length);

  let size = titleSize;
  doc.setFont('times', 'bold');
  doc.setFontSize(size);
  const maxTitleW = contentW - (rightW ? rightW + 18 : 0);
  const tw = doc.getTextWidth(title);
  if (tw > maxTitleW) { size = Math.max(14, size * (maxTitleW / tw)); doc.setFontSize(size); }
  let shown = title;
  while (doc.getTextWidth(shown) > maxTitleW && shown.length > 4) shown = `${shown.slice(0, -2)}…`;
  const titleBase = MARGIN + size * 0.78;
  doc.text(shown, MARGIN, titleBase);

  let bottom = titleBase;
  if (byline) {
    doc.setFont('times', 'italic');
    doc.setFontSize(11.5);
    bottom = titleBase + 15;
    doc.text(byline, MARGIN, bottom);
  }

  // Right block sits on the same baseline as the last left-hand line.
  const n = rightLines.length;
  rightLines.forEach((l, i) => {
    doc.setFont('helvetica', l.bold ? 'bold' : 'normal');
    doc.setFontSize(l.size || 8.5);
    doc.setTextColor(l.grey ? '#444444' : INK);
    const y = bottom - (n - 1 - i) * 11;
    const w = doc.getTextWidth(l.text) + (l.spacing || 0) * Math.max(0, l.text.length - 1);
    doc.text(l.text, pageW - MARGIN - w, y, { charSpace: l.spacing || 0 });
  });
  doc.setTextColor(INK);

  // Newspaper section rule: thick over thin.
  const ruleY = bottom + 8;
  doc.setDrawColor('#000000');
  doc.setLineWidth(2);
  doc.line(MARGIN, ruleY, pageW - MARGIN, ruleY);
  doc.setLineWidth(0.5);
  doc.line(MARGIN, ruleY + 3.2, pageW - MARGIN, ruleY + 3.2);
  return ruleY + 3.2;
}

function drawFooter(doc, pageW, pageH, text) {
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(7);
  doc.setTextColor(FOOTER_GREY);
  doc.text(text, pageW / 2, pageH - MARGIN / 2 - 2, { align: 'center' });
  doc.setTextColor(INK);
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

function clueItems(clues) {
  const items = [];
  for (const [dir, label] of [['across', 'ACROSS'], ['down', 'DOWN']]) {
    const list = clues?.[dir] || [];
    if (!list.length) continue;
    items.push({ kind: 'head', text: label });
    for (const cl of list) {
      const runs = clueRuns(cl.clue);
      // An empty clue still gets its number, with a dash so it reads as deliberate.
      items.push({ kind: 'entry', num: String(cl.number), runs: runs.length ? runs : [{ text: '—', bold: false, italic: false }] });
    }
  }
  return items;
}

function answerFor(grid, cl, dir) {
  let s = '';
  for (let k = 0; k < cl.length; k++) {
    const r = dir === 'down' ? cl.row + k : cl.row;
    const c = dir === 'across' ? cl.col + k : cl.col;
    const t = cellText(grid[r]?.[c]);
    if (!t) return null;
    s += t.length > 1 ? `[${t}]` : t;
  }
  return toWinAnsi(s.toUpperCase());
}

function numberWidth(items, size, measure) {
  let w = 0;
  for (const it of items) if (it.kind === 'entry') w = Math.max(w, measure(it.num, 'bold', size));
  return w;
}

/**
 * Build the printable PDF.
 * @param {{grid: string[][], clues: {across: object[], down: object[]}, circles?: string[],
 *          shades?: string[], shadeColors?: Object<string,string>}} puzzle
 * @param {{title?: string, author?: string, dateLabel?: string, difficultyLabel?: string,
 *          pageSize?: 'letter'|'a4', answerKey?: boolean, color?: boolean}} options
 * @returns {Promise<Blob>} application/pdf
 */
export async function buildCrosswordPdf(puzzle, options = {}) {
  const { jsPDF } = await import('jspdf');
  const pageSize = options.pageSize === 'a4' ? 'a4' : 'letter';
  const [pageW, pageH] = PAGE_SIZES[pageSize];
  const color = options.color !== false;
  const title = toWinAnsi(decodeEntities(options.title || '').trim()) || 'The Crossword';
  const author = toWinAnsi(decodeEntities(options.author || '').trim());
  const byline = author ? (/^by\s/i.test(author) ? author : `By ${author}`) : '';
  const rightLines = [];
  if (options.dateLabel) rightLines.push({ text: toWinAnsi(options.dateLabel), size: 8.5 });
  if (options.difficultyLabel) {
    rightLines.push({ text: toWinAnsi(options.difficultyLabel).toUpperCase(), size: 7.5, bold: true, spacing: 0.9, grey: true });
  }

  const doc = new jsPDF({ unit: 'pt', format: pageSize, orientation: 'portrait', compress: true });
  doc.setProperties({ title, author: author || 'Krosalita', creator: 'Krosalita' });
  doc.setLineCap('butt');
  const measure = makeMeasure(doc);

  const grid = puzzle.grid || [];
  const rows = grid.length;
  const cols = rows ? Math.max(...grid.map((r) => r.length)) : 0;
  const contentW = pageW - 2 * MARGIN;
  const bodyBottom = pageH - MARGIN - 6;

  // ---- Page 1 -------------------------------------------------------------
  const headerBottom = drawHeader(doc, pageW, { title, byline, rightLines });
  const bodyTop = headerBottom + 14;

  const nCols = 5;
  const colW = (contentW - (nCols - 1) * GUTTER) / nCols;
  const span = cols <= 7 ? 2 : 3;
  const spanW = span * colW + (span - 1) * GUTTER;
  const spanX = MARGIN + (nCols - span) * (colW + GUTTER);
  const cell = Math.min(spanW / Math.max(cols, 1), 27, ((bodyBottom - bodyTop) * 0.62) / Math.max(rows, 1));
  const gridW = cell * cols;
  const gridH = cell * rows;
  // Right-aligned to the margin like a print page; a small grid is centred in its span.
  const gridX = gridW < spanW - 1 ? spanX + (spanW - gridW) / 2 : spanX;
  if (rows) drawGrid(doc, puzzle, gridX, bodyTop, cell, { letters: false, color });

  const underTop = bodyTop + gridH + 16;
  const page1Cols = [];
  for (let i = 0; i < nCols; i++) {
    const x = MARGIN + i * (colW + GUTTER);
    page1Cols.push({ x, w: colW, top: i < nCols - span ? bodyTop : underTop, bottom: bodyBottom });
  }

  const items = clueItems(puzzle.clues);
  let result = null;
  let metrics = null;
  let numW = 0;
  // Minis have room to spare; let their clues print a touch larger.
  const startSize = cols <= 7 ? 10.5 : MAX_CLUE_SIZE;
  for (let s = startSize; s >= MIN_CLUE_SIZE - 1e-6; s -= SIZE_STEP) {
    metrics = flowMetrics(s);
    numW = numberWidth(items, s, measure);
    // A mini prints Across and Down side by side, as newspapers set them; bigger grids
    // just flow, since a forced break would waste most of a column.
    if (cols <= 7) result = flow(items, [page1Cols], metrics, numW, measure, { breakBeforeDown: true });
    if (!result) result = flow(items, [page1Cols], metrics, numW, measure);
    if (result) break;
  }

  // Rare: even the smallest size overflows. Continue on extra pages of full-height columns,
  // and since the clues have the room now, take the largest size that fits in them.
  let extraPages = 0;
  if (!result) {
    const contTop = MARGIN + 30;
    const fullCols = page1Cols.map((c) => ({ ...c, top: contTop }));
    for (let n = 1; n <= 6 && !result; n++) {
      const pages = [page1Cols, ...Array(n).fill(fullCols)];
      for (let s = MAX_CLUE_SIZE; s >= MIN_CLUE_SIZE - 1e-6 && !result; s -= SIZE_STEP) {
        metrics = flowMetrics(s);
        numW = numberWidth(items, s, measure);
        result = flow(items, pages, metrics, numW, measure);
      }
      extraPages = n;
    }
  }
  for (let i = 0; i < extraPages; i++) {
    doc.addPage(pageSize, 'portrait');
    doc.setFont('times', 'bold');
    doc.setFontSize(14);
    doc.setTextColor(INK);
    doc.text(`${title} (continued)`, MARGIN, MARGIN + 12);
    doc.setDrawColor('#000000');
    doc.setLineWidth(0.8);
    doc.line(MARGIN, MARGIN + 19, pageW - MARGIN, MARGIN + 19);
  }
  if (result) drawFlow(doc, result, metrics, numW, 0);

  const puzzlePages = 1 + extraPages;
  const keyPage = puzzlePages + 1;
  for (let p = 1; p <= puzzlePages; p++) {
    doc.setPage(p);
    const parts = ['Krosalita'];
    if (puzzlePages > 1) parts.push(`Page ${p} of ${puzzlePages}`);
    if (options.answerKey) parts.push(`Solution on page ${keyPage}`);
    drawFooter(doc, pageW, pageH, parts.join('  ·  '));
  }

  // ---- Answer key -----------------------------------------------------------
  if (options.answerKey && rows) {
    doc.addPage(pageSize, 'portrait');
    const top = drawHeader(doc, pageW, {
      title: `Solution — ${title}`,
      byline,
      rightLines,
      titleSize: 22,
    }) + 18;

    // Leave the lower part of the page for the answer list when there is one.
    const keyCell = Math.min(30, (contentW * 0.72) / cols, ((bodyBottom - top) * 0.6) / rows);
    const kx = (pageW - keyCell * cols) / 2;
    drawGrid(doc, puzzle, kx, top, keyCell, { letters: true, color });

    const keyItems = [];
    let complete = true;
    for (const [dir, label] of [['across', 'ACROSS'], ['down', 'DOWN']]) {
      const list = puzzle.clues?.[dir] || [];
      if (!list.length) continue;
      keyItems.push({ kind: 'head', text: label });
      for (const cl of list) {
        const ans = answerFor(grid, cl, dir);
        if (!ans) { complete = false; break; }
        keyItems.push({ kind: 'entry', num: String(cl.number), runs: [{ text: ans, bold: false, italic: false }] });
      }
    }
    // The list is a convenience; it only prints if the grid is filled and it fits cleanly.
    if (complete && keyItems.length) {
      const listTop = top + keyCell * rows + 22;
      const n = 6;
      const w = (contentW - (n - 1) * GUTTER) / n;
      const listCols = Array.from({ length: n }, (_, i) => ({
        x: MARGIN + i * (w + GUTTER), w, top: listTop, bottom: bodyBottom,
      }));
      for (let s = 8; s >= 6.5 - 1e-6; s -= 0.25) {
        const m = flowMetrics(s);
        const nw = numberWidth(keyItems, s, measure);
        const r = flow(keyItems, [listCols], m, nw, measure);
        if (r) { drawFlow(doc, r, m, nw, keyPage - 1); break; }
      }
    }
    doc.setPage(keyPage);
    drawFooter(doc, pageW, pageH, 'Krosalita  ·  Solution');
  }

  return doc.output('blob');
}
