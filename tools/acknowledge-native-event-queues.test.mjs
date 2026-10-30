import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Socket} from 'node:net';
import {createLedgerEntry, ledgerBinding, ledgerKey, writeLedger} from './native-verification-ledger.mjs';
import {acknowledgeNativeEventQueues, nativeEventAckReceiptHash, verifyPublishedNativeEventCommit,
  runNativeEventQueueAckCli} from './acknowledge-native-event-queues.mjs';

globalThis.fetch = () => {throw Error('OFFLINE_ACK_TEST');};
Socket.prototype.connect = globalThis.fetch;
const sha = value => createHash('sha256').update(value).digest('hex');
const sourceCommit = '1'.repeat(40), publishedCommit = '2'.repeat(40), track = 'a'.repeat(64);
const engine = 'b'.repeat(64), fingerprint = 'c'.repeat(64), content = 'd'.repeat(64);
const at = Date.now(), version = '2026-10-30T12:00:00.000000001Z';
const geometry = {parts:1, spanX:2, spanZ:3};
const policy = {engineDigest:engine, compatibleEngines:[], verifierVersion:'polytrack-native-bounded-v1',
  verifierFingerprint:fingerprint, resourceProfiles:['standard'], reviewPolicyVersions:['review-v1'],
  trackContentHashes:{[track]:content}, trackGeometries:{[track]:{geometryPolicy:'default', trackGeometry:geometry}}};
function decode(value) {
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('stringValue' in value) return value.stringValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('nullValue' in value) return null;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, entry]) => [key, decode(entry)]));
}
function fixture(t, {periods = 1, perPeriod = 2, disposition = 'approved'} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-ack-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const candidates = [], entries = [], queues = new Map(), calls = [];
  for (let p = 0; p < periods; p++) {
    const periodId = 'weekly-' + p, slots = []; let bytes = 0;
    for (let i = 0; i < perPeriod; i++) {
      const n = p * perPeriod + i, replay = 'QUJD' + String(n).padStart(4, '0');
      const job = {lane:'event', accountId:sha('account-' + n), trackId:track, periodId, runId:sha('run-' + n),
        timeMs:20000 + n, frames:20000 + n, uploadId:null, replayHash:sha(replay), replay};
      job.resultId = job.runId;
      const nativeBinding = {verifierVersion:policy.verifierVersion, verifierFingerprint:fingerprint, resourceProfile:'standard',
        resultId:job.resultId, trackId:track, timeMs:job.timeMs, replayHash:job.replayHash, actualReplayHash:job.replayHash,
        nativeTrackId:track, trackContentHash:content, engineDigest:engine};
      const nativeResult = {resultId:job.resultId, trackId:track, timeMs:job.timeMs, replayHash:job.replayHash,
        engineDigest:engine, trackContentHash:content, trackGeometry:geometry, geometryPolicy:'default',
        binding:nativeBinding, boundInputFingerprint:sha(JSON.stringify(nativeBinding)), deterministic:true,
        status:'verified', reason:'native_exact_finish'};
      const binding = ledgerBinding(job), key = ledgerKey(binding);
      const result = disposition === 'approved' ? nativeResult : {...nativeResult, status:'unavailable', reason:'review_hold'};
      entries.push(createLedgerEntry({job, nativeResult, result, verifiedAt:at - 1000, policy,
        review:{complete:true, disposition, bindingKey:key, policyVersion:'review-v1', attestationHash:sha('review-' + n)}}));
      candidates.push({binding, ledgerKey:key, sourceCollection:'0.6.2_event_runs', sourceStatus:'waiting', replay, replayLength:replay.length});
      slots.push({runId:job.runId, timeMs:job.timeMs, receivedAt:at - 5000, notBefore:at - 5000,
        attempts:0, lease:null, leaseUntil:0, previousTimeMs:null}); bytes += replay.length;
    }
    queues.set(periodId, {data:{slots, replayBytes:bytes, admitted:500, entrants:200,
      runIds:['lifetime-run'], subjects:['owner-hash'], retentionPages:5, nested:{retain:true}}, updateTime:version});
  }
  const ledger = writeLedger({root:path.join(root, 'verification-ledger'), entries, expectedManifestHash:null});
  fs.writeFileSync(path.join(root, 'verification-ledger-current.json'), JSON.stringify({schemaVersion:1,
    directory:'verification-ledger', manifestHash:ledger.manifestHash}));
  const receipt = {schemaVersion:1, kind:'native-event-queue-ack', sourceCommit, captureSha256:'e'.repeat(64),
    ledgerManifestHash:ledger.manifestHash, candidates};
  let getHook, commitHook;
  const db = {get:async (collection, id) => {calls.push({kind:'get', collection, id});
    if (getHook) await getHook(collection, id); return structuredClone(queues.get(id) || null);},
    call:async (endpoint, body) => {
      calls.push({kind:'commit', endpoint, body:structuredClone(body)});
      if (commitHook) {const result = await commitHook(endpoint, body); if (result !== undefined) return result;}
      assert.equal(endpoint, ':commit'); assert.equal(body.writes.length, 1);
      const w = body.writes[0], id = w.update.name.split('/').at(-1), current = queues.get(id);
      if (w.currentDocument.updateTime !== current.updateTime) throw Object.assign(Error('CAS'), {status:412});
      const updates = decode({mapValue:{fields:w.update.fields}});
      assert.deepEqual(Object.keys(updates).sort(), ['replayBytes', 'slots']);
      Object.assign(current.data, updates); current.updateTime = '2026-10-30T12:00:01.000000001Z';
      return {writeResults:[{updateTime:current.updateTime}], commitTime:current.updateTime};
    }};
  const publicationGate = async input => ({...input, published:true, acceptedResultsRetained:true,
    acceptedBestAdmissionCompatible:true, freshHoldFencesValidated:true});
  const options = () => ({root, receipt, expectedReceiptHash:nativeEventAckReceiptHash(receipt), publishedCommit,
    publicationGate, policy, db, now:() => at});
  return {root, receipt, queues, calls, options, getHook:value => {getHook = value;}, commitHook:value => {commitHook = value;}};
}

test('one exact CAS masked write per period removes approved slots and preserves lifetime/retention fields', async t => {
  const f = fixture(t, {periods:2}), before = structuredClone(f.queues);
  const result = await acknowledgeNativeEventQueues(f.options());
  assert.equal(result.counts.readAttempts, 2); assert.equal(result.counts.writeAttempts, 2);
  assert.equal(result.counts.removedRuns, 4); assert.equal(result.stopped, null);
  for (const [id, queue] of f.queues) {
    assert.deepEqual({...queue.data, slots:before.get(id).data.slots, replayBytes:before.get(id).data.replayBytes}, before.get(id).data);
    assert.equal(queue.data.replayBytes, 0); assert.equal(queue.data.slots.length, 0);
  }
  for (const call of f.calls.filter(call => call.kind === 'commit')) {
    assert.deepEqual(call.body.writes[0].updateMask.fieldPaths, ['slots', 'replayBytes']);
    assert.equal(call.body.writes[0].currentDocument.updateTime, version);
    assert(call.body.writes[0].update.name.includes('/0.6.2_event_queues/'));
  }
});

test('retry is idempotent and never sends an empty commit or subtracts bytes twice', async t => {
  const f = fixture(t); await acknowledgeNativeEventQueues(f.options()); f.calls.length = 0;
  const result = await acknowledgeNativeEventQueues(f.options());
  assert.equal(result.counts.removedRuns, 0); assert.equal(result.counts.writeAttempts, 0);
  assert.equal(f.calls.length, 1); assert.equal(f.queues.get('weekly-0').data.replayBytes, 0);
});

test('unknown/unpublished gate, wrong pin and unmet admission/retention prerequisites do not initialize DB', async t => {
  const f = fixture(t); let connects = 0;
  for (const publicationGate of [async () => true, async input => ({...input, published:false}),
    async input => ({...input, published:true, acceptedResultsRetained:true}),
    async input => ({...input, published:true, acceptedBestAdmissionCompatible:true}),
    async input => ({...input, published:true, acceptedResultsRetained:true, acceptedBestAdmissionCompatible:true})]) {
    await assert.rejects(acknowledgeNativeEventQueues({...f.options(), db:undefined,
      connectDb:async () => {connects++; return {};}, publicationGate}), /gate/);
  }
  await assert.rejects(acknowledgeNativeEventQueues({...f.options(), expectedReceiptHash:'f'.repeat(64)}));
  assert.equal(connects, 0); assert.equal(f.calls.length, 0);
});

test('private candidates must be exact raw-pending, ASCII/SHA/length-bound and duplicate-free', async t => {
  const f = fixture(t), baseline = structuredClone(f.receipt);
  const changes = [r => {r.candidates[0].replay += 'X';}, r => {r.candidates[0].replayLength++;},
    r => {r.candidates[0].sourceStatus = 'verified';}, r => {r.candidates[0].sourceCollection = 'client-cache';},
    r => {r.candidates[0].binding.frames--;}, r => {r.candidates.push(r.candidates[0]);},
    r => {r.candidates[0].replay = '\u00e9';}, r => {r.candidates[0].binding.periodId = '../other';}];
  for (const change of changes) {
    const receipt = structuredClone(baseline); change(receipt);
    await assert.rejects(acknowledgeNativeEventQueues({...f.options(), receipt, expectedReceiptHash:nativeEventAckReceiptHash(receipt)}));
  }
  assert.equal(f.calls.length, 0);
});

for (const disposition of ['held', 'excluded']) test(disposition + ' ledger proofs never authorize queue removal', async t => {
  const f = fixture(t, {disposition});
  const result = await acknowledgeNativeEventQueues(f.options());
  assert.equal(result.counts.approved, 0); assert.equal(f.calls.length, 0);
});

test('missing or incompatible ledger proof does not authorize queue removal', async t => {
  const f = fixture(t), options = f.options();
  const result = await acknowledgeNativeEventQueues({...options, policy:{...policy, verifierFingerprint:'f'.repeat(64)}});
  assert.equal(result.counts.approved, 0); assert.equal(f.calls.length, 0);
  f.receipt.candidates[0].binding.runId = 'f'.repeat(64);
  f.receipt.candidates[0].ledgerKey = ledgerKey(f.receipt.candidates[0].binding);
  f.receipt.candidates.pop();
  assert.equal((await acknowledgeNativeEventQueues(f.options())).counts.approved, 0);
});

test('active leases, mismatched slot times and unrelated newly admitted runs remain byte-for-byte intact', async t => {
  const f = fixture(t, {perPeriod:3}), queue = f.queues.get('weekly-0');
  queue.data.slots[0].leaseUntil = at + 10000; queue.data.slots[0].lease = 'active';
  queue.data.slots[1].timeMs++;
  const other = {runId:'f'.repeat(64), timeMs:123, lease:null, leaseUntil:0, futureField:{keep:true}};
  queue.data.slots.push(other); queue.data.replayBytes += 10;
  const before = structuredClone(queue.data), result = await acknowledgeNativeEventQueues(f.options());
  assert.equal(result.counts.removedRuns, 1);
  assert.deepEqual(queue.data.slots, [before.slots[0], before.slots[1], other]);
  assert.equal(queue.data.replayBytes, before.replayBytes - f.receipt.candidates[2].replayLength);
});

test('CAS conflict defers the period without retry, while another period can progress', async t => {
  const f = fixture(t, {periods:2}); let attempts = 0;
  f.commitHook(async () => {attempts++; if (attempts === 1) throw Object.assign(Error('conflict'), {status:412});});
  const result = await acknowledgeNativeEventQueues(f.options());
  assert.equal(result.periods[0].status, 'conflict_deferred'); assert.equal(result.periods[1].status, 'acknowledged');
  assert.equal(attempts, 2); assert.equal(result.counts.readAttempts, 2);
});

for (const stage of ['get', 'commit']) test('429 at ' + stage + ' stops the entire round immediately', async t => {
  const f = fixture(t, {periods:3});
  f[stage === 'get' ? 'getHook' : 'commitHook'](async () => {throw Object.assign(Error('quota'), {status:429});});
  const result = await acknowledgeNativeEventQueues(f.options());
  assert.equal(result.stopped, 'quota'); assert.equal(result.counts.readAttempts, 1);
  assert.equal(result.counts.writeAttempts, stage === 'get' ? 0 : 1); assert.equal(result.counts.removedRuns, 0);
});

test('commit timeout and malformed acknowledgement are unknown, never successes or retries', async t => {
  for (const response of [undefined, {}, {writeResults:[]}, {writeResults:[{updateTime:'bad'}]},
    {writeResults:[{updateTime:version}], commitTime:'bad'}]) {
    const f = fixture(t, {periods:2});
    f.commitHook(async () => {if (response === undefined) throw Error('timeout after possible commit'); return response;});
    const result = await acknowledgeNativeEventQueues(f.options());
    assert.equal(result.stopped, 'unknown_commit'); assert.equal(result.counts.readAttempts, 1);
    assert.equal(result.counts.writeAttempts, 1); assert.equal(result.counts.removedRuns, 0);
  }
});

test('inconsistent replay accounting and duplicate queue run IDs fail closed before commit', async t => {
  for (const mutate of [queue => {queue.replayBytes = 0;}, queue => {queue.slots.push(queue.slots[0]);}]) {
    const f = fixture(t); mutate(f.queues.get('weekly-0').data);
    const result = await acknowledgeNativeEventQueues(f.options());
    assert.equal(result.stopped, 'invalid_queue'); assert.equal(result.counts.writeAttempts, 0);
  }
});

test('four-period hard cap and smaller document budgets bound work without querying', async t => {
  const f = fixture(t, {periods:6}); const result = await acknowledgeNativeEventQueues(f.options());
  assert.equal(result.counts.readAttempts, 4); assert.equal(result.counts.writeAttempts, 4); assert.equal(result.periodsDeferred, 2);
  assert(f.calls.every(call => call.kind === 'commit' || call.collection === '0.6.2_event_queues'));
  const g = fixture(t, {periods:3}), bounded = await acknowledgeNativeEventQueues({...g.options(), writeLimit:1});
  assert.equal(bounded.counts.writeAttempts, 1); assert.equal(bounded.counts.readAttempts, 1);
  assert.equal(bounded.stopped, 'document_budget');
  await assert.rejects(acknowledgeNativeEventQueues({...g.options(), maxPeriods:5}));
  await assert.rejects(acknowledgeNativeEventQueues({...g.options(), readLimit:17}));
});

test('ledger pin mutation during publication gate stops before any connection', async t => {
  const f = fixture(t); let connects = 0;
  await assert.rejects(acknowledgeNativeEventQueues({...f.options(), db:undefined, connectDb:async () => {connects++;},
    publicationGate:async input => {fs.writeFileSync(path.join(f.root, 'verification-ledger-current.json'), JSON.stringify({
      schemaVersion:1, directory:'verification-ledger', manifestHash:'f'.repeat(64)}));
      return {...input, published:true, acceptedResultsRetained:true, acceptedBestAdmissionCompatible:true, freshHoldFencesValidated:true};}}), /changed/);
  assert.equal(connects, 0);
});

test('protected canonical default-branch publication must be exact remote tip and source parent', t => {
  const f = fixture(t), input = {root:f.root, sourceCommit, publishedCommit};
  const env = {GITHUB_REPOSITORY:'StaticQuasar931/PolyTrack-0.6.3-Ranked', GITHUB_REF_PROTECTED:'true',
    GITHUB_REF:'refs/heads/main', DEFAULT_BRANCH:'main', NATIVE_EVENT_QUEUE_ACK_APPROVED:'true',
    NATIVE_ACCEPTED_RESULTS_RETENTION_VALIDATED:'true', NATIVE_EVENT_ACCEPTED_BEST_ADMISSION_VALIDATED:'true',
    NATIVE_EVENT_FRESH_HOLD_FENCES_VALIDATED:'true'};
  const run = (_binary, args) => {
    const key = args.join(' ');
    if (key === 'rev-parse --show-toplevel') return f.root;
    if (key === 'remote get-url origin') return 'https://github.com/StaticQuasar931/PolyTrack-0.6.3-Ranked.git';
    if (key.startsWith('status ')) return '';
    if (key === 'rev-parse HEAD') return publishedCommit;
    if (key === 'rev-parse HEAD^') return sourceCommit;
    if (key.startsWith('ls-remote ')) return publishedCommit + '\trefs/heads/main\n';
    assert.fail(key);
  };
  assert.equal(verifyPublishedNativeEventCommit(input, {env, run}).published, true);
  for (const override of [{GITHUB_REF_PROTECTED:'false'}, {NATIVE_EVENT_QUEUE_ACK_APPROVED:'false'},
    {NATIVE_EVENT_ACCEPTED_BEST_ADMISSION_VALIDATED:'false'}, {NATIVE_EVENT_FRESH_HOLD_FENCES_VALIDATED:'false'},
    {GITHUB_REPOSITORY:'untrusted/fork'}]) {
    assert.throws(() => verifyPublishedNativeEventCommit(input, {env:{...env, ...override}, run}));
  }
  assert.throws(() => verifyPublishedNativeEventCommit(input, {env, run:(binary, args) =>
    args[0] === 'ls-remote' ? 'f'.repeat(40) + '\trefs/heads/main\n' : run(binary, args)}), /exact protected remote/);
});

test('CLI cannot execute implicitly or read credentials before publication approval', async () => {
  let connections = 0;
  await assert.rejects(runNativeEventQueueAckCli({argv:[], env:{}, connectDb:async () => {connections++;}}), /execute/);
  assert.equal(connections, 0);
});
