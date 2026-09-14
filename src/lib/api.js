// Thin client for the in-repo crosswithfriends proxy (Vercel serverless /api/cwf/*).
//
// Every response goes through readJson(). A static host with no serverless runtime answers
// /api/cwf/* with the SPA fallback — index.html, status 200 — so `res.ok` is true and
// res.json() throws `Unexpected token '<', "<!doctype "...`, which tells the user nothing
// about what is actually wrong. Name the real problem instead.
async function readJson(res, what) {
  const body = await res.text();
  const looksHtml = /^\s*<(!doctype|html)/i.test(body);
  if (looksHtml) {
    const e = new Error(
      `The Crosswithfriends proxy isn't running here, so ${what} can't work. `
      + 'It needs the /api/cwf functions — use `npm run dev`, `start.bat dev`, or the deployed site.',
    );
    e.noBackend = true;
    throw e;
  }
  try {
    return body ? JSON.parse(body) : {};
  } catch {
    const e = new Error(`The puzzle source sent something unreadable (${res.status}).`);
    e.badResponse = true;
    throw e;
  }
}

export async function searchCwf({ q = '', page = 0, standard = true, mini = true } = {}) {
  const params = new URLSearchParams({
    q, page: String(page), standard: String(standard), mini: String(mini),
  });
  const res = await fetch(`/api/cwf/search?${params.toString()}`);
  const data = await readJson(res, 'Browse');
  if (!res.ok) throw new Error(data.message || `Search failed (${res.status})`);
  return data.puzzles || [];
}

export async function fetchCwfPuzzle(pid) {
  const res = await fetch(`/api/cwf/puzzle?pid=${encodeURIComponent(pid)}`);
  const data = await readJson(res, 'importing a puzzle');
  if (res.status === 503) {
    const e = new Error(data.message || 'The puzzle source is waking up — try again.');
    e.retryable = true;
    throw e;
  }
  if (!res.ok) throw new Error(data.message || `Couldn't load puzzle (${res.status})`);
  return data; // { meta, version, layout, grid, clues }
}
