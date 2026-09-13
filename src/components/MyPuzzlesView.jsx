import React, { useState, useEffect, useCallback } from 'react';
import { Play, PenTool, Trash2, RefreshCw, Share, Check, X } from './Icons';
import { supabaseEnabled } from '../lib/supabase.js';
import { listMyPuzzles, deletePuzzle, setPuzzlePublic, publishPuzzle, unpublishPuzzle } from '../lib/puzzles.js';
import { formatCode } from '../lib/shareCode.js';
import { solvedIndex, puzzleId } from '../lib/solves.js';

// A signed-in user's saved crosswords. Guests see a sign-in prompt.
const MyPuzzlesView = ({ authUser, onSignIn, onPlay, onEdit, onHost }) => {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busyId, setBusyId] = useState(null);
  const [copied, setCopied] = useState(null);

  const load = useCallback(async () => {
    if (!authUser) return;
    setLoading(true); setError('');
    try { setRows(await listMyPuzzles()); }
    catch (err) { setError(err.message || 'Could not load puzzles.'); }
    finally { setLoading(false); }
  }, [authUser]);

  useEffect(() => { load(); }, [load]);

  if (!supabaseEnabled) {
    return (
      <div className="panel p-10 text-center animate-rise-in">
        <h3 className="font-display text-2xl font-semibold text-ink mb-2">Saved puzzles need Supabase</h3>
        <p className="text-ink-faint max-w-md mx-auto text-sm">Configure <code className="chip">VITE_SUPABASE_URL</code> / <code className="chip">VITE_SUPABASE_ANON_KEY</code> to enable accounts.</p>
      </div>
    );
  }

  if (!authUser) {
    return (
      <div className="panel p-10 text-center animate-rise-in">
        <h3 className="font-display text-2xl font-semibold text-ink mb-2">Your puzzle library</h3>
        <p className="text-ink-faint mb-6 max-w-md mx-auto text-sm">Sign in to save crosswords you create and pick them up on any device.</p>
        <button onClick={onSignIn} className="btn btn-accent">Sign in</button>
      </div>
    );
  }

  const remove = async (id) => { await deletePuzzle(id); setRows((r) => r.filter((x) => x.id !== id)); };
  const togglePublic = async (row) => { await setPuzzlePublic(row.id, !row.is_public); setRows((r) => r.map((x) => (x.id === row.id ? { ...x, is_public: !x.is_public } : x))); };

  // A share code is a capability, not a listing: anyone holding it can open the puzzle,
  // and revoking it closes that door. Deliberately separate from "make public".
  const share = async (row) => {
    setBusyId(row.id); setError('');
    try {
      const { code } = await publishPuzzle(row.id);
      setRows((r) => r.map((x) => (x.id === row.id ? { ...x, share_code: code } : x)));
    } catch (err) { setError(err.message || 'Could not share that puzzle.'); }
    finally { setBusyId(null); }
  };
  const unshare = async (row) => {
    if (!window.confirm('Revoke this code? Anyone who already has it will stop being able to open the puzzle.')) return;
    setBusyId(row.id); setError('');
    try {
      await unpublishPuzzle(row.id);
      setRows((r) => r.map((x) => (x.id === row.id ? { ...x, share_code: null } : x)));
    } catch (err) { setError(err.message || 'Could not revoke that code.'); }
    finally { setBusyId(null); }
  };
  const copy = async (row) => {
    try {
      await navigator.clipboard.writeText(formatCode(row.share_code));
      setCopied(row.id);
      setTimeout(() => setCopied((c) => (c === row.id ? null : c)), 2000);
    } catch { /* clipboard blocked; the code is on screen to read */ }
  };


  // Which of these the player has already finished, so the list can say so. Cheap enough
  // to rebuild each render — it is a Map over at most 750 local records.
  const solved = solvedIndex();

  return (
    <div className="animate-rise-in">
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-display text-2xl font-semibold text-ink">My Puzzles</h2>
        <button onClick={load} className="btn btn-sm btn-ghost"><RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Refresh</button>
      </div>
      {error && <div className="mb-4 border-l-2 border-wrong bg-wrong/8 px-4 py-3 text-wrong text-sm">{error}</div>}
      {rows.length === 0 && !loading && <div className="panel p-8 text-center text-ink-faint text-sm">No saved puzzles yet. Build one in Create and hit “Save”.</div>}
      {rows.length > 0 && (
        <div className="panel divide-y divide-line overflow-hidden">
          {rows.map((row) => (
            <div key={row.id} className="flex items-center gap-3 px-4 py-3 hover:bg-ink/[0.03] transition">
              <div className="min-w-0 flex-1">
                <div className="font-display font-semibold text-ink truncate">{row.title || 'Untitled'}</div>
                <div className="text-ink-faint text-xs flex items-center gap-1.5 flex-wrap">
                  <span>{new Date(row.created_at).toLocaleDateString()}</span>
                  {row.is_public && <span className="chip">public</span>}
                  {solved.has(puzzleId({ remoteId: row.id })) && (
                    <span className="chip inline-flex items-center gap-1 text-grass"><Check size={11} />solved</span>
                  )}
                  {row.share_code && (
                    <button
                      onClick={() => copy(row)}
                      title="Copy this puzzle's code"
                      className="font-mono tracking-wider text-ink-soft underline decoration-dotted hover:text-ink"
                    >
                      {copied === row.id ? 'copied!' : formatCode(row.share_code)}
                    </button>
                  )}
                </div>
              </div>
              <button onClick={() => onPlay?.(row.data, row)} className="btn btn-sm btn-accent"><Play size={13} />Play</button>
              <button onClick={() => onEdit?.(row.data)} className="btn btn-sm hidden sm:inline-flex"><PenTool size={13} />Edit</button>
              <button onClick={() => onHost?.(row.data)} className="btn btn-sm btn-ghost hidden sm:inline-flex">Host</button>
              {row.share_code ? (
                <button onClick={() => unshare(row)} disabled={busyId === row.id} className="btn btn-sm btn-ghost hidden sm:inline-flex" title="Revoke the share code"><X size={13} />Unshare</button>
              ) : (
                <button onClick={() => share(row)} disabled={busyId === row.id} className="btn btn-sm hidden sm:inline-flex" title="Get a code others can type in to play this">
                  {busyId === row.id ? <RefreshCw size={13} className="animate-spin" /> : <Share size={13} />}Share
                </button>
              )}
              <button onClick={() => togglePublic(row)} className="btn btn-sm btn-ghost hidden md:inline-flex">{row.is_public ? 'Make private' : 'Make public'}</button>
              <button onClick={() => remove(row.id)} className="text-ink-faint hover:text-wrong p-1.5"><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default MyPuzzlesView;
