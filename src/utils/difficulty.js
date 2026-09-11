// Shared difficulty vocabulary: one place that maps a 0..1 score to a label and a colour.
// These three tables were previously copy-pasted into App.jsx, PlayView.jsx and
// ManualEditor.jsx, so a change to the palette only ever landed in one of them.

export const DIFFICULTY_BANDS = [
  { key: 'easy',      label: 'Easy',      max: 20, className: 'text-inkblue' },
  { key: 'fair',      label: 'Fair',      max: 40, className: 'text-grass' },
  { key: 'moderate',  label: 'Moderate',  max: 60, className: 'text-gold' },
  { key: 'hard',      label: 'Hard',      max: 80, className: 'text-accent' },
  { key: 'difficult', label: 'Difficult', max: 101, className: 'text-accent-deep' },
];

/** 0..1 score -> display label. */
export function difficultyLabelFromScore(score01) {
  const pct = (Number(score01) || 0) * 100;
  return (DIFFICULTY_BANDS.find((b) => pct < b.max) || DIFFICULTY_BANDS[4]).label;
}

/** Tailwind text colour for a difficulty label (or a raw CSV difficulty value). */
export function difficultyColorClass(label = '') {
  const d = String(label).toUpperCase();
  const band = DIFFICULTY_BANDS.find((b) => b.label.toUpperCase() === d);
  return band ? band.className : 'text-ink-soft';
}

/** The 0..1 target a named band aims for: the midpoint of its range. */
export function difficultyTargetOf(choice) {
  // 'nyt-monday' is offered in the UI but had no entry in the old band table, so it
  // resolved to an empty allow-set and generation failed with "No words match the
  // selected difficulty/filter." It means Monday-easy.
  if (choice === 'nyt-monday') return 0.12;
  const i = DIFFICULTY_BANDS.findIndex((b) => b.key === choice);
  if (i < 0) return null;
  const min = i === 0 ? 0 : DIFFICULTY_BANDS[i - 1].max;
  return (min + Math.min(100, DIFFICULTY_BANDS[i].max)) / 200;
}
