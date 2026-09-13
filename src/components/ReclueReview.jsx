import React from 'react';
import { X, Check, RefreshCw } from './Icons';
import { renderRich } from '../utils/richText';
import { BANDS } from '../utils/clueSource';

const BAND_ORDER = ['easy', 'medium', 'hard'];

// How each outcome is described to the author. "unreachable" is a real answer, not a
// failure: 64% of answers have never had an Easy clue published, because the answer
// itself carries most of the difficulty.
const STATUS = {
  corpus: { label: 'published clue', tone: 'text-inkblue' },
  generated: { label: 'written', tone: 'text-grass' },
  already: { label: 'already right', tone: 'text-ink-faint' },
  missed: { label: 'closest available', tone: 'text-gold' },
  unreachable: { label: "answer can't go there", tone: 'text-ink-faint' },
  failed: { label: 'nothing found', tone: 'text-accent' },
};

/**
 * Review a whole-puzzle re-clue before anything is applied.
 *
 * Deliberately not automatic: a third of the proposals are swapped-in published clues and
 * safe, but the generated ones are occasionally wrong in ways no score can detect, so the
 * author sees every change with its predicted difficulty and decides.
 */
export default function ReclueReview({
  band, onBandChange, running, progress, result, error, selected, onToggle,
  onRun, onApply, onClose, aiEnabled,
}) {
  const rows = result?.results || [];
  const s = result?.summary;
  const changed = rows.filter((r) => r.chosen);
  const nSelected = changed.filter((r) => selected.has(r.key)).length;

  return (
    <div className="mt-4 border border-ink/20 bg-paper-sunken rounded-sm">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line flex-wrap">
        <span className="eyebrow">Re-clue this puzzle</span>
        <span className="grow" />
        {BAND_ORDER.map((b) => (
          <button
            key={b}
            onClick={() => onBandChange(b)}
            disabled={running}
            className={`px-2.5 py-1 rounded-sm border text-[11px] font-bold uppercase tracking-wide transition ${
              band === b ? 'border-ink bg-ink text-paper-raised' : 'border-ink/25 text-ink-soft hover:bg-ink/5'
            }`}
          >
            {BANDS[b].label}
          </button>
        ))}
        <button onClick={onRun} disabled={running} className="btn btn-sm btn-accent">
          {running ? <RefreshCw size={13} className="animate-spin" /> : <Check size={13} />}
          {running ? 'Working…' : 'Find clues'}
        </button>
        <button onClick={onClose} className="text-ink-faint hover:text-ink ml-1" title="Close"><X size={15} /></button>
      </div>

      {!aiEnabled && (
        <p className="px-3 py-2 text-xs text-ink-faint border-b border-line">
          AI is off, so only clues already published for these answers can be offered.
        </p>
      )}

      {running && (
        <p className="px-3 py-2 text-xs text-ink-faint border-b border-line">
          {progress?.phase === 'generate'
            ? `Writing clues… ${progress.done}/${progress.total}`
            : 'Checking published clues…'}
        </p>
      )}

      {error && <p className="px-3 py-2 text-xs text-accent border-b border-line">{error}</p>}

      {s && (
        <div className="px-3 py-2 text-xs text-ink-soft border-b border-line">
          <b>{s.corpus}</b> from published clues · <b>{s.generated}</b> written ·{' '}
          <b>{s.already}</b> already in band
          {s.missed > 0 && <> · <b>{s.missed}</b> closest available</>}
          {s.unreachable > 0 && (
            <> · <b>{s.unreachable}</b> whose answer can&apos;t reach {BANDS[band].label.toLowerCase()}</>
          )}
          {s.failed > 0 && <> · <b>{s.failed}</b> with nothing</>}
        </div>
      )}

      {rows.length > 0 && (
        <ul className="max-h-80 overflow-auto">
          {rows.filter((r) => r.chosen).map((r) => {
            const st = STATUS[r.status] || STATUS.missed;
            return (
              <li key={r.key} className="flex items-start gap-2 px-3 py-2 border-b border-line last:border-0">
                <input
                  type="checkbox"
                  className="mt-1 shrink-0"
                  checked={selected.has(r.key)}
                  onChange={() => onToggle(r.key)}
                />
                <span className="font-mono text-[11px] font-bold w-8 shrink-0 pt-0.5 text-ink-soft">
                  {Math.round(r.chosen.percentile)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-ink leading-snug">
                    <span className="font-mono font-bold mr-1.5">{r.number}{r.direction === 'across' ? 'A' : 'D'}</span>
                    {renderRich(r.chosen.clue)}
                    {r.chosen.suspect && (
                      <span className="ml-1.5 eyebrow text-[0.55rem] text-accent" title="Reads unlike any published clue for this answer — check it is true.">check accuracy</span>
                    )}
                  </div>
                  {r.current?.clue && (
                    <div className="text-[11px] text-ink-faint line-through truncate">{renderRich(r.current.clue)}</div>
                  )}
                </div>
                <span className={`eyebrow text-[0.55rem] shrink-0 pt-1 ${st.tone}`}>{st.label}</span>
              </li>
            );
          })}
        </ul>
      )}

      {changed.length > 0 && (
        <div className="px-3 py-2 flex items-center gap-2 border-t border-line">
          <button onClick={onApply} disabled={!nSelected} className="btn btn-sm btn-accent">
            <Check size={13} />Apply {nSelected} {nSelected === 1 ? 'clue' : 'clues'}
          </button>
          <span className="text-[11px] text-ink-faint">
            {changed.length > nSelected
              ? `${changed.length - nSelected} left unticked because they miss the band — tick to use anyway.`
              : 'Nothing changes until you apply.'}
          </span>
        </div>
      )}

      {result && !changed.length && !running && (
        <p className="px-3 py-3 text-xs text-ink-faint">
          Nothing to change — every answer is already in this band, or its answer can&apos;t reach it.
        </p>
      )}
    </div>
  );
}
