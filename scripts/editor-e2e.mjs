// End-to-end check of the free-form Create editor: a blank grid by default, black squares
// drawn by click / drag / '.', 180-degree symmetry, resizing, circles and coloured shades,
// the grid check that stops an unfillable fill, a real fill of a hand-drawn grid, the
// grid surviving a reload, the marks reaching Play, and the PDF export producing a PDF.
//
// Real mouse and key events over CDP throughout — the painting tools are pointer-driven,
// and a synthetic .click() would skip exactly the pointerdown/pointermove path under test.
//
// Run:  npm run build && node scripts/editor-e2e.mjs

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_LAYOUTS } from '../src/data/layouts.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const basePort = 5300 + Math.floor(Math.random() * 300);
const PREVIEW_PORT = basePort;
const CDP_PORT = basePort + 5000;
const BASE = `http://localhost:${PREVIEW_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const ok = (n) => { results.push({ n, pass: true }); console.log(`  PASS  ${n}`); };
const bad = (n, d) => { results.push({ n, pass: false, d }); console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); };
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));

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
  return { send, evaluate, errors, close: () => ws.close() };
}

let preview, edge, profile;

// Kill by PROFILE, not pid: Edge's launcher exits immediately and orphans the browser.
function killEdgeByProfile(dir) {
  if (!dir) return;
  const tag = dir.split(/[\\/]/).pop();
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
      try { spawnSync('taskkill', ['/PID', String(preview.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
    }
    preview?.kill();
  } catch { /* ignore */ }
  try { if (profile) rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

try {
  console.log('starting preview server...');
  preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'],
    { cwd: ROOT, shell: true, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE)).ok) break; } catch { /* wait */ }
    await sleep(250);
  }
  profile = mkdtempSync(join(tmpdir(), 'krosalita-editor-'));
  edge = spawn(EDGE, [
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1500,1100', BASE,
  ], { stdio: 'ignore' });
  const page = await connect(CDP_PORT);
  console.log('browser attached');

  // ---------- input helpers ----------
  const mouse = (type, x, y, buttons = 0) => page.send('Input.dispatchMouseEvent', {
    type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: 1,
  });
  const realClick = async (x, y) => {
    await mouse('mousePressed', x, y, 1);
    await mouse('mouseReleased', x, y, 0);
    await sleep(80);
  };
  const key = async (k) => {
    const isChar = k.length === 1;
    const vk = k === '.' ? 190 : isChar ? k.toUpperCase().charCodeAt(0) : { Backspace: 8, ArrowRight: 39, ArrowDown: 40 }[k];
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: k, code: k === '.' ? 'Period' : isChar ? `Key${k.toUpperCase()}` : k,
      windowsVirtualKeyCode: vk, text: isChar ? k : undefined,
    });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k });
    await sleep(60);
  };
  // The app root div is the scroll container (overflow-x hidden => overflow-y auto), so
  // scroll that, instantly, and re-measure afterwards.
  const SCROLLER = `(el) => {
    let n = el.parentElement;
    while (n && n !== document.body) {
      const st = getComputedStyle(n);
      if (n.scrollHeight > n.clientHeight + 4 && /auto|scroll|hidden/.test(st.overflowY + st.overflowX)) return n;
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }`;
  const pointOf = (selector, center = true) => page.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    if (${center}) {
      const sc = (${SCROLLER})(el);
      const pre = el.getBoundingClientRect();
      const sr = sc === (document.scrollingElement || document.documentElement) ? { top: 0, height: innerHeight } : sc.getBoundingClientRect();
      if (pre.top < sr.top + 40 || pre.bottom > sr.top + sr.height - 40) {
        sc.scrollTo({ top: sc.scrollTop + (pre.top - sr.top - sr.height / 2), behavior: 'instant' });
      }
    }
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  const clickSel = async (selector) => {
    if (!(await pointOf(selector))) return false;
    await sleep(120);
    const pt = await pointOf(selector, false);
    await realClick(pt.x, pt.y);
    return true;
  };
  const cellSel = (r, c) => `[data-testid="create-grid"] [data-rc="${r},${c}"]`;
  const clickCell = (r, c) => clickSel(cellSel(r, c));
  const clickButton = async (label) => {
    const found = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => (x.textContent || '').trim().toLowerCase().startsWith(${JSON.stringify(label.toLowerCase())}) && !x.disabled);
      if (!b) return false;
      b.setAttribute('data-e2e-target', '1');
      return true;
    })()`);
    if (!found) return false;
    const okc = await clickSel('[data-e2e-target="1"]');
    await page.evaluate(`document.querySelector('[data-e2e-target]')?.removeAttribute('data-e2e-target')`);
    return okc;
  };
  const grid = () => page.evaluate(`(() => {
    const g = document.querySelector('[data-testid="create-grid"]');
    if (!g) return null;
    return [...g.children].map(row => [...row.children].map(d => d.className.includes('xw-cell--block') ? '#' : (d.querySelector('.xw-letter')?.textContent || '')));
  })()`);
  const blocksOf = (g) => g.flatMap((row, r) => row.map((ch, c) => (ch === '#' ? `${r},${c}` : null))).filter(Boolean);
  const healthText = () => page.evaluate(`document.querySelector('[data-testid="grid-health"]')?.innerText || ''`);
  const setInput = (selector, value) => page.evaluate(`(() => {
    const i = document.querySelector(${JSON.stringify(selector)});
    if (!i) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(String(value))});
    i.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

  // ---------- wait for the corpus, open Create ----------
  for (let i = 0; i < 120; i++) {
    const ready = await page.evaluate(`[...document.querySelectorAll('button')].some(x => (x.textContent||'').trim().toLowerCase() === 'generate' && !x.disabled && x.classList.contains('btn'))`);
    if (ready) break;
    await sleep(500);
  }
  await page.evaluate(`[...document.querySelectorAll('button')].find(x => /^create$/i.test((x.textContent||'').trim()))?.click()`);
  await sleep(800);

  let g = await grid();
  check(g && g.length === 15 && g[0].length === 15 && blocksOf(g).length === 0,
    'Create opens on a blank 15x15 grid', g ? `${g.length}x${g[0]?.length}, ${blocksOf(g).length} blocks` : 'no grid');

  // ---------- Blocks tool: click, symmetry, drag ----------
  await clickSel('[data-tool="block"]');
  await clickCell(0, 0);
  g = await grid();
  check(g[0][0] === '#' && g[14][14] === '#' && blocksOf(g).length === 2,
    'a click in Blocks mode blacks the square and its 180° partner', blocksOf(g).join(' '));

  const a = await pointOf(cellSel(2, 5));
  await sleep(100);
  const p0 = await pointOf(cellSel(2, 5), false);
  const p2 = await pointOf(cellSel(4, 5), false);
  await mouse('mousePressed', p0.x, p0.y, 1);
  for (let i = 1; i <= 8; i++) await mouse('mouseMoved', p0.x, p0.y + ((p2.y - p0.y) * i) / 8, 1);
  await mouse('mouseReleased', p2.x, p2.y, 0);
  await sleep(150);
  g = await grid();
  const dragged = ['2,5', '3,5', '4,5', '12,9', '11,9', '10,9'].every((k) => { const [r, c] = k.split(',').map(Number); return g[r][c] === '#'; });
  check(a && dragged, 'a drag paints a run of blocks (and mirrors it)', blocksOf(g).join(' '));

  await clickCell(0, 0);
  g = await grid();
  check(g[0][0] !== '#' && g[14][14] !== '#', 'clicking a block again opens it and its partner');

  await page.evaluate(`(() => { const l = [...document.querySelectorAll('label')].find(x => /symmetric blocks/i.test(x.textContent)); l?.querySelector('input')?.click(); })()`);
  await sleep(100);
  await clickCell(1, 1);
  g = await grid();
  check(g[1][1] === '#' && g[13][13] !== '#', 'with symmetry off a block is placed alone');
  await clickCell(1, 1);
  await page.evaluate(`(() => { const l = [...document.querySelectorAll('label')].find(x => /symmetric blocks/i.test(x.textContent)); l?.querySelector('input')?.click(); })()`);

  // ---------- the grid check catches a 2-letter entry ----------
  await clickCell(0, 2);
  await sleep(150);
  let ht = await healthText();
  const badMarked = await page.evaluate(`!!document.querySelector('${cellSel(0, 0)}.xw-cell--bad')`);
  check(/only 2 letters/i.test(ht) && badMarked, 'a 2-letter entry is reported and its squares outlined', ht.slice(0, 160));
  await sleep(2100);
  await clickButton('fill remaining');
  await sleep(400);
  const body = await page.evaluate(`document.body.innerText`);
  check(/can't be filled yet/i.test(body), 'Fill Remaining refuses an unfillable grid and says why');
  await clickCell(0, 2);
  // (The drag above legitimately left 2-letter DOWN entries over column 5, so the message
  // itself stays; the squares this block made short must be released.)
  const stillBad = await page.evaluate(`!!document.querySelector('${cellSel(0, 0)}.xw-cell--bad')`);
  check(!stillBad, 'removing the block clears the outline on the squares it made short');

  // ---------- circles and coloured shades ----------
  await clickSel('[data-tool="shade"]');
  await clickSel('button[aria-label="Blue"]');
  await clickCell(6, 6);
  await clickSel('[data-tool="circle"]');
  await clickCell(6, 7);
  const marks = await page.evaluate(`(() => {
    const shade = document.querySelector('${cellSel(6, 6)} span.mix-blend-multiply');
    const ring = document.querySelector('${cellSel(6, 7)} .rounded-full');
    return { shade: shade ? getComputedStyle(shade).backgroundColor : null, ring: !!ring };
  })()`);
  check(marks.shade === 'rgb(188, 215, 247)', 'the Shade tool fills a square with the chosen colour', String(marks.shade));
  check(marks.ring, 'the Circles tool rings a square');

  // ---------- '.' toggles a block from the keyboard; a letter opens it ----------
  await clickSel('[data-tool="letter"]');
  await clickCell(7, 7);
  await key('.');
  g = await grid();
  check(g[7][7] === '#', "'.' turns the selected square black");
  await clickCell(7, 7);
  await key('q');
  g = await grid();
  check(g[7][7] === 'Q', 'typing a letter on a black square opens it');

  // ---------- resize keeps what fits ----------
  await setInput('input[aria-label="Rows"]', 13);
  await setInput('input[aria-label="Columns"]', 11);
  await sleep(100);
  await clickButton('resize');
  await sleep(300);
  g = await grid();
  const keptShade = await page.evaluate(`!!document.querySelector('${cellSel(6, 6)} span.mix-blend-multiply')`);
  check(g.length === 13 && g[0].length === 11 && g[7][7] === 'Q' && keptShade,
    'Resize to 13×11 keeps the letters and marks that still fit', `${g.length}x${g[0].length}`);

  // ---------- draw Classic 15x15 by hand and fill it ----------
  await setInput('input[aria-label="Rows"]', 15);
  await setInput('input[aria-label="Columns"]', 15);
  await sleep(100);
  await clickButton('new blank');
  await sleep(300);
  await clickButton('new grid');                       // the confirm: there are letters to lose
  await sleep(300);
  g = await grid();
  check(g.length === 15 && blocksOf(g).length === 0, 'New blank gives an empty 15×15 after confirming');

  const classic = DEFAULT_LAYOUTS.find((l) => l.name === 'Classic 15x15').grid;
  await clickSel('[data-tool="block"]');
  for (let r = 0; r < 15; r++) {
    for (let c = 0; c < 15; c++) {
      if (classic[r][c] !== '#') continue;
      if (r * 15 + c > (14 - r) * 15 + (14 - c)) continue;   // its mirror was already drawn
      await clickCell(r, c);
    }
  }
  g = await grid();
  const drawn = g.map((row) => row.map((ch) => (ch === '#' ? '#' : '.')).join(''));
  check(drawn.join('|') === classic.join('|'), 'Classic 15×15 can be drawn block by block with symmetry');
  ht = await healthText();
  check(/84 entries/.test(ht) && /symmetric/.test(ht) && !/not symmetric/.test(ht), 'the grid check counts 84 entries, symmetric', ht.split('\n')[0]);

  // shade one square so the colour has somewhere to travel
  await clickSel('[data-tool="shade"]');
  await clickSel('button[aria-label="Pink"]');
  await clickCell(1, 1);
  await clickSel('[data-tool="letter"]');

  await page.evaluate(`[...document.querySelectorAll('button')].find(x => (x.textContent||'').trim().toLowerCase() === 'easy')?.click()`);
  await sleep(2100);
  await clickButton('fill remaining');
  let filled = false;
  for (let i = 0; i < 80; i++) {
    await sleep(400);
    g = await grid();
    if (g.every((row) => row.every((ch) => ch))) { filled = true; break; }
  }
  check(filled, 'Fill Remaining fills a hand-drawn grid completely');
  // every entry read back off the grid is distinct and has a clue
  const clueState = await page.evaluate(`(() => ({
    missing: (document.body.innerText.match(/Click to add clue/g) || []).length,
    difficulty: !!document.querySelector('.eyebrow') && /Difficulty/.test(document.body.innerText),
  }))()`);
  const entries = [];
  for (let r = 0; r < 15; r++) {
    for (const run of g[r].join('').split('#')) if (run.length > 1) entries.push(run);
  }
  for (let c = 0; c < 15; c++) {
    for (const run of g.map((row) => row[c]).join('').split('#')) if (run.length > 1) entries.push(run);
  }
  check(entries.length === 84 && new Set(entries).size === 84, 'the fill has 84 distinct answers', `${entries.length} / ${new Set(entries).size}`);
  check(clueState.missing === 0, 'every filled entry got a clue', `${clueState.missing} missing`);
  check(clueState.difficulty, 'a difficulty label is shown for the filled grid');

  // ---------- the Create grid survives a reload ----------
  const before = JSON.stringify(g);
  await sleep(500);
  await page.send('Page.reload');
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const n = await page.evaluate(`document.querySelectorAll('button').length`);
    if (n > 5) break;
  }
  await page.evaluate(`[...document.querySelectorAll('button')].find(x => /^create$/i.test((x.textContent||'').trim()))?.click()`);
  await sleep(800);
  g = await grid();
  check(JSON.stringify(g) === before, 'the Create grid (letters and blocks) survives a reload');
  const pinkKept = await page.evaluate(`(() => { const s = document.querySelector('${cellSel(1, 1)} span.mix-blend-multiply'); return s ? getComputedStyle(s).backgroundColor : null; })()`);
  check(pinkKept === 'rgb(246, 198, 214)', 'shading survives a reload', String(pinkKept));

  // ---------- marks reach Play ----------
  await clickButton('play this puzzle');
  await sleep(900);
  const playShade = await page.evaluate(`(() => {
    const s = [...document.querySelectorAll('.xw-grid span.mix-blend-multiply')].map(x => getComputedStyle(x).backgroundColor);
    return s;
  })()`);
  check(playShade.includes('rgb(246, 198, 214)'), 'the coloured shade is shown in Play', JSON.stringify(playShade));

  // ---------- PDF export ----------
  await page.evaluate(`(() => {
    window.__blobs = [];
    const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => { window.__blobs.push({ type: b.type, size: b.size }); return orig(b); };
    HTMLAnchorElement.prototype.click = function () { window.__downloads = (window.__downloads || []).concat(this.download); };
  })()`);
  // The Play toolbar's PDF button; the immersive game view may be on, so fall back to it.
  let opened = await clickButton('pdf');
  if (!opened) {
    await page.evaluate(`document.querySelector('[aria-label="Exit full screen"], [aria-label="Close"]')?.click()`);
    opened = await clickButton('pdf');
  }
  await sleep(600);
  let previewSrc = null;
  for (let i = 0; i < 30; i++) {
    previewSrc = await page.evaluate(`document.querySelector('iframe[title="PDF preview"]')?.getAttribute('src') || null`);
    if (previewSrc) break;
    await sleep(300);
  }
  check(opened && previewSrc && previewSrc.startsWith('blob:'), 'the PDF dialog renders a live preview', String(previewSrc));
  await setInput('input[placeholder="Your name"]', 'E2E Constructor');
  await sleep(500);
  await clickButton('download pdf');
  let dl = null;
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    dl = await page.evaluate(`({ blobs: window.__blobs, downloads: window.__downloads || [] })`);
    if (dl.downloads.length) break;
  }
  const pdfBlob = dl.blobs.filter((b) => b.type === 'application/pdf').pop();
  check(dl.downloads.some((n) => /\.pdf$/.test(n)) && pdfBlob && pdfBlob.size > 5000,
    'Download PDF produces a real PDF file', JSON.stringify(dl));

  check(page.errors.length === 0, 'no page-level JS errors captured', page.errors.slice(0, 2).join(' | '));

  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    writeFileSync(join(tmpdir(), 'krosalita-editor-e2e.png'), Buffer.from(shot.result.data, 'base64'));
    console.log(`  screenshot: ${join(tmpdir(), 'krosalita-editor-e2e.png')}`);
  }
  page.close();
} catch (err) {
  bad('harness', err.stack || err.message);
}

const failed = results.filter((r) => !r.pass);
console.log(failed.length ? `\nFAILED — ${failed.length} of ${results.length}` : `\nPASSED — ${results.length} checks`);
cleanup();
process.exit(failed.length ? 1 : 0);
