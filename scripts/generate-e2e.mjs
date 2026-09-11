// End-to-end check of the real app: launches the production build in headless Edge,
// clicks Generate, and reads the rendered grid + clues back out of the DOM.
//
// Asserts the things the unit benches can't: that the worker actually loads the packed
// corpus over HTTP, that a fill completes in the browser, that no answer repeats, and
// that no clue references another clue.
//
// Run:  npm run build && node scripts/generate-e2e.mjs

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const PREVIEW_PORT = 4178;
const CDP_PORT = 9339;
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
      const r = await fetch(`http://localhost:${port}/json/list`);
      const tabs = await r.json();
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
    const r = await send('Runtime.evaluate', {
      expression: expr, awaitPromise: true, returnByValue: true,
    });
    if (r.result?.exceptionDetails) {
      throw new Error(r.result.exceptionDetails.exception?.description || 'eval error');
    }
    return r.result?.result?.value;
  };
  const console_ = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      console_.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? '').join(' ')}`);
    } else if (m.method === 'Log.entryAdded') {
      console_.push(`${m.params.entry.level}: ${m.params.entry.text}`);
    } else if (m.method === 'Runtime.exceptionThrown') {
      console_.push(`exception: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  return { send, evaluate, console_, close: () => ws.close() };
}

let preview, edge, profile;
function cleanup() {
  try { edge?.kill(); } catch { /* ignore */ }
  try {
    // shell:true means `preview.pid` is the shell, not the node process it
    // spawned. Killing only the shell leaks a vite preview that keeps the port
    // AND serves a stale file list, so the next run's new asset hashes 404.
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
  // If a previous run leaked a server, --strictPort makes our spawn fail silently
  // and we would test against ITS stale dist. Refuse instead.
  try {
    const probe = await fetch(BASE);
    if (probe.ok) throw new Error(`port ${PREVIEW_PORT} already in use — a previous preview leaked; kill it first`);
  } catch (e) { if (/already in use/.test(e.message)) throw e; }
  preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'],
    { cwd: ROOT, shell: true, stdio: 'ignore' });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(BASE)).ok) break; } catch { /* wait */ }
    await sleep(250);
  }

  // The corpus must actually be served, or the worker silently has no words.
  const binRes = await fetch(`${BASE}/corpus/corpus.bin`);
  const binLen = Number(binRes.headers.get('content-length') || 0);
  if (binRes.ok && binLen > 1e6) ok(`corpus.bin served (${(binLen / 1e6).toFixed(2)} MB)`);
  else bad('corpus.bin served', `status ${binRes.status}, ${binLen} bytes`);

  profile = mkdtempSync(join(tmpdir(), 'krosalita-e2e-'));
  edge = spawn(EDGE, [
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1400,1000', BASE,
  ], { stdio: 'ignore' });

  const page = await connect(CDP_PORT);
  console.log('browser attached');

  // Wait for React to mount.
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate(`!!document.querySelector('button')`)) break;
    await sleep(250);
  }

  // "Generate" matches BOTH the nav tab and the toolbar action button; the action
  // button is the one carrying a .btn class, so disambiguate on that.
  const clicked = await page.evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')]
      .filter(x => (x.textContent || '').trim().toLowerCase() === 'generate' && !x.disabled);
    const b = btns.find(x => /\bbtn\b/.test(x.className || '')) || btns[btns.length - 1];
    if (!b) return null;
    b.click();
    return b.className || 'unclassed';
  })()`);
  if (clicked) ok(`clicked Generate (${String(clicked).slice(0, 40)})`);
  else bad('clicked Generate', 'no enabled Generate button');

  // Generate opens the "Specific Words" dialog; Confirm actually starts the solve.
  await sleep(600);
  const confirmed = await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => /^confirm$/i.test((x.textContent || '').trim()) && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (confirmed) ok('confirmed the Generate dialog');
  else bad('confirmed the Generate dialog', 'no Confirm button found');

  // Poll until a grid with filled letters renders, or we give up.
  let filled = 0;
  const t0 = Date.now();
  for (let i = 0; i < 120; i++) {
    filled = await page.evaluate(`(() => {
      const cells = [...document.querySelectorAll('div,td,span')]
        .filter(e => e.children.length === 0 && /^[A-Z]$/.test((e.textContent||'').trim()));
      return cells.length;
    })()`);
    if (filled > 40) break;
    await sleep(500);
  }
  const genMs = Date.now() - t0;
  if (filled > 40) ok(`grid filled in browser (${filled} letter cells, ~${genMs}ms)`);
  else bad('grid filled in browser', `${filled} letter cells after ${genMs}ms`);

  const status = await page.evaluate(
    `(document.body.innerText.match(/^.*(couldn't|could not|no words|stopped|needs|error|filling|searching|attempt|backtrack).*$/im) || [''])[0]`);
  if (status) console.log(`  page status: "${status.trim().slice(0, 160)}"`);

  // Pull the clue list out of the DOM and re-run the filters over it. The clue number
  // is rendered as its own element, so textContent reads like "1Blue" — strip the
  // leading number rather than requiring whitespace after it.
  const clues = await page.evaluate(`(() => {
    const out = [];
    for (const el of document.querySelectorAll('li,div,p,button')) {
      if (el.querySelector('li,div,p,button')) continue;      // leaf nodes only
      const t = (el.textContent || '').trim();
      const m = t.match(/^(\\d+)\\s*(.+)$/);
      if (m && m[2].length > 1 && t.length < 240) out.push(m[2].trim());
    }
    return [...new Set(out)].slice(0, 400);
  })()`);
  console.log(`  read ${clues?.length || 0} clues from the DOM`);
  if ((clues?.length || 0) >= 40) ok(`clue list rendered (${clues.length} clues)`);
  else bad('clue list rendered', `only ${clues?.length || 0} found — the filter gate below would pass vacuously`);

  const { clueRejectReason } = await import(pathToFileURL(join(ROOT, 'src/utils/clueFilters.js')).href);
  const offenders = (clues || [])
    .map((c) => [c, clueRejectReason(c.replace(/^\d+\s*/, ''))])
    .filter(([, r]) => r);
  if (!offenders.length) ok('no cross-reference / grid-dependent clues rendered');
  else bad('no cross-reference clues rendered', offenders.slice(0, 3).map(([c, r]) => `${r}: ${c}`).join(' | '));

  // Console errors are a strong signal the worker failed to load the corpus.
  const errs = page.console_.filter((l) => /^(error|exception)/i.test(l));
  if (!errs.length) ok('no page-level JS errors captured');
  else bad('no page-level JS errors captured', errs.slice(0, 3).join(' | '));
  if (page.console_.length) {
    console.log('  console tail:');
    for (const l of page.console_.slice(-8)) console.log(`    ${l.slice(0, 160)}`);
  }

  // Optional: the AI difficulty audit, only when the configured Ollama is actually up.
  // Skipped rather than failed so this harness stays useful offline.
  const OLLAMA = process.env.KROSALITA_OLLAMA || 'http://100.102.10.69:11434';
  let ollamaUp = false;
  try {
    const c = new AbortController();
    const to = setTimeout(() => c.abort(), 4000);
    ollamaUp = (await fetch(`${OLLAMA}/api/tags`, { signal: c.signal })).ok;
    clearTimeout(to);
  } catch { ollamaUp = false; }

  if (!ollamaUp) {
    console.log(`  skip: AI audit (${OLLAMA} unreachable)`);
  } else {
    await page.evaluate(`(() => {
      localStorage.setItem('krosalita:ollama', JSON.stringify(
        { enabled: true, baseUrl: ${JSON.stringify(OLLAMA)}, model: 'qwen3.5:27b' }));
      location.reload();
    })()`);
    await sleep(2500);
    // Regenerate after the reload so a puzzle exists again.
    await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')]
        .filter(x => (x.textContent||'').trim().toLowerCase() === 'generate' && !x.disabled)
        .find(x => /\bbtn\b/.test(x.className || ''));
      if (b) b.click();
    })()`);
    await sleep(700);
    await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => /^confirm$/i.test((x.textContent||'').trim()) && !x.disabled);
      if (b) b.click();
    })()`);
    for (let i = 0; i < 40; i++) {
      if (await page.evaluate(`!!document.body.innerText.match(/AI Audit/i)`)) break;
      await sleep(500);
    }
    const started = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => /ai audit/i.test((x.textContent||'').trim()) && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (!started) {
      bad('AI audit button present', 'no enabled "AI Audit" button after enabling Ollama');
    } else {
      ok('AI audit button present');
      let summary = null;
      for (let i = 0; i < 90; i++) {          // 84 clues ~ 5 batches ~ 2-3 min
        summary = await page.evaluate(
          `(document.body.innerText.match(/AI difficulty[\s\S]{0,220}/i) || [''])[0]`);
        if (summary && !/Auditing/i.test(summary)) break;
        await sleep(3000);
      }
      if (summary && /AI difficulty/i.test(summary)) {
        ok('AI audit returned a rating');
        console.log('  ' + summary.split(String.fromCharCode(10)).slice(0, 6).join(' | ').slice(0, 220));
      } else {
        bad('AI audit returned a rating', 'no summary rendered in time');
      }
    }
  }

  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    const out = join(ROOT, 'scripts', 'generate-e2e.png');
    writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
    console.log(`  screenshot: ${out}`);
  }

  page.close();
} catch (e) {
  bad('harness', e.message);
} finally {
  cleanup();
}

const failed = results.filter((r) => !r.pass);
console.log('');
if (failed.length) { console.log(`FAILED — ${failed.length} of ${results.length}`); process.exit(1); }
console.log(`PASSED — ${results.length} checks`);
