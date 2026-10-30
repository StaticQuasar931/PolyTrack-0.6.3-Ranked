import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createNativeEventBaseline, projectNativeEventSnapshot, projectNativeEventTotals, nativeEventSourceHash,
  projectRetainedEventVerifications, projectAssembledEventTotals, deriveCapturedNativeRollingHills} from './native-event-snapshot.mjs';
import {publicEventTotals} from './public-event-totals-backup.mjs';
import {createLedgerEntry, writeLedger, ledgerBinding, ledgerKey} from './native-verification-ledger.mjs';
import {eventPeriod, eventLeaderboard, eventRp, publicEventPeriod, capturedEventRp, capturedEventLeaderboard} from '../workers/ranked/src/events.js';
import {PERMANENT_ROLLING_HILLS, derivePermanentRollingHills} from '../workers/ranked/src/permanent-rolling-hills.js';
import {VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION} from '../workers/ranked/src/verification.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const trackId = sha('event-track'), accountId = sha('racer'), replay = deflateSync(Buffer.alloc(15)).toString('base64url');
const content = sha('track-content'), fingerprint = sha('verifier-fixture'), geometry = {parts: 1, spanX: 1, spanZ: 1};
const policy = {engineDigest: VERIFIER_ENGINE_DIGEST, compatibleEngines: [], verifierVersion: VERIFIER_VERSION,
  verifierFingerprint: fingerprint, resourceProfiles: ['standard'], reviewPolicyVersions: ['review-v1'],
  trackContentHashes: {[trackId]: content}, trackGeometries: {[trackId]: {geometryPolicy: 'default', trackGeometry: geometry}}};
const period = eventPeriod({id: 'day1', kind: 'custom', enabled: true, trackId, startsAt: 1000, endsAt: 1000000,
  graceMs: 1000, maxRp: 1000, targetMs: 1000, scoringVersion: 'time-ratio-v1', eligibility: 'best-submitted-during-period',
  capacity: {policyVersion: 'test-v1', entrants: 200, admissionsPerPeriod: 512, replayBytesPerPeriod: 8388608,
    minIntervalMs: 1000, verificationsPerDay: 128}});

function run(extra = {}) {
  return {lane: 'event', periodId: period.id, trackId, runId: sha('new-run'), accountId, timeMs: 1000, frames: 1000,
    uploadId: null, replayHash: sha(replay), replay, submittedAt: 2000, name: 'Racer', carStyle: 'style', ...extra};
}
function pending(value = run()) {
  const {replay: bytes, lane, uploadId, frames, ...row} = value;
  return {...row, verificationStatus: 'waiting', pending: true, verified: false, eventRpEligible: false, source: 'pending-event-playback'};
}
function media(value = run()) {
  return {...value, verificationStatus: 'waiting', pending: true, verified: false, eventRpEligible: false, source: 'pending-event-recording'};
}
const oldRows = () => eventLeaderboard(period, [{accountId, name: 'Older PB', carStyle: 'style', timeMs: 1200,
  runId: sha('old-run'), replayHash: sha(replay), submittedAt: 1500}]);
function board({rows = oldRows(), waiting = [pending()], ...extra} = {}) {
  return {id: period.id, period, entries: rows, pendingPlaybacks: waiting, complete: true, totalEntries: rows.length,
    sourceComplete: true, updatedAt: 2500, racerCount: 1, ...extra};
}
function totals({entries, ...extra} = {}) {
  return {entries: entries || [{accountId, name: 'Profile Name', rp: eventRp(period, 1200) + 77 + 100,
    finiteEventRp: eventRp(period, 1200) + 77, permanentRollingHillsRp: 100,
    rollingHillsEventRpContribution: 100, events: 4, identityUpdatedAt: 1000,
    profileCosmetics: {version: 1}}], updatedAt: 2500, complete: true, totalEntries: entries?.length ?? 1, ...extra};
}
function rolling(extra = {}) {
  const rh = PERMANENT_ROLLING_HILLS.trackId;
  return {trackId: rh, algorithmVersion: 'participation-v8-s1', schemaVersion: 6, revision: 1, sourceRevision: 1,
    signature: 'fixture-signature-12345', builtAt: 3000, updatedAt: 3000, complete: true, totalEntries: 1,
    entries: [{accountId, trackId: rh, timeMs: 1000, frames: 1000, runVerified: true, integrityVerified: true,
      replayHash: sha(replay), name: 'Rolling Racer', pbAt: 1000}], ...extra};
}
function ledgerEntry(value = run(), disposition = 'approved', verifiedAt = 3000) {
  const job = {...value, resultId: value.runId};
  const binding = {verifierVersion: VERIFIER_VERSION, verifierFingerprint: fingerprint, resourceProfile: 'standard',
    resultId: job.resultId, trackId, timeMs: job.timeMs, replayHash: job.replayHash, actualReplayHash: sha(job.replay),
    nativeTrackId: trackId, trackContentHash: content, engineDigest: VERIFIER_ENGINE_DIGEST};
  const nativeResult = {resultId: job.resultId, trackId, timeMs: job.timeMs, replayHash: job.replayHash,
    status: 'verified', reason: 'native_exact_finish', deterministic: true, engineDigest: VERIFIER_ENGINE_DIGEST,
    trackContentHash: content, trackGeometry: geometry, geometryPolicy: 'default', binding,
    boundInputFingerprint: sha(JSON.stringify(binding))};
  const result = disposition === 'approved' ? nativeResult : {...nativeResult, status: 'unavailable', reason: 'similar_replay_pending_manual_review'};
  return createLedgerEntry({job, result, nativeResult, policy, lane: 'event', verifiedAt, review: {complete: true, disposition,
    bindingKey: ledgerKey(ledgerBinding(job)), policyVersion: 'review-v1', attestationHash: sha('review-' + disposition)}});
}
function loaded(t, entries = [ledgerEntry()]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-event-snapshot-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  return writeLedger({root, entries, expectedManifestHash: null});
}
function setup(t, {serverBoard = board(), serverTotals = totals(), runs = [run()], entries, recordings = runs.map(media)} = {}) {
  return {baseline: createNativeEventBaseline({serverBoard, period, serverTotals}), ledger: loaded(t, entries),
    canonicalRows: runs, recordings, policy};
}

test('exact branded reviewed ledger moves a retained pending PB into shared verified standings', async t => {
  const options = setup(t), before = JSON.stringify(options.baseline);
  const result = await projectNativeEventSnapshot(options);
  assert.equal(result.ready, true);
  assert.equal(result.board.entries[0].timeMs, 1000);
  assert.equal(result.board.entries[0].rp, eventRp(period, 1000));
  assert.equal(result.board.entries[0].physicsVerified, true);
  assert.equal(result.board.entries[0].replayIntegrityVerified, true);
  assert.equal(result.board.entries[0].verified, true);
  assert.equal(result.board.entries[0].pending, false);
  assert.equal(result.board.pendingPlaybacks, undefined);
  assert.equal(result.board.entries[0].submittedAt, 2000);
  assert.equal(result.board.entries[0].runCreatedAt, 2000);
  assert.equal(result.board.entries[0].verifiedAt, 3000, 'actual ledger review time, not the original PB or capture time');
  assert.equal(result.promotedReplays[0].replayHash, sha(replay));
  assert.equal(result.promotedReplays[0].submittedAt, 2000);
  assert.equal(result.promotedReplays[0].verifiedAt, 3000);
  assert.equal(JSON.stringify(options.baseline), before);
  assert.equal(JSON.stringify(result.board).includes('nativeLedger'), false);
});

test('held faster pending preserves an older verified PB and its original date/playback', async t => {
  const result = await projectNativeEventSnapshot(setup(t, {entries: [ledgerEntry(run(), 'held')]}));
  assert.equal(result.board.entries[0].timeMs, 1200);
  assert.equal(result.board.entries[0].submittedAt, 1500);
  assert.equal(result.board.pendingPlaybacks[0].timeMs, 1000);
  assert.equal(result.board.pendingPlaybacks[0].pending, true);
  assert.equal(result.board.pendingPlaybacks[0].eventRpEligible, false);
  assert.deepEqual(result.adjustments, []);
});

test('existing flagless standings receive exact ledger proof flags and approval date, without changing ERP', async t => {
  const old = run({runId: sha('old-run'), timeMs: 1200, frames: 1200, submittedAt: 1500});
  const projection = await projectNativeEventSnapshot(setup(t, {serverBoard: board({waiting: []}), runs: [old], entries: [ledgerEntry(old)]}));
  assert.equal(projection.report.admittedExisting, 1);
  assert.equal(projection.board.entries[0].physicsVerified, true);
  assert.equal(projection.board.entries[0].verified, true);
  assert.equal(projection.board.entries[0].verifiedAt, 3000);
  assert.equal(projection.board.entries[0].submittedAt, 1500);
  assert.equal(projection.promotedReplays[0].verifiedAt, 3000);
  assert.deepEqual(projection.adjustments, []);
});

test('retained public replay projections need not invent an old verified envelope before native admission', async t => {
  const old = run({runId: sha('old-run'), timeMs: 1200, frames: 1200, submittedAt: 1500});
  const retained = {...old};
  const projection = await projectNativeEventSnapshot(setup(t, {serverBoard: board({waiting: []}), runs: [old],
    recordings: [retained], entries: [ledgerEntry(old)]}));
  assert.equal(projection.report.admittedExisting, 1);
  assert.equal(projection.promotedReplays[0].submittedAt, 1500);
  assert.equal(projection.promotedReplays[0].verifiedAt, 3000);
});

test('a held pending verdict with no bytes is not misreported as a missing approved promotion', async t => {
  const projection = await projectNativeEventSnapshot(setup(t, {recordings: [], entries: [ledgerEntry(run(), 'held')]}));
  assert.equal(projection.ready, true);
  assert.equal(projection.report.unavailableRecording, 0);
  assert.equal(projection.report.held, 1);
  assert.equal(projection.board.entries[0].timeMs, 1200);
});

test('twelve unavailable legacy archives retain original standings without invented verification flags', async t => {
  const rows = eventLeaderboard(period, Array.from({length: 12}, (_, index) => ({accountId: sha('archive-' + index),
    timeMs: 1000 + index, submittedAt: 1500, name: 'Archive'})));
  const projection = await projectNativeEventSnapshot(setup(t, {serverBoard: board({rows, waiting: []}), runs: [], recordings: [], entries: []}));
  assert.equal(projection.report.unavailableExisting, 12);
  assert.equal(projection.board.entries.length, 12);
  for (const entry of projection.board.entries) {
    assert.equal(entry.physicsVerified, undefined);
    assert.equal(entry.verifiedAt, undefined);
    assert.equal(entry.submittedAt, 1500);
  }
  assert.deepEqual(projection.adjustments, []);
});

for (const disposition of ['held', 'excluded']) test('an exact ledger ' + disposition + ' removes existing ERP and adjusts finite totals once', async t => {
  const old = run({runId: sha('old-run'), timeMs: 1200, frames: 1200, submittedAt: 1500});
  const projection = await projectNativeEventSnapshot(setup(t, {serverBoard: board({waiting: []}), runs: [old],
    recordings: [], entries: [ledgerEntry(old, disposition)]}));
  assert.equal(projection.board.entries.length, 0);
  assert.equal(projection.report.removedExisting, 1);
  assert.deepEqual(projection.adjustments, [{accountId, beforeRp: eventRp(period, 1200), afterRp: 0,
    deltaRp: -eventRp(period, 1200), deltaEvents: -1}]);
  const args = {serverTotals: totals(), projections: [projection], rollingNormalBoard: rolling()};
  const first = projectNativeEventTotals(args), second = projectNativeEventTotals(args);
  assert.deepEqual(second.totals, first.totals);
  assert.equal(first.totals.entries[0].finiteEventRp, 77);
  assert.equal(first.totals.entries[0].events, 3);
  assert.equal(first.totals.entries[0].rp, 77 + 1001);
});

test('legacy missing run/hash binds only one exact retained original, never a same-time guess', async t => {
  const old = run({runId: sha('old-run'), timeMs: 1200, frames: 1200, submittedAt: 1500});
  const rows = oldRows().map(({runId, replayHash, ...row}) => row);
  const options = setup(t, {serverBoard: board({rows, waiting: []}), runs: [old], entries: [ledgerEntry(old)]});
  const projection = await projectNativeEventSnapshot(options);
  assert.equal(projection.board.entries[0].runId, old.runId);
  assert.equal(projection.board.entries[0].verifiedAt, 3000);
  const ambiguous = await projectNativeEventSnapshot({...options, canonicalRows: [old, {...old, runId: sha('ambiguous')} ]});
  assert.equal(ambiguous.report.unavailableExisting, 1);
  assert.equal(ambiguous.board.entries[0].physicsVerified, undefined);
});

test('approved PB survives a separate even faster held run for the same account', async t => {
  const faster = run({runId: sha('held-faster'), timeMs: 900, frames: 900, submittedAt: 2100});
  const result = await projectNativeEventSnapshot(setup(t, {serverBoard: board({waiting: [pending(), pending(faster)]}),
    runs: [run(), faster], entries: [ledgerEntry(), ledgerEntry(faster, 'held')]}));
  assert.equal(result.board.entries[0].timeMs, 1000);
  assert.equal(result.board.pendingPlaybacks[0].runId, faster.runId);
});

test('current source or retained replay holds cannot be overridden by an approved ledger', async t => {
  for (const where of ['source', 'recording', 'pending']) {
    const pb = run(), options = setup(t, {
      runs: [{...pb, ...(where === 'source' ? {needsReview: true} : {})}],
      recordings: [{...media(pb), ...(where === 'recording' ? {reviewHold: true} : {})}],
      serverBoard: board({waiting: [{...pending(pb), ...(where === 'pending' ? {reviewHold: true} : {})}]})});
    const result = await projectNativeEventSnapshot(options);
    assert.equal(result.board.entries[0].timeMs, 1200, where);
    assert.equal(result.board.pendingPlaybacks.length, 1);
  }
});

test('public/client verified flags and a serialized ledger clone confer no admission', async t => {
  const options = setup(t);
  await assert.rejects(projectNativeEventSnapshot({...options, ledger: structuredClone(options.ledger)}), /pinned/);
  const result = await projectNativeEventSnapshot({...options, ledger: loaded(t, [])});
  assert.equal(result.board.entries[0].timeMs, 1200);
});

test('incompatible current proof policy does not admit a pending PB', async t => {
  const options = setup(t);
  const result = await projectNativeEventSnapshot({...options, policy: {...policy, verifierFingerprint: sha('different')}});
  assert.equal(result.board.entries[0].timeMs, 1200);
  assert.equal(result.board.pendingPlaybacks.length, 1);
});

test('all exact event binding fields and original dates must match retained bytes', async t => {
  const options = setup(t);
  for (const change of [{periodId: 'other'}, {trackId: sha('other')}, {accountId: sha('other')},
    {runId: sha('other')}, {timeMs: 999}, {replayHash: sha('other')}]) {
    const result = await projectNativeEventSnapshot({...options, recordings: [{...media(), ...change}]});
    assert.equal(result.ready, false);
    assert.equal(result.board.entries[0].timeMs, 1200);
    assert.equal(result.report.unavailableRecording, 1);
  }
  await assert.rejects(projectNativeEventSnapshot({...options, recordings: [{...media(), submittedAt: 2001}]}), /date conflict/);
});

test('missing exact retained replay defers totals and never exposes a newly verified row', async t => {
  const options = setup(t, {recordings: []}), projection = await projectNativeEventSnapshot(options);
  assert.equal(projection.ready, false);
  assert.equal(projection.board.pendingPlaybacks.length, 1);
  assert.throws(() => projectNativeEventTotals({serverTotals: totals(), projections: [projection], rollingNormalBoard: rolling()}), /Ready/);
});

test('corrupt, retimed or duplicate matching recordings fail closed', async t => {
  const options = setup(t);
  for (const recordings of [[{...media(), replay: replay + 'changed'}], [{...media(), frames: 900}], [media(), media()]]) {
    await assert.rejects(projectNativeEventSnapshot({...options, recordings}));
  }
});

test('shared ranking retains competition ties and chooses fastest approved PB, not receipt order', async t => {
  const other = run({accountId: sha('other-racer'), runId: sha('other-run')});
  const result = await projectNativeEventSnapshot(setup(t, {serverBoard: board({waiting: [pending(other), pending()]}),
    runs: [other, run()], entries: [ledgerEntry(other), ledgerEntry()]}));
  assert.deepEqual(result.board.entries.map(row => row.rank), [1, 1]);
});

test('baseline companion roundtrip makes repeated cached overlay idempotent', async t => {
  const options = setup(t), first = await projectNativeEventSnapshot(options);
  const second = await projectNativeEventSnapshot({...options, baseline: JSON.parse(JSON.stringify(first.baseline))});
  assert.deepEqual(second.board, first.board);
  assert.deepEqual(second.adjustments, first.adjustments);
  assert.throws(() => createNativeEventBaseline({serverBoard: first.board, period, serverTotals: totals()}), /pristine/);
});

test('totals apply exact old-to-new finite delta once and replace Rolling Hills via shared policy', async t => {
  const serverTotals = totals(), projection = await projectNativeEventSnapshot(setup(t, {serverTotals}));
  const args = {serverTotals, projections: [projection], rollingNormalBoard: rolling()};
  const first = projectNativeEventTotals(args), second = projectNativeEventTotals(args);
  assert.deepEqual(second, first);
  const result = first.totals.entries[0];
  assert.equal(result.finiteEventRp, 1000 + 77, 'unknown archived contributions remain untouched');
  assert.equal(result.permanentRollingHillsRp, derivePermanentRollingHills(rolling()).entries[0].rp);
  assert.equal(result.rp, 1077 + 1001);
  assert.equal(result.events, 4, 'improving an existing event is not another event');
  assert.equal(result.name, 'Profile Name');
  assert.equal(result.identityUpdatedAt, 1000);
  assert.throws(() => projectNativeEventTotals({...args, serverTotals: first.totals}), /pristine/);
  assert.throws(() => projectNativeEventTotals({...args, projections: [projection, projection]}), /duplicate/);
});

test('fresh server totals reject old companions, then rebase without doubling or undoing overlays', async t => {
  const old = await projectNativeEventSnapshot(setup(t));
  const freshTotals = totals({updatedAt: 2600, entries: [{...totals().entries[0], finiteEventRp: 1077, rp: 1177}]});
  assert.throws(() => projectNativeEventTotals({serverTotals: freshTotals, projections: [old], rollingNormalBoard: rolling()}), /baseline mismatch/);
  const freshBoard = board({rows: old.board.entries, waiting: [], updatedAt: 2600});
  const rebased = await projectNativeEventSnapshot(setup(t, {serverBoard: freshBoard, serverTotals: freshTotals}));
  assert.deepEqual(rebased.adjustments, []);
  const result = projectNativeEventTotals({serverTotals: freshTotals, projections: [rebased], rollingNormalBoard: rolling()});
  assert.equal(result.totals.entries[0].finiteEventRp, 1077);
  assert.equal(result.totals.entries[0].rp, 2078);
});

test('new entrant adds one finite event, not any unknown historical periods', async t => {
  const serverTotals = totals({entries: []});
  const projection = await projectNativeEventSnapshot(setup(t, {serverBoard: board({rows: []}), serverTotals}));
  const result = projectNativeEventTotals({serverTotals, projections: [projection], rollingNormalBoard: rolling()});
  assert.equal(result.totals.entries[0].events, 1);
  assert.equal(result.totals.entries[0].finiteEventRp, 1000);
});

test('partial or guessed finite/archived baselines never produce totals', async t => {
  for (const serverBoard of [board({complete: false}), board({totalEntries: 50}), board({publicationPending: true})]) {
    assert.throws(() => createNativeEventBaseline({serverBoard, period, serverTotals: totals()}));
  }
  const unknown = totals({entries: [{accountId, rp: 1000, events: 4}]});
  assert.throws(() => projectNativeEventTotals({serverTotals: unknown, rollingNormalBoard: rolling()}), /Explicit finite/);
  const options = setup(t), bad = structuredClone(options.baseline); bad.board.entries[0].rp++;
  await assert.rejects(projectNativeEventSnapshot({...options, baseline: bad}), /companion/);
  const changedPolicy = structuredClone(options.baseline); changedPolicy.period.targetMs++;
  await assert.rejects(projectNativeEventSnapshot({...options, baseline: changedPolicy}), /companion/);
});

test('incomplete Rolling Hills board blocks rather than resetting its dynamic ERP to zero', () => {
  assert.throws(() => projectNativeEventTotals({serverTotals: totals(), rollingNormalBoard: rolling({complete: false})}), /incomplete/);
});

test('no API performs transport, native execution, or file writes during projection', async t => {
  const options = setup(t), oldFetch = globalThis.fetch;
  globalThis.fetch = () => {throw Error('Network forbidden');};
  try {
    const projection = await projectNativeEventSnapshot(options);
    assert.equal(projectNativeEventTotals({serverTotals: totals(), projections: [projection], rollingNormalBoard: rolling()}).totals.entries.length, 1);
  } finally {globalThis.fetch = oldFetch;}
});

test('pinned captured public policy compiles without private capacity, engine or period binding', async t => {
  const publicPeriod = publicEventPeriod(period), source = board({period: publicPeriod});
  const baseline = createNativeEventBaseline({serverBoard: source, serverTotals: totals(),
    expectedSourceHash: nativeEventSourceHash(source)});
  const projection = await projectNativeEventSnapshot({...setup(t), baseline});
  assert.equal(baseline.policyMode, 'captured-public-period');
  for (const field of ['capacity', 'engineDigest', 'verifierVersion', 'kodub', 'periodBinding']) {
    assert.equal(baseline.period[field], undefined, field);
  }
  assert.equal(projection.board.entries[0].rp, eventRp(period, 1000));
  assert.equal(projection.board.entries[0].verifiedAt, 3000);
  const result = projectNativeEventTotals({serverTotals: totals(), projections: [projection], rollingNormalBoard: rolling()});
  assert.equal(result.totals.entries[0].finiteEventRp, 1077);
});

test('genuinely omitted public scoring version retains original legacy V1 semantics without inserting a field', async t => {
  const publicPeriod = publicEventPeriod(period); delete publicPeriod.scoringVersion;
  const source = board({period: publicPeriod});
  const baseline = createNativeEventBaseline({serverBoard: source, serverTotals: totals(), expectedSourceHash: nativeEventSourceHash(source)});
  const projection = await projectNativeEventSnapshot({...setup(t), baseline});
  assert.equal(Object.hasOwn(baseline.period, 'scoringVersion'), false);
  assert.equal(Object.hasOwn(projection.board.period, 'scoringVersion'), false);
  assert.equal(projection.board.entries[0].rp, eventRp(period, 1000));
});

test('public V2 target and tie scores match fully validated private Worker policy', async t => {
  const full = eventPeriod({...period, scoringVersion: 'time-gap-v2'}), publicPeriod = publicEventPeriod(full);
  const source = board({period: publicPeriod, rows: capturedEventLeaderboard(publicPeriod, [{accountId, timeMs: 1200, submittedAt: 1500}])});
  const baseline = createNativeEventBaseline({serverBoard: source, serverTotals: totals(), expectedSourceHash: nativeEventSourceHash(source)});
  const projection = await projectNativeEventSnapshot({...setup(t), baseline});
  assert.equal(projection.board.entries[0].rp, eventRp(full, 1000));
  for (const timeMs of [1, 999, 1000, 1200, 300000]) assert.equal(capturedEventRp(publicPeriod, timeMs), eventRp(full, timeMs));
  const rows = [{accountId, timeMs: 1000}, {accountId: sha('tie'), timeMs: 1000}, {accountId: sha('third'), timeMs: 1200}];
  assert.deepEqual(capturedEventLeaderboard(publicPeriod, rows), eventLeaderboard(full, rows));
});

test('public source requires independently pinned matching object or exact file bytes', () => {
  const source = board({period: publicEventPeriod(period)}), args = {serverBoard: source, serverTotals: totals()};
  assert.throws(() => createNativeEventBaseline(args), /Trusted event source hash/);
  assert.throws(() => createNativeEventBaseline({...args, expectedSourceHash: sha('different')}), /hash mismatch/);
  const sourceBytes = JSON.stringify(source) + '\n', expectedSourceHash = sha(sourceBytes);
  const baseline = createNativeEventBaseline({...args, sourceBytes, expectedSourceHash});
  assert.equal(baseline.sourceHashMode, 'file-bytes');
  assert.equal(baseline.sourceHash, expectedSourceHash);
  assert.throws(() => createNativeEventBaseline({...args, serverBoard: {...source, updatedAt: 2600}, sourceBytes, expectedSourceHash}), /bytes do not match/);
  assert.throws(() => createNativeEventBaseline({...args, sourceBytes: sourceBytes + ' ', expectedSourceHash}), /hash mismatch/);
});

test('missing public target, dates or explicit entrant limit cannot be invented from another policy', () => {
  for (const missing of ['targetMs', 'startsAt', 'endsAt', 'entrantLimit']) {
    const publicPeriod = publicEventPeriod(period); delete publicPeriod[missing];
    const source = board({period: publicPeriod}), args = {serverBoard: source, serverTotals: totals(), expectedSourceHash: nativeEventSourceHash(source)};
    assert.throws(() => createNativeEventBaseline(args), undefined, missing);
    assert.throws(() => createNativeEventBaseline({...args, period: publicEventPeriod(period)}), undefined, missing);
  }
  const publicPeriod = publicEventPeriod(period), source = board({period: publicPeriod});
  assert.throws(() => createNativeEventBaseline({serverBoard: source, serverTotals: totals(), expectedSourceHash: nativeEventSourceHash(source),
    period: {...publicPeriod, targetMs: 999}}), /exactly match/);
});

test('captured kodub scoring requires no private kodub track code or Worker period binding', async t => {
  const publicPeriod = {...publicEventPeriod(period), kind: 'kodub', maxRp: 700, scoringVersion: 'time-gap-v2'};
  const rows = capturedEventLeaderboard(publicPeriod, [{accountId, timeMs: 1200, submittedAt: 1500}]);
  const source = board({period: publicPeriod, rows});
  const baseline = createNativeEventBaseline({serverBoard: source, serverTotals: totals(), expectedSourceHash: nativeEventSourceHash(source)});
  const result = await projectNativeEventSnapshot({...setup(t), baseline});
  assert.equal(result.board.entries[0].rp, capturedEventRp(publicPeriod, 1000));
  assert.equal(result.board.entries[0].rp, 560);
  assert.equal(result.baseline.period.kodub, undefined);
});

test('even a valid full private policy cannot fill a missing captured target or change implicit legacy scoring', () => {
  const publicPeriod = publicEventPeriod(period); delete publicPeriod.targetMs;
  const source = board({period: publicPeriod});
  assert.throws(() => createNativeEventBaseline({serverBoard: source, period, serverTotals: totals()}), /invalid_scoring/);
  const legacy = publicEventPeriod(period); delete legacy.scoringVersion;
  assert.throws(() => createNativeEventBaseline({serverBoard: board({period: legacy}),
    period: eventPeriod({...period, scoringVersion: 'time-gap-v2'}), serverTotals: totals()}), /baseline mismatch/);
});

async function previousNative(t) {
  const options = setup(t), projection = await projectNativeEventSnapshot(options);
  return {options, projection, retainedNativeEntries: {previousBoard: projection.board,
    recordings: projection.promotedReplays, expectedSourceHash: nativeEventSourceHash(projection.board)}};
}

test('fresh raw board omitting an old native PB retains it and subtracts only server ERP', async t => {
  const prior = await previousNative(t), freshTotals = totals({updatedAt: 4000});
  const options = setup(t, {serverBoard: board({waiting: [], updatedAt: 4000}), serverTotals: freshTotals, runs: [], recordings: []});
  const args = {...options, ledger: prior.options.ledger, retainedNativeEntries: prior.retainedNativeEntries};
  const first = await projectNativeEventSnapshot(args), second = await projectNativeEventSnapshot(args);
  assert.equal(first.board.entries[0].timeMs, 1000);
  assert.equal(first.board.entries[0].submittedAt, 2000);
  assert.equal(first.board.entries[0].verifiedAt, 3000);
  assert.equal(first.report.retainedAdmitted, 1);
  assert.equal(first.adjustments[0].beforeRp, eventRp(period, 1200), 'never subtract the previously overlaid native ERP');
  assert.equal(first.adjustments[0].deltaRp, 1000 - eventRp(period, 1200));
  assert.deepEqual(first.board, second.board);
  const one = projectNativeEventTotals({serverTotals: freshTotals, projections: [first], rollingNormalBoard: rolling()});
  const two = projectNativeEventTotals({serverTotals: freshTotals, projections: [second], rollingNormalBoard: rolling()});
  assert.equal(one.totals.entries[0].finiteEventRp, 1077);
  assert.deepEqual(one.totals, two.totals);
});

test('a newer faster held pending run cannot replace a retained approved native PB', async t => {
  const prior = await previousNative(t), newer = run({runId: sha('newer-held'), timeMs: 900, frames: 900, submittedAt: 2200});
  const options = setup(t, {serverBoard: board({waiting: [pending(newer)], updatedAt: 4000}), runs: [newer],
    entries: [ledgerEntry(), ledgerEntry(newer, 'held')]});
  const result = await projectNativeEventSnapshot({...options, retainedNativeEntries: prior.retainedNativeEntries});
  assert.equal(result.board.entries[0].timeMs, 1000);
  assert.equal(result.board.entries[0].runId, run().runId);
  assert.equal(result.board.pendingPlaybacks[0].runId, newer.runId);
  assert.equal(result.board.pendingPlaybacks[0].eventRpEligible, false);
  assert.equal(result.promotedReplays.find(value => value.runId === run().runId).replay, replay);
});

test('empty raw server archive retains old native approval, replay and original dates with one ERP event', async t => {
  const prior = await previousNative(t);
  const freshTotals = totals({updatedAt: 4000, entries: [{...totals().entries[0], finiteEventRp: 77, rp: 177, events: 3}]});
  const options = setup(t, {serverBoard: board({rows: [], waiting: [], archived: true, updatedAt: 4000}),
    serverTotals: freshTotals, runs: [], recordings: []});
  const projection = await projectNativeEventSnapshot({...options, ledger: prior.options.ledger, retainedNativeEntries: prior.retainedNativeEntries});
  assert.equal(projection.board.archived, true);
  assert.equal(projection.board.entries.length, 1);
  assert.equal(projection.board.entries[0].submittedAt, 2000);
  assert.equal(projection.board.entries[0].verifiedAt, 3000);
  assert.equal(projection.promotedReplays[0].replayHash, sha(replay));
  assert.equal(projection.promotedReplays[0].replay, replay);
  assert.equal(projection.adjustments[0].beforeRp, 0);
  assert.equal(projection.adjustments[0].deltaRp, 1000);
  const output = projectNativeEventTotals({serverTotals: freshTotals, projections: [projection], rollingNormalBoard: rolling()});
  assert.equal(output.totals.entries[0].finiteEventRp, 1077);
  assert.equal(output.totals.entries[0].events, 4);
});

test('a protected prior pending source can prove admission after raw archive cleanup without prior overlay', async t => {
  const previousBoard = board({rows: []}), options = setup(t, {serverBoard: board({rows: [], waiting: [], archived: true}), runs: [], recordings: []});
  const result = await projectNativeEventSnapshot({...options, retainedNativeEntries: {previousBoard,
    recordings: [media()], expectedSourceHash: nativeEventSourceHash(previousBoard)}});
  assert.equal(result.board.entries[0].runId, run().runId);
  assert.equal(result.board.entries[0].submittedAt, pending().submittedAt);
  assert.equal(result.board.entries[0].verifiedAt, 3000);
});

test('current root ledger hold/exclusion vetoes stale previously approved native snapshots', async t => {
  const prior = await previousNative(t);
  for (const disposition of ['held', 'excluded']) {
    const options = setup(t, {serverBoard: board({rows: [], waiting: []}), runs: [], recordings: [], entries: [ledgerEntry(run(), disposition)]});
    const result = await projectNativeEventSnapshot({...options, retainedNativeEntries: prior.retainedNativeEntries});
    assert.equal(result.board.entries.length, 0);
    assert.equal(result.report.retainedBlocked, 1);
    assert.equal(result.ready, true);
  }
});

test('current exact-run restrictions veto retention but not a different run for the same account', async t => {
  const prior = await previousNative(t);
  const options = setup(t, {serverBoard: board({rows: [], waiting: []}), runs: [{...run(), needsReview: true}], recordings: []});
  const result = await projectNativeEventSnapshot({...options, retainedNativeEntries: prior.retainedNativeEntries});
  assert.equal(result.board.entries.length, 0);
  assert.equal(result.report.retainedBlocked, 1);
});

test('retention requires a trusted snapshot pin, exact immutable period, and matching authentic replay date', async t => {
  const prior = await previousNative(t), options = setup(t, {serverBoard: board({rows: [], waiting: []}), runs: [], recordings: []});
  const input = prior.retainedNativeEntries;
  await assert.rejects(projectNativeEventSnapshot({...options, retainedNativeEntries: {...input, expectedSourceHash: sha('wrong')}}), /hash/);
  const wrongPeriod = {...input.previousBoard, period: {...input.previousBoard.period, endsAt: period.endsAt + 1}};
  await assert.rejects(projectNativeEventSnapshot({...options, retainedNativeEntries: {...input, previousBoard: wrongPeriod,
    expectedSourceHash: nativeEventSourceHash(wrongPeriod)}}), /frozen policy/);
  await assert.rejects(projectNativeEventSnapshot({...options, retainedNativeEntries: {...input,
    recordings: input.recordings.map(value => ({...value, submittedAt: 2001}))}}), /date conflict/);
});

test('missing retained native bytes defers rather than silently publishing the vanished old PB', async t => {
  const prior = await previousNative(t), options = setup(t, {serverBoard: board({rows: [], waiting: []}), runs: [], recordings: []});
  const result = await projectNativeEventSnapshot({...options, retainedNativeEntries: {...prior.retainedNativeEntries, recordings: []}});
  assert.equal(result.ready, false);
  assert.equal(result.report.unavailableRetained, 1);
});

test('minimum of prior and newly approved native PBs wins regardless of capture order', async t => {
  const prior = await previousNative(t);
  for (const timeMs of [900, 1100]) {
    const newer = run({runId: sha('new-approved-' + timeMs), timeMs, frames: timeMs, submittedAt: 2200});
    const options = setup(t, {serverBoard: board({waiting: [pending(newer)]}), runs: [newer], entries: [ledgerEntry(), ledgerEntry(newer)]});
    const result = await projectNativeEventSnapshot({...options, retainedNativeEntries: prior.retainedNativeEntries});
    assert.equal(result.board.entries[0].timeMs, Math.min(1000, timeMs));
    assert.equal(result.promotedReplays.length, 1);
    assert.equal(result.promotedReplays[0].runId,result.board.entries[0].runId);
    assert.equal(result.promotedReplays[0].replayHash,result.board.entries[0].replayHash);
    assert.equal(result.promotedReplays[0].timeMs,result.board.entries[0].timeMs);
  }
});

test('a changed proof policy defers instead of silently erasing a retained prior approval', async t => {
  const prior = await previousNative(t), options = setup(t, {serverBoard: board({rows: [], waiting: []}), runs: [], recordings: []});
  const result = await projectNativeEventSnapshot({...options, retainedNativeEntries: prior.retainedNativeEntries,
    policy: {...policy, verifierFingerprint: sha('not-compatible')}});
  assert.equal(result.ready, false);
  assert.equal(result.report.unavailableRetained, 1);
});

test('pinned retained source rows and replay dates are isolated from mutations after projection begins', async t => {
  const prior = await previousNative(t), options = setup(t);
  const retainedNativeEntries = structuredClone(prior.retainedNativeEntries);
  const promise = projectNativeEventSnapshot({...options, retainedNativeEntries});
  retainedNativeEntries.previousBoard.entries[0].submittedAt = 2200;
  retainedNativeEntries.recordings[0].submittedAt = 2200;
  const result = await promise;
  assert.equal(result.ready, true);
  assert.equal(result.board.entries[0].submittedAt, 2000);
  assert.equal(result.report.retainedAdmitted, 1);
});

test('unmatched legacy prior rows without dates are not invented as native retention candidates', async t => {
  const prior = await previousNative(t), previousBoard = structuredClone(prior.projection.board);
  previousBoard.entries.push({accountId: sha('unavailable-archive'), timeMs: 1200, rp: eventRp(period, 1200), rank: 2});
  previousBoard.totalEntries = previousBoard.entries.length;
  const options = setup(t, {serverBoard: board({rows: [], waiting: []}), runs: [], recordings: []});
  const result = await projectNativeEventSnapshot({...options, retainedNativeEntries: {...prior.retainedNativeEntries,
    previousBoard, expectedSourceHash: nativeEventSourceHash(previousBoard)}});
  assert.equal(result.ready, true);
  assert.equal(result.report.retainedUnmatched, 1);
  assert.equal(result.board.entries.length, 1);
  assert.equal(result.board.entries[0].runId, run().runId);
});

test('unknown-completeness legacy boards gain existing proof flags only, never ranking, RP, pending admissions or totals', async t => {
  const old = run({runId: sha('old-run'), timeMs: 1200, frames: 1200, submittedAt: 1500});
  const missing = {accountId: sha('missing-legacy'), timeMs: 1300, submittedAt: 1600, rank: 91, rp: 12, legacy: 'unchanged'};
  const serverBoard = board({period: publicEventPeriod(period), rows: [{...oldRows()[0], rank: 47, rp: 321}, missing]});
  delete serverBoard.complete; delete serverBoard.totalEntries;
  const original = structuredClone(serverBoard);
  const result = await projectRetainedEventVerifications({serverBoard, expectedSourceHash: nativeEventSourceHash(serverBoard),
    ledger: loaded(t, [ledgerEntry(old), ledgerEntry()]), canonicalRows: [old, run()], recordings: [media(old), media()], policy});
  assert.equal(result.report.verified, 1);
  assert.equal(result.report.unavailable, 1);
  assert.equal(result.board.entries.length, 2);
  assert.equal(result.board.entries[0].rank, 47);
  assert.equal(result.board.entries[0].rp, 321);
  assert.equal(result.board.entries[0].submittedAt, 1500);
  assert.equal(result.board.entries[0].verifiedAt, 3000);
  assert.equal(result.board.entries[0].physicsVerified, true);
  assert.deepEqual(result.board.entries[1], missing);
  assert.deepEqual(result.board.pendingPlaybacks, original.pendingPlaybacks);
  assert.equal(Object.hasOwn(result.board, 'complete'), false);
  assert.equal(Object.hasOwn(result.board, 'totalEntries'), false);
  assert.equal(result.totalsEligible, false);
  assert.deepEqual(result.adjustments, []);
  assert.deepEqual(serverBoard, original);
  assert.throws(() => projectNativeEventTotals({serverTotals: totals(), projections: [result], rollingNormalBoard: rolling()}), /Ready/);
});

test('old archived=false and explicitly incomplete boards retain coverage metadata exactly', async t => {
  for (const coverage of [{archived: false}, {archived: false, complete: false, totalEntries: 500}]) {
    const serverBoard = board({waiting: [], ...coverage});
    if (!Object.hasOwn(coverage, 'complete')) {delete serverBoard.complete; delete serverBoard.totalEntries;}
    const result = await projectRetainedEventVerifications({serverBoard, expectedSourceHash: nativeEventSourceHash(serverBoard),
      ledger: loaded(t, []), canonicalRows: [], recordings: [], policy});
    assert.deepEqual(result.board, serverBoard);
    assert.equal(result.report.unavailable, 1);
  }
});

test('unknown coverage review holds change proof eligibility only, without pretending to know an ERP delta', async t => {
  const old = run({runId: sha('old-run'), timeMs: 1200, frames: 1200, submittedAt: 1500});
  const serverBoard = board({waiting: []}); delete serverBoard.complete; delete serverBoard.totalEntries;
  const result = await projectRetainedEventVerifications({serverBoard, expectedSourceHash: nativeEventSourceHash(serverBoard),
    ledger: loaded(t, [ledgerEntry(old, 'held')]), canonicalRows: [old], recordings: [media(old)], policy});
  assert.equal(result.board.entries[0].verified, false);
  assert.equal(result.board.entries[0].eventRpEligible, false);
  assert.equal(result.board.entries[0].verificationStatus, 'held');
  assert.equal(result.board.entries[0].rank, serverBoard.entries[0].rank);
  assert.equal(result.board.entries[0].rp, serverBoard.entries[0].rp);
  assert.deepEqual(result.adjustments, []);
});

test('real legacy kodub envelope without submission dates uses only the exact protected visible row date', async t => {
  const submittedAt = 1792771667212, verifiedAt = 1793000000000;
  const publicPeriod = {...publicEventPeriod(period), id: 'kodub_1792958400000', kind: 'kodub', maxRp: 700,
    startsAt: 1792353600000, endsAt: 1792958400000};
  const old = run({periodId: publicPeriod.id, runId: sha('wah-legacy'), timeMs: 1200, frames: 1200, submittedAt});
  // Exact legacy export keys: no submittedAt or runCreatedAt in this file.
  const raw = {periodId: old.periodId, trackId, accountId, runId: old.runId, timeMs: old.timeMs, frames: old.frames,
    replay, replayHash: sha(replay), carStyle: old.carStyle, verifiedAt};
  const entries = capturedEventLeaderboard(publicPeriod, [{...old, rp: 0}]);
  const serverBoard = board({id: publicPeriod.id, period: publicPeriod, rows: entries, waiting: [], updatedAt: verifiedAt});
  delete serverBoard.complete; delete serverBoard.totalEntries;
  const ledger = loaded(t, [ledgerEntry(old, 'approved', verifiedAt)]);
  const args = {serverBoard, expectedSourceHash: nativeEventSourceHash(serverBoard), ledger,
    canonicalRows: [old], recordings: [raw], policy};
  const result = await projectRetainedEventVerifications(args);
  assert.equal(result.report.verified, 1);
  assert.equal(result.board.entries[0].submittedAt, submittedAt);
  assert.equal(result.board.entries[0].verifiedAt, verifiedAt);
  assert.equal(result.promotedReplays[0].submittedAt, submittedAt);
  assert.equal(Object.hasOwn(result.board, 'complete'), false);
  assert.equal(Object.hasOwn(raw, 'submittedAt'), false, 'do not mutate the original legacy envelope');
  const fullBoard = {...serverBoard, complete: true, totalEntries: 1};
  const baseline = createNativeEventBaseline({serverBoard: fullBoard, serverTotals: totals(), expectedSourceHash: nativeEventSourceHash(fullBoard)});
  const full = await projectNativeEventSnapshot({...args, baseline});
  assert.equal(full.report.admittedExisting, 1);
  assert.equal(full.promotedReplays[0].submittedAt, submittedAt);
  assert.equal(full.board.entries[0].verifiedAt, verifiedAt);
  for (const conflict of [{submittedAt: submittedAt + 1}, {runCreatedAt: submittedAt + 1}]) {
    await assert.rejects(projectRetainedEventVerifications({...args, recordings: [{...raw, ...conflict}]}), /date conflict/);
    await assert.rejects(projectNativeEventSnapshot({...args, baseline, recordings: [{...raw, ...conflict}]}), /date conflict/);
  }
});

test('new pending recording without its own submission date cannot inherit date from pending row or verifiedAt', async t => {
  const raw = media(); delete raw.submittedAt; raw.verifiedAt = 3000;
  const result = await projectNativeEventSnapshot(setup(t, {recordings: [raw]}));
  assert.equal(result.ready, false);
  assert.equal(result.report.admitted, 0);
  assert.equal(result.report.unavailableRecording, 1);
  assert.equal(result.board.entries[0].timeMs, 1200);
  assert.equal(result.board.pendingPlaybacks.length, 1);
});

test('protected prior visible native PB can retain dateless legacy bytes, but a prior pending row cannot', async t => {
  const prior = await previousNative(t), options = setup(t, {serverBoard: board({rows: [], waiting: [], archived: true}), runs: [], recordings: []});
  const raw = {...prior.retainedNativeEntries.recordings[0]}; delete raw.submittedAt; delete raw.runCreatedAt;
  const result = await projectNativeEventSnapshot({...options, retainedNativeEntries: {...prior.retainedNativeEntries, recordings: [raw]}});
  assert.equal(result.ready, true);
  assert.equal(result.board.entries[0].submittedAt, 2000);
  assert.equal(result.promotedReplays[0].submittedAt, 2000);
  const previousBoard = board({rows: []}), pendingRaw = media(); delete pendingRaw.submittedAt;
  const denied = await projectNativeEventSnapshot({...options, retainedNativeEntries: {previousBoard,
    expectedSourceHash: nativeEventSourceHash(previousBoard), recordings: [pendingRaw]}});
  assert.equal(denied.ready, false);
  assert.equal(denied.board.entries.length, 0);
});

test('legacy w_20261005 exact visible native proof gains honest labels even when row and replay have no submission dates', async t => {
  const original = run({periodId: 'w_20261005', runId: sha('34793a-legacy-run'), timeMs: 15537, frames: 15537});
  delete original.submittedAt;
  const publicPeriod = {...publicEventPeriod(period), id: original.periodId, kind: 'weekly', maxRp: 500,
    targetMs: 12368, startsAt: Date.UTC(2026, 9, 5), endsAt: Date.UTC(2026, 9, 12)};
  const row = {accountId, runId: original.runId, replayHash: original.replayHash, timeMs: 15537, rp: 398, rank: 1, name: 'Legacy'};
  const serverBoard = {id: original.periodId, period: publicPeriod, entries: [row], updatedAt: Date.UTC(2026, 9, 29), archived: false};
  const raw = {periodId: original.periodId, trackId, accountId, runId: original.runId, timeMs: original.timeMs,
    frames: original.frames, replay, replayHash: sha(replay), carStyle: 'style'};
  const approvedAt = Date.UTC(2026, 9, 29);
  const result = await projectRetainedEventVerifications({serverBoard, expectedSourceHash: nativeEventSourceHash(serverBoard),
    ledger: loaded(t, [ledgerEntry(original, 'approved', approvedAt)]), canonicalRows: [original], recordings: [raw], policy});
  assert.equal(result.report.verified, 1);
  assert.equal(result.board.entries[0].physicsVerified, true);
  assert.equal(result.board.entries[0].verifiedAt, approvedAt);
  assert.equal(result.board.entries[0].rp, 398); assert.equal(result.board.entries[0].rank, 1);
  for (const key of ['submittedAt', 'runCreatedAt', 'createdAt', 'pbAt']) {
    assert.equal(Object.hasOwn(result.board.entries[0], key), false, key);
    assert.equal(Object.hasOwn(result.promotedReplays[0], key), false, key);
  }
  assert.equal(Object.hasOwn(result.board, 'complete'), false);
  assert.equal(result.totalsEligible, false); assert.deepEqual(result.adjustments, []);
});

test('unknown-date existing proof cannot guess a missing run/hash or change an explicit ERP eligibility decision', async t => {
  const original = run(); delete original.submittedAt;
  const row = {accountId, runId: original.runId, replayHash: original.replayHash, timeMs: 1000, rp: 123, rank: 8, eventRpEligible: false};
  const serverBoard = board({rows: [row], waiting: []}); delete serverBoard.complete; delete serverBoard.totalEntries;
  const raw = {...original};
  const args = {serverBoard, expectedSourceHash: nativeEventSourceHash(serverBoard), ledger: loaded(t, [ledgerEntry(original)]),
    canonicalRows: [original], recordings: [raw], policy};
  const result = await projectRetainedEventVerifications(args);
  assert.equal(result.report.verified, 1); assert.equal(result.board.entries[0].eventRpEligible, false);
  const missingIdentity = structuredClone(serverBoard); delete missingIdentity.entries[0].runId;
  const skipped = await projectRetainedEventVerifications({...args, serverBoard: missingIdentity, expectedSourceHash: nativeEventSourceHash(missingIdentity)});
  assert.equal(skipped.report.verified, 0); assert.equal(skipped.report.unavailable, 1);
});

test('winning retained 10s replay is the only exported per-account payload after a slower approved 11s run', async t => {
  const prior = await previousNative(t), slower = run({runId: sha('approved-slower'), timeMs: 1100, frames: 1100, submittedAt: 2200});
  const options = setup(t, {serverBoard: board({waiting: [pending(slower)]}), runs: [slower], entries: [ledgerEntry(), ledgerEntry(slower)]});
  const result = await projectNativeEventSnapshot({...options, retainedNativeEntries: prior.retainedNativeEntries});
  assert.equal(result.board.entries[0].timeMs, 1000);
  assert.equal(result.promotedReplays.length, 1);
  assert.equal(result.promotedReplays[0].runId, run().runId);
  assert.equal(result.promotedReplays[0].timeMs, 1000);
  assert.equal(result.promotedReplays[0].replayHash, result.board.entries[0].replayHash);
});

test('source old PB and two approved same-account fast ties export only the exact selected run/hash, never the last processed replay', async t => {
  const old = run({runId: sha('old-run'), timeMs: 1200, frames: 1200, submittedAt: 1500});
  const tieBytes = deflateSync(Buffer.alloc(15), {level: 0}).toString('base64url');
  const tie = run({runId: sha('new-fast-tie'), replay: tieBytes, replayHash: sha(tieBytes), submittedAt: 2200});
  const options = setup(t, {serverBoard: board({waiting: [pending(), pending(tie)]}), runs: [old, run(), tie],
    entries: [ledgerEntry(old), ledgerEntry(), ledgerEntry(tie)]});
  const result = await projectNativeEventSnapshot(options), selected = result.board.entries[0];
  assert.equal(selected.runId, run().runId); assert.equal(selected.replayHash, sha(replay));
  assert.equal(result.promotedReplays.length, 1);
  const perAccount = new Map();
  for (const value of result.promotedReplays) perAccount.set(value.accountId, value);
  assert.equal(perAccount.get(accountId).runId, selected.runId);
  assert.equal(perAccount.get(accountId).timeMs, selected.timeMs);
  assert.equal(perAccount.get(accountId).replayHash, selected.replayHash);
});

function assembledTotals(count = 269) {
  return totals({entries: Array.from({length: count}, (_, index) => ({accountId: index === 0 ? accountId : sha('total-' + index),
    name: 'Racer ' + index, rp: 10, finiteEventRp: 10, permanentRollingHillsRp: 0, rollingHillsEventRpContribution: 0, events: 1}))});
}
function capturedRolling(extra = {}) {
  const snapshot = rolling(extra); delete snapshot.signature; delete snapshot.builtAt;
  return snapshot;
}

test('269 assembled totals validate without fabricated paginatedSource, and identities are checked across chunks', () => {
  const source = assembledTotals(), original = structuredClone(source);
  assert.throws(() => publicEventTotals(source), /Invalid public event totals/);
  const projected = projectAssembledEventTotals(source);
  assert.equal(projected.entries.length, 269); assert.equal(projected.totalEntries, 269); assert.equal(projected.complete, true);
  assert.equal(Object.hasOwn(projected, 'paginatedSource'), false); assert.equal(Object.hasOwn(projected, 'pagination'), false);
  assert.deepEqual(source, original);
  const duplicate = structuredClone(source); duplicate.entries[201].accountId = duplicate.entries[0].accountId;
  assert.throws(() => projectAssembledEventTotals(duplicate), /Duplicate.*across chunks/);
  const invalidTail = structuredClone(source); invalidTail.entries[268].rp = -1;
  assert.throws(() => projectAssembledEventTotals(invalidTail), /metric/);
  assert.throws(() => projectAssembledEventTotals({...source, totalEntries: 268}), /complete/);
  assert.throws(() => projectAssembledEventTotals({...source, complete: false}), /complete/);
});

test('explicit captured-native Rolling source safely merges 269 totals while signature-less Worker source still blocks', () => {
  const normal = capturedRolling(), serverTotals = assembledTotals();
  assert.throws(() => projectNativeEventTotals({serverTotals, rollingNormalBoard: normal}), /incomplete/);
  const capturedRollingBoard = deriveCapturedNativeRollingHills({board: normal, expectedSourceHash: nativeEventSourceHash(normal)});
  const args = {serverTotals, capturedRollingBoard};
  const first = projectNativeEventTotals(args), second = projectNativeEventTotals(args);
  assert.equal(first.totals.entries.length, 269);
  assert.equal(first.totals.entries.find(value => value.accountId === accountId).rp, 1011);
  assert.equal(Object.hasOwn(first.totals, 'paginatedSource'), false);
  assert.equal(first.totals.nativeEventOverlay.rollingSource.kind, 'captured-native-content-v1');
  assert.deepEqual(first.totals, second.totals);
  assert.throws(() => projectNativeEventTotals({serverTotals, capturedRollingBoard: structuredClone(capturedRollingBoard)}), /Pinned/);
  assert.throws(() => projectNativeEventTotals({...args, rollingNormalBoard: rolling()}), /Choose one/);
});

test('captured-native Rolling golden ERP/ranks/dates match Worker math with a valid 31-minute normal finish excluded only from ERP', () => {
  const rh = PERMANENT_ROLLING_HILLS.trackId, template = rolling().entries[0];
  const entries = [template,
    {...template, accountId: sha('tie'), timeMs: 1000, frames: 1000},
    {...template, accountId: sha('third'), timeMs: 1500, frames: 1500, pbAt: 1500},
    {...template, accountId: sha('31-minute-normal'), timeMs: 1860000, frames: 1860000},
    {...template, accountId: sha('unverified-fast'), timeMs: 500, frames: 500, runVerified: false},
    {...template, accountId: sha('held-fast'), timeMs: 700, frames: 700, runVerified: false, reviewHold: true}];
  const normal = capturedRolling({entries, totalEntries: entries.length});
  const expected = derivePermanentRollingHills({...normal, signature: 'worker-golden-fixture-123', builtAt: 3000});
  const actual = deriveCapturedNativeRollingHills({board: normal, expectedSourceHash: nativeEventSourceHash(normal)});
  assert.deepEqual(actual.entries, expected.entries);
  assert.equal(actual.targetMs, expected.targetMs);
  assert.deepEqual(actual.entries.map(value => value.rank), [1, 1, 3]);
  assert.equal(actual.entries.find(value => value.timeMs === 1500).rp, 667);
  assert.equal(normal.entries.find(value => value.timeMs === 1860000).runVerified, true, 'normal verification is unchanged');
  assert.equal(actual.sourceTotalEntries, 6); assert.equal(actual.totalEntries, 3); assert.equal(actual.trackId, rh);
  for (const field of ['signature', 'sourceSignature', 'builtAt']) assert.equal(Object.hasOwn(actual, field), false, field);
  assert.equal(actual.capturedNativeSource.kind, 'captured-native-content-v1');
  assert.equal(actual.sourceCompleteness, 'captured-native-complete');
});

test('captured-native provenance keeps real source/proof clocks without inventing Worker build metadata', () => {
  const normal = capturedRolling(); normal.entries[0].verifiedAt = 5000;
  const result = deriveCapturedNativeRollingHills({board: normal, expectedSourceHash: nativeEventSourceHash(normal)});
  assert.equal(result.updatedAt, 5000); assert.equal(result.entries[0].runAgeMs, 4000);
  assert.equal(result.capturedNativeSource.sourceUpdatedAt, 3000);
  assert.equal(Object.hasOwn(result.capturedNativeSource, 'sourceBuiltAt'), false);
  const withBuild = {...normal, builtAt: 2000};
  assert.equal(deriveCapturedNativeRollingHills({board: withBuild, expectedSourceHash: nativeEventSourceHash(withBuild)}).capturedNativeSource.sourceBuiltAt, 2000);
  const held = {...normal, entries: [{...normal.entries[0], needsReview: true}]};
  assert.throws(() => deriveCapturedNativeRollingHills({board: held, expectedSourceHash: nativeEventSourceHash(held)}), /No captured-native/);
});

test('captured-native Rolling rejects missing/untrusted pins, incomplete coverage, duplicate accounts and no ERP-eligible finishes', () => {
  const normal = capturedRolling();
  assert.throws(() => deriveCapturedNativeRollingHills({board: normal}), /Trusted/);
  assert.throws(() => deriveCapturedNativeRollingHills({board: normal, expectedSourceHash: sha('wrong')}), /hash mismatch/);
  for (const change of [{complete: false}, {totalEntries: 2}, {sourceComplete: false}, {ranksExact: false},
    {totalEntriesExact: false}, {trackId: sha('wrong')}, {sourceRevision: 9}, {updatedAt: 0}, {schemaVersion: 5}]) {
    const board = {...normal, ...change};
    assert.throws(() => deriveCapturedNativeRollingHills({board, expectedSourceHash: nativeEventSourceHash(board)}));
  }
  const duplicate = {...normal, entries: [normal.entries[0], normal.entries[0]], totalEntries: 2};
  assert.throws(() => deriveCapturedNativeRollingHills({board: duplicate, expectedSourceHash: nativeEventSourceHash(duplicate)}), /Duplicate/);
  const slow = {...normal, entries: [{...normal.entries[0], timeMs: 1860000, frames: 1860000}]};
  assert.throws(() => deriveCapturedNativeRollingHills({board: slow, expectedSourceHash: nativeEventSourceHash(slow)}), /No captured-native/);
});
