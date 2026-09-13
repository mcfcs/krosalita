// Does a rebus CROSS actually work?
//
// The case under test is the one a constructor actually hits: one square holds a
// multi-letter string that has to satisfy an ACROSS entry and a DOWN entry at the same
// time.
//
//   across 1A: L E B R O N [JAM] E S   -> LEBRONJAMES   (9 squares, 11 letters)
//   down   2D: [JAM] P A C K E D       -> JAMPACKED     ( 7 squares,  9 letters)
//
// The shared square is (row 0, col 6) and holds the literal string "JAM".
//
// Everything is driven over CDP with REAL key and mouse events against the production
// build (vite preview on dist/), and the puzzle arrives through the real import path
// (DOM.setFileInputFiles on the Play tab's "Import to Play" input -> importPuzzlePlay ->
// startPlayMode), so nothing here is stubbed.
//
// Run:  node scripts/rebus-e2e.mjs        (dist/ must already be built)

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const basePort = 4900 + Math.floor(Math.random() * 300);
const PREVIEW_PORT = basePort;
const CDP_PORT = basePort + 5000;
const BASE = `http://localhost:${PREVIEW_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const ok = (n) => { results.push({ n, pass: true }); console.log(`  PASS  ${n}`); };
const bad = (n, d) => { results.push({ n, pass: false, d }); console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); };

// ---------------------------------------------------------------- the puzzle
const ACROSS_CELLS = ['L', 'E', 'B', 'R', 'O', 'N', 'JAM', 'E', 'S'];
const DOWN_TAIL = ['P', 'A', 'C', 'K', 'E', 'D'];
const SHARED = { row: 0, col: 6, value: 'JAM' };

const answers = [
  ACROSS_CELLS.slice(),
  ...DOWN_TAIL.map((ch) => ['#', '#', '#', '#', '#', '#', ch, '#', '#']),
];
const layout = answers.map((row) => row.map((c) => (c === '#' ? '#' : '.')).join(''));

const puzzleJSON = {
  version: '1.0',
  layoutName: 'Rebus E2E 9x7',
  layout,
  grid: answers,
  clues: {
    across: [{
      number: 1, row: 0, col: 0, length: 9, word: 'LEBRONJAMES',
      clue: 'Akron-born NBA great, **The King** — *four-time* champion',
    }],
    down: [{
      number: 2, row: 0, col: 6, length: 7, word: 'JAMPACKED',
      clue: '_Crammed_ full, like a café at π o’clock 🎉',
    }],
  },
  exportedAt: new Date().toISOString(),
};

// ---------------------------------------------------------------- CDP driver
async function connect(port) {
  let info;
  for (let i = 0; i < 60; i++) {
    try {
      const tabs = await (await fetch(`http://localhost:${port}/json/list`)).json();
      info = tabs.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (info) break;
    } catch { /* not up yet */ }
    await sleep(250);
  }
  if (!info) throw new Error('no CDP page target');
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
    }
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  await send('DOM.enable');
  return { send, evaluate, errors, close: () => ws.close() };
}

let preview, edge, profile;

/**
 * Kill the headless browser by its PROFILE, not by pid.
 *
 * `spawn(EDGE, ...)` returns the launcher, which forks the real browser and exits at once,
 * so by teardown `edge.pid` is gone and a `/T` tree-kill on it is a no-op — that is how
 * runs strand ~14 processes each. The unique --user-data-dir basename is the reliable
 * handle.
 */
function killEdgeByProfile(dir) {
  if (!dir) return;
  const tag = dir.split(/[\\/]/).pop();            // mkdtemp basename, no shell metachars
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${tag}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: 'ignore' });
  } catch { /* not windows */ }
}

function cleanup() {
  try { killEdgeByProfile(profile); edge?.kill(); } catch { /* ignore */ }
  try {
    if (preview?.pid) {
      try { spawnSync('taskkill', ['/PID', String(preview.pid), '/T', '/F'], { stdio: 'ignore' }); }
      catch { /* not windows */ }
    }
    preview?.kill();
  } catch { /* ignore */ }
  try { if (profile) rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

try {
  const puzzlePath = join(tmpdir(), `krosalita-rebus-${Date.now()}.json`);
  writeFileSync(puzzlePath, JSON.stringify(puzzleJSON, null, 2), 'utf8');

  console.log('starting preview server...');
  preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'],
    { cwd: ROOT, shell: true, stdio: 'ignore' });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE)).ok) break; } catch { /* wait */ }
    await sleep(250);
  }

  profile = mkdtempSync(join(tmpdir(), 'krosalita-rebus-'));
  edge = spawn(EDGE, [
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1500,1200', BASE,
  ], { stdio: 'ignore' });

  const page = await connect(CDP_PORT);
  console.log('browser attached');

  // ---------------------------- real input helpers ----------------------------
  const realClick = async (x, y) => {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
    await sleep(90);
  };
  const VK = { Backspace: 8, Tab: 9, Enter: 13, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40 };
  const key = async (k) => {
    const isChar = k.length === 1;
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: k, code: isChar ? `Key${k.toUpperCase()}` : k,
      windowsVirtualKeyCode: isChar ? k.toUpperCase().charCodeAt(0) : VK[k],
      text: isChar ? k : undefined,
    });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k });
    await sleep(70);
  };
  const type = async (s) => { for (const ch of s) await key(ch.toLowerCase()); };

  // The app root carries overflow-x-hidden, so it — not the window — is the scroller.
  const SCROLLER = `(el) => {
    let n = el.parentElement;
    while (n && n !== document.body) {
      const st = getComputedStyle(n);
      if (n.scrollHeight > n.clientHeight + 4 && /auto|scroll|hidden/.test(st.overflowY + st.overflowX)) return n;
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }`;
  const CENTER = (sel) => `(() => {
    const el = ${sel};
    if (!el) return null;
    const sc = (${SCROLLER})(el);
    const pre = el.getBoundingClientRect();
    const sr = sc === (document.scrollingElement || document.documentElement)
      ? { top: 0, height: innerHeight } : sc.getBoundingClientRect();
    sc.scrollTo({ top: sc.scrollTop + (pre.top - sr.top - sr.height / 2), behavior: 'instant' });
    const r = el.getBoundingClientRect();
    if (r.width === 0) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`;

  const CELL = (r, c) => `(document.querySelectorAll('.xw-grid--play [role="row"]')[${r}]
    ?.querySelectorAll('.xw-cell')[${c}] || null)`;
  // Exact text, not startsWith: the layout-selector button shows the puzzle's layout NAME,
  // so a prefix match on "Rebus" happily found "Rebus E2E 9x7" and clicked the wrong control.
  const BTN = (label) => `([...document.querySelectorAll('button')]
    .find(x => (x.textContent || '').trim() === ${JSON.stringify(String(label))} && !x.disabled) || null)`;
  // Matched by literal label rather than a regex on purpose: `\s` is not a recognised
  // escape in either a JS string literal or a template literal, so it silently collapses
  // to a bare "s" on the way to the page and /^Rebus(s*·s*On)?$/ stops matching
  // "Rebus · On" — a passing-looking harness that never sees the ON state.
  const REBUS_LABELS = ['Rebus', 'Rebus · On'];
  const BTN_ANY = (labels) => `([...document.querySelectorAll('button')]
    .find(x => ${JSON.stringify(labels)}.includes((x.textContent || '').trim()) && !x.disabled) || null)`;
  const REBUS_BTN = BTN_ANY(REBUS_LABELS);

  /** Re-measures every time: any scroll since the last call invalidates the coordinates. */
  const clickAt = async (sel) => {
    const first = await page.evaluate(CENTER(sel));
    if (!first) return false;
    await sleep(220);                         // let the instant scroll settle
    const fresh = await page.evaluate(CENTER(sel));
    if (!fresh) return false;
    await realClick(fresh.x, fresh.y);
    return true;
  };
  const clickCell = (r, c) => clickAt(CELL(r, c));
  const clickLabel = (label) => clickAt(BTN(label));

  const grid = () => page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.xw-grid--play [role="row"]')];
    return rows.map(rw => [...rw.querySelectorAll('.xw-cell')].map(d => ({
      t: (d.querySelector('.xw-letter')?.textContent || ''),
      block: d.className.includes('xw-cell--block'),
      aria: d.getAttribute('aria-label') || '',
      rebusStyled: !!d.querySelector('.xw-letter.font-bold'),
      selected: d.getAttribute('aria-selected') === 'true',
    })));
  })()`);
  const cellOf = async (r, c) => (await grid())[r]?.[c];
  const isComplete = () => page.evaluate(`(() => {
    const t = document.body.innerText || '';
    return { toolbar: /\\bComplete\\b/.test(t), solved: /Solved!/.test(t) };
  })()`);
  const rebusOn = () => page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => ${JSON.stringify(REBUS_LABELS)}.includes((x.textContent || '').trim()));
    return b ? (b.textContent || '').trim() : null;
  })()`);
  const clickRebus = () => clickAt(REBUS_BTN);
  /** Select (r,c) without the click-again direction toggle firing by accident. */
  const selectCell = async (r, c) => {
    const g = await grid();
    if (g[r]?.[c]?.selected) return true;
    return clickCell(r, c);
  };
  /** True when the highlighted word runs DOWN through the shared square. */
  const activeIsDown = () => page.evaluate(`(() => {
    const rows = [...document.querySelectorAll('.xw-grid--play [role="row"]')];
    const below = rows[1]?.querySelectorAll('.xw-cell')[6];
    return !!(below && /bg-word/.test(below.className));
  })()`);
  const closeResult = async () => {
    await page.evaluate(`(() => { const b = document.querySelector('button[aria-label="Close"]'); if (b) b.click(); return !!b; })()`);
    await sleep(300);
  };

  const importPuzzle = async () => {
    const doc = await page.send('DOM.getDocument', { depth: 1 });
    const q = await page.send('DOM.querySelector', {
      nodeId: doc.result.root.nodeId,
      selector: 'input[type="file"][accept=".json"]',
    });
    if (!q.result?.nodeId) return false;
    await page.send('DOM.setFileInputFiles', { files: [puzzlePath], nodeId: q.result.nodeId });
    for (let i = 0; i < 40; i++) {
      await sleep(300);
      const g = await grid();
      if (g.length === 7 && g[0].length === 9) return true;
    }
    return false;
  };

  /**
   * Fill every square except the shared one, correctly. Rebus must be OFF.
   * Each letter re-selects its own square rather than trusting the smart cursor, so one
   * surprising auto-advance cannot silently scatter the board.
   */
  const fillEverythingElse = async () => {
    const plan = [];
    ACROSS_CELLS.forEach((ch, c) => { if (c !== SHARED.col) plan.push([0, c, ch]); });
    DOWN_TAIL.forEach((ch, i) => plan.push([i + 1, SHARED.col, ch]));
    for (const [r, c, ch] of plan) {
      await selectCell(r, c);
      await key(ch.toLowerCase());
    }
  };

  // ------------------------- wait for the app, open Play -------------------------
  let ready = false;
  for (let i = 0; i < 200; i++) {
    ready = await page.evaluate(`(() => [...document.querySelectorAll('button')].some(
      x => /^Play$/.test((x.textContent||'').trim())))()`);
    if (ready) break;
    await sleep(500);
  }
  if (!ready) throw new Error('app never rendered its tab bar');
  await clickAt(`([...document.querySelectorAll('button')].find(x => /^Play$/.test((x.textContent||'').trim())) || null)`);
  await sleep(800);

  if (await importPuzzle()) ok('imported the rebus puzzle through the real Import-to-Play path');
  else throw new Error('import never produced a 7x9 play grid');

  // The answers must have survived the JSON round trip as a 3-char cell.
  const answersOk = await page.evaluate(`(() => {
    try { const s = JSON.parse(localStorage.getItem('krosalita:session'));
      return s?.play?.playAnswers?.[0]?.[6] || null; } catch { return null; }
  })()`);
  if (answersOk === 'JAM') ok('the answer key holds the 3-character cell "JAM" at (0,6)');
  else bad('the answer key holds the 3-character cell "JAM" at (0,6)', `got ${JSON.stringify(answersOk)}`);

  const g0 = await grid();
  const nonBlock = g0.flat().filter((c) => !c.block).length;
  if (nonBlock === 15) ok(`the grid rendered 15 solvable squares (9 across + 6 down tail)`);
  else bad('the grid rendered 15 solvable squares', `got ${nonBlock}`);

  // =======================================================================
  // Phase 1 — typing JAM into the shared square in Rebus mode
  // =======================================================================
  await clickRebus();
  const rb = await rebusOn();
  if (rb && /On/.test(rb)) ok(`Rebus mode engaged ("${rb}")`);
  else bad('Rebus mode engaged', `button reads ${JSON.stringify(rb)}`);

  await selectCell(SHARED.row, SHARED.col);
  await type('JAM');
  let sq = await cellOf(SHARED.row, SHARED.col);
  if (sq?.t === 'JAM') ok('typing J-A-M in Rebus mode is accepted and the square displays "JAM"');
  else bad('typing J-A-M in Rebus mode is accepted', `square shows ${JSON.stringify(sq?.t)}`);
  if (sq?.rebusStyled) ok('the square renders with the shrunken multi-letter rebus style');
  else bad('the square renders with the shrunken multi-letter rebus style', 'no rebus text class');

  // Check must call the rebus square CORRECT, on its own, before anything else is filled.
  await clickLabel('Check Cell');
  await sleep(300);
  sq = await cellOf(SHARED.row, SHARED.col);
  if (/, correct/.test(sq?.aria || '')) ok('Check marks the "JAM" square correct (not wrong)');
  else bad('Check marks the "JAM" square correct', `aria-label: ${JSON.stringify(sq?.aria)}`);

  let comp = await isComplete();
  if (!comp.toolbar && !comp.solved) ok('one correct square alone does not report the puzzle complete');
  else bad('one correct square alone does not report the puzzle complete', JSON.stringify(comp));

  // =======================================================================
  // Phase 2 — a WRONG single letter in that square must be reported wrong
  // =======================================================================
  await selectCell(SHARED.row, SHARED.col);
  await key('Backspace'); await key('Backspace'); await key('Backspace');
  await type('X');
  sq = await cellOf(SHARED.row, SHARED.col);
  if (sq?.t === 'X') ok('the rebus square can be cleared back down and retyped');
  else bad('the rebus square can be cleared back down and retyped', `shows ${JSON.stringify(sq?.t)}`);
  await clickLabel('Check Cell');
  await sleep(300);
  sq = await cellOf(SHARED.row, SHARED.col);
  if (/, incorrect/.test(sq?.aria || '')) ok('a WRONG single letter ("X") in the shared square is reported wrong');
  else bad('a WRONG single letter ("X") in the shared square is reported wrong', `aria-label: ${JSON.stringify(sq?.aria)}`);

  // =======================================================================
  // Phase 3 — the failure direction: only "J" must NOT complete the puzzle
  // =======================================================================
  await selectCell(SHARED.row, SHARED.col);
  await key('Backspace');
  await type('J');
  sq = await cellOf(SHARED.row, SHARED.col);
  if (sq?.t === 'J') ok('the shared square now holds only "J"');
  else bad('the shared square now holds only "J"', `shows ${JSON.stringify(sq?.t)}`);

  await key('Enter');                          // leave Rebus mode
  const rbOff = await rebusOn();
  if (rbOff && !/On/.test(rbOff)) ok('Enter leaves Rebus mode');
  else bad('Enter leaves Rebus mode', `button reads ${JSON.stringify(rbOff)}`);

  await fillEverythingElse();
  let g = await grid();
  const filledElsewhere = g.flat().filter((c) => !c.block && c.t).length;
  if (filledElsewhere === 15) ok(`every one of the 15 squares is filled (shared square = "J")`);
  else bad('every one of the 15 squares is filled', `${filledElsewhere}/15 — ${JSON.stringify(g[0].map(c => c.t))}`);

  comp = await isComplete();
  if (!comp.toolbar && !comp.solved) ok('with only "J" in the shared square the puzzle is NOT reported complete');
  else bad('with only "J" in the shared square the puzzle is NOT reported complete', JSON.stringify(comp));

  await selectCell(SHARED.row, SHARED.col);
  await clickLabel('Check Cell');
  await sleep(300);
  sq = await cellOf(SHARED.row, SHARED.col);
  if (/, incorrect/.test(sq?.aria || '')) ok('Check reports the partial "J" as wrong');
  else bad('Check reports the partial "J" as wrong', `aria-label: ${JSON.stringify(sq?.aria)}`);

  // =======================================================================
  // Phase 4 — finish the rebus: the one square must satisfy BOTH entries
  // =======================================================================
  await selectCell(SHARED.row, SHARED.col);
  await clickRebus();
  await selectCell(SHARED.row, SHARED.col);
  await type('AM');
  await sleep(400);
  g = await grid();
  sq = g[SHARED.row][SHARED.col];
  if (sq?.t === 'JAM') ok('the shared square reads "JAM" again');
  else bad('the shared square reads "JAM" again', `shows ${JSON.stringify(sq?.t)}`);

  const acrossJoined = g[0].filter((c) => !c.block).map((c) => c.t).join('');
  const downJoined = g.map((row) => row[6]).filter((c) => !c.block).map((c) => c.t).join('');
  if (acrossJoined === 'LEBRONJAMES') ok(`the ACROSS entry re-joins to LEBRONJAMES (9 squares -> 11 letters)`);
  else bad('the ACROSS entry re-joins to LEBRONJAMES', `got "${acrossJoined}"`);
  if (downJoined === 'JAMPACKED') ok(`the DOWN entry re-joins to JAMPACKED (7 squares -> 9 letters)`);
  else bad('the DOWN entry re-joins to JAMPACKED', `got "${downJoined}"`);

  comp = await isComplete();
  if (comp.toolbar || comp.solved) ok(`completion actually fires with a 3-character cell (toolbar=${comp.toolbar}, result card=${comp.solved})`);
  else bad('completion actually fires with a 3-character cell', 'checkPlayComplete never reported the puzzle solved');

  g = await grid();
  sq = g[SHARED.row][SHARED.col];
  if (/, correct/.test(sq?.aria || '')) ok('on completion the shared rebus square is graded correct');
  else bad('on completion the shared rebus square is graded correct', `aria-label: ${JSON.stringify(sq?.aria)}`);

  // =======================================================================
  // Phase 5 — Reveal Cell / Reveal Word restore the whole "JAM"
  // =======================================================================
  await closeResult();
  if (await importPuzzle()) ok('re-imported a fresh copy for the reveal tests');
  else bad('re-imported a fresh copy for the reveal tests', 'import did not reset the board');
  await sleep(500);

  await selectCell(SHARED.row, SHARED.col);
  await clickLabel('Reveal Cell');
  await sleep(400);
  sq = await cellOf(SHARED.row, SHARED.col);
  if (sq?.t === 'JAM') ok('Reveal Cell restores the full "JAM", not a single letter');
  else bad('Reveal Cell restores the full "JAM"', `revealed ${JSON.stringify(sq?.t)}`);

  // Reveal Word on the DOWN entry: clicking an already-selected square flips the direction.
  for (let i = 0; i < 3 && !(await activeIsDown()); i++) await clickCell(SHARED.row, SHARED.col);
  if (await activeIsDown()) ok('the shared square flips the active entry to DOWN on a second click');
  else bad('the shared square flips the active entry to DOWN on a second click', 'still across');
  await clickLabel('Reveal Word');
  await sleep(400);
  g = await grid();
  const revealedDown = g.map((row) => row[6]).filter((c) => !c.block).map((c) => c.t).join('');
  if (revealedDown === 'JAMPACKED') ok('Reveal Word on the DOWN entry restores "JAM" + PACKED');
  else bad('Reveal Word on the DOWN entry restores the rebus', `got "${revealedDown}"`);

  for (let i = 0; i < 3 && (await activeIsDown()); i++) await clickCell(SHARED.row, SHARED.col);
  await clickLabel('Reveal Word');
  await sleep(400);
  g = await grid();
  const revealedAcross = g[0].filter((c) => !c.block).map((c) => c.t).join('');
  if (revealedAcross === 'LEBRONJAMES') ok('Reveal Word on the ACROSS entry restores the full rebus square too');
  else bad('Reveal Word on the ACROSS entry restores the full rebus square too', `got "${revealedAcross}"`);

  comp = await isComplete();
  if (comp.toolbar || comp.solved) ok('a fully revealed rebus board also reports complete');
  else bad('a fully revealed rebus board also reports complete', JSON.stringify(comp));

  // ---------------------------- no page-level errors ----------------------------
  if (page.errors.length === 0) ok('no page-level JS errors captured');
  else bad('no page-level JS errors captured', page.errors.slice(0, 3).join(' | '));

  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    writeFileSync(join(ROOT, 'scripts', 'rebus-e2e.png'), Buffer.from(shot.result.data, 'base64'));
    console.log('  screenshot: scripts/rebus-e2e.png');
  }
  page.close();
  try { rmSync(puzzlePath, { force: true }); } catch { /* ignore */ }
} catch (err) {
  bad('harness', err.message);
}

const failed = results.filter((r) => !r.pass);
console.log(failed.length ? `\nFAILED — ${failed.length} of ${results.length}` : `\nPASSED — ${results.length} checks`);
cleanup();
process.exit(failed.length ? 1 : 0);
