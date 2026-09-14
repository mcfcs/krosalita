// End-to-end check of the Browse tab and the /api/cwf proxy behind it.
//
// This exists because Browse was broken for a long time in a way nothing caught: the Vite
// plugin that runs the serverless handlers locally only hooked `configureServer` (the DEV
// server), while start.bat serves the production build with `vite preview`. Every
// /api/cwf request therefore fell through to the SPA fallback and returned index.html with
// a 200, so the client's `res.ok` was true and `res.json()` failed with
// "Unexpected token '<', "<!doctype "... is not valid JSON" — an error that names the
// symptom and hides the cause.
//
// The first check below is the regression itself, and it is deliberately a check on the
// CONTENT TYPE, not on whether the request succeeded: a 200 of HTML is the failure mode.
//
// Upstream is a third-party service, so anything needing real puzzle data degrades to a
// skip rather than a failure when it is unreachable.
//
// Run:  npm run build && node scripts/browse-e2e.mjs

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const basePort = 5700 + Math.floor(Math.random() * 200);
const PREVIEW_PORT = basePort;
const CDP_PORT = basePort + 3000;
const BASE = `http://localhost:${PREVIEW_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const ok = (n) => { results.push({ n, pass: true }); console.log(`  PASS  ${n}`); };
const bad = (n, d) => { results.push({ n, pass: false, d }); console.log(`  FAIL  ${n}${d ? ` — ${d}` : ''}`); };
const skip = (n, d) => console.log(`  skip  ${n}${d ? ` — ${d}` : ''}`);

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
/** Kill Edge by PROFILE, not pid: spawn returns its launcher, which forks and exits. */
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

  // ---------- THE regression: the proxy must be served, not swallowed by the SPA ----------
  let upstreamOk = false;
  let firstPid = null;
  try {
    const res = await fetch(`${BASE}/api/cwf/search?q=&page=0&standard=true&mini=true`, { signal: AbortSignal.timeout(30000) });
    const ct = res.headers.get('content-type') || '';
    const body = await res.text();
    if (/^\s*<(!doctype|html)/i.test(body)) {
      bad('/api/cwf/search is served by the API, not the SPA fallback',
        `got ${res.status} ${ct} starting "${body.slice(0, 24).replace(/\s+/g, ' ')}" — the preview server is not running the handlers`);
    } else if (!ct.includes('application/json')) {
      bad('/api/cwf/search is served by the API, not the SPA fallback', `content-type ${ct}`);
    } else {
      ok(`/api/cwf/search is served by the API, not the SPA fallback (${res.status} ${ct})`);
      try {
        const data = JSON.parse(body);
        const list = data.puzzles || [];
        if (list.length > 0) {
          upstreamOk = true;
          firstPid = list[0].pid;
          ok(`search returned ${list.length} puzzles (e.g. "${String(list[0].title).slice(0, 40)}")`);
        } else {
          skip('search returned puzzles', 'upstream answered with an empty list');
        }
      } catch (e) { bad('search response parses as JSON', e.message); }
    }
  } catch (e) {
    bad('/api/cwf/search is served by the API, not the SPA fallback', `request failed: ${e.message}`);
  }

  if (upstreamOk && firstPid) {
    try {
      const res = await fetch(`${BASE}/api/cwf/puzzle?pid=${encodeURIComponent(firstPid)}`, { signal: AbortSignal.timeout(40000) });
      const body = await res.text();
      if (/^\s*<(!doctype|html)/i.test(body)) {
        bad('/api/cwf/puzzle is served by the API', 'got the SPA fallback');
      } else {
        const d = JSON.parse(body);
        const rows = (d.grid || []).length;
        const cols = rows ? (d.grid[0] || []).length : 0;
        const nClues = (d.clues?.across?.length || 0) + (d.clues?.down?.length || 0);
        if (rows > 0 && nClues > 0) ok(`puzzle ${firstPid} imports as ${rows}x${cols} with ${nClues} clues`);
        else bad('puzzle imports with a grid and clues', JSON.stringify({ rows, cols, nClues }));
      }
    } catch (e) { bad('/api/cwf/puzzle is served by the API', e.message); }
  } else {
    skip('puzzle import', 'no pid to try (upstream unreachable or empty)');
  }

  // ---------- and the tab itself renders results ----------
  profile = mkdtempSync(join(tmpdir(), 'krosalita-browse-'));
  edge = spawn(EDGE, [
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1400,1000', BASE,
  ], { stdio: 'ignore' });
  const page = await connect(CDP_PORT);

  for (let i = 0; i < 120; i++) {
    const ready = await page.evaluate(`[...document.querySelectorAll('button')].some(
      x => (x.textContent||'').trim().toLowerCase() === 'generate' && !x.disabled && x.classList.contains('btn'))`);
    if (ready) break;
    await sleep(500);
  }
  await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => /^browse$/i.test((x.textContent||'').trim()));
    if (b) b.click();
  })()`);

  let state = null;
  for (let i = 0; i < 60; i++) {
    await sleep(500);
    state = await page.evaluate(`(() => {
      const t = document.body.innerText || '';
      return {
        rows: document.querySelectorAll('button').length,
        playButtons: [...document.querySelectorAll('button')].filter(x => /^play$/i.test((x.textContent||'').trim())).length,
        jsonError: /is not valid JSON|Unexpected token/i.test(t),
        noBackend: /proxy isn't running here/i.test(t),
      };
    })()`);
    if (state.playButtons > 0 || state.jsonError || state.noBackend) break;
  }
  // The loop above breaks on the FIRST rendered row, which would make "listed N puzzles" a
  // near-meaningless assertion. Let the list settle, then count for real.
  if (state?.playButtons > 0) {
    await sleep(2000);
    state = await page.evaluate(`(() => ({
      rows: document.querySelectorAll('button').length,
      playButtons: [...document.querySelectorAll('button')].filter(x => /^play$/i.test((x.textContent||'').trim())).length,
      jsonError: /is not valid JSON|Unexpected token/i.test(document.body.innerText || ''),
      noBackend: /proxy isn't running here/i.test(document.body.innerText || ''),
    }))()`);
  }

  if (state?.jsonError) {
    bad('Browse renders results without a raw JSON parse error', 'the page is showing "not valid JSON"');
  } else if (state?.noBackend) {
    bad('Browse renders results', 'the client reports no backend — the preview is not running the handlers');
  } else if (state?.playButtons >= 5) {
    ok(`Browse listed ${state.playButtons} playable puzzles`);
  } else if (state?.playButtons > 0) {
    bad('Browse listed playable puzzles', `only ${state.playButtons} rendered — the API returned 50`);
  } else if (!upstreamOk) {
    skip('Browse listed playable puzzles', 'upstream unreachable');
  } else {
    bad('Browse listed playable puzzles', 'no Play buttons rendered');
  }

  if (page.errors.length === 0) ok('no page-level JS errors captured');
  else bad('no page-level JS errors captured', page.errors.slice(0, 2).join(' | '));

  page.close();
} catch (err) {
  bad('harness', err.message);
}

const failed = results.filter((r) => !r.pass);
console.log(failed.length ? `\nFAILED — ${failed.length} of ${results.length}` : `\nPASSED — ${results.length} checks`);
cleanup();
process.exit(failed.length ? 1 : 0);
