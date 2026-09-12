import React, { useState } from 'react';
import { X, Zap, Check, RefreshCw, Edit3 } from './Icons';
import { renderRich } from '../utils/richText';
import { BANDS } from '../utils/clueSource';

const BAND_ORDER = ['easy', 'medium', 'hard'];

const bandClass = (band) => (
  band === 'easy' ? 'text-inkblue' : band === 'medium' ? 'text-gold' : 'text-accent'
);

/**
 * Pick a clue for one answer at a chosen difficulty.
 *
 * Candidates come from the corpus first and only then from the model, and every one shows
 * the difficulty the local scorer predicts for it — the model's own sense of "easy" is
 * unreliable enough that showing an unverified label would be worse than showing none.
 * Nothing is applied until the author picks it.
 */
export default function ClueStudio({
  word,
  currentClue,
  band,
  onBandChange,
  candidates,
  range,
  loading,
  generating,
  error,
  aiEnabled,
  onGenerate,
  onAccept,
  onClose,
}) {
  const [editing, setEditing] = useState(null);
  const [draft, setDraft] = useState('');

  const inBand = candidates.filter((c) => c.inBand);
  const others = candidates.filter((c) => !c.inBand);
  const win = BANDS[band];

  // The answer, not the clue, sets most of the difficulty: 64% of answers have never had
  // an Easy clue published. Saying so up front stops "make this easy" looking broken.
  const outOfReach = range && (range.max < win.min || range.min >= win.max);

  const accept = (clue) => { onAccept(clue); setEditing(null); };

  const row = (c, i) => (
    <li key={`${c.source}-${i}-${c.clue}`} className="border-b border-line last:border-0">
      {editing === c.clue ? (
        <div className="p-2 flex gap-2">
          <input
            className="field flex-1 text-sm"
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') accept(draft);
              if (e.key === 'Escape') setEditing(null);
            }}
          />
          <button onClick={() => accept(draft)} className="btn btn-sm btn-accent"><Check size={13} />Use</button>
          <button onClick={() => setEditing(null)} className="btn btn-sm btn-ghost">Cancel</button>
        </div>
      ) : (
        <div className="flex items-start gap-2 p-2 group">
          <span
            className={`font-mono text-[11px] font-bold w-8 shrink-0 pt-0.5 ${bandClass(c.band)}`}
            title={`predicted difficulty: ${Math.round(c.percentile)} of 100`}
          >
            {Math.round(c.percentile)}
          </span>
          <button
            onClick={() => accept(c.clue)}
            className="flex-1 text-left text-sm text-ink hover:text-accent leading-snug"
          >
            {renderRich(c.clue)}
            {c.source === 'corpus' && (
              <span className="ml-1.5 eyebrow text-[0.55rem] text-ink-faint">published</span>
            )}
            {c.suspect && (
              <span
                className="ml-1.5 eyebrow text-[0.55rem] text-accent"
                title="This reads unlike any published clue for this answer — check it is actually true."
              >
                check accuracy
              </span>
            )}
          </button>
          <button
            onClick={() => { setEditing(c.clue); setDraft(c.clue); }}
            className="opacity-0 group-hover:opacity-100 text-ink-faint hover:text-ink shrink-0 pt-0.5"
            title="Edit before using"
          >
            <Edit3 size={13} />
          </button>
        </div>
      )}
    </li>
  );

  return (
    <div className="mt-3 border border-ink/20 bg-paper-sunken rounded-sm">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line">
        <span className="eyebrow">Clues for</span>
        <span className="font-mono font-bold text-ink">{word}</span>
        <span className="grow" />
        <button onClick={onClose} className="text-ink-faint hover:text-ink" title="Close"><X size={15} /></button>
      </div>

      <div className="px-3 py-2 flex items-center gap-2 flex-wrap border-b border-line">
        {BAND_ORDER.map((b) => (
          <button
            key={b}
            onClick={() => onBandChange(b)}
            className={`px-2.5 py-1 rounded-sm border text-[11px] font-bold uppercase tracking-wide transition ${
              band === b ? 'border-ink bg-ink text-paper-raised' : 'border-ink/25 text-ink-soft hover:bg-ink/5'
            }`}
          >
            {BANDS[b].label}
          </button>
        ))}
        <span className="grow" />
        {aiEnabled && (
          <button onClick={onGenerate} disabled={generating} className="btn btn-sm btn-ghost">
            {generating ? <RefreshCw size={13} className="animate-spin" /> : <Zap size={13} />}
            {generating ? 'Writing…' : 'Write more'}
          </button>
        )}
      </div>

      {currentClue && (
        <div className="px-3 py-2 text-xs text-ink-faint border-b border-line">
          <span className="eyebrow mr-1.5">Now</span>{renderRich(currentClue)}
        </div>
      )}

      {outOfReach && (
        <p className="px-3 py-2 text-xs text-accent border-b border-line">
          No published clue for {word} is {win.label.toLowerCase()} — its clues run{' '}
          {Math.round(range.min)}–{Math.round(range.max)} of 100. The answer itself sets most of
          the difficulty, so a {win.label.toLowerCase()} clue may not exist.
        </p>
      )}

      {error && <p className="px-3 py-2 text-xs text-accent border-b border-line">{error}</p>}

      {loading ? (
        <p className="px-3 py-4 text-xs text-ink-faint">Loading clues…</p>
      ) : (
        <>
          <ul className="max-h-64 overflow-auto">{inBand.map(row)}</ul>
          {!inBand.length && !generating && (
            <p className="px-3 py-3 text-xs text-ink-faint">
              Nothing in this band yet.{aiEnabled ? ' Try “Write more”.' : ' Turn on AI to write some.'}
            </p>
          )}
          {others.length > 0 && (
            <details className="border-t border-line">
              <summary className="px-3 py-1.5 text-[11px] text-ink-faint cursor-pointer select-none">
                {others.length} outside this band
              </summary>
              <ul>{others.map(row)}</ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}
