// Client for a locally-hosted Ollama server (https://ollama.com).
// Used for AI clue assistance. All config lives in localStorage so it is
// per-device and never leaves the machine.
import { loadJSON, saveJSON } from './storage';

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
