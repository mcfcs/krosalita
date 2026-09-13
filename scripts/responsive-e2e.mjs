// Responsive checks that a desktop-sized window cannot catch.
//
// Two of these guard bugs that made the app unusable rather than ugly:
//   * an iPad in landscape is 1180px wide AND has no hardware keyboard, so hiding the
//     on-screen keyboard at the `lg` breakpoint left no way to type a letter at all;
//   * the keyboard is fixed to the bottom of the viewport and covered the lower third of
//     the grid — and a tap on a covered square hit the keyboard, so the selection never
//     moved and the grid looked dead.
//
// Run:  npm run build && node scripts/responsive-e2e.mjs

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const basePort = 5300 + Math.floor(Math.random() * 300);
const PREVIEW_PORT = basePort;
const CDP_PORT = basePort + 4000;
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
    const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
    return r.result?.result?.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');
  return { send, evaluate, errors, close: () => ws.close() };
}

let preview, edge, profile;

/** Tear down just the browser. cleanup() also kills the preview server, and calling that
 *  between viewports left every run after the first loading nothing at all. */
function closeBrowser() {
  try {
    if (edge?.pid) {
      try { spawnSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }); }
      catch { /* not windows */ }
    }
    edge?.kill();
  } catch { /* ignore */ }
  try { if (profile) rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
  edge = null; profile = null;
}

function cleanup() {
  try {
    if (edge?.pid) {
      try { spawnSync('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }); }
      catch { /* not windows */ }
    }
    edge?.kill();
  } catch { /* ignore */ }
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

const VIEWPORTS = [
  { name: 'phone 390x844', w: 390, h: 844, touch: true, dock: true },
  { name: 'phone 360x740', w: 360, h: 740, touch: true, dock: true },
  { name: 'iPad portrait 820x1180', w: 820, h: 1180, touch: true, dock: true },
  { name: 'iPad landscape 1180x820', w: 1180, h: 820, touch: true, dock: true },
  { name: 'desktop 1440x900', w: 1440, h: 900, touch: false, dock: false },
  { name: 'desktop 1920x1080', w: 1920, h: 1080, touch: false, dock: false },
];

try {
  console.log('starting preview server...');
  preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'],
    { cwd: ROOT, shell: true, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE)).ok) break; } catch { /* wait */ }
    await sleep(250);
  }

  const allErrors = [];
  let port = CDP_PORT;

  for (const v of VIEWPORTS) {
    // A BROWSER PER VIEWPORT, not one browser re-emulated. Touch emulation turned out to be
    // sticky in a way none of clearDeviceMetricsOverride, setTouchEmulationEnabled(false)
    // or setEmitTouchEventsForMouse(false) undoes: once a touch viewport had been set, every
    // later viewport kept matching `pointer: coarse`, so the desktop cases silently tested
    // a tablet. A fresh headless browser reports `pointer: fine`, which is what pinned it
    // down — so start a fresh one each time rather than trust a reset that does not work.
    profile = mkdtempSync(join(tmpdir(), 'krosalita-resp-'));
    port += 1;
    edge = spawn(EDGE, [
      `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
      '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      `--window-size=${v.w},${v.h}`, 'about:blank',
    ], { stdio: 'ignore' });
    const page = await connect(port);

    await page.send('Emulation.setDeviceMetricsOverride', {
      width: v.w, height: v.h, deviceScaleFactor: 2, mobile: v.touch,
    });
    if (v.touch) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    await page.send('Page.navigate', { url: BASE });
    await sleep(2500);
    for (let i = 0; i < 60; i++) {
      const ready = await page.evaluate(`[...document.querySelectorAll('button')].some(
        x => (x.textContent||'').trim().toLowerCase() === 'generate' && !x.disabled && x.classList.contains('btn'))`);
      if (ready) break;
      await sleep(500);
    }
    // Create is where the dock and the grid coexist on every form factor.
    await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(x => /^create$/i.test((x.textContent||'').trim()));
      if (b) b.click();
    })()`);
    await sleep(900);

    // ---- the dock must appear exactly where a hardware keyboard is absent ----
    const dock = await page.evaluate(`(() => {
      const d = document.querySelector('.solve-dock');
      if (!d) return { present: false };
      const cs = getComputedStyle(d);
      const r = d.getBoundingClientRect();
      return { present: true, display: cs.display, keys: d.querySelectorAll('button').length, top: Math.round(r.top) };
    })()`);
    const ptr = await page.evaluate(`JSON.stringify({
      coarse: matchMedia('(pointer: coarse)').matches,
      fine: matchMedia('(pointer: fine)').matches,
      none: matchMedia('(pointer: none)').matches,
    })`);
    const visible = dock.present && dock.display !== 'none';
    if (visible === v.dock) {
      ok(`${v.name}: on-screen keyboard ${v.dock ? 'shown' : 'hidden'} as it should be`);
    } else {
      bad(`${v.name}: on-screen keyboard ${v.dock ? 'shown' : 'hidden'} as it should be`, `${JSON.stringify(dock)} pointer=${ptr}`);
    }

    // ---- no horizontal overflow ----
    const overflow = await page.evaluate(`(() => {
      const wide = [...document.querySelectorAll('*')]
        .filter(e => e.getBoundingClientRect().width > innerWidth + 1)
        .map(e => (e.className && String(e.className).slice(0, 40)) || e.tagName);
      return { doc: document.documentElement.scrollWidth, vw: innerWidth, wide: wide.slice(0, 3) };
    })()`);
    if (overflow.doc <= overflow.vw + 1 && overflow.wide.length === 0) ok(`${v.name}: no horizontal overflow`);
    else bad(`${v.name}: no horizontal overflow`, JSON.stringify(overflow));

    // ---- a square the keyboard would cover must be scrolled clear when selected ----
    if (v.dock) {
      const covered = await page.evaluate(`(() => {
        const d = document.querySelector('.solve-dock');
        const floor = d && getComputedStyle(d).display !== 'none' ? d.getBoundingClientRect().top : innerHeight;
        const cells = [...document.querySelectorAll('.xw-cell')]
          .filter(c => !c.className.includes('xw-cell--block'));
        // the last square that currently sits under the dock
        const hit = [...cells].reverse().find(c => c.getBoundingClientRect().top > floor - 4);
        if (!hit) return null;
        hit.click();
        return true;
      })()`);
      if (covered) {
        await sleep(900); // the nudge scrolls smoothly
        const after = await page.evaluate(`(() => {
          const d = document.querySelector('.solve-dock');
          const floor = d && getComputedStyle(d).display !== 'none' ? d.getBoundingClientRect().top : innerHeight;
          const sel = document.querySelector('.xw-cell[data-sel="1"]');
          if (!sel) return { sel: false };
          const r = sel.getBoundingClientRect();
          return { sel: true, bottom: Math.round(r.bottom), floor: Math.round(floor), clear: r.bottom <= floor + 1 };
        })()`);
        if (after.sel && after.clear) ok(`${v.name}: a covered square is scrolled clear of the keyboard (${after.bottom} <= ${after.floor})`);
        else bad(`${v.name}: a covered square is scrolled clear of the keyboard`, JSON.stringify(after));
      } else {
        ok(`${v.name}: no square sits under the keyboard to begin with`);
      }
    }

    allErrors.push(...page.errors.map((e) => `${v.name}: ${e}`));
    page.close();
    closeBrowser();
  }

  if (allErrors.length === 0) ok('no page-level JS errors at any viewport');
  else bad('no page-level JS errors at any viewport', allErrors.slice(0, 2).join(' | '));
} catch (err) {
  bad('harness', err.message);
}

const failed = results.filter((r) => !r.pass);
console.log(failed.length ? `\nFAILED — ${failed.length} of ${results.length}` : `\nPASSED — ${results.length} checks`);
cleanup();
process.exit(failed.length ? 1 : 0);
