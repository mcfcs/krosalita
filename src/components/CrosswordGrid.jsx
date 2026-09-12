import React from 'react';

// Shared crossword grid renderer used by both the studio Play view and the
// immersive Game view. Purely presentational — all state comes via props.
const CrosswordGrid = ({
  playGrid,
  playAnswers,
  playClues,
  playSelectedCell,
  activeSlot,
  revealedCells,
  playAutoCheck,
  playComplete,
  checkedCells = null,
  circles = null,
  shades = null,
  remoteCells = {},
  getNumberForCell,
  onCellClick,
  gridClassName = 'xw-grid xw-grid--play',
}) => {
  const inActiveWord = (r, c) => {
    if (!activeSlot) return false;
    if (activeSlot.direction === 'across') return r === activeSlot.row && c >= activeSlot.col && c < activeSlot.col + activeSlot.length;
    return c === activeSlot.col && r >= activeSlot.row && r < activeSlot.row + activeSlot.length;
  };

  return (
    <div className={gridClassName} style={{ '--cols': playGrid[0]?.length || 15 }}>
      {playGrid.map((row, r) => (
        <div key={r} className="flex">
          {row.map((cell, c) => {
            const isSelected = playSelectedCell?.row === r && playSelectedCell?.col === c;
            const isInWord = inActiveWord(r, c);
            const isRevealed = revealedCells.has(`${r},${c}`);
            const isChecked = checkedCells?.has(`${r},${c}`);
            const showCorrectness = (playAutoCheck || playComplete || isChecked) && !!playAnswers;
            const isCorrect = showCorrectness && cell === playAnswers[r][c] && cell !== '';
            const isWrong = showCorrectness && cell !== '' && cell !== playAnswers[r][c];
            const clueNumber = getNumberForCell(r, c, playClues);
            const clueObj = clueNumber ? (playClues.across.find(cl => cl.number === clueNumber) || playClues.down.find(cl => cl.number === clueNumber)) : null;
            const isSlotFilled = (slot) => {
              if (!slot) return false;
              for (let i = 0; i < slot.length; i++) {
                const rr = slot.direction === 'across' ? slot.row : slot.row + i;
                const cc = slot.direction === 'across' ? slot.col + i : slot.col;
                const ch = playGrid[rr]?.[cc];
                if (!ch || ch === '#') return false;
              }
              return true;
            };
            const missingClue = clueObj && isSlotFilled(clueObj) && !clueObj.clue;

            const fill = cell === '#'
              ? 'xw-cell--block'
              : isSelected
                ? 'bg-select ring-1 ring-inset ring-ink/30'
                : isInWord
                  ? 'bg-word'
                  : missingClue && cell
                    ? 'xw-cell--needs-clue'
                    : '';
            const letterColor = isRevealed
              ? 'text-revealed'
              : isWrong ? 'text-wrong' : isCorrect ? 'text-correct' : 'text-ink';
            const cellKey = `${r},${c}`;
            const remote = cell !== '#' ? remoteCells[cellKey] : null;
            const shaded = cell !== '#' && shades?.has(cellKey);
            const circled = cell !== '#' && circles?.has(cellKey);
            const isRebus = cell && cell.length > 1;

            return (
              <div
                key={c}
                onClick={() => onCellClick(r, c)}
                className={`xw-cell ${cell === '#' ? '' : 'cursor-pointer'} ${fill}`}
              >
                {shaded && <span className="absolute inset-0 pointer-events-none bg-ink/15" />}
                {circled && <span className="absolute inset-[9%] pointer-events-none rounded-full border border-ink/45" />}
                {remote && (
                  <span
                    className="absolute inset-0 pointer-events-none"
                    title={remote.name}
                    style={{
                      backgroundColor: remote.tint ? `${remote.tint}24` : undefined,
                      boxShadow: remote.ring ? `inset 0 0 0 2.5px ${remote.ring}` : undefined,
                    }}
                  />
                )}
                {cell !== '#' && clueNumber && <span className="xw-num">{clueNumber}</span>}
                {cell !== '#' && cell && (
                  <span className={`xw-letter ${letterColor} ${isRebus ? 'text-[0.42em] leading-[1.05] font-bold px-0.5 text-center' : ''}`}>{cell}</span>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
};

export default CrosswordGrid;
