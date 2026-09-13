import React from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Delete } from './Icons';
import { renderRich } from '../utils/richText';

const ROW1 = ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'];
const ROW2 = ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'];
const ROW3 = ['Z', 'X', 'C', 'V', 'B', 'N', 'M'];

/**
 * Bottom-docked solve controls for touch devices: a current-clue bar (with
 * prev/next + direction toggle) and an NYT-style on-screen keyboard.
 * Hidden on large screens where a physical keyboard is expected (lg:hidden).
 */
const MobileSolveDock = ({ clueNumber, clueDirection, clueText, onPrev, onNext, onToggleDir, onKey, onBackspace }) => {
  const press = (fn) => (e) => { e.preventDefault(); fn(); };

  // Portal to <body> so the fixed dock anchors to the viewport, not to any
  // transformed ancestor (e.g. the animated PlayView container).
  return createPortal((
    <div className="solve-dock fixed inset-x-0 bottom-0 z-40 bg-paper/95 backdrop-blur border-t border-line shadow-[0_-8px_24px_-18px_rgba(26,26,26,0.5)]"
         style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {/* current clue bar */}
      <div className="flex items-stretch gap-2 px-2 pt-2">
        <button onPointerDown={press(onPrev)} className="w-11 shrink-0 flex items-center justify-center rounded-lg bg-paper-raised border border-line active:bg-word/60" aria-label="Previous clue">
          <ChevronLeft size={20} />
        </button>
        <button onPointerDown={press(onToggleDir)}
                className="flex-1 min-w-0 text-left rounded-lg bg-paper-sunken border border-line px-3 py-1.5 active:bg-word/60">
          <div className="eyebrow text-[0.58rem] leading-none mb-0.5">
            {clueNumber ? `${clueNumber} ${clueDirection === 'across' ? 'Across' : 'Down'}` : 'Tap a cell'}
          </div>
          <div className="text-sm text-ink leading-snug break-words line-clamp-2">{clueText ? renderRich(clueText) : '—'}</div>
        </button>
        <button onPointerDown={press(onNext)} className="w-11 shrink-0 flex items-center justify-center rounded-lg bg-paper-raised border border-line active:bg-word/60" aria-label="Next clue">
          <ChevronRight size={20} />
        </button>
      </div>

      {/* keyboard */}
      <div className="px-1.5 pt-2 pb-2 space-y-1.5 select-none">
        <div className="flex gap-1">
          {ROW1.map(k => <button key={k} onPointerDown={press(() => onKey(k))} className="kbd-key flex-1">{k}</button>)}
        </div>
        <div className="flex gap-1 px-3">
          {ROW2.map(k => <button key={k} onPointerDown={press(() => onKey(k))} className="kbd-key flex-1">{k}</button>)}
        </div>
        <div className="flex gap-1">
          <button onPointerDown={press(onToggleDir)} className="kbd-key kbd-key--wide" aria-label="Toggle direction">⇄</button>
          {ROW3.map(k => <button key={k} onPointerDown={press(() => onKey(k))} className="kbd-key flex-1">{k}</button>)}
          <button onPointerDown={press(onBackspace)} className="kbd-key kbd-key--wide" aria-label="Delete"><Delete size={20} /></button>
        </div>
      </div>
    </div>
  ), document.body);
};

export default MobileSolveDock;
