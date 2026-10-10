// Shared crossword utilities

export const parseCSV = (text) => {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const getDay = (raw) => {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return '';
    return dayNames[d.getDay()];
  };
  const lines = text.trim().split('\n');
  const parsed = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const parts = [];
    let current = '';
    let inQuotes = false;
    for (let char of line) {
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        parts.push(current.trim());
        current = '';
      } else {
        current += char;
      }
    }
    parts.push(current.trim());
    if (parts.length >= 3) {
      const rawDate = parts[0].replace(/"/g, '').trim();
      const word = parts[1].replace(/"/g, '').trim().toUpperCase().replace(/[^A-Z]/g, '');
      const clue = parts[2].replace(/"/g, '').trim();
      const difficulty = (parts[3] || '').replace(/"/g, '').trim();
      if (word && clue) {
        parsed.push({ date: rawDate, day: getDay(rawDate), word, clue, difficulty });
      }
    }
  }
  return parsed.sort((a, b) => b.word.length - a.word.length);
};

// findSlots is pure in `layout` and is called from many hot paths (render,
// click handlers, the solver). Memoize on the layout array reference so a given
// layout's slots are computed once. Layout grids are treated as immutable
// (replaced, never mutated in place), and the returned array is only read, so
// sharing the cached instance is safe.
const slotsCache = new WeakMap();

export const findSlots = (layout) => {
  if (layout && typeof layout === 'object') {
    const cached = slotsCache.get(layout);
    if (cached) return cached;
    const computed = computeSlots(layout);
    slotsCache.set(layout, computed);
    return computed;
  }
  return computeSlots(layout);
};

// Build a "row,col" -> clue number lookup for a clue set, cached per clue-set
// object so per-cell number lookups during render are O(1) instead of scanning
// both clue arrays for every cell.
const cellNumberCache = new WeakMap();

export const getCellNumber = (clueSet, r, c) => {
  if (!clueSet) return null;
  let map = cellNumberCache.get(clueSet);
  if (!map) {
    map = new Map();
    for (const cl of clueSet.across || []) {
      const k = `${cl.row},${cl.col}`;
      if (!map.has(k)) map.set(k, cl.number);
    }
    for (const cl of clueSet.down || []) {
      const k = `${cl.row},${cl.col}`;
      if (!map.has(k)) map.set(k, cl.number);
    }
    cellNumberCache.set(clueSet, map);
  }
  const n = map.get(`${r},${c}`);
  return n === undefined ? null : n;
};

const computeSlots = (layout) => {
  const slots = [];
  const rows = layout.length;
  const cols = layout[0].length;
  for (let r = 0; r < rows; r++) {
    let start = -1;
    for (let c = 0; c <= cols; c++) {
      if (c < cols && layout[r][c] === '.') {
        if (start === -1) start = c;
      } else {
        if (start !== -1 && c - start >= 2) {
          slots.push({ row: r, col: start, length: c - start, direction: 'across', id: `across-${r}-${start}` });
        }
        start = -1;
      }
    }
  }
  for (let c = 0; c < cols; c++) {
    let start = -1;
    for (let r = 0; r <= rows; r++) {
      if (r < rows && layout[r][c] === '.') {
        if (start === -1) start = r;
      } else {
        if (start !== -1 && r - start >= 2) {
          slots.push({ row: start, col: c, length: r - start, direction: 'down', id: `down-${start}-${c}` });
        }
        start = -1;
      }
    }
  }
  return slots;
};

export const assignNumbers = (placements) => {
  const numbered = [];
  const numberMap = new Map();
  let currentNumber = 1;
  const positions = placements.map(p => ({
    row: p.slot.row,
    col: p.slot.col,
    direction: p.slot.direction,
    word: p.word,
    clue: p.clue,
    length: p.slot.length
  })).sort((a, b) => a.row !== b.row ? a.row - b.row : a.col - b.col);
  for (const pos of positions) {
    const key = `${pos.row},${pos.col}`;
    if (!numberMap.has(key)) numberMap.set(key, currentNumber++);
    numbered.push({ number: numberMap.get(key), direction: pos.direction, word: pos.word, clue: pos.clue, row: pos.row, col: pos.col, length: pos.length });
  }
  return numbered;
};

export const getWordFromGrid = (grid, row, col, length, direction) => {
  let word = '';
  for (let i = 0; i < length; i++) {
    const r = direction === 'across' ? row : row + i;
    const c = direction === 'across' ? col + i : col;
    if (grid[r] && grid[r][c] && grid[r][c] !== '#') word += grid[r][c] || '_';
  }
  return word;
};

export const getLayoutStats = (layoutGrid) => {
  if (!layoutGrid || layoutGrid.length === 0) {
    return { slots: 0, blackCells: 0, acrossSlots: 0, downSlots: 0 };
  }

  const normalized = layoutGrid.map(row => Array.isArray(row) ? row : row.split(''));
  const slots = findSlots(normalized);
  const lengthCounts = slots.reduce((acc, s) => {
    acc[s.length] = (acc[s.length] || 0) + 1;
    return acc;
  }, {});
  const blackCells = normalized.reduce((sum, row) => sum + row.filter(cell => cell === '#').length, 0);
  const acrossSlots = slots.filter(slot => slot.direction === 'across').length;
  const downSlots = slots.filter(slot => slot.direction === 'down').length;

  return { slots: slots.length, blackCells, acrossSlots, downSlots, lengthCounts };
};

// ---- free-form grids (Create) ------------------------------------------------------
// Create used to take its black squares from a fixed entry in `layouts`; the author could
// only type letters. Now the blocks live in the grid itself, so the layout is derived
// from it and every structural edit (a block, a resize, a template) re-derives the slots.

/** '#'/'.' layout rows for a letter grid. Any non-'#' square is white. */
export const layoutOfGrid = (grid) => (grid || []).map(
  (row) => row.map((c) => (c === '#' ? '#' : '.')).join(''),
);

/** Slots of a layout in clue-number order, each with its NYT-style number. */
export const numberLayout = (layout) => {
  if (!layout || !layout.length) return [];
  const slots = findSlots(layout);
  const sorted = [...slots].sort((a, b) => (a.row !== b.row ? a.row - b.row : a.col - b.col));
  const numberMap = new Map();
  let next = 1;
  return sorted.map((s) => {
    const key = `${s.row},${s.col}`;
    if (!numberMap.has(key)) numberMap.set(key, next++);
    return { number: numberMap.get(key), direction: s.direction, row: s.row, col: s.col, length: s.length };
  });
};

/**
 * Clue lists for a layout, carrying over every clue whose slot survived unchanged
 * (same direction, start and length). A slot that grew or shrank is a different answer,
 * so its clue is dropped rather than left describing a word that is no longer there.
 * Returns `prev` itself when nothing structural changed, so a caller can bail out of a
 * state update without re-rendering.
 */
export const cluesForLayout = (layout, grid, prev = null) => {
  const numbered = numberLayout(layout);
  const id = (c, dir) => `${dir}-${c.row}-${c.col}-${c.length}`;
  const old = new Map();
  for (const dir of ['across', 'down']) {
    for (const c of prev?.[dir] || []) old.set(id(c, dir), c);
  }
  const out = { across: [], down: [] };
  let same = !!prev
    && numbered.filter((n) => n.direction === 'across').length === (prev.across || []).length
    && numbered.filter((n) => n.direction === 'down').length === (prev.down || []).length;
  for (const n of numbered) {
    const was = old.get(id(n, n.direction));
    if (!was || was.number !== n.number) same = false;
    out[n.direction].push({
      ...n,
      word: was?.word || (grid ? getWordFromGrid(grid, n.row, n.col, n.length, n.direction) : ''),
      clue: was?.clue || '',
    });
  }
  return same ? prev : out;
};

/** 180-degree partner of a square — the symmetry American grids use. */
export const mirrorOf = (r, c, rows, cols) => [rows - 1 - r, cols - 1 - c];

/**
 * What is wrong with a hand-drawn grid, split by whether the solver can live with it.
 *
 * errors   — the fill cannot succeed: 2-letter entries (the corpus has none), entries over
 *            15 letters, and white squares that belong to no entry at all (they would stay
 *            empty forever and the puzzle could never be played).
 * warnings — legal but unusual: unchecked squares (in only one entry) and white areas cut
 *            off from the rest of the grid.
 * Each issue lists the "r,c" keys involved so the editor can mark them.
 */
export const analyzeGrid = (layout, maxLen = 15) => {
  const empty = { errors: [], warnings: [], words: 0, blocks: 0, symmetric: true, badCells: new Set() };
  if (!layout || !layout.length || !layout[0].length) return empty;
  const rows = layout.length;
  const cols = layout[0].length;
  const slots = findSlots(layout);
  const cover = new Map();
  const cellsOf = (s) => Array.from({ length: s.length }, (_, i) => (
    s.direction === 'across' ? `${s.row},${s.col + i}` : `${s.row + i},${s.col}`));
  for (const s of slots) for (const k of cellsOf(s)) cover.set(k, (cover.get(k) || 0) + 1);

  const short = slots.filter((s) => s.length < 3);
  const long = slots.filter((s) => s.length > maxLen);
  const orphan = [];
  const unchecked = [];
  let blocks = 0;
  let symmetric = true;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const isBlock = layout[r][c] === '#';
      if (isBlock) blocks++;
      const [mr, mc] = mirrorOf(r, c, rows, cols);
      if (isBlock !== (layout[mr][mc] === '#')) symmetric = false;
      if (isBlock) continue;
      const n = cover.get(`${r},${c}`) || 0;
      if (n === 0) orphan.push(`${r},${c}`);
      else if (n === 1) unchecked.push(`${r},${c}`);
    }
  }

  // Flood the white squares; every flood after the first is an island.
  let islands = 0;
  const seen = new Set();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (layout[r][c] === '#' || seen.has(`${r},${c}`)) continue;
      islands++;
      const stack = [[r, c]];
      seen.add(`${r},${c}`);
      while (stack.length) {
        const [y, x] = stack.pop();
        for (const [dy, dx] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const ny = y + dy;
          const nx = x + dx;
          const k = `${ny},${nx}`;
          if (ny < 0 || nx < 0 || ny >= rows || nx >= cols || layout[ny][nx] === '#' || seen.has(k)) continue;
          seen.add(k);
          stack.push([ny, nx]);
        }
      }
    }
  }

  const errors = [];
  const warnings = [];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  if (short.length) {
    errors.push({ code: 'SHORT', text: `${plural(short.length, 'entry is', 'entries are')} only 2 letters — the word list has no 2-letter answers. Add or remove a block beside ${short.length === 1 ? 'it' : 'them'}.`, cells: short.flatMap(cellsOf) });
  }
  if (long.length) {
    errors.push({ code: 'LONG', text: `${plural(long.length, 'entry is', 'entries are')} longer than ${maxLen} letters — break ${long.length === 1 ? 'it' : 'them'} up with a block.`, cells: long.flatMap(cellsOf) });
  }
  if (orphan.length) {
    errors.push({ code: 'ORPHAN', text: `${plural(orphan.length, 'white square belongs', 'white squares belong')} to no entry — make ${orphan.length === 1 ? 'it' : 'them'} black or open up a neighbour.`, cells: orphan });
  }
  if (unchecked.length) {
    warnings.push({ code: 'UNCHECKED', text: `${plural(unchecked.length, 'square is', 'squares are')} unchecked (part of only one entry).`, cells: unchecked });
  }
  if (islands > 1) {
    warnings.push({ code: 'ISLANDS', text: `The white squares form ${islands} separate areas.`, cells: [] });
  }
  const badCells = new Set(errors.flatMap((e) => e.cells));
  return { errors, warnings, words: slots.length, blocks, symmetric, badCells };
};
