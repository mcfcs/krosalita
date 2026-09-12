// Sound effects, synthesised in the browser — no audio files.
//
// Why synthesis rather than royalty-free samples: the app is an offline-capable PWA, and a
// usable sample set is ~150 KB that has to download, decode and sit in the cache before the
// first keypress makes a noise. These are a few hundred bytes of maths that start instantly,
// need no attribution, and — the part samples genuinely cannot do cheaply — vary per
// keystroke, so holding down a letter sounds like typing rather than a stuck buzzer.
//
// The palette is deliberately quiet and short. A crossword is played for half an hour at a
// stretch; anything with a tail or a melody on every keypress becomes unbearable by minute
// three. Typing is a click, not a note.
//
// Off by default. The toggle is a user gesture, which is what lets the AudioContext start
// under autoplay policy — so the context is created there, not at import.

import { loadJSON, saveJSON } from './storage.js';

let ctx = null;
let master = null;       // every voice routes through here, so volume is one node
let noiseBuf = null;     // one second of white noise, reused by every click
let enabled = loadJSON('soundOn', false);
let volume = clamp01(loadJSON('soundVolume', 0.7));

function clamp01(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.7;
}

const getCtx = () => {
  if (typeof window === 'undefined') return null;
  try {
    if (!ctx) {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
    }
    // Browsers suspend the context when the tab is backgrounded; without this the first
    // sound after coming back is silently swallowed.
    if (ctx.state === 'suspended') ctx.resume?.();
  } catch { return null; }
  return ctx;
};

const getNoise = (c) => {
  if (noiseBuf) return noiseBuf;
  noiseBuf = c.createBuffer(1, c.sampleRate, c.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return noiseBuf;
};

export const isSoundOn = () => enabled;
export const setSoundOn = (v) => {
  enabled = !!v;
  saveJSON('soundOn', enabled);
  if (enabled) getCtx(); // warm up on the enabling gesture
};

export const getVolume = () => volume;
export const setVolume = (v) => {
  volume = clamp01(v);
  saveJSON('soundVolume', volume);
  if (master && ctx) master.gain.setTargetAtTime(volume, ctx.currentTime, 0.01);
};

// Typing faster than this just stacks oscillators that nobody can hear apart, and on a held
// key it turns into a rasp. Dropping the extras costs nothing perceptually.
let lastVoice = 0;
const MIN_GAP = 0.012; // seconds

/** A pitched note. `type` is an OscillatorNode wave. */
const tone = (freq, dur = 0.08, type = 'sine', gain = 0.05, when = 0, detune = 0) => {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime + when;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.value = freq;
  if (detune) o.detune.value = detune;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.006);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  g.connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
};

/**
 * A percussive click: a burst of noise through a bandpass, optionally with a low sine
 * "thump" under it. This is what makes a keypress sound like a key rather than a beep —
 * real key noise is broadband and almost pitchless.
 */
const click = (freq, dur = 0.03, gain = 0.06, q = 6, thump = 0) => {
  const c = getCtx();
  if (!c) return;
  const t = c.currentTime;
  const src = c.createBufferSource();
  src.buffer = getNoise(c);
  src.playbackRate.value = 0.8 + Math.random() * 0.4;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = q;
  const g = c.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(bp);
  bp.connect(g);
  g.connect(master);
  src.start(t);
  src.stop(t + dur + 0.01);
  if (thump) tone(thump, dur * 1.6, 'sine', gain * 0.5);
};

/**
 * Guard every public sound: off or no context → do nothing.
 *
 * `rapid` marks the ones a user can fire dozens of times a second (typing, cursor moves);
 * only those are throttled. The throttle must NOT cover the rest, or the word-complete
 * chime — which lands in the same tick as the keypress that completed the word — would be
 * swallowed exactly when it matters.
 */
const voice = (fn, rapid = false) => (...args) => {
  if (!enabled) return;
  const c = getCtx();
  if (!c) return;
  if (rapid) {
    if (c.currentTime - lastVoice < MIN_GAP) return;
    lastVoice = c.currentTime;
  }
  try { fn(...args); } catch { /* audio is never worth breaking input over */ }
};

export const sfx = {
  /** A letter goes into a square. Pitch jitters so held keys don't drone. */
  type: voice(() => click(1500 + Math.random() * 500, 0.028, 0.055, 7, 170), true),

  /** Backspace — duller and lower than typing, so deleting is audibly different. */
  erase: voice(() => click(650 + Math.random() * 150, 0.04, 0.045, 4), true),

  /** Arrow keys, Tab, clicking a square. Almost subliminal by design. */
  move: voice(() => click(3000, 0.012, 0.022, 10), true),

  /**
   * An entry is now completely filled. Deliberately the SAME sound whether the answer is
   * right or wrong — a different sound for a wrong word would be a free Check, which is
   * exactly the help the player chose not to ask for.
   */
  wordDone: voice(() => { tone(660, 0.09, 'triangle', 0.05); tone(990, 0.14, 'triangle', 0.045, 0.075); }),

  /** Check said this is right. */
  correct: voice(() => { tone(880, 0.07, 'sine', 0.05); tone(1320, 0.11, 'sine', 0.04, 0.06); }),

  /** Check said this is wrong. Low and short — a nudge, not a punishment. */
  wrong: voice(() => { tone(150, 0.13, 'sawtooth', 0.035); tone(146, 0.13, 'sawtooth', 0.03, 0, -12); }),

  /** A letter or word was revealed. Falling, because it is a small surrender. */
  reveal: voice(() => { tone(700, 0.1, 'sine', 0.045); tone(520, 0.16, 'sine', 0.04, 0.08); }),

  /** Blocks in Create mode. */
  block: voice(() => click(280, 0.05, 0.05, 2)),

  /** Confirmation when sound is switched on, and for UI commits generally. */
  toggle: voice(() => tone(880, 0.09, 'triangle', 0.05)),

  /** Puzzle solved. The one place a real melody is earned. */
  win: voice(() => {
    [[523, 0], [659, 0.1], [784, 0.2]].forEach(([f, w]) => tone(f, 0.16, 'triangle', 0.055, w));
    tone(1047, 0.5, 'triangle', 0.06, 0.3);
    tone(1568, 0.4, 'sine', 0.025, 0.34);   // sparkle on top
    tone(262, 0.6, 'sine', 0.035, 0.3);     // root underneath, for body
  }),
};

// Older call sites said `key` for typing; keep it working.
sfx.key = sfx.type;
