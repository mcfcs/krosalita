import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Upload, Download, RefreshCw, Bug, Puzzle, PenTool, X, Check, ChevronRight, ChevronDown, Save, FolderOpen, Grid3X3, Play, BookOpen, Languages, Settings, Flame, DownloadCloud, Zap, Share, Search, Volume2, VolumeX, Maximize, Trophy } from './components/Icons';
import BrowseView from './components/BrowseView';
import MultiplayerView from './components/MultiplayerView';
import AuthModal from './components/AuthModal';
import MyPuzzlesView from './components/MyPuzzlesView';
import SolveHistory from './components/SolveHistory';
import ConfirmModal from './components/ConfirmModal';
import ResultModal from './components/ResultModal';
import DictionaryModal from './components/DictionaryModal';
import LayoutEditorModal from './components/LayoutEditorModal';
import LayoutSelector from './components/LayoutSelector';
import ManualEditor from './components/ManualEditor';
import ReclueReview from './components/ReclueReview';
import PlayView from './components/PlayView';
import GameView from './components/GameView';
import RequiredWordsModal from './components/RequiredWordsModal';
import SettingsModal from './components/SettingsModal';
import { DEFAULT_LAYOUTS } from './data/layouts';
import { parseCSV, findSlots, assignNumbers, getWordFromGrid, getLayoutStats, getCellNumber } from './utils/crosswordUtils';
import { isClueUsableFor } from './utils/clueFilters';
import { loadJSON, saveJSON } from './utils/storage';

// Clues the user writes or accepts. Kept separate from the corpus so they survive the CSV
// being re-fetched on every load, and so they can be exported and fed back into the
// pipeline later.
const USER_CLUES_KEY = 'userClues';
// Rows the user removed from the Lexicon. The corpus CSV is re-fetched on every load, so
// a deletion has to be recorded as a subtraction over it — there is nowhere else to put it.
const USER_HIDDEN_KEY = 'userHidden';
const pairKey = (word, clue) => `${String(word || '').toUpperCase()}\u0000${String(clue || '')}`;
import { todayKey, seedFromString, getStreak, recordDailySolve, isDailySolved } from './utils/daily';
import { difficultyLabelFromScore, difficultyColorClass, difficultyTargetOf } from './utils/difficulty';
import { getOllamaConfig, saveOllamaConfig, generateClues, auditDifficulty } from './utils/ollama';
import { loadClueModel, cluePercentile } from './utils/clueScore';
import {
  BANDS, scoreCandidates, flagImplausible, makeGenerator, recluePuzzle,
  sensesForAnswer, senseText,
} from './utils/clueSource';
import { memoryClueStore } from './utils/clueIndex';
import { useAuth } from './hooks/useAuth';
import { savePuzzle, fetchByCode } from './lib/puzzles';
import { recordSolve, syncOnSignIn } from './lib/solves';
import { formatCode, codeError } from './lib/shareCode';
import { sfx, isSoundOn, setSoundOn, getVolume, setVolume } from './utils/sound';
import { burstConfetti } from './utils/confetti';
import { renderRich, plainRich } from './utils/richText';

const CrosswordGenerator = () => {
  const [activeTab, setActiveTab] = useState('auto');
  const [words, setWords] = useState([]);
  const [grid, setGrid] = useState(null);
  const [clues, setClues] = useState({ across: [], down: [] });
  const [error, setError] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState('');
  const [tagalogMode, setTagalogMode] = useState(false);
  // True when the words come from an uploaded CSV or the Tagalog list rather than
  // the packed corpus artifact, so the worker is told which source to index.
  const [usingCustomWords, setUsingCustomWords] = useState(false);
  const [userClues, setUserClues] = useState(() => loadJSON(USER_CLUES_KEY, []));
  const [userHidden, setUserHidden] = useState(() => new Set(loadJSON(USER_HIDDEN_KEY, [])));
  const [debugMode, setDebugMode] = useState(false);
  const [debugLog, setDebugLog] = useState([]);
  const [layouts, setLayouts] = useState(DEFAULT_LAYOUTS);
  const [selectedLayoutIndex, setSelectedLayoutIndex] = useState(0);
  const [showLayoutSelector, setShowLayoutSelector] = useState(false);
  const [showLayoutModal, setShowLayoutModal] = useState(false);
  const [layoutEditorMode, setLayoutEditorMode] = useState('create');
  const [editingLayoutIndex, setEditingLayoutIndex] = useState(null);
  const cancelRef = useRef(false);
  const previousWordsRef = useRef(null);

  const [manualGrid, setManualGrid] = useState(null);
  const [manualClues, setManualClues] = useState({ across: [], down: [] });
  const [selectedCell, setSelectedCell] = useState(null);
  const [selectedDirection, setSelectedDirection] = useState('across');
  const [editingClue, setEditingClue] = useState(null);
  const [clueInput, setClueInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [currentLayoutIndex, setCurrentLayoutIndex] = useState(0);
  const [requiredWords, setRequiredWords] = useState([]);
  const [requiredMode, setRequiredMode] = useState('anchor'); // 'anchor' | 'opportunistic'
  const [showRequiredModal, setShowRequiredModal] = useState(false);
  const [requiredAction, setRequiredAction] = useState('auto'); // 'auto' | 'play'
  const [manualRequiredInput, setManualRequiredInput] = useState('');
  const [manualRequiredMode, setManualRequiredMode] = useState('opportunistic');
  const [requiredViewMode, setRequiredViewMode] = useState('simple'); // 'simple' | 'byLength'
  const [puzzleDateInfo, setPuzzleDateInfo] = useState(new Map());
  const [failedWord, setFailedWord] = useState(null);
  const [latestGrid, setLatestGrid] = useState(null);
  const [latestClues, setLatestClues] = useState(null);
  const [requiredHighlights, setRequiredHighlights] = useState(new Set());
  const [showRequiredHighlights, setShowRequiredHighlights] = useState(false);
  const [highlightMissingRequired, setHighlightMissingRequired] = useState(false);
  const [csvLoading, setCsvLoading] = useState(false);
  const [difficultyInfo, setDifficultyInfo] = useState({ score: null, label: '' });
  const [difficultyChoice, setDifficultyChoice] = useState('random'); // random | easy | fair | moderate | hard | difficult | nyt-monday
  
  // Play mode state
  const [playGrid, setPlayGrid] = useState(null);
  const [playClues, setPlayClues] = useState({ across: [], down: [] });
  const [playSelectedCell, setPlaySelectedCell] = useState(null);
  const [playDirection, setPlayDirection] = useState('across');
  const [playAnswers, setPlayAnswers] = useState(null); // The correct answers
  const [playComplete, setPlayComplete] = useState(false);
  const [playTimer, setPlayTimer] = useState(0);
  const [playTimerActive, setPlayTimerActive] = useState(false);
  const [playPaused, setPlayPaused] = useState(false);
  const [playCircles, setPlayCircles] = useState(new Set()); // circled cells (imported puzzles)
  const [playShades, setPlayShades] = useState(new Set());   // shaded cells
  const [rebusMode, setRebusMode] = useState(false);         // type multiple letters into one cell
  const [gameView, setGameView] = useState(() => typeof window !== 'undefined' && window.matchMedia?.('(max-width: 767px)').matches); // immersive NYT-style view — default on phones
  const [checkedCells, setCheckedCells] = useState(new Set()); // cells shown correctness via one-off Check
  // Squares in Create whose letter the author put there by hand. Nothing else recorded who
  // filled a square, so a regenerate had no way to tell the author's letters from the
  // solver's and simply overwrote everything.
  const [lockedCells, setLockedCells] = useState(new Set());
  // Circled squares in Create. Circles were previously read-only — they arrived with an
  // imported puzzle and there was no way to author one.
  const [manualCircles, setManualCircles] = useState(new Set());
  // Rebus authoring: several letters typed into one square, the way LEBRON[JAM]ES and
  // [JAM]PACKED share a square.
  const [manualRebusMode, setManualRebusMode] = useState(false);
  const [shareCodeInput, setShareCodeInput] = useState('');
  const [shareCodeBusy, setShareCodeBusy] = useState(false);
  const [shareCodeError, setShareCodeError] = useState('');
  // Generation is rate-limited: a run takes ~10ms on a warm corpus, so a double-click used
  // to fire two solves and the second's result raced the first's into the grid.
  const [cooldownUntil, setCooldownUntil] = useState(0);
  const [, setNowTick] = useState(0);   // forces the cooldown countdown to re-render
  const [usedAssist, setUsedAssist] = useState(false); // any reveal/check used → not a clean solve
  const [confirmDialog, setConfirmDialog] = useState(null); // { title, message, confirmLabel, onConfirm }
  const [showResult, setShowResult] = useState(false);
  const [cleanSolve, setCleanSolve] = useState(false);
  const [playAutoCheck, setPlayAutoCheck] = useState(false);
  const [revealedCells, setRevealedCells] = useState(new Set());
  
  // Dictionary state
  const [showDictionary, setShowDictionary] = useState(false);
  const [dictionarySearch, setDictionarySearch] = useState('');
  const [newWord, setNewWord] = useState('');
  const [newClue, setNewClue] = useState('');
  const [editingWordIndex, setEditingWordIndex] = useState(null);
  const [editWord, setEditWord] = useState('');
  const [editClue, setEditClue] = useState('');
  
  // Settings / AI / PWA / daily
  const [showSettings, setShowSettings] = useState(false);
  const [ollamaConfig, setOllamaConfig] = useState(() => getOllamaConfig());
  const [installPromptEvent, setInstallPromptEvent] = useState(null);
  const [isDailyMode, setIsDailyMode] = useState(false);
  const [streak, setStreak] = useState(() => getStreak());
  const [mpSeedPuzzle, setMpSeedPuzzle] = useState(null); // puzzle handed from Browse to host
  const [autoJoinCode] = useState(() => {
    try { const c = new URLSearchParams(window.location.search).get('join'); return c && /^\d{5}$/.test(c) ? c : null; } catch { return null; }
  });
  const [showAuth, setShowAuth] = useState(false);
  const [soundOn, setSoundOnState] = useState(() => isSoundOn());
  const [soundVolume, setSoundVolumeState] = useState(() => getVolume());
  const auth = useAuth();

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    setSoundOnState(next);
    if (next) sfx.toggle(); // audible confirmation that it is on
  };

  // Dragging the slider previews at the new level, which is the only way to judge it.
  const changeVolume = (v) => {
    setVolume(v);
    setSoundVolumeState(v);
    sfx.type();
  };

  const puzzleFileInputRef = useRef(null);
  const playTimerRef = useRef(null);
  const workerRef = useRef(null);
  const restoredRef = useRef(false);
  // Set by handleDaily, read and cleared by startPlayMode, so only a solve that actually
  // came from Today's Puzzle can earn the streak.
  const dailyRequestRef = useRef(false);
  // Signature of the last Create fill, so Regenerate can tell when it produced the same
  // grid again and try once more with a different seed.
  const lastFillSigRef = useRef('');
  // Where the puzzle being played came from, so a finished solve can be recorded under a
  // stable identity rather than an anonymous hash.
  const playMetaRef = useRef(null);
  const solveRecordedRef = useRef(false);
  const resultShownRef = useRef(false);

  // =========== LOGGING ============
  // Helper to log debug messages
  // Only logs if debugMode is enabled
  const log = (message) => {
    if (debugMode) {
      setDebugLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${message}`]);
    }
  };

  // ========= DATE INFO (for Create tab) =========
  const rebuildPuzzleDateInfo = useCallback((list) => {
    const map = new Map();
    list.forEach(item => {
      if (!item?.word) return;
      const key = item.word.toUpperCase();
      const date = item.date || '';
      const day = item.day || '';
      const difficulty = item.difficulty || '';
      const formatted = date ? (day ? `${date} (${day})` : date) : '';
      const entry = { clue: item.clue || '', date, day, formatted, difficulty };
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(entry);
    });
    setPuzzleDateInfo(map);
  }, []);

  useEffect(() => {
    rebuildPuzzleDateInfo(words);
  }, [words, rebuildPuzzleDateInfo]);

  const getDateInfoForWord = useCallback((word) => {
    if (!word) return null;
    const list = puzzleDateInfo.get(word.toUpperCase());
    return list && list.length > 0 ? list[0] : null;
  }, [puzzleDateInfo]);

  const getDateInfoForWordClue = useCallback((word, clue) => {
    if (!word) return null;
    const list = puzzleDateInfo.get(word.toUpperCase());
    if (!list || list.length === 0) return null;
    if (clue) {
      const match = list.find(entry => entry.clue === clue);
      if (match) return match;
    }
    return list[0];
  }, [puzzleDateInfo]);

  const hasWordInGrid = useCallback((gridData, layoutIdx, word) => {
    if (!gridData || !word) return false;
    const layout = layouts[layoutIdx]?.grid;
    if (!layout) return false;
    const slots = findSlots(layout);
    const target = word.toUpperCase();
    for (const slot of slots) {
      const w = getWordFromGrid(gridData, slot.row, slot.col, slot.length, slot.direction);
      if (w && w.length === slot.length && w.toUpperCase() === target) {
        return true;
      }
    }
    return false;
  }, [layouts]);

  const computePlacedRequired = useCallback((gridData, layoutIdx, requiredList = []) => {
    const placed = [];
    requiredList.forEach(w => {
      if (hasWordInGrid(gridData, layoutIdx, w)) placed.push(w.toUpperCase());
    });
    return placed;
  }, [hasWordInGrid]);

  const difficultyValueFromText = (difficulty = '') => {
    const d = difficulty.toUpperCase();
    if (d === 'EASY') return 0.0;
    if (d === 'FAIR') return 0.3;
    if (d === 'MODERATE') return 0.5;
    if (d === 'HARD') return 0.7;
    if (d === 'DIFFICULT') return 1.0;
    return 0.5;
  };

  const computePuzzleDifficulty = useCallback((gridData, clueSet) => {
    if (!gridData || !clueSet) return { score: null, label: '' };
    const allClues = [...(clueSet.across || []), ...(clueSet.down || [])];
    let total = 0;
    let count = 0;
    for (const clue of allClues) {
      const word = clue.word || getWordFromGrid(gridData, clue.row, clue.col, clue.length, clue.direction || clue.slot?.direction || 'across');
      if (!word) continue;
      if (word.includes('_') || word.includes(null)) continue;
      const info = getDateInfoForWordClue(word.toUpperCase(), clue.clue) || getDateInfoForWord(word.toUpperCase());
      const val = difficultyValueFromText(info?.difficulty || clue.difficulty || '');
      total += val;
      count += 1;
    }
    if (count === 0) return { score: null, label: '' };
    const avg = total / count;
    return { score: avg * 100, label: difficultyLabelFromScore(avg) };
  }, [getDateInfoForWord, getDateInfoForWordClue]);

  useEffect(() => {
    let info = { score: null, label: '' };
    if (activeTab === 'play' && playAnswers && playClues) {
      info = computePuzzleDifficulty(playAnswers, playClues);
    } else if (activeTab === 'create' && manualGrid && manualClues) {
      info = computePuzzleDifficulty(manualGrid, manualClues);
    } else if (grid && clues) {
      info = computePuzzleDifficulty(grid, clues);
    }
    setDifficultyInfo(info);
  }, [activeTab, playAnswers, playClues, manualGrid, manualClues, grid, clues, computePuzzleDifficulty]);

  // Clear failed highlight if the word is no longer present in the current grid
  useEffect(() => {
    if (!failedWord) return;
    const currentGrid = activeTab === 'auto' ? grid : manualGrid;
    const layoutIdx = activeTab === 'auto' ? selectedLayoutIndex : currentLayoutIndex;
    if (!hasWordInGrid(currentGrid, layoutIdx, failedWord)) {
      setFailedWord(null);
    }
  }, [failedWord, grid, manualGrid, activeTab, selectedLayoutIndex, currentLayoutIndex, hasWordInGrid]);

  const handleRequiredConfirm = (wordsList, mode, difficulty) => {
    const chosenMode = mode || 'anchor';
    // setDifficultyChoice does not land before the generate call below runs, so the
    // choice has to be threaded through explicitly. Reading difficultyChoice here meant
    // the selector appeared to work only on the second attempt.
    const chosenDifficulty = difficulty || difficultyChoice;
    if (difficulty) setDifficultyChoice(difficulty);
    setRequiredWords(wordsList);
    setRequiredMode(chosenMode);
    setShowRequiredModal(false);
    if (requiredAction === 'play') {
      handleAutoGeneratePlayInternal(wordsList, chosenMode, chosenDifficulty);
    } else {
      handleAutoGenerateInternal(wordsList, chosenMode, chosenDifficulty);
    }
  };

  /**
   * Fill the Create grid.
   *
   * mode 'fill'       — keep every letter already on the grid and fill only the blanks.
   * mode 'regenerate' — keep only the author's pinned letters and reroll everything else.
   *
   * @param {'fill'|'regenerate'} opts.mode
   * @param {number|null} opts.seed  explicit seed, so a retry can force a different fill
   */
  const generateManualFill = async (wordList = words, requiredWordsList = [], requiredModeInput = 'opportunistic', opts = {}) => {
    const { mode = 'fill', seed: seedArg = null } = opts;
    if (!manualGrid) { setError('Create a grid first'); return; }
    if (wordList.length === 0) { setError('Please upload a CSV file first'); return; }
    if (!layouts[currentLayoutIndex]) { setError('Please select a valid layout'); return; }
    
    cancelRef.current = false;
    setIsGenerating(true);
    setFailedWord(null);
    setProgress('Filling remaining slots...');
    setError('');
    
    const layout = layouts[currentLayoutIndex].grid;
    // 'fill' treats every letter on the grid as fixed. 'regenerate' keeps only what the
    // author pinned, so the solver is free to replace its own previous answers — which is
    // the whole point: before this there was no way to ask for another fill without
    // either losing your own words or getting the identical grid back.
    const keepAll = mode !== 'regenerate';
    const presetGrid = manualGrid.map((row, r) => row.map((cell, c) => {
      if (cell === '#') return '#';
      if (!cell) return null;
      if (!keepAll && !lockedCells.has(cellKey(r, c))) return null;
      return cell.toUpperCase();
    }));
    
    // A clue may only be re-pinned to the slot it was written for. clueIndex returns a
    // preset verbatim for whatever word now occupies the slot, so sending a clue whose
    // answer has changed under it drags the old clue onto the new entry (THEME's
    // "Unifying idea" ending up on THREE). manualClues[].word records the answer the
    // clue was assigned to, but ordinary typing edits the grid without touching it —
    // so the letters currently in manualGrid are the source of truth for "unchanged".
    const presetClues = {};
    const addPresetClue = (c, direction) => {
      if (!c.clue) return;
      const current = getWordFromGrid(presetGrid, c.row, c.col, c.length, direction);
      if (current.length !== c.length) return;                          // slot no longer complete
      if (c.word && current !== c.word.toUpperCase()) return;           // answer changed under the clue
      // On a regenerate the answer is only guaranteed to survive where every square of the
      // slot is pinned. Anywhere else the solver may replace the word, and re-pinning the
      // old clue would drag it onto a different answer.
      if (!keepAll && !slotFullyLocked({ row: c.row, col: c.col, length: c.length, direction })) return;
      presetClues[`${direction}-${c.row}-${c.col}`] = c.clue;
    };
    manualClues.across.forEach(c => addPresetClue(c, 'across'));
    manualClues.down.forEach(c => addPresetClue(c, 'down'));
    const requiredMerged = requiredWordsList.map(w => w.toUpperCase());

    // Fully-filled squares are passed through as presetGrid; the solver injects any
    // off-dictionary entries itself and constrains around them, so there is no longer a
    // hand-built word list to assemble here.
    const result = await generateCrossword(
      layout,
      setProgress,
      solveBudgetMs(layout),
      presetGrid,
      requiredMerged,
      requiredModeInput,
      presetClues,
      difficultyTargetOf(difficultyChoice),
      seedArg,
    );

    let picked = result;
    if (result?.grid) {
      const numberedTmp = assignNumbers(result.placements || []);
      const tmpClues = {
        across: numberedTmp.filter(n => n.direction === 'across').sort((a, b) => a.number - b.number),
        down: numberedTmp.filter(n => n.direction === 'down').sort((a, b) => a.number - b.number)
      };
      picked = {
        ...result,
        cluesObj: tmpClues,
        // difficultyPercentile places the puzzle within what THIS word list can
        // actually produce; the raw score is on an absolute scale the corpus only
        // sparsely populates, so a grid at the easy end of the achievable range would
        // otherwise still be labelled "Moderate".
        difficultyMeta: result.difficultyPercentile != null
          ? {
            score: result.difficultyPercentile,
            label: difficultyLabelFromScore(result.difficultyPercentile / 100),
          }
          : result.difficultyScore != null
            ? { score: result.difficultyScore, label: difficultyLabelFromScore(result.difficultyScore / 100) }
            : computePuzzleDifficulty(result.grid, tmpClues),
      };
    }

    const newGrid = picked?.grid || presetGrid;
    const placements = picked?.placements || [];
    const complete = picked?.complete || false;
    const solveFailedWord = picked?.failedWord || null;
    const generatedClues = picked?.cluesObj || (() => {
      const numbered = assignNumbers(placements || []);
      return {
        across: numbered.filter(n => n.direction === 'across').sort((a, b) => a.number - b.number),
        down: numbered.filter(n => n.direction === 'down').sort((a, b) => a.number - b.number)
      };
    })();
    
    if (cancelRef.current) {
      setIsGenerating(false);
      setProgress('Stopped. Best partial grid shown.');
    }

    const finalGrid = newGrid || presetGrid;
    setManualGrid(finalGrid);
    lastFillSigRef.current = gridSignature(finalGrid);
    startCooldown();
    
    const placementMap = new Map();
    (placements || []).forEach(p => {
      placementMap.set(`${p.slot.direction}-${p.slot.row}-${p.slot.col}`, p);
    });
    
    const updateClueList = (list, direction) => list.map(clue => {
      const word = getWordFromGrid(finalGrid, clue.row, clue.col, clue.length, direction);
      const placement = placementMap.get(`${direction}-${clue.row}-${clue.col}`);
      return { 
        ...clue, 
        word, 
        clue: clue.clue || placement?.clue || clue.clue || '' 
      };
    });
    
    const newManualClues = generatedClues?.across ? generatedClues : {
      across: updateClueList(manualClues.across, 'across'),
      down: updateClueList(manualClues.down, 'down')
    };
    setManualClues(newManualClues);
    setLatestGrid(finalGrid);
    setLatestClues(newManualClues);
    const placedReq = computePlacedRequired(finalGrid, currentLayoutIndex, requiredMerged);
    setRequiredHighlights(new Set(placedReq));
    setShowRequiredHighlights(placedReq.length > 0);
    setHighlightMissingRequired(true);
    
    if (complete) {
      setProgress('Filled all remaining slots!');
      setTimeout(() => setProgress(''), 3000);
      setFailedWord(null);
    } else {
      const slots = findSlots(layout);
      const filled = placements ? placements.length : 0;
      setProgress(`Stopped with best result: ${filled}/${slots.length} slots filled. You can keep editing and run again.`);
      // Preflight refusals (DUPLICATE_PRESET_WORD, TOO_MANY_CUSTOM_WORDS,
      // REQUIRED_WORD_NO_SLOT, INSUFFICIENT_WORDS_FOR_LENGTH, NO_CORPUS…) name the
      // actual blocker. Surface them the way generatePuzzle does instead of collapsing
      // every one into the generic "current letters" line.
      const solverMessage = picked?.error?.message;
      if (solverMessage) setError(solverMessage);
      else if (filled === 0) setError('Could not place additional words with the current letters.');
      const lastPlaced = placements?.length ? placements[placements.length - 1]?.word : null;
      setFailedWord(lastPlaced || solveFailedWord || null);
    }
    
    setIsGenerating(false);
  };
  
  /**
   * A rebus square holds several letters, but the solver reasons a letter at a time: its
   * preset reader tests each square against /^[A-Z]$/, so a square holding JAM is not a
   * valid constraint and every entry through it becomes unsatisfiable. Rather than let that
   * surface as a mystifying "couldn't fill this grid", say what is actually in the way.
   * This matches how constructors work anyway — fill first, add the rebus afterwards.
   */
  const blockedByRebus = () => {
    const squares = rebusSquares();
    if (!squares.length) return false;
    setError(`Automatic fill can't run while the grid has ${squares.length} rebus `
      + `${squares.length === 1 ? 'square' : 'squares'} — the solver works one letter at a `
      + 'time. Fill the grid first, then add the rebus squares.');
    return true;
  };

  const handleManualGenerate = () => {
    if (onCooldown || isGenerating) return;
    if (blockedByRebus()) return;
    const manualRequired = parseWordListInput(manualRequiredInput);
    generateManualFill(words, manualRequired, manualRequiredMode || 'opportunistic', { mode: 'fill' });
  };

  /**
   * Reroll the unpinned part of the Create grid.
   *
   * The worker already picks a fresh random seed per run, but the solver draws most of its
   * candidates from the top of the ranked corpus, so a new seed can still land on the same
   * answers. When that happens, try once more with another seed rather than handing back an
   * identical grid and looking broken.
   */
  const handleManualRegenerate = async () => {
    if (onCooldown || isGenerating) return;
    if (blockedByRebus()) return;
    const manualRequired = parseWordListInput(manualRequiredInput);
    const before = gridSignature(manualGrid);
    await generateManualFill(words, manualRequired, manualRequiredMode || 'opportunistic',
      { mode: 'regenerate', seed: (Math.random() * 0x7fffffff) | 0 });
    if (lastFillSigRef.current && lastFillSigRef.current === before && !cancelRef.current) {
      await generateManualFill(words, manualRequired, manualRequiredMode || 'opportunistic',
        { mode: 'regenerate', seed: (Math.random() * 0x7fffffff) | 0 });
      if (lastFillSigRef.current === before) {
        // Worth saying out loud rather than leaving the author clicking a button that
        // appears to do nothing: a tightly-crossed grid can have very few valid fills.
        setProgress('That is the only fill this grid allows — unpin a square or two for more variety.');
      }
    }
  };

  const normalizeLayoutGrid = (gridData) => gridData.map(row => Array.isArray(row) ? row.join('') : row);

  const handleSaveLayout = (name, gridData) => {
    const normalizedGrid = normalizeLayoutGrid(gridData);
    let updatedLayouts = layouts;

    if (layoutEditorMode === 'edit' && editingLayoutIndex !== null) {
      // The re-init used to be gated on being ON the Create tab, which left manualGrid —
      // and now the pinned-square coordinates — describing the OLD shape while every slot
      // lookup read the new one. Gate it on the shape actually changing instead, so a
      // rename leaves the author's work alone but a real edit rebuilds the grid.
      const shapeChanged = (layouts[editingLayoutIndex]?.grid || []).join('|') !== normalizedGrid.join('|');
      updatedLayouts = layouts.map((layout, idx) => idx === editingLayoutIndex ? { ...layout, name, grid: normalizedGrid } : layout);
      setLayouts(updatedLayouts);
      setSelectedLayoutIndex(editingLayoutIndex);
      setCurrentLayoutIndex(editingLayoutIndex);
      if (shapeChanged || activeTab === 'create') initializeManualGrid(editingLayoutIndex, updatedLayouts);
    } else {
      updatedLayouts = [...layouts, { name, grid: normalizedGrid }];
      const newIndex = updatedLayouts.length - 1;
      setLayouts(updatedLayouts);
      setSelectedLayoutIndex(newIndex);
      setCurrentLayoutIndex(newIndex);
      // A brand-new layout always has a new shape, so this is unconditional.
      initializeManualGrid(newIndex, updatedLayouts);
    }

    return true;
  };

  const openCreateLayoutModal = () => {
    setLayoutEditorMode('create');
    setEditingLayoutIndex(null);
    setShowLayoutModal(true);
  };

  const openEditLayoutModal = () => {
    setLayoutEditorMode('edit');
    setEditingLayoutIndex(layoutIndexForTab);
    setShowLayoutModal(true);
  };

  const handleSelectLayout = (layoutIdx, tab = activeTab) => {
    if (!layouts[layoutIdx]) return;
    if (tab === 'create') {
      initializeManualGrid(layoutIdx);
    } else {
      setSelectedLayoutIndex(layoutIdx);
    }
    setShowLayoutSelector(false);
  };


  // ============ WAVE FUNCTION COLLAPSE - CROSSWYRD STYLE (OPTIMIZED) ============
  // With frequent yields to prevent "Page Unresponsive" popup
  // Uses backtracking with state saving/restoring
  // Returns { grid, placements, attempts, complete }
  // - grid: 2D array of characters (null for empty, '#' for black)
  // - placements: array of { slot, word, clue }
  // - attempts: number of WFC attempts made
  //  - complete: boolean indicating if puzzle is fully filled
  // - onProgress: callback(progressString)
  // - shouldCancel: function that returns true if generation should be cancelled
  // - wordList: array of { word, clue }
  // - layout: 2D array of characters ('#' for black, '.' for white)
  // - Uses Maps and Sets for performance
  // - Highly optimized for performance and responsiveness
  // - Implements advanced constraint propagation and backtracking
  // - Randomizes word selection to improve variety
  // - Yields frequently to keep UI responsive
  
  // Runs the crossword solver in a Web Worker so the UI stays responsive and
  // the solver can run flat-out (no setTimeout yields). Same return shape as
  // before; the 4th argument is now the time budget in ms. Cancellation is
  // driven by cancelRef plus terminating the worker.
  // One persistent worker for the whole session. It owns the corpus and its bitset
  // index, so a generation sends only the layout and constraints. The previous version
  // spawned a fresh Worker per call and structured-cloned all 552k word rows into it —
  // three times per click when a difficulty band was selected.
  const pendingRef = useRef(null);
  const clueDataPendingRef = useRef(null);
  const clueDataSeqRef = useRef(0);
  const corpusFpRef = useRef(null);

  const ensureWorker = () => {
    if (workerRef.current) return workerRef.current;
    const w = new Worker(new URL('./worker/crosswordWorker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      // Clue data has its own channel so it can't be mistaken for solver progress.
      if (e.data?.type === 'clueDataResult') { clueDataPendingRef.current?.fn(e.data.data); return; }
      pendingRef.current?.(e.data);
    };
    w.onerror = () => { pendingRef.current?.({ type: 'error', message: 'The solver failed to start.' }); };
    workerRef.current = w;
    return w;
  };

  const killWorker = () => {
    try { workerRef.current?.terminate(); } catch { /* ignore */ }
    workerRef.current = null;
    corpusFpRef.current = null;
    pendingRef.current = null;
  };

  // Describes where the worker should get its words: the packed artifact by default,
  // or the in-memory rows when the user uploaded a CSV / switched to Tagalog.
  const corpusRequest = useCallback(() => (
    usingCustomWords
      ? { rows: words, sourceTag: tagalogMode ? 'tagalog' : 'custom' }
      : { url: `${import.meta.env.BASE_URL || '/'}corpus/corpus.bin` }
  ), [usingCustomWords, words, tagalogMode]);

  /**
   * How long to let a fill run, by area. A flat 15s was fine when every layout was 15x15
   * or 5x5; a 21x21 has nearly twice the squares and 134 entries, and a Sunday that needs
   * 1.2s on this machine could need well past 15s on a slower one. Floor at the old value
   * so nothing small got faster, cap so a hopeless grid still fails while you are watching.
   */
  const solveBudgetMs = (layout) => {
    const cells = (layout?.length || 15) * (layout?.[0]?.length || 15);
    return Math.min(60000, Math.max(15000, Math.round(15000 * (cells / 225))));
  };

  const generateCrossword = (layout, onProgress, timeoutMs = 10000, presetGrid = null, requiredWordsList = [], requiredModeArg = 'anchor', presetClues = {}, difficultyTarget = null, seed = null) =>
    new Promise((resolve) => {
      const emptyResult = {
        grid: null, placements: [], requiredPlaced: 0, attempts: 0,
        failedWord: null, complete: false, error: null,
      };
      let worker;
      try {
        worker = ensureWorker();
      } catch {
        resolve({ ...emptyResult, error: { code: 'NO_WORKER', message: 'Your browser blocked the solver worker.' } });
        return;
      }

      let best = null;
      let settled = false;
      let askedForCorpus = false;

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearInterval(poll);
        pendingRef.current = null;
        resolve(result || best || emptyResult);
      };

      const sendStart = () => worker.postMessage({
        type: 'start',
        payload: {
          layout, timeoutMs, presetGrid, requiredWordsList, requiredModeArg, presetClues,
          difficultyTarget, seed, corpusFingerprint: corpusFpRef.current,
        },
      });

      pendingRef.current = (msg) => {
        if (msg.type === 'progress') onProgress(msg.text);
        else if (msg.type === 'best') best = msg.result;
        else if (msg.type === 'done') finish(msg.result);
        else if (msg.type === 'corpusReady') { corpusFpRef.current = msg.fingerprint; sendStart(); }
        else if (msg.type === 'needCorpus') {
          if (askedForCorpus) { finish({ ...emptyResult, error: { code: 'NO_CORPUS', message: 'Could not load the word list.' } }); return; }
          askedForCorpus = true;
          worker.postMessage({ type: 'loadCorpus', payload: corpusRequest() });
        } else if (msg.type === 'error') {
          finish(best || { ...emptyResult, error: { code: 'SOLVER_ERROR', message: msg.message } });
        }
      };

      const poll = setInterval(() => {
        if (cancelRef.current) {
          worker.postMessage({ type: 'cancel' });
          finish(best);
        }
      }, 60);

      if (corpusFpRef.current) sendStart();
      else {
        askedForCorpus = true;
        worker.postMessage({ type: 'loadCorpus', payload: corpusRequest() });
      }
    });

  const handleFileUpload = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setCsvLoading(true);
    setProgress('Loading CSV...');
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = parseCSV(event.target.result);
        if (parsed.length === 0) { setError('No valid words found in CSV'); return; }
        setWords(parsed);
        setUsingCustomWords(true);
        corpusFpRef.current = null;
        setError('');
        if (activeTab === 'auto') generatePuzzle();
      } catch (err) { setError('Error parsing CSV: ' + err.message); }
      setCsvLoading(false);
      setProgress('');
    };
    reader.onerror = () => {
      setCsvLoading(false);
      setProgress('');
      setError('Error reading CSV file');
    };
    reader.readAsText(file);
  };

  const generatePuzzle = async (layoutIdx = selectedLayoutIndex, autoStartPlay = false, requiredWordsList = requiredWords, requiredModeInput = requiredMode, targetDifficulty = difficultyChoice, seed = null) => {
    // A solve is ~10ms warm, so without this a double-click fired two of them and the
    // slower one's result overwrote the faster one's. The buttons are disabled during the
    // cooldown, but this path is also reachable from the Required Words dialog, so it says
    // what happened rather than appearing to do nothing.
    if (isGenerating) return;
    if (cooldownUntil > Date.now()) {
      setProgress(`One puzzle at a time — try again in ${Math.ceil((cooldownUntil - Date.now()) / 1000)}s.`);
      return;
    }
    startCooldown();

    // Reset cancellation state
    cancelRef.current = false;
    setIsGenerating(true);
    setFailedWord(null);
    setProgress('Initializing...');
    setError('');
    setGrid(null); // Clear previous grid while generating
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    if (!layouts[layoutIdx]) {
      setError('Please select a valid layout');
      setIsGenerating(false);
      return;
    }
    
    const layout = layouts[layoutIdx].grid;
    const slots = findSlots(layout);
    
    const requiredMerged = requiredWordsList.map(w => w.toUpperCase());

    log(`Starting generation for ${slots.length} slots`);
    setProgress(`Searching for complete ${layout.length}x${layout[0].length} puzzle...`);
    
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // One solve, not three. Difficulty is steered inside the search by biasing value
    // ordering toward a running residual target, so a single run lands in the band;
    // re-rolling whole puzzles and picking the closest was both slower and less accurate.
    const timeoutMs = solveBudgetMs(layout);
    const result = await generateCrossword(
      layout,
      setProgress,
      timeoutMs,
      null,
      requiredMerged,
      requiredModeInput,
      {},
      difficultyTargetOf(targetDifficulty),
      seed,
    );

    let picked = result;
    if (result?.grid) {
      const numberedTmp = assignNumbers(result.placements);
      const tmpClues = {
        across: numberedTmp.filter(n => n.direction === 'across').sort((a, b) => a.number - b.number),
        down: numberedTmp.filter(n => n.direction === 'down').sort((a, b) => a.number - b.number)
      };
      picked = {
        ...result,
        cluesObj: tmpClues,
        // difficultyPercentile places the puzzle within what THIS word list can
        // actually produce; the raw score is on an absolute scale the corpus only
        // sparsely populates, so a grid at the easy end of the achievable range would
        // otherwise still be labelled "Moderate".
        difficultyMeta: result.difficultyPercentile != null
          ? {
            score: result.difficultyPercentile,
            label: difficultyLabelFromScore(result.difficultyPercentile / 100),
          }
          : result.difficultyScore != null
            ? { score: result.difficultyScore, label: difficultyLabelFromScore(result.difficultyScore / 100) }
            : computePuzzleDifficulty(result.grid, tmpClues),
      };
    }
    const newGrid = picked?.grid;
    const placements = picked?.placements || [];
    const complete = picked?.complete || false;
    const solveFailedWord = picked?.failedWord || null;
    const difficultyMeta = picked?.difficultyMeta || computePuzzleDifficulty(newGrid, clues);
    
    if (cancelRef.current) {
      setIsGenerating(false);
      setProgress('Stopped. Showing best partial grid.');
    }

    if (complete) {
      const generatedClues = picked?.cluesObj || (() => {
        const numbered = assignNumbers(placements);
        return {
          across: numbered.filter(n => n.direction === 'across').sort((a, b) => a.number - b.number), 
          down: numbered.filter(n => n.direction === 'down').sort((a, b) => a.number - b.number) 
        };
      })();
      setGrid(newGrid);
      setClues(generatedClues);
      setLatestGrid(newGrid);
      setLatestClues(generatedClues);
      setDifficultyInfo(difficultyMeta || computePuzzleDifficulty(newGrid, generatedClues));
      const placedReq = computePlacedRequired(newGrid, layoutIdx, requiredMerged);
      setRequiredHighlights(new Set(placedReq));
      setShowRequiredHighlights(placedReq.length > 0);
      setHighlightMissingRequired(true);
      // Deliberately NOT pushed into Create. This used to call syncManualFromAuto, which
      // replaced the author's hand-built grid and every clue they had written with the
      // generated puzzle, silently and with no undo. Create is its own workspace now; the
      // "Send to Create" button moves a puzzle across when that is actually wanted.
      if (autoStartPlay) {
        startPlayMode(newGrid, generatedClues, {
          meta: {
            seed,
            layoutName: layouts[layoutIdx]?.name,
            layoutIndex: layoutIdx,
            difficulty: targetDifficulty,
            corpusFingerprint: corpusFpRef.current || undefined,
            title: layouts[layoutIdx]?.name,
          },
        });
      }
      // An unreachable band must be said out loud, not silently rendered as a different
      // label. The corpus floor is real: only ~5% of answers score below 21, so a 78-entry
      // grid genuinely cannot average down to Easy however the fill is steered. Measured:
      // Easy round-trips on every small and mid grid, and lands at the bottom of Fair on
      // Standard 15x15 (21) and Sunday 21x21 (26).
      const rep = result.difficultyReport;
      if (rep && rep.onTarget === false && rep.requestedPercentile != null) {
        const wanted = difficultyLabelFromScore(rep.requestedPercentile / 100);
        const got = difficultyLabelFromScore(rep.achievedPercentile / 100);
        setProgress(`Filled all ${slots.length} slots — but this grid could not reach ${wanted}. `
          + `The closest it gets is ${got} (${rep.achievedPercentile} of 100): there are not enough `
          + `${wanted.toLowerCase()} clues in the word list for ${slots.length} answers. `
          + `A smaller grid can go easier.`);
        setTimeout(() => setProgress(''), 12000);
      } else {
        setProgress(`Success! All ${slots.length} slots filled.`);
        setTimeout(() => setProgress(''), 5000);
      }
      setFailedWord(null);
    } else if (newGrid) {
      // Stopped early - show best result
      const generatedClues = picked?.cluesObj || (() => {
        const numbered = assignNumbers(placements);
        return {
          across: numbered.filter(n => n.direction === 'across').sort((a, b) => a.number - b.number), 
          down: numbered.filter(n => n.direction === 'down').sort((a, b) => a.number - b.number) 
        };
      })();
      setGrid(newGrid);
      setClues(generatedClues);
      setLatestGrid(newGrid);
      setLatestClues(generatedClues);
      setDifficultyInfo(difficultyMeta || computePuzzleDifficulty(newGrid, generatedClues));
      const placedReq = computePlacedRequired(newGrid, layoutIdx, requiredMerged);
      setRequiredHighlights(new Set(placedReq));
      setShowRequiredHighlights(placedReq.length > 0);
      setHighlightMissingRequired(true);
      // Same as above: a partial fill is still not a reason to throw away the author's
      // work, and silently switching tabs on them compounded it.
      setProgress('');
      setError(picked?.error?.message
        || `Stopped: best result was ${placements.length}/${slots.length} slots filled. You can edit it in Create.`);
      setFailedWord(solveFailedWord || null);
    } else {
      // Cancelling before the first result arrives used to land in the branch below and
      // accuse the user's word list of having no usable lengths, sending them off to
      // audit a CSV over a button they pressed themselves.
      setProgress('');
      if (cancelRef.current) {
        setError('Stopped before anything was placed. Press Generate to try again.');
      } else {
        // Preflight refusals land here: they name the actual blocker (a 2-letter slot,
        // a required word with nowhere to go, an impossible preset) instead of leaving
        // the user staring at a spinner for two minutes.
        setError(picked?.error?.message
          || 'Could not place any words. Check that your word list has words of the right lengths.');
      }
    }
    
    setIsGenerating(false);
  };

  const handleAutoGenerateInternal = (reqWords, mode, difficulty = difficultyChoice) => {
    generatePuzzle(selectedLayoutIndex, false, reqWords, mode, difficulty);
  };
  
  const handleAutoGeneratePlayInternal = (reqWords, mode, difficulty = difficultyChoice) => {
    generatePuzzle(selectedLayoutIndex, true, reqWords, mode, difficulty);
  };

  const syncManualFromAuto = (newGrid, generatedClues, layoutIdx) => {
    if (!newGrid || !generatedClues) return;
    const layout = layouts[layoutIdx]?.grid || layouts[0]?.grid;
    if (!layout) return;
    setCurrentLayoutIndex(layoutIdx);
    setManualGrid(newGrid.map(row => row.map(cell => cell === null ? '' : cell)));
    // Every letter here came from the solver, so nothing is pinned: a Regenerate in Create
    // is free to reroll all of it.
    setLockedCells(new Set());
    setManualCircles(new Set());
    const slots = findSlots(layout);
    const numbered = [];
    const numberMap = new Map();
    let currentNumber = 1;
    const sortedSlots = [...slots].sort((a, b) => a.row !== b.row ? a.row - b.row : a.col - b.col);
    for (const slot of sortedSlots) {
      const key = `${slot.row},${slot.col}`;
      if (!numberMap.has(key)) numberMap.set(key, currentNumber++);
      const word = getWordFromGrid(newGrid, slot.row, slot.col, slot.length, slot.direction);
      const clueSource = (slot.direction === 'across' ? generatedClues.across : generatedClues.down).find(c => c.row === slot.row && c.col === slot.col);
      numbered.push({ number: numberMap.get(key), direction: slot.direction, word, clue: clueSource?.clue || '', row: slot.row, col: slot.col, length: slot.length });
    }
    setManualClues({ 
      across: numbered.filter(n => n.direction === 'across'), 
      down: numbered.filter(n => n.direction === 'down') 
    });
    setSelectedCell(null);
  };
  
  const cancelGeneration = () => {
    cancelRef.current = true;
    if (workerRef.current) {
      try { workerRef.current.postMessage({ type: 'cancel' }); } catch { killWorker(); }
    }
  };

  const exportPuzzle = () => {
    const currentGrid = activeTab === 'auto' ? grid : manualGrid;
    const currentClues = activeTab === 'auto' ? clues : manualClues;
    const layoutIdx = activeTab === 'auto' ? selectedLayoutIndex : currentLayoutIndex;
    if (!currentGrid) return;
    if (!layouts[layoutIdx]) return;
    const puzzleData = {
      version: "1.0",
      layoutIndex: layoutIdx,
      layoutName: layouts[layoutIdx].name,
      layout: layouts[layoutIdx].grid,
      grid: currentGrid,
      clues: {
        across: currentClues.across.map(c => ({ number: c.number, row: c.row, col: c.col, length: c.length || c.word?.length, word: c.word || getWordFromGrid(currentGrid, c.row, c.col, c.length, 'across'), clue: c.clue })),
        down: currentClues.down.map(c => ({ number: c.number, row: c.row, col: c.col, length: c.length || c.word?.length, word: c.word || getWordFromGrid(currentGrid, c.row, c.col, c.length, 'down'), clue: c.clue }))
      },
      // Circles and rebus squares are part of the puzzle, not decoration — a grid exported
      // without them comes back as a different puzzle.
      circles: [...manualCircles],
      hasRebus: currentGrid.some((row) => row.some((c) => c && c !== '#' && c.length > 1)),
      exportedAt: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(puzzleData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'crossword-puzzle.json';
    a.click();
    URL.revokeObjectURL(url);
  };

  const importPuzzle = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const puzzleData = JSON.parse(event.target.result);
        if (!puzzleData.grid || !puzzleData.clues) { setError('Invalid puzzle file'); return; }
        
        // Find matching layout by comparing grid patterns, or use the embedded layout
        let layoutIdx = 0;
        if (puzzleData.layout) {
          // Try to find a matching layout in our layouts array
          const importedLayoutStr = JSON.stringify(puzzleData.layout);
          const matchingIdx = layouts.findIndex(l => JSON.stringify(l.grid) === importedLayoutStr);
          if (matchingIdx !== -1) {
            layoutIdx = matchingIdx;
          } else if (puzzleData.layoutIndex !== undefined && puzzleData.layoutIndex < layouts.length) {
            // Fall back to layoutIndex if the layout pattern doesn't match but index is valid
            layoutIdx = puzzleData.layoutIndex;
          } else {
            const newLayout = { name: puzzleData.layoutName || 'Imported Layout', grid: normalizeLayoutGrid(puzzleData.layout) };
            const newIndex = layouts.length;
            setLayouts(prev => [...prev, newLayout]);
            layoutIdx = newIndex;
          }
          // If no match found, we'll use index 0 but the grid will still work since we use the actual grid data
        } else if (puzzleData.layoutIndex !== undefined && puzzleData.layoutIndex < layouts.length) {
          layoutIdx = puzzleData.layoutIndex;
        }
        
        // Store in auto tab for reference
        const importedClues = { across: puzzleData.clues.across, down: puzzleData.clues.down };
        setGrid(puzzleData.grid);
        setClues(importedClues);
        setLatestGrid(puzzleData.grid);
        setLatestClues(importedClues);
        setSelectedLayoutIndex(layoutIdx);
        
        // // Also set up play mode
        // startPlayMode(puzzleData.grid, { across: puzzleData.clues.across, down: puzzleData.clues.down });
        
        setError('');
        // setProgress(`Puzzle loaded! Click Play to start.`);
        setTimeout(() => setProgress(''), 3000);
      } catch (err) { setError('Error loading puzzle: ' + err.message); }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const importPuzzlePlay = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const puzzleData = JSON.parse(event.target.result);
        if (!puzzleData.grid || !puzzleData.clues) { setError('Invalid puzzle file'); return; }
        
        // Find matching layout by comparing grid patterns, or use the embedded layout
        let layoutIdx = 0;
        if (puzzleData.layout) {
          // Try to find a matching layout in our layouts array
          const importedLayoutStr = JSON.stringify(puzzleData.layout);
          const matchingIdx = layouts.findIndex(l => JSON.stringify(l.grid) === importedLayoutStr);
          if (matchingIdx !== -1) {
            layoutIdx = matchingIdx;
          } else if (puzzleData.layoutIndex !== undefined && puzzleData.layoutIndex < layouts.length) {
            // Fall back to layoutIndex if the layout pattern doesn't match but index is valid
            layoutIdx = puzzleData.layoutIndex;
          } else {
            const newLayout = { name: puzzleData.layoutName || 'Imported Layout', grid: normalizeLayoutGrid(puzzleData.layout) };
            const newIndex = layouts.length;
            setLayouts(prev => [...prev, newLayout]);
            layoutIdx = newIndex;
          }
          // If no match found, we'll use index 0 but the grid will still work since we use the actual grid data
        } else if (puzzleData.layoutIndex !== undefined && puzzleData.layoutIndex < layouts.length) {
          layoutIdx = puzzleData.layoutIndex;
        }
        
        // Store in auto tab for reference
        const importedClues = { across: puzzleData.clues.across, down: puzzleData.clues.down };
        setGrid(puzzleData.grid);
        setClues(importedClues);
        setLatestGrid(puzzleData.grid);
        setLatestClues(importedClues);
        setSelectedLayoutIndex(layoutIdx);
        
        // // Also set up play mode
        startPlayMode(puzzleData.grid, importedClues, {
          circles: puzzleData.circles,
          shades: puzzleData.shades,
          meta: { source: 'imported', title: puzzleData.meta?.title || puzzleData.layoutName },
        });
        
        setError('');
        setProgress(`Puzzle loaded! Click Play to start.`);
        setTimeout(() => setProgress(''), 3000);
      } catch (err) { setError('Error loading puzzle: ' + err.message); }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  const downloadPuzzle = async () => {
    const currentGrid = activeTab === 'auto' ? grid : manualGrid;
    const currentClues = activeTab === 'auto' ? clues : manualClues;
    if (!currentGrid) return;
    
    const cellSize = 36;
    const rows = currentGrid.length;
    const cols = currentGrid[0].length;
    const gridPadding = 40;
    const cluesPadding = 40;
    const lineHeight = 18;
    const clueColumnWidth = 300;
    const titleHeight = 60;
    const clueGap = 6;
    const gridWidth = cols * cellSize;
    const gridHeight = rows * cellSize;
    
    // Canvas cannot render markup, so strip the markers rather than draw them: this PNG is
    // the one export that ends up in somebody else's hands with **King** printed literally.
    const acrossCluesText = currentClues.across.map(c => `${c.number}. ${plainRich(c.clue) || '(No clue)'}`);
    const downCluesText = currentClues.down.map(c => `${c.number}. ${plainRich(c.clue) || '(No clue)'}`);
    
    const tempCanvas = document.createElement('canvas');
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.font = '13px Arial';
    
    const calculateWrappedHeight = (textArray, maxWidth, ctx) => {
      let totalHeight = 0;
      for (const text of textArray) {
        const words = text.split(' ');
        let line = '', lines = 1;
        for (const word of words) {
          const testLine = line + word + ' ';
          if (ctx.measureText(testLine).width > maxWidth - 20) { lines++; line = word + ' '; }
          else line = testLine;
        }
        totalHeight += (lines * lineHeight) + clueGap;
      }
      return totalHeight;
    };
    
    const acrossHeight = calculateWrappedHeight(acrossCluesText, clueColumnWidth, tempCtx) + 35;
    const downHeight = calculateWrappedHeight(downCluesText, clueColumnWidth, tempCtx) + 35;
    const cluesContentHeight = Math.max(acrossHeight, downHeight);
    const totalContentHeight = Math.max(gridHeight, cluesContentHeight);
    const totalWidth = gridPadding + gridWidth + cluesPadding + clueColumnWidth + cluesPadding + clueColumnWidth + gridPadding;
    const totalHeight = titleHeight + totalContentHeight + gridPadding + 20;
    
    const canvas = document.createElement('canvas');
    canvas.width = totalWidth;
    canvas.height = totalHeight;
    const ctx = canvas.getContext('2d');
    
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, totalWidth, totalHeight);
    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 24px Georgia, serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('CROSSWORD PUZZLE', totalWidth / 2, titleHeight / 2 + 10);
    
    const gridStartX = gridPadding;
    const gridStartY = titleHeight;
    
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = gridStartX + c * cellSize;
        const y = gridStartY + r * cellSize;
        const cell = currentGrid[r][c];
        if (cell === '#') {
          ctx.fillStyle = '#1a1a1a';
          ctx.fillRect(x, y, cellSize, cellSize);
        } else {
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(x, y, cellSize, cellSize);
          ctx.strokeStyle = '#c9c9c4';
          ctx.lineWidth = 1;
          ctx.strokeRect(x, y, cellSize, cellSize);
          const num = getNumberForCell(r, c, currentClues);
          if (num) {
            ctx.fillStyle = '#4a4a48';
            ctx.font = 'bold 10px Arial';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'top';
            ctx.fillText(num.toString(), x + 3, y + 2);
          }
        }
      }
    }
    
    const drawWrappedText = (text, x, startY, maxWidth) => {
      const words = text.split(' ');
      let line = '', currentY = startY;
      ctx.font = '13px Arial';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (let i = 0; i < words.length; i++) {
        const testLine = line + words[i] + ' ';
        if (ctx.measureText(testLine).width > maxWidth && i > 0) {
          ctx.fillText(line.trim(), x, currentY);
          line = words[i] + ' ';
          currentY += lineHeight;
        } else line = testLine;
      }
      ctx.fillText(line.trim(), x, currentY);
      return currentY + lineHeight;
    };
    
    const acrossStartX = gridStartX + gridWidth + cluesPadding;
    let acrossY = gridStartY;
    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 16px Georgia, serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('ACROSS', acrossStartX, acrossY);
    acrossY += 28;
    ctx.fillStyle = '#4a4a48';
    for (const clue of acrossCluesText) { acrossY = drawWrappedText(clue, acrossStartX, acrossY, clueColumnWidth - 10); acrossY += clueGap; }
    
    const downStartX = acrossStartX + clueColumnWidth + cluesPadding;
    let downY = gridStartY;
    ctx.fillStyle = '#1a1a1a';
    ctx.font = 'bold 16px Georgia, serif';
    ctx.textBaseline = 'top';
    ctx.fillText('DOWN', downStartX, downY);
    downY += 28;
    ctx.fillStyle = '#4a4a48';
    for (const clue of downCluesText) { downY = drawWrappedText(clue, downStartX, downY, clueColumnWidth - 10); downY += clueGap; }
    
    const imageUrl = canvas.toDataURL('image/png');
    const imageLink = document.createElement('a');
    imageLink.href = imageUrl;
    imageLink.download = 'crossword-puzzle.png';
    imageLink.click();
    
    setTimeout(() => {
      let answerText = 'CROSSWORD ANSWER KEY\n' + '='.repeat(30) + '\n\nACROSS\n';
      currentClues.across.forEach(c => {
        const len = c.length || c.word?.length || 0;
        let word = '';
        for (let i = 0; i < len; i++) { const row = c.row, col = c.col + i; if (currentGrid[row] && currentGrid[row][col] && currentGrid[row][col] !== '#') word += currentGrid[row][col] || '_'; }
        if (!word && c.word) word = c.word;
        answerText += `${c.number}. ${word}\n`;
      });
      answerText += '\nDOWN\n';
      currentClues.down.forEach(c => {
        const len = c.length || c.word?.length || 0;
        let word = '';
        for (let i = 0; i < len; i++) { const row = c.row + i, col = c.col; if (currentGrid[row] && currentGrid[row][col] && currentGrid[row][col] !== '#') word += currentGrid[row][col] || '_'; }
        if (!word && c.word) word = c.word;
        answerText += `${c.number}. ${word}\n`;
      });
      const blob = new Blob([answerText], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'crossword-answers.txt';
      a.click();
      URL.revokeObjectURL(url);
    }, 500);
  };

  // Share a clean, blank puzzle image (structure + numbers only, no answers)
  // via the Web Share API on mobile, falling back to a PNG download.
  const sharePuzzle = async () => {
    const currentGrid = activeTab === 'auto' ? grid : activeTab === 'play' ? playGrid : manualGrid;
    const currentClues = activeTab === 'auto' ? clues : activeTab === 'play' ? playClues : manualClues;
    if (!currentGrid || !currentGrid.length) return;
    const rows = currentGrid.length, cols = currentGrid[0].length;
    const cell = 44, pad = 24, title = 54;
    const canvas = document.createElement('canvas');
    canvas.width = pad * 2 + cols * cell;
    canvas.height = title + pad + rows * cell + 34;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#f7f7f5'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#1a1a1a'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 26px Georgia, serif';
    ctx.fillText('Krosalita', canvas.width / 2, title / 2 + 8);
    const gx = pad, gy = title;
    ctx.fillStyle = '#1a1a1a'; ctx.fillRect(gx - 2, gy - 2, cols * cell + 4, rows * cell + 4);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = gx + c * cell, y = gy + r * cell;
        if (currentGrid[r][c] === '#') { ctx.fillStyle = '#1a1a1a'; ctx.fillRect(x, y, cell, cell); }
        else {
          ctx.fillStyle = '#ffffff'; ctx.fillRect(x, y, cell, cell);
          ctx.strokeStyle = '#c9c9c4'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, cell, cell);
          const num = getCellNumber(currentClues, r, c);
          if (num) { ctx.fillStyle = '#4a4a48'; ctx.font = '500 10px Arial'; ctx.textAlign = 'left'; ctx.textBaseline = 'top'; ctx.fillText(String(num), x + 3, y + 3); }
        }
      }
    }
    ctx.fillStyle = '#8a8a86'; ctx.font = '13px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('Made with Krosalita', canvas.width / 2, gy + rows * cell + 20);

    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) return;
    const file = new File([blob], 'krosalita-puzzle.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ title: 'Krosalita crossword', text: 'Can you solve this crossword?', files: [file] });
        return;
      } catch { /* cancelled or unsupported — fall back to download */ }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'krosalita-puzzle.png'; a.click();
    URL.revokeObjectURL(url);
  };

  const getNumberForCell = (r, c, clueSet = clues) => getCellNumber(clueSet, r, c);

  const initializeManualGrid = useCallback((layoutIdx = currentLayoutIndex, layoutList = layouts) => {
    if (!layoutList[layoutIdx]) return;
    const layout = layoutList[layoutIdx].grid;
    const rows = layout.length;
    const cols = layout[0].length;
    const newGrid = Array(rows).fill(null).map((_, r) => Array(cols).fill(null).map((_, c) => layout[r][c] === '#' ? '#' : ''));
    setManualGrid(newGrid);
    setLockedCells(new Set());   // no letters left, so no pins
    setManualCircles(new Set());
    setManualRebusMode(false);
    setCurrentLayoutIndex(layoutIdx);
    const slots = findSlots(layout);
    const numbered = [];
    const numberMap = new Map();
    let currentNumber = 1;
    const sortedSlots = [...slots].sort((a, b) => a.row !== b.row ? a.row - b.row : a.col - b.col);
    for (const slot of sortedSlots) {
      const key = `${slot.row},${slot.col}`;
      if (!numberMap.has(key)) numberMap.set(key, currentNumber++);
      numbered.push({ number: numberMap.get(key), direction: slot.direction, word: '', clue: '', row: slot.row, col: slot.col, length: slot.length });
    }
    setManualClues({ across: numbered.filter(n => n.direction === 'across'), down: numbered.filter(n => n.direction === 'down') });
    setSelectedCell(null);
  }, [currentLayoutIndex, layouts]);

  const handleCellClick = (r, c) => {
    if (manualGrid[r][c] === '#') return;
    const layout = layouts[currentLayoutIndex]?.grid;
    if (!layout) return;
    const slots = findSlots(layout);
    const acrossSlot = slots.find(s => s.direction === 'across' && s.row === r && c >= s.col && c < s.col + s.length);
    const downSlot = slots.find(s => s.direction === 'down' && s.col === c && r >= s.row && r < s.row + s.length);
    if (selectedCell?.row === r && selectedCell?.col === c) {
      if (selectedDirection === 'across' && downSlot) setSelectedDirection('down');
      else if (selectedDirection === 'down' && acrossSlot) setSelectedDirection('across');
    } else {
      setSelectedCell({ row: r, col: c });
      if (acrossSlot) setSelectedDirection('across');
      else if (downSlot) setSelectedDirection('down');
    }
  };

  const isFormElement = (el) => {
    if (!el) return false;
    const tag = el.tagName?.toLowerCase();
    // 'button' is deliberately NOT here. The keydown handler is bound to the root
    // tabIndex=0 div, so e.target is whichever button last took focus — counting buttons
    // as form elements killed typing and the arrow keys after every click on a clue,
    // Check, Reveal or Pause until the user clicked a grid square again.
    return ['input', 'textarea', 'select'].includes(tag) || el.isContentEditable;
  };

  // ---- author-locked squares -------------------------------------------------------
  const cellKey = (r, c) => `${r},${c}`;

  const lockCell = (r, c) => setLockedCells((prev) => {
    const next = new Set(prev);
    next.add(cellKey(r, c));
    return next;
  });

  const unlockCell = (r, c) => setLockedCells((prev) => {
    if (!prev.has(cellKey(r, c))) return prev;
    const next = new Set(prev);
    next.delete(cellKey(r, c));
    return next;
  });

  const toggleCellLock = (r, c) => {
    if (!manualGrid || manualGrid[r]?.[c] === '#' || !manualGrid[r]?.[c]) return;
    if (lockedCells.has(cellKey(r, c))) unlockCell(r, c); else lockCell(r, c);
  };

  /**
   * Pin or unpin every filled square of the current word. Authors think in words, not
   * squares, so this is the control that gets used; the per-square toggle is the escape
   * hatch for a single crossing letter.
   */
  const toggleCurrentWordLock = () => {
    const { slot } = getCurrentWord();
    if (!slot || !manualGrid) return;
    const cells = [];
    for (let i = 0; i < slot.length; i++) {
      const r = slot.direction === 'across' ? slot.row : slot.row + i;
      const c = slot.direction === 'across' ? slot.col + i : slot.col;
      if (manualGrid[r]?.[c] && manualGrid[r][c] !== '#') cells.push(cellKey(r, c));
    }
    if (!cells.length) return;
    const allPinned = cells.every((k) => lockedCells.has(k));
    setLockedCells((prev) => {
      const next = new Set(prev);
      cells.forEach((k) => (allPinned ? next.delete(k) : next.add(k)));
      return next;
    });
  };

  /** Compact fingerprint of a filled grid, for "did the regenerate actually change it?". */
  const gridSignature = (g) => (g || []).map((row) => row.map((c) => c || '.').join('')).join('/');

  const toggleManualCircle = (r, c) => {
    if (!manualGrid || manualGrid[r]?.[c] === '#') return;
    setManualCircles((prev) => {
      const next = new Set(prev);
      const k = cellKey(r, c);
      if (next.has(k)) next.delete(k); else next.add(k);
      return next;
    });
  };

  /** Squares holding more than one letter. The solver works a letter at a time, so these
   *  are the squares an automatic fill cannot reason about. */
  const rebusSquares = () => {
    const out = [];
    if (!manualGrid) return out;
    manualGrid.forEach((row, r) => row.forEach((cell, c) => {
      if (cell && cell !== '#' && cell.length > 1) out.push(cellKey(r, c));
    }));
    return out;
  };

  /** Release every pin without deleting a letter, so Regenerate may reroll the whole grid. */
  const unpinAll = () => setLockedCells(new Set());

  /** True when every square of a slot is pinned — the only case where its clue is safe. */
  const slotFullyLocked = (slot, locks = lockedCells) => {
    for (let i = 0; i < slot.length; i++) {
      const r = slot.direction === 'across' ? slot.row : slot.row + i;
      const c = slot.direction === 'across' ? slot.col + i : slot.col;
      if (!locks.has(cellKey(r, c))) return false;
    }
    return true;
  };

  const cooldownLeft = Math.max(0, Math.ceil((cooldownUntil - Date.now()) / 1000));
  const onCooldown = cooldownLeft > 0;

  // Only ticks while a cooldown is actually running, so there is no idle timer.
  React.useEffect(() => {
    if (cooldownUntil <= Date.now()) return;
    const id = setInterval(() => setNowTick((t) => t + 1), 250);
    return () => clearInterval(id);
  }, [cooldownUntil]);

  const GENERATE_COOLDOWN_MS = 2000;
  const startCooldown = () => setCooldownUntil(Date.now() + GENERATE_COOLDOWN_MS);

  const parseWordListInput = (inputText) => inputText
    .split(',')
    .map(w => w.trim().toUpperCase().replace(/[^A-Z]/g, ''))
    .filter(Boolean);

  // Core Create-grid input — shared by the physical keyboard and the on-screen keyboard.
  const applyManualKey = (key) => {
    if (!selectedCell || !manualGrid) return;
    const { row, col } = selectedCell;
    if (key === 'Enter') { setManualRebusMode(false); return; }

    // In rebus mode backspace trims the square rather than clearing it outright.
    if (manualRebusMode && key === 'Backspace') {
      const cur = manualGrid[row][col] && manualGrid[row][col] !== '#' ? manualGrid[row][col] : '';
      if (cur.length > 1) {
        const newGrid = manualGrid.map(r => [...r]);
        newGrid[row][col] = cur.slice(0, -1);
        setManualGrid(newGrid);
        sfx.erase();
        return;
      }
    }

    if (key === 'Backspace') {
      const newGrid = manualGrid.map(r => [...r]);
      if (newGrid[row][col]) {
        newGrid[row][col] = '';
        setManualGrid(newGrid);
        unlockCell(row, col);       // deleting a letter releases its pin
        sfx.erase();
      } else if (selectedDirection === 'across' && col > 0 && manualGrid[row][col - 1] !== '#') {
        newGrid[row][col - 1] = '';
        setManualGrid(newGrid);
        setSelectedCell({ row, col: col - 1 });
        unlockCell(row, col - 1);
        sfx.erase();
      } else if (selectedDirection === 'down' && row > 0 && manualGrid[row - 1][col] !== '#') {
        newGrid[row - 1][col] = '';
        setManualGrid(newGrid);
        setSelectedCell({ row: row - 1, col });
        unlockCell(row - 1, col);
        sfx.erase();
      }
      return;
    }
    // Rebus: letters pile into the current square instead of advancing, so one square can
    // hold JAM. Enter leaves the mode. The cap matches the play-mode one.
    if (manualRebusMode && key.length === 1 && /[a-zA-Z]/.test(key)) {
      const cur = manualGrid[row][col] && manualGrid[row][col] !== '#' ? manualGrid[row][col] : '';
      const newGrid = manualGrid.map(r => [...r]);
      newGrid[row][col] = (cur + key.toUpperCase()).slice(0, 8);
      setManualGrid(newGrid);
      lockCell(row, col);
      sfx.type();
      return;
    }

    if (key.length === 1 && /[a-zA-Z]/.test(key)) {
      const newGrid = manualGrid.map(r => [...r]);
      newGrid[row][col] = key.toUpperCase();
      setManualGrid(newGrid);
      // Typed by the author, so pinned: Regenerate must leave it alone.
      lockCell(row, col);
      sfx.type();
      if (selectedDirection === 'across' && col < manualGrid[0].length - 1 && manualGrid[row][col + 1] !== '#') setSelectedCell({ row, col: col + 1 });
      else if (selectedDirection === 'down' && row < manualGrid.length - 1 && manualGrid[row + 1][col] !== '#') setSelectedCell({ row: row + 1, col });
      return;
    }
    if (key === 'ArrowRight' && col < manualGrid[0].length - 1 && manualGrid[row][col + 1] !== '#') { setSelectedCell({ row, col: col + 1 }); setSelectedDirection('across'); sfx.move(); }
    else if (key === 'ArrowLeft' && col > 0 && manualGrid[row][col - 1] !== '#') { setSelectedCell({ row, col: col - 1 }); setSelectedDirection('across'); sfx.move(); }
    else if (key === 'ArrowDown' && row < manualGrid.length - 1 && manualGrid[row + 1][col] !== '#') { setSelectedCell({ row: row + 1, col }); setSelectedDirection('down'); sfx.move(); }
    else if (key === 'ArrowUp' && row > 0 && manualGrid[row - 1][col] !== '#') { setSelectedCell({ row: row - 1, col }); setSelectedDirection('down'); sfx.move(); }
  };

  const handleKeyDown = (e) => {
    if (showDictionary || showRequiredModal || showLayoutModal) return;
    if (isFormElement(e.target)) return;
    if (editingClue) return;
    if (!selectedCell || !manualGrid) return;
    if (e.key === 'Backspace' || e.key.startsWith('Arrow') || (e.key.length === 1 && /[a-zA-Z]/.test(e.key))) {
      e.preventDefault();
    }
    applyManualKey(e.key);
  };

  const getCurrentWord = () => {
    if (!selectedCell || !manualGrid) return { word: '', slot: null };
    const layout = layouts[currentLayoutIndex]?.grid;
    if (!layout) return { word: '', slot: null };
    const slots = findSlots(layout);
    const slot = slots.find(s => {
      if (s.direction !== selectedDirection) return false;
      if (s.direction === 'across') return s.row === selectedCell.row && selectedCell.col >= s.col && selectedCell.col < s.col + s.length;
      return s.col === selectedCell.col && selectedCell.row >= s.row && selectedCell.row < s.row + s.length;
    });
    if (!slot) return { word: '', slot: null };
    let word = '';
    for (let i = 0; i < slot.length; i++) {
      const r = slot.direction === 'across' ? slot.row : slot.row + i;
      const c = slot.direction === 'across' ? slot.col + i : slot.col;
      word += manualGrid[r][c] || '_';
    }
    return { word, slot };
  };

  const getClueForCurrentSlot = () => {
    const { slot } = getCurrentWord();
    if (!slot) return null;
    const clueList = slot.direction === 'across' ? manualClues.across : manualClues.down;
    return clueList.find(c => c.row === slot.row && c.col === slot.col);
  };

  const updateClue = (clueText) => {
    const { word, slot } = getCurrentWord();
    if (!slot) return;
    const direction = slot.direction;
    const clueList = direction === 'across' ? [...manualClues.across] : [...manualClues.down];
    const clueIndex = clueList.findIndex(c => c.row === slot.row && c.col === slot.col);
    if (clueIndex !== -1) {
      // Record which answer the user wrote this clue for, so generateManualFill can tell
      // later whether the slot still holds it (see addPresetClue).
      clueList[clueIndex] = { ...clueList[clueIndex], clue: clueText, word: word.includes('_') ? '' : word };
      setManualClues({ ...manualClues, [direction]: clueList });
    }
    setEditingClue(null);
    setClueInput('');
  };

  const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };

  // Answers already committed elsewhere in the grid. The solver forbids duplicate
  // entries, so offering one of these as a suggestion sets up "Generate Remaining" to
  // hard-fail with DUPLICATE_PRESET_WORD. Only fully-filled slots count — a partial
  // slot is not yet an answer.
  const answersInGrid = (excludeSlot = null) => {
    const used = new Set();
    const layout = layouts[currentLayoutIndex]?.grid;
    if (!layout || !manualGrid) return used;
    for (const s of findSlots(layout)) {
      if (excludeSlot && s.direction === excludeSlot.direction
        && s.row === excludeSlot.row && s.col === excludeSlot.col) continue;
      const w = getWordFromGrid(manualGrid, s.row, s.col, s.length, s.direction);
      if (w.length === s.length) used.add(w.toUpperCase());
    }
    return used;
  };

  const findSuggestionsForSlot = () => {
    const { word, slot } = getCurrentWord();
    if (!slot || words.length === 0) return [];

    const pattern = word.replace(/_/g, '.');
    const regex = new RegExp(`^${pattern}$`, 'i');
    const used = answersInGrid(slot);

    // Step 1: find all matches, minus answers already elsewhere in the grid
    const matches = words.filter(
      w => w.word.length === slot.length && regex.test(w.word) && !used.has(w.word.toUpperCase())
    );

    if (matches.length === 0) return [];

    // 🔀 Randomize matches first
    const shuffledMatches = shuffle(matches);

    // Step 2: group by Word (already randomized), keeping only clues that can stand
    // alone in a generated puzzle. Rows pointing at another grid ("See 63 Down") or at
    // a theme this puzzle does not have would be written straight into manualClues and
    // then re-sent as a presetClue, surviving into the export. A word whose every clue
    // is unusable is still a legal fill, so it is still offered — with an empty clue
    // rather than a poisoned one.
    const byWord = new Map();
    for (const item of shuffledMatches) {
      const key = item.word.toUpperCase();
      if (!byWord.has(key)) byWord.set(key, []);
      if (isClueUsableFor(item.clue, item.word)) byWord.get(key).push(item);
    }

    const optionsFor = (w) => {
      const list = byWord.get(w);
      return list.length ? list : [{ word: w, clue: '' }];
    };

    const uniqueWords = [...byWord.keys()];

    // Step 3: decision logic
    if (uniqueWords.length === 1) {
      // One word → show all its usable clues (already randomized)
      return shuffle(optionsFor(uniqueWords[0]));
    }

    // Multiple words → one random usable clue per word
    return shuffle(
      uniqueWords.map(w => {
        const options = optionsFor(w);
        return options[Math.floor(Math.random() * options.length)];
      })
    ).slice(0, 10);

  };


  const applySuggestion = (suggestion) => {
    const { slot } = getCurrentWord();
    if (!slot) return;
    const newGrid = manualGrid.map(r => [...r]);
    for (let i = 0; i < suggestion.word.length; i++) {
      const r = slot.direction === 'across' ? slot.row : slot.row + i;
      const c = slot.direction === 'across' ? slot.col + i : slot.col;
      newGrid[r][c] = suggestion.word[i];
    }
    setManualGrid(newGrid);
    // The author picked this word off the suggestion list, so it is theirs, not the
    // solver's — pin it like anything typed.
    setLockedCells((prev) => {
      const next = new Set(prev);
      for (let i = 0; i < suggestion.word.length; i++) {
        const r = slot.direction === 'across' ? slot.row : slot.row + i;
        const c = slot.direction === 'across' ? slot.col + i : slot.col;
        next.add(cellKey(r, c));
      }
      return next;
    });
    const direction = slot.direction;
    const clueList = direction === 'across' ? [...manualClues.across] : [...manualClues.down];
    const clueIndex = clueList.findIndex(c => c.row === slot.row && c.col === slot.col);
    if (clueIndex !== -1) {
      clueList[clueIndex] = { ...clueList[clueIndex], clue: suggestion.clue, word: suggestion.word };
      setManualClues({ ...manualClues, [direction]: clueList });
    }
    setShowSuggestions(false);
  };

  const isInCurrentWord = (r, c) => {
    if (!selectedCell) return false;
    const { slot } = getCurrentWord();
    if (!slot) return false;
    if (slot.direction === 'across') return r === slot.row && c >= slot.col && c < slot.col + slot.length;
    return c === slot.col && r >= slot.row && r < slot.row + slot.length;
  };

  // ============ PLAY MODE FUNCTIONS ============
  
  const startPlayMode = (sourceGrid, sourceClues, extras = {}) => {
    if (!sourceGrid || !sourceClues) return;

    // Only a solve that came from handleDaily counts toward the streak.
    const fromDaily = dailyRequestRef.current;
    setIsDailyMode(fromDaily);
    dailyRequestRef.current = false;

    // Everything the solve log needs to name this puzzle the same way on another device.
    playMetaRef.current = {
      ...(extras.meta || {}),
      source: extras.meta?.source || (fromDaily ? 'daily' : 'generated'),
      day: fromDaily ? todayKey() : (extras.meta?.day || undefined),
    };
    solveRecordedRef.current = false;

    // Create empty play grid (keep structure, clear letters)
    const emptyGrid = sourceGrid.map(row =>
      row.map(cell => cell === '#' ? '#' : '')
    );

    setPlayCircles(new Set(extras.circles || []));
    setPlayShades(new Set(extras.shades || []));
    setRebusMode(false);
    // Store the answers
    setPlayAnswers(sourceGrid);
    setPlayGrid(emptyGrid);
    setPlayClues(sourceClues);
    setPlaySelectedCell(null);
    setPlayDirection('across');
    setPlayComplete(false);
    setRevealedCells(new Set());
    setPlayAutoCheck(false); // start every puzzle with auto-check off
    setPlayPaused(false);
    setCheckedCells(new Set());
    setUsedAssist(false);
    setShowResult(false);
    setCleanSolve(false);
    resultShownRef.current = false;
    setPlayTimer(0);
    setPlayTimerActive(true);
    setActiveTab('play');
  };
  
  const handlePlayCellClick = (r, c) => {
    if (!playGrid || playGrid[r][c] === '#') return;
    sfx.move();
    
    if (playSelectedCell?.row === r && playSelectedCell?.col === c) {
      setPlayDirection(prev => prev === 'across' ? 'down' : 'across');
    } else {
      setPlaySelectedCell({ row: r, col: c });
    }
  };
  
  const getPlayCurrentSlot = () => {
    if (!playSelectedCell || !playGrid) return null;
    const { row, col } = playSelectedCell;
    
    // Find the slot containing this cell
    const layout = playGrid.map(r => r.map(c => c === '#' ? '#' : '.'));
    const slots = findSlots(layout);
    
    return slots.find(s => {
      if (s.direction !== playDirection) return false;
      if (s.direction === 'across') {
        return s.row === row && col >= s.col && col < s.col + s.length;
      }
      return s.col === col && row >= s.row && row < s.row + s.length;
    });
  };
  
  const isInPlayCurrentWord = (r, c) => {
    const slot = getPlayCurrentSlot();
    if (!slot) return false;
    if (slot.direction === 'across') {
      return r === slot.row && c >= slot.col && c < slot.col + slot.length;
    }
    return c === slot.col && r >= slot.row && r < slot.row + slot.length;
  };
  
  const togglePlayPause = () => {
    setPlayPaused(prev => {
      const next = !prev;
      setPlayTimerActive(!next && !playComplete);
      return next;
    });
  };

  // Core Play input — shared by the physical keyboard and the on-screen keyboard.
  const applyPlayKey = (key) => {
    if (playPaused) return; // no input while paused

    // Clue navigation (across→down→wrap) — works with or without a selection.
    if (key === 'Enter') { if (rebusMode) { setRebusMode(false); return; } goToNextClue(1); return; }
    if (key === ' ' || key === 'Tab') { goToNextClue(1); return; }
    if (key === 'ShiftTab') { goToNextClue(-1); return; }

    if (!playSelectedCell || !playGrid) return;
    const { row, col } = playSelectedCell;

    // Rebus entry: letters accumulate in the current cell, backspace trims it.
    if (rebusMode) {
      const cur = playGrid[row][col] && playGrid[row][col] !== '#' ? playGrid[row][col] : '';
      if (key === 'Backspace') {
        const newGrid = playGrid.map(r => [...r]);
        newGrid[row][col] = cur.slice(0, -1);
        setPlayGrid(newGrid);
        if (cur) sfx.erase();
        return;
      }
      if (key.length === 1 && /[a-zA-Z]/.test(key)) {
        const newGrid = playGrid.map(r => [...r]);
        newGrid[row][col] = (cur + key.toUpperCase()).slice(0, 8);
        setPlayGrid(newGrid);
        sfx.type();
        if (checkedCells.has(`${row},${col}`)) setCheckedCells(prev => { const n = new Set(prev); n.delete(`${row},${col}`); return n; });
        checkPlayComplete(newGrid);
        return;
      }
      // arrows fall through to normal navigation (and leave the rebus as typed)
    }

    if (key === 'Backspace') {
      const newGrid = playGrid.map(r => [...r]);
      if (newGrid[row][col]) {
        // clear the current cell, stay put
        newGrid[row][col] = '';
        setPlayGrid(newGrid);
        sfx.erase();
      } else if (playDirection === 'across' && col > 0 && playGrid[row][col - 1] !== '#') {
        // empty already → step back and clear
        newGrid[row][col - 1] = '';
        setPlayGrid(newGrid);
        setPlaySelectedCell({ row, col: col - 1 });
        sfx.erase();
      } else if (playDirection === 'down' && row > 0 && playGrid[row - 1][col] !== '#') {
        newGrid[row - 1][col] = '';
        setPlayGrid(newGrid);
        setPlaySelectedCell({ row: row - 1, col });
        sfx.erase();
      }
      return;
    }

    if (key.length === 1 && /[a-zA-Z]/.test(key)) {
      const wasEmpty = !playGrid[row][col];
      const newGrid = playGrid.map(r => [...r]);
      newGrid[row][col] = key.toUpperCase();
      setPlayGrid(newGrid);
      sfx.type();
      // a re-typed cell needs re-checking → drop its "checked" mark
      if (checkedCells.has(`${row},${col}`)) {
        setCheckedCells(prev => { const n = new Set(prev); n.delete(`${row},${col}`); return n; });
      }
      // Smart cursor: next empty square in the word, else first empty of the next clue.
      const slot = getPlayCurrentSlot();
      let target = null;
      if (slot) {
        const cellAt = (i) => (slot.direction === 'across' ? { row: slot.row, col: slot.col + i } : { row: slot.row + i, col: slot.col });
        const curIdx = slot.direction === 'across' ? col - slot.col : row - slot.row;
        for (let i = curIdx + 1; i < slot.length && !target; i++) { const cc = cellAt(i); if (!newGrid[cc.row][cc.col]) target = cc; }
        for (let i = 0; i < curIdx && !target; i++) { const cc = cellAt(i); if (!newGrid[cc.row][cc.col]) target = cc; }
        if (!target) {
          // word is full → jump to the first empty square of the next clue
          const layout = newGrid.map(rw => rw.map(x => (x === '#' ? '#' : '.')));
          const all = findSlots(layout);
          const byPos = (a, b) => a.row - b.row || a.col - b.col;
          const order = [
            ...all.filter(s => s.direction === playDirection).sort(byPos),
            ...all.filter(s => s.direction !== playDirection).sort(byPos),
          ];
          const firstEmpty = (s) => { for (let i = 0; i < s.length; i++) { const r = s.direction === 'across' ? s.row : s.row + i; const c = s.direction === 'across' ? s.col + i : s.col; if (!newGrid[r][c]) return { row: r, col: c }; } return null; };
          const startI = order.findIndex(s => s.direction === slot.direction && s.row === slot.row && s.col === slot.col);
          for (let k = 1; k <= order.length && !target; k++) {
            const s = order[(startI + k) % order.length];
            const cell = firstEmpty(s);
            if (cell) { target = cell; if (s.direction !== playDirection) setPlayDirection(s.direction); }
          }
        }
      }
      if (target) setPlaySelectedCell(target);
      else if (playDirection === 'across' && col < newGrid[0].length - 1 && newGrid[row][col + 1] !== '#') setPlaySelectedCell({ row, col: col + 1 });
      else if (playDirection === 'down' && row < newGrid.length - 1 && newGrid[row + 1][col] !== '#') setPlaySelectedCell({ row: row + 1, col });
      // That keypress just completed the entry → a small chime. Gated on `wasEmpty`, so
      // re-typing a letter into an already-full word stays silent. The sound is the same
      // whether the answer is right or wrong: a "that's wrong" noise here would be a free
      // Check, which is exactly the help the player chose not to ask for.
      if (wasEmpty && slot) {
        let filled = 0;
        for (let i = 0; i < slot.length; i++) {
          const rr = slot.direction === 'across' ? slot.row : slot.row + i;
          const cc = slot.direction === 'across' ? slot.col + i : slot.col;
          if (newGrid[rr][cc]) filled++;
        }
        if (filled === slot.length) sfx.wordDone();
      }
      // Check completion (even if auto-check is off, so the timer stops)
      checkPlayComplete(newGrid);
      return;
    }

    // Arrow key navigation
    if (key === 'ArrowRight' && col < playGrid[0].length - 1 && playGrid[row][col + 1] !== '#') {
      setPlaySelectedCell({ row, col: col + 1 });
      setPlayDirection('across');
      sfx.move();
    } else if (key === 'ArrowLeft' && col > 0 && playGrid[row][col - 1] !== '#') {
      setPlaySelectedCell({ row, col: col - 1 });
      setPlayDirection('across');
      sfx.move();
    } else if (key === 'ArrowDown' && row < playGrid.length - 1 && playGrid[row + 1][col] !== '#') {
      setPlaySelectedCell({ row: row + 1, col });
      setPlayDirection('down');
      sfx.move();
    } else if (key === 'ArrowUp' && row > 0 && playGrid[row - 1][col] !== '#') {
      setPlaySelectedCell({ row: row - 1, col });
      setPlayDirection('down');
      sfx.move();
    }
  };

  const handlePlayKeyDown = (e) => {
    if (showDictionary || showRequiredModal || showLayoutModal) return;
    if (isFormElement(e.target)) return;
    if (activeTab !== 'play' || !playGrid) return;
    const navKey = e.key === 'Enter' || e.key === ' ' || e.key === 'Tab';
    if (e.key === 'Backspace' || e.key.startsWith('Arrow') || navKey || (e.key.length === 1 && /[a-zA-Z]/.test(e.key))) {
      e.preventDefault();
    }
    applyPlayKey(e.key === 'Tab' && e.shiftKey ? 'ShiftTab' : e.key);
  };

  // Jump the selection to the next/previous clue in global order: all across
  // (by number), then all down, wrapping. Enter/Space/Tab and ‹ › use this.
  const goToNextClue = (delta = 1) => {
    if (!playClues) return;
    const across = (playClues.across || []).map(cl => ({ row: cl.row, col: cl.col, dir: 'across' }));
    const down = (playClues.down || []).map(cl => ({ row: cl.row, col: cl.col, dir: 'down' }));
    const list = [...across, ...down];
    if (!list.length) return;
    const slot = getPlayCurrentSlot();
    let idx = slot ? list.findIndex(c => c.dir === playDirection && c.row === slot.row && c.col === slot.col) : -1;
    if (idx === -1) idx = delta > 0 ? -1 : 0;
    const nx = ((idx + delta) % list.length + list.length) % list.length;
    const target = list[nx];
    setPlayDirection(target.dir);
    setPlaySelectedCell({ row: target.row, col: target.col });
  };
  const goToAdjacentClue = goToNextClue; // arrows now cross across↔down too
  
  const checkPlayComplete = (currentGrid) => {
    if (!playAnswers) return;
    
    for (let r = 0; r < currentGrid.length; r++) {
      for (let c = 0; c < currentGrid[r].length; c++) {
        if (currentGrid[r][c] !== '#' && currentGrid[r][c] !== playAnswers[r][c]) {
          return;
        }
      }
    }
    
    setPlayComplete(true);
    setPlayTimerActive(false);
  };
  
  const revealCell = () => {
    if (!playSelectedCell || !playAnswers) return;
    const { row, col } = playSelectedCell;

    const newGrid = playGrid.map(r => [...r]);
    newGrid[row][col] = playAnswers[row][col];
    setPlayGrid(newGrid);

    setRevealedCells(prev => new Set([...prev, `${row},${col}`]));
    setUsedAssist(true);
    sfx.reveal();
    checkPlayComplete(newGrid);
  };

  const revealWord = () => {
    const slot = getPlayCurrentSlot();
    if (!slot || !playAnswers) return;

    const newGrid = playGrid.map(r => [...r]);
    const newRevealed = new Set(revealedCells);

    for (let i = 0; i < slot.length; i++) {
      const r = slot.direction === 'across' ? slot.row : slot.row + i;
      const c = slot.direction === 'across' ? slot.col + i : slot.col;
      newGrid[r][c] = playAnswers[r][c];
      newRevealed.add(`${r},${c}`);
    }

    setPlayGrid(newGrid);
    setRevealedCells(newRevealed);
    setUsedAssist(true);
    sfx.reveal();
    checkPlayComplete(newGrid);
  };

  const doRevealAll = () => {
    if (!playAnswers) return;
    setPlayGrid(playAnswers.map(r => [...r]));
    // Reveal Cell and Reveal Word both record their cells; without the same here every
    // letter came back styled `text-correct`, so a board you gave up on was
    // indistinguishable from one you actually solved.
    const all = new Set();
    playAnswers.forEach((row, r) => row.forEach((cell, c) => {
      if (cell && cell !== '#') all.add(`${r},${c}`);
    }));
    setRevealedCells(all);
    setUsedAssist(true);
    sfx.reveal();
    setPlayComplete(true);
    setPlayTimerActive(false);
  };
  const revealAll = () => setConfirmDialog({
    title: 'Reveal the whole puzzle?',
    message: 'This fills in every answer and ends the solve. This can’t be undone.',
    confirmLabel: 'Reveal all',
    danger: true,
    onConfirm: () => { setConfirmDialog(null); doRevealAll(); },
  });

  // ---- One-off "Check" actions (separate from always-on auto-check) ----
  const markChecked = (cells) => {
    if (!cells.length) return;
    setCheckedCells(prev => { const n = new Set(prev); cells.forEach(k => n.add(k)); return n; });
    setUsedAssist(true);
    // One sound for the whole action. Any wrong square makes it a "wrong" — that is the
    // part the player needs to hear, and staying silent would read as "all correct".
    // A blank square is not wrong, it is simply unanswered, so it does not count.
    if (playAnswers && playGrid) {
      const answered = cells
        .map((k) => k.split(',').map(Number))
        .filter(([r, c]) => playGrid[r]?.[c] && playGrid[r][c] !== '#');
      // Nothing typed yet → nothing to be right about. Playing the correct sound over an
      // empty entry reads as "yes, that's it", which is the opposite of the truth.
      if (answered.length) {
        const wrong = answered.some(([r, c]) => playGrid[r][c] !== playAnswers[r]?.[c]);
        if (wrong) sfx.wrong(); else sfx.correct();
      }
    }
  };
  const checkSquare = () => {
    if (!playSelectedCell || playGrid?.[playSelectedCell.row]?.[playSelectedCell.col] === '#') return;
    markChecked([`${playSelectedCell.row},${playSelectedCell.col}`]);
  };
  const checkWord = () => {
    const slot = getPlayCurrentSlot();
    if (!slot) return;
    const cells = [];
    for (let i = 0; i < slot.length; i++) {
      const r = slot.direction === 'across' ? slot.row : slot.row + i;
      const c = slot.direction === 'across' ? slot.col + i : slot.col;
      cells.push(`${r},${c}`);
    }
    markChecked(cells);
  };
  const doCheckPuzzle = () => {
    if (!playGrid) return;
    const cells = [];
    for (let r = 0; r < playGrid.length; r++) {
      for (let c = 0; c < playGrid[r].length; c++) {
        if (playGrid[r][c] && playGrid[r][c] !== '#') cells.push(`${r},${c}`);
      }
    }
    markChecked(cells);
  };
  const checkPuzzle = () => setConfirmDialog({
    title: 'Check the whole board?',
    message: 'This marks every filled square as correct or wrong. It counts as using help.',
    confirmLabel: 'Check board',
    onConfirm: () => { setConfirmDialog(null); doCheckPuzzle(); },
  });

  const clearCurrentWord = () => {
    const slot = getPlayCurrentSlot();
    if (!slot || !playGrid) return;
    const newGrid = playGrid.map(r => [...r]);
    const dropped = new Set(checkedCells);
    for (let i = 0; i < slot.length; i++) {
      const r = slot.direction === 'across' ? slot.row : slot.row + i;
      const c = slot.direction === 'across' ? slot.col + i : slot.col;
      if (!revealedCells.has(`${r},${c}`)) { newGrid[r][c] = ''; dropped.delete(`${r},${c}`); }
    }
    setPlayGrid(newGrid);
    setCheckedCells(dropped);
  };
  
  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };
  
  // ============ DICTIONARY FUNCTIONS ============
  
  const saveUserClue = useCallback((word, clue) => {
    const w = String(word || '').toUpperCase().replace(/[^A-Z]/g, '');
    const c = String(clue || '').trim();
    if (!w || !c) return false;
    const date = new Date().toISOString().split('T')[0];
    if (userClues.some((e) => e.word === w && e.clue === c)) return false;
    const next = [...userClues, { date, word: w, clue: c }];
    saveJSON(USER_CLUES_KEY, next);
    setUserClues(next);
    setWords((prev) => (prev.some((e) => e.word === w && e.clue === c)
      ? prev : [...prev, { date, word: w, clue: c, difficulty: '' }]));
    // Deliberately does NOT set usingCustomWords. That flag swaps the worker off the
    // packed corpus and onto a structured clone of every CSV row, which has no clue store
    // -- so accepting a single clue used to blank the Clue Studio that offered it, and
    // degrade fill quality, for the rest of the session. A saved clue belongs in the
    // dictionary and the export; it is not a reason to abandon the corpus.
    return true;
  }, [userClues]);

  const addWordToDictionary = () => {
    if (!newWord.trim() || !newClue.trim()) return;
    
    const word = newWord.trim().toUpperCase().replace(/[^A-Z]/g, '');
    const clue = newClue.trim();
    
    if (!word) return;
    
    // An answer legitimately has many clues -- picking one at a difficulty is the whole
    // point -- so only the exact (word, clue) pair counts as a duplicate. This used to
    // reject any word already present, which made saving a second clue impossible.
    if (words.some(w => w.word === word && w.clue === clue)) {
      setError('That clue is already in your dictionary');
      setTimeout(() => setError(''), 3000);
      return;
    }

    saveUserClue(word, clue);
    setNewWord('');
    setNewClue('');
    setProgress('Saved to your dictionary.');
    setTimeout(() => setProgress(''), 3000);
  };
  
  /**
   * Remove one Lexicon row for good.
   *
   * `words` is rebuilt from the corpus CSV on every load, so mutating state alone made the
   * row reappear on refresh — the count even went back up. A row the user added lives in
   * userClues and is removed from there; a corpus row cannot be edited in place, so it is
   * recorded as a subtraction instead.
   *
   * Note the scope: this makes the Lexicon truthful and keeps the deletion across reloads.
   * The packed corpus the solver reads is unchanged, so the answer only stops being
   * *placeable* for as long as usingCustomWords stays set — this session.
   */
  const deleteWordFromDictionary = (index) => {
    const row = words[index];
    if (!row) return;
    const key = pairKey(row.word, row.clue);
    const inUserClues = userClues.some((e) => pairKey(e.word, e.clue) === key);
    if (inUserClues) {
      const next = userClues.filter((e) => pairKey(e.word, e.clue) !== key);
      saveJSON(USER_CLUES_KEY, next);
      setUserClues(next);
    } else {
      const next = new Set(userHidden);
      next.add(key);
      saveJSON(USER_HIDDEN_KEY, [...next]);
      setUserHidden(next);
    }
    setWords(prev => prev.filter((_, i) => i !== index));
    setUsingCustomWords(true);
    corpusFpRef.current = null;
  };
  
  const startEditWord = (index) => {
    setEditingWordIndex(index);
    setEditWord(words[index].word);
    setEditClue(words[index].clue);
  };
  
  const saveEditWord = () => {
    if (editingWordIndex === null) return;
    
    const word = editWord.trim().toUpperCase().replace(/[^A-Z]/g, '');
    const clue = editClue.trim();
    
    if (!word || !clue) return;
    
    // Same reasoning as the delete above: the edit has to be expressed as "hide the old
    // pair, add the new one", or the CSV reload puts the original back.
    const original = words[editingWordIndex];
    if (original && (original.word !== word || original.clue !== clue)) {
      const oldKey = pairKey(original.word, original.clue);
      const wasMine = userClues.some((e) => pairKey(e.word, e.clue) === oldKey);
      const date = original.date || new Date().toISOString().split('T')[0];
      const nextClues = [
        ...userClues.filter((e) => pairKey(e.word, e.clue) !== oldKey),
        { date, word, clue },
      ];
      saveJSON(USER_CLUES_KEY, nextClues);
      setUserClues(nextClues);
      if (!wasMine) {
        const nextHidden = new Set(userHidden);
        nextHidden.add(oldKey);
        saveJSON(USER_HIDDEN_KEY, [...nextHidden]);
        setUserHidden(nextHidden);
      }
    }
    setUsingCustomWords(true);
    corpusFpRef.current = null;
    setWords(prev => prev.map((w, i) => 
      i === editingWordIndex ? { ...w, word, clue } : w
    ));
    
    setEditingWordIndex(null);
    setEditWord('');
    setEditClue('');
  };
  
  const exportDictionary = () => {
    // Proper RFC-4180 quoting. The old version only quoted on a comma and never escaped an
    // embedded quote, so any clue containing one corrupted the file — and clues contain
    // them constantly ("___ it", quoted titles, dialogue).
    const cell = (v) => {
      const t = String(v ?? '');
      return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    let csv = 'Date,Word,Clue\n';
    words.forEach(w => {
      csv += `${cell(w.date || '')},${cell(w.word)},${cell(w.clue)}\n`;
    });
    
    // Excel reads a BOM-less CSV in the system ANSI codepage, so accented clues arrive as
    // mojibake for anyone who double-clicks the file. The JSON export stays BOM-less.
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'crossword-dictionary.csv';
    a.click();
    URL.revokeObjectURL(url);
  };
  
  const getFilteredWords = () => {
    if (!dictionarySearch.trim()) return words;
    const search = dictionarySearch.toLowerCase();
    return words.filter(w => 
      w.word.toLowerCase().includes(search) || 
      w.clue.toLowerCase().includes(search)
    );
  };

  // Timer effect
  React.useEffect(() => {
    if (playTimerActive) {
      playTimerRef.current = setInterval(() => {
        setPlayTimer(prev => prev + 1);
      }, 1000);
    } else {
      clearInterval(playTimerRef.current);
    }
    return () => clearInterval(playTimerRef.current);
  }, [playTimerActive]);

  React.useEffect(() => {
    let cancelled = false;
    const loadDefaultCSV = async () => {
      setCsvLoading(true);
      setProgress('Loading CSV...');
      try {
        const response = await fetch('/crosswords.csv');
        if (response.ok) {
          const text = await response.text();
          const parsed = parseCSV(text);
          if (!cancelled && !tagalogMode && parsed.length > 0) {
            // Merge the user's own clues over the corpus; they are additive, never a
            // replacement, so a fresh CSV never silently drops them.
            const mine = loadJSON(USER_CLUES_KEY, []);
            const hidden = new Set(loadJSON(USER_HIDDEN_KEY, []));
            const kept = hidden.size ? parsed.filter((e) => !hidden.has(pairKey(e.word, e.clue))) : parsed;
            setWords(mine.length ? [...kept, ...mine.map((e) => ({ ...e, difficulty: '' }))] : kept);
          }
        }
      } catch { console.log('No default crosswords.csv found'); }
      if (!cancelled) {
        setCsvLoading(false);
        setProgress('');
      }
    };
    if (!tagalogMode && words.length === 0) loadDefaultCSV();
    return () => { cancelled = true; };
  }, [tagalogMode, words.length]);

  React.useEffect(() => {
    let cancelled = false;

    const loadTagalogList = async () => {
      setCsvLoading(true);
      setProgress('Loading Tagalog word list...');
      try {
        const response = await fetch('/tagalogcrosswordfinal_test.csv');
        if (!response.ok) throw new Error('Tagalog crossword CSV not found');
        const text = await response.text();
        const parsed = parseCSV(text);
        if (parsed.length === 0) throw new Error('No Tagalog entries found');
        if (cancelled) return;
        setWords(parsed);
        setError('');
      } catch (err) {
        console.error(err);
        if (!cancelled) {
          setTagalogMode(false);
          setError('Unable to load Tagalog crossword list.');
          if (previousWordsRef.current) {
            setWords(previousWordsRef.current);
            previousWordsRef.current = null;
          }
        }
      } finally {
        if (!cancelled) {
          setCsvLoading(false);
          setProgress('');
        }
      }
    };

    if (tagalogMode) {
      previousWordsRef.current = words;
      setUsingCustomWords(true);
      corpusFpRef.current = null;
      loadTagalogList();
    } else if (previousWordsRef.current) {
      setWords(previousWordsRef.current);
      previousWordsRef.current = null;
      setUsingCustomWords(false);
      corpusFpRef.current = null;
    }

    return () => { cancelled = true; };
  }, [tagalogMode]);

  React.useEffect(() => {
    if (activeTab === 'create' && !manualGrid) initializeManualGrid();
  }, [activeTab, manualGrid, initializeManualGrid]);

  React.useEffect(() => {
    if (showSuggestions && words.length > 0) setSuggestions(findSuggestionsForSlot());
  }, [selectedCell, selectedDirection, manualGrid, showSuggestions]);

  // Arriving via an invite link (?join=CODE): jump to Multiplayer and clean the URL.
  React.useEffect(() => {
    if (!autoJoinCode) return;
    setActiveTab('multiplayer');
    try {
      const u = new URL(window.location.href);
      u.searchParams.delete('join');
      window.history.replaceState({}, '', u.toString());
    } catch { /* ignore */ }
  }, [autoJoinCode]);

  // ============ PWA INSTALL ============
  React.useEffect(() => {
    const onBeforeInstall = (e) => { e.preventDefault(); setInstallPromptEvent(e); };
    const onInstalled = () => setInstallPromptEvent(null);
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const handleInstall = async () => {
    if (!installPromptEvent) return;
    installPromptEvent.prompt();
    try { await installPromptEvent.userChoice; } catch { /* ignore */ }
    setInstallPromptEvent(null);
  };

  const handleSaveOllama = (cfg) => {
    const next = { ...ollamaConfig, ...cfg };
    setOllamaConfig(next);
    saveOllamaConfig(next);
  };

  // ---- whole-puzzle re-clue ----
  const [reclue, setReclue] = useState(null);
  const reclueAbortRef = useRef(null);

  // clueSource works against a corpus-shaped object; build one from what the worker sent
  // rather than shipping a second copy of the 6 MB artifact to the main thread.
  const shimCorpus = (data) => {
    const byWord = new Map();
    const entries = [];
    for (const [word, v] of Object.entries(data || {})) {
      byWord.set(word, v.clues || []);
      entries.push({ word, ...(v.answerFeatures || {}) });
    }
    return { entries, clueStore: memoryClueStore(byWord) };
  };

  const activeClueSet = () => (activeTab === 'create' ? manualClues : clues);

  const runReclue = async (band) => {
    const set = activeClueSet();
    const entries = [...(set?.across || []), ...(set?.down || [])]
      .filter((c) => c.word && !c.word.includes('_'))
      .map((c) => ({ key: `${c.direction}-${c.row}-${c.col}`, ...c }));
    if (!entries.length) {
      setReclue((r) => ({ ...(r || {}), band, error: 'Fill the grid first.' }));
      return;
    }
    reclueAbortRef.current?.abort();
    const ctrl = new AbortController();
    reclueAbortRef.current = ctrl;
    setReclue({ band, running: true, progress: null, result: null, error: '', selected: new Set() });
    try {
      const [model, data] = await Promise.all([
        loadScorer(),
        requestClueData([...new Set(entries.map((e) => e.word))]),
      ]);
      const corpus = shimCorpus(data);
      const generate = ollamaConfig.enabled
        // perWord was 4, but the batch request was silently truncating: at 4 the model
        // returned ONE clue per answer, at 8 it returned none at all, twice, and gave up.
        // With the budget fixed, over-generating is where the in-band hits come from —
        // scoring is local and instant, so the only cost is a little model time.
        ? makeGenerator({ baseUrl: ollamaConfig.baseUrl, model: ollamaConfig.model, perWord: 8, signal: ctrl.signal })
        : null;
      const out = await recluePuzzle(corpus, model, entries, {
        band,
        generate,
        // Embeddings live on localhost, not on the generation host — the remote box has no
        // embedding model. This populates `chosen.suspect`, which ReclueReview has always
        // rendered as a "check accuracy" badge and which nothing has ever set, so the
        // warning has never once appeared. 21-26% of generated clues are flagged by it.
        embed: { baseUrl: 'http://localhost:11434' },
        onProgress: (p) => setReclue((r) => (r ? { ...r, progress: p } : r)),
      });
      // Pre-tick only the proposals that actually landed in the requested band. A
      // near-miss is still shown and can be ticked deliberately, but it must not be
      // applied by default: ticking those would quietly swap p57 and p62 clues into an
      // EASY pass, which is precisely the silent near-miss this feature exists to avoid.
      const selected = new Set(out.results
        .filter((r) => r.chosen && (r.status === 'corpus' || r.status === 'generated'))
        .map((r) => r.key));
      setReclue({ band, running: false, progress: null, result: out, error: '', selected });
    } catch (err) {
      setReclue((r) => ({ ...(r || { band }), running: false, error: String(err?.message || err) }));
    }
  };

  const applyReclue = () => {
    const st = reclue;
    if (!st?.result) return;
    const picks = new Map(st.result.results
      .filter((r) => r.chosen && st.selected.has(r.key))
      .map((r) => [r.key, r.chosen.clue]));
    if (!picks.size) return;
    const apply = (set) => ({
      across: (set?.across || []).map((c) => {
        const k = `across-${c.row}-${c.col}`;
        return picks.has(k) ? { ...c, clue: picks.get(k) } : c;
      }),
      down: (set?.down || []).map((c) => {
        const k = `down-${c.row}-${c.col}`;
        return picks.has(k) ? { ...c, clue: picks.get(k) } : c;
      }),
    });
    if (activeTab === 'create') setManualClues((prev) => apply(prev));
    else { setClues((prev) => apply(prev)); setLatestClues((prev) => apply(prev)); }
    for (const r of st.result.results) {
      if (r.chosen && st.selected.has(r.key)) saveUserClue(r.word, r.chosen.clue);
    }
    setReclue(null);
    setProgress(`Re-clued ${picks.size} ${picks.size === 1 ? 'entry' : 'entries'}.`);
    setTimeout(() => setProgress(''), 4000);
  };

  // ============ CLUE STUDIO ============
  // The scorer runs on the MAIN thread, not in the worker: it has to rate a clue on every
  // keystroke, and a postMessage round trip per character would be absurd for something
  // that takes microseconds. The corpus stays in the worker, which hands over just the
  // per-answer material the scorer needs.
  const clueModelRef = useRef(null);
  const [clueStudio, setClueStudio] = useState(null);

  const loadScorer = useCallback(async () => {
    if (clueModelRef.current) return clueModelRef.current;
    const res = await fetch(`${import.meta.env.BASE_URL || '/'}corpus/clue-model.json`);
    if (!res.ok) throw new Error(`Couldn't load the clue scorer (${res.status}).`);
    clueModelRef.current = loadClueModel(await res.json());
    return clueModelRef.current;
  }, []);

  const requestClueData = useCallback((words) => new Promise((resolve) => {
    const w = ensureWorker();
    // One slot per request, keyed by id. A single shared slot meant a second request
    // overwrote the first's resolver: the worker's FIRST reply went to the SECOND caller,
    // the second reply arrived to a null ref and was dropped, and the first request hung
    // for 15s then resolved {} — which made a whole-puzzle re-clue report "nothing found"
    // for every answer while the corpus had clues for all of them.
    const id = ++clueDataSeqRef.current;
    const timer = setTimeout(() => {
      // Only clear the slot if it is still ours.
      if (clueDataPendingRef.current?.id === id) clueDataPendingRef.current = null;
      resolve({});
    }, 15000);
    clueDataPendingRef.current = {
      id,
      fn: (data) => {
        clearTimeout(timer);
        if (clueDataPendingRef.current?.id === id) clueDataPendingRef.current = null;
        resolve(data || {});
      },
    };
    const send = () => w.postMessage({ type: 'clueData', payload: { words } });
    if (corpusFpRef.current) send();
    else {
      // The worker needs its corpus before it can answer.
      const prev = pendingRef.current;
      pendingRef.current = (msg) => {
        if (msg.type === 'corpusReady') { corpusFpRef.current = msg.fingerprint; pendingRef.current = prev; send(); }
        else prev?.(msg);
      };
      w.postMessage({ type: 'loadCorpus', payload: corpusRequest() });
    }
  }), [corpusRequest]);

  const openClueStudio = async (word, currentClue, band = 'medium') => {
    if (!word || /_/.test(word)) return;
    setClueStudio({ word, currentClue, band, candidates: [], loading: true, generating: false,
      error: '', range: null, sense: '', reading: '', senses: null, findingSenses: false });
    try {
      const [model, data] = await Promise.all([loadScorer(), requestClueData([word])]);
      const entry = data[word];
      const clues = entry?.clues || [];
      const af = entry?.answerFeatures || {};
      const cands = clues.map((c) => {
        const percentile = cluePercentile(model, word, c.clue, af);
        const win = BANDS[band];
        return {
          clue: c.clue, percentile, source: 'corpus',
          band: percentile < BANDS.easy.max ? 'easy' : percentile < BANDS.medium.max ? 'medium' : 'hard',
          inBand: percentile >= win.min && percentile < win.max,
        };
      }).sort((a, b) => (b.inBand - a.inBand) || a.percentile - b.percentile);
      const ps = cands.map((c) => c.percentile);
      setClueStudio((st) => (st?.word !== word ? st : {
        ...st,
        candidates: cands,
        range: ps.length ? { min: Math.min(...ps), max: Math.max(...ps), count: ps.length } : null,
        answerFeatures: af,
        loading: false,
      }));
    } catch (err) {
      setClueStudio((st) => (st ? { ...st, loading: false, error: String(err?.message || err) } : st));
    }
  };

  const setClueStudioBand = (band) => setClueStudio((st) => {
    if (!st) return st;
    const win = BANDS[band];
    const candidates = st.candidates
      .map((c) => ({ ...c, inBand: c.percentile >= win.min && c.percentile < win.max }))
      .sort((a, b) => (b.inBand - a.inBand) || a.percentile - b.percentile);
    return { ...st, band, candidates };
  });

  // Ask what the answer can mean before asking for clues. The corpus only records the
  // sense it happens to have used — RAZER is only ever "Leveler" — so without this the
  // brand, the character or the game reading is unreachable.
  const discoverStudioSenses = async () => {
    const st = clueStudio;
    if (!st) return;
    setClueStudio((s0) => (s0 ? { ...s0, findingSenses: true, error: '' } : s0));
    try {
      const senses = await sensesForAnswer(
        { clueStore: { __mem: new Map([[st.word, st.candidates
          .filter((c) => c.source === 'corpus').map((c) => ({ clue: c.clue }))]]) } },
        st.word,
        {
          baseUrl: ollamaConfig.baseUrl,
          model: ollamaConfig.model,
          embedUrl: ollamaConfig.baseUrl,
        },
      );
      setClueStudio((s0) => (s0?.word !== st.word ? s0 : { ...s0, findingSenses: false, senses }));
    } catch (err) {
      setClueStudio((s0) => (s0 ? { ...s0, findingSenses: false, error: String(err?.message || err) } : s0));
    }
  };

  const pickStudioSense = (sn) => {
    setClueStudio((s0) => (s0 ? { ...s0, sense: sn ? senseText(sn) : '' } : s0));
  };

  const generateStudioClues = async () => {
    const st = clueStudio;
    if (!st) return;
    setClueStudio((s0) => (s0 ? { ...s0, generating: true, error: '' } : s0));
    try {
      const model = await loadScorer();
      const generate = makeGenerator({
        baseUrl: ollamaConfig.baseUrl, model: ollamaConfig.model, perWord: 6,
      });
      // Hand the model how this answer has actually been clued, so it writes in the same
      // sense — and the same READING, which is what stops a concatenated phrase like
      // ISITME being clued as though it were about the time.
      const known = st.candidates.filter((c) => c.source === 'corpus').map((c) => c.clue);
      const fresh = await generate([{ word: st.word, sense: st.sense, known }], st.band);
      const got = fresh.get(st.word) || { clues: [], reading: '' };
      const shim = { entries: [{ word: st.word, ...(st.answerFeatures || {}) }],
        clueStore: { wordIndexOf: new Map([[st.word, 0]]), counts: [0], offsets: [0] } };
      const exclude = new Set(st.candidates.map((c) => c.clue.toLowerCase()));
      let scored = scoreCandidates(shim, model, st.word, got.clues, { band: st.band, exclude });
      // Flag anything that reads unlike this answer's real clues — the model does write
      // confidently wrong ones, and nothing in the difficulty score can see that.
      if (known.length >= 3) {
        scored = await flagImplausible(
          { clueStore: { __mem: new Map([[st.word, known.map((c) => ({ clue: c }))]]) } },
          st.word, scored, { baseUrl: ollamaConfig.baseUrl },
        );
      }
      setClueStudio((s0) => (s0?.word !== st.word ? s0 : {
        ...s0,
        generating: false,
        reading: got.reading || '',
        candidates: [...s0.candidates, ...scored]
          .sort((a, b) => (b.inBand - a.inBand) || a.percentile - b.percentile),
      }));
    } catch (err) {
      setClueStudio((s0) => (s0 ? { ...s0, generating: false, error: String(err?.message || err) } : s0));
    }
  };

  // Rate every clue in the finished puzzle with the local model. The precomputed
  // difficulty is instant but blind to how a specific clue reads, so this is what
  // actually surfaces a Saturday-hard entry sitting in a Monday grid.
  const [auditState, setAuditState] = useState({ running: false, done: 0, total: 0, summary: null, error: '' });
  const auditAbortRef = useRef(null);

  const runDifficultyAudit = async () => {
    const entries = [...(clues?.across || []), ...(clues?.down || [])]
      .filter((c) => c.word && c.clue)
      .map((c) => ({ number: c.number, direction: c.direction, word: c.word, clue: c.clue }));
    if (!entries.length) {
      setAuditState({ running: false, done: 0, total: 0, summary: null, error: 'Nothing to audit yet.' });
      return;
    }
    auditAbortRef.current?.abort();
    const ctrl = new AbortController();
    auditAbortRef.current = ctrl;
    setAuditState({ running: true, done: 0, total: entries.length, summary: null, error: '' });
    try {
      const { summary } = await auditDifficulty({
        baseUrl: ollamaConfig.baseUrl,
        model: ollamaConfig.model,
        entries,
        signal: ctrl.signal,
        onProgress: ({ done, total }) => setAuditState((s) => ({ ...s, done, total })),
      });
      setAuditState({ running: false, done: entries.length, total: entries.length, summary, error: '' });
    } catch (err) {
      setAuditState({ running: false, done: 0, total: 0, summary: null, error: String(err?.message || err) });
    }
  };

  const aiGenerateClues = (word, difficulty = 'MODERATE') =>
    generateClues({
      baseUrl: ollamaConfig.baseUrl,
      model: ollamaConfig.model,
      word,
      difficulty,
      count: 3,
      language: tagalogMode ? 'Tagalog' : 'English',
    });

  // ============ DAILY PUZZLE ============
  const handleDaily = () => {
    if (words.length === 0) { setError('Load a word list first to build today’s puzzle.'); return; }
    // The solver is seeded, so the daily is genuinely reproducible. It used to
    // seededShuffle all 552k rows to imitate determinism, which the solver then threw
    // away by calling Math.random() internally.
    const seed = seedFromString(todayKey());
    // Rotate over the 15x15s only. Two reasons: a daily that is a 5x5 Mini one morning and
    // a 21x21 Sunday the next is not a daily, it is a lucky dip; and `seed % layouts.length`
    // over the whole list means ADDING a layout silently reassigns every past date's grid.
    // Keyed by name so the mapping survives reordering too.
    const dailyPool = layouts.filter((l) => l.grid.length === 15 && l.grid[0].length === 15);
    const pool = dailyPool.length ? dailyPool : layouts;
    const chosen = pool[seed % pool.length];
    const layoutIdx = Math.max(0, layouts.indexOf(chosen));
    setSelectedLayoutIndex(layoutIdx);
    // startPlayMode reads and clears this, so any solve NOT started from here is
    // explicitly marked non-daily. Previously isDailyMode was only ever cleared by the
    // streak effect, so abandoning the daily and solving anything else credited the day.
    dailyRequestRef.current = true;
    setIsDailyMode(true);
    generatePuzzle(layoutIdx, true, [], 'anchor', 'random', seed);
  };

  // Record a streak when the daily puzzle is completed (once per day).
  React.useEffect(() => {
    // usedAssist matters as much as isDailyMode here: doRevealAll sets playComplete
    // directly, so without this Reveal Puzzle earned the day's streak and stamped
    // lastSolved, making the genuine solve uncountable.
    if (playComplete && isDailyMode && !usedAssist && !isDailySolved()) {
      setStreak(recordDailySolve());
      setIsDailyMode(false);
    }
  }, [playComplete, isDailyMode, usedAssist]);

  // Record every finished solve — daily, generated, imported or shared. Local first, so it
  // works signed out and offline; the upload is fire-and-forget and syncOnSignIn reconciles.
  React.useEffect(() => {
    if (!playComplete || !playAnswers || solveRecordedRef.current) return;
    solveRecordedRef.current = true;
    const meta = playMetaRef.current || {};
    try {
      recordSolve({
        ...meta,
        grid: playAnswers,
        seconds: playTimer,
        usedHelp: usedAssist,
        difficultyScore: difficultyInfo?.score ?? null,
        difficultyLabel: difficultyInfo?.label || '',
      });
    } catch { /* a solve log is never worth breaking the finish screen over */ }
  }, [playComplete, playAnswers, playTimer, usedAssist, difficultyInfo]);

  // Signing in reconciles the device's history with the account's, both ways.
  React.useEffect(() => {
    if (!auth.user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await syncOnSignIn(auth.user.id);
        if (!cancelled && !r.skipped && (r.uploaded || r.downloaded)) {
          setProgress(`Synced your solves — ${r.uploaded} up, ${r.downloaded} down.`);
          setTimeout(() => setProgress(''), 4000);
        }
      } catch { /* offline; the next sign-in reconciles */ }
    })();
    return () => { cancelled = true; };
  }, [auth.user?.id]);

  // Celebrate on completion (once per solve): chime, confetti, result card.
  React.useEffect(() => {
    if (playComplete && !resultShownRef.current) {
      resultShownRef.current = true;
      setCleanSolve(!usedAssist);
      sfx.win();
      burstConfetti();
      setShowResult(true);
    }
    if (!playComplete) resultShownRef.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playComplete]);

  // ============ AUTO-SAVE & RESUME ============
  // Restore a saved session once on mount (primarily an in-progress solve).
  React.useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const s = loadJSON('session', null);
    if (!s) return;
    // Custom layouts are saved with the session; without them a saved index can point
    // past the end of DEFAULT_LAYOUTS and every layout lookup returns undefined.
    const restoredLayouts = Array.isArray(s.layouts) && s.layouts.length ? s.layouts : DEFAULT_LAYOUTS;
    if (restoredLayouts !== DEFAULT_LAYOUTS) setLayouts(restoredLayouts);
    const clampIdx = (i) => Math.min(Math.max(0, i | 0), restoredLayouts.length - 1);
    if (typeof s.selectedLayoutIndex === 'number') setSelectedLayoutIndex(clampIdx(s.selectedLayoutIndex));
    if (typeof s.currentLayoutIndex === 'number') setCurrentLayoutIndex(clampIdx(s.currentLayoutIndex));
    if (Array.isArray(s.lockedCells)) setLockedCells(new Set(s.lockedCells));
    if (Array.isArray(s.manualCircles)) setManualCircles(new Set(s.manualCircles));
    if (s.difficultyChoice) setDifficultyChoice(s.difficultyChoice);
    if (s.grid) { setGrid(s.grid); setClues(s.clues || { across: [], down: [] }); }
    if (s.latestGrid) { setLatestGrid(s.latestGrid); setLatestClues(s.latestClues || null); }
    if (s.play && s.play.playAnswers) {
      setPlayAnswers(s.play.playAnswers);
      setPlayGrid(s.play.playGrid);
      setPlayClues(s.play.playClues || { across: [], down: [] });
      setRevealedCells(new Set(s.play.revealedCells || []));
      setCheckedCells(new Set(s.play.checkedCells || []));
      setUsedAssist(!!s.play.usedAssist);
      setPlayTimer(s.play.playTimer || 0);
      setPlayComplete(!!s.play.playComplete);
      setPlayCircles(new Set(s.play.circles || []));
      setPlayShades(new Set(s.play.shades || []));
      resultShownRef.current = !!s.play.playComplete; // don't re-pop the result card on resume
      setPlayDirection(s.play.playDirection || 'across');
      setIsDailyMode(!!s.play.isDailyMode);
      setPlayTimerActive(!s.play.playComplete);
      if (s.activeTab === 'play' && !autoJoinCode) setActiveTab('play');
    }
  }, [autoJoinCode]);

  // Persist the working session whenever it changes.
  React.useEffect(() => {
    if (!restoredRef.current) return;
    saveJSON('session', {
      activeTab,
      selectedLayoutIndex,
      currentLayoutIndex,
      // Custom layouts live only in state; without them a restored index points past the
      // end of DEFAULT_LAYOUTS and every layout lookup returns undefined.
      layouts,
      lockedCells: [...lockedCells],
      manualCircles: [...manualCircles],
      difficultyChoice,
      grid,
      clues,
      latestGrid,
      latestClues,
      play: playAnswers ? {
        playAnswers,
        playGrid,
        playClues,
        revealedCells: [...revealedCells],
        // revealedCells was saved but usedAssist and checkedCells were not, so a reload
        // turned an assisted solve into a clean one — the revealed letters still showed,
        // but the flag that said help was used had gone.
        checkedCells: [...checkedCells],
        usedAssist,
        playTimer,
        playComplete,
        playDirection,
        isDailyMode,
        circles: [...playCircles],
        shades: [...playShades],
      } : null,
    });
    // playTimer is deliberately absent from the dependency list. It ticks once a second,
    // and with it here the whole puzzle — every grid, every clue list — was
    // JSON.stringify'd and written to localStorage every second of every solve. The
    // interval below picks up the clock instead.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, selectedLayoutIndex, currentLayoutIndex, layouts, lockedCells, manualCircles, difficultyChoice, grid, clues, latestGrid, latestClues, playAnswers, playGrid, playClues, revealedCells, checkedCells, usedAssist, playComplete, playDirection, isDailyMode, playCircles, playShades]);

  // Catch up the clock roughly, rather than on every tick. Losing a few seconds of
  // elapsed time to a hard refresh is a far better trade than a 6 MB-per-minute write
  // loop, and saveJSON quietly returns false on a full quota, so the cheaper the writes
  // the less there is to lose.
  React.useEffect(() => {
    if (!playAnswers || playComplete) return;
    const id = setInterval(() => {
      const prev = loadJSON('session', null);
      if (prev?.play) saveJSON('session', { ...prev, play: { ...prev.play, playTimer } });
    }, 15000);
    return () => clearInterval(id);
  }, [playAnswers, playComplete, playTimer]);

  const layoutIndexForTab = Math.min(activeTab === 'create' ? currentLayoutIndex : selectedLayoutIndex, Math.max(layouts.length - 1, 0));

  // The Required Words modal's stats are read on every render whether it is open or not,
  // so this has to hold up when the layout is missing. findSlots([]) reads layout[0].length
  // and throws; that exception used to take the entire app down to a white screen.
  const layoutStatsForModal = React.useMemo(() => {
    const layoutGrid = layouts[selectedLayoutIndex]?.grid;
    if (!layoutGrid || !layoutGrid.length) return { slots: 0, lengthCounts: {} };
    const stats = getLayoutStats(layoutGrid);
    return {
      slots: stats.slots || findSlots(layoutGrid).length,
      lengthCounts: stats.lengthCounts || {},
    };
  }, [layouts, selectedLayoutIndex]);

  // Best complete puzzle to host in multiplayer (a full solution grid + clues).
  const hostablePuzzle = playAnswers
    ? { grid: playAnswers, clues: playClues, meta: { title: 'Current puzzle' } }
    : grid
      ? { grid, clues, meta: { title: 'Generated puzzle' } }
      : latestGrid
        ? { grid: latestGrid, clues: latestClues, meta: { title: 'Latest puzzle' } }
        : null;

  // Generate a fresh, complete puzzle and RETURN it (no play-state mutation) —
  // used by the multiplayer Rematch flow.
  const generateFreshPuzzle = async () => {
    if (!words.length) throw new Error('Load a word list first.');
    // Without this a single "Stop the Press" leaves cancelRef true for the rest of the
    // session, and every multiplayer Rematch cancels itself within 60 ms.
    cancelRef.current = false;
    const layout = layouts[selectedLayoutIndex]?.grid;
    if (!layout) throw new Error('No layout selected.');
    const result = await generateCrossword(
      layout, () => {}, solveBudgetMs(layout), null, [], 'anchor', {}, difficultyTargetOf(difficultyChoice), null);
    if (!result?.grid || !result.complete) throw new Error('Could not generate a full puzzle — try Crosswithfriends.');
    const numbered = assignNumbers(result.placements || []);
    const clueSet = {
      across: numbered.filter((n) => n.direction === 'across').sort((a, b) => a.number - b.number),
      down: numbered.filter((n) => n.direction === 'down').sort((a, b) => a.number - b.number),
    };
    return { grid: result.grid, clues: clueSet, meta: { title: 'Rematch puzzle' } };
  };

  // ---- Playing somebody else's puzzle from its code ----
  // codeError() names the specific problem so the message can too: "that is not valid" tells
  // the user nothing about which of the eight characters they got wrong.
  const CODE_MESSAGES = {
    empty: 'Enter the code you were given.',
    length: 'A puzzle code is 8 characters, like KR7F-2Q9X.',
    charset: 'Codes only use digits 2-9 and letters — check for a typo.',
    confusable: 'Codes never contain O, 0, I, 1, L or U. One of those is in there — try the digit or letter it looks like.',
  };

  const playByShareCode = async () => {
    const bad = codeError(shareCodeInput);
    if (bad) { setShareCodeError(CODE_MESSAGES[bad] || 'That code is not valid.'); return; }
    setShareCodeBusy(true);
    setShareCodeError('');
    try {
      const row = await fetchByCode(shareCodeInput);
      const d = row.data || {};
      if (!d.grid || !d.clues) throw new Error('That puzzle is missing its grid or clues.');
      startPlayMode(d.grid, d.clues, {
        circles: d.circles,
        shades: d.shades,
        meta: { source: 'shared', remoteId: row.id, title: row.title || 'Shared puzzle' },
      });
      setShareCodeInput('');
      setProgress(`Opened ${formatCode(row.share_code || shareCodeInput)}.`);
      setTimeout(() => setProgress(''), 4000);
    } catch (err) {
      setShareCodeError(err.message || 'Could not open that puzzle.');
    } finally {
      setShareCodeBusy(false);
    }
  };

  // ---- Saved puzzles (Supabase) ----
  const buildCurrentPuzzleData = () => {
    const cg = activeTab === 'auto' ? grid : activeTab === 'play' ? playAnswers : manualGrid;
    const cc = activeTab === 'auto' ? clues : activeTab === 'play' ? playClues : manualClues;
    if (!cg) return null;
    const layout = cg.map((row) => row.map((c) => (c === '#' ? '#' : '.')).join(''));
    const circles = activeTab === 'play' ? [...playCircles] : [...manualCircles];
    const shades = activeTab === 'play' ? [...playShades] : [];
    return {
      version: '1.0', layout, grid: cg, clues: cc, circles, shades,
      hasRebus: cg.some((row) => row.some((c) => c && c !== '#' && c.length > 1)),
      meta: { title: 'My puzzle' },
    };
  };

  const saveCurrentPuzzle = async () => {
    if (!auth.user) { setShowAuth(true); return; }
    const data = buildCurrentPuzzleData();
    if (!data) { setError('Nothing to save yet.'); return; }
    try {
      await savePuzzle({ title: data.meta.title, data });
      setProgress('Saved to your account!');
      setTimeout(() => setProgress(''), 3000);
    } catch (err) {
      setError(err.message || 'Could not save puzzle.');
    }
  };

  const loadPuzzleIntoCreate = (data) => {
    if (!data?.grid) return;
    const layoutGrid = data.grid.map((row) => row.map((c) => (c === '#' ? '#' : '.')).join(''));
    const newIndex = layouts.length;
    setLayouts((prev) => [...prev, { name: data.meta?.title || 'Saved puzzle', grid: layoutGrid }]);
    setCurrentLayoutIndex(newIndex);
    setManualGrid(data.grid.map((row) => row.map((c) => (c === '#' ? '#' : (c || '')))));
    // A loaded puzzle is not the author's hand-typed work, so nothing is pinned and a
    // Regenerate may reroll all of it. Hand-written clues still survive, because a clue is
    // only dropped when its answer changes under it.
    setLockedCells(new Set());
    setManualCircles(new Set(data.circles || []));
    setManualRebusMode(false);
    setManualClues({ across: data.clues?.across || [], down: data.clues?.down || [] });
    setSelectedCell(null);
    setActiveTab('create');
  };

  return (
    <div className={`relative z-10 min-h-screen overflow-x-hidden px-3 py-6 sm:px-4 sm:py-8 md:px-8 ${tagalogMode ? 'tagalog-theme' : ''}`} onKeyDown={activeTab === 'play' ? handlePlayKeyDown : activeTab === 'create' ? handleKeyDown : undefined} tabIndex={0}>
      <div className="max-w-7xl mx-auto">
        {/* ===================== MASTHEAD ===================== */}
        <header className="mb-8 animate-rise-in">
          <div className="flex items-center justify-between gap-3 eyebrow">
            <span>{tagalogMode ? 'Ang Pang-Araw-araw na Grid' : 'The Daily Grid'}</span>
            <span className="hidden sm:inline normal-case tracking-normal font-mono text-[0.6rem] text-ink-faint">
              {new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}
            </span>
            <span>Vol. I · No. 1</span>
          </div>
          <div className="rule-hair my-2.5" />
          <h1 className="text-center font-display font-black leading-[0.86] tracking-[-0.02em] text-ink text-[2.85rem] sm:text-6xl md:text-7xl">
            Kros<span className="italic text-accent">alita</span>
          </h1>
          <div className="rule-double mt-3.5" />
          <p className="mt-3 text-center font-display italic text-ink-soft text-base md:text-lg">
            Set the grid · pull the words · play the proof
          </p>
        </header>

        {/* ===================== CONTROLS CLUSTER ===================== */}
        <div className="flex justify-center flex-wrap items-center gap-2 mb-7">
          <button
            onClick={() => setTagalogMode(prev => !prev)}
            className={`btn btn-sm ${tagalogMode ? 'btn-accent' : ''}`}
          >
            <Languages size={14} />
            {tagalogMode ? 'Tagalog · On' : 'Tagalog · Off'}
          </button>
          <button onClick={() => setShowSettings(true)} className={`btn btn-sm ${ollamaConfig.enabled ? 'btn-ink' : 'btn-ghost'}`}>
            <Zap size={14} />AI {ollamaConfig.enabled ? 'On' : 'Off'}
          </button>
          <button onClick={toggleSound} className={`btn btn-sm ${soundOn ? 'btn-ink' : 'btn-ghost'}`} title="Sound effects">
            {soundOn ? <Volume2 size={14} /> : <VolumeX size={14} />}Sound
          </button>
          {soundOn && (
            <label className="flex items-center gap-1.5 text-[11px] text-ink-faint" title="Effect volume">
              <span className="sr-only">Sound effect volume</span>
              <input
                type="range"
                min="0" max="1" step="0.05"
                value={soundVolume}
                onChange={(e) => changeVolume(Number(e.target.value))}
                className="w-20 accent-ink cursor-pointer"
                aria-label="Sound effect volume"
              />
              <span className="font-mono tabular-nums w-7">{Math.round(soundVolume * 100)}</span>
            </label>
          )}
          {installPromptEvent && (
            <button onClick={handleInstall} className="btn btn-sm btn-accent">
              <DownloadCloud size={14} />Install App
            </button>
          )}
          {streak.current > 0 && (
            <span className="chip border-gold/40 text-gold" title={`Best streak: ${streak.best}`}>
              <Flame size={13} />{streak.current}-day streak
            </span>
          )}
          {auth.enabled && (auth.user ? (
            <button onClick={auth.signOut} className="btn btn-sm btn-ghost" title={auth.user.email}>
              {auth.displayName || 'Account'} · Sign out
            </button>
          ) : (
            <button onClick={() => setShowAuth(true)} className="btn btn-sm btn-ghost">Sign in</button>
          ))}
        </div>

        {/* ===================== SECTION NAV ===================== */}
        <nav className="mb-7 flex justify-center">
          <div className="flex flex-wrap items-end justify-center gap-1 border-b-2 border-ink/15">
            <button onClick={() => setActiveTab('auto')} className={`tab ${activeTab === 'auto' ? 'tab-active' : ''}`}>
              <Puzzle size={15} />Generate
            </button>
            <button onClick={() => setActiveTab('create')} className={`tab ${activeTab === 'create' ? 'tab-active' : ''}`}>
              <PenTool size={15} />Create
            </button>
            <button onClick={() => setActiveTab('play')} className={`tab ${activeTab === 'play' ? 'tab-active' : ''}`}>
              <Play size={13} />Play
            </button>
            <button onClick={() => setActiveTab('browse')} className={`tab ${activeTab === 'browse' ? 'tab-active' : ''}`}>
              <Search size={14} />Browse
            </button>
            <button onClick={() => setActiveTab('multiplayer')} className={`tab ${activeTab === 'multiplayer' ? 'tab-active' : ''}`}>
              <Play size={13} />Multiplayer
            </button>
            {auth.enabled && (
              <button onClick={() => setActiveTab('mypuzzles')} className={`tab ${activeTab === 'mypuzzles' ? 'tab-active' : ''}`}>
                <Save size={14} />My Puzzles
              </button>
            )}
            <button onClick={() => setActiveTab('history')} className={`tab ${activeTab === 'history' ? 'tab-active' : ''}`}>
              <Trophy size={14} />History
            </button>
            <button onClick={() => setShowDictionary(true)} className="tab">
              <BookOpen size={15} />Dictionary
            </button>
          </div>
        </nav>
        
        {['auto', 'create', 'play'].includes(activeTab) && (activeTab !== 'play' ? (
        <div className="panel panel-pad mb-6 overflow-visible animate-rise-in" style={{ animationDelay: '60ms' }}>
          {csvLoading && (
            <div className="mb-4">
              <div className="eyebrow text-ink-soft">Loading word list…</div>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-sm bg-ink/10">
                <div className="h-full w-1/3 animate-pulse bg-accent" />
              </div>
            </div>
          )}
          <div className="flex gap-2.5 flex-wrap items-center relative">
            <label className="btn cursor-pointer">
              <Upload size={16} />Upload CSV
              <input type="file" accept=".csv" onChange={handleFileUpload} className="hidden" />
            </label>

            <div className="relative">
              <button onClick={() => setShowLayoutSelector(!showLayoutSelector)} className="btn">
                <Grid3X3 size={16} />{layouts[layoutIndexForTab]?.name}
              </button>
            </div>

            {activeTab === 'auto' && !isGenerating && (
              <button onClick={() => { setRequiredAction('auto'); setShowRequiredModal(true); }} disabled={words.length === 0 || onCooldown} className="btn btn-accent">
                <RefreshCw size={16} />{onCooldown ? `Wait ${cooldownLeft}s` : 'Generate'}
              </button>
            )}

            {activeTab === 'auto' && !isGenerating && (
              <button onClick={handleDaily} disabled={words.length === 0 || onCooldown} className="btn btn-gold" title="Build & play today's puzzle — solve it to grow your streak">
                <Flame size={15} />{onCooldown ? `Wait ${cooldownLeft}s` : 'Today’s Puzzle'}
              </button>
            )}

            {activeTab === 'auto' && isGenerating && (
              <button onClick={cancelGeneration} className="btn btn-ink">
                <X size={16} />Stop the Press
              </button>
            )}

            {activeTab === 'create' && manualGrid && (
              <button
                onClick={() => {
                  // Create had no way to play what you had just built — the only Play buttons
                  // belonged to the Generate tab. Circles travel with it.
                  const empty = manualGrid.some((row) => row.some((c) => c !== '#' && !c));
                  if (empty) { setError('Fill every square before playing this puzzle.'); return; }
                  startPlayMode(manualGrid, manualClues, {
                    circles: [...manualCircles],
                    meta: { source: 'generated', layoutName: layouts[currentLayoutIndex]?.name, title: 'My puzzle' },
                  });
                }}
                className="btn btn-ink"
              >
                <Play size={13} />Play This Puzzle
              </button>
            )}

            {activeTab === 'create' && (
              <button onClick={() => initializeManualGrid(currentLayoutIndex)} className="btn btn-ghost">
                <RefreshCw size={16} />Clear Grid
              </button>
            )}

            {activeTab === 'create' && !isGenerating && (
              <button
                onClick={handleManualGenerate}
                disabled={words.length === 0 || onCooldown}
                title="Fill the empty squares and leave every letter already on the grid alone"
                className="btn btn-accent"
              >
                <RefreshCw size={16} />{onCooldown ? `Wait ${cooldownLeft}s` : 'Fill Remaining'}
              </button>
            )}

            {activeTab === 'create' && !isGenerating && (
              <button
                onClick={handleManualRegenerate}
                disabled={words.length === 0 || onCooldown}
                title={lockedCells.size
                  ? `Reroll the grid, keeping your ${lockedCells.size} pinned ${lockedCells.size === 1 ? 'square' : 'squares'}`
                  : 'Reroll the whole grid — nothing is pinned yet, so everything may change'}
                className="btn"
              >
                <RefreshCw size={16} />{onCooldown ? `Wait ${cooldownLeft}s` : 'Regenerate'}
              </button>
            )}

            {activeTab === 'create' && isGenerating && (
              <button onClick={cancelGeneration} className="btn btn-ink">
                <X size={16} />Stop the Press
              </button>
            )}

            {activeTab === 'auto' && grid && (
              <button onClick={() => startPlayMode(grid, clues)} className="btn btn-ink">
                <Play size={13} />Play This Puzzle
              </button>
            )}

            {activeTab === 'auto' && grid && (
              <button
                onClick={() => {
                  // Generating no longer writes into Create behind the author's back, so
                  // moving a puzzle across is explicit — and asks first if there is
                  // hand-typed work in there to lose.
                  const hasOwnWork = lockedCells.size > 0;
                  if (hasOwnWork) {
                    setConfirmDialog({
                      title: 'Replace your Create grid?',
                      message: `Create holds ${lockedCells.size} pinned ${lockedCells.size === 1 ? 'square' : 'squares'} you typed. Sending this puzzle over replaces the grid and its clues. This can’t be undone.`,
                      confirmLabel: 'Replace it',
                      danger: true,
                      onConfirm: () => {
                        setConfirmDialog(null);
                        syncManualFromAuto(grid, clues, selectedLayoutIndex);
                        setActiveTab('create');
                      },
                    });
                    return;
                  }
                  syncManualFromAuto(grid, clues, selectedLayoutIndex);
                  setActiveTab('create');
                }}
                className="btn"
                title="Copy this puzzle into Create so you can edit it"
              >
                <PenTool size={13} />Send to Create
              </button>
            )}

            {activeTab === 'create' && (
              <div className="w-full flex flex-col gap-3 md:max-w-3xl border-t border-ink/12 mt-1 pt-4">
                <div className="eyebrow text-ink-soft">Specific Words for Create</div>
                <div className="text-xs text-ink-faint font-mono leading-relaxed">
                  Layout {layouts[currentLayoutIndex]?.grid.length}×{layouts[currentLayoutIndex]?.grid[0]?.length} · Max words {findSlots(layouts[currentLayoutIndex]?.grid || []).length} · Lengths {Object.entries(getLayoutStats(layouts[currentLayoutIndex]?.grid || []).lengthCounts || {}).sort((a,b)=>a[0]-b[0]).map(([len,count]) => `${len}(${count})`).join(', ')}
                </div>
                <div className="flex flex-wrap gap-1.5 items-center">
                  <span className="eyebrow mr-1">Difficulty</span>
                  {['random','easy','fair','moderate','hard','difficult'].map(opt => (
                    <button
                      key={opt}
                      onClick={() => setDifficultyChoice(opt)}
                      className={`px-2.5 py-1 rounded-sm border text-[11px] font-bold uppercase tracking-wide transition ${difficultyChoice === opt ? 'border-ink bg-ink text-paper-raised' : 'border-ink/25 text-ink-soft hover:bg-ink/5'}`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
                <textarea
                  value={manualRequiredInput}
                  onChange={(e) => setManualRequiredInput(e.target.value)}
                  placeholder="Comma-separated words to force into the puzzle (optional)"
                  className="field font-mono text-sm"
                  rows={2}
                />
                <div className="flex gap-2.5 items-center flex-wrap">
                  <span className="eyebrow">Placement</span>
                  <label className={`px-3 py-1.5 rounded-sm border cursor-pointer text-xs font-semibold ${manualRequiredMode === 'anchor' ? 'border-ink bg-ink text-paper-raised' : 'border-ink/25 text-ink-soft hover:bg-ink/5'}`}>
                    <input type="radio" className="hidden" checked={manualRequiredMode === 'anchor'} onChange={() => setManualRequiredMode('anchor')} />
                    Place first
                  </label>
                  <label className={`px-3 py-1.5 rounded-sm border cursor-pointer text-xs font-semibold ${manualRequiredMode === 'opportunistic' ? 'border-ink bg-ink text-paper-raised' : 'border-ink/25 text-ink-soft hover:bg-ink/5'}`}>
                    <input type="radio" className="hidden" checked={manualRequiredMode === 'opportunistic'} onChange={() => setManualRequiredMode('opportunistic')} />
                    Fill flexibly
                  </label>
                  <span className="text-xs text-ink-faint italic">(leave empty to generate normally)</span>
                </div>
              </div>
            )}

            <span className="hidden md:block ml-auto h-6 w-px bg-ink/15" />

            <button onClick={downloadPuzzle} disabled={activeTab === 'auto' ? !grid : !manualGrid} className="btn">
              <Download size={16} />Download
            </button>

            <button onClick={exportPuzzle} disabled={activeTab === 'auto' ? !grid : !manualGrid} className="btn">
              <Save size={16} />Export
            </button>

            <button onClick={sharePuzzle} disabled={activeTab === 'auto' ? !grid : !manualGrid} className="btn">
              <Share size={16} />Share
            </button>

            {auth.enabled && (
              <button onClick={saveCurrentPuzzle} disabled={activeTab === 'auto' ? !grid : !manualGrid} className="btn">
                <Save size={16} />Save
              </button>
            )}

            <label className="btn cursor-pointer">
              <FolderOpen size={16} />Import
              <input type="file" accept=".json" onChange={(e) => { importPuzzle(e); }} ref={puzzleFileInputRef} className="hidden" />
            </label>

            <button onClick={() => setDebugMode(!debugMode)} className={`btn btn-sm ${debugMode ? 'btn-ink' : 'btn-ghost'}`}>
              <Bug size={15} />Debug
            </button>
          </div>

          <div className="mt-4 text-ink-faint text-xs">CSV format: <span className="font-mono text-ink-soft">Date, Word, Clue</span> · drop <code className="chip">crosswords.csv</code> in the public folder for auto-load.</div>

          {isGenerating && <div className="mt-4 flex items-center gap-3 border-l-2 border-ink bg-paper-sunken px-4 py-3 text-ink-soft text-sm"><span className="h-4 w-4 animate-spin rounded-full border-2 border-ink/25 border-t-ink" />{progress}</div>}
          {!isGenerating && error && <div className="mt-4 border-l-2 border-accent bg-accent/8 px-4 py-3 text-accent-deep text-sm font-medium">{error}</div>}
          {!isGenerating && progress && <div className="mt-4 border-l-2 border-grass bg-grass/8 px-4 py-3 text-grass text-sm font-medium">{progress}</div>}
          {words.length > 0 && !isGenerating && <div className="mt-4 text-ink-soft text-sm flex items-center gap-2"><Check size={15} className="text-grass" />Loaded <b className="font-mono">{words.length}</b> words from CSV</div>}
        </div>
        ) : (
        <div className="panel panel-pad mb-6 overflow-visible animate-rise-in" style={{ animationDelay: '60ms' }}>
          <div className="flex gap-2.5 flex-wrap items-center relative">
            <label className="btn cursor-pointer">
              <Upload size={16} />Upload CSV
              <input type="file" accept=".csv" onChange={handleFileUpload} className="hidden" />
            </label>

            <div className="relative">
              <button onClick={() => setShowLayoutSelector(!showLayoutSelector)} className="btn">
                <Grid3X3 size={16} />{layouts[layoutIndexForTab]?.name}
              </button>
            </div>

            {!isGenerating && (
              <button
                onClick={() => {
                  if (activeTab === 'play') {
                    generatePuzzle(selectedLayoutIndex, true, requiredWords, requiredMode);
                  } else {
                    setRequiredAction('play');
                    setShowRequiredModal(true);
                  }
                }}
                disabled={words.length === 0}
                className="btn btn-accent"
              >
                <RefreshCw size={16} />Generate &amp; Play
              </button>
            )}

            {isGenerating && (
              <button onClick={cancelGeneration} className="btn btn-ink">
                <X size={16} />Stop the Press
              </button>
            )}

            {latestGrid && latestClues && !isGenerating && (
              <button onClick={() => startPlayMode(latestGrid, latestClues)} className="btn btn-ink">
                <Play size={13} />Play Latest Puzzle
              </button>
            )}

            {activeTab === 'play' && (
              <div className="flex flex-col gap-1">
                <div className="flex items-center gap-1.5">
                <input
                  value={shareCodeInput}
                  onChange={(e) => { setShareCodeInput(e.target.value); setShareCodeError(''); }}
                  onKeyDown={(e) => { if (e.key === 'Enter') playByShareCode(); }}
                  placeholder="Puzzle code"
                  aria-label="Play a shared puzzle by its code"
                  spellCheck={false}
                  autoCapitalize="characters"
                  className="w-32 px-2.5 py-1.5 rounded-sm border border-ink/25 bg-paper-raised font-mono text-sm uppercase tracking-wider placeholder:normal-case placeholder:tracking-normal placeholder:text-ink-faint"
                />
                <button onClick={playByShareCode} disabled={shareCodeBusy} className="btn btn-sm">
                  {shareCodeBusy ? <RefreshCw size={14} className="animate-spin" /> : <Play size={13} />}Open
                </button>
                </div>
                {shareCodeError && (
                  <span className="text-[11px] text-accent max-w-[17rem] leading-snug">{shareCodeError}</span>
                )}
              </div>
            )}

            <label className="btn cursor-pointer">
              <FolderOpen size={16} />Import to Play
              <input type="file" accept=".json" onChange={(e) => { importPuzzlePlay(e); }} ref={puzzleFileInputRef} className="hidden" />
            </label>

            <button onClick={sharePuzzle} disabled={!playGrid} className="btn">
              <Share size={16} />Share
            </button>

            {auth.enabled && (
              <button onClick={saveCurrentPuzzle} disabled={!playAnswers} className="btn">
                <Save size={16} />Save
              </button>
            )}

            <button onClick={() => setDebugMode(!debugMode)} className={`btn btn-sm ${debugMode ? 'btn-ink' : 'btn-ghost'}`}>
              <Bug size={15} />Debug
            </button>
          </div>

          <div className="mt-4 text-ink-faint text-xs">Stay in Play mode: upload a CSV, pick a layout, then generate to jump straight into playing — or import a saved puzzle JSON.</div>

          {isGenerating && <div className="mt-4 flex items-center gap-3 border-l-2 border-ink bg-paper-sunken px-4 py-3 text-ink-soft text-sm"><span className="h-4 w-4 animate-spin rounded-full border-2 border-ink/25 border-t-ink" />{progress}</div>}
          {!isGenerating && error && <div className="mt-4 border-l-2 border-accent bg-accent/8 px-4 py-3 text-accent-deep text-sm font-medium">{error}</div>}
          {!isGenerating && progress && <div className="mt-4 border-l-2 border-grass bg-grass/8 px-4 py-3 text-grass text-sm font-medium">{progress}</div>}
          {words.length > 0 && !isGenerating && <div className="mt-4 text-ink-soft text-sm flex items-center gap-2"><Check size={15} className="text-grass" />Loaded <b className="font-mono">{words.length}</b> words from CSV</div>}
        </div>
        ))}

        {activeTab === 'browse' && (
          <BrowseView
            onPlay={(puzzle) => startPlayMode(puzzle.grid, puzzle.clues, {
              circles: puzzle.circles,
              shades: puzzle.shades,
              meta: {
                source: 'imported',
                sourceId: puzzle.meta?.pid || puzzle.pid,
                sourceName: 'crosswithfriends',
                title: puzzle.meta?.title,
              },
            })}
            onHost={(puzzle) => { setMpSeedPuzzle(puzzle); setActiveTab('multiplayer'); }}
          />
        )}

        {activeTab === 'multiplayer' && (
          <MultiplayerView
            puzzle={hostablePuzzle}
            seedPuzzle={mpSeedPuzzle}
            onConsumeSeed={() => setMpSeedPuzzle(null)}
            authUser={auth.user ? { id: auth.user.id, displayName: auth.displayName } : null}
            autoJoinCode={autoJoinCode}
            onGeneratePuzzle={generateFreshPuzzle}
          />
        )}

        {activeTab === 'history' && (
          <SolveHistory authUser={auth.user} onSignIn={() => setShowAuth(true)} />
        )}

        {activeTab === 'mypuzzles' && (
          <MyPuzzlesView
            authUser={auth.user}
            onSignIn={() => setShowAuth(true)}
            onPlay={(data, row) => startPlayMode(data.grid, data.clues, {
              circles: data.circles,
              shades: data.shades,
              meta: { source: 'imported', remoteId: row?.id, title: row?.title || data.meta?.title },
            })}
            onEdit={(data) => loadPuzzleIntoCreate(data)}
            onHost={(data) => { setMpSeedPuzzle({ grid: data.grid, clues: data.clues, meta: data.meta }); setActiveTab('multiplayer'); }}
          />
        )}

        {debugMode && debugLog.length > 0 && (
          <div className="panel p-4 mb-6 font-mono text-xs max-h-64 overflow-y-auto">
            <div className="flex justify-between items-center mb-3"><h2 className="eyebrow text-ink">Debug Log</h2><button onClick={() => setDebugLog([])} className="btn btn-sm btn-ghost">Clear</button></div>
            {debugLog.map((line, i) => <div key={i} className="text-ink-soft mb-1">{line}</div>)}
          </div>
        )}
        
        {activeTab === 'auto' && grid && (
          <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 animate-rise-in" style={{ animationDelay: '120ms' }}>
            <div className="xl:col-span-2 panel panel-pad">
              <div className="flex items-end justify-between gap-3 flex-wrap">
                <div>
                  <div className="eyebrow">The Puzzle</div>
                  <h2 className="font-display text-2xl font-semibold text-ink leading-tight">Proof Grid</h2>
                </div>
                <div className="flex items-center gap-2 flex-wrap">
                  {difficultyInfo?.label && (
                    <span className="inline-flex items-center gap-2 border border-ink/20 bg-paper-sunken px-3 py-1.5 rounded-sm">
                      <span className="eyebrow">Difficulty</span>
                      <span className={`font-display font-semibold ${difficultyColorClass(difficultyInfo.label)}`}>{difficultyInfo.label}</span>
                      {difficultyInfo.score !== null && <span className="font-mono text-xs text-ink-faint">({Math.round(difficultyInfo.score)})</span>}
                    </span>
                  )}
                  {clues && (clues.across?.length || 0) > 0 && (
                    <button
                      onClick={() => setReclue((r) => (r ? null : { band: 'medium', selected: new Set() }))}
                      className="btn btn-sm btn-ghost"
                      title="Swap in clues at a chosen difficulty"
                    >
                      <RefreshCw size={14} />Re-clue
                    </button>
                  )}
                  {ollamaConfig.enabled && clues && (clues.across?.length || 0) > 0 && (
                    <button
                      onClick={runDifficultyAudit}
                      disabled={auditState.running}
                      className="btn btn-sm btn-ghost"
                      title="Rate every clue with your local model"
                    >
                      <Zap size={14} />
                      {auditState.running
                        ? `Auditing ${auditState.done}/${auditState.total}…`
                        : 'AI Audit'}
                    </button>
                  )}
                </div>
              </div>

              {reclue && activeTab === 'auto' && (
                <ReclueReview
                  band={reclue.band}
                  onBandChange={(b) => setReclue((r) => ({ ...r, band: b }))}
                  running={!!reclue.running}
                  progress={reclue.progress}
                  result={reclue.result}
                  error={reclue.error}
                  selected={reclue.selected || new Set()}
                  aiEnabled={ollamaConfig.enabled}
                  onToggle={(k) => setReclue((r) => {
                    const next = new Set(r.selected);
                    if (next.has(k)) next.delete(k); else next.add(k);
                    return { ...r, selected: next };
                  })}
                  onRun={() => runReclue(reclue.band)}
                  onApply={applyReclue}
                  onClose={() => setReclue(null)}
                />
              )}

              {(auditState.summary || auditState.error) && (
                <div className="mb-4 border border-ink/15 bg-paper-sunken rounded-sm p-3">
                  {auditState.error ? (
                    <p className="text-xs text-accent">{auditState.error}</p>
                  ) : (
                    <>
                      <div className="flex items-baseline gap-3 flex-wrap mb-2">
                        <span className="eyebrow">AI difficulty</span>
                        <span className="font-display font-semibold text-ink">
                          {Math.round(auditState.summary.mean)}
                        </span>
                        <span className="text-xs text-ink-faint font-mono">
                          hardest fifth {Math.round(auditState.summary.p80)}
                          {auditState.summary.unrated > 0 && ` · ${auditState.summary.unrated} unrated`}
                        </span>
                      </div>
                      {/* The average hides the entries that actually stall a solver, so
                          call out the worst few explicitly. */}
                      <ul className="text-xs text-ink-soft space-y-0.5">
                        {auditState.summary.hardest.map((h) => (
                          <li key={`${h.number}-${h.direction}`}>
                            <span className="font-mono text-ink-faint mr-1.5">{Math.round(h.difficulty)}</span>
                            <span className="font-semibold">{h.number} {h.direction === 'across' ? 'A' : 'D'}</span>
                            {' '}{h.word} — {renderRich(h.clue)}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
              <div className="rule-hair my-4" />
              <div className="overflow-x-auto pb-2"><div className="xw-grid" style={{ '--cols': grid[0]?.length || 15 }}>
                {grid.map((row, r) => <div key={r} className="flex">{row.map((cell, c) => <div key={c} className={`xw-cell ${cell === '#' ? 'xw-cell--block' : ''}`}>{cell !== '#' && getNumberForCell(r, c) && <span className="xw-num">{getNumberForCell(r, c)}</span>}{cell !== '#' && cell !== null && <span className="xw-letter">{cell}</span>}</div>)}</div>)}
              </div></div>
            </div>
            <div className="panel panel-pad max-h-[640px] overflow-y-auto">
              <div className="eyebrow">Solutions</div>
              <h2 className="font-display text-2xl font-semibold text-ink mb-4">Clues</h2>
              <div className="mb-6">
                <h3 className="eyebrow text-ink flex items-center gap-1.5 border-b border-ink/15 pb-1.5 mb-3"><ChevronRight size={13} />Across</h3>
                {clues.across.map(clue => <div key={`across-${clue.number}`} className="mb-2.5 text-sm text-ink-soft leading-snug"><span className="font-mono font-semibold text-accent mr-1.5">{clue.number}</span>{renderRich(clue.clue)}</div>)}
              </div>
              <div>
                <h3 className="eyebrow text-ink flex items-center gap-1.5 border-b border-ink/15 pb-1.5 mb-3"><ChevronDown size={13} />Down</h3>
                {clues.down.map(clue => <div key={`down-${clue.number}`} className="mb-2.5 text-sm text-ink-soft leading-snug"><span className="font-mono font-semibold text-accent mr-1.5">{clue.number}</span>{renderRich(clue.clue)}</div>)}
              </div>
            </div>
          </div>
        )}
        
        {activeTab === 'create' && manualGrid && (
          <ManualEditor
            manualGrid={manualGrid}
            manualClues={manualClues}
            selectedCell={selectedCell}
            selectedDirection={selectedDirection}
            handleCellClick={handleCellClick}
            getNumberForCell={getNumberForCell}
            isInCurrentWord={isInCurrentWord}
            getCurrentWord={getCurrentWord}
            getClueForCurrentSlot={getClueForCurrentSlot}
            setSelectedCell={setSelectedCell}
            setSelectedDirection={setSelectedDirection}
            editingClue={editingClue}
            clueInput={clueInput}
            setClueInput={setClueInput}
            updateClue={updateClue}
            setEditingClue={setEditingClue}
            words={words}
            showSuggestions={showSuggestions}
            setShowSuggestions={setShowSuggestions}
            suggestions={suggestions}
            setSuggestions={setSuggestions}
            findSuggestionsForSlot={findSuggestionsForSlot}
            applySuggestion={applySuggestion}
            tagalogMode={tagalogMode}
            puzzleDateInfo={puzzleDateInfo}
            getDateInfoForWord={getDateInfoForWord}
            getDateInfoForWordClue={getDateInfoForWordClue}
            failedWord={failedWord}
            highlightedWords={requiredHighlights}
            showRequiredHighlights={showRequiredHighlights}
            setShowRequiredHighlights={setShowRequiredHighlights}
            highlightMissingRequired={highlightMissingRequired}
            setHighlightMissingRequired={setHighlightMissingRequired}
            difficultyInfo={difficultyInfo}
            aiEnabled={ollamaConfig.enabled}
            clueStudio={clueStudio}
            onOpenClueStudio={openClueStudio}
            onCloseClueStudio={() => setClueStudio(null)}
            onClueStudioBand={setClueStudioBand}
            onClueStudioSense={(v) => setClueStudio((st) => (st ? { ...st, sense: v } : st))}
            onDiscoverSenses={discoverStudioSenses}
            onPickSense={pickStudioSense}
            onGenerateClues={generateStudioClues}
            onClueAccepted={saveUserClue}
            aiGenerateClues={aiGenerateClues}
            onOpenSettings={() => setShowSettings(true)}
            onVirtualKey={applyManualKey}
            lockedCells={lockedCells}
            circles={manualCircles}
            onToggleCircle={toggleManualCircle}
            rebusOn={manualRebusMode}
            onToggleRebus={() => setManualRebusMode((v) => !v)}
            onToggleCellLock={toggleCellLock}
            onToggleWordLock={toggleCurrentWordLock}
            onUnpinAll={unpinAll}
            onOpenReclue={() => setReclue((r) => (r ? null : { band: 'medium', selected: new Set() }))}
          />
        )}
        {reclue && activeTab === 'create' && (
          <ReclueReview
            band={reclue.band}
            onBandChange={(b) => setReclue((r) => ({ ...r, band: b }))}
            running={!!reclue.running}
            progress={reclue.progress}
            result={reclue.result}
            error={reclue.error}
            selected={reclue.selected || new Set()}
            aiEnabled={ollamaConfig.enabled}
            onToggle={(k) => setReclue((r) => {
              const next = new Set(r.selected);
              if (next.has(k)) next.delete(k); else next.add(k);
              return { ...r, selected: next };
            })}
            onRun={() => runReclue(reclue.band)}
            onApply={applyReclue}
            onClose={() => setReclue(null)}
          />
        )}
        
        {activeTab === 'auto' && !grid && !isGenerating && (
          <div className="panel p-12 text-center animate-rise-in" style={{ animationDelay: '120ms' }}>
            <Puzzle size={56} className="mx-auto text-ink/25 mb-4" />
            <h3 className="font-display text-2xl font-semibold text-ink mb-2">No Edition Set</h3>
            <p className="text-ink-faint max-w-sm mx-auto">Upload a CSV word list to typeset a fresh crossword — or import a puzzle you saved earlier.</p>
          </div>
        )}
        
        {/* PLAY MODE */}
        {activeTab === 'play' && (
          <div className="mb-4 flex flex-wrap items-center gap-1.5">
            <span className="eyebrow mr-1">Difficulty</span>
            {['random','easy','fair','moderate','hard','difficult'].map(opt => (
              <button
                key={opt}
                onClick={() => setDifficultyChoice(opt)}
                className={`px-2.5 py-1 rounded-sm border text-[11px] font-bold uppercase tracking-wide transition ${difficultyChoice === opt ? 'border-ink bg-ink text-paper-raised' : 'border-ink/25 text-ink-soft hover:bg-ink/5'}`}
              >
                {opt}
              </button>
            ))}
            <span className="text-xs text-ink-faint italic ml-1">(applies when you Generate &amp; Play)</span>
          </div>
        )}

        {activeTab === 'play' && playGrid && (gameView ? (
          <GameView
            playGrid={playGrid}
            playClues={playClues}
            playDirection={playDirection}
            playSelectedCell={playSelectedCell}
            playAnswers={playAnswers}
            playComplete={playComplete}
            playTimer={playTimer}
            playAutoCheck={playAutoCheck}
            revealedCells={revealedCells}
            setPlayAutoCheck={setPlayAutoCheck}
            revealCell={revealCell}
            revealWord={revealWord}
            revealAll={revealAll}
            handlePlayCellClick={handlePlayCellClick}
            getNumberForCell={getNumberForCell}
            getPlayCurrentSlot={getPlayCurrentSlot}
            setPlaySelectedCell={setPlaySelectedCell}
            setPlayDirection={setPlayDirection}
            formatTime={formatTime}
            onVirtualKey={applyPlayKey}
            goToAdjacentClue={goToAdjacentClue}
            paused={playPaused}
            onTogglePause={togglePlayPause}
            checkedCells={checkedCells}
            onCheckSquare={checkSquare}
            onCheckWord={checkWord}
            onCheckPuzzle={checkPuzzle}
            onClearWord={clearCurrentWord}
            circles={playCircles}
            shades={playShades}
            rebusOn={rebusMode}
            onToggleRebus={() => setRebusMode(v => !v)}
            onExit={() => setGameView(false)}
          />
        ) : (
          <PlayView
            playGrid={playGrid}
            playClues={playClues}
            playDirection={playDirection}
            playSelectedCell={playSelectedCell}
            playAnswers={playAnswers}
            playComplete={playComplete}
            playTimer={playTimer}
            playAutoCheck={playAutoCheck}
            revealedCells={revealedCells}
            setPlayAutoCheck={setPlayAutoCheck}
            revealCell={revealCell}
            revealWord={revealWord}
            revealAll={revealAll}
            handlePlayCellClick={handlePlayCellClick}
            isInPlayCurrentWord={isInPlayCurrentWord}
            getNumberForCell={getNumberForCell}
            getPlayCurrentSlot={getPlayCurrentSlot}
            setPlaySelectedCell={setPlaySelectedCell}
            setPlayDirection={setPlayDirection}
            formatTime={formatTime}
            difficultyInfo={difficultyInfo}
            onVirtualKey={applyPlayKey}
            goToAdjacentClue={goToAdjacentClue}
            paused={playPaused}
            onTogglePause={togglePlayPause}
            checkedCells={checkedCells}
            onCheckSquare={checkSquare}
            onCheckWord={checkWord}
            onCheckPuzzle={checkPuzzle}
            onClearWord={clearCurrentWord}
            circles={playCircles}
            shades={playShades}
            rebusOn={rebusMode}
            onToggleRebus={() => setRebusMode(v => !v)}
            onEnterGameView={() => setGameView(true)}
          />
        ))}
        
        {activeTab === 'play' && !playGrid && (
          <div className="panel p-12 text-center animate-rise-in">
            <Play size={44} className="mx-auto text-ink/25 mb-4" />
            <h3 className="font-display text-2xl font-semibold text-ink mb-2">Nothing on the Stand</h3>
            <p className="text-ink-faint mb-6 max-w-md mx-auto">Generate a puzzle in Play mode, or import a saved crossword to start solving immediately.</p>
            <div className="flex flex-wrap justify-center gap-3">
              <button onClick={() => generatePuzzle(selectedLayoutIndex, true)} disabled={words.length === 0 || isGenerating} className="btn btn-accent">
                <RefreshCw size={16} />Generate &amp; Play
              </button>
              <button onClick={() => puzzleFileInputRef.current?.click()} className="btn">
                <FolderOpen size={16} />Import Puzzle
              </button>
            </div>
            <p className="text-ink-faint text-xs mt-5 italic">Tip: upload a CSV word list first so we can typeset a grid for you.</p>
          </div>
        )}
      </div>
      
      <LayoutSelector
        isOpen={showLayoutSelector}
        layouts={layouts}
        activeTab={activeTab}
        layoutIndexForTab={layoutIndexForTab}
        onSelect={handleSelectLayout}
        onClose={() => setShowLayoutSelector(false)}
        onCreateLayout={() => { setShowLayoutSelector(false); openCreateLayoutModal(); }}
        onEditLayout={() => { setShowLayoutSelector(false); openEditLayoutModal(); }}
      />

      <LayoutEditorModal
        isOpen={showLayoutModal}
        onClose={() => { setShowLayoutModal(false); setEditingLayoutIndex(null); }}
        onSave={handleSaveLayout}
        editingLayout={editingLayoutIndex !== null ? layouts[editingLayoutIndex] : null}
        mode={layoutEditorMode}
      />
      
      <RequiredWordsModal
        isOpen={showRequiredModal}
        onClose={() => setShowRequiredModal(false)}
        onConfirm={(words, mode, difficulty) => handleRequiredConfirm(words, mode, difficulty)}
        initialWords={requiredWords}
        stats={{
          rows: layouts[selectedLayoutIndex]?.grid.length || 0,
          cols: layouts[selectedLayoutIndex]?.grid[0]?.length || 0,
          // Computed on every render, open or not, so it must survive a missing layout.
          // findSlots([]) reads layout[0].length and throws, which used to white-screen the
          // whole app on reload whenever selectedLayoutIndex pointed past the end.
          slots: layoutStatsForModal.slots,
          lengthCounts: layoutStatsForModal.lengthCounts
        }}
        modeView={requiredViewMode}
        onModeChange={setRequiredViewMode}
        initialDifficulty={difficultyChoice}
      />
      
      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        config={ollamaConfig}
        onSave={handleSaveOllama}
      />

      <AuthModal isOpen={showAuth} onClose={() => setShowAuth(false)} auth={auth} />

      <ConfirmModal
        open={!!confirmDialog}
        title={confirmDialog?.title}
        message={confirmDialog?.message}
        confirmLabel={confirmDialog?.confirmLabel}
        danger={confirmDialog?.danger}
        onConfirm={confirmDialog?.onConfirm}
        onCancel={() => setConfirmDialog(null)}
      />

      <ResultModal
        open={showResult}
        timeText={formatTime(playTimer)}
        clean={cleanSolve}
        difficulty={difficultyInfo?.label}
        onClose={() => setShowResult(false)}
        onShare={sharePuzzle}
        onPlayAgain={words.length ? () => { setShowResult(false); generatePuzzle(selectedLayoutIndex, true); } : null}
      />

      <DictionaryModal
        isOpen={showDictionary}
        onClose={() => setShowDictionary(false)}
        words={words}
        dictionarySearch={dictionarySearch}
        setDictionarySearch={setDictionarySearch}
        newWord={newWord}
        setNewWord={setNewWord}
        newClue={newClue}
        setNewClue={setNewClue}
        addWordToDictionary={addWordToDictionary}
        exportDictionary={exportDictionary}
        getFilteredWords={getFilteredWords}
        editingWordIndex={editingWordIndex}
        setEditingWordIndex={setEditingWordIndex}
        editWord={editWord}
        setEditWord={setEditWord}
        editClue={editClue}
        setEditClue={setEditClue}
        saveEditWord={saveEditWord}
        startEditWord={startEditWord}
        deleteWordFromDictionary={deleteWordFromDictionary}
      />
    </div>
  );
};

export default CrosswordGenerator;
