// Player identity for multiplayer. Guests get a stable ephemeral id in
// localStorage; a signed-in user's auth uid is used instead when available.
import { loadString, saveString } from '../utils/storage.js';

const uuid = () => (globalThis.crypto?.randomUUID?.() || `g${Date.now()}${Math.floor(Math.random() * 1e9)}`);

export function getGuestId() {
  let id = loadString('mpId', '');
  if (!id) { id = uuid(); saveString('mpId', id); }
  return id;
}

export function getSavedName() { return loadString('mpName', ''); }
export function saveName(name) { saveString('mpName', name || ''); }

const COLORS = ['#2b74e7', '#e4574c', '#1b9a55', '#b07c14', '#7c3aed', '#0891b2', '#db2777', '#65a30d'];
export function colorFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[h % COLORS.length];
}

// 5-digit lobby code.
export const makeCode = () => String(Math.floor(10000 + Math.random() * 90000));
