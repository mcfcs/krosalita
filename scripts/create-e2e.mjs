// End-to-end check of the Create workspace: the author's own letters, the two fill
// buttons, the generation cooldown, and the promise that Generate no longer eats Create.
//
// Everything here is driven with REAL mouse and key events over CDP rather than synthetic
// .click()/dispatchEvent, because half of what is being tested is focus behaviour — a
// synthetic click does not move focus, so it would hide exactly the class of bug this
// covers.
//
// Run:  npm run build && node scripts/create-e2e.mjs

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

/**
 * Kill the headless browser by its PROFILE, not by pid.
 *
 * `spawn(EDGE, ...)` returns the launcher process, which forks the real browser and exits
 * immediately — so by teardown time `edge.pid` no longer exists ("ERROR: The process
 * ... not found") and the ~14 processes it left behind are orphans in nobody's tree. A
 * `/T` tree-kill on that pid is therefore a no-op, which is how runs were stranding
 * hundreds of processes and locked profile directories. Each run gets a unique
 * --user-data-dir, so that is the reliable handle.
 */
function killEdgeByProfile(dir) {
  if (!dir) return;
  const tag = dir.split(/[\/]/).pop();            // unique mkdtemp basename, no metachars
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
  console.log('starting preview server...');
  preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'],
    { cwd: ROOT, shell: true, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE)).ok) break; } catch { /* wait */ }
    await sleep(250);
  }

  profile = mkdtempSync(join(tmpdir(), 'krosalita-create-'));
  edge = spawn(EDGE, [
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1500,1100', BASE,
  ], { stdio: 'ignore' });

  const page = await connect(CDP_PORT);
  console.log('browser attached');

  // ---------- real input helpers ----------
  const realClick = async (x, y, button = 'left') => {
    const clickCount = 1;
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount, buttons: button === 'right' ? 2 : 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount, buttons: 0 });
    await sleep(90);
  };
  const key = async (k) => {
    const isChar = k.length === 1;
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: k, code: isChar ? `Key${k.toUpperCase()}` : k,
      windowsVirtualKeyCode: isChar ? k.toUpperCase().charCodeAt(0) : { Backspace: 8, ArrowRight: 39, ArrowDown: 40 }[k],
      text: isChar ? k : undefined,
    });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k });
    await sleep(60);
  };
  // The app root carries `overflow-x-hidden`, and per spec a non-visible overflow on one
  // axis computes the other to `auto` — so the root div is the scroll container and the
  // window itself does not scroll at all. Find the real scroller and move that.
  const SCROLLER = `(el) => {
    let n = el.parentElement;
    while (n && n !== document.body) {
      const st = getComputedStyle(n);
      if (n.scrollHeight > n.clientHeight + 4 && /auto|scroll|hidden/.test(st.overflowY + st.overflowX)) return n;
      n = n.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }`;
  /** Centre of the nth non-block square of the Create grid, in viewport coordinates. */
  const cellPoint = (n) => page.evaluate(`(() => {
    const cells = [...document.querySelectorAll('.xw-cell')]
      .filter(d => !d.className.includes('xw-cell--block'));
    const el = cells[${n}];
    if (!el) return null;
    const sc = (${SCROLLER})(el);
    const pre = el.getBoundingClientRect();
    const sr = sc === (document.scrollingElement || document.documentElement)
      ? { top: 0, height: innerHeight } : sc.getBoundingClientRect();
    sc.scrollTo({ top: sc.scrollTop + (pre.top - sr.top - sr.height / 2), behavior: 'instant' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  // A real mouse click takes viewport coordinates, so anything below the fold has to be
  // scrolled to first — otherwise the click lands on whatever happens to be at that point.
  // scrollIntoView alone is not enough here: it scrolls the nearest scrollable ancestor,
  // which for the Create grid is not the window, so scroll the window explicitly and then
  // re-measure in a second round trip.
  const scrollTo = (label) => page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => (x.textContent || '').trim().toLowerCase().startsWith(${JSON.stringify(String(label).toLowerCase())}) && !x.disabled);
    if (!b) return false;
    const sc = (${SCROLLER})(b);
    const r = b.getBoundingClientRect();
    const sr = sc === (document.scrollingElement || document.documentElement)
      ? { top: 0, height: innerHeight } : sc.getBoundingClientRect();
    // index.css sets html { scroll-behavior: smooth }, so a scrollTop assignment animates
    // and a measurement taken straight afterwards catches it mid-flight.
    sc.scrollTo({ top: sc.scrollTop + (r.top - sr.top - sr.height / 2), behavior: 'instant' });
    return true;
  })()`);
  const measure = (label) => page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => (x.textContent || '').trim().toLowerCase().startsWith(${JSON.stringify(String(label).toLowerCase())}) && !x.disabled);
    if (!b) return null;
    const r = b.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight) return null;
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  })()`);
  /** Re-measures every time: any scroll since the last call invalidates the coordinates. */
  const clickCell = async (n) => {
    const pt = await cellPoint(n);
    if (!pt) return false;
    await sleep(250);                       // let the instant scroll settle before clicking
    const fresh = await cellPoint(n);
    await realClick(fresh.x, fresh.y);
    return true;
  };

  const clickByLabel = async (label) => {
    if (!(await scrollTo(label))) return false;
    await sleep(400);
    const pt = await measure(label);
    if (!pt) return false;
    await realClick(pt.x, pt.y);
    return true;
  };
  const gridState = () => page.evaluate(`(() => {
    const cells = [...document.querySelectorAll('.xw-cell')];
    return {
      letters: cells.map(d => (d.querySelector('.xw-letter')?.textContent || '')).join(''),
      pinned: cells.filter(d => d.className.includes('xw-cell--pinned')).length,
      pinnedLetters: cells.filter(d => d.className.includes('xw-cell--pinned'))
        .map(d => d.querySelector('.xw-letter')?.textContent || '').join(''),
    };
  })()`);
  const buttonText = (label) => page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => (x.textContent || '').trim().toLowerCase().startsWith(${JSON.stringify(String(label).toLowerCase())}));
    return b ? { text: (b.textContent||'').trim(), disabled: !!b.disabled } : null;
  })()`);

  // ---------- wait for the corpus, then open Create ----------
  for (let i = 0; i < 120; i++) {
    const ready = await page.evaluate(`(() => [...document.querySelectorAll('button')].some(
      x => (x.textContent||'').trim().toLowerCase() === 'generate' && !x.disabled && x.classList.contains('btn')))()`);
    if (ready) break;
    await sleep(500);
  }
  const createTab = await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^create$/i.test((x.textContent||'').trim()));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
  })()`);
  if (createTab) { await realClick(createTab.x, createTab.y); ok('opened the Create tab'); }
  else bad('opened the Create tab', 'no Create tab button');
  await sleep(700);

  // ---------- type a word; it must pin ----------
  if (!(await clickCell(0))) throw new Error('no Create grid rendered');
  const TYPED = 'ZEBRA';
  for (const ch of TYPED) await key(ch.toLowerCase());
  let st = await gridState();
  // The cursor stops at a block, so a short slot legitimately holds fewer letters than were
  // typed. What matters is that every square that DID take a letter is pinned.
  let MINE = st.pinnedLetters;
  if (MINE.length >= 3 && st.pinned === MINE.length) ok(`typing pinned my ${st.pinned} squares ("${MINE}")`);
  else bad('typing pins my squares', `pinned ${st.pinned} = "${st.pinnedLetters}"`);

  // ---------- 2A regression: typing must still work after clicking a button ----------
  await clickByLabel('clear grid');
  await sleep(300);
  await clickCell(0);
  for (const ch of TYPED) await key(ch.toLowerCase());
  st = await gridState();
  MINE = st.pinnedLetters;
  if (MINE.length >= 3) ok(`typing still works after clicking a toolbar button — 2A ("${MINE}")`);
  else {
    bad('typing still works after clicking a toolbar button (2A)', `got "${st.pinnedLetters}"`);
    throw new Error('no baseline to test against — the later checks would pass vacuously');
  }

  // ---------- Fill Remaining keeps every letter ----------
  await sleep(2100); // clear the cooldown
  if (await clickByLabel('fill remaining')) {
    for (let i = 0; i < 60; i++) { if ((await gridState()).letters.replace(/\s/g, '').length > MINE.length + 10) break; await sleep(400); }
    await sleep(600);
    st = await gridState();
    if (st.pinnedLetters === MINE) ok('Fill Remaining kept my letters');
    else bad('Fill Remaining kept my letters', `pinned now "${st.pinnedLetters}"`);
    if (st.letters.replace(/\s/g, '').length > MINE.length) ok(`Fill Remaining filled the rest (${st.letters.replace(/\s/g, '').length} letters)`);
    else bad('Fill Remaining filled the rest', `only ${st.letters.length}`);
  } else bad('Fill Remaining kept my letters', 'no Fill Remaining button');

  // ---------- the cooldown ----------
  const during = await buttonText('wait');
  if (during && during.disabled) ok(`generation is on cooldown right after a fill ("${during.text}")`);
  else bad('generation is on cooldown right after a fill', JSON.stringify(during));
  await sleep(2200);
  const after = await buttonText('fill remaining');
  if (after && !after.disabled) ok('the cooldown releases after ~2s');
  else bad('the cooldown releases after ~2s', JSON.stringify(after));

  // ---------- Regenerate keeps mine and changes the rest ----------
  const beforeRegen = await gridState();
  if (await clickByLabel('regenerate')) {
    for (let i = 0; i < 80; i++) {
      const s2 = await gridState();
      if (s2.letters !== beforeRegen.letters && s2.letters.replace(/\s/g, '').length > MINE.length) break;
      await sleep(400);
    }
    await sleep(700);
    st = await gridState();
    if (st.pinnedLetters === MINE) ok('Regenerate kept my pinned letters');
    else bad('Regenerate kept my pinned letters', `pinned now "${st.pinnedLetters}"`);
    if (st.letters !== beforeRegen.letters) ok('Regenerate actually changed the rest of the grid');
    else bad('Regenerate actually changed the rest of the grid', 'the grid is byte-identical');
  } else bad('Regenerate kept my pinned letters', 'no Regenerate button');

  // ---------- a second regenerate must differ again ----------
  await sleep(2200);
  const beforeSecond = (await gridState()).letters;
  if (await clickByLabel('regenerate')) {
    for (let i = 0; i < 80; i++) { if ((await gridState()).letters !== beforeSecond) break; await sleep(400); }
    await sleep(700);
    st = await gridState();
    if (st.letters !== beforeSecond) ok('a second Regenerate gives a different grid again');
    else bad('a second Regenerate gives a different grid again', 'identical to the previous fill');
    if (st.pinnedLetters === MINE) ok('my letters survived two regenerates');
    else bad('my letters survived two regenerates', `pinned now "${st.pinnedLetters}"`);
  }

  // ---------- right-click unpins one square ----------
  const pinnedPt = await page.evaluate(`(() => {
    const el = [...document.querySelectorAll('.xw-cell')].find(d => d.className.includes('xw-cell--pinned'));
    return el ? true : null;
  })()`);
  if (pinnedPt) {
    const beforePins = (await gridState()).pinned;
    // Headless Chromium does not turn a dispatched right-button press into a contextmenu
    // event; that mapping belongs to the browser. Fire the event our handler listens for.
    await page.evaluate(`(() => {
      const el = [...document.querySelectorAll('.xw-cell')].find(d => d.className.includes('xw-cell--pinned'));
      el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(250);
    const afterPins = (await gridState()).pinned;
    if (afterPins === beforePins - 1) ok('right-click unpins a single square');
    else bad('right-click unpins a single square', `${beforePins} -> ${afterPins}`);
  } else bad('right-click unpins a single square', 'no pinned square found');

  // ---------- Unpin all ----------
  if (await clickByLabel('unpin all')) {
    await sleep(300);
    st = await gridState();
    if (st.pinned === 0) ok('Unpin all releases every square');
    else bad('Unpin all releases every square', `${st.pinned} still pinned`);
  } else {
    const probe = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /unpin/i.test(x.textContent || ''));
      if (!b) return { found: false, buttons: [...document.querySelectorAll('button')].map(x => (x.textContent||'').trim()).slice(-12) };
      const r = b.getBoundingClientRect();
      return { found: true, text: (b.textContent||'').trim(), disabled: b.disabled, rect: { t: Math.round(r.top), b: Math.round(r.bottom) }, vh: innerHeight };
    })()`);
    bad('Unpin all releases every square', `no clickable control — ${JSON.stringify(probe)}`);
  }

  // ---------- 3A: generating must NOT touch Create ----------
  await sleep(2200);
  await clickCell(0);
  for (const ch of 'QUARK') await key(ch.toLowerCase());
  const createBefore = (await gridState()).letters;
  const autoTab = await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^generate$/i.test((x.textContent||'').trim()) && !x.classList.contains('btn-accent'));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
  })()`);
  if (autoTab) {
    await realClick(autoTab.x, autoTab.y);
    await sleep(600);
    await clickByLabel('generate');
    await sleep(600);
    await clickByLabel('confirm');
    for (let i = 0; i < 80; i++) {
      const n = await page.evaluate(`document.querySelectorAll('.xw-letter').length`);
      if (n > 40) break;
      await sleep(400);
    }
    await sleep(800);
    if (createTab) await realClick(createTab.x, createTab.y);
    await sleep(700);
    const createAfter = (await gridState()).letters;
    if (createAfter === createBefore) ok('generating on the Generate tab left Create untouched (3A)');
    else bad('generating on the Generate tab left Create untouched (3A)', `"${createBefore.slice(0, 24)}" -> "${createAfter.slice(0, 24)}"`);
  } else bad('generating on the Generate tab left Create untouched (3A)', 'no Generate tab found');

  // ---------- 1A: a custom layout must survive a reload ----------
  // This used to white-screen the app: selectedLayoutIndex was persisted but `layouts` was
  // not, so after a reload the index pointed past the end of DEFAULT_LAYOUTS, and the
  // Required Words modal's stats prop — computed on every render, open or not — reached
  // findSlots([]) -> layout[0].length and threw. The second reload recovered, but only by
  // overwriting the saved session with the blank initial state, taking the in-progress
  // solve with it.
  // "New" lives inside the layout selector, which is collapsed by default — the button
  // showing the current layout's name opens it.
  await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => /15x15|5x5|layout/i.test((x.textContent||'').trim()) && x.classList.contains('btn'));
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(700);
  const openedEditor = await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^new$/i.test((x.textContent||'').trim()));
    if (!b) return false;
    b.click();
    return true;
  })()`);
  await sleep(700);
  if (openedEditor) {
    const named = await page.evaluate(`(() => {
      const i = document.querySelector('input[placeholder="My Custom Layout"]');
      if (!i) return false;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(i, 'E2E Custom');
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    const saved = named && await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /save layout/i.test((x.textContent||'').trim()) && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (saved) {
      await sleep(900);
      await page.send('Page.reload');
      // A reload re-parses the 552k-row CSV and re-decodes the packed corpus, so the grid
      // takes a few seconds to appear. Poll, or a slow machine reads as a white screen.
      let alive = null;
      for (let i = 0; i < 40; i++) {
        await sleep(500);
        alive = await page.evaluate(`(() => ({
          cells: document.querySelectorAll('.xw-cell').length,
          buttons: document.querySelectorAll('button').length,
          bodyLen: (document.body.innerText || '').length,
          layoutName: (document.body.innerText || '').includes('E2E Custom'),
          text: (document.body.innerText || '').slice(0, 700),
          tab: [...document.querySelectorAll('button')].filter(b => b.className.includes('tab-active')).map(b => b.textContent.trim()),
          session: (() => { try { const j = JSON.parse(localStorage.getItem('krosalita:session')); return { tab: j.activeTab, cur: j.currentLayoutIndex, sel: j.selectedLayoutIndex, nLayouts: (j.layouts||[]).length }; } catch (e) { return String(e); } })(),
        }))()`);
        if (alive.buttons > 5 && alive.bodyLen > 200) break;
      }
      // The crash rendered a completely blank document — no buttons, no text. Which tab it
      // restores to is not the point, so assert the app is alive, then go to Create and
      // confirm a grid actually builds against the restored custom layout.
      if (alive.buttons > 5 && alive.bodyLen > 200) {
        ok(`the app survives a reload after saving a custom layout — 1A (${alive.buttons} controls)`);
      } else {
        bad('the app survives a reload after saving a custom layout (1A)', `white screen: ${JSON.stringify(alive)}`);
      }
      const tabPt = await page.evaluate(`(() => {
        const b = [...document.querySelectorAll('button')].find(x => /^create$/i.test((x.textContent||'').trim()));
        if (!b) return null;
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
      })()`);
      if (tabPt) await realClick(tabPt.x, tabPt.y);
      let cellsAfter = 0;
      for (let i = 0; i < 30; i++) {
        await sleep(400);
        cellsAfter = await page.evaluate(`document.querySelectorAll('.xw-cell').length`);
        if (cellsAfter > 0) break;
      }
      if (cellsAfter > 0) ok(`Create builds a grid from the restored custom layout (${cellsAfter} cells)`);
      else bad('Create builds a grid from the restored custom layout', 'no cells rendered');
      if (alive.layoutName) ok('the custom layout itself survived the reload');
      else bad('the custom layout itself survived the reload', 'the saved layout name is gone');
    } else bad('the app survives a reload after saving a custom layout (1A)', 'could not save a layout');
  } else bad('the app survives a reload after saving a custom layout (1A)', 'no New layout button');

  // ---------- no page-level exceptions throughout ----------
  if (page.errors.length === 0) ok('no page-level JS errors captured');
  else bad('no page-level JS errors captured', page.errors.slice(0, 2).join(' | '));

  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    writeFileSync(join(ROOT, 'scripts', 'create-e2e.png'), Buffer.from(shot.result.data, 'base64'));
    console.log('  screenshot: scripts/create-e2e.png');
  }
  page.close();
} catch (err) {
  bad('harness', err.message);
}

const failed = results.filter((r) => !r.pass);
console.log(failed.length ? `\nFAILED — ${failed.length} of ${results.length}` : `\nPASSED — ${results.length} checks`);
cleanup();
process.exit(failed.length ? 1 : 0);
