// CRUD for a signed-in user's saved puzzles (RLS-guarded server-side), plus the
// share-code publish/lookup flow added in 0003_solves_and_share_codes.sql.
import { supabase } from './supabase.js';
import { generateShareCode, normalizeCode, formatCode } from './shareCode.js';

export async function savePuzzle({ title, data, isPublic = false }) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data: sess } = await supabase.auth.getUser();
  const user = sess?.user;
  if (!user) throw new Error('Sign in to save puzzles.');
  const { data: row, error } = await supabase
    .from('puzzles')
    .insert({ owner_id: user.id, title: title || 'Untitled', data, is_public: isPublic })
    .select()
    .single();
  if (error) throw error;
  return row;
}

export async function listMyPuzzles() {
  if (!supabase) return [];
  // 0003 narrowed puzzles_read to owner-only, so RLS already scopes this. The
  // explicit filter is belt-and-braces and makes the intent readable at the call
  // site — "my puzzles" should never have depended on a policy to mean "mine".
  const { data: sess } = await supabase.auth.getUser();
  const user = sess?.user;
  if (!user) return [];
  const { data, error } = await supabase
    .from('puzzles').select('*').eq('owner_id', user.id)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

export async function deletePuzzle(id) {
  if (!supabase) return;
  const { error } = await supabase.from('puzzles').delete().eq('id', id);
  if (error) throw error;
}

export async function setPuzzlePublic(id, isPublic) {
  if (!supabase) return;
  const { error } = await supabase.from('puzzles').update({ is_public: isPublic }).eq('id', id);
  if (error) throw error;
}

// ---------------------------------------------------------------------------
// Share codes
// ---------------------------------------------------------------------------

/**
 * Assign a share code to one of the caller's puzzles and return it.
 *
 * Idempotent: a puzzle that already has a code keeps it, so the same link can be
 * handed out twice. Collisions are resolved inside claim_share_code() — the client
 * offers a candidate, and on unique_violation the database retries with its own
 * until it wins, so there is no read-then-write race here.
 *
 * @returns {{ id, code, formatted }} code is canonical (KR7F2Q9X), formatted is KR7F-2Q9X
 */
export async function publishPuzzle(id) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data: sess } = await supabase.auth.getUser();
  if (!sess?.user) throw new Error('Sign in to share puzzles.');
  if (!id) throw new Error('No puzzle to share.');

  const { data, error } = await supabase.rpc('claim_share_code', {
    p_puzzle: id,
    p_code: generateShareCode(),
  });
  if (error) {
    if (error.code === '42501') throw new Error('That puzzle is not yours to share.');
    throw error;
  }
  const code = normalizeCode(data);
  if (!code) throw new Error('The server returned an unusable share code.');
  return { id, code, formatted: formatCode(code) };
}

/** Revoke a puzzle's share code. Anyone holding the old code stops being able to open it. */
export async function unpublishPuzzle(id) {
  if (!supabase) return;
  const { error } = await supabase
    .from('puzzles')
    .update({ share_code: null, shared_at: null })
    .eq('id', id);
  if (error) throw error;
}

/**
 * Look up a shared puzzle by its code. Works signed-out — that is the entire point
 * of the code. Goes through the get_puzzle_by_code RPC rather than a table select,
 * because a select-by-code would require the puzzles table to be anon-readable,
 * which would let anyone list every code. See the reasoning block in
 * supabase/migrations/0003_solves_and_share_codes.sql.
 *
 * @returns the puzzle row { id, title, data, share_code, created_at, shared_at, author }
 * @throws  Error with .notFound === true when no puzzle carries that code
 */
export async function fetchByCode(input) {
  const code = normalizeCode(input);
  if (!code) {
    const e = new Error('That does not look like a share code — they are 8 characters, like KR7F-2Q9X.');
    e.invalid = true;
    throw e;
  }
  if (!supabase) throw new Error('Supabase is not configured.');

  const { data, error } = await supabase.rpc('get_puzzle_by_code', { p_code: code });
  if (error) throw error;

  const row = Array.isArray(data) ? data[0] : data;
  if (!row) {
    const e = new Error(`No puzzle found for ${formatCode(code)}. Check the code and try again.`);
    e.notFound = true;
    throw e;
  }
  return row;
}
