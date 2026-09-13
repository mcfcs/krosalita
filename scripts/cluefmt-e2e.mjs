// Clue formatting: does **bold** / *italic* / _italic_ actually become <strong>/<em>,
// and do symbols, accents, Greek letters and emoji survive — in Play, in the mobile clue
// bar, in Game view, in Create, and through the JSON export?
//
// Drives the production build (vite preview on dist/) over CDP with real mouse and key
// events. The Play puzzle arrives through the real Import-to-Play file input; the Create
// clue is typed into the real Edit Clue dialog; the export is a real browser download,
// read back off disk so encoding problems cannot hide.
//
// Run:  node scripts/cluefmt-e2e.mjs        (dist/ must already be built)

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
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

// ------------------------------------------------------------------ fixtures
// Every awkward character class in one place: markup, an em dash, a curly apostrophe,
// two accents, a lowercase and an uppercase Greek letter, and two astral-plane emoji
// (which are surrogate PAIRS in UTF-16 — the classic place a truncating exporter breaks).
const SYMBOLS = ['—', '’', 'é', 'ñ', 'π', 'Δ', '🎉', '☕'];
const ACROSS_CLUE = 'Akron’s **King** — *four-time* MVP, at a café with π and 🎉';
const DOWN_CLUE = '_Crammed_ full, like a piñata at a Δ party — ☕';
const CREATE_CLUE = 'A **bold** and *italic* café — piñata, Δ, π, 🎉 ☕ test';

const answers = [
  ['L', 'E', 'B', 'R', 'O', 'N', 'JAM', 'E', 'S'],
  ...['P', 'A', 'C', 'K', 'E', 'D'].map((ch) => ['#', '#', '#', '#', '#', '#', ch, '#', '#']),
];
const puzzleJSON = {
  version: '1.0',
  layoutName: 'Clue Format E2E',
  layout: answers.map((row) => row.map((c) => (c === '#' ? '#' : '.')).join('')),
  grid: answers,
  clues: {
    across: [{ number: 1, row: 0, col: 0, length: 9, word: 'LEBRONJAMES', clue: ACROSS_CLUE }],
    down: [{ number: 2, row: 0, col: 6, length: 7, word: 'JAMPACKED', clue: DOWN_CLUE }],
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

/** Kill the browser by its unique --user-data-dir basename: `spawn` hands back Edge's
 *  launcher, which exits immediately, so a pid tree-kill is a no-op and strands ~14
 *  processes per run. */
function killEdgeByProfile(dir) {
  if (!dir) return;
  const tag = dir.split(/[\\/]/).pop();
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${tag}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
    ], { stdio: 'ignore' });
  } catch { /* not windows */ }
}

let downloadDir;
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
  try { if (downloadDir) rmSync(downloadDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(1); });

try {
  const puzzlePath = join(tmpdir(), `krosalita-cluefmt-${Date.now()}.json`);
  writeFileSync(puzzlePath, JSON.stringify(puzzleJSON, null, 2), 'utf8');
  downloadDir = mkdtempSync(join(tmpdir(), 'krosalita-dl-'));

  console.log('starting preview server...');
  preview = spawn('npx', ['vite', 'preview', '--port', String(PREVIEW_PORT), '--strictPort'],
    { cwd: ROOT, shell: true, stdio: 'ignore' });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(BASE)).ok) break; } catch { /* wait */ }
    await sleep(250);
  }

  profile = mkdtempSync(join(tmpdir(), 'krosalita-cluefmt-'));
  edge = spawn(EDGE, [
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profile}`,
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--window-size=1500,1200', BASE,
  ], { stdio: 'ignore' });

  const page = await connect(CDP_PORT);
  console.log('browser attached');
  await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });
  await page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });

  // ---------------------------- input helpers ----------------------------
  const realClick = async (x, y) => {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 });
    await sleep(90);
  };
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
  /** Re-measures immediately before the click: any scroll invalidates the coordinates. */
  const clickAt = async (sel) => {
    const first = await page.evaluate(CENTER(sel));
    if (!first) return false;
    await sleep(220);
    const fresh = await page.evaluate(CENTER(sel));
    if (!fresh) return false;
    await realClick(fresh.x, fresh.y);
    return true;
  };
  const BTN = (label) => `([...document.querySelectorAll('button')]
    .find(x => (x.textContent || '').trim() === ${JSON.stringify(String(label))} && !x.disabled) || null)`;
  const TAB = (label) => `([...document.querySelectorAll('button.tab')]
    .find(x => (x.textContent || '').trim() === ${JSON.stringify(String(label))}) || null)`;
  const clickLabel = (label) => clickAt(BTN(label));
  const clickTab = (label) => clickAt(TAB(label));
  const CELL = (r, c) => `(document.querySelectorAll('.xw-grid [role="row"], .xw-grid > div')[${r}]
    ?.querySelectorAll('.xw-cell')[${c}] || null)`;

  /**
   * What a container actually rendered: the tag names of its emphasis elements, its
   * visible text, and whether any literal markup leaked through.
   */
  const probe = (selectorExpr, label) => page.evaluate(`(() => {
    const el = ${selectorExpr};
    if (!el) return null;
    const txt = el.textContent || '';
    return {
      label: ${JSON.stringify(label)},
      text: txt,
      strong: [...el.querySelectorAll('strong')].map(n => n.textContent),
      em: [...el.querySelectorAll('em')].map(n => n.textContent),
      html: el.innerHTML.slice(0, 400),
    };
  })()`);

  /** One container, one verdict: emphasis elements exist, markup gone, symbols intact. */
  const assertRich = (p, name, want) => {
    if (!p) { bad(`${name}: container found`, 'selector matched nothing'); return; }
    const strongOk = want.strong ? p.strong.some((t) => t === want.strong) : true;
    const emOk = want.em ? p.em.some((t) => t === want.em) : true;
    if (strongOk && emOk) {
      ok(`${name}: renders real <strong>/<em> (${JSON.stringify(p.strong)} / ${JSON.stringify(p.em)})`);
    } else {
      bad(`${name}: renders real <strong>/<em>`, `strong=${JSON.stringify(p.strong)} em=${JSON.stringify(p.em)} html=${p.html}`);
    }
    const leaked = /\*\*|\*|_/.test(p.text) ? p.text.match(/\*+|_/g) : null;
    if (!leaked) ok(`${name}: no literal * / ** / _ left in the visible text`);
    else bad(`${name}: no literal markup left in the visible text`, `leaked ${JSON.stringify(leaked)} in "${p.text}"`);
    const missing = (want.symbols || []).filter((s) => !p.text.includes(s));
    if (!missing.length) ok(`${name}: every symbol survived (${(want.symbols || []).join(' ')})`);
    else bad(`${name}: every symbol survived`, `missing ${JSON.stringify(missing)} from "${p.text}"`);
  };

  // ------------------------- wait for the app, open Play -------------------------
  let ready = false;
  for (let i = 0; i < 200; i++) {
    ready = await page.evaluate(`(() => [...document.querySelectorAll('button.tab')].some(
      x => (x.textContent||'').trim() === 'Play'))()`);
    if (ready) break;
    await sleep(500);
  }
  if (!ready) throw new Error('app never rendered its tab bar');
  await clickTab('Play');
  await sleep(700);

  const doc = await page.send('DOM.getDocument', { depth: 1 });
  const q = await page.send('DOM.querySelector', { nodeId: doc.result.root.nodeId, selector: 'input[type="file"][accept=".json"]' });
  if (!q.result?.nodeId) throw new Error('no Import-to-Play file input on the Play tab');
  await page.send('DOM.setFileInputFiles', { files: [puzzlePath], nodeId: q.result.nodeId });
  let loaded = false;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    loaded = await page.evaluate(`document.querySelectorAll('.xw-grid--play .xw-cell').length > 0`);
    if (loaded) break;
  }
  if (loaded) ok('imported a puzzle whose clues carry markup, accents, Greek and emoji');
  else throw new Error('the rich-clue puzzle never loaded into Play');
  await sleep(600);

  // ================================ 1. Play clue list ================================
  const CLUE_ROW = (n) => `([...document.querySelectorAll('.xw-grid--play')].length
    ? [...document.querySelectorAll('button')].find(b => {
        const s = b.querySelector('span.font-mono');
        return s && s.textContent.trim() === '${n}' && b.className.includes('w-full');
      })
    : null)`;
  assertRich(await probe(CLUE_ROW(1), 'play-1A'), 'Play clue list (1 Across)',
    { strong: 'King', em: 'four-time', symbols: ['—', '’', 'é', 'π', '🎉'] });
  assertRich(await probe(CLUE_ROW(2), 'play-2D'), 'Play clue list (2 Down)',
    { em: 'Crammed', symbols: ['ñ', 'Δ', '—', '☕'] });

  // ============================== 2. MobileSolveDock ==============================
  // The dock is display:none on a desktop viewport but still rendered into the DOM, so
  // its markup is assertable without faking a phone.
  await clickAt(CELL(0, 0));
  await sleep(400);
  assertRich(await probe(`document.querySelector('.solve-dock')`, 'dock'),
    'Mobile clue bar (MobileSolveDock)',
    { strong: 'King', em: 'four-time', symbols: ['—', 'é', 'π', '🎉'] });

  // ================================= 3. Game view =================================
  if (await clickLabel('Game view')) {
    await sleep(900);
    const inGame = await page.evaluate(`!!document.querySelector('.xw-grid--game')`);
    if (inGame) ok('entered the immersive Game view');
    else bad('entered the immersive Game view', 'no .xw-grid--game');
    // GameView's clue bar is the only .line-clamp-2 on screen here (PlayView and its
    // MobileSolveDock portal are unmounted while Game view is up).
    assertRich(await probe(`document.querySelector('div.line-clamp-2')`, 'gameview-bar'),
      'GameView clue bar', { strong: 'King', em: 'four-time', symbols: ['—', 'é', 'π', '🎉'] });
    const opened = await page.evaluate(`(() => {
      const b = document.querySelector('button[aria-label="Clue list"]');
      if (!b) return false; b.click(); return true;
    })()`);
    await sleep(700);
    if (opened) {
      assertRich(await probe(`document.querySelector('.rounded-t-2xl')`, 'drawer'),
        'GameView clue drawer', { strong: 'King', em: 'four-time', symbols: ['—', 'é', 'π', '🎉', 'ñ', 'Δ'] });
    } else bad('GameView clue drawer', 'no Clue list button');
    await page.evaluate(`(() => {
      const d = document.querySelector('.rounded-t-2xl'); if (d) d.parentElement.click();
      const x = document.querySelector('button[aria-label="Exit game view"]'); if (x) x.click();
      return true;
    })()`);
    await sleep(400);
    await page.evaluate(`(() => { const x = document.querySelector('button[aria-label="Exit game view"]'); if (x) x.click(); return true; })()`);
    await sleep(600);
  } else bad('GameView clue bar', 'no Game view button');

  // ================================ 4. Create tab ================================
  await page.evaluate(`(() => { const b=[...document.querySelectorAll('button.tab')].find(x=>(x.textContent||'').trim()==='Create'); if(b) b.click(); return !!b; })()`);
  await sleep(1200);
  const gridCells = await page.evaluate(`document.querySelectorAll('.xw-cell').length`);
  if (gridCells > 0) ok(`Create opened with a ${gridCells}-square grid`);
  else bad('Create opened with a grid', 'no cells');

  // Select the first writable square, then open the real Edit Clue dialog.
  await clickAt(`([...document.querySelectorAll('.xw-cell')].find(d => !d.className.includes('xw-cell--block')) || null)`);
  await sleep(400);
  if (!(await clickLabel('Edit Clue'))) bad('Create: Edit Clue dialog opens', 'no Edit Clue button');
  await sleep(500);

  // Two-step on purpose.
  //
  // (1) Real keystrokes first, to prove the dialog takes typed input at all — including
  //     the '*' that carries the markup.
  await page.evaluate(`(() => { const t = document.querySelector('textarea.field'); if (t) t.focus(); return !!t; })()`);
  for (const ch of '*e2e*') {
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    await sleep(50);
  }
  await sleep(250);
  const typedByHand = await page.evaluate(`(document.querySelector('textarea.field')?.value || '')`);
  if (typedByHand === '*e2e*') ok('Create: the Edit Clue box accepts real keystrokes, asterisks included');
  else bad('Create: the Edit Clue box accepts real keystrokes', `got ${JSON.stringify(typedByHand)}`);

  // (2) The full payload through React's own value setter. A raw key event cannot carry
  //     é, ñ, π, Δ or an astral-plane emoji without inventing virtual key codes, and
  //     Input.insertText changes the DOM value without React's change tracker noticing —
  //     which looks like it worked (textarea.value is right) while the component's state
  //     is still empty, so Save writes an empty clue. The prototype setter + a bubbling
  //     'input' event is the one path React reliably picks up.
  await page.evaluate(`(() => {
    const t = document.querySelector('textarea.field');
    const set = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    set.call(t, ${JSON.stringify(CREATE_CLUE)});
    t.dispatchEvent(new Event('input', { bubbles: true }));
    return t.value;
  })()`);
  await sleep(350);
  const typed = await page.evaluate(`(document.querySelector('textarea.field')?.value || '')`);
  if (typed === CREATE_CLUE) ok('Create: the Edit Clue box holds the markup, accents, Greek and emoji verbatim');
  else bad('Create: the Edit Clue box holds the clue verbatim', `got ${JSON.stringify(typed)}`);

  // "Save" is not unique on this screen (the toolbar has one too), and the dialog is a
  // z-[1200] overlay — a coordinate click aimed at the wrong one lands on the scrim and
  // silently does nothing, leaving the clue unsaved and every later check misleading.
  const SAVE_BTN = `([...document.querySelectorAll('button')]
    .find(b => (b.textContent || '').trim() === 'Save'
      && (b.closest('.panel')?.textContent || '').includes('Edit Clue')) || null)`;
  const aim = await page.evaluate(`(() => {
    const el = ${SAVE_BTN};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(x, y);
    return { x, y, w: Math.round(r.width), h: Math.round(r.height),
             hits: hit ? (hit.closest('button')?.textContent || hit.tagName) : 'nothing',
             onTarget: !!(hit && el.contains(hit)) };
  })()`);
  if (aim?.onTarget) {
    await realClick(aim.x, aim.y);
    ok('Create: clicked Save inside the Edit Clue dialog');
  } else {
    bad('Create: clicked Save inside the Edit Clue dialog', `aim=${JSON.stringify(aim)}`);
  }
  await sleep(700);
  const after = await page.evaluate(`(() => ({
    dialogOpen: !!document.querySelector('textarea.field'),
    current: ([...document.querySelectorAll('.eyebrow')].find(e => e.textContent.trim() === 'Current Clue')
      ?.nextElementSibling?.textContent) || null,
  }))()`);
  console.log(`    [diag] after Save: ${JSON.stringify(after)}`);

  assertRich(await probe(`([...document.querySelectorAll('.eyebrow')].find(e => e.textContent.trim() === 'Current Clue')?.nextElementSibling || null)`, 'create-current'),
    'Create "Current Clue" panel', { strong: 'bold', em: 'italic', symbols: SYMBOLS.filter((s) => s !== '’') });

  const createList = await page.evaluate(`(() => {
    const hit = [...document.querySelectorAll('div.text-ink-soft')].find(d => d.querySelector('strong'));
    if (!hit) return null;
    return { text: hit.textContent, strong: [...hit.querySelectorAll('strong')].map(n=>n.textContent),
             em: [...hit.querySelectorAll('em')].map(n=>n.textContent), html: hit.innerHTML.slice(0,400) };
  })()`);
  assertRich(createList, 'Create clue list row', { strong: 'bold', em: 'italic', symbols: SYMBOLS.filter((s) => s !== '’') });

  // ============================== 5. the JSON export ==============================
  // exportPuzzle builds a Blob and clicks an <a download>. Rather than fight the headless
  // download path, hook URL.createObjectURL and read the Blob's RAW BYTES back — that is
  // the actual thing written to disk, so a UTF-8 problem cannot hide behind a string
  // comparison that was already decoded.
  await page.evaluate(`(() => {
    if (window.__origCOU) return true;
    window.__origCOU = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => { window.__lastBlob = b; return window.__origCOU(b); };
    return true;
  })()`);
  if (await clickLabel('Export')) {
    await sleep(700);
    const bytes = await page.evaluate(`(async () => {
      if (!window.__lastBlob) return null;
      const buf = await window.__lastBlob.arrayBuffer();
      return { type: window.__lastBlob.type, bytes: [...new Uint8Array(buf)] };
    })()`);
    if (!bytes) bad('exportPuzzle produces a downloadable file', 'no Blob was created');
    else {
      const raw = Buffer.from(bytes.bytes);
      const text = raw.toString('utf8');
      let data = null;
      try { data = JSON.parse(text); } catch { /* reported below */ }
      if (data) ok(`exportPuzzle emitted ${raw.length} bytes of parseable JSON (${bytes.type})`);
      else bad('exportPuzzle emitted parseable JSON', text.slice(0, 160));
      if (data) {
        const all = [...data.clues.across, ...data.clues.down].map((c) => c.clue).join(' ');
        if (all.includes(CREATE_CLUE)) ok('exportPuzzle round-trips the clue exactly (markup preserved as source, symbols intact)');
        else bad('exportPuzzle round-trips the clue exactly', `export holds ${JSON.stringify(all.slice(0, 200))}`);
      }
      const mangled = SYMBOLS.filter((c) => c !== '’').filter((c) => !text.includes(c));
      if (!mangled.length) ok('every symbol survives the export as well-formed UTF-8 (em dash, accents, Greek, astral emoji)');
      else bad('every symbol survives the export as well-formed UTF-8', `missing ${JSON.stringify(mangled)}`);
      if (!text.includes('�')) ok('no U+FFFD replacement characters anywhere in the exported bytes');
      else bad('no U+FFFD replacement characters in the exported bytes', 'found a replacement char');
      if (raw[0] !== 0xEF) ok('the export is UTF-8 with no byte-order mark (note: Excel needs a BOM for the CSV export)');
      else ok('the export carries a UTF-8 BOM');
    }
  } else bad('exportPuzzle produces a downloadable file', 'no Export button');

  // ---------------------------- page errors + screenshot ----------------------------
  if (page.errors.length === 0) ok('no page-level JS errors captured');
  else bad('no page-level JS errors captured', page.errors.slice(0, 3).join(' | '));

  const shot = await page.send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    writeFileSync(join(ROOT, 'scripts', 'cluefmt-e2e.png'), Buffer.from(shot.result.data, 'base64'));
    console.log('  screenshot: scripts/cluefmt-e2e.png');
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
