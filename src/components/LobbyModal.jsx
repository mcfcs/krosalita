import React, { useState } from 'react';
import { X, Check, RefreshCw, Play } from './Icons.jsx';
import { getGuestId, getSavedName, saveName, colorFor } from '../multiplayer/identity.js';
import { createGame, joinGame } from '../multiplayer/client.js';

// Host a loaded puzzle or join by 5-digit code. Returns { game, me } on success.
const LobbyModal = ({ isOpen, onClose, puzzle, defaultMode = 'host', initialCode = '', authUser, onReady }) => {
  const [mode, setMode] = useState(defaultMode);
  const [name, setName] = useState(getSavedName() || authUser?.displayName || '');
  const [code, setCode] = useState(initialCode);
  const [gamemode, setGamemode] = useState('coop');
  const [spectator, setSpectator] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // The modal stays mounted while closed, so useState's initial values are the
  // props from MultiplayerView's FIRST render (mode 'host', empty code). Re-sync
  // the pane + prefilled code on each open. This is the documented "adjust state
  // when a prop changes" pattern: a render-phase update, so no flash of the wrong
  // pane, and `mode` stays plain state the tab buttons can still change by hand.
  const requested = isOpen ? `${defaultMode}:${initialCode}` : null;
  const [appliedRequest, setAppliedRequest] = useState(requested);
  if (requested !== appliedRequest) {
    setAppliedRequest(requested);
    if (isOpen) {
      setMode(defaultMode);
      setCode(initialCode);
      setError('');
    }
  }

  if (!isOpen) return null;

  const myId = authUser?.id || getGuestId();
  const myColor = colorFor(myId);

  const submit = async () => {
    setError('');
    if (!name.trim()) { setError('Enter a display name.'); return; }
    saveName(name.trim());
    setBusy(true);
    try {
      const me = { id: myId, name: name.trim(), color: myColor, isHost: mode === 'host', isSpectator: mode === 'join' && spectator };
      let game;
      if (mode === 'host') {
        if (!puzzle) { setError('Load, generate, or import a puzzle first.'); setBusy(false); return; }
        game = await createGame({ puzzle, hostId: myId, hostName: name.trim(), gamemode, color: myColor });
      } else {
        if (!/^\d{5}$/.test(code.trim())) { setError('Enter the 5-digit game code.'); setBusy(false); return; }
        game = await joinGame({ code: code.trim(), playerId: myId, name: name.trim(), color: myColor, isSpectator: spectator });
        me.isHost = game.host_id === myId;
      }
      onReady({ game, me });
    } catch (err) {
      setError(err.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[1200] bg-ink/45 backdrop-blur-[2px] flex items-center justify-center p-4" onClick={onClose}>
      <div className="panel w-full max-w-md p-6 animate-rise-in" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between mb-4">
          <h3 className="font-display text-2xl font-semibold text-ink">Multiplayer</h3>
          <button onClick={onClose} className="text-ink-faint hover:text-ink"><X size={20} /></button>
        </div>

        <div className="flex gap-1 mb-5 border-b-2 border-line">
          <button onClick={() => setMode('host')} className={`tab ${mode === 'host' ? 'tab-active' : ''}`}>Host a game</button>
          <button onClick={() => setMode('join')} className={`tab ${mode === 'join' ? 'tab-active' : ''}`}>Join by code</button>
        </div>

        <div className="space-y-4">
          <div>
            <div className="eyebrow mb-1.5">Display name</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" className="field" maxLength={24} />
          </div>

          {mode === 'host' ? (
            <>
              <div>
                <div className="eyebrow mb-1.5">Game mode</div>
                <div className="flex gap-2">
                  <button onClick={() => setGamemode('coop')} className={`btn btn-sm flex-1 ${gamemode === 'coop' ? 'btn-ink' : 'btn-ghost'}`}>Co-op solve</button>
                  <button onClick={() => setGamemode('points')} className={`btn btn-sm flex-1 ${gamemode === 'points' ? 'btn-ink' : 'btn-ghost'}`}>Points</button>
                </div>
              </div>
              <div className="text-xs text-ink-faint">
                {puzzle ? <>Hosting a <b>{puzzle.grid?.length}×{puzzle.grid?.[0]?.length}</b> puzzle{puzzle.meta?.title ? ` — “${puzzle.meta.title}”` : ''}.</> : <span className="text-wrong">No puzzle loaded. Generate/import one first (Browse, Generate, or Play).</span>}
              </div>
            </>
          ) : (
            <div className="space-y-3">
              <div>
                <div className="eyebrow mb-1.5">Game code</div>
                <input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 5))} placeholder="12345" inputMode="numeric" className="field font-mono text-2xl tracking-[0.4em] text-center" />
              </div>
              <label className="flex items-center gap-2.5 cursor-pointer select-none">
                <input type="checkbox" checked={spectator} onChange={(e) => setSpectator(e.target.checked)} className="w-4 h-4 accent-accent" />
                <span className="text-sm text-ink-soft">Join as <span className="font-semibold text-ink">spectator</span> (watch only)</span>
              </label>
            </div>
          )}

          {error && <div className="border-l-2 border-wrong bg-wrong/8 px-3 py-2 text-wrong text-sm">{error}</div>}

          <button onClick={submit} disabled={busy} className="btn btn-accent w-full">
            {busy ? <><RefreshCw size={16} className="animate-spin" />Working…</> : mode === 'host' ? <><Play size={14} />Create game</> : <><Check size={16} />Join game</>}
          </button>
        </div>
      </div>
    </div>
  );
};

export default LobbyModal;
