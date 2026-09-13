// Share codes for user-created puzzles.
//
// A code is 8 characters drawn from a deliberately non-confusable alphabet and is
// displayed in two groups of four — KR7F-2Q9X — because the whole point is that
// somebody can read it down a phone or write it on a whiteboard.
//
// Excluded and why:
//   0 / O   look identical in most UI fonts
//   1 / I / L   likewise
//   U       reads as V when spoken, and its absence removes most of the
//           accidental-word surface along with the A/E it would otherwise pair with
// That leaves 30 symbols: the digits 2-9 and 22 letters.
//
// Only ONE member of each confusable pair would normally be kept so the other can be
// auto-corrected on input. Here BOTH members of 0/O and 1/I/L are excluded, so there
// is no honest correction to apply: a code containing one of them cannot have come
// from a generator, and normalizeCode rejects it rather than guessing. Rejecting is
// the safe failure — guessing would silently hand somebody another person's puzzle.

export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 8;
export const CODE_GROUP = 4;

// Characters a person plausibly types for a glyph that is not in the alphabet.
// Listed so the UI can say *why* a code was rejected instead of just "invalid".
export const CONFUSABLE_CHARS = ['0', 'O', '1', 'I', 'L', 'U'];

// Short strings that should never appear in a code that gets read aloud. Checked
// against the whole 8-character code, so this is a handful of entries, not a
// dictionary — the alphabet has no A/E/I/O/U except A, E and Y, which already makes
// real words rare.
const BLOCKED = ['ARSE', 'CRAP', 'DAMN', 'FART', 'SHAG', 'TWAT', 'WANK', 'SEX', 'FAG'];

const randomBytes = (n) => {
  const out = new Uint8Array(n);
  const c = globalThis.crypto;
  if (c && typeof c.getRandomValues === 'function') {
    c.getRandomValues(out);
    return out;
  }
  // No CSPRNG (very old browser / odd runtime). A share code is a capability, not a
  // secret key, and the server-side unique index is what actually guarantees
  // correctness, so a weaker source is survivable — it is just not preferred.
  for (let i = 0; i < n; i++) out[i] = Math.floor(Math.random() * 256);
  return out;
};

// Rejection sampling: 256 % 30 === 16, so naively taking byte % 30 would make the
// first 16 symbols ~6% likelier than the rest. Bytes at or above the largest
// multiple of 30 are discarded instead.
const LIMIT = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length; // 240

const rawCode = () => {
  let out = '';
  while (out.length < CODE_LENGTH) {
    const bytes = randomBytes(CODE_LENGTH * 2);
    for (let i = 0; i < bytes.length && out.length < CODE_LENGTH; i++) {
      if (bytes[i] >= LIMIT) continue;
      out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
    }
  }
  return out;
};

/**
 * A fresh canonical code: 8 characters, uppercase, no separator.
 * This is the form that goes in the database. Use formatCode() to show it.
 */
export function generateShareCode() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const code = rawCode();
    if (!BLOCKED.some((w) => code.includes(w))) return code;
  }
  return rawCode(); // pathological; the blocklist is not a correctness requirement
}

/** 'KR7F2Q9X' -> 'KR7F-2Q9X'. Returns '' for anything that is not a valid code. */
export function formatCode(code) {
  const canonical = normalizeCode(code);
  if (!canonical) return '';
  const groups = [];
  for (let i = 0; i < canonical.length; i += CODE_GROUP) {
    groups.push(canonical.slice(i, i + CODE_GROUP));
  }
  return groups.join('-');
}

/**
 * Canonicalise user input: ' kr7f 2q9x ' and 'kr7f-2q9x' and 'KR7F2Q9X' all become
 * 'KR7F2Q9X'. Returns null when the input cannot be a code — wrong length, or
 * containing a character the generator can never emit (including the confusables
 * 0/O/1/I/L/U, which are rejected rather than guessed at).
 */
export function normalizeCode(input) {
  if (typeof input !== 'string') return null;
  // Separators people actually type or paste: spaces, dashes, underscores, dots.
  const stripped = input.trim().replace(/[\s\-_.]+/g, '').toUpperCase();
  if (stripped.length !== CODE_LENGTH) return null;
  for (const ch of stripped) {
    if (!CODE_ALPHABET.includes(ch)) return null;
  }
  return stripped;
}

/** Whether input normalises to a well-formed code. Says nothing about existence. */
export function isValidCode(input) {
  return normalizeCode(input) !== null;
}

/**
 * Why input was rejected, for a UI message. null when it is valid.
 * 'length' | 'confusable' | 'charset' | 'empty'
 */
export function codeError(input) {
  if (typeof input !== 'string' || !input.trim()) return 'empty';
  const stripped = input.trim().replace(/[\s\-_.]+/g, '').toUpperCase();
  if ([...stripped].some((ch) => CONFUSABLE_CHARS.includes(ch))) return 'confusable';
  if ([...stripped].some((ch) => !CODE_ALPHABET.includes(ch))) return 'charset';
  if (stripped.length !== CODE_LENGTH) return 'length';
  return null;
}

/** Size of the code space: 30^8 = 656,100,000,000. */
export const CODE_SPACE = Math.pow(CODE_ALPHABET.length, CODE_LENGTH);

/**
 * Expected number of colliding pairs once `n` codes exist (birthday approximation,
 * n^2 / 2N). At 100k published puzzles this is ~0.0076, i.e. under a 1% chance of
 * even one collision ever occurring — and the partial unique index plus the retry
 * loop in claim_share_code() makes a collision a non-event rather than a bug.
 */
export function collisionOdds(n) {
  return (n * n) / (2 * CODE_SPACE);
}
