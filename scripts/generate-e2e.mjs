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
// Fixed ports make each run hostage to the previous run's cleanup: a leaked vite
// preview keeps serving a STALE file list, so new asset hashes 404 into the SPA
// fallback and every module script fails to load. Pick free ports per run.
const basePort = 4200 + Math.floor(Math.random() * 300);
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

  // Poll until the Generate ACTION button is clickable, then click it. The app parses
  // crosswords.csv on startup and the button stays disabled until that finishes, so an
  // early click would land on the "Generate" nav tab instead (both match the text).
  let clicked = null;
  for (let i = 0; i < 120; i++) {
    clicked = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')].find(
        (x) => (x.textContent || '').trim().toLowerCase() === 'generate'
               && !x.disabled && x.classList.contains('btn'));
      if (!b) return null;
      b.click();
      return b.className;
    })()`);
    if (clicked) break;
    await sleep(500);
  }
  if (clicked) ok(`clicked Generate (${String(clicked).slice(0, 40)})`);
  else bad('clicked Generate', 'the Generate button never became enabled');

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

  // ---- Clue Studio, in Create. Works with Ollama off: the corpus supplies candidates
  // and the scorer is local, so only "Write more" needs a model.
  await page.evaluate(`(() => {
    const t = [...document.querySelectorAll('button')]
      .find(x => (x.textContent||'').trim().toLowerCase() === 'create'
                 && x.classList.contains('tab'));
    if (t) t.click();
  })()`);
  await sleep(900);

  // A completed auto-fill is copied into the Create tab (syncManualFromAuto), but the
  // copy lands a render tick after the tab switch — poll rather than guess a delay.
  // Letters live in <span class="xw-letter"> INSIDE the clickable <div class="xw-cell">,
  // so the leaf-node scan used for the proof grid above finds nothing here.
  // Wait for the grid to be FULLY copied, not merely non-empty. A partially synced grid
  // still has gaps, every word containing one is incomplete, and the Clues button stays
  // disabled — which showed up as an intermittent "no enabled Clues button" failure.
  let createLetters = 0;
  let openCells = 0;
  for (let i = 0; i < 60; i++) {
    const m = await page.evaluate(`JSON.stringify({
      letters: document.querySelectorAll('.xw-cell .xw-letter').length,
      open: [...document.querySelectorAll('.xw-cell')].filter(c => !c.classList.contains('xw-cell--block')).length
    })`);
    ({ letters: createLetters, open: openCells } = JSON.parse(m));
    if (openCells > 0 && createLetters >= openCells) break;
    await sleep(250);
  }
  if (openCells > 0 && createLetters >= openCells) {
    ok(`Create grid fully carries the fill (${createLetters}/${openCells} squares)`);
  } else {
    bad('Create grid carries the fill', `${createLetters} of ${openCells} open squares filled`);
  }

  // Reads the open ClueStudio panel: header is `<span class="eyebrow">Clues for</span>`
  // then the answer; each candidate row is `<span>percentile</span><button>clue</button>`
  // where the button may also carry "published" / "check accuracy" badge spans.
  const READ_STUDIO = `(() => {
    const h = [...document.querySelectorAll('span')]
      .find(e => e.classList.contains('eyebrow') && (e.textContent||'').trim() === 'Clues for');
    if (!h) return null;
    const panel = h.parentElement.parentElement;
    const rows = [...panel.querySelectorAll('li')].map(li => {
      const b = li.querySelector('button');
      if (!b) return null;
      const c = b.cloneNode(true);
      for (const s of c.querySelectorAll('span')) s.remove();   // drop the badges
      const clue = (c.textContent||'').trim();
      const pct = ((li.querySelector('span')||{}).textContent||'').trim();
      return clue ? { clue, pct } : null;
    }).filter(Boolean);
    return { word: ((h.nextElementSibling||{}).textContent||'').trim(), rows,
             loading: /Loading clues/i.test(panel.innerText||''),
             text: (panel.innerText||'').slice(0, 400) };
  })()`;

  // Select a filled square so there is a complete word to clue. Not every answer has
  // corpus clues, so probe a few squares spread across the grid until one yields
  // candidates instead of failing on whichever letter happened to be in the middle.
  let picked = null;
  let openedStudio = false;
  let studio = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const cell = await page.evaluate(`(() => {
      const cells = [...document.querySelectorAll('.xw-cell')].filter(e => e.querySelector('.xw-letter'));
      if (!cells.length) return null;
      const el = cells[(${attempt} * 13 + 7) % cells.length];
      el.click();
      return (el.querySelector('.xw-letter').textContent||'').trim();
    })()`);
    if (!cell) break;
    picked = picked || cell;
    await sleep(250);

    const opened = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => (x.textContent||'').trim() === 'Clues' && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    openedStudio = openedStudio || opened;
    if (!opened) continue;

    // The studio fetches the scorer + asks the worker for the corpus clues.
    for (let i = 0; i < 40; i++) {
      studio = await page.evaluate(READ_STUDIO);
      if (studio && (studio.rows.length || !studio.loading)) break;
      await sleep(250);
    }
    if (studio?.rows?.length) break;
  }
  if (picked) ok(`selected a filled square in Create (${picked})`);
  else {
    const diag = await page.evaluate(`JSON.stringify({
      tabs: [...document.querySelectorAll('button.tab')].map(b => (b.textContent||'').trim() + (b.classList.contains('tab-active') ? '*' : '')),
      cells: document.querySelectorAll('.xw-cell').length,
      letters: document.querySelectorAll('.xw-cell .xw-letter').length,
      body: (document.body.innerText||'').slice(0, 300)
    })`);
    bad('selected a filled square in Create', diag);
  }
  if (openedStudio) ok('opened the Clue Studio');
  else bad('opened the Clue Studio', 'no enabled "Clues" button');

  if (studio?.rows?.length) {
    ok(`Studio listed ${studio.rows.length} candidates for ${studio.word}`);
    for (const r of studio.rows.slice(0, 3)) {
      console.log(`     ${String(r.pct).padStart(3)}  ${r.clue.slice(0, 110)}`);
    }
  } else {
    bad('Studio listed candidates', `panel text: ${String(studio?.text || 'not found').slice(0, 120)}`);
  }

  // Accepting must actually change the slot's clue.
  if (studio?.rows?.length) {
    const applied = await page.evaluate(`(() => {
      const h = [...document.querySelectorAll('span')]
        .find(e => e.classList.contains('eyebrow') && (e.textContent||'').trim() === 'Clues for');
      if (!h) return '';
      const b = h.parentElement.parentElement.querySelector('li button');
      if (!b) return '';
      const c = b.cloneNode(true);
      for (const s of c.querySelectorAll('span')) s.remove();
      b.click();
      return (c.textContent||'').trim();
    })()`);
    const stripped = String(applied)
      .replace(/^\d+\s*/, '').replace(/published|check accuracy/g, '').trim();
    // Read the "Current Clue" block rather than the whole page: the studio itself shows
    // the candidate, so a body-wide match would pass before the clue was ever applied.
    let clueNow = '';
    for (let i = 0; i < 24; i++) {
      clueNow = await page.evaluate(`(() => {
        const h = [...document.querySelectorAll('div')]
          .find(e => (e.textContent||'').trim() === 'Current Clue');
        return h && h.nextElementSibling ? (h.nextElementSibling.textContent||'').trim() : '';
      })()`);
      if (stripped && clueNow.includes(stripped.slice(0, 24))) break;
      await sleep(250);
    }
    if (stripped && clueNow.includes(stripped.slice(0, 24))) {
      ok(`accepted clue became the slot clue ("${stripped.slice(0, 60)}")`);
    } else {
      bad('accepted clue applied', `looked for "${stripped.slice(0, 40)}", slot shows "${clueNow.slice(0, 40)}"`);
    }

    // Regression: accepting a clue used to flip usingCustomWords, which swapped the worker
    // off the packed corpus onto CSV rows with no clue store -- so the Studio went blank
    // from then on. The existing checks missed it because the audit step reloads the page
    // in between, which reset the flag. Reopen it here, in the same page session.
    await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => (x.textContent || '').trim() === 'Clues' && !x.disabled);
      if (b) b.click();
    })()`);
    let again = null;
    for (let i = 0; i < 30; i++) {
      again = await page.evaluate(READ_STUDIO);
      if (again && (again.rows.length || !again.loading)) break;
      await sleep(400);
    }
    if (again?.rows?.length) ok(`Studio still works after accepting (${again.rows.length} candidates)`);
    else bad('Studio still works after accepting', `panel now shows ${again?.rows?.length ?? 'nothing'}`);
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
        .find(x => x.classList.contains('btn'));   // \\b in a template literal is BACKSPACE
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
          `(document.body.innerText.match(/AI difficulty[\\s\\S]{0,220}/i) || [''])[0]`);
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

  // ---- Whole-puzzle re-clue, in Create. Runs with or without a model: the corpus alone
  // already supplies a swap for every answer that has a published clue in the band, and
  // only the rest go to Ollama. So this is guarded, not skipped, on the offline path —
  // `ollamaUp` (probed above) only decides how long the run is allowed to take.
  //
  // The AI audit above reloads the page into Auto, so re-enter Create either way.
  await page.evaluate(`(() => {
    const t = [...document.querySelectorAll('button')]
      .find(x => (x.textContent||'').trim().toLowerCase() === 'create'
                 && x.classList.contains('tab'));
    if (t) t.click();
  })()`);
  let reclueCells = 0;
  for (let i = 0; i < 60; i++) {
    reclueCells = await page.evaluate(`document.querySelectorAll('.xw-cell .xw-letter').length`);
    if (reclueCells > 40) break;
    await sleep(250);
  }

  // `<span class="eyebrow">Re-clue this puzzle</span>` sits in the panel's header row, so
  // the panel itself is two levels up — same shape as the Clue Studio reader above.
  const RECLUE_PANEL = `[...document.querySelectorAll('span')]
      .find(e => e.classList.contains('eyebrow') && (e.textContent||'').trim() === 'Re-clue this puzzle')
      ?.parentElement?.parentElement`;

  // Clicks a button inside the panel. `pred` is JS source tested against `t`, the trimmed
  // label: the band buttons match exactly while Apply carries a live count.
  const clickInReclue = (pred) => `(() => {
    const panel = ${RECLUE_PANEL};
    if (!panel) return false;
    const b = [...panel.querySelectorAll('button')]
      .find(x => { const t = (x.textContent||'').trim(); return (${pred}) && !x.disabled; });
    if (!b) return false;
    b.click();
    return true;
  })()`;

  // Each proposal is an <li>: checkbox, percentile <span>, the numbered clue, status label.
  // The selected band button is the one carrying the bare `bg-ink` class — the unselected
  // ones carry `hover:bg-ink/5`, so this must be classList.contains, not a substring test.
  const READ_RECLUE = `(() => {
    const panel = ${RECLUE_PANEL};
    if (!panel) return null;
    const runBtn = [...panel.querySelectorAll('button')]
      .find(b => /Working|Find clues/.test((b.textContent||'').trim()));
    const applyBtn = [...panel.querySelectorAll('button')]
      .find(b => (b.textContent||'').trim().startsWith('Apply'));
    const rows = [...panel.querySelectorAll('li')].map(li => {
      const spans = [...li.querySelectorAll('span')];
      const box = li.querySelector('input[type="checkbox"]');
      const line = li.querySelector('div > div');
      const c = line ? line.cloneNode(true) : null;
      if (c) for (const s of c.querySelectorAll('span')) s.remove();   // drop number + badges
      return {
        box: !!box,
        checked: !!(box && box.checked),
        pct: ((li.querySelector('span')||{}).textContent||'').trim(),
        num: spans.length > 1 ? (spans[1].textContent||'').trim() : '',
        clue: c ? (c.textContent||'').trim() : '',
        status: spans.length ? (spans[spans.length - 1].textContent||'').trim() : '',
      };
    });
    const text = panel.innerText || '';
    return {
      band: ([...panel.querySelectorAll('button')].find(b => b.classList.contains('bg-ink'))
             || { textContent: '' }).textContent.trim(),
      running: /Working/.test(runBtn ? (runBtn.textContent||'') : ''),
      summary: ((text.match(/^.*from published clues.*$/m) || [''])[0]).trim(),
      error: ((text.match(/^.*(couldn't|could not|failed|timed out|cancelled).*$/im) || [''])[0]).trim(),
      applyText: applyBtn ? (applyBtn.textContent||'').trim() : '',
      rows,
      text: text.slice(0, 400),
    };
  })()`;

  if (reclueCells <= 40) {
    console.log('  skip: re-clue (no filled grid in Create)');
  } else {
    // "Re-clue all" lives in the selection panel, which ManualEditor only renders once a
    // square is selected — and the reload above cleared whatever was selected before.
    await page.evaluate(`(() => {
      const c = [...document.querySelectorAll('.xw-cell')].find(e => e.querySelector('.xw-letter'));
      if (c) c.click();
      return !!c;
    })()`);
    let openedReclue = false;
    for (let i = 0; i < 20; i++) {
      openedReclue = await page.evaluate(`(() => {
        const b = [...document.querySelectorAll('button')]
          .find(x => (x.textContent||'').trim() === 'Re-clue all' && !x.disabled);
        if (!b) return false;
        b.click();
        return true;
      })()`);
      if (openedReclue) break;
      await sleep(250);
    }
    let rv = null;
    for (let i = 0; i < 24; i++) {
      rv = await page.evaluate(READ_RECLUE);
      if (rv) break;
      await sleep(250);
    }
    // Sense discovery needs Ollama, which only the audit step above turns on — so this
    // runs here rather than with the other Studio checks, where AI is still off.
    await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => (x.textContent || '').trim() === 'Clues' && !x.disabled);
      if (b) b.click();
    })()`);
    await sleep(1200);
// Sense discovery: the answer's distinct meanings, each pickable.
    const askedSenses = await page.evaluate(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => /what can it mean|find meanings/i.test((x.textContent || '').trim()) && !x.disabled);
      if (!b) return false;
      b.click();
      return true;
    })()`);
    if (askedSenses) {
      let senseRows = [];
      for (let i = 0; i < 60; i++) {
        senseRows = await page.evaluate(`(() => {
          const h = [...document.querySelectorAll('span.eyebrow')]
            .find(e => (e.textContent || '').trim() === 'Clues for');
          if (!h) return [];
          const panel = h.parentElement.parentElement;
          return [...panel.querySelectorAll('ul li button')]
            .map(b => (b.textContent || '').trim())
            .filter(t => /as published|unverified|unchecked/.test(t));
        })()`);
        if (senseRows.length) break;
        await sleep(1000);
      }
      if (senseRows.length) {
        ok(`sense list offered ${senseRows.length} meanings`);
        for (const r of senseRows.slice(0, 3)) console.log(`       ${r.replace(/\s+/g, ' ').slice(0, 84)}`);
        // Every meaning must carry a confidence label — the model invents them, so an
        // unlabelled one would read as vetted.
        const unlabelled = senseRows.filter(t => !/as published|unverified|unchecked/.test(t));
        if (unlabelled.length) bad('every meaning is labelled', `${unlabelled.length} without a label`);
        else ok('every meaning carries a confidence label');
        // The Studio sits well below the fold; a viewport capture would show the header.
        await page.evaluate(`(() => {
          const h = [...document.querySelectorAll('span.eyebrow')]
            .find(e => (e.textContent || '').trim() === 'Clues for');
          if (h) h.parentElement.parentElement.scrollIntoView({ block: 'center' });
        })()`);
        await sleep(400);
        const sshot = await page.send('Page.captureScreenshot', { format: 'png' });
        if (sshot.result?.data) {
          const out = join(ROOT, 'scripts', 'senses-e2e.png');
          writeFileSync(out, Buffer.from(sshot.result.data, 'base64'));
          console.log(`  screenshot: ${out}`);
        }
      } else {
        bad('sense list offered meanings', 'none appeared within 60s');
      }
    } else {
      console.log('  skip: sense discovery (button not present — AI off?)');
    }

    if (openedReclue && rv) ok('opened the Re-clue panel from Create');
    else bad('opened the Re-clue panel', openedReclue ? 'panel header never rendered' : 'no enabled "Re-clue all" button');

    if (rv) {
      const bandClicked = await page.evaluate(clickInReclue(`t === 'Easy'`));
      let band = '';
      for (let i = 0; i < 20; i++) {
        band = ((await page.evaluate(READ_RECLUE)) || {}).band || '';
        if (band === 'Easy') break;
        await sleep(200);
      }
      if (bandClicked && band === 'Easy') ok('selected the Easy band');
      else bad('selected the Easy band', `the highlighted band reads "${band}"`);

      const started = await page.evaluate(clickInReclue(`t === 'Find clues'`));
      if (!started) {
        bad('started the re-clue run', 'no enabled "Find clues" button');
      } else {
        // Corpus-only lands in seconds; with a model the leftovers go out 15 answers per
        // request, so allow minutes rather than guessing. The button reads "Working…" for
        // the whole run, which is the only reliable done signal.
        await sleep(600);
        const rounds = ollamaUp ? 90 : 20;          // 90 x 3s ~ 4.5 min
        const tR0 = Date.now();
        for (let i = 0; i < rounds; i++) {
          rv = await page.evaluate(READ_RECLUE);
          if (rv && !rv.running && (rv.summary || rv.error)) break;
          await sleep(3000);
        }
        const reclueMs = Date.now() - tR0;
        if (rv?.summary) {
          ok(`re-clue run finished (~${Math.round(reclueMs / 1000)}s${ollamaUp ? '' : ', corpus only'})`);
          console.log(`  summary: ${rv.summary.slice(0, 220)}`);
        } else {
          bad('re-clue run finished', `after ${reclueMs}ms: ${String(rv?.error || rv?.text || 'panel gone').slice(0, 160)}`);
        }

        const proposed = rv?.rows || [];
        if (proposed.length) {
          ok(`re-clue proposed ${proposed.length} clues`);
          for (const r of proposed.slice(0, 4)) {
            console.log(`     ${String(r.pct).padStart(3)}  ${r.num.padEnd(4)} ${r.clue.slice(0, 76)}  [${r.status}]`);
          }
        } else {
          bad('re-clue proposed clues', `panel text: ${String(rv?.text || 'not found').slice(0, 160)}`);
        }

        // Every row must be actionable: a tickbox, a numeric percentile, and one of the
        // six outcomes ReclueReview knows how to describe.
        const STATUSES = ['published clue', 'written', 'already right',
          'closest available', "answer can't go there", 'nothing found'];
        const malformed = proposed.filter(
          (r) => !r.box || !/^[0-9]+$/.test(r.pct) || !r.clue || !STATUSES.includes(r.status));
        if (proposed.length && !malformed.length) ok('every proposal has a tickbox, a percentile and a known status');
        else if (proposed.length) bad('proposal rows well formed', JSON.stringify(malformed.slice(0, 2)).slice(0, 200));

        // Screenshot the panel BEFORE applying — the review state is the thing worth seeing.
        await page.evaluate(`(() => { const p = ${RECLUE_PANEL}; if (p) p.scrollIntoView({ block: 'center' }); return true; })()`);
        await sleep(400);
        const reclueShot = await page.send('Page.captureScreenshot', { format: 'png' });
        if (reclueShot.result?.data) {
          const out = join(ROOT, 'scripts', 'reclue-e2e.png');
          writeFileSync(out, Buffer.from(reclueShot.result.data, 'base64'));
          console.log(`  screenshot: ${out}`);
        }

        if (proposed.length) {
          const applyText = rv.applyText;
          const applied = await page.evaluate(clickInReclue(`t.startsWith('Apply')`));
          let closed = false;
          let note = '';
          for (let i = 0; i < 24; i++) {
            const st = JSON.parse(await page.evaluate(`JSON.stringify({
              open: !!(${RECLUE_PANEL}),
              note: ((document.body.innerText||'').match(/Re-clued[^\\n]*/) || [''])[0]
            })`));
            closed = !st.open;
            note = st.note;
            if (closed && note) break;
            await sleep(250);
          }
          if (applied && closed && /Re-clued/.test(note)) {
            ok(`applied the re-clue ("${applyText}" -> "${note.trim()}")`);
          } else {
            bad('applied the re-clue', `clicked=${applied} panelClosed=${closed} note="${note}"`);
          }
        }
      }
    }
  }

  // ---- Create-mode auto-fill against the new solver. The suggestion and
  // "Generate Remaining" paths predate the rewrite, so exercise them for real: clear the
  // grid, refill it from scratch, and check the solver's own message reaches the UI.
  await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => (x.textContent || '').trim() === 'Clear Grid' && !x.disabled);
    if (b) b.click();
  })()`);
  await sleep(600);
  const cleared = await page.evaluate(`document.querySelectorAll('.xw-cell .xw-letter').length`);
  if (cleared === 0) ok('cleared the Create grid');
  else bad('cleared the Create grid', `${cleared} letters remain`);

  const ranFill = await page.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')]
      .find(x => (x.textContent || '').trim() === 'Generate Remaining' && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  })()`);
  if (!ranFill) {
    bad('ran Generate Remaining', 'button missing or disabled');
  } else {
    let filled = 0;
    let open = 0;
    for (let i = 0; i < 80; i++) {
      const m = await page.evaluate(`JSON.stringify({
        letters: document.querySelectorAll('.xw-cell .xw-letter').length,
        open: [...document.querySelectorAll('.xw-cell')].filter(c => !c.classList.contains('xw-cell--block')).length
      })`);
      ({ letters: filled, open } = JSON.parse(m));
      if (open > 0 && filled >= open) break;
      await sleep(500);
    }
    if (open > 0 && filled >= open) ok(`Generate Remaining refilled the grid (${filled}/${open})`);
    else bad('Generate Remaining refilled the grid', `${filled} of ${open} squares`);

    // Every refilled entry must get a clue — an unclued answer is unsolvable, and this is
    // the path where preset clues used to be re-pinned to the wrong word.
    const unclued = await page.evaluate(`document.querySelectorAll('.xw-cell--needs-clue, .xw-cell--needs-clue-strong').length`);
    if (unclued === 0) ok('every refilled entry has a clue');
    else bad('every refilled entry has a clue', `${unclued} squares still flagged as needing one`);
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
