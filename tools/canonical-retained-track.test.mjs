import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createCanonicalRetainedTrack} from './canonical-retained-track.mjs';
import {rankTrustedTrackEntries} from '../workers/ranked/src/index.js';

const trackId = 'b'.repeat(64), accountId = 'a'.repeat(64), otherId = 'c'.repeat(64);
const replay = deflateSync(Buffer.alloc(15)).toString('base64url');
const sha = value => createHash('sha256').update(value).digest('hex');
const old = {accountId, trackId, uploadId: 10, timeMs: 2000, frames: 1000, raceTimeFrames: 1000,
  replayHash: sha(replay), nativeLedgerKey: 'd'.repeat(64), nativeLedgerManifestHash: 'e'.repeat(64),
  runVerified: true, verified: true, verifiedState: 1, integrityVerified: true, verificationStatus: 'verified',
  createdAt: 123, pbAt: '2025-01-01T00:00:00Z', updatedAt: 456, verifiedAt: 789,
  name: 'Published', profileCosmetics: {theme: 'saved'}, rank: 1};
const current = {...old, accountId: otherId, uploadId: 11, timeMs: 1500, runVerified: false,
  verified: false, verifiedState: 0, verificationStatus: 'pending', playbackPending: true};
const boardOf = entries => ({trackId, complete: true, sourceComplete: true, totalEntriesExact: true,
  ranksExact: true, totalEntries: entries.length, count: entries.length, publishedEntries: entries.length,
  updatedAt: 900, builtAt: 901, revision: 12, sourceRevision: 11, entries});
function fixture(options = {}) {
  const prior = boardOf([structuredClone(old), structuredClone(current)]);
  const board = {...boardOf([structuredClone(current)]), pagination: {complete: true}, paginatedSource: true};
  const data = {...structuredClone(old), replay, verified: false, verifiedState: 0,
    verificationStatus: 'pending', pbAt: '2026-11-01T00:00:00Z', name: 'Raw canonical', secret: 'not public'};
  const doc = {data, name: `projects/test/databases/(default)/documents/0.6.2_race_results/${accountId}_${trackId}`,
    updateTime: '2026-11-12T00:00:00.123456789Z'};
  const calls = [];
  const helper = createCanonicalRetainedTrack({readCanonical: async (...args) => {calls.push(args); return doc;},
    proofAllowed: row => row.nativeLedgerKey === old.nativeLedgerKey, ...options});
  return {prior, board, doc, calls, helper, run: () => helper.reconcile({trackId, prior, board})};
}

test('two-row reconciliation preserves dates/verdicts, pending current row and exact public evidence', async t => {
  t.mock.method(globalThis, 'fetch', () => assert.fail('No network permitted'));
  const f = fixture(), before = structuredClone({prior: f.prior, board: f.board, doc: f.doc});
  const result = await f.run();
  assert.deepEqual(result.board.entries, rankTrustedTrackEntries([current, old], trackId));
  assert.deepEqual(result.board, {...boardOf(result.board.entries)});
  assert.deepEqual(result.retained, [{accountId, trackId, uploadId: old.uploadId,
    replayHash: old.replayHash, canonicalUpdateTime: f.doc.updateTime}]);
  assert.equal(result.readDocuments, 1);
  assert.equal(f.helper.usedDocuments(), 1);
  assert.deepEqual(f.calls, [[accountId, trackId]]);
  assert.deepEqual({prior: f.prior, board: f.board, doc: f.doc}, before);
  assert.deepEqual(f.helper.report(), {maxDocuments: 32, readDocuments: 1, retained: result.retained});
  result.retained[0].accountId = 'changed';
  const report = f.helper.report(); report.retained[0].uploadId = 99;
  assert.equal(f.helper.report().retained[0].accountId, accountId);
  assert.equal(f.helper.report().retained[0].uploadId, 10);
  result.board.entries[1].profileCosmetics.theme = 'changed';
  assert.equal(f.prior.entries[0].profileCosmetics.theme, 'saved');
});

test('no missing accounts makes no canonical or proof calls', async () => {
  const f = fixture({proofAllowed: () => assert.fail('No proof check needed')});
  f.board = f.prior;
  const result = await f.helper.reconcile({trackId, prior: f.prior, board: f.board});
  assert.equal(result.readDocuments, 0); assert.deepEqual(result.retained, []); assert.deepEqual(f.calls, []);
});

for (const [label, change] of [
  ['missing document', f => {f.doc.data = null;}],
  ['explicit absent document', f => {f.doc.exists = false;}],
  ['changed time', f => {f.doc.data.timeMs++;}],
  ['changed upload', f => {f.doc.data.uploadId++;}],
  ['changed account', f => {f.doc.data.accountId = otherId;}],
  ['changed track', f => {f.doc.data.trackId = otherId;}],
  ['changed frames', f => {f.doc.data.frames++; f.doc.data.raceTimeFrames++;}],
  ['inconsistent frame aliases', f => {f.doc.data.raceTimeFrames++;}],
  ['missing upload', f => {delete f.doc.data.uploadId;}],
  ['missing time', f => {delete f.doc.data.timeMs;}],
  ['changed hash', f => {f.doc.data.replayHash = 'f'.repeat(64);}],
  ['wrong bytes', f => {f.doc.data.replay = 'wrong';}],
  ['malformed replay with matching hash', f => {
    const bad = deflateSync(Buffer.alloc(16)).toString('base64url');
    f.doc.data.replay = bad; f.doc.data.replayHash = sha(bad); f.prior.entries[0].replayHash = sha(bad);
  }],
  ['invalid compressed replay', f => {
    f.doc.data.replay = 'AAAA'; f.doc.data.replayHash = sha('AAAA'); f.prior.entries[0].replayHash = sha('AAAA');
  }],
  ['wrong document name', f => {f.doc.name = f.doc.name.replace(accountId, otherId);}],
  ['wrong collection', f => {f.doc.name = f.doc.name.replace('0.6.2_race_results', 'other');}],
  ['wrong document id', f => {f.doc.id = otherId;}],
  ...['needsReview', 'reviewHold', 'excluded', 'unscored', 'held', 'hold', 'unranked'].flatMap(key => [
    [`canonical ${key}`, f => {f.doc.data[key] = true;}],
    [`prior ${key}`, f => {f.prior.entries[0][key] = true;}],
    [`malformed ${key}`, f => {f.doc.data[key] = 'false';}],
  ]),
  ...['verificationStatus', 'validationState', 'status'].flatMap(key =>
    ['held', 'review', 'mismatch', 'rejected', 'excluded', 'unscored', 'unavailable_final'].map(value =>
      [`canonical ${key}:${value}`, f => {f.doc.data[key] = value;}])),
  ['review reason', f => {f.doc.data.reason = 'competitive review hold';}],
  ['absent native key', f => {delete f.prior.entries[0].nativeLedgerKey;}],
  ['malformed native key', f => {f.prior.entries[0].nativeLedgerKey = 'invalid';}],
  ['pending prior', f => {f.prior.entries[0].runVerified = false;}],
]) test(`${label} fails closed without mutating inputs or reporting partial retention`, async () => {
  const f = fixture(); change(f);
  const before = structuredClone({prior: f.prior, board: f.board, doc: f.doc});
  await assert.rejects(f.run());
  assert.deepEqual({prior: f.prior, board: f.board, doc: f.doc}, before);
  assert.deepEqual(f.helper.report().retained, []);
  assert.ok(f.calls.length <= 1);
});

for (const value of [false, undefined, null, 1, 'true', Promise.resolve(true)]) {
  test(`proof callback must return literal true (${String(value)}) before any reads`, async () => {
    const f = fixture({proofAllowed: () => value});
    await assert.rejects(f.run(), /proof/); assert.deepEqual(f.calls, []);
  });
}

for (const target of ['prior', 'board']) for (const [label, change] of [
  ['not complete', b => {b.complete = false;}],
  ['inexact', b => {b.totalEntriesExact = false;}],
  ['inexact ranks', b => {b.ranksExact = false;}],
  ['incomplete source', b => {b.sourceComplete = false;}],
  ['wrong total', b => {b.totalEntries++;}],
  ['missing total', b => {delete b.totalEntries;}],
  ['wrong count', b => {b.count++;}],
  ['wrong track', b => {b.trackId = accountId;}],
  ['wrong row track', b => {b.entries[0].trackId = accountId;}],
  ['duplicate', b => {b.entries.push(b.entries[0]); b.totalEntries++; b.count++;}],
  ['invalid account', b => {b.entries[0].accountId = 'bad';}],
  ['invalid time', b => {b.entries[0].timeMs = NaN;}],
  ['oversized', b => {b.entries = Array(10001).fill(old); b.totalEntries = b.count = 10001;}],
]) test(`${target} ${label} rejects before reads`, async () => {
  const f = fixture(); change(f[target]);
  await assert.rejects(f.run()); assert.deepEqual(f.calls, []);
});

test('budget validates full missing set before any reads and never resets', async () => {
  const f = fixture({maxDocuments: 1});
  const empty = boardOf([]);
  await assert.rejects(f.helper.reconcile({trackId, prior: f.prior, board: empty}), /budget/);
  assert.deepEqual(f.calls, []);
  await f.run();
  await assert.rejects(f.run(), /budget/);
  assert.equal(f.helper.usedDocuments(), 1); assert.equal(f.calls.length, 1);
});

test('failed callback is charged before call, without retries', async () => {
  let calls = 0, helper;
  helper = createCanonicalRetainedTrack({maxDocuments: 1, proofAllowed: () => true,
    readCanonical: () => {calls++; assert.equal(helper.usedDocuments(), 1); throw Error('read failed');}});
  const f = fixture();
  await assert.rejects(helper.reconcile({trackId, prior: f.prior, board: f.board}), /read failed/);
  assert.equal(calls, 1); assert.equal(helper.usedDocuments(), 1);
  assert.deepEqual(helper.report().retained, []);
});

test('a later canonical failure never exposes an earlier retained row', async () => {
  const f = fixture(); let calls = 0;
  f.prior.entries[1] = {...old, accountId: otherId, uploadId: 11};
  const helper = createCanonicalRetainedTrack({proofAllowed: () => true,
    readCanonical: () => {calls++; return calls === 1 ? f.doc : null;}});
  await assert.rejects(helper.reconcile({trackId, prior: f.prior, board: boardOf([])}));
  assert.equal(calls, 2); assert.equal(helper.usedDocuments(), 2);
  assert.deepEqual(helper.report().retained, []);
});

test('snapshot inputs before await and isolate proof callback mutation', async () => {
  const f = fixture(); let release;
  const gate = new Promise(resolve => {release = resolve;});
  const helper = createCanonicalRetainedTrack({proofAllowed: row => {row.pbAt = 'mutated'; return true;},
    readCanonical: async () => {await gate; return f.doc;}});
  const pending = helper.reconcile({trackId, prior: f.prior, board: f.board});
  f.prior.entries[0].pbAt = 'external'; f.board.updatedAt = -1;
  release(); const result = await pending;
  assert.equal(result.board.entries[1].pbAt, old.pbAt); assert.equal(result.board.updatedAt, 900);
});

test('concurrent batches cannot overbook a shared budget', async () => {
  const f = fixture(); let release;
  f.prior.entries[1] = {...old, accountId: otherId, uploadId: 11};
  const gate = new Promise(resolve => {release = resolve;});
  const helper = createCanonicalRetainedTrack({maxDocuments: 2, proofAllowed: () => true,
    readCanonical: async () => {await gate; return f.doc;}});
  const pending = helper.reconcile({trackId, prior: f.prior, board: boardOf([])});
  await assert.rejects(helper.reconcile({trackId, prior: f.prior, board: f.board}), /budget/);
  release(); await assert.rejects(pending); assert.equal(helper.usedDocuments(), 2);
});

test('absent update time is null; raw verification flags cannot replace prior verdict', async () => {
  const f = fixture(); delete f.doc.updateTime;
  const result = await f.run();
  assert.equal(result.retained[0].canonicalUpdateTime, null);
  assert.equal(result.board.entries[1].verified, true);
  assert.equal(result.board.entries[0].verified, false);
});

test('configuration rejects invalid budgets and absent callbacks', () => {
  for (const maxDocuments of [0, -1, 33, 1.5, NaN, Infinity, '1', null]) {
    assert.throws(() => createCanonicalRetainedTrack({maxDocuments, readCanonical() {}, proofAllowed() {}}));
  }
  assert.throws(() => createCanonicalRetainedTrack());
  assert.throws(() => createCanonicalRetainedTrack({readCanonical() {}}));
});

test('multiple missing verified rows are validated once each and ranked with current entries', async () => {
  const f = fixture();
  const second = {...old, accountId: 'f'.repeat(64), uploadId: 12, timeMs: 1400};
  const prior = boardOf([old, second, current]); let reads = 0;
  const helper = createCanonicalRetainedTrack({maxDocuments: 2, proofAllowed: () => true,
    readCanonical: async id => {reads++; return {data: {...(id === accountId ? old : second), replay,
      verified: false, verifiedState: 0}};}});
  const result = await helper.reconcile({trackId, prior, board: f.board});
  assert.deepEqual(result.board.entries, rankTrustedTrackEntries([current, old, second], trackId));
  assert.equal(reads, 2); assert.equal(result.readDocuments, 2);
  assert.equal(result.retained.length, 2); assert.equal(result.board.totalEntries, 3);
});

test('materialized boards above public 500 cap are accepted up to 10000 accounts', async () => {
  const entries = Array.from({length: 10000}, (_, index) => ({...current,
    accountId: index.toString(16).padStart(64, '0'), timeMs: index + 1}));
  const board = boardOf(entries);
  const helper = createCanonicalRetainedTrack({proofAllowed: () => assert.fail('No missing proof'),
    readCanonical: () => assert.fail('No missing reads')});
  const result = await helper.reconcile({trackId, prior: board, board});
  assert.equal(result.board.entries.length, 10000); assert.equal(result.board.totalEntries, 10000);
});

test('combined account limit rejects before reads even if both boards individually fit', async () => {
  const f = fixture();
  const entries = Array.from({length: 10000}, (_, index) => ({...current,
    accountId: index.toString(16).padStart(64, '0')}));
  await assert.rejects(f.helper.reconcile({trackId, prior: f.prior, board: boardOf(entries)}), /limit/);
  assert.deepEqual(f.calls, []);
});

test('publication structure exceeding indexed playback budget cannot be retained', async () => {
  const f = fixture(), count = 1000, bytes = Buffer.alloc(15 + count * 5 * 3);
  for (let channel = 0; channel < 5; channel++) {
    const offset = channel * (3 + count * 3);
    bytes.writeUIntLE(count, offset, 3);
    for (let i = 0; i < count; i++) bytes.writeUIntLE(i ? 1 : 3999000, offset + 3 + i * 3, 3);
  }
  const replay = deflateSync(bytes).toString('base64url');
  Object.assign(f.prior.entries[0], {frames: 4000000, raceTimeFrames: 4000000, replayHash: sha(replay)});
  Object.assign(f.doc.data, {frames: 4000000, raceTimeFrames: 4000000, replayHash: sha(replay), replay});
  await assert.rejects(f.run(), /indexed playback budget/);
  assert.equal(f.helper.usedDocuments(), 1); assert.deepEqual(f.helper.report().retained, []);
});

test('all missing proofs are preflighted before the first canonical read', async () => {
  const f = fixture();
  f.prior.entries[1] = {...old, accountId: otherId, nativeLedgerKey: 'invalid'};
  await assert.rejects(f.helper.reconcile({trackId, prior: f.prior, board: boardOf([])}), /proof/);
  assert.deepEqual(f.calls, []);
});

test('synchronous callback errors and proof errors propagate without retries', async () => {
  for (const stage of ['proof', 'read']) {
    let calls = 0;
    const helper = createCanonicalRetainedTrack({proofAllowed: () => {
      if (stage === 'proof') {calls++; throw Error('proof failed');} return true;
    }, readCanonical: () => {calls++; throw Error('read failed');}});
    const f = fixture();
    await assert.rejects(helper.reconcile({trackId, prior: f.prior, board: f.board}), /failed/);
    assert.equal(calls, 1); assert.equal(helper.usedDocuments(), stage === 'read' ? 1 : 0);
  }
});
