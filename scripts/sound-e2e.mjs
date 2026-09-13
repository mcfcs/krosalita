// End-to-end check that the sound effects actually fire, and fire the RIGHT sound.
//
// Headless has no speakers, so this instruments the Web Audio API instead: every
// OscillatorNode and BiquadFilterNode the page creates is recorded with its frequency,
// and each effect in src/utils/sound.js has a distinct frequency signature. That makes
// "typing plays the typing sound" a real assertion rather than "something made a noise".
//
// The spy is installed with Page.addScriptToEvaluateOnNewDocument + a reload, so it is in
// place before the app's first keypress.
//
// Run:  npm run build && node scripts/sound-e2e.mjs

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const basePort = 4600 + Math.floor(Math.random() * 300);
const PREVIEW_PORT = basePort;
const CDP_PORT = basePort + 5000;
const BASE = `http://localhost:${PREVIEW_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const ok = (n) => { results.push({ n, pass: true }); console.log(`  PASS  ${n}`); };
const bad = (n, d) => { results.push({ n, pass: false, d }); console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); };

// ---- minimal CDP client (no deps) ----
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
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
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
  return { send, evaluate, close: () => ws.close() };
}

// Every voice's frequency signature, from src/utils/sound.js. `osc` entries are
// OscillatorNodes, `bq` the bandpass at the heart of a click.
const SIG = {
  type: { bq: [1500, 2000], osc: [170] },
  erase: { bq: [650, 800], osc: [] },
  move: { bq: [3000, 3000], osc: [] },
  block: { bq: [280, 280], osc: [] },
  wordDone: { osc: [660, 990] },
  correct: { osc: [880, 1320] },
  wrong: { osc: [150, 146] },
  reveal: { osc: [700, 520] },
  toggle: { osc: [880] },
  win: { osc: [523, 659, 784, 1047, 1568, 262] },
};
const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;

/** Which named effects are present in a batch of recorded audio nodes. */
function identify(events) {
  const osc = events.filter((e) => e.k === 'osc').map((e) => e.f);
  const bq = events.filter((e) => e.k === 'bq').map((e) => e.f);
  const found = new Set();
  for (const [name, sig] of Object.entries(SIG)) {
    if (sig.bq) {
      // A click's bandpass is randomised within a range; the low thump identifies typing.
      const hit = bq.some((f) => f >= sig.bq[0] - 3 && f <= sig.bq[1] + 3);
      const thumpOk = sig.osc.length === 0 || sig.osc.every((f) => osc.some((g) => near(g, f)));
      if (hit && thumpOk) found.add(name);
    } else if (sig.osc.every((f) => osc.some((g) => near(g, f)))) {
      found.add(name);
    }
  }
  // `type` and `erase`/`move` overlap only if a range coincides; they don't. But `wordDone`
  // (660/990) and `correct` (880/1320) share nothing, so no disambiguation is needed.
  return found;
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

  profile = mkdtempSync(join(tmpdir(), 'krosalita-sfx-'));
  edge = spawn(EDGE, [
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    // The context must be allowed to start without a gesture, and must make no actual
    // noise on the machine running the test.
    '--autoplay-policy=no-user-gesture-required', '--mute-audio',
    '--window-size=1400,1000', BASE,
  ], { stdio: 'ignore' });

  const page = await connect(CDP_PORT);
  console.log('browser attached');

  // Install the spy, then reload so it is present before any app code runs.
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__sfx = [];
      window.__master = null;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      const co = AC.prototype.createOscillator;
      AC.prototype.createOscillator = function () {
        const n = co.call(this);
        // The caller sets frequency/type synchronously right after construction, so read
        // it on the microtask queue rather than now.
        queueMicrotask(() => { try { window.__sfx.push({ k: 'osc', f: Math.round(n.frequency.value), t: n.type }); } catch (e) {} });
        return n;
      };
      const cb = AC.prototype.createBiquadFilter;
      AC.prototype.createBiquadFilter = function () {
        const n = cb.call(this);
        queueMicrotask(() => { try { window.__sfx.push({ k: 'bq', f: Math.round(n.frequency.value) }); } catch (e) {} });
        return n;
      };
      const cg = AC.prototype.createGain;
      AC.prototype.createGain = function () {
        const n = cg.call(this);
        if (!window.__master) window.__master = n;  // sound.js builds the master gain first
        return n;
      };
    })()`,
  });
  await page.send('Page.reload');
  await sleep(1500);

  const drain = async () => {
    const evs = await page.evaluate('(() => { const e = window.__sfx || []; window.__sfx = []; return e; })()');
    return evs || [];
  };
  const heard = async () => [...identify(await drain())];

  // The app's keydown handler sits on a tabIndex=0 wrapper div, and a synthetic .click()
  // does not move focus the way a real mousedown does, so without this the key events land
  // on <body> and never reach React.
  //
  // This also papers over a real bug, so don't read it as a pure harness quirk: isFormElement
  // (App.jsx:1195) counts 'button' as a form element and both keydown handlers bail on it, so
  // after a REAL click on any button — a clue in the clue list, Check, Reveal, Pause — typing
  // and the arrow keys stop working until you click a grid square again.
  const focusApp = () => page.evaluate(`(() => {
    const w = document.querySelector('div[tabindex="0"]');
    if (w) { w.focus(); return document.activeElement === w; }
    return false;
  })()`);

  // A real key event, so the app's own keydown handler runs rather than a synthetic click.
  const key = async (k) => {
    await focusApp();
    const isChar = k.length === 1;
    await page.send('Input.dispatchKeyEvent', {
      type: 'keyDown', key: k, code: isChar ? `Key${k.toUpperCase()}` : k,
      windowsVirtualKeyCode: isChar ? k.toUpperCase().charCodeAt(0) : { Backspace: 8, ArrowRight: 39, ArrowDown: 40 }[k],
      text: isChar ? k : undefined,
    });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k });
    await sleep(70);
  };
  const clickText = async (re, exact = false) => page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => {
      const t = (x.textContent || '').trim();
      return ${exact ? `t.toLowerCase() === ${JSON.stringify(String(re).toLowerCase())}` : `/${re}/i.test(t)`} && !x.disabled;
    });
    if (!b) return false;
    b.click();
    return true;
  })()`);

  // ---- build a puzzle and enter Play ----
  for (let i = 0; i < 120; i++) {
    const c = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => (x.textContent || '').trim().toLowerCase() === 'generate'
               && !x.disabled && x.classList.contains('btn'));
      if (!b) return false; b.click(); return true;
    })()`);
    if (c) break;
    await sleep(500);
  }
  await sleep(600);
  await clickText('^confirm$');
  for (let i = 0; i < 120; i++) {
    const n = await page.evaluate(`document.querySelectorAll('button').length && [...document.querySelectorAll('div,td,span')].filter(e => e.children.length === 0 && /^[A-Z]$/.test((e.textContent||'').trim())).length`);
    if (n > 40) break;
    await sleep(500);
  }
  if (await clickText('Play This Puzzle')) ok('entered Play mode');
  else bad('entered Play mode', 'no "Play This Puzzle" button');
  await sleep(800);

  // ---- sound is OFF by default: nothing may be produced ----
  await drain();
  await page.evaluate(`(() => { const c = [...document.querySelectorAll('div')].find(d => d.className && String(d.className).includes('xw') ); return true; })()`);
  await key('a'); await key('b');
  const silent = await drain();
  if (silent.length === 0) ok('sound off by default — no audio nodes created');
  else bad('sound off by default', `${silent.length} audio node(s) created while off`);

  // ---- turn it on ----
  const toggled = await clickText('Sound');
  await sleep(150);
  const onSounds = await heard();
  if (toggled && onSounds.includes('toggle')) ok('Sound toggle plays its confirmation');
  else bad('Sound toggle plays its confirmation', toggled ? `heard [${onSounds}]` : 'no Sound button');

  // ---- select a square, then type ----
  await page.evaluate(`(() => {
    const cells = [...document.querySelectorAll('div')].filter(d => d.className && String(d.className).includes('xw-cell'));
    const c = cells.find(d => !String(d.className).includes('block') && !String(d.className).includes('#'));
    if (c) c.click();
    return !!c;
  })()`);
  await sleep(120);
  const moveHeard = await heard();
  if (moveHeard.includes('move')) ok('clicking a square plays the navigation tick');
  else bad('clicking a square plays the navigation tick', `heard [${moveHeard}]`);

  await drain();
  await key('q');
  const typed = await heard();
  if (typed.includes('type')) ok('typing a letter plays the typing click');
  else bad('typing a letter plays the typing click', `heard [${typed}]`);

  await drain();
  await key('Backspace');
  const erased = await heard();
  if (erased.includes('erase') && !erased.includes('type')) ok('backspace plays the erase click, not the typing one');
  else bad('backspace plays the erase click, not the typing one', `heard [${erased}]`);

  await drain();
  await key('ArrowDown');
  const moved = await heard();
  if (moved.includes('move')) ok('arrow keys play the navigation tick');
  else bad('arrow keys play the navigation tick', `heard [${moved}]`);

  // ---- fill a whole entry: the last letter must chime ----
  await drain();
  let chimed = false;
  for (let i = 0; i < 14 && !chimed; i++) {
    await key('z');
    if ((await heard()).includes('wordDone')) chimed = true;
  }
  if (chimed) ok('completing an entry plays the word-complete chime');
  else bad('completing an entry plays the word-complete chime', 'no 660/990 chime in 14 keypresses');

  // ---- Check on a Z-filled word must sound wrong ----
  // The smart cursor has moved on by now, so select a square that actually holds a Z —
  // otherwise Check runs over a blank entry, which correctly makes no sound at all.
  const onZ = await page.evaluate(`(() => {
    const cells = [...document.querySelectorAll('div')].filter(d =>
      d.className && String(d.className).includes('xw-cell') && (d.textContent || '').trim().endsWith('Z'));
    if (!cells.length) return false;
    cells[0].click();
    return true;
  })()`);
  await sleep(150);
  await drain();
  if (onZ && await clickText('Check Word')) {
    await sleep(200);
    const checked = await heard();
    if (checked.includes('wrong')) ok('Check on a wrong entry plays the wrong sound');
    else bad('Check on a wrong entry plays the wrong sound', `heard [${checked}]`);
  } else bad('Check on a wrong entry plays the wrong sound', onZ ? 'no "Check Word" button' : 'no Z-filled square to select');

  // ---- Reveal, then Check the same word: must sound correct ----
  await drain();
  if (await clickText('Reveal Word')) {
    await sleep(250);
    const rev = await heard();
    if (rev.includes('reveal')) ok('Reveal Word plays the reveal sound');
    else bad('Reveal Word plays the reveal sound', `heard [${rev}]`);

    await drain();
    await clickText('Check Word');
    await sleep(200);
    const checked2 = await heard();
    if (checked2.includes('correct') && !checked2.includes('wrong')) ok('Check on a revealed (correct) entry plays the correct sound');
    else bad('Check on a revealed (correct) entry plays the correct sound', `heard [${checked2}]`);
  } else bad('Reveal Word plays the reveal sound', 'no "Reveal Word" button');

  // ---- Check over an entry with nothing typed in it must stay silent ----
  const onBlank = await page.evaluate(`(() => {
    const cells = [...document.querySelectorAll('div')].filter(d =>
      d.className && String(d.className).includes('xw-cell')
      && !String(d.className).includes('block')
      && !/[A-Z]/.test((d.textContent || '').trim()));
    if (!cells.length) return false;
    cells[0].click();
    return true;
  })()`);
  await sleep(150);
  await drain();
  if (onBlank && await clickText('Check Word')) {
    await sleep(200);
    const blankCheck = await drain();
    if (blankCheck.length === 0) ok('Check over an unanswered entry stays silent');
    else bad('Check over an unanswered entry stays silent', `heard [${[...identify(blankCheck)]}]`);
  } else bad('Check over an unanswered entry stays silent', 'no blank square to select');

  // ---- volume slider drives the master gain and persists ----
  const vol = await page.evaluate(`(() => {
    const r = document.querySelector('input[type=range][aria-label="Sound effect volume"]');
    if (!r) return null;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(r, '0.25');
    r.dispatchEvent(new Event('input', { bubbles: true }));
    r.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(300);
  const gain = await page.evaluate('window.__master ? window.__master.gain.value : null');
  const stored = await page.evaluate('localStorage.getItem("krosalita:soundVolume")');
  if (vol && gain !== null && gain < 0.4) ok(`volume slider drives the master gain (${Number(gain).toFixed(2)})`);
  else bad('volume slider drives the master gain', `slider ${vol}, gain ${gain}`);
  if (String(stored).replace(/"/g, '') === '0.25') ok('volume persists to localStorage');
  else bad('volume persists to localStorage', `stored ${stored}`);

  // ---- turning it back off must silence everything again ----
  await clickText('Sound');
  await sleep(150);
  await drain();
  await key('k'); await key('j'); await key('ArrowDown');
  const afterOff = await drain();
  if (afterOff.length === 0) ok('turning Sound off silences typing again');
  else bad('turning Sound off silences typing again', `${afterOff.length} node(s) still created`);

  // ---- the toggle must survive a reload ----
  await clickText('Sound');
  await sleep(150);
  await page.send('Page.reload');
  await sleep(2500);
  const persisted = await page.evaluate('localStorage.getItem("krosalita:soundOn")');
  if (String(persisted).replace(/"/g, '') === 'true') ok('the Sound setting persists across a reload');
  else bad('the Sound setting persists across a reload', `stored ${persisted}`);

  page.close();
} catch (err) {
  bad('harness', err.message);
}

const failed = results.filter((r) => !r.pass);
console.log(failed.length ? `\nFAILED — ${failed.length} of ${results.length}` : `\nPASSED — ${results.length} checks`);
cleanup();
process.exit(failed.length ? 1 : 0);
