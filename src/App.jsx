import React, { useState, useCallback, useRef, useEffect } from 'react';
import { Upload, Download, RefreshCw, Bug, Puzzle, PenTool, X, Check, ChevronRight, ChevronDown, Save, FolderOpen, Grid3X3, Play, BookOpen, Languages, Settings, Flame, DownloadCloud, Zap, Share, Search, Volume2, VolumeX, Maximize } from './components/Icons';
import BrowseView from './components/BrowseView';
import MultiplayerView from './components/MultiplayerView';
import AuthModal from './components/AuthModal';
import MyPuzzlesView from './components/MyPuzzlesView';
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
import { loadJSON, saveJSON } from './utils/storage';

// Clues the user writes or accepts. Kept separate from the corpus so they survive the CSV
// being re-fetched on every load, and so they can be exported and fed back into the
// pipeline later.
const USER_CLUES_KEY = 'userClues';
import { todayKey, seedFromString, getStreak, recordDailySolve, isDailySolved } from './utils/daily';
import { difficultyLabelFromScore, difficultyColorClass, difficultyTargetOf } from './utils/difficulty';
import { getOllamaConfig, saveOllamaConfig, generateClues, auditDifficulty } from './utils/ollama';
import { loadClueModel, cluePercentile } from './utils/clueScore';
import {
  BANDS, scoreCandidates, flagImplausible, makeGenerator, recluePuzzle,
} from './utils/clueSource';
import { memoryClueStore } from './utils/clueIndex';
import { useAuth } from './hooks/useAuth';
import { savePuzzle } from './lib/puzzles';
import { sfx, isSoundOn, setSoundOn } from './utils/sound';
import { burstConfetti } from './utils/confetti';
import { renderRich } from './utils/richText';

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
  const auth = useAuth();

  const toggleSound = () => {
    const next = !soundOn;
    setSoundOn(next);
    setSoundOnState(next);
    if (next) sfx.reveal(); // audible confirmation
  };

  const puzzleFileInputRef = useRef(null);
  const playTimerRef = useRef(null);
  const workerRef = useRef(null);
  const restoredRef = useRef(false);
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
    if (difficulty) setDifficultyChoice(difficulty);
    setRequiredWords(wordsList);
    setRequiredMode(chosenMode);
    setShowRequiredModal(false);
    if (requiredAction === 'play') {
      handleAutoGeneratePlayInternal(wordsList, chosenMode);
    } else {
      handleAutoGenerateInternal(wordsList, chosenMode);
    }
  };

  const generateManualFill = async (wordList = words, requiredWordsList = [], requiredModeInput = 'opportunistic') => {
    if (!manualGrid) { setError('Create a grid first'); return; }
    if (wordList.length === 0) { setError('Please upload a CSV file first'); return; }
    if (!layouts[currentLayoutIndex]) { setError('Please select a valid layout'); return; }
    
    cancelRef.current = false;
    setIsGenerating(true);
    setFailedWord(null);
    setProgress('Filling remaining slots...');
    setError('');
    
    const layout = layouts[currentLayoutIndex].grid;
    const presetGrid = manualGrid.map(row => row.map(cell => {
      if (cell === '#') return '#';
      if (!cell) return null;
      return cell.toUpperCase();
    }));
    
    const presetClues = {};
    manualClues.across.forEach(c => {
      presetClues[`across-${c.row}-${c.col}`] = c.clue || '';
    });
    manualClues.down.forEach(c => {
      presetClues[`down-${c.row}-${c.col}`] = c.clue || '';
    });
    const requiredMerged = requiredWordsList.map(w => w.toUpperCase());

    // Fully-filled squares are passed through as presetGrid; the solver injects any
    // off-dictionary entries itself and constrains around them, so there is no longer a
    // hand-built word list to assemble here.
    const result = await generateCrossword(
      layout,
      setProgress,
      15000,
      presetGrid,
      requiredMerged,
      requiredModeInput,
      presetClues,
      difficultyTargetOf(difficultyChoice),
      null,
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
      if (filled === 0) setError('Could not place additional words with the current letters.');
      const lastPlaced = placements?.length ? placements[placements.length - 1]?.word : null;
      setFailedWord(lastPlaced || solveFailedWord || null);
    }
    
    setIsGenerating(false);
  };
  
  const handleManualGenerate = () => {
    const manualRequired = parseWordListInput(manualRequiredInput);
    generateManualFill(words, manualRequired, manualRequiredMode || 'opportunistic');
  };

  const normalizeLayoutGrid = (gridData) => gridData.map(row => Array.isArray(row) ? row.join('') : row);

  const handleSaveLayout = (name, gridData) => {
    const normalizedGrid = normalizeLayoutGrid(gridData);
    let updatedLayouts = layouts;

    if (layoutEditorMode === 'edit' && editingLayoutIndex !== null) {
      updatedLayouts = layouts.map((layout, idx) => idx === editingLayoutIndex ? { ...layout, name, grid: normalizedGrid } : layout);
      setLayouts(updatedLayouts);
      setSelectedLayoutIndex(editingLayoutIndex);
      setCurrentLayoutIndex(editingLayoutIndex);
      if (activeTab === 'create') initializeManualGrid(editingLayoutIndex, updatedLayouts);
    } else {
      updatedLayouts = [...layouts, { name, grid: normalizedGrid }];
      const newIndex = updatedLayouts.length - 1;
      setLayouts(updatedLayouts);
      setSelectedLayoutIndex(newIndex);
      setCurrentLayoutIndex(newIndex);
      if (activeTab === 'create') initializeManualGrid(newIndex, updatedLayouts);
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
  const corpusFpRef = useRef(null);

  const ensureWorker = () => {
    if (workerRef.current) return workerRef.current;
    const w = new Worker(new URL('./worker/crosswordWorker.js', import.meta.url), { type: 'module' });
    w.onmessage = (e) => {
      // Clue data has its own channel so it can't be mistaken for solver progress.
      if (e.data?.type === 'clueDataResult') { clueDataPendingRef.current?.(e.data.data); return; }
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
    const timeoutMs = 15000;
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
      syncManualFromAuto(newGrid, generatedClues, layoutIdx);
      if (autoStartPlay) {
        startPlayMode(newGrid, generatedClues);
      }
      setProgress(`Success! All ${slots.length} slots filled.`);
      setTimeout(() => setProgress(''), 5000);
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
      syncManualFromAuto(newGrid, generatedClues, layoutIdx);
      setActiveTab('create');
      setError(picked?.error?.message
        || `Stopped: best result was ${placements.length}/${slots.length} slots filled. You can edit it in Create.`);
      setFailedWord(solveFailedWord || null);
    } else {
      // Preflight refusals land here: they name the actual blocker (a 2-letter slot,
      // a required word with nowhere to go, an impossible preset) instead of leaving
      // the user staring at a spinner for two minutes.
      setError(picked?.error?.message
        || 'Could not place any words. Check that your word list has words of the right lengths.');
    }
    
    setIsGenerating(false);
  };

  const handleAutoGenerateInternal = (reqWords, mode) => {
    generatePuzzle(selectedLayoutIndex, false, reqWords, mode, difficultyChoice);
  };
  
  const handleAutoGeneratePlayInternal = (reqWords, mode) => {
    generatePuzzle(selectedLayoutIndex, true, reqWords, mode, difficultyChoice);
  };

  const syncManualFromAuto = (newGrid, generatedClues, layoutIdx) => {
    if (!newGrid || !generatedClues) return;
    const layout = layouts[layoutIdx]?.grid || layouts[0]?.grid;
    if (!layout) return;
    setCurrentLayoutIndex(layoutIdx);
    setManualGrid(newGrid.map(row => row.map(cell => cell === null ? '' : cell)));
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
        startPlayMode(puzzleData.grid, importedClues, { circles: puzzleData.circles, shades: puzzleData.shades });
        
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
    
    const acrossCluesText = currentClues.across.map(c => `${c.number}. ${c.clue || '(No clue)'}`);
    const downCluesText = currentClues.down.map(c => `${c.number}. ${c.clue || '(No clue)'}`);
    
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
    return ['input', 'textarea', 'select', 'button'].includes(tag) || el.isContentEditable;
  };

  const parseWordListInput = (inputText) => inputText
    .split(',')
    .map(w => w.trim().toUpperCase().replace(/[^A-Z]/g, ''))
    .filter(Boolean);

  // Core Create-grid input — shared by the physical keyboard and the on-screen keyboard.
  const applyManualKey = (key) => {
    if (!selectedCell || !manualGrid) return;
    const { row, col } = selectedCell;
    if (key === 'Backspace') {
      const newGrid = manualGrid.map(r => [...r]);
      if (newGrid[row][col]) {
        newGrid[row][col] = '';
        setManualGrid(newGrid);
      } else if (selectedDirection === 'across' && col > 0 && manualGrid[row][col - 1] !== '#') {
        newGrid[row][col - 1] = '';
        setManualGrid(newGrid);
        setSelectedCell({ row, col: col - 1 });
      } else if (selectedDirection === 'down' && row > 0 && manualGrid[row - 1][col] !== '#') {
        newGrid[row - 1][col] = '';
        setManualGrid(newGrid);
        setSelectedCell({ row: row - 1, col });
      }
      return;
    }
    if (key.length === 1 && /[a-zA-Z]/.test(key)) {
      const newGrid = manualGrid.map(r => [...r]);
      newGrid[row][col] = key.toUpperCase();
      setManualGrid(newGrid);
      if (selectedDirection === 'across' && col < manualGrid[0].length - 1 && manualGrid[row][col + 1] !== '#') setSelectedCell({ row, col: col + 1 });
      else if (selectedDirection === 'down' && row < manualGrid.length - 1 && manualGrid[row + 1][col] !== '#') setSelectedCell({ row: row + 1, col });
      return;
    }
    if (key === 'ArrowRight' && col < manualGrid[0].length - 1 && manualGrid[row][col + 1] !== '#') { setSelectedCell({ row, col: col + 1 }); setSelectedDirection('across'); }
    else if (key === 'ArrowLeft' && col > 0 && manualGrid[row][col - 1] !== '#') { setSelectedCell({ row, col: col - 1 }); setSelectedDirection('across'); }
    else if (key === 'ArrowDown' && row < manualGrid.length - 1 && manualGrid[row + 1][col] !== '#') { setSelectedCell({ row: row + 1, col }); setSelectedDirection('down'); }
    else if (key === 'ArrowUp' && row > 0 && manualGrid[row - 1][col] !== '#') { setSelectedCell({ row: row - 1, col }); setSelectedDirection('down'); }
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
    const { slot } = getCurrentWord();
    if (!slot) return;
    const direction = slot.direction;
    const clueList = direction === 'across' ? [...manualClues.across] : [...manualClues.down];
    const clueIndex = clueList.findIndex(c => c.row === slot.row && c.col === slot.col);
    if (clueIndex !== -1) {
      clueList[clueIndex] = { ...clueList[clueIndex], clue: clueText };
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

  const findSuggestionsForSlot = () => {
    const { word, slot } = getCurrentWord();
    if (!slot || words.length === 0) return [];

    const pattern = word.replace(/_/g, '.');
    const regex = new RegExp(`^${pattern}$`, 'i');

    // Step 1: find all matches
    const matches = words.filter(
      w => w.word.length === slot.length && regex.test(w.word)
    );

    if (matches.length === 0) return [];

    // 🔀 Randomize matches first
    const shuffledMatches = shuffle(matches);

    // Step 2: group by Word (already randomized)
    const byWord = shuffledMatches.reduce((acc, item) => {
      if (!acc[item.word]) acc[item.word] = [];
      acc[item.word].push(item);
      return acc;
    }, {});

    const uniqueWords = Object.keys(byWord);

    // Step 3: decision logic
    if (uniqueWords.length === 1) {
      // One word → show all clues (already randomized)
      return shuffle(byWord[uniqueWords[0]]);
    }

    // Multiple words → one random clue per word
    return shuffle(
      uniqueWords.map(word => {
        const clues = byWord[word];
        return clues[Math.floor(Math.random() * clues.length)];
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
        return;
      }
      if (key.length === 1 && /[a-zA-Z]/.test(key)) {
        const newGrid = playGrid.map(r => [...r]);
        newGrid[row][col] = (cur + key.toUpperCase()).slice(0, 8);
        setPlayGrid(newGrid);
        sfx.key();
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
      } else if (playDirection === 'across' && col > 0 && playGrid[row][col - 1] !== '#') {
        // empty already → step back and clear
        newGrid[row][col - 1] = '';
        setPlayGrid(newGrid);
        setPlaySelectedCell({ row, col: col - 1 });
      } else if (playDirection === 'down' && row > 0 && playGrid[row - 1][col] !== '#') {
        newGrid[row - 1][col] = '';
        setPlayGrid(newGrid);
        setPlaySelectedCell({ row: row - 1, col });
      }
      return;
    }

    if (key.length === 1 && /[a-zA-Z]/.test(key)) {
      const newGrid = playGrid.map(r => [...r]);
      newGrid[row][col] = key.toUpperCase();
      setPlayGrid(newGrid);
      sfx.key();
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
      // Check completion (even if auto-check is off, so the timer stops)
      checkPlayComplete(newGrid);
      return;
    }

    // Arrow key navigation
    if (key === 'ArrowRight' && col < playGrid[0].length - 1 && playGrid[row][col + 1] !== '#') {
      setPlaySelectedCell({ row, col: col + 1 });
      setPlayDirection('across');
    } else if (key === 'ArrowLeft' && col > 0 && playGrid[row][col - 1] !== '#') {
      setPlaySelectedCell({ row, col: col - 1 });
      setPlayDirection('across');
    } else if (key === 'ArrowDown' && row < playGrid.length - 1 && playGrid[row + 1][col] !== '#') {
      setPlaySelectedCell({ row: row + 1, col });
      setPlayDirection('down');
    } else if (key === 'ArrowUp' && row > 0 && playGrid[row - 1][col] !== '#') {
      setPlaySelectedCell({ row: row - 1, col });
      setPlayDirection('down');
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
    checkPlayComplete(newGrid);
  };

  const doRevealAll = () => {
    if (!playAnswers) return;
    setPlayGrid(playAnswers.map(r => [...r]));
    setUsedAssist(true);
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
    setUsingCustomWords(true);
    corpusFpRef.current = null;
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
  
  const deleteWordFromDictionary = (index) => {
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
    
    const blob = new Blob([csv], { type: 'text/csv' });
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
            setWords(mine.length ? [...parsed, ...mine.map((e) => ({ ...e, difficulty: '' }))] : parsed);
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
        ? makeGenerator({ baseUrl: ollamaConfig.baseUrl, model: ollamaConfig.model, perWord: 4, signal: ctrl.signal })
        : null;
      const out = await recluePuzzle(corpus, model, entries, {
        band,
        generate,
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
    const timer = setTimeout(() => { clueDataPendingRef.current = null; resolve({}); }, 15000);
    clueDataPendingRef.current = (data) => { clearTimeout(timer); clueDataPendingRef.current = null; resolve(data || {}); };
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
    setClueStudio({ word, currentClue, band, candidates: [], loading: true, generating: false, error: '', range: null });
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

  const generateStudioClues = async () => {
    const st = clueStudio;
    if (!st) return;
    setClueStudio((s0) => (s0 ? { ...s0, generating: true, error: '' } : s0));
    try {
      const model = await loadScorer();
      const generate = makeGenerator({
        baseUrl: ollamaConfig.baseUrl, model: ollamaConfig.model, perWord: 6,
      });
      const fresh = await generate([{ word: st.word }], st.band);
      const shim = { entries: [{ word: st.word, ...(st.answerFeatures || {}) }],
        clueStore: { wordIndexOf: new Map([[st.word, 0]]), counts: [0], offsets: [0] } };
      const exclude = new Set(st.candidates.map((c) => c.clue.toLowerCase()));
      let scored = scoreCandidates(shim, model, st.word, fresh.get(st.word) || [], { band: st.band, exclude });
      // Flag anything that reads unlike this answer's real clues — the model does write
      // confidently wrong ones, and nothing in the difficulty score can see that.
      const known = st.candidates.filter((c) => c.source === 'corpus').map((c) => ({ clue: c.clue }));
      if (known.length >= 2) {
        scored = await flagImplausible(
          { clueStore: { wordIndexOf: new Map([[st.word, 0]]), counts: [known.length], __clues: known } },
          st.word, scored, { baseUrl: ollamaConfig.baseUrl },
        );
      }
      setClueStudio((s0) => (s0?.word !== st.word ? s0 : {
        ...s0,
        generating: false,
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
    const layoutIdx = layouts.length ? seed % layouts.length : 0;
    setSelectedLayoutIndex(layoutIdx);
    setIsDailyMode(true);
    generatePuzzle(layoutIdx, true, [], 'anchor', 'random', seed);
  };

  // Record a streak when the daily puzzle is completed (once per day).
  React.useEffect(() => {
    if (playComplete && isDailyMode && !isDailySolved()) {
      setStreak(recordDailySolve());
      setIsDailyMode(false);
    }
  }, [playComplete, isDailyMode]);

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
    if (typeof s.selectedLayoutIndex === 'number') setSelectedLayoutIndex(s.selectedLayoutIndex);
    if (s.difficultyChoice) setDifficultyChoice(s.difficultyChoice);
    if (s.grid) { setGrid(s.grid); setClues(s.clues || { across: [], down: [] }); }
    if (s.latestGrid) { setLatestGrid(s.latestGrid); setLatestClues(s.latestClues || null); }
    if (s.play && s.play.playAnswers) {
      setPlayAnswers(s.play.playAnswers);
      setPlayGrid(s.play.playGrid);
      setPlayClues(s.play.playClues || { across: [], down: [] });
      setRevealedCells(new Set(s.play.revealedCells || []));
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
        playTimer,
        playComplete,
        playDirection,
        isDailyMode,
        circles: [...playCircles],
        shades: [...playShades],
      } : null,
    });
  }, [activeTab, selectedLayoutIndex, difficultyChoice, grid, clues, latestGrid, latestClues, playAnswers, playGrid, playClues, revealedCells, playTimer, playComplete, playDirection, isDailyMode, playCircles, playShades]);

  const layoutIndexForTab = Math.min(activeTab === 'create' ? currentLayoutIndex : selectedLayoutIndex, Math.max(layouts.length - 1, 0));

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
    const layout = layouts[selectedLayoutIndex]?.grid;
    if (!layout) throw new Error('No layout selected.');
    const result = await generateCrossword(
      layout, () => {}, 15000, null, [], 'anchor', {}, difficultyTargetOf(difficultyChoice), null);
    if (!result?.grid || !result.complete) throw new Error('Could not generate a full puzzle — try Crosswithfriends.');
    const numbered = assignNumbers(result.placements || []);
    const clueSet = {
      across: numbered.filter((n) => n.direction === 'across').sort((a, b) => a.number - b.number),
      down: numbered.filter((n) => n.direction === 'down').sort((a, b) => a.number - b.number),
    };
    return { grid: result.grid, clues: clueSet, meta: { title: 'Rematch puzzle' } };
  };

  // ---- Saved puzzles (Supabase) ----
  const buildCurrentPuzzleData = () => {
    const cg = activeTab === 'auto' ? grid : activeTab === 'play' ? playAnswers : manualGrid;
    const cc = activeTab === 'auto' ? clues : activeTab === 'play' ? playClues : manualClues;
    if (!cg) return null;
    const layout = cg.map((row) => row.map((c) => (c === '#' ? '#' : '.')).join(''));
    return { version: '1.0', layout, grid: cg, clues: cc, meta: { title: 'My puzzle' } };
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
              <button onClick={() => { setRequiredAction('auto'); setShowRequiredModal(true); }} disabled={words.length === 0} className="btn btn-accent">
                <RefreshCw size={16} />Generate
              </button>
            )}

            {activeTab === 'auto' && !isGenerating && (
              <button onClick={handleDaily} disabled={words.length === 0} className="btn btn-gold" title="Build & play today's puzzle — solve it to grow your streak">
                <Flame size={15} />Today’s Puzzle
              </button>
            )}

            {activeTab === 'auto' && isGenerating && (
              <button onClick={cancelGeneration} className="btn btn-ink">
                <X size={16} />Stop the Press
              </button>
            )}

            {activeTab === 'create' && (
              <button onClick={() => initializeManualGrid(currentLayoutIndex)} className="btn btn-ghost">
                <RefreshCw size={16} />Clear Grid
              </button>
            )}

            {activeTab === 'create' && !isGenerating && (
              <button onClick={handleManualGenerate} disabled={words.length === 0} className="btn btn-accent">
                <RefreshCw size={16} />Generate Remaining
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
            onPlay={(puzzle) => startPlayMode(puzzle.grid, puzzle.clues, { circles: puzzle.circles, shades: puzzle.shades })}
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

        {activeTab === 'mypuzzles' && (
          <MyPuzzlesView
            authUser={auth.user}
            onSignIn={() => setShowAuth(true)}
            onPlay={(data) => startPlayMode(data.grid, data.clues)}
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
                            {' '}{h.word} — {h.clue}
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
            onGenerateClues={generateStudioClues}
            onClueAccepted={saveUserClue}
            aiGenerateClues={aiGenerateClues}
            onOpenSettings={() => setShowSettings(true)}
            onVirtualKey={applyManualKey}
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
          slots: getLayoutStats(layouts[selectedLayoutIndex]?.grid || []).slots || findSlots(layouts[selectedLayoutIndex]?.grid || []).length,
          lengthCounts: getLayoutStats(layouts[selectedLayoutIndex]?.grid || []).lengthCounts || {}
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
