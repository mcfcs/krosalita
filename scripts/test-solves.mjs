// Bare-Node harness for src/lib/solves.js and src/lib/shareCode.js.
//
//   node scripts/test-solves.mjs
//
// There is no live Supabase here, so this exercises the LOCAL path for real (against
// a faked localStorage with a real quota) and the sync path against a fake server
// that implements the same upsert-by-(user, puzzle_key) contract as the table in
// 0003_solves_and_share_codes.sql.

// ---------------------------------------------------------------------------
// Fake localStorage — with a quota, because SOLVE_CAP exists precisely because
// saveJSON swallows QuotaExceededError.
// ---------------------------------------------------------------------------
function makeLocalStorage(quotaBytes = Infinity) {
  const map = new Map();
  return {
    _map: map,
    get length() { return map.size; },
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) {
      const str = String(v);
      let total = str.length + k.length;
      for (const [ek, ev] of map) if (ek !== k) total += ek.length + ev.length;
      if (total > quotaBytes) {
        const e = new Error('QuotaExceededError');
        e.name = 'QuotaExceededError';
        throw e;
      }
      map.set(k, str);
    },
    removeItem: (k) => { map.delete(k); },
    clear: () => map.clear(),
    bytes() {
      let n = 0;
      for (const [k, v] of map) n += k.length + v.length;
      return n;
    },
  };
}

globalThis.localStorage = makeLocalStorage();

// ---------------------------------------------------------------------------
// Fake server — mirrors the unique (user_id, puzzle_key) constraint.
// ---------------------------------------------------------------------------
function makeServer(uid = 'user-1') {
  const rows = new Map(); // `${user}|${key}` -> row
  return {
    uid,
    calls: { list: 0, upsert: 0, rows: 0 },
    offline: false,
    signedOut: false,
    async userId() {
      if (this.offline) throw new Error('network down');
      return this.signedOut ? null : this.uid;
    },
    async list(userId) {
      if (this.offline) throw new Error('network down');
      this.calls.list++;
      const out = [];
      for (const [k, row] of rows) if (k.startsWith(`${userId}|`)) out.push(fromRow(row));
      return out.sort((a, b) => String(b.solvedAt).localeCompare(String(a.solvedAt)));
    },
    async upsert(userId, records) {
      if (this.offline) throw new Error('network down');
      this.calls.upsert++;
      this.calls.rows += records.length;
      for (const rec of records) rows.set(`${userId}|${rec.id}`, toRow(rec, userId));
    },
    // Test-only seeding, bypassing the client mapping.
    seed(records) {
      for (const rec of records) rows.set(`${this.uid}|${rec.id}`, toRow(rec, this.uid));
    },
    size() { return rows.size; },
    raw() { return [...rows.values()]; },
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------
let pass = 0; const failures = [];
const ok = (cond, msg) => { if (cond) { pass++; } else { failures.push(msg); console.log(`  FAIL  ${msg}`); } };
const eq = (a, b, msg) => ok(Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b), `${msg} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const section = (name) => console.log(`\n— ${name}`);

// ---------------------------------------------------------------------------
const {
  recordSolve, listSolves, listLocalSolves, hasSolved, syncOnSignIn,
  puzzleIdentity, puzzleId, mergeSolves, mergeRecord, makeRecord,
  contentHashOf, canonicalGrid, hash128, kindFromId, clearLocalSolves,
  loadLocal, toRow, fromRow, SOLVE_CAP, solvedIndex,
} = await import('../src/lib/solves.js');

const {
  generateShareCode, normalizeCode, formatCode, isValidCode, codeError,
  CODE_ALPHABET, CODE_LENGTH, CODE_SPACE, collisionOdds, CONFUSABLE_CHARS,
} = await import('../src/lib/shareCode.js');

const GRID_A = ['CAT#', 'ARE#', 'TEN#', '####'];
const GRID_B = ['DOG#', 'ORE#', 'GEN#', '####'];
const reset = () => { globalThis.localStorage = makeLocalStorage(); clearLocalSolves(); };

// ===========================================================================
section('puzzle identity');
// ===========================================================================
{
  // Determinism: same descriptor, same id, across repeated calls.
  const d1 = { source: 'generated', grid: GRID_A };
  eq(puzzleId(d1), puzzleId({ source: 'generated', grid: GRID_A }), 'hash identity is stable across calls');
  ok(puzzleId(d1) !== puzzleId({ source: 'generated', grid: GRID_B }), 'different grids get different ids');

  // Hard-coded digest: catches an accidental change to the hash that would
  // invalidate every id already stored on a user's device.
  eq(hash128('CAT#/ARE#/TEN#/####'), hash128(canonicalGrid(GRID_A)), 'canonicalGrid feeds hash128');
  const FROZEN = contentHashOf(GRID_A);
  eq(FROZEN.length, 32, 'content hash is 128 bits as 32 hex chars');
  ok(/^[0-9a-f]{32}$/.test(FROZEN), 'content hash is lowercase hex');
  console.log(`  (frozen digest for GRID_A: ${FROZEN})`);

  // Grid shape independence: row-strings and cell-arrays of the same puzzle agree.
  const asArrays = GRID_A.map((r) => r.split(''));
  eq(contentHashOf(asArrays), FROZEN, 'array-of-arrays grid hashes the same as row strings');
  eq(contentHashOf(GRID_A.map((r) => r.toLowerCase())), FROZEN, 'case does not change the hash');
  const asObjects = GRID_A.map((r) => r.split('').map((ch) => (ch === '#' ? '#' : { letter: ch })));
  eq(contentHashOf(asObjects), FROZEN, 'cell objects hash the same');

  // Tiers, strongest first.
  eq(puzzleIdentity({ remoteId: 'AB-CD', grid: GRID_A }).kind, 'remote', 'remoteId wins');
  eq(puzzleIdentity({ remoteId: 'AB-CD' }).id, 'p:ab-cd', 'remote id is lowercased');
  eq(puzzleIdentity({ sourceId: 'pid123', sourceName: 'crosswithfriends' }).id, 'x:crosswithfriends:pid123', 'source id shape');
  eq(puzzleIdentity({ source: 'daily', day: '2026-09-14' }).id, 'd:2026-09-14', 'daily is its date');
  eq(puzzleIdentity({ source: 'generated', seed: 42, layoutName: 'Mini 5x5', difficulty: 'hard' }).id,
    'g:mini-5x5:hard:42', 'seeded generation tuple');
  eq(puzzleIdentity({ source: 'generated', seed: 42, layoutName: 'Mini 5x5', difficulty: 'hard', corpusFingerprint: 'ABC123' }).id,
    'g:mini-5x5:hard:42:abc123', 'corpus fingerprint joins the tuple');
  eq(puzzleIdentity({ source: 'generated', grid: GRID_A }).id, `h:${FROZEN}`, 'unseeded generation falls back to the grid hash');
  eq(puzzleIdentity({ source: 'generated' }).kind, 'adhoc', 'nothing to name it by -> adhoc');

  // Precedence is total, not accidental.
  eq(puzzleIdentity({ remoteId: 'r', sourceId: 's', source: 'daily', seed: 1, grid: GRID_A }).kind, 'remote', 'remote beats all');
  eq(puzzleIdentity({ sourceId: 's', source: 'daily', seed: 1, grid: GRID_A }).kind, 'source', 'source beats daily');
  eq(puzzleIdentity({ source: 'daily', seed: 1, grid: GRID_A }).kind, 'daily', 'daily beats seed');
  eq(puzzleIdentity({ source: 'generated', seed: 1, grid: GRID_A }).kind, 'seed', 'seed beats hash');

  // Two devices, same puzzle, same id — the whole requirement.
  const deviceA = puzzleIdentity({ sourceId: 'PID-9', sourceName: 'CrossWithFriends', grid: GRID_A });
  const deviceB = puzzleIdentity({ sourceId: ' pid-9 ', sourceName: 'crosswithfriends', grid: GRID_A });
  eq(deviceA.id, deviceB.id, 'same imported puzzle -> same id on two devices despite case/whitespace');
  eq(deviceA.contentHash, deviceB.contentHash, 'and the same content hash');

  // Tier is recoverable from the id, so it need not be a column.
  for (const [id, kind] of [['p:x', 'remote'], ['x:a:b', 'source'], ['d:2026-01-01', 'daily'], ['g:a:b:1', 'seed'], ['h:deadbeef', 'hash'], ['a:zz', 'adhoc']]) {
    eq(kindFromId(id), kind, `kindFromId(${id})`);
  }
}

// ===========================================================================
section('record + list, signed out');
// ===========================================================================
{
  reset();
  const noBackend = { async userId() { return null; }, async list() { return []; }, async upsert() {} };

  const r1 = recordSolve({ source: 'daily', day: '2026-09-10', seconds: 300, title: 'Daily' }, noBackend);
  eq(r1.id, 'd:2026-09-10', 'daily recorded under its date');
  eq(r1.count, 1, 'first solve counts once');

  recordSolve({ source: 'imported', sourceId: 'pid-1', seconds: 120, usedHelp: true, title: 'Imported', grid: GRID_A }, noBackend);
  recordSolve({ source: 'generated', grid: GRID_B, seconds: 200, difficultyScore: 62, difficultyLabel: 'Moderate' }, noBackend);

  eq(listLocalSolves().length, 3, 'three distinct puzzles stored');
  eq(listLocalSolves({ source: 'daily' }).length, 1, 'filter by source');
  eq(listLocalSolves({ limit: 2 }).length, 2, 'limit respected');

  ok(hasSolved('d:2026-09-10'), 'hasSolved by id');
  ok(hasSolved({ source: 'imported', sourceId: 'pid-1' }), 'hasSolved by descriptor (Browse case)');
  ok(hasSolved({ source: 'generated', grid: GRID_B }), 'hasSolved by grid (My Puzzles case)');
  ok(!hasSolved({ source: 'imported', sourceId: 'pid-unknown' }), 'unsolved puzzle is not claimed as solved');
  ok(!hasSolved(null) && !hasSolved(''), 'hasSolved tolerates nothing');
  eq(solvedIndex().size, 3, 'solvedIndex covers every record');

  // Re-solving the same puzzle updates rather than duplicating.
  const again = recordSolve({ source: 'imported', sourceId: 'pid-1', seconds: 90, usedHelp: false, grid: GRID_A }, noBackend);
  eq(listLocalSolves().length, 3, 'a repeat solve does not add a row');
  eq(again.count, 2, 'repeat solve bumps the count');
  eq(again.bestSeconds, 90, 'best time improves');
  eq(again.usedHelp, false, 'an unaided re-solve clears the help flag');

  // A slower repeat must not worsen the best.
  const slower = recordSolve({ source: 'imported', sourceId: 'pid-1', seconds: 400, grid: GRID_A }, noBackend);
  eq(slower.bestSeconds, 90, 'a slower solve leaves the best alone');
  eq(slower.seconds, 400, 'but the latest duration is the latest solve');
  eq(slower.count, 3, 'count keeps climbing');

  // listSolves with no backend degrades to the local list.
  const listed = await listSolves({}, noBackend);
  eq(listed.length, 3, 'listSolves degrades to local when signed out');
}

// ===========================================================================
section('sign-in merge: each side has rows the other lacks');
// ===========================================================================
{
  reset();
  const server = makeServer('user-1');
  const offline = { async userId() { return null; }, async list() { return []; }, async upsert() {} };

  // Device history built while signed out.
  recordSolve({ source: 'daily', day: '2026-09-01', seconds: 111, title: 'Local daily' }, offline);
  recordSolve({ source: 'imported', sourceId: 'local-only', seconds: 222, title: 'Local import' }, offline);
  const sharedLocal = recordSolve({ source: 'imported', sourceId: 'both', seconds: 500, usedHelp: true, title: 'Both', solvedAt: '2026-09-02T00:00:00.000Z' }, offline);
  eq(server.size(), 0, 'nothing reached the server while signed out');

  // Server history from another device, including one row for the same puzzle.
  server.seed([
    makeRecord({ source: 'daily', day: '2026-08-20', seconds: 333, title: 'Server daily', solvedAt: '2026-08-20T00:00:00.000Z' }),
    makeRecord({ source: 'generated', grid: GRID_A, seconds: 444, title: 'Server gen', solvedAt: '2026-08-21T00:00:00.000Z' }),
    makeRecord({ source: 'imported', sourceId: 'both', seconds: 150, usedHelp: false, title: 'Both', solvedAt: '2026-09-03T00:00:00.000Z' }),
  ]);

  const localBefore = loadLocal();
  const res = await syncOnSignIn('user-1', server);

  eq(res.skipped, false, 'sync ran');
  eq(res.merged.length, 5, 'union is 5 distinct puzzles (3 local + 3 server, 1 shared)');
  eq(res.downloaded, 2, 'two server rows were new to this device');
  ok(res.uploaded >= 2, `local-only rows were pushed (uploaded=${res.uploaded})`);

  // Nothing lost in either direction.
  const ids = new Set(res.merged.map((r) => r.id));
  for (const r of localBefore) ok(ids.has(r.id), `local row survived: ${r.id}`);
  for (const id of ['d:2026-08-20', 'x:cwf:both']) ok(ids.has(id), `server row landed: ${id}`);
  ok(ids.has(`h:${contentHashOf(GRID_A)}`), 'server-generated row landed under its grid hash');

  // Nothing duplicated.
  eq(new Set(res.merged.map((r) => r.id)).size, res.merged.length, 'merged list has no duplicate ids');
  eq(loadLocal().length, 5, 'local store holds the union');
  eq(server.size(), 5, 'server holds the union too');

  // The contested row merged field-by-field rather than one side winning outright.
  const both = res.merged.find((r) => r.id === 'x:cwf:both');
  eq(both.bestSeconds, 150, 'best time is the better of the two sides');
  eq(both.usedHelp, false, 'an unaided solve on either device clears usedHelp');
  eq(both.solvedAt, '2026-09-03T00:00:00.000Z', 'latest solve wins solvedAt');
  eq(both.firstSolvedAt, sharedLocal.firstSolvedAt, 'earliest solve wins firstSolvedAt');

  // Idempotence: a second sync changes nothing and pushes nothing.
  const before = JSON.stringify(loadLocal());
  const rowsBefore = server.calls.rows;
  const res2 = await syncOnSignIn('user-1', server);
  eq(res2.merged.length, 5, 'second sync is a no-op in size');
  eq(res2.downloaded, 0, 'second sync downloads nothing new');
  eq(server.calls.rows, rowsBefore, 'second sync uploads nothing');
  eq(JSON.stringify(loadLocal()), before, 'local store byte-identical after a second sync');

  // Merge is commutative.
  const a = loadLocal(); const b = await server.list('user-1');
  eq(mergeSolves(a, b).length, mergeSolves(b, a).length, 'mergeSolves is order-independent in size');
  eq(JSON.stringify(mergeSolves(a, b).map((r) => r.id).sort()),
    JSON.stringify(mergeSolves(b, a).map((r) => r.id).sort()), 'and in membership');
}

// ===========================================================================
section('cross-tier dedupe by content hash');
// ===========================================================================
{
  // One device named it by its seed tuple, the other only had the grid.
  const seeded = makeRecord({ source: 'generated', seed: 7, layoutName: 'Mini', difficulty: 'fair', grid: GRID_A, seconds: 300, solvedAt: '2026-09-01T00:00:00.000Z' });
  const hashed = makeRecord({ source: 'generated', grid: GRID_A, seconds: 200, solvedAt: '2026-09-02T00:00:00.000Z' });
  ok(seeded.id !== hashed.id, 'the two devices did name it differently');
  const merged = mergeSolves([seeded], [hashed]);
  eq(merged.length, 1, 'the weak tiers collapse on a matching content hash');
  eq(merged[0].id, seeded.id, 'and the stronger (seed) id is the one kept');
  eq(merged[0].bestSeconds, 200, 'best time carried across the collapse');

  // Strong tiers must NOT collapse even when the grid matches: a daily and a
  // separately generated puzzle can be the same grid, and erasing the daily would
  // break the streak UI.
  const daily = makeRecord({ source: 'daily', day: '2026-09-05', grid: GRID_A, seconds: 100 });
  const gen = makeRecord({ source: 'generated', grid: GRID_A, seconds: 100 });
  eq(mergeSolves([daily], [gen]).length, 2, 'a daily is never collapsed into a generated puzzle');

  const imported = makeRecord({ source: 'imported', sourceId: 'pid-x', grid: GRID_A, seconds: 100 });
  eq(mergeSolves([imported], [gen]).length, 2, 'an imported puzzle keeps its authoritative id');

  // Different grids never collapse.
  eq(mergeSolves([hashed], [makeRecord({ source: 'generated', grid: GRID_B })]).length, 2, 'different grids stay separate');

  // Records with no hash at all cannot be collapsed by accident.
  const noHash1 = makeRecord({ source: 'generated', seed: 1, layoutName: 'A', difficulty: 'x' });
  const noHash2 = makeRecord({ source: 'generated', seed: 2, layoutName: 'A', difficulty: 'x' });
  eq(mergeSolves([noHash1], [noHash2]).length, 2, 'hashless weak records are not collapsed together');
}

// ===========================================================================
section('storage cap');
// ===========================================================================
{
  reset();
  const offline = { async userId() { return null; }, async list() { return []; }, async upsert() {} };
  const N = SOLVE_CAP + 60;
  for (let i = 0; i < N; i++) {
    const stamp = new Date(Date.UTC(2020, 0, 1) + i * 3600_000).toISOString();
    recordSolve({ source: 'generated', sourceId: null, seed: i, layoutName: 'cap', difficulty: 'x', seconds: 60, solvedAt: stamp }, offline);
  }
  const stored = loadLocal();
  eq(stored.length, SOLVE_CAP, `local store capped at SOLVE_CAP (${SOLVE_CAP})`);
  eq(new Set(stored.map((r) => r.id)).size, SOLVE_CAP, 'capped store has no duplicates');

  // The cap drops the OLDEST, so the newest solve is always present.
  const newestId = `g:cap:x:${N - 1}`;
  ok(stored.some((r) => r.id === newestId), 'newest record survives the cap');
  ok(!stored.some((r) => r.id === 'g:cap:x:0'), 'oldest record was evicted');
  eq(stored[0].id, newestId, 'store stays sorted newest-first');

  const bytes = globalThis.localStorage.bytes();
  console.log(`  (${SOLVE_CAP} records = ${(bytes / 1024).toFixed(1)}KB of localStorage)`);
  ok(bytes < 1024 * 1024, `a full store stays under 1MB (${(bytes / 1024).toFixed(1)}KB)`);

  // Merging beyond the cap still truncates rather than growing without bound.
  const server = makeServer('user-2');
  server.seed([makeRecord({ source: 'daily', day: '2030-01-01', seconds: 5, solvedAt: '2030-01-01T00:00:00.000Z' })]);
  const res = await syncOnSignIn('user-2', server);
  eq(res.merged.length, SOLVE_CAP, 'sync result is capped too');
  eq(res.merged[0].id, 'd:2030-01-01', 'the newest row from the server is the one kept');
}

// ===========================================================================
section('degradation: quota, offline, corrupt storage');
// ===========================================================================
{
  // A localStorage that always throws must not take the app down.
  globalThis.localStorage = makeLocalStorage(10); // 10 bytes: every write fails
  const offline = { async userId() { return null; }, async list() { return []; }, async upsert() {} };
  const rec = recordSolve({ source: 'daily', day: '2026-01-01', seconds: 10 }, offline);
  eq(rec.id, 'd:2026-01-01', 'recordSolve still returns a usable record when the quota is blown');
  eq(loadLocal().length, 0, 'and nothing was persisted (saveJSON failed silently, as designed)');
  ok(!hasSolved('d:2026-01-01'), 'hasSolved reflects what actually persisted');

  // A localStorage with garbage in it.
  globalThis.localStorage = makeLocalStorage();
  globalThis.localStorage.setItem('krosalita:solves', '{not json');
  eq(loadLocal().length, 0, 'unparseable storage reads as empty');
  globalThis.localStorage.setItem('krosalita:solves', '{"a":1}');
  eq(loadLocal().length, 0, 'non-array storage reads as empty');
  globalThis.localStorage.setItem('krosalita:solves', '[null,{"nope":1},{"id":"d:2026-01-02"}]');
  eq(loadLocal().length, 1, 'malformed records are filtered out, valid ones kept');

  // A server that throws must leave local history untouched.
  reset();
  recordSolve({ source: 'daily', day: '2026-02-02', seconds: 10 }, offline);
  const broken = makeServer('user-3'); broken.offline = true;
  const res = await syncOnSignIn('user-3', broken);
  eq(res.skipped, true, 'sync reports it was skipped when the server is unreachable');
  eq(loadLocal().length, 1, 'local history is untouched by a failed sync');
  const listedOffline = await listSolves({}, broken);
  eq(listedOffline.length, 1, 'listSolves still returns local rows when the server throws');

  // Signed out: sync is a no-op, not an error.
  const out = makeServer('user-4'); out.signedOut = true;
  const res2 = await syncOnSignIn(null, out);
  eq(res2.skipped, true, 'signed-out sync is skipped');
  eq(res2.uploaded, 0, 'signed-out sync uploads nothing');
}

// ===========================================================================
section('row mapping round-trip');
// ===========================================================================
{
  const rec = makeRecord({
    source: 'imported', sourceId: 'pid-rt', title: 'Round trip', seconds: 250,
    usedHelp: true, difficultyScore: 71.5, difficultyLabel: 'Hard', grid: GRID_A,
    solvedAt: '2026-05-05T12:00:00.000Z',
  });
  const back = fromRow(toRow(rec, 'user-x'));
  for (const k of Object.keys(rec)) eq(back[k], rec[k], `round-trip preserves ${k}`);
  eq(toRow(rec, 'user-x').user_id, 'user-x', 'row carries the user id');
  eq(toRow(rec, 'user-x').puzzle_key, rec.id, 'puzzle_key is the identity');
  eq(rec.rows, 4, 'grid size inferred from the grid (rows)');
  eq(rec.cols, 4, 'grid size inferred from the grid (cols)');
}

// ===========================================================================
section('share codes');
// ===========================================================================
{
  eq(CODE_ALPHABET.length, 30, 'alphabet is 30 symbols');
  eq(CODE_LENGTH, 8, 'codes are 8 characters');
  for (const ch of CONFUSABLE_CHARS) ok(!CODE_ALPHABET.includes(ch), `alphabet excludes ${ch}`);
  eq(new Set(CODE_ALPHABET).size, CODE_ALPHABET.length, 'alphabet has no repeats');

  // Generation.
  const codes = [];
  for (let i = 0; i < 20000; i++) codes.push(generateShareCode());
  ok(codes.every((c) => c.length === CODE_LENGTH), 'every generated code is 8 chars');
  ok(codes.every((c) => [...c].every((ch) => CODE_ALPHABET.includes(ch))), 'every character is in the alphabet');
  ok(codes.every(isValidCode), 'every generated code validates');
  eq(new Set(codes).size, codes.length, `no duplicates in ${codes.length} generated codes`);

  // Distribution: rejection sampling should leave the alphabet roughly flat.
  const counts = new Map();
  for (const c of codes) for (const ch of c) counts.set(ch, (counts.get(ch) || 0) + 1);
  eq(counts.size, CODE_ALPHABET.length, 'every symbol in the alphabet actually gets used');
  const expected = (codes.length * CODE_LENGTH) / CODE_ALPHABET.length;
  const worst = Math.max(...[...counts.values()].map((n) => Math.abs(n - expected) / expected));
  ok(worst < 0.12, `symbol frequencies are within 12% of uniform (worst ${(worst * 100).toFixed(1)}%)`);

  // Formatting and round-trip.
  const code = generateShareCode();
  const pretty = formatCode(code);
  ok(/^[^-]{4}-[^-]{4}$/.test(pretty), `formatted as XXXX-XXXX (${pretty})`);
  eq(normalizeCode(pretty), code, 'formatted code round-trips through normalizeCode');
  eq(normalizeCode(code), code, 'canonical code normalises to itself');
  eq(formatCode(pretty), pretty, 'formatCode is idempotent');

  // The forgiving-input cases.
  eq(normalizeCode(pretty.toLowerCase()), code, 'lowercase accepted');
  eq(normalizeCode(code.toLowerCase()), code, 'lowercase without a dash accepted');
  eq(normalizeCode(`  ${pretty}  `), code, 'surrounding whitespace accepted');
  eq(normalizeCode(pretty.replace('-', ' ')), code, 'space instead of dash accepted');
  eq(normalizeCode(pretty.replace('-', '_')), code, 'underscore instead of dash accepted');
  eq(normalizeCode(pretty.replace('-', '')), code, 'no separator accepted');
  eq(normalizeCode([...code].join(' ')), code, 'spaced-out characters accepted');

  // Rejections.
  eq(normalizeCode(''), null, 'empty rejected');
  eq(normalizeCode(null), null, 'null rejected');
  eq(normalizeCode(12345678), null, 'non-string rejected');
  eq(normalizeCode(code.slice(0, 7)), null, 'too short rejected');
  eq(normalizeCode(code + 'X'), null, 'too long rejected');
  eq(normalizeCode('KR7F-2Q9!'), null, 'punctuation rejected');
  for (const ch of CONFUSABLE_CHARS) {
    const spoiled = ch + code.slice(1);
    eq(normalizeCode(spoiled), null, `confusable "${ch}" rejected`);
    eq(codeError(spoiled), 'confusable', `codeError names "${ch}" as confusable`);
  }
  eq(codeError(''), 'empty', 'codeError: empty');
  eq(codeError('KR7F2Q9'), 'length', 'codeError: length');
  eq(codeError('KR7F2Q9!'), 'charset', 'codeError: charset');
  eq(codeError(pretty), null, 'codeError: valid code has no error');

  // Two different codes never normalise to the same thing.
  const normalized = new Set(codes.map(normalizeCode));
  eq(normalized.size, codes.length, 'normalisation is injective over generated codes');

  // Collision sanity.
  eq(CODE_SPACE, Math.pow(30, 8), 'code space is 30^8');
  ok(CODE_SPACE > 6.5e11, `code space is ${CODE_SPACE.toExponential(3)}`);
  ok(collisionOdds(100_000) < 0.01, `expected collisions at 100k puzzles: ${collisionOdds(100_000).toExponential(2)} (<1%)`);
  ok(collisionOdds(1_000_000) < 1, `expected collisions at 1M puzzles: ${collisionOdds(1_000_000).toFixed(3)}`);
  console.log(`  (space ${CODE_SPACE.toExponential(3)}; expected collisions at 1k/100k/1M: ` +
    `${collisionOdds(1e3).toExponential(1)} / ${collisionOdds(1e5).toExponential(1)} / ${collisionOdds(1e6).toFixed(3)})`);

  // Empirical birthday check at a scale we can actually run.
  eq(new Set(codes).size, 20000, 'no birthday collision observed in 20k codes (expected ~3e-7)');
}

// ===========================================================================
section('modules import cleanly in bare Node');
// ===========================================================================
{
  const puzzles = await import('../src/lib/puzzles.js');
  for (const fn of ['publishPuzzle', 'unpublishPuzzle', 'fetchByCode', 'savePuzzle', 'listMyPuzzles']) {
    eq(typeof puzzles[fn], 'function', `puzzles.js exports ${fn}`);
  }
  // Supabase is unconfigured here, so these must fail with a clear message rather
  // than a TypeError on a null client.
  eq(await puzzles.listMyPuzzles(), [], 'listMyPuzzles returns [] with no backend');
  eq(await puzzles.unpublishPuzzle('x'), undefined, 'unpublishPuzzle is a no-op with no backend');
  await puzzles.publishPuzzle('x').then(
    () => ok(false, 'publishPuzzle should reject with no backend'),
    (e) => eq(e.message, 'Supabase is not configured.', 'publishPuzzle explains the missing backend'),
  );
  await puzzles.fetchByCode('not a code').then(
    () => ok(false, 'fetchByCode should reject a malformed code'),
    (e) => ok(e.invalid === true, 'fetchByCode flags a malformed code before touching the network'),
  );
  await puzzles.fetchByCode('KR7F-2Q9X').then(
    () => ok(false, 'fetchByCode should reject with no backend'),
    (e) => eq(e.message, 'Supabase is not configured.', 'a well-formed code still needs a backend'),
  );
}

// ===========================================================================
console.log(`\n${failures.length ? 'FAILED' : 'PASSED'} — ${pass} assertions, ${failures.length} failures`);
if (failures.length) {
  for (const f of failures) console.log(`  - ${f}`);
  process.exitCode = 1;
}
