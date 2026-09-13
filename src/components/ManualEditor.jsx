import React, { useEffect, useRef } from 'react';
import { PenTool, Sparkles, X, Check, ChevronRight, ChevronDown, Zap, Lock, Unlock } from './Icons';
import MobileSolveDock from './MobileSolveDock';
import { renderRich } from '../utils/richText';
import ClueStudio from './ClueStudio';
import { difficultyColorClass } from '../utils/difficulty';

const ManualEditor = ({
  manualGrid,
  manualClues,
  selectedCell,
  selectedDirection,
  handleCellClick,
  getNumberForCell,
  isInCurrentWord,
  getCurrentWord,
  getClueForCurrentSlot,
  setSelectedCell,
  setSelectedDirection,
  editingClue,
  clueInput,
  setClueInput,
  updateClue,
  setEditingClue,
  words,
  showSuggestions,
  setShowSuggestions,
  suggestions,
  setSuggestions,
  findSuggestionsForSlot,
  applySuggestion,
  highlightedWords = new Set(),
  highlightMissingRequired = false,
  showRequiredHighlights = false,
  setShowRequiredHighlights = () => {},
  setHighlightMissingRequired = () => {},
  tagalogMode = false,
  getDateInfoForWord = () => null,
  getDateInfoForWordClue = () => null,
  failedWord = null,
  difficultyInfo = { score: null, label: '' },
  aiEnabled = false,
  clueStudio = null,
  onOpenClueStudio = () => {},
  onCloseClueStudio = () => {},
  onClueStudioBand = () => {},
  onClueStudioSense = () => {},
  onDiscoverSenses = () => {},
  onPickSense = () => {},
  onGenerateClues = () => {},
  onClueAccepted = () => {},
  onOpenReclue = () => {},
  onVirtualKey = () => {},
  lockedCells = new Set(),
  onToggleCellLock = () => {},
  onToggleWordLock = () => {},
  onUnpinAll = () => {}
}) => {


  const currentWord = getCurrentWord();
  const cluesContainerRef = useRef(null);
  const clueRefs = useRef({});

  // getCurrentWord() builds a NEW object every render, so using it as a dependency fired
  // this on every render — typing one character into the required-words box snapped the
  // clue pane back to the selection. Key off a scalar id instead, and only scroll when the
  // clue is actually off-screen, which is what PlayView already does.
  const activeClueEntry = currentWord?.slot
    ? (currentWord.slot.direction === 'across' ? manualClues.across : manualClues.down)
      .find(c => c.row === currentWord.slot.row && c.col === currentWord.slot.col)
    : null;
  const activeClueId = activeClueEntry
    ? `${currentWord.slot.direction}-${activeClueEntry.number}`
    : null;

  useEffect(() => {
    if (!activeClueId) return;
    const el = clueRefs.current[activeClueId];
    const container = cluesContainerRef.current;
    if (!el || !container) return;
    const top = el.offsetTop;
    const bottom = top + el.offsetHeight;
    if (top < container.scrollTop || bottom > container.scrollTop + container.clientHeight) {
      container.scrollTop = Math.max(0, top - 8);
    }
  }, [activeClueId]);

  const wordComplete = !!currentWord?.word && !currentWord.word.includes('_');

  // Right-click is the desktop gesture for pinning a single square; touch has no
  // equivalent, so a ~500ms press does the same. The timer is cancelled on move so a
  // scroll never pins a square by accident.
  const longPress = useRef({ timer: null, fired: false });
  const startLongPress = (r, c) => {
    longPress.current.fired = false;
    clearTimeout(longPress.current.timer);
    longPress.current.timer = setTimeout(() => {
      longPress.current.fired = true;
      onToggleCellLock(r, c);
      if (navigator.vibrate) navigator.vibrate(8);
    }, 500);
  };
  const cancelLongPress = () => clearTimeout(longPress.current.timer);
  useEffect(() => () => clearTimeout(longPress.current.timer), []);

  const pinnedCount = lockedCells.size;
  const currentWordPinned = (() => {
    const slot = currentWord?.slot;
    if (!slot || !manualGrid) return false;
    let any = false;
    for (let i = 0; i < slot.length; i++) {
      const r = slot.direction === 'across' ? slot.row : slot.row + i;
      const c = slot.direction === 'across' ? slot.col + i : slot.col;
      if (!manualGrid[r]?.[c] || manualGrid[r][c] === '#') continue;
      any = true;
      if (!lockedCells.has(`${r},${c}`)) return false;
    }
    return any;
  })();

  const openStudio = () => {
    const slot = currentWord?.slot;
    if (!slot) return;
    let word = '';
    for (let i = 0; i < slot.length; i++) {
      const r = slot.direction === 'across' ? slot.row : slot.row + i;
      const c = slot.direction === 'across' ? slot.col + i : slot.col;
      word += manualGrid[r]?.[c] || '';
    }
    if (!word || word.length !== slot.length || word.includes('_')) return;
    onOpenClueStudio(word, getClueForCurrentSlot()?.clue || '');
  };

  const activeSlot = currentWord?.slot;
  const activeClue = activeSlot
    ? (selectedDirection === 'across' ? manualClues.across : manualClues.down).find(c => c.row === activeSlot.row && c.col === activeSlot.col)
    : null;

  const goToAdjacentClue = (delta) => {
    const list = selectedDirection === 'across' ? manualClues.across : manualClues.down;
    if (!list || !list.length) return;
    let idx = activeSlot ? list.findIndex(c => c.row === activeSlot.row && c.col === activeSlot.col) : -1;
    idx = idx === -1 ? 0 : (idx + delta + list.length) % list.length;
    const c = list[idx];
    setSelectedCell({ row: c.row, col: c.col });
  };

  if (!manualGrid) return null;

  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 animate-rise-in pb-72 lg:pb-0">
      <div className="xl:col-span-2 space-y-5">
        {/* ---- grid composer ---- */}
        <div className="panel panel-pad">
          <div className="flex items-end justify-between mb-1 gap-3 flex-wrap">
            <div>
              <div className="eyebrow">Compose</div>
              <h2 className="font-display text-2xl font-semibold text-ink leading-tight">Set Your Grid</h2>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {difficultyInfo?.label && (
                <span className="inline-flex items-center gap-2 border border-ink/20 bg-paper-sunken px-3 py-1.5 rounded-sm">
                  <span className="eyebrow">Difficulty</span>
                  <span className={`font-display font-semibold ${difficultyColorClass(difficultyInfo.label)}`}>{difficultyInfo.label}</span>
                  {difficultyInfo.score !== null && <span className="font-mono text-xs text-ink-faint">({Math.round(difficultyInfo.score)})</span>}
                </span>
              )}
              {highlightedWords.size > 0 && (
                <button
                  onClick={() => setShowRequiredHighlights(prev => {
                    const next = !prev;
                    if (next) setHighlightMissingRequired(false);
                    return next;
                  })}
                  className={`btn btn-sm ${showRequiredHighlights ? 'btn-ink' : 'btn-ghost'}`}
                >
                  {showRequiredHighlights ? 'Hide required' : 'Show required'}
                </button>
              )}
            </div>
          </div>
          <p className="text-ink-faint text-sm mt-1 mb-4">Click a cell to select · click again to flip Across/Down · type letters to fill.</p>
          <div className="rule-hair mb-4" />
          <div className="overflow-x-auto pb-2"><div className="xw-grid" style={{ '--cols': manualGrid[0]?.length || 15 }}>
            {manualGrid.map((row, r) => <div key={r} className="flex">{row.map((cell, c) => {
              const isSelected = selectedCell?.row === r && selectedCell?.col === c;
              const isInWord = isInCurrentWord(r, c);
              const clueNumber = getNumberForCell(r, c, manualClues);
              const across = manualClues.across.find(cl => cl.row === r && c >= cl.col && c < cl.col + cl.length);
              const down = manualClues.down.find(cl => cl.col === c && r >= cl.row && r < cl.row + cl.length);
              const isSlotFilled = (slot) => {
                if (!slot) return false;
                for (let i = 0; i < slot.length; i++) {
                  const rr = slot.direction === 'across' ? slot.row : slot.row + i;
                  const cc = slot.direction === 'across' ? slot.col + i : slot.col;
                  const ch = manualGrid[rr]?.[cc];
                  if (!ch || ch === '#') return false;
                }
                return true;
              };
              const acrossWord = across ? Array.from({ length: across.length }, (_, i) => manualGrid[across.row][across.col + i] || '').join('').toUpperCase() : '';
              const downWord = down ? Array.from({ length: down.length }, (_, i) => manualGrid[down.row + i][down.col] || '').join('').toUpperCase() : '';
              const missingClueAcross = across && isSlotFilled(across) && !across.clue;
              const missingClueDown = down && isSlotFilled(down) && !down.clue;
              const missingClue = (missingClueAcross || missingClueDown) && cell;
              const inHighlightedWord = showRequiredHighlights && highlightedWords && highlightedWords.size > 0 && cell
                ? highlightedWords.has(acrossWord) || highlightedWords.has(downWord)
                : false;
              const inFailedWord = failedWord && cell
                ? ((across && isSlotFilled(across) && failedWord.toUpperCase() === acrossWord) ||
                   (down && isSlotFilled(down) && failedWord.toUpperCase() === downWord))
                : false;
              // `!showRequiredHighlights` used to be in this condition, but inHighlightedWord
              // already requires it to be TRUE — so the branch could never render and the
              // "required word that still needs a clue" state was unreachable.
              const shouldShowRequiredMissing = inHighlightedWord && missingClue && highlightMissingRequired;
              const cellClass = cell === '#'
                ? 'xw-cell--block'
                : inFailedWord
                  ? 'xw-cell--failed'
                  : isSelected
                    ? 'bg-select ring-1 ring-inset ring-ink/30'
                    : isInWord
                      ? 'bg-word'
                      : shouldShowRequiredMissing && cell
                        ? 'xw-cell--needs-clue-strong'
                        : inHighlightedWord
                          ? 'xw-cell--required'
                          : missingClue && cell
                            ? 'xw-cell--needs-clue'
                            : '';
              const pinned = cell !== '#' && cell && lockedCells.has(`${r},${c}`);
              return (
                <div
                  key={c}
                  onClick={() => { if (!longPress.current.fired) handleCellClick(r, c); }}
                  onContextMenu={(e) => { if (cell !== '#' && cell) { e.preventDefault(); onToggleCellLock(r, c); } }}
                  onTouchStart={() => { if (cell !== '#' && cell) startLongPress(r, c); }}
                  onTouchEnd={cancelLongPress}
                  onTouchMove={cancelLongPress}
                  onTouchCancel={cancelLongPress}
                  title={cell !== '#' && cell
                    ? (pinned ? 'Pinned — Regenerate will keep this letter. Right-click or long-press to unpin.'
                      : 'Right-click or long-press to pin this letter')
                    : undefined}
                  className={`xw-cell ${cell === '#' ? '' : 'cursor-pointer'} ${cellClass} ${pinned ? 'xw-cell--pinned' : ''}`}
                >
                  {cell !== '#' && clueNumber && <span className="xw-num">{clueNumber}</span>}
                  {cell !== '#' && cell && <span className="xw-letter text-ink">{cell}</span>}
                </div>
              );
            })}</div>)}
          </div></div>

          {/* Pinned squares are the contract between the author and Regenerate, so say
              plainly how many there are and offer the way out. */}
          <div className="mt-2 flex items-center justify-center gap-2 flex-wrap text-[11px] text-ink-faint">
            {pinnedCount > 0 ? (
              <>
                <Lock size={12} className="text-ink-soft" />
                <span>
                  <b className="text-ink-soft font-semibold">{pinnedCount}</b>{' '}
                  {pinnedCount === 1 ? 'square is' : 'squares are'} pinned — Regenerate keeps
                  {pinnedCount === 1 ? ' it' : ' them'}.
                </span>
                <button onClick={onUnpinAll} className="underline hover:text-ink transition">
                  Unpin all
                </button>
              </>
            ) : (
              <span>Type a letter to pin it. Pinned squares survive Regenerate.</span>
            )}
          </div>
        </div>

        {/* ---- selection / clue editor ---- */}
        {selectedCell && (
          <div className="panel panel-pad">
            <div className="flex items-end justify-between gap-3 flex-wrap">
              <div>
                <span className="eyebrow">Current Selection</span>
                <div className="font-mono text-2xl font-medium text-ink tracking-[0.28em] mt-1.5">{currentWord.word || '·····'}</div>
                <div className="text-ink-faint text-sm mt-1">Direction — <span className="text-ink capitalize font-semibold">{selectedDirection}</span></div>
              </div>
              <div className="flex gap-2 flex-wrap">
                <button onClick={() => { setClueInput(getClueForCurrentSlot()?.clue || ''); setEditingClue(true); }} className="btn btn-sm"><PenTool size={15} />Edit Clue</button>
                {words.length > 0 && <button onClick={() => { setShowSuggestions(!showSuggestions); setSuggestions(findSuggestionsForSlot()); }} className="btn btn-sm btn-accent"><Sparkles size={15} />Auto-fill</button>}
                <button onClick={openStudio} disabled={!wordComplete} title={wordComplete ? 'Browse and write clues at a chosen difficulty' : 'Fill the word first'} className="btn btn-sm btn-gold"><Zap size={15} />Clues</button>
                <button onClick={onOpenReclue} title="Re-clue the whole puzzle at a chosen difficulty" className="btn btn-sm"><Sparkles size={15} />Re-clue all</button>
                <button
                  onClick={onToggleWordLock}
                  disabled={!currentWord?.word}
                  title={currentWordPinned
                    ? 'Unpin this word so Regenerate may change it'
                    : 'Pin this word so Regenerate keeps it'}
                  className={`btn btn-sm ${currentWordPinned ? 'btn-ink' : ''}`}
                >
                  {currentWordPinned ? <Lock size={15} /> : <Unlock size={15} />}
                  {currentWordPinned ? 'Pinned' : 'Pin word'}
                </button>
              </div>
            </div>

            {getClueForCurrentSlot() && (
              <div className="mt-4 bg-paper-sunken rounded-sm p-4 border border-ink/12 space-y-1.5">
                <div className="eyebrow">Current Clue</div>
                <div className="text-ink">{getClueForCurrentSlot()?.clue ? renderRich(getClueForCurrentSlot().clue) : <span className="text-ink-faint italic">No clue set</span>}</div>
                {!tagalogMode && getClueForCurrentSlot()?.clue && (() => {
                  const slot = getCurrentWord()?.slot;
                  let filledWord = '';
                  if (slot) {
                    for (let i = 0; i < slot.length; i++) {
                      const rr = slot.direction === 'across' ? slot.row : slot.row + i;
                      const cc = slot.direction === 'across' ? slot.col + i : slot.col;
                      filledWord += manualGrid[rr]?.[cc] || '';
                    }
                  }
                  if (!filledWord || filledWord.includes('_')) return null;
                  const dateInfo = getDateInfoForWordClue(filledWord.toUpperCase(), getClueForCurrentSlot()?.clue) || getDateInfoForWord(filledWord.toUpperCase());
                  return dateInfo ? (
                    <div className="flex flex-col gap-0.5 text-xs text-ink-soft pt-1">
                      <div>Date appeared: <span className="text-gold font-semibold font-mono">{dateInfo.formatted}</span></div>
                      {dateInfo.difficulty && (
                        <div>Difficulty: <span className={`font-semibold ${difficultyColorClass(dateInfo.difficulty)}`}>{dateInfo.difficulty}</span></div>
                      )}
                    </div>
                  ) : null;
                })()}
              </div>
            )}

            {editingClue && (
              <div className="fixed inset-0 z-[1200] bg-ink/45 backdrop-blur-[2px] flex items-center justify-center p-4">
                <div className="panel w-full max-w-md p-6 animate-rise-in">
                  <h3 className="font-display text-2xl font-semibold text-ink mb-1">Edit Clue</h3>
                  <div className="eyebrow mb-3">For <span className="font-mono text-accent">{currentWord.word}</span></div>
                  <textarea value={clueInput} onChange={(e) => setClueInput(e.target.value)} placeholder="Enter your clue…" className="field" rows={3} autoFocus />
                  <div className="text-[11px] text-ink-faint mt-1.5">Formatting: <code className="chip">**bold**</code> <code className="chip">*italic*</code> · accents & symbols (é, ñ, —, ♪) can be typed directly.</div>
                  <div className="flex gap-3 mt-4">
                    <button onClick={() => updateClue(clueInput)} className="btn btn-accent flex-1"><Check size={16} />Save</button>
                    <button onClick={() => { setEditingClue(null); setClueInput(''); }} className="btn btn-ghost flex-1"><X size={16} />Cancel</button>
                  </div>
                </div>
              </div>
            )}

            {clueStudio && (
              <ClueStudio
                word={clueStudio.word}
                currentClue={clueStudio.currentClue}
                band={clueStudio.band}
                candidates={clueStudio.candidates}
                range={clueStudio.range}
                loading={clueStudio.loading}
                generating={clueStudio.generating}
                error={clueStudio.error}
                aiEnabled={aiEnabled}
                onBandChange={onClueStudioBand}
                sense={clueStudio.sense}
                reading={clueStudio.reading}
                onSenseChange={onClueStudioSense}
                senses={clueStudio.senses}
                findingSenses={clueStudio.findingSenses}
                onDiscoverSenses={onDiscoverSenses}
                onPickSense={onPickSense}
                onGenerate={onGenerateClues}
                onAccept={(clue) => {
                  updateClue(clue);
                  // Keep it: the user's own clues accumulate across puzzles and export.
                  onClueAccepted(clueStudio.word, clue);
                  onCloseClueStudio();
                }}
                onClose={onCloseClueStudio}
              />
            )}

            {showSuggestions && (
              <div className="mt-4 border border-line rounded-lg overflow-hidden">
                <div className="bg-paper-sunken px-4 py-2 flex items-center justify-between border-b border-line"><span className="eyebrow">Suggestions from CSV</span><button onClick={() => setShowSuggestions(false)} className="text-ink-faint hover:text-ink"><X size={15} /></button></div>
                <div className="max-h-48 overflow-y-auto">
                  {suggestions.length === 0 ? <div className="p-4 text-ink-faint text-center text-sm">No matching words found</div> : suggestions.map((s, i) => (
                    <button key={i} onClick={() => applySuggestion(s)} className="w-full px-4 py-2.5 text-left hover:bg-ink/[0.04] transition border-b border-ink/8 last:border-0">
                      <div className="font-mono font-semibold text-accent tracking-wide">{s.word}</div>
                      <div className="text-ink-soft text-sm truncate">{s.clue}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ---- clue list ---- */}
      <div className="panel panel-pad max-h-[720px] overflow-y-auto" ref={cluesContainerRef}>
        <div className="eyebrow">Manuscript</div>
        <h2 className="font-display text-2xl font-semibold text-ink mb-4">Clues</h2>
        <div className="mb-6">
          <h3 className="eyebrow text-ink flex items-center gap-1.5 border-b border-ink/15 pb-1.5 mb-3"><ChevronRight size={13} />Across</h3>
          {manualClues.across.map(clue => {
            let word = '';
            for (let i = 0; i < clue.length; i++) word += manualGrid[clue.row][clue.col + i] || '_';
            const normalized = !word.includes('_') ? word.toUpperCase() : null;
            const dateInfo = !tagalogMode && clue.clue && normalized ? getDateInfoForWordClue(normalized, clue.clue) : null;
            const clueId = `across-${clue.number}`;
            const isActive = selectedCell && selectedDirection === 'across' && clue.row === currentWord.slot?.row && clue.col === currentWord.slot?.col;
            return <div key={`across-${clue.number}`} ref={node => { if (node) clueRefs.current[clueId] = node; }} className={`mb-2.5 text-sm pl-3 border-l-2 transition cursor-pointer py-1 ${isActive ? 'border-accent bg-accent/8' : 'border-ink/15 hover:bg-ink/[0.04]'}`} onClick={() => { setSelectedCell({ row: clue.row, col: clue.col }); setSelectedDirection('across'); }}>
              <div className="flex items-center gap-2"><span className="font-mono font-semibold text-accent">{clue.number}</span><span className="font-mono text-ink-faint text-xs tracking-wide">{word}</span></div>
              <div className="text-ink-soft mt-0.5 leading-snug">{clue.clue ? renderRich(clue.clue) : <span className="text-ink-faint italic">Click to add clue</span>}</div>
              {dateInfo && (
                <div className="text-[11px] text-ink-faint mt-0.5 space-y-0.5">
                  <div>Date: <span className="text-gold font-mono">{dateInfo.formatted}</span></div>
                  {dateInfo.difficulty && <div>Difficulty: <span className={difficultyColorClass(dateInfo.difficulty)}>{dateInfo.difficulty}</span></div>}
                </div>
              )}
            </div>;
          })}
        </div>
        <div>
          <h3 className="eyebrow text-ink flex items-center gap-1.5 border-b border-ink/15 pb-1.5 mb-3"><ChevronDown size={13} />Down</h3>
          {manualClues.down.map(clue => {
            let word = '';
            for (let i = 0; i < clue.length; i++) word += manualGrid[clue.row + i][clue.col] || '_';
            const normalized = !word.includes('_') ? word.toUpperCase() : null;
            const dateInfo = !tagalogMode && clue.clue && normalized ? getDateInfoForWordClue(normalized, clue.clue) : null;
            const clueId = `down-${clue.number}`;
            const isActive = selectedCell && selectedDirection === 'down' && clue.row === currentWord.slot?.row && clue.col === currentWord.slot?.col;
            return <div key={`down-${clue.number}`} ref={node => { if (node) clueRefs.current[clueId] = node; }} className={`mb-2.5 text-sm pl-3 border-l-2 transition cursor-pointer py-1 ${isActive ? 'border-accent bg-accent/8' : 'border-ink/15 hover:bg-ink/[0.04]'}`} onClick={() => { setSelectedCell({ row: clue.row, col: clue.col }); setSelectedDirection('down'); }}>
              <div className="flex items-center gap-2"><span className="font-mono font-semibold text-accent">{clue.number}</span><span className="font-mono text-ink-faint text-xs tracking-wide">{word}</span></div>
              <div className="text-ink-soft mt-0.5 leading-snug">{clue.clue ? renderRich(clue.clue) : <span className="text-ink-faint italic">Click to add clue</span>}</div>
              {dateInfo && (
                <div className="text-[11px] text-ink-faint mt-0.5 space-y-0.5">
                  <div>Date: <span className="text-gold font-mono">{dateInfo.formatted}</span></div>
                  {dateInfo.difficulty && <div>Difficulty: <span className={difficultyColorClass(dateInfo.difficulty)}>{dateInfo.difficulty}</span></div>}
                </div>
              )}
            </div>;
          })}
        </div>
      </div>

      <MobileSolveDock
        clueNumber={activeClue?.number}
        clueDirection={selectedDirection}
        clueText={activeClue?.clue || (currentWord?.word ? currentWord.word.replace(/_/g, '·') : '')}
        onPrev={() => goToAdjacentClue(-1)}
        onNext={() => goToAdjacentClue(1)}
        onToggleDir={() => setSelectedDirection(selectedDirection === 'across' ? 'down' : 'across')}
        onKey={(ch) => onVirtualKey(ch)}
        onBackspace={() => onVirtualKey('Backspace')}
      />
    </div>
  );
};

export default ManualEditor;
