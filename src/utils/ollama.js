// Client for a locally-hosted Ollama server (https://ollama.com).
// Used for AI clue assistance. All config lives in localStorage so it is
// per-device and never leaves the machine.
import { loadJSON, saveJSON } from './storage.js';

const CONFIG_KEY = 'ollama';
export const DEFAULT_CONFIG = {
  enabled: false,
  baseUrl: 'http://localhost:11434',
  model: 'llama3.1',
};

export const getOllamaConfig = () => ({ ...DEFAULT_CONFIG, ...loadJSON(CONFIG_KEY, {}) });
export const saveOllamaConfig = (cfg) => saveJSON(CONFIG_KEY, { ...getOllamaConfig(), ...cfg });

const withTimeout = (ms) => {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(id) };
};

const trimBase = (url) => (url || '').replace(/\/+$/, '');

// Warn if an https page tries to reach an http Ollama (browsers block this as
// mixed content). Returns a message string, or null if fine.
export const mixedContentWarning = (baseUrl) => {
  try {
    if (typeof window === 'undefined') return null;
    if (window.location.protocol === 'https:' && /^http:\/\//i.test(baseUrl || '')) {
      return 'This page is served over HTTPS but the Ollama URL is HTTP — browsers block that (mixed content). Serve the app over HTTP, or put Ollama behind HTTPS.';
    }
  } catch { /* ignore */ }
  return null;
};

// Quick connectivity + model list. Throws on failure with a friendly message.
export const listModels = async (baseUrl) => {
  const mc = mixedContentWarning(baseUrl);
  if (mc) throw new Error(mc);
  const t = withTimeout(8000);
  try {
    const res = await fetch(`${trimBase(baseUrl)}/api/tags`, { signal: t.signal });
    if (!res.ok) throw new Error(`Server responded ${res.status}.`);
    const data = await res.json();
    return (data.models || []).map((m) => m.name);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Timed out reaching Ollama (check the URL / VPN).');
    if (err.message && err.message.startsWith('Server responded')) throw err;
    throw new Error('Could not reach Ollama. Check: (1) it is running; (2) the URL is right — over Tailscale use the host\'s Tailscale IP/name, not localhost; (3) it is bound to your network (OLLAMA_HOST=0.0.0.0:11434); (4) this page\'s origin is allowed (OLLAMA_ORIGINS).');
  } finally {
    t.done();
  }
};

const DIFFICULTY_HINT = {
  EASY: 'very easy and straightforward, suitable for a Monday puzzle',
  FAIR: 'gently challenging',
  MODERATE: 'medium difficulty with a little wordplay',
  HARD: 'tricky, with wordplay or misdirection',
  DIFFICULT: 'very hard, cryptic-leaning, suitable for a Saturday puzzle',
};

const cleanClueLine = (line) => {
  let c = line.trim().replace(/^\s*(?:\d+[.)]|[-*•])\s*/, '').trim();
  c = c.replace(/^["'“”]+|["'“”]+$/g, '').trim();
  return c;
};

/**
 * Generate crossword clues for a word.
 * @returns {Promise<string[]>} array of candidate clues
 */
export const generateClues = async ({ baseUrl, model, word, count = 3, difficulty = 'MODERATE', language = 'English' }) => {
  const answer = (word || '').toUpperCase();
  if (!answer) return [];
  const hint = DIFFICULTY_HINT[difficulty.toUpperCase()] || DIFFICULTY_HINT.MODERATE;
  const prompt = `You are an expert crossword clue writer. Write ${count} distinct ${language} crossword clues for the answer "${answer}".
Make them ${hint}. Keep each clue short (a few words), do NOT include the answer or its length in the clue, and do not explain.
Return ONLY the clues, one per line, with no numbering or quotes.`;

  const t = withTimeout(45000);
  try {
    const res = await fetch(`${trimBase(baseUrl)}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0.8 } }),
      signal: t.signal,
    });
    if (!res.ok) throw new Error(`Ollama responded ${res.status}. Check the model name.`);
    const data = await res.json();
    const text = data.response || '';
    return text
      .split('\n')
      .map((l) => cleanClueLine(l))
      .filter((c) => c && !c.toUpperCase().includes(answer))
      .slice(0, count);
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Clue generation timed out.');
    throw new Error(err.message || 'Clue generation failed.');
  } finally {
    t.done();
  }
};

// ---------------------------------------------------------------------------
// Difficulty audit — rate the clues of a finished puzzle 0-100 so the setter
// can sanity-check the overall level and spot outliers.
// ---------------------------------------------------------------------------

const AUDIT_BATCH_SIZE = 20;
const AUDIT_TIMEOUT_MS = 180000; // a 27B model needs ~30s per 20 pairs

// A timeout signal that also fires when the caller's AbortSignal does.
const linkedTimeout = (ms, external) => {
  const t = withTimeout(ms);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  t.signal.addEventListener('abort', onAbort);
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener('abort', onAbort);
  }
  return {
    signal: ctrl.signal,
    timedOut: () => t.signal.aborted,
    done: () => {
      t.signal.removeEventListener('abort', onAbort);
      external?.removeEventListener('abort', onAbort);
      t.done();
    },
  };
};

const clampScore = (n) => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Pull the ratings out of one model response. Pure + defensive: tolerates code
 * fences, stray prose, out-of-range scores and malformed items.
 * @returns {Array<{i:number,d:number}>} valid items only (possibly empty)
 */
export const parseAuditResponse = (text, batchSize) => {
  const raw = (text || '').replace(/```[a-z]*\s*/gi, '').replace(/```/g, '').trim();
  const greedy = raw.match(/\[[\s\S]*\]/);
  const lazy = raw.match(/\[[\s\S]*?\]/);
  let arr = null;
  for (const candidate of [greedy?.[0], lazy?.[0]]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) { arr = parsed; break; }
    } catch { /* try the next shape */ }
  }
  if (!arr) return [];
  const seen = new Set();
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const i = Number(item.i);
    const d = Number(item.d);
    if (!Number.isFinite(i) || !Number.isFinite(d)) continue;
    if (i < 1 || i > batchSize || seen.has(i)) continue;
    seen.add(i);
    out.push({ i, d: clampScore(d) });
  }
  return out;
};

const auditPrompt = (batch) => {
  const pairs = batch
    .map((e, idx) => `${idx + 1}. ${(e.word || '').toUpperCase()} — ${e.clue}`)
    .join('\n');
  return `You are a veteran crossword editor. Rate how hard each ANSWER/CLUE pair is for a solver, 0-100, on the New York Times weekday scale.

Scale:
0-15 Monday, plain definition; 16-35 Tuesday/Wednesday; 36-55 Thursday, wordplay or a "?" clue; 56-75 Friday, obscure word or tough angle; 76-100 Saturday, crosswordese or deep trivia.

Calibration:
OREO "Sandwich cookie" -> 10
IDEA "Brainstorm result" -> 5
ERNE "Sea eagle" -> 70
ETUI "Needle case" -> 75
ANOA "Wild ox of Celebes" -> 90
ESNE "Anglo-Saxon serf" -> 95
HELL "Fire place?" -> 45

Pairs:
${pairs}

Return ONLY a JSON array of objects {"i":<the number above>,"d":<0-100>}, one per pair, in order. No prose, no explanation, no code fences.`;
};

// One /api/generate round trip for a batch. Returns the raw response text.
const runAuditBatch = async ({ baseUrl, model, batch, signal }) => {
  const t = linkedTimeout(AUDIT_TIMEOUT_MS, signal);
  try {
    const res = await fetch(`${trimBase(baseUrl)}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: auditPrompt(batch),
        stream: false,
        think: false,
        options: { temperature: 0, num_predict: 1200 },
      }),
      signal: t.signal,
    });
    if (!res.ok) throw new Error(`Ollama responded ${res.status}. Check the model name.`);
    const data = await res.json();
    return data.response || '';
  } catch (err) {
    if (err.name === 'AbortError') {
      if (t.timedOut()) throw new Error('A difficulty batch timed out.');
      throw new Error('Difficulty audit cancelled.');
    }
    throw new Error(err.message || 'Difficulty audit failed.');
  } finally {
    t.done();
  }
};

const percentile = (sortedAsc, p) => {
  if (!sortedAsc.length) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil(p * sortedAsc.length) - 1));
  return sortedAsc[idx];
};

/**
 * Rate every clue in a finished puzzle, 20 at a time (one request per clue
 * would take minutes). A batch that will not parse is retried once and then
 * skipped, so one bad response never sinks the whole audit.
 * @param {{number:number,direction:string,word:string,clue:string}[]} entries
 * @param {(p:{done:number,total:number}) => void} [onProgress] after each batch
 * @param {AbortSignal} [signal] cancels the run
 * @returns {Promise<{ratings:object[],summary:object}>}
 */
export const auditDifficulty = async ({ baseUrl, model, entries, onProgress, signal }) => {
  const list = (entries || []).filter((e) => e && e.word && e.clue);
  const total = list.length;
  const emptySummary = { mean: 0, p80: 0, hardest: [], unrated: 0 };
  if (!total) return { ratings: [], summary: emptySummary };

  const mc = mixedContentWarning(baseUrl);
  if (mc) throw new Error(mc);

  const ratings = [];
  let unrated = 0;
  let done = 0;

  for (let start = 0; start < total; start += AUDIT_BATCH_SIZE) {
    if (signal?.aborted) throw new Error('Difficulty audit cancelled.');
    const batch = list.slice(start, start + AUDIT_BATCH_SIZE);
    let items = [];

    for (let attempt = 0; attempt < 2 && !items.length; attempt += 1) {
      try {
        const text = await runAuditBatch({ baseUrl, model, batch, signal });
        items = parseAuditResponse(text, batch.length);
      } catch (err) {
        // Cancellation is the caller's decision — everything else is just a
        // bad batch, so retry once and move on.
        if (signal?.aborted || /cancelled/i.test(err.message || '')) throw err;
      }
    }

    const byIndex = new Map(items.map((it) => [it.i, it.d]));
    batch.forEach((e, idx) => {
      const d = byIndex.get(idx + 1);
      if (d === undefined) { unrated += 1; return; }
      ratings.push({
        number: e.number,
        direction: e.direction,
        word: e.word,
        clue: e.clue,
        difficulty: d,
      });
    });

    done += batch.length;
    onProgress?.({ done, total });
  }

  if (!ratings.length) return { ratings, summary: { ...emptySummary, unrated } };

  const scores = ratings.map((r) => r.difficulty).sort((a, b) => a - b);
  const mean = Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10;
  const hardest = [...ratings].sort((a, b) => b.difficulty - a.difficulty).slice(0, 5);

  return { ratings, summary: { mean, p80: percentile(scores, 0.8), hardest, unrated } };
};

// ---------------------------------------------------------------------------
// Batched clue generation
// ---------------------------------------------------------------------------

const GEN_BATCH_SIZE = 15;
const GEN_TIMEOUT_MS = 240000; // a 27B model writing ~30 clues takes a while

/** Token budget for a response carrying `items` clue objects, with headroom. */
const budgetFor = (items) => Math.min(8000, 400 + items * 45);

/** Answers per request, so a big `perWord` shrinks the batch instead of overrunning. */
export const genBatchSize = (perWord) => Math.max(1, Math.min(GEN_BATCH_SIZE,
  Math.floor(120 / Math.max(1, perWord))));

// Length is the single biggest thing the model gets wrong when asked for an easy clue.
// Measured on the shipped scorer, same answer and same meaning each time:
//   SLED  "Snow rider" p22   ->  "A vehicle used for riding down snowy hills" p65
//   ETSY  "Craft site" p15   ->  "Site for handmade goods sellers"            p45
//   ATTA  "___ boy"    p29   ->  "Common prefix for 'boy' and 'girl' phrases" p67
// Asked for EASY, the model wrote the 30-45 character versions almost every time and
// missed the band it had just been asked for. That is not the scorer being fooled: a
// printed Monday clue really is a two-word fragment, and the model was writing glossary
// definitions. Spelling the length out moves more than any adjective about difficulty.
const GEN_RUBRIC = {
  easy: 'a plain, direct definition — and TERSE, the length a printed Monday clue actually is: two to four words, a fragment and never a sentence ("Snow rider", "Craft site", "Sport with mallets")',
  medium: 'moderately challenging, with light wordplay or a slightly indirect angle, and still short — a printed clue, not a definition',
  hard: 'genuinely tough — wordplay, misdirection, or a less obvious sense of the word, still phrased as a short printed clue',
};

/**
 * Pull `{i, c}` pairs out of whatever the model wrapped its JSON in.
 * Exported so it can be unit-tested without a server. Tolerant by design: one malformed
 * item should cost one clue, not the whole batch.
 */
export const parseGenerateResponse = (text, batchSize) => {
  if (!text) return [];
  const cleaned = String(text).replace(/^```(?:json)?|```$/gm, '').trim();
  const match = cleaned.match(/\[[\s\S]*\]/);
  let arr = null;
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      if (Array.isArray(parsed)) arr = parsed;
    } catch { /* fall through to salvage */ }
  }
  // A response cut off by num_predict has no closing bracket, so the whole array fails to
  // parse and every clue in the batch is lost -- measured: asking for 8 clues x 15 answers
  // returned 0 usable clues, twice, because both attempts ran past the token budget.
  // The items themselves are complete up to the cut, so salvage them one by one.
  if (!arr) {
    arr = [];
    for (const m of cleaned.matchAll(/\{[^{}]*\}/g)) {
      try { arr.push(JSON.parse(m[0])); } catch { /* skip this one item */ }
    }
    if (!arr.length) return [];
  }
  const out = [];
  for (const item of arr) {
    if (!item || typeof item !== 'object') continue;
    const i = Number(item.i);
    const c = typeof item.c === 'string' ? item.c.trim() : '';
    if (!Number.isFinite(i) || i < 1 || i > batchSize || !c) continue;
    // The reading is what the model THOUGHT the answer says. Surfacing it is the only way
    // a wrong interpretation becomes visible rather than silently producing clues for the
    // wrong word -- asked for AMINOT it reads "AMINOT" and clues a French painter.
    out.push({ i, clue: cleanClueLine(c), reading: typeof item.r === 'string' ? item.r.trim() : '' });
  }
  return out;
};

const NL = String.fromCharCode(10);

const generatePrompt = (batch, band, perWord) => {
  const hint = GEN_RUBRIC[band] || GEN_RUBRIC.medium;
  // Three things pin down what an answer actually MEANS, in decreasing order of
  // reliability. Without them the model guesses and guesses badly: asked to clue ISITME
  // it wrote "Time to check one's watch?", and RAZER got clued as a gaming brand when the
  // corpus has only ever used the raze sense.
  //   1. `sense`   - the caller said outright which meaning is wanted. Wins.
  //   2. `known`   - how the answer has actually been clued in print. Ground truth.
  //   3. neither   - say so, and warn that answers are written without spaces, because
  //                  the model otherwise reads WHATSUPDOC as a Peanuts reference.
  const lines = batch.map((e, i) => {
    const bits = [`${i + 1}. ${e.word}`];
    if (e.sense) bits.push(`   meaning: ${e.sense}`);
    else if (e.known?.length) {
      bits.push(`   clued before as: ${e.known.slice(0, 4).map((c) => `"${c}"`).join(', ')} — use the SAME meaning`);
    } else {
      bits.push('   never clued before — it may be a multi-word phrase, name or brand written without spaces');
    }
    return bits.join(NL);
  }).join(NL);

  return `You are a New York Times crossword editor writing clues.

For each numbered ANSWER below, write ${perWord} crossword ${perWord === 1 ? 'clue' : 'clues'}.
Every clue must be ${hint}.

Rules:
- Never include the answer, or any part of it, in its own clue.
- Never refer to another entry ("see 14-Across", "with 3-Down") — these puzzles are generated, so the numbers would be meaningless.
- Never refer to the grid, its theme, circled or shaded squares.
- Keep each clue short, the way a printed crossword clue is short: a noun phrase or
  fragment of two to five words. "Snow rider", not "A vehicle for riding down snow".
- Vary the length across the ${perWord} clues for an answer. Make at least two of them as
  short as you can while still being fair.
- Clue only the meaning indicated. If none is given, work out the most likely reading first.

Reply with ONLY a JSON array of {"i":<answer number>,"r":"<the reading you clued, e.g. AM I NOT>","c":"<clue>"}, ${perWord} entries per answer. No prose, no code fences.

${lines}`;
};

/**
 * Write clues for many answers at once.
 *
 * One request per answer would mean ~78 round trips for a full puzzle — minutes on a
 * local 27B model. Batching 15 answers per request makes that ~5 requests. Mirrors
 * auditDifficulty's shape: one retry per batch, cancellation via AbortSignal, and a batch
 * that will not parse costs its own entries rather than the whole run.
 *
 * @returns {Promise<Map<string, string[]>>} answer -> candidate clues
 */
export const generateCluesBatch = async ({
  baseUrl, model, entries, band = 'medium', perWord = 2, onProgress, signal,
}) => {
  const list = (entries || []).filter((e) => e && e.word);
  const out = new Map();
  if (!list.length) return out;

  const mc = mixedContentWarning(baseUrl);
  if (mc) throw new Error(mc);

  let done = 0;
  const step = genBatchSize(perWord);
  for (let start = 0; start < list.length; start += step) {
    if (signal?.aborted) throw new Error('Clue generation cancelled.');
    const batch = list.slice(start, start + step);
    let items = [];

    for (let attempt = 0; attempt < 2 && !items.length; attempt += 1) {
      const t = linkedTimeout(GEN_TIMEOUT_MS, signal);
      try {
        const res = await fetch(`${trimBase(baseUrl)}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            prompt: generatePrompt(batch, band, perWord),
            stream: false,
            think: false,
            // One returned item is `{"i":1,"r":"ERNE","c":"Heraldic eagle"}, ` -- about 25
            // tokens, more when the reading is a spelled-out phrase. A flat 1400 was
            // enough for the 30 clues the UI used to ask for and silently truncated
            // anything larger, so size the budget to what was actually requested.
            options: { temperature: 0.8, num_predict: budgetFor(batch.length * perWord) },
          }),
          signal: t.signal,
        });
        if (!res.ok) throw new Error(`Ollama responded ${res.status}. Check the model name.`);
        const data = await res.json();
        items = parseGenerateResponse(data.response || '', batch.length);
      } catch {
        // A cancel or a timeout is fatal; anything else is just a bad batch, so the loop
        // retries once and then moves on rather than losing every other answer.
        if (signal?.aborted) throw new Error('Clue generation cancelled.');
        if (t.timedOut()) throw new Error('Clue generation timed out.');
      } finally {
        t.done();
      }
    }

    for (const { i, clue, reading } of items) {
      const e = batch[i - 1];
      if (!e) continue;
      const entry = out.get(e.word) || { clues: [], reading: '' };
      if (!entry.clues.includes(clue)) entry.clues.push(clue);
      if (!entry.reading && reading) entry.reading = reading;
      out.set(e.word, entry);
    }

    done += batch.length;
    onProgress?.({ done, total: list.length });
  }
  return out;
};

/**
 * Embed short texts with a local embedding model.
 *
 * Used to sanity-check generated clues: a model asked for a clue will occasionally write
 * a confidently wrong one (asked for ERNE it offered "Old British coin"; ERNE is a sea
 * eagle). The difficulty scorer cannot catch that — it rates difficulty, not truth — but
 * comparing a candidate against the answer's KNOWN clues does. Measured on a hand-labelled
 * sample: every correct clue scored >= 0.77 against the centroid of that answer's real
 * clues, every wrong one <= 0.64.
 */
export const embedTexts = async ({ baseUrl, model = 'qwen3-embedding:0.6b', texts, signal }) => {
  if (!texts?.length) return [];
  // The embedding model is small and the generation model is not, so they are commonly on
  // different machines: this setup runs a 27B over the tailnet and a 0.6B embedder
  // locally. Pointing both at the configured server meant every embedding call 404'd, so
  // the accuracy check and sense corroboration silently never ran. Try the configured
  // server, then localhost.
  const hosts = [...new Set([trimBase(baseUrl), 'http://localhost:11434'].filter(Boolean))];
  let last = null;
  for (const host of hosts) {
    const t = linkedTimeout(60000, signal);
    try {
      const res = await fetch(`${host}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
        signal: t.signal,
      });
      if (!res.ok) { last = new Error(`Embedding model responded ${res.status}.`); continue; }
      const data = await res.json();
      if (data.embeddings?.length) return data.embeddings;
      last = new Error('Embedding model returned nothing.');
    } catch (err) {
      if (signal?.aborted) throw err;
      last = err;
    } finally {
      t.done();
    }
  }
  throw last || new Error('No embedding model reachable.');
};

// ---------------------------------------------------------------------------
// Sense discovery
// ---------------------------------------------------------------------------

const SENSE_TIMEOUT_MS = 120000;

/**
 * Ask what an answer could mean, before asking for clues.
 *
 * Deliberately a separate call from clue writing. Asking for meanings AND clues in one
 * request is cheaper and measurably worse: GHAST came back with only a D&D specter and
 * lost the Minecraft mob entirely, RAZER lost the raze sense the corpus actually uses,
 * and DISCORD overran the token budget and failed to parse. Two small calls beat one big
 * one here.
 *
 * The model WILL invent senses for obscure answers — asked about RAZER it offered a
 * "Vampire character in D&D" — so nothing here is presented as fact. clueSource
 * corroborates each sense against the answer's published clues before the UI labels it.
 *
 * @returns {Promise<Array<{label:string, gloss:string, domain:string}>>}
 */
export const discoverSenses = async ({ baseUrl, model, word, known = [], signal, max = 4 }) => {
  const answer = (word || '').toUpperCase();
  if (!answer) return [];
  const mc = mixedContentWarning(baseUrl);
  if (mc) throw new Error(mc);

  const prompt = `You are a crossword editor deciding how an answer could be clued.

ANSWER: ${answer}
${known.length
    ? `It has been clued before as: ${known.slice(0, 6).map((c) => `"${c}"`).join(', ')}.`
    : 'It has never been clued before.'}

List the genuinely DISTINCT things this answer can REFER TO. Include proper nouns —
brands, video game characters or creatures, bands, films, places, people — not only
dictionary senses. A solver is as likely to meet the brand as the dictionary word.

Do NOT list facts ABOUT the string itself. "A valid Scrabble word", "a five-letter word",
"an anagram of X" are not meanings and must never appear.
Only list meanings you are confident really exist. One correct meaning is far better than
three with an invented one among them. At most ${max}.

For each give:
  "label"  2-4 words naming the sense, e.g. "Minecraft mob"
  "gloss"  one short sentence saying what it is
  "domain" the vocabulary a clue in that sense would draw on, comma separated

Reply with ONLY a JSON array. No prose, no code fences.`;

  const t = linkedTimeout(SENSE_TIMEOUT_MS, signal);
  try {
    const res = await fetch(`${trimBase(baseUrl)}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, prompt, stream: false, think: false,
        options: { temperature: 0.7, num_predict: 900 },
      }),
      signal: t.signal,
    });
    if (!res.ok) throw new Error(`Ollama responded ${res.status}. Check the model name.`);
    const data = await res.json();
    return parseSenses(data.response || '', max);
  } catch (err) {
    if (signal?.aborted) throw new Error('Sense lookup cancelled.');
    if (t.timedOut()) throw new Error('Sense lookup timed out.');
    throw new Error(err.message || 'Sense lookup failed.');
  } finally {
    t.done();
  }
};

/** Exported so the parsing can be tested without a server. */
export const parseSenses = (text, max = 4) => {
  if (!text) return [];
  const cleaned = String(text).replace(/^```(?:json)?|```$/gm, '').trim();
  const m = cleaned.match(/\[[\s\S]*\]/);
  if (!m) return [];
  let arr;
  try { arr = JSON.parse(m[0]); } catch { return []; }
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const label = typeof it.label === 'string' ? it.label.trim() : '';
    const gloss = typeof it.gloss === 'string' ? it.gloss.trim() : '';
    if (!label || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    out.push({
      label,
      gloss,
      domain: typeof it.domain === 'string' ? it.domain.trim() : '',
    });
    if (out.length >= max) break;
  }
  return out;
};
