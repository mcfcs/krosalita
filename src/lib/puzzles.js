// CRUD for a signed-in user's saved puzzles (RLS-guarded server-side).
import { supabase } from './supabase.js';

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
  const { data, error } = await supabase.from('puzzles').select('*').order('created_at', { ascending: false });
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
