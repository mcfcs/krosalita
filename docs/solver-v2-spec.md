# solveCrossword v2 — bitset CSP fill (implementation reference)

Working spec for the solver rewrite. Derived from the approved plan at
`~/.claude/plans/read-and-analyze-the-magical-meadow.md`.

## Measured sizing facts

Distinct words per length in `public/crosswords.csv` (552,614 rows → 62,970 distinct 3–15 letter words,
**zero 2-letter words**):

| len | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| N | 2476 | 6301 | 10584 | 12642 | 12001 | 8037 | 4639 | 2741 | 1284 | 411 | 363 | 200 | 1291 |

Layout slots: Classic 84, Standard 78, Open 70, Symmetric 76, Diamond 78, Minis 10 each.
→ ≤ 84 slots, ≤ 225 cells, lengths 3–15, max bucket 12,642 words.

## Module layout

| file | status | responsibility |
|---|---|---|
| `src/utils/rng.js` | new | `mulberry32(seed)`, `seedFromString(str)`, `randInt(rng,n)` |
| `src/utils/bitset.js` | new | flat-`Uint32Array` ops taking `(arr, offset, len)`; no allocation in hot path |
| `src/utils/wordIndex.js` | new | `buildWordIndex(rows, opts)`, `addAdHocWord`, `resetAdHoc`, `fingerprintOf` |
| `src/utils/clueIndex.js` | new | `buildClueIndex`, `pickClues` |
| `src/utils/clueFilters.js` | new | cross-ref / grid-dependent regexes (mirrors `pipeline/clue_filters.py`) |
| `src/utils/solver.js` | rewrite | preflight + propagate + search + restart |
| `src/worker/crosswordWorker.js` | edit | `loadCorpus` RPC, module-level index cache, cooperative cancel |
| `src/App.jsx` | edit | persistent worker singleton, drop 3-run difficulty loop, surface `result.error.message` |
| `src/utils/crosswordUtils.js` | mostly unchanged | `findSlots` memo reused verbatim |

## Data structures

### CorpusIndex — built once, immutable, shared across solves

```
CorpusIndex = { fingerprint, minLen, maxLen, byLen: Array<LenIndex|null>, lookup: Array<Map<string,int>|null> }

LenIndex = {
  len, count,                       // N_L real words
  extra,                            // ad-hoc words in the reserved tail (0..32)
  W,                                // ceil((N_L + 32)/32)
  letters     : Uint8Array(W*32*len)    // letter codes 0..25; word i at [i*len, i*len+len)
  all         : Uint32Array(W)          // bits 0..count-1 set, tail zeroed
  byLetter    : Uint32Array(len*26*W)   // row (pos*26+letter) at offset (pos*26+letter)*W
  score       : Uint16Array(W*32)       // static quality 0..65535, DESCENDING by index
  freq        : Uint16Array(W*32)
  diff        : Uint8Array(W*32)        // difficulty 0..255 (continuous once the model lands)
  posAlphabet : Int32Array(len)         // 26-bit mask of letters occurring at each position
}
```

**Critical invariant: word indices are assigned in DESCENDING `score` order within a LenIndex.**
So "top-K best candidates" == "first K set bits" — an O(K) bit scan, no sort, no 12k-word scan.

**Reserved tail**: 32 bit-slots per length for words not in the corpus (user-typed required words,
fully-preset out-of-dictionary strings). `addAdHocWord` writes `letters`, sets the bit in `all`, sets the 26
`byLetter` rows for its positions, `score = 65535`, `freq = 0`. `resetAdHoc()` clears between solves.
Cap 32/length → preflight `TOO_MANY_CUSTOM_WORDS`.

Byte sizes: `byLetter` 1,399,736 B (1.34 MiB) · `letters` 430,688 B (420 KiB) · score+freq ~252 KB ·
diff ~63 KB · all+posAlphabet ~27 KB. **Typed-array total ~2.17 MB.** The per-length `lookup` Maps add ~6 MB
of JS overhead and are droppable in favour of binary search over packed strings.

### Per-solve state — ~200 KB, allocated once, reused by every restart

```
slotLen    : Int32Array(S)
slotCellOf : Int32Array(S*15)   // flat cell index of slot s position i
crossSlot  : Int32Array(S*15)   // the OTHER slot at position i, or -1
crossPos   : Int32Array(S*15)   // its position within that other slot

domOff     : Int32Array(S)
domW       : Int32Array(S)
domArena   : Uint32Array(Σ domW)  // ~19,219 words = 77 KB worst case (Classic)
dom0       : Uint32Array(same)    // post-preflight-AC snapshot → O(memcpy) restarts
domCount   : Int32Array(S)
domCount0  : Int32Array(S)
domFirst   : Int32Array(S)        // first non-zero 32-bit word  } scan window
domLast    : Int32Array(S)        // last  non-zero 32-bit word  }
domVersion : Int32Array(S)        // monotone global tick, NEVER restored on undo

cellMask   : Int32Array(CELLS)    // 26-bit letter mask, 0 = contradiction
cellMask0  : Int32Array(CELLS)
cellLevel  : Int32Array(CELLS)    // deepest decision level that last narrowed this cell

posCache   : Int32Array(S*15)     // lettersAt(s,i) memo
posStamp   : Int32Array(S*15)     // == domVersion[s] when valid

assign      : Int32Array(S)       // word index assigned to slot s, or -1
assignOrder : Int32Array(S)       // decision stack: slot chosen at each level
assignVal   : Int32Array(S)

usedMask    : Array<Uint32Array(W)> per length   // structural dedup
cellWeight  : Float32Array(CELLS)                // wdeg — CARRIED ACROSS RESTARTS
globalNogood: Uint32Array(shape of domArena)     // CARRIED ACROSS RESTARTS
conflict    : Uint32Array(S * ceil(S/32))        // per-slot conflict set
```

### Trail — exact record format

Three parallel growable `Int32Array`s, initial capacity 1<<16, doubling.

```
trailW : PAIRS   [absWordIdx, oldValue]      absWordIdx = domOff[s] + w
trailC : PAIRS   [slotIdx, oldDomCount]      at most ONCE per slot per level,
                                             guarded by countStamp[s] === level
trailM : TRIPLES [cellIdx, oldMask, oldLevel]
levelMark : per level, the three trail tops
```

`undoTo(mark)` walks each backwards restoring values, recomputes `domFirst`/`domLast` for touched slots, and
**bumps `domVersion[s] = ++tick` (never restores it)** — which invalidates `posCache` automatically, so the
cache needs no trailing. That is why the version counter is global and monotone.

Nothing else is cloned. Compare `saveState()` (`solver.js:275-283`), which deep-clones 78 Sets on every
decision *and* every backtrack.

## Propagation primitives

### `lettersAt(s, i) → 26-bit mask` (slot → cell)

Memo on `posStamp[k] === domVersion[s]`. Otherwise for each letter in `posAlphabet[i]`, test
`dom[s] & byLetter[(i*26+l)*W]` over the `[domFirst, domLast]` window with **early exit on first hit**.
Worst case 26 × 397 = 10,322 word-ANDs; realistic ~26–80 ops.

**Must be a pure function of `dom[s]` — do NOT mask by `cellMask`, that would make the memo unsound.**

### `reviseSlot(s, i, allowedMask) → changed` (cell → slot)

```
n = popcount(allowedMask)
n == 0                          -> WIPEOUT
n >= REVISE_MAX_LETTERS (12)    -> NO_CHANGE   // skip; SOUND because propagation only prunes
n == 1                          -> andIntoTrailed(s, byLetter row)   // fast path, no scratch
else -> OR the n rows into a reused scratch Uint32Array(397), then andIntoTrailed
```

`andIntoTrailed(s, src)` walks `[first,last]`; where `old & src !== old` it pushes `[d+w, old]` to `trailW`,
writes, and accumulates `delta`. If `delta > 0`: push `[s, domCount[s]]` to `trailC` (guarded), subtract,
`domVersion[s] = ++tick`, tighten the window. Returns WIPEOUT when `domCount[s] === 0`.

Cost: `n*W` ORs + `W` ANDs ≈ 2,400 ops worst for a length-6 slot, typically < 400.

### `propagate(seedCells) → OK | WIPEOUT(slot)`

Ring-buffer worklist of **cell** indices (≤ 225) with `inQueue: Uint8Array(CELLS)`.
**Seeded only with the cells of the slot just assigned — never a full grid sweep.**

```
while queue not empty:
  every 256 pops -> checkClock()
  c = dequeue; m = cellMask[c]
  if m == 0 -> WIPEOUT
  for each (s,i) on cell c (at most 2):
    if assigned: continue
    r = reviseSlot(s, i, m)
    if r == WIPEOUT -> return WIPEOUT(s)
    if r == CHANGED:
      for j in 0..slotLen[s]-1:
        c2 = slotCellOf[s*15+j]
        nm = cellMask[c2] & lettersAt(s, j)
        if nm !== cellMask[c2]:
          trailM.push(c2, cellMask[c2], cellLevel[c2])
          cellMask[c2] = nm; cellLevel[c2] = level; cellWeightTouch(c2)
          if nm == 0 -> return WIPEOUT(s)
          enqueue c2
```

Terminates because `cellMask` only shrinks within a level. No `iterations < 500` band-aid, no full
O(cells × slots × candidates) sweeps.

## Search

### Variable ordering — MRV / dom-over-wdeg

`score = domCount[s] / max(1, Σ cellWeight over cells whose crossing slot is unassigned)`.
Required-candidate multiplier: `anchor` ×0.001, `opportunistic` ×0.05 (a bitset test with early exit, not a
Set scan). Seeded jitter `×(1 + 0.02*rng())`. Tie-break: more unassigned crossing slots, then longer slot.

`cellWeight` starts at 1.0 and is incremented on every wipeout, **carried across restarts** — this is what
makes restart *i+1* structurally smarter than restart *i*.

Replaces `getSlotEntropy` (`solver.js:216`), which averages cell-mask popcounts — only weakly correlated with
real domain size, and not MRV at all.

### Value ordering — top-K + jittered sample, then 1-ply lookahead

- (a) K_TOP = 48 best by static score = **the first 48 set bits** (indices are score-sorted).
- (b) K_RAND = 16 seeded-random set bits, for variety.
- (c) per candidate, per unassigned crossing slot:
  `c = andCountCapped(dom[t], row, MAX_WORDS_SCANNED=32, CAP=64)`
  - `c == 0` → **HARD REJECT**, `removeValueTrailed(s, w)` (prune permanently at this level)
  - else `supp += log1p(c)`
- reject if `isSingletonElsewhere(len, w)` (w is the last candidate of another unassigned slot)
- `q = supp + ALPHA_QUALITY*(score[w]/65535) + BONUS_REQUIRED − BETA_DIFF*|diffValue(w) − residualDiffTarget()|`
- insertion-sort ≤ 64 entries by q descending, no allocation

Cost per node: ≤ 64 × 15 × 32 ≈ 30k worst, ~3k typical.

### Main loop

```
solveOnce(budgetBacktracks):
  domArena.set(dom0); domCount.set(domCount0); cellMask.set(cellMask0)
  andNot globalNogood out of domArena
  assign.fill(-1); level = 0; trail tops = 0; conflict.fill(0)
  placeAnchorsAndPresets()               // uses the SAME placeValue path
  loop:
    checkClock(); reportProgress()
    if placedCount == S -> SOLVED
    s = selectSlot();    if s < 0 || domCount[s] == 0 -> handleFailure
    vals = orderValues(s); if empty      -> handleFailure
    pushLevel(); assignOrder[level] = s; valueStack[level] = vals
    r = placeValue(s, vals[0])
    if r == WIPEOUT:
      if ++backtracks > budget -> RESTART
      handleFailure(r.slot)
```

`placeValue(s, w)`:
1. `narrowToSingleton(s, w)` — trailed AND with the one-bit mask.
2. `assign[s] = w; placedCount++`.
3. `usedMask[len] |= bit(w)` and **AND-NOT `w` out of every unassigned slot of the same length** (trailed).
   ≤ 46 × 198 = 9k ops worst. **This is the structural dedup — a used word cannot reappear on ANY path**
   (anchors, preset fills and normal decisions all route through here).
4. For each cell of `s`: `cellMask` = single letter bit (trailed), enqueue.
5. `return propagate(cellsOf(s))`.

### Failure handling — conflict-directed backjumping

```
handleFailure(failedSlot t):
  for each cell c of t: cellWeight[c] += 1              // wdeg, survives restarts
  jump = max over cells of t of cellLevel[c]
  jump = max(jump, maxLevel(conflict[t]))
  if jump == 0: recordGlobalNogood(...); return false   // this restart is exhausted
  while level > jump: undoTo(levelMark[level]); unassign(assignOrder[level]); level--
  d = assignOrder[jump]
  conflict[d] |= conflict[t] & ~bit(d)
  conflict[d] |= slotsAssignedOn(cellsOf(t))
  removeValueTrailed(d, assignVal[jump])
  pop next value from valueStack[jump]; if none -> recurse handleFailure(d)
  return true
```

**Soundness**: `cellLevel[c]` is the deepest level that last narrowed cell `c`; no level above `jump` touched
any cell of `t`, so none can be responsible. Skipping them is complete.

This is the fix for the "tries all the other words" symptom: today the only response to failure is
`stateStack.pop()` + delete one word (`solver.js:357-360`, `:371-374`, `:389-395`), so a conflict created 10
levels up forces enumeration of all ~10k candidates at the deepest slot before the culprit is revisited.

### Restarts — Luby, carrying forward

`budget(i) = 200 * luby(i)`, luby = 1,1,2,1,1,2,4,1,1,2,1,1,2,4,8,…

**Carried across restarts**: `cellWeight` (wdeg), `globalNogood`, best partial, and the **rng stream position**
(continued, not reseeded — every restart explores differently while the whole run stays reproducible from
`seed`).
**Reset each restart**: `domArena.set(dom0)` — a **77 KB memcpy** (vs ~10M allocating ops today).
Extra restart trigger: elapsed > 50% of budget with `placedCount < 0.4*S`.

### Seeded randomness

One `rng = mulberry32(seed)` for the whole solve: slot jitter, K_RAND sample, tie-breaks, anchor ordering.
App passes `seedFromString(todayKey())` for the daily, `(Date.now()^rand)>>>0` otherwise. Removes
`Math.random()` at `solver.js:98`/`:237` and makes `handleDaily` genuinely reproducible — it can then stop
`seededShuffle`-ing all 552,614 rows at `App.jsx:1918`.

### Clock / cancel

`checkClock()` reads `now()` + `isCancelled()` and throws a module-private ABORT sentinel caught at the top of
`solveCrossword`, which returns the best partial. Call sites: every main-loop node; every 256 worklist pops in
`propagate`; every 64 candidates in `orderValues`; every 4,096 words during index build.

## Index build: where and when

**Build in the worker on corpus load.** It must be runtime-capable (user CSV upload at `App.jsx:599`, Tagalog
mode swap), and the build itself is cheap: ~63k distinct words → dedup + sort + `byLetter` fill ≈ **40–80 ms**.
The expensive part is parsing 25 MB of CSV (~1.5–3 s), which already happens today on the main thread.

```
main -> worker  { type:'loadCorpus', payload:{ url:'/corpus/...' | text:<csv>, sourceTag } }
worker -> main  { type:'corpusReady', fingerprint, stats:{ distinct, byLength } }
main -> worker  { type:'start', payload:{ ..., corpusFingerprint, seed, difficultyTarget } }
worker -> main  { type:'needCorpus' }     // if the fingerprint isn't the cached one
```

The worker holds `let cachedIndex = null` at module scope and rebuilds only when the fingerprint changes.
Given a `url` it does its own fetch + parse, so **the 552,614-row array is never structured-cloned**. Today
`App.jsx:671-680` posts the entire filtered `workingWords` array on every call, three times per generation.

**Two App.jsx changes are required for the index to survive the re-runs:**

1. **The worker must become a singleton.** `App.jsx:561` constructs a new `Worker` per call and `:575`/`:806`
   terminate it, which would destroy the cache. Hold it in a ref, never terminate on success; cancel via the
   existing `{type:'cancel'}` message plus the cooperative `isCancelled()` check, keeping `terminate()` only as
   a 500 ms-grace fallback (then respawn and re-send `loadCorpus`).
2. **Collapse the three-run difficulty loop to one** (see below). `generateManualFill` (`App.jsx:388`) has the
   identical loop; the singleton worker fixes both.

The prebuilt `public/corpus/*` artifact from `pipeline/s7_pack.py` gives the default corpus a zero-parse cold
start; the runtime builder stays for uploads and Tagalog.

## Anchors, presets, ad-hoc words

All three go through **one** path — `placeValue` — so dedup, propagation and trailing apply uniformly.

1. **Ad-hoc injection (before `dom0`)**: required words and fully-preset strings not in `lookup[len]` go into
   the reserved 32-bit tail via `addAdHocWord`. Lets App stop synthesising `{word, clue:'',
   difficulty:'MODERATE'}` entries into `workingWords` (`App.jsx:651-655`, `:350-354`, `:368-377`).
2. **Preset letters (before `dom0`)**: `cellMask0[c] = bit(letter)`; initial AC makes fully-preset slots
   singletons naturally — the special-case loop at `solver.js:325-336` disappears.
3. **Anchors (top of each `solveOnce`, level 0)**: for each required word in seeded-shuffled order, find the
   unassigned matching-length slot whose domain still contains it and which has the **fewest** remaining
   candidates (MRV-consistent), then `placeValue`. On wipeout, undo that anchor and try the next slot; if none
   works, fall back to the `opportunistic` value-ordering bonus rather than failing the run.

## Where difficulty belongs: score-biased value ordering, NOT a pre-filtered word set

1. **Pre-filtering causes the hang.** `allowedDifficulties('easy')` keeps only EASY|FAIR; Classic needs 46
   mutually-distinct, mutually-crossing 4-letter words. Cutting the pool 50–70% is exactly when this CSP flips
   from "seconds" to "no solution exists" — and `App.jsx:670` then repeats the starved search three times.
2. **The target is an aggregate, not a per-word constraint.** A hard filter to {EASY, FAIR} gives mean ~0.15 →
   score 15, which can never land in the `fair` band (20–40) no matter how many reruns. A soft bias with a
   residual target self-corrects and hits the band in **one** run:
   ```
   residualDiffTarget() = clamp((targetMean*S − placedDiffSum) / (S − placedCount), 0, 1)
   ```
3. **The index must be built once.** A pre-filter over word objects forces a per-difficulty rebuild.
4. **A hard filter, if wanted, is still free**: a precomputed per-length `allowedMask[choice]`
   (5 × 13 × W ≈ 130 KB, built once) ANDed into `dom0` — no rebuild. Preflight then reports which length starved.

API: `{ difficultyTarget: 0..1, difficultyWeight: BETA_DIFF, difficultyHardFilter: false }`.
App drops `filterWordsByDifficulty` from the solver path (keeps it for BrowseView), sets `maxDifficultyRuns`
3 → 1, and reports the achieved `result.difficultyScore`.

## Preflight — the concrete cases

Runs after slot topology and `dom0` construction, before any search. Returns `{ok:false, code, message,
detail}`; `solveCrossword` returns it in a new additive `error` field; App surfaces `result.error.message`.

| # | code | condition | message |
|---|---|---|---|
| 1 | `NO_SLOTS` | `slots.length === 0` | "This layout has no word slots (every run is 1 cell or black)." |
| 2 | `BAD_LAYOUT` | ragged rows, chars outside `.#` | "Layout row {r} has {n} cells, expected {cols}." |
| 3 | `EMPTY_WORDLIST` | 0 words after hard filter | "No words left after the {choice} difficulty filter." |
| 4 | `NO_WORDS_FOR_LENGTH` | `byLen[L]` null/empty for a used L | "Needs {n} {L}-letter words, list has none." **Corpus has ZERO 2-letter words — any length-2 slot lands here; this is today's guaranteed 120s spin.** |
| 5 | `INSUFFICIENT_WORDS_FOR_LENGTH` | `count(L)+adhoc(L) < slotsOfLength(L)` | "Needs {n} distinct {L}-letter words, only {m} available — duplicates aren't allowed." |
| 6 | `PRESET_LETTER_IMPOSSIBLE` | preset letter not in `posAlphabet[L][i]` | "No {L}-letter word has '{ch}' in position {i+1}." |
| 7 | `CELL_NO_LETTER` | `cellMask0[c] === 0` after AC | "No letter works for both {n}-Across and {m}-Down at row {r}, col {c}." |
| 8 | `SLOT_EMPTY_AFTER_AC` | `domCount0[s] === 0` | "{n}-{Dir} ({L} letters) has no possible word given crossing letters '{pattern}'." |
| 9 | `REQUIRED_WORD_UNKNOWN` | non-A-Z, or length <3 / >15 | "'{w}' must be 3–15 letters, A–Z only." |
| 10 | `REQUIRED_WORD_NO_SLOT` | no slot of that length | "'{w}' is {L} letters; no {L}-letter slot in this layout." |
| 11 | `REQUIRED_WORDS_OVERSUBSCRIBED` | `#required(L) > #slots(L)` | "{k} required words are {L} letters but there are only {n} slots." |
| 12 | `REQUIRED_WORD_UNPLACEABLE` | after AC, no slot's domain contains it | "'{w}' doesn't fit any {L}-letter slot with the current preset letters." |
| 13 | `DUPLICATE_PRESET_WORD` | two preset slots hold the same string | "'{w}' appears twice in the grid ({slotA} and {slotB})." |
| 14 | `TOO_MANY_CUSTOM_WORDS` | > 32 ad-hoc for one length | "At most 32 custom {L}-letter words per puzzle." |
| 15 | `NO_TIME` | `timeoutMs <= 0` | "Out of time budget." (hit by `Math.max(0, timeoutMs−elapsed)` at `App.jsx:675` on run 3) |
| — | `ISOLATED_CELL` *(warning)* | white cell in no slot | "Row {r}, col {c} isn't part of any word and will be left blank." |

Cases 1–6 and 9–15 are checked before AC and short-circuit; 7–8 need `dom0`. Initial AC costs < 50 ms, versus
today spending the full 120 s to discover the same infeasibility.

## Clue decoupling

The solver returns word **indices**; it never touches clue text.

```
ClueIndex = { offsets: Int32Array per length (CSR), rowIds: Int32Array, rows }
pickClues(placements, clueIndex, { seed, difficultyTarget, presetClues }) -> placements with .clue
```

Per placement: a preset clue wins; otherwise choose the row whose difficulty is nearest `difficultyTarget`,
tie-broken by the seeded rng, **skipping any clue matching `clueFilters`**, any containing the answer as a
substring, and any clue text already used elsewhere in this puzzle. Runs in the worker just before
`{type:'done'}`, so App sees the identical `placements: [{slot, word, clue}]` shape.

Fixes the latent bug where `wordItemMap` (`solver.js:54-55`) takes the *first* row and `parseCSV`'s
descending-length sort (`crosswordUtils.js:39`) makes that "first" the oldest 1993-era clue.

## Complexity and memory

**Per node today** (Standard 15×15, 78 slots):
- per-restart init: the length-4 bucket alone is 156,013 duplicated rows × 24 slots ≈ 3.7M ops;
  whole init **8–12M allocating ops per restart**
- `saveState`: 78 Set clones totalling **3–6M entries**, on every decision *and* every backtrack
- `propagate`: ≤ 500 iterations × (225 cells × 2 slots × full-Set scan ~10k + 78 × filterSlot at 10k × 15)
  ⇒ **1e8–1e9 ops per call**

**Per node, new:**

| phase | worst | typical |
|---|---|---|
| `selectSlot` | 1.3k | 1.3k |
| `orderValues` | 30k | ~3k |
| `propagate` | ~72k | ~8k |
| `placeValue` dedup AND-NOT | ~9k | ~2k |
| `undoTo` | ~300 | ~100 |
| **total** | **~1.1e5** | **~1.5e4** |

**≈ 3–4 orders of magnitude per node.** Target > 2,000 nodes/s in a worker; a 78-slot 15×15 should fill in
1–3 s or be reported infeasible in < 200 ms. Restart cost drops from ~10M allocating ops to a 77 KB
`TypedArray.set()`.

**Memory**: index 2.17 MB typed (+ ~6 MB droppable lookup Maps) · per-solve state ~200 KB · dom0 + globalNogood
2 × 77 KB · trail cap 1 MB · scratch 1.6 KB. **Peak worker ≈ 10 MB steady**, versus today's transient
150–250 MB per `postMessage` of `workingWords`, three times per generation.

## Return shape and App changes

```js
{
  grid, placements: [{slot, word, clue}], complete, attempts, requiredPlaced, failedWord,  // unchanged
  // additive:
  error: null | { code, message, detail },
  failedSlot: null | slotId,
  difficultyScore: number|null,
  stats: { nodes, backtracks, backjumps, restarts, propagations, seed, ms }
}
```

App.jsx edits:
(a) persistent worker singleton + `loadCorpus` handshake;
(b) `maxDifficultyRuns` 3 → 1, pass `difficultyTarget`/`seed` instead of a pre-filtered `workingWords`;
(c) surface `result.error.message`;
(d) remove the `lastPlaced || solveFailedWord` override at `:760` and `:476` so the solver's own conflict
    attribution is used;
(e) `handleDaily` passes `seedFromString(todayKey())` instead of `seededShuffle`-ing 552k rows.
