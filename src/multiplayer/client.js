// Supabase-backed multiplayer transport: game lifecycle (create/join) via
// Postgres, live sync via a Realtime channel (broadcast + presence).
import { supabase } from '../lib/supabase.js';
import { makeCode } from './identity.js';

const blankFrom = (answersGrid) =>
  answersGrid.map((row) => row.map((cell) => (cell === '#' ? '#' : '')));

// Create a lobby seeded with a puzzle (canonical { grid(answers), clues, layout }).
export async function createGame({ puzzle, hostId, hostName, gamemode = 'coop', color }) {
  if (!supabase) throw new Error('Supabase is not configured.');
  let game = null;
  for (let attempt = 0; attempt < 6 && !game; attempt++) {
    const code = makeCode();
    const { data, error } = await supabase
      .from('games')
      .insert({
        code,
        host_id: hostId,
        puzzle,
        gamemode,
        state: { grid: blankFrom(puzzle.grid) },
        status: 'playing',
      })
      .select()
      .single();
    if (!error) { game = data; break; }
    if (error.code !== '23505') throw error; // 23505 = unique_violation on code → retry
  }
  if (!game) throw new Error('Could not allocate a game code, try again.');
  await supabase.from('game_players').insert({
    game_id: game.id, player_id: hostId, display_name: hostName, color, is_host: true,
  });
  return game;
}

export async function joinGame({ code, playerId, name, color, isSpectator = false }) {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data: game, error } = await supabase.from('games').select('*').eq('code', String(code).trim()).maybeSingle();
  if (error) throw error;
  if (!game) throw new Error('No game found for that code.');
  await supabase.from('game_players').upsert(
    { game_id: game.id, player_id: playerId, display_name: name, color, is_host: game.host_id === playerId, is_spectator: isSpectator },
    { onConflict: 'game_id,player_id' },
  );
  return game;
}

export async function loadPlayers(gameId) {
  if (!supabase) return [];
  const { data } = await supabase.from('game_players').select('*').eq('game_id', gameId);
  return data || [];
}

// Durable low-frequency writes (host).
export async function persistState(gameId, state) {
  if (!supabase) return;
  await supabase.from('games').update({ state }).eq('id', gameId);
}
// Re-read the authoritative board so a (re)joining/reconnecting client can
// reconcile any broadcasts it missed while disconnected.
export async function loadState(gameId) {
  if (!supabase) return null;
  const { data } = await supabase.from('games').select('state').eq('id', gameId).maybeSingle();
  return data?.state || null;
}
export async function updateGameFields(gameId, patch) {
  if (!supabase) return;
  await supabase.from('games').update(patch).eq('id', gameId);
}
export async function addScore(gameId, playerId, delta) {
  if (!supabase || !delta) return;
  await supabase.rpc('increment_score', { p_game: gameId, p_player: playerId, p_delta: delta });
}
export async function addFills(gameId, playerId, delta) {
  if (!supabase || !delta) return;
  await supabase.rpc('increment_fills', { p_game: gameId, p_player: playerId, p_delta: delta });
}
export async function resetPlayers(gameId) {
  if (!supabase) return;
  await supabase.rpc('reset_game_players', { p_game: gameId });
}

// ---- chat ----
export async function sendChatRow(gameId, { playerId, name, color, text }) {
  if (!supabase) return;
  await supabase.from('game_chat').insert({ game_id: gameId, player_id: playerId, name, color, text });
}
export async function loadChat(gameId) {
  if (!supabase) return [];
  const { data } = await supabase.from('game_chat').select('*').eq('game_id', gameId).order('created_at', { ascending: true }).limit(50);
  return data || [];
}

// ---- host moderation ----
export async function kickPlayer(gameId, playerId) {
  if (!supabase) return;
  await supabase.from('game_players').delete().eq('game_id', gameId).eq('player_id', playerId);
}
export async function setHost(gameId, newHostId) {
  if (!supabase) return;
  await supabase.from('games').update({ host_id: newHostId }).eq('id', gameId);
  await supabase.from('game_players').update({ is_host: false }).eq('game_id', gameId);
  await supabase.from('game_players').update({ is_host: true }).eq('game_id', gameId).eq('player_id', newHostId);
}

// A Realtime channel for a game: broadcast (cell edits, host actions) + presence (roster/cursors).
export function openChannel(gameId, playerKey) {
  if (!supabase) return null;
  return supabase.channel(`game:${gameId}`, {
    config: { broadcast: { self: false }, presence: { key: playerKey } },
  });
}
