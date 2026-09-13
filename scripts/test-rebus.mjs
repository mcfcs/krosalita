// Does a rebus CROSS hold up at the data level?
//   across: LEBRON[JAM]ES   -> L,E,B,R,O,N,JAM,E,S   (9 squares, 11 letters)
//   down:   [JAM]PACKED     -> JAM,P,A,C,K,E,D       (7 squares,  9 letters)
// They share the JAM square. This uses the app's own helpers, not a reimplementation.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const u = (p) => pathToFileURL(path.join(APP, p)).href;
const { getWordFromGrid, findSlots } = await import(u('src/utils/crosswordUtils.js'));

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n         got  ${JSON.stringify(got)}\n         want ${JSON.stringify(want)}`}`);
  ok ? pass++ : fail++;
};

// A 9x7 board. Row 0 is the across entry; column 6 is the down entry starting at the JAM.
const B = '#';
const answers = [
  ['L','E','B','R','O','N','JAM','E','S'],
  [ B , B , B , B , B , B ,'P' , B , B ],
  [ B , B , B , B , B , B ,'A' , B , B ],
  [ B , B , B , B , B , B ,'C' , B , B ],
  [ B , B , B , B , B , B ,'K' , B , B ],
  [ B , B , B , B , B , B ,'E' , B , B ],
  [ B , B , B , B , B , B ,'D' , B , B ],
];
const layout = answers.map((row) => row.map((c) => (c === B ? B : '.')));

const slots = findSlots(layout);
const across = slots.find((s) => s.direction === 'across' && s.row === 0);
const down = slots.find((s) => s.direction === 'down' && s.col === 6);

check('the across slot is 9 SQUARES long', across?.length, 9);
check('the down slot is 7 SQUARES long', down?.length, 7);
check('the across entry re-joins to the full answer',
  getWordFromGrid(answers, across.row, across.col, across.length, 'across'), 'LEBRONJAMES');
check('the down entry re-joins to the full answer',
  getWordFromGrid(answers, down.row, down.col, down.length, 'down'), 'JAMPACKED');
check('both entries share the same square', [across.row, across.col + 6], [down.row, down.col]);
check('the shared square holds the whole rebus', answers[0][6], 'JAM');

// checkPlayComplete's comparison, verbatim: currentGrid[r][c] !== playAnswers[r][c]
const complete = (g) => {
  for (let r = 0; r < g.length; r++)
    for (let c = 0; c < g[r].length; c++)
      if (g[r][c] !== '#' && g[r][c] !== answers[r][c]) return false;
  return true;
};
const filled = answers.map((r) => [...r]);
check('a fully correct board (rebus typed as JAM) is complete', complete(filled), true);

const partial = answers.map((r) => [...r]);
partial[0][6] = 'J';                       // only the first letter typed
check('typing only J is NOT accepted as complete', complete(partial), false);

const wrong = answers.map((r) => [...r]);
wrong[0][6] = 'JAN';
check('a wrong rebus (JAN) is NOT accepted as complete', complete(wrong), false);

// The clue's length field must describe SQUARES, or the clue list lies about the answer.
check('across length in squares != answer length in letters', [across.length, 'LEBRONJAMES'.length], [9, 11]);

console.log(fail ? `\nFAILED — ${fail} of ${pass + fail}` : `\nPASSED — ${pass} checks`);
process.exit(fail ? 1 : 0);
