import React from 'react';
import { Share, Play, X, Trophy } from './Icons';

// Celebration card shown when a puzzle is solved.
const ResultModal = ({ open, timeText, clean, difficulty, onClose, onShare, onPlayAgain }) => {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[1300] bg-ink/55 backdrop-blur-[2px] flex items-center justify-center p-4">
      <div className="panel w-full max-w-sm p-7 text-center animate-rise-in relative">
        <button onClick={onClose} aria-label="Close" className="absolute top-1.5 right-1.5 p-2.5 text-ink-faint hover:text-ink"><X size={18} /></button>
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-accent/10 text-accent mb-3"><Trophy size={32} /></div>
        <h3 className="font-display text-3xl font-semibold text-ink mb-1">Solved!</h3>
        {clean
          ? <div className="text-correct font-semibold text-sm mb-1">★ Clean solve — no help used</div>
          : <div className="text-ink-faint text-sm mb-1">Nicely done</div>}

        <div className="my-5 flex items-center justify-center gap-8">
          <div>
            <div className="eyebrow">Time</div>
            <div className="font-mono text-3xl font-medium text-ink tabular-nums">{timeText}</div>
          </div>
          {difficulty ? (
            <div>
              <div className="eyebrow">Difficulty</div>
              <div className="font-display text-2xl font-semibold text-ink">{difficulty}</div>
            </div>
          ) : null}
        </div>

        <div className="flex gap-3">
          {onShare && <button onClick={onShare} className="btn btn-accent flex-1"><Share size={15} />Share</button>}
          {onPlayAgain && <button onClick={onPlayAgain} className="btn flex-1"><Play size={13} />New puzzle</button>}
        </div>
      </div>
    </div>
  );
};

export default ResultModal;
