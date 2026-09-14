import React, { useEffect, useRef } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Trophy, Maximize } from './Icons';
import MobileSolveDock from './MobileSolveDock';
import CrosswordGrid from './CrosswordGrid';
import { renderRich } from '../utils/richText';
import { keepClearOfDock } from '../utils/keepClearOfDock';
import { difficultyColorClass } from '../utils/difficulty';

const PlayView = ({
  playGrid,
  playClues,
  playDirection,
  playSelectedCell,
  playAnswers,
  playComplete,
  playTimer,
  playAutoCheck,
  revealedCells,
  setPlayAutoCheck,
  revealCell,
  revealWord,
  revealAll,
  handlePlayCellClick,
  getNumberForCell,
  getPlayCurrentSlot,
  setPlaySelectedCell,
  setPlayDirection,
  formatTime,
  difficultyInfo,
  onVirtualKey = () => {},
  goToAdjacentClue = () => {},
  canControl = true,
  remoteCells = {},
  paused = false,
  onTogglePause = null,
  checkedCells = null,
  onCheckSquare = null,
  onCheckWord = null,
  onCheckPuzzle = null,
  onClearWord = null,
  circles = null,
  shades = null,
  rebusOn = false,
  onToggleRebus = null,
  onEnterGameView = null
}) => {
  const cluesContainerRef = useRef(null);
  const clueRefs = useRef({});


  // Compute the active slot/clue once per render (getPlayCurrentSlot rebuilds
  // the layout + re-derives slots, so calling it per cell was O(cells × findSlots)).
  const activeSlot = getPlayCurrentSlot();
  const activeClue = activeSlot
    ? (activeSlot.direction === 'across' ? playClues.across : playClues.down).find(c => c.row === activeSlot.row && c.col === activeSlot.col)
    : null;
  const activeClueId = activeClue ? `${activeSlot.direction}-${activeClue.number}` : null;

  // Scroll the active clue into view ONLY when it changes and is off-screen —
  // never on every render (e.g. the 1s timer tick), so manual scrolling of the
  // clue list is never hijacked back to the current clue.
  // Same as in the Create editor: the on-screen keyboard covers the lower rows of the
  // grid, and a tap on a covered square lands on the dock rather than the square.
  // CrosswordGrid marks the selection with aria-selected, so it is addressable here.
  useEffect(() => {
    if (!playSelectedCell) return;
    const el = document.querySelector('.xw-cell[aria-selected="true"]');
    if (el) keepClearOfDock(el);
  }, [playSelectedCell]);

  useEffect(() => {
    if (!activeClueId) return;
    const el = clueRefs.current[activeClueId];
    const container = cluesContainerRef.current;
    if (!el || !container) return;
    // The ACROSS/DOWN heading is `sticky top-0`, so the first rows of a section sit
    // underneath it. Scrolling the active clue to `top - 12` therefore parked it behind
    // the heading, which is why the highlighted row showed as a clipped sliver. Treat the
    // band the heading occupies as not visible.
    const header = el.closest('div')?.previousElementSibling;
    const headerH = header && getComputedStyle(header).position === 'sticky'
      ? header.offsetHeight : 0;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    const viewTop = container.scrollTop + headerH;
    const viewBottom = container.scrollTop + container.clientHeight;
    if (top < viewTop || bottom > viewBottom) {
      container.scrollTop = Math.max(0, top - headerH - 12);
    }
  }, [activeClueId]);

  if (!playGrid) return null;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 animate-rise-in solve-dock-pad">
      <div className="xl:col-span-2 space-y-5">
        {/* ---- solve toolbar ---- */}
        <div className="panel p-4">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-5">
              <div className="flex items-baseline gap-2">
                <span className="eyebrow">Time</span>
                <span className="font-mono text-2xl font-medium text-ink tabular-nums">{formatTime(playTimer)}</span>
              </div>
              {onEnterGameView && (
                <button onClick={onEnterGameView} className="btn btn-sm btn-ghost" title="Immersive game view">
                  <Maximize size={14} />Game view
                </button>
              )}
              {onTogglePause && !playComplete && (
                <button onClick={onTogglePause} className={`btn btn-sm ${paused ? 'btn-accent' : 'btn-ghost'}`}>
                  {paused ? 'Resume' : 'Pause'}
                </button>
              )}
              {onToggleRebus && !playComplete && (
                <button onClick={onToggleRebus} className={`btn btn-sm ${rebusOn ? 'btn-accent' : 'btn-ghost'}`} title="Rebus: type several letters into one square (Enter to exit)">
                  Rebus{rebusOn ? ' · On' : ''}
                </button>
              )}
              {playComplete && (
                <span className="inline-flex items-center gap-1.5 text-grass font-display font-semibold text-lg">
                  <Trophy size={20} />Complete
                </span>
              )}
            </div>
            <div className="flex gap-2 items-center flex-wrap">
              {difficultyInfo?.label && (
                <span className="inline-flex items-center gap-2 border border-ink/20 bg-paper-sunken px-3 py-1.5 rounded-sm">
                  <span className="eyebrow">Difficulty</span>
                  <span className={`font-display font-semibold ${difficultyColorClass(difficultyInfo.label)}`}>{difficultyInfo.label}</span>
                  {difficultyInfo.score !== null && <span className="font-mono text-xs text-ink-faint">({Math.round(difficultyInfo.score)})</span>}
                </span>
              )}
              {canControl && (
                <>
                  <button onClick={() => setPlayAutoCheck(prev => !prev)} className={`btn btn-sm ${playAutoCheck ? 'btn-ink' : 'btn-ghost'}`}>
                    Auto-check {playAutoCheck ? 'On' : 'Off'}
                  </button>
                  <button onClick={revealCell} className="btn btn-sm">Reveal Cell</button>
                  <button onClick={revealWord} className="btn btn-sm">Reveal Word</button>
                  <button onClick={revealAll} className="btn btn-sm btn-accent">Reveal All</button>
                </>
              )}
              {onCheckSquare && (
                <>
                  <span className="w-px h-5 bg-line mx-0.5 hidden sm:block" />
                  <button onClick={onCheckSquare} className="btn btn-sm btn-ghost">Check Cell</button>
                  <button onClick={onCheckWord} className="btn btn-sm btn-ghost">Check Word</button>
                  <button onClick={onCheckPuzzle} className="btn btn-sm btn-ghost">Check All</button>
                  <button onClick={onClearWord} className="btn btn-sm btn-ghost">Clear Word</button>
                </>
              )}
            </div>
          </div>
        </div>

        {/* ---- the grid ---- */}
        <div className="panel panel-pad relative">
          {paused && (
            <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-paper-raised/95 backdrop-blur rounded-xl">
              <div className="font-display text-3xl font-semibold text-ink">Paused</div>
              <p className="text-ink-faint text-sm">The clock is stopped.</p>
              <button onClick={onTogglePause} className="btn btn-accent">Resume solving</button>
            </div>
          )}
          {/* The clue you are actually on. The phone gets this from MobileSolveDock, but the
              dock is hidden on a wide screen with a mouse — so on a desktop there was
              nothing above the grid saying which entry you were in, and the only way to
              read your own clue was to hunt for the highlighted row in the side list.
              `desk-clue-bar` is the exact complement of `.solve-dock`, so precisely one of
              the two is ever visible. */}
          <div className="desk-clue-bar items-stretch gap-2 mb-3">
            <button
              onClick={() => goToAdjacentClue(-1)}
              className="w-9 shrink-0 flex items-center justify-center rounded-lg border border-line bg-paper-sunken hover:bg-ink/5 transition"
              aria-label="Previous clue"
            >
              <ChevronLeft size={18} />
            </button>
            <div className="flex-1 min-w-0 flex items-center gap-3 rounded-lg border border-line bg-paper-sunken px-3.5 py-2.5">
              <span className="font-mono font-bold text-accent tabular-nums shrink-0">
                {activeClue?.number ?? '—'}
                <span className="ml-1 text-[0.7rem] uppercase tracking-wide text-ink-faint">
                  {playDirection === 'across' ? 'A' : 'D'}
                </span>
              </span>
              <span className="text-ink leading-snug">
                {activeClue?.clue
                  ? renderRich(activeClue.clue)
                  : <span className="text-ink-faint italic">Select a square to see its clue.</span>}
              </span>
            </div>
            <button
              onClick={() => goToAdjacentClue(1)}
              className="w-9 shrink-0 flex items-center justify-center rounded-lg border border-line bg-paper-sunken hover:bg-ink/5 transition"
              aria-label="Next clue"
            >
              <ChevronRight size={18} />
            </button>
          </div>

          <div className="overflow-x-auto pb-2">
            <CrosswordGrid
              playGrid={playGrid}
              playAnswers={playAnswers}
              playClues={playClues}
              playSelectedCell={playSelectedCell}
              activeSlot={activeSlot}
              revealedCells={revealedCells}
              playAutoCheck={playAutoCheck}
              playComplete={playComplete}
              checkedCells={checkedCells}
              circles={circles}
              shades={shades}
              remoteCells={remoteCells}
              getNumberForCell={getNumberForCell}
              onCellClick={handlePlayCellClick}
            />
          </div>
          <p className="text-ink-faint text-xs mt-4">Click a cell to select · click again to flip Across/Down · type to fill · arrow keys to move.</p>
        </div>
      </div>

      {/* ---- clue list ---- */}
      <div className="panel max-h-[560px] lg:max-h-[720px] overflow-y-auto" ref={cluesContainerRef}>
        {[
          { dir: 'across', label: 'Across', list: playClues.across },
          { dir: 'down', label: 'Down', list: playClues.down },
        ].map(({ dir, label, list }) => (
          <div key={dir}>
            <h3 className="sticky top-0 z-10 bg-paper-raised/95 backdrop-blur eyebrow text-ink flex items-center gap-1.5 border-b border-line px-4 py-2.5">
              {dir === 'across' ? <ChevronRight size={13} /> : <ChevronDown size={13} />}{label}
              <span className="ml-auto font-mono text-[0.6rem] text-ink-faint normal-case tracking-normal">{list.length}</span>
            </h3>
            <div className="px-2 py-1.5">
              {list.map((clue) => {
                const isActive = playDirection === dir && activeSlot?.row === clue.row && activeSlot?.col === clue.col;
                return (
                  <button
                    key={`${dir}-${clue.number}`}
                    ref={(node) => { if (node) clueRefs.current[`${dir}-${clue.number}`] = node; }}
                    onClick={() => { setPlaySelectedCell({ row: clue.row, col: clue.col }); setPlayDirection(dir); }}
                    className={`w-full flex gap-3 text-left rounded-lg px-2.5 py-2 transition leading-snug
                      ${isActive ? 'bg-accent text-white' : 'text-ink-soft hover:bg-ink/[0.05]'}`}
                  >
                    <span className={`font-mono font-bold tabular-nums w-6 shrink-0 text-right text-sm ${isActive ? 'text-white' : 'text-accent'}`}>{clue.number}</span>
                    <span className="flex-1 text-[0.92rem]">{clue.clue ? renderRich(clue.clue) : <span className="italic opacity-60">—</span>}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <MobileSolveDock
        clueNumber={activeClue?.number}
        clueDirection={playDirection}
        clueText={activeClue?.clue}
        onPrev={() => goToAdjacentClue(-1)}
        onNext={() => goToAdjacentClue(1)}
        onToggleDir={() => setPlayDirection(playDirection === 'across' ? 'down' : 'across')}
        onKey={(ch) => onVirtualKey(ch)}
        onBackspace={() => onVirtualKey('Backspace')}
      />
    </div>
  );
};

export default PlayView;
