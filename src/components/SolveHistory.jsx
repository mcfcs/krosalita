import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Trophy, RefreshCw, Flame, Check } from './Icons';
import { listSolves, listLocalSolves, clearLocalSolves } from '../lib/solves.js';
import { supabaseEnabled } from '../lib/supabase.js';

const SOURCES = [
  { key: null, label: 'Everything' },
  { key: 'daily', label: 'Daily' },
  { key: 'generated', label: 'Generated' },
  { key: 'imported', label: 'Imported' },
  { key: 'shared', label: 'Shared' },
];

const SOURCE_TONE = {
  daily: 'text-gold',
  generated: 'text-inkblue',
  imported: 'text-ink-soft',
  shared: 'text-grass',
};

const mmss = (sec) => {
  if (sec == null) return '—';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const dayLabel = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
};

/**
 * Every crossword this device — and, once signed in, this account — has finished.
 *
 * Reads local storage first and paints immediately, then folds in the server rows when
 * they arrive. That ordering is the point: the log has to be useful signed out and
 * offline, so waiting on a network round trip before showing anything would be wrong.
 */
export default function SolveHistory({ authUser, onSignIn }) {
  const [rows, setRows] = useState(() => listLocalSolves({ limit: 500 }));
  const [source, setSource] = useState(null);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState('');

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await listSolves({ limit: 500 }));
    } catch {
      setRows(listLocalSolves({ limit: 500 }));
      setNote('Showing this device only — the server could not be reached.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh, authUser?.id]);

  const shown = useMemo(
    () => (source ? rows.filter((r) => r.source === source) : rows),
    [rows, source],
  );

  const stats = useMemo(() => {
    const timed = rows.filter((r) => typeof r.bestSeconds === 'number');
    const clean = rows.filter((r) => !r.usedHelp);
    return {
      total: rows.length,
      clean: clean.length,
      best: timed.length ? Math.min(...timed.map((r) => r.bestSeconds)) : null,
      dailies: rows.filter((r) => r.source === 'daily').length,
      replays: rows.reduce((a, r) => a + Math.max(0, (r.count || 1) - 1), 0),
    };
  }, [rows]);

  return (
    <div className="animate-rise-in space-y-5">
      <div className="panel panel-pad">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <div className="eyebrow flex items-center gap-1.5"><Trophy size={13} className="text-gold" />Solve history</div>
            <h2 className="font-display text-3xl font-semibold text-ink">Crosswords you&apos;ve finished</h2>
          </div>
          <button onClick={refresh} disabled={loading} className="btn btn-sm">
            <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />Refresh
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-5">
          {[
            { label: 'Solved', value: stats.total },
            { label: 'Without help', value: stats.clean },
            { label: 'Best time', value: mmss(stats.best) },
            { label: 'Dailies', value: stats.dailies },
          ].map((s) => (
            <div key={s.label} className="bg-paper-sunken border border-line rounded-sm px-3 py-2.5">
              <div className="font-mono text-2xl font-semibold text-ink tabular-nums">{s.value}</div>
              <div className="eyebrow text-[0.58rem] mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>

        {!authUser && supabaseEnabled && (
          <p className="mt-4 text-xs text-ink-faint">
            Saved on this device.{' '}
            <button onClick={onSignIn} className="underline hover:text-ink">Sign in</button>
            {' '}to keep your history across devices — nothing already recorded is lost.
          </p>
        )}
        {note && <p className="mt-3 text-xs text-accent">{note}</p>}
      </div>

      <div className="panel">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-line flex-wrap">
          {SOURCES.map((s) => (
            <button
              key={s.label}
              onClick={() => setSource(s.key)}
              className={`px-2.5 py-1 rounded-sm border text-[11px] font-bold uppercase tracking-wide transition ${
                source === s.key ? 'border-ink bg-ink text-paper-raised' : 'border-ink/25 text-ink-soft hover:bg-ink/5'
              }`}
            >
              {s.label}
            </button>
          ))}
          <span className="grow" />
          <span className="text-[11px] text-ink-faint tabular-nums">{shown.length} shown</span>
        </div>

        {shown.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-ink-faint">
            {rows.length === 0
              ? 'Nothing finished yet. Solve a puzzle and it will appear here.'
              : 'No solves of that kind yet.'}
          </p>
        ) : (
          <ul className="max-h-[32rem] overflow-auto">
            {shown.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 border-b border-line last:border-0">
                <span className={`eyebrow text-[0.55rem] w-16 shrink-0 ${SOURCE_TONE[r.source] || 'text-ink-faint'}`}>
                  {r.source}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-ink truncate">
                    {r.title || (r.source === 'daily' ? `Daily · ${r.day}` : 'Untitled puzzle')}
                    {!r.usedHelp && <Check size={12} className="inline ml-1.5 text-grass" aria-label="solved without help" />}
                    {(r.count || 1) > 1 && (
                      <span className="ml-1.5 text-[11px] text-ink-faint">×{r.count}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-ink-faint">
                    {dayLabel(r.solvedAt)}
                    {r.rows && r.cols ? ` · ${r.rows}×${r.cols}` : ''}
                    {r.difficultyLabel ? ` · ${r.difficultyLabel}` : ''}
                  </div>
                </div>
                <span className="font-mono text-sm text-ink-soft tabular-nums shrink-0">{mmss(r.bestSeconds)}</span>
              </li>
            ))}
          </ul>
        )}

        {rows.length > 0 && (
          <div className="px-4 py-2.5 border-t border-line flex items-center gap-2 flex-wrap">
            <Flame size={13} className="text-gold" />
            <span className="text-[11px] text-ink-faint">
              {stats.replays > 0
                ? `${stats.replays} re-solve${stats.replays === 1 ? '' : 's'} — the time shown is your best.`
                : 'The time shown is your best for each puzzle.'}
            </span>
            <span className="grow" />
            <button
              onClick={() => {
                if (!window.confirm('Clear the solve history stored on this device? Anything already synced to your account stays there.')) return;
                clearLocalSolves();
                refresh();
              }}
              className="text-[11px] text-ink-faint underline hover:text-accent"
            >
              Clear this device
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
