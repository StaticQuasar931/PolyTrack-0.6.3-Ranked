import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Socket} from 'node:net';
import {createLedgerEntry, ledgerBinding, ledgerKey, ledgerDisposition, mergeLedgerEntries, writeLedger, readLedger,
  applyLedgerToBoard, nativePolicyFingerprint, MAX_LEDGER_FILE_BYTES} from './native-verification-ledger.mjs';

globalThis.fetch = () => {throw Error('OFFLINE_LEDGER_TEST');};
Socket.prototype.connect = globalThis.fetch;
const sha = value => createHash('sha256').update(value).digest('hex');
const track = 'a'.repeat(64), engine = 'b'.repeat(64), fingerprint = 'c'.repeat(64), content = 'd'.repeat(64);
const geometry = {parts:20, spanX:100, spanZ:120};
const finalReviewAt = Date.now() - 60000;
const policy = {engineDigest:engine, compatibleEngines:[], verifierVersion:'polytrack-native-bounded-v1',
  verifierFingerprint:fingerprint, resourceProfiles:['standard'], reviewPolicyVersions:['review-v1'],
  trackContentHashes:{[track]:content}, trackGeometries:{[track]:{geometryPolicy:'default', trackGeometry:geometry}}};

test('stored-overlay policy receipts bind engine, geometry and review rules deterministically',()=>{
  const hash=nativePolicyFingerprint(policy);
  assert.match(hash,/^[a-f0-9]{64}$/);
  assert.equal(nativePolicyFingerprint(Object.fromEntries(Object.entries(policy).reverse())),hash);
  assert.equal(nativePolicyFingerprint({...policy,knownTrackIds:['discovery-only']}),hash);
  for(const changed of [{...policy,verifierFingerprint:'e'.repeat(64)},
    {...policy,reviewPolicyVersions:['review-v2']},
    {...policy,trackContentHashes:{[track]:'f'.repeat(64)}}])assert.notEqual(nativePolicyFingerprint(changed),hash);
});
function fixture({lane = 'normal', number = 1, disposition = 'approved', engineDigest = engine} = {}) {
  const replay = 'private-replay-' + number, accountId = sha('account-' + number);
  const job = {lane, accountId, trackId:track, timeMs:20000 + number, frames:20000 + number,
    uploadId:lane === 'event' ? null : number, replayHash:sha(replay), replay};
  if (lane === 'event') Object.assign(job, {periodId:'weekly-2026-10-30', runId:sha('run-' + number)});
  job.resultId = lane === 'event' ? job.runId : accountId + '_' + track;
  const binding = {verifierVersion:policy.verifierVersion, verifierFingerprint:fingerprint, resourceProfile:'standard',
    resultId:job.resultId, trackId:track, timeMs:job.timeMs, replayHash:job.replayHash,
    actualReplayHash:sha(replay), nativeTrackId:track, trackContentHash:content, engineDigest};
  const nativeResult = {resultId:job.resultId, trackId:track, timeMs:job.timeMs, replayHash:job.replayHash,
    status:'verified', reason:'native_exact_finish', deterministic:true, engineDigest,
    trackContentHash:content, trackGeometry:geometry, geometryPolicy:'default', binding,
    boundInputFingerprint:sha(JSON.stringify(binding))};
  const result = disposition === 'approved' ? structuredClone(nativeResult) : {...structuredClone(nativeResult),
    status:'unavailable', reason:disposition === 'held' ? 'similar_replay_pending_manual_review' : 'review_excluded'};
  const review = {complete:true, disposition, bindingKey:ledgerKey(ledgerBinding(job)),
    policyVersion:'review-v1', attestationHash:sha('review-' + disposition + number)};
  return {job, result, nativeResult, review, verifiedAt:finalReviewAt, lane, policy};
}
function temporary(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-ledger-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true})); return root;
}
function overlay(f, ledger, extra = {}) {
  const row = {...f.job, name:'Private Racer', integrityVerified:false, runVerified:false}; delete row.replay;
  const board = {trackId:track, ...(f.lane === 'event' ? {periodId:f.job.periodId} : {}), entries:[row]};
  return applyLedgerToBoard({board, ledger, canonicalRows:[f.job], recordings:[f.job], policy:f.policy, lane:f.lane, ...extra});
}

for (const lane of ['normal', 'event']) test(lane + ' exact native proof persists and applies without replay/name leakage', t => {
  const f = fixture({lane}), entry = createLedgerEntry(f), root = temporary(t);
  const ledger = writeLedger({root, entries:[entry], expectedManifestHash:null});
  assert.deepEqual(readLedger({root, expectedManifestHash:ledger.manifestHash}), ledger);
  const applied = overlay(f, ledger);
  assert.equal(applied.report.verified, 1); assert.equal(applied.board.entries[0].runVerified, true);
  assert.equal(applied.board.entries[0].verifiedState, 1);
  assert.equal(applied.board.entries[0].verificationStatus, 'verified');
  assert.equal(applied.board.entries[0].verifiedAt, finalReviewAt);
  assert.equal(entry.witnesses[0].verifiedAt, finalReviewAt);
  assert.equal(applied.board.entries[0].name, 'Private Racer'); assert.equal(applied.board.entries[0].nativeLedgerKey, entry.key);
  for (const name of fs.readdirSync(path.join(root, 'shards'))) {
    const data = fs.readFileSync(path.join(root, 'shards', name), 'utf8');
    assert(!data.includes(f.job.replay)); assert(!data.includes('Private Racer'));
    assert(!data.includes('credentials')); assert(Buffer.byteLength(data) <= MAX_LEDGER_FILE_BYTES);
  }
});

test('all source binding fields, including event identity, change the key', () => {
  const f = fixture({lane:'event'}), original = ledgerKey(ledgerBinding(f.job));
  for (const [field, value] of Object.entries({accountId:'f'.repeat(64), trackId:'e'.repeat(64), timeMs:21000,
    frames:21000, uploadId:2, replayHash:'f'.repeat(64), periodId:'other-week', runId:'e'.repeat(64)})) {
    assert.notEqual(ledgerKey(ledgerBinding({...f.job, [field]:value})), original, field);
  }
});

test('review completion must be an explicit attestation, not flags or cache presence', () => {
  for (const review of [undefined, {complete:false}, {...fixture().review, complete:false},
    {...fixture().review, cacheHit:true}, {...fixture().review, disposition:'pending'}]) {
    assert.throws(() => createLedgerEntry({...fixture(), review}));
  }
  assert.throws(() => createLedgerEntry({...fixture(), result:{status:'verified', cacheHit:true}}));
  assert.throws(() => createLedgerEntry({...fixture(), review:fixture({number:2}).review}), /review binding/);
  const f = fixture(); f.result.needsReview = true; assert.throws(() => createLedgerEntry(f));
});

test('rejects tampered native job, recording, deterministic witness, result and native track', () => {
  const changes = [f => {f.job.replay += 'changed';}, f => {f.nativeResult.deterministic = false;},
    f => {f.nativeResult.binding.nativeTrackId = 'f'.repeat(64);}, f => {f.nativeResult.timeMs++;},
    f => {f.result.timeMs++;}, f => {f.result.binding.actualReplayHash = 'f'.repeat(64);},
    f => {f.job.resultId = 'wrong';}, f => {f.nativeResult.boundInputFingerprint = 'f'.repeat(64);},
    f => {f.job.raceTimeFrames = 1;}, f => {f.nativeResult.geometryPolicy = 'rejected';},
    f => {f.nativeResult.trackGeometry = {...geometry, spanX:Infinity};}];
  for (const change of changes) {const f = fixture(); change(f); assert.throws(() => createLedgerEntry(f));}
});

test('engine compatibility is explicit, and does not imply fingerprint/geometry compatibility', t => {
  const old = 'e'.repeat(64), f = fixture({engineDigest:old});
  assert.throws(() => createLedgerEntry(f), /incompatible/);
  f.policy = {...policy, compatibleEngines:[old]};
  const ledger = writeLedger({root:temporary(t), entries:[createLedgerEntry(f)], expectedManifestHash:null});
  assert.equal(overlay(f, ledger).report.verified, 1);
  for (const changed of [{...policy}, {...f.policy, verifierFingerprint:'f'.repeat(64)},
    {...f.policy, trackContentHashes:{[track]:'f'.repeat(64)}}, {...f.policy, trackGeometries:{}}]) {
    assert.equal(overlay(f, ledger, {policy:changed}).report.verified, 0);
  }
});

for (const disposition of ['held', 'excluded']) test(disposition + ' is sticky across later approvals, engines and durable appends', t => {
  const approved = fixture(), held = fixture({disposition}), a = createLedgerEntry(approved), h = createLedgerEntry(held);
  assert.deepEqual(mergeLedgerEntries([a], [h]), mergeLedgerEntries([h], [a]));
  const root = temporary(t), first = writeLedger({root, entries:[h], expectedManifestHash:null});
  const second = writeLedger({root, entries:[a], expectedManifestHash:first.manifestHash});
  assert.equal(ledgerDisposition(second.entries[0]), disposition);
  const row = {...approved.job, runVerified:true, verified:true};
  const result = overlay(approved, second, {board:{trackId:track, entries:[row]}, policy:{...policy, engineDigest:'f'.repeat(64)}});
  assert.equal(result.report[disposition], 1); assert.equal(result.board.entries[0].runVerified, false);
  assert.equal(result.board.entries[0].verifiedState, 0);
  assert.equal(result.board.entries[0].verificationStatus, disposition);
  assert.equal(result.board.entries[0].verifiedAt, null);
});

test('final review timestamp is mandatory, positive and bounded by the actual clock', () => {
  for (const verifiedAt of [undefined, null, 0, -1, NaN, Infinity, '123', 1.5, Date.now() + 60000, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => createLedgerEntry({...fixture(), verifiedAt}), /final review timestamp/);
  }
  const f = fixture(); f.result.checkedAt = finalReviewAt - 50000; f.job.pbAt = finalReviewAt - 100000;
  assert.throws(() => createLedgerEntry({...f, verifiedAt:undefined}), /final review timestamp/);
  assert.equal(createLedgerEntry(f).witnesses[0].verifiedAt, finalReviewAt);
});

test('pending approvals use actual final review time, never PB/snapshot age or stale timestamp', t => {
  const f = fixture(), ledger = writeLedger({root:temporary(t), entries:[createLedgerEntry(f)], expectedManifestHash:null});
  const board = {trackId:track, updatedAt:finalReviewAt - 300000,
    entries:[{...f.job, verifiedState:0, verified:false, runVerified:false, verifiedAt:finalReviewAt - 10000, pbAt:1}]};
  const result = overlay(f, ledger, {board});
  assert.equal(result.board.entries[0].verifiedAt, finalReviewAt);
  assert.equal(result.board.entries[0].verifiedState, 1);
});

test('already verified rows preserve earliest valid public approval time', t => {
  const f = fixture(), a = createLedgerEntry(f), later = createLedgerEntry({...f, verifiedAt:finalReviewAt + 1000});
  const ledger = writeLedger({root:temporary(t), entries:[later, a], expectedManifestHash:null});
  for (const flag of [{verifiedState:1}, {verifiedState:'1'}, {runVerified:true}, {verified:true}]) {
    const before = finalReviewAt - 10000, board = {trackId:track, entries:[{...f.job, ...flag, verifiedAt:before}]};
    assert.equal(overlay(f, ledger, {board}).board.entries[0].verifiedAt, before);
  }
  for (const invalid of [0, null, NaN, Date.now() + 60000]) {
    const board = {trackId:track, entries:[{...f.job, verifiedState:1, verifiedAt:invalid}]};
    assert.equal(overlay(f, ledger, {board}).board.entries[0].verifiedAt, finalReviewAt);
  }
  const board = {trackId:track, entries:[{...f.job, verifiedState:1, verifiedAt:finalReviewAt + 10000}]};
  assert.equal(overlay(f, ledger, {board}).board.entries[0].verifiedAt, finalReviewAt);
});

test('normal source frames fall back to source time; missing board frames enrich from exact canonical', t => {
  const f = fixture(), withoutFrames = {...f.job}; delete withoutFrames.frames;
  assert.deepEqual(ledgerBinding(withoutFrames), ledgerBinding(f.job));
  f.job.frames = f.job.timeMs - 5;
  f.review.bindingKey = ledgerKey(ledgerBinding(f.job));
  const ledger = writeLedger({root:temporary(t), entries:[createLedgerEntry(f)], expectedManifestHash:null});
  const board = {trackId:track, entries:[withoutFrames]};
  const result = overlay(f, ledger, {board});
  assert.equal(result.report.verified, 1); assert.equal(result.board.entries[0].frames, f.job.frames);
  assert.equal(board.entries[0].frames, undefined);
  const explicitMismatch = {trackId:track, entries:[{...withoutFrames, frames:f.job.frames + 1}]};
  assert.equal(overlay(f, ledger, {board:explicitMismatch}).report.verified, 0);
  const event = fixture({lane:'event'}); delete event.job.frames;
  assert.throws(() => ledgerBinding(event.job), /timing/);
});

test('timestamp-less stored witnesses are rejected, not backfilled from other dates', t => {
  const root = temporary(t), entry = structuredClone(createLedgerEntry(fixture()));
  delete entry.witnesses[0].verifiedAt;
  assert.throws(() => writeLedger({root, entries:[entry], expectedManifestHash:null}), /schema fields/);
});

test('exact current canonical and recording required; stale sources cannot restore an old PB', t => {
  const f = fixture(), ledger = writeLedger({root:temporary(t), entries:[createLedgerEntry(f)], expectedManifestHash:null});
  for (const [field, value] of Object.entries({timeMs:19000, frames:19000, uploadId:3, replayHash:'f'.repeat(64)})) {
    assert.equal(overlay(f, ledger, {canonicalRows:[{...f.job, [field]:value}]}).report.verified, 0);
    assert.equal(overlay(f, ledger, {recordings:[{...f.job, [field]:value}]}).report.verified, 0);
  }
  assert.equal(overlay(f, ledger, {recordings:[{...f.job, replay:'bad'}]}).report.verified, 0);
  assert.equal(overlay(f, ledger, {canonicalRows:[]}).report.verified, 0);
  assert.throws(() => overlay(f, ledger, {canonicalRows:[f.job, {...f.job, uploadId:2}]}), /duplicate current/);
});

test('holds and exclusions in current source/recording/board block approval', t => {
  const f = fixture(), ledger = writeLedger({root:temporary(t), entries:[createLedgerEntry(f)], expectedManifestHash:null});
  for (const flag of [{needsReview:true}, {excluded:true}, {reviewHold:true}, {status:'rejected'},
    {verificationStatus:'unavailable_final'}, {reason:'review_excluded'}]) {
    assert.equal(overlay(f, ledger, {canonicalRows:[{...f.job, ...flag}]}).report.verified, 0);
    assert.equal(overlay(f, ledger, {recordings:[{...f.job, ...flag}]}).report.verified, 0);
    assert.equal(overlay(f, ledger, {board:{trackId:track, entries:[{...f.job, ...flag}]}}).report.verified, 0);
  }
});

test('event period/run mismatch never promotes and normal rows cannot impersonate events', t => {
  const f = fixture({lane:'event'}), ledger = writeLedger({root:temporary(t), entries:[createLedgerEntry(f)], expectedManifestHash:null});
  assert.equal(overlay(f, ledger, {canonicalRows:[{...f.job, periodId:'old-week'}]}).report.verified, 0);
  assert.equal(overlay(f, ledger, {recordings:[{...f.job, runId:'f'.repeat(64)}]}).report.verified, 0);
  assert.equal(overlay(f, ledger, {board:{periodId:'old-week', entries:[f.job]}}).report.verified, 0);
  assert.throws(() => ledgerBinding(f.job, 'normal'));
});

test('manifest CAS, writer lock, corruption and forged in-memory ledgers fail closed', t => {
  const root = temporary(t), f = fixture(), entry = createLedgerEntry(f);
  const ledger = writeLedger({root, entries:[entry], expectedManifestHash:null});
  assert.throws(() => writeLedger({root, entries:[], expectedManifestHash:null}));
  assert.throws(() => readLedger({root, expectedManifestHash:'f'.repeat(64)}), /manifest hash/);
  assert.throws(() => overlay(f, structuredClone(ledger)), /pinned readLedger/);
  fs.writeFileSync(path.join(root, '.writer.lock'), 'busy');
  assert.throws(() => writeLedger({root, entries:[], expectedManifestHash:ledger.manifestHash}), /EEXIST/);
  fs.unlinkSync(path.join(root, '.writer.lock'));
  const file = path.join(root, 'shards', fs.readdirSync(path.join(root, 'shards'))[0]);
  fs.appendFileSync(file, ' '); assert.throws(() => readLedger({root, expectedManifestHash:ledger.manifestHash}), /shard hash/);
});

test('shards are deterministic, content addressed and byte bounded regardless of input order', t => {
  const entries = Array.from({length:20}, (_, i) => createLedgerEntry(fixture({number:i + 1})));
  const root = temporary(t);
  const a = writeLedger({root, entries, expectedManifestHash:null, maxFileBytes:8192});
  const b = writeLedger({root:temporary(t), entries:[...entries].reverse(), expectedManifestHash:null, maxFileBytes:8192});
  assert.equal(a.manifestHash, b.manifestHash); assert.deepEqual(a.entries, b.entries);
  assert(Object.isFrozen(a.entries[0].witnesses[0].review));
  assert(fs.statSync(path.join(root, 'manifest.json')).size <= 8192);
  for (const name of fs.readdirSync(path.join(root, 'shards'))) {
    const file = fs.readFileSync(path.join(root, 'shards', name));
    assert(file.length <= 8192); assert.equal(name, sha(file) + '.json');
  }
});

test('manifest rename failure leaves acknowledged generation readable and releases lock', t => {
  const root = temporary(t), a = createLedgerEntry(fixture()), b = createLedgerEntry(fixture({number:2}));
  const first = writeLedger({root, entries:[a], expectedManifestHash:null});
  const rename = fs.renameSync;
  try {
    fs.renameSync = (from, to) => {
      if (path.basename(to) === 'manifest.json') throw Object.assign(Error('injected rename failure'), {code:'EIO'});
      return rename(from, to);
    };
    assert.throws(() => writeLedger({root, entries:[b], expectedManifestHash:first.manifestHash}), /injected/);
  } finally {fs.renameSync = rename;}
  assert.deepEqual(readLedger({root, expectedManifestHash:first.manifestHash}), first);
  assert(!fs.existsSync(path.join(root, '.writer.lock')));
  assert(!fs.readdirSync(root).some(name => name.startsWith('.manifest-')));
  const recovered = writeLedger({root, entries:[b], expectedManifestHash:first.manifestHash});
  assert.equal(recovered.entries.length, 2);
});

test('missing shards and forged manifest contents never yield a partial trusted ledger', t => {
  const root = temporary(t), f = fixture();
  const ledger = writeLedger({root, entries:[createLedgerEntry(f)], expectedManifestHash:null});
  const name = fs.readdirSync(path.join(root, 'shards'))[0];
  fs.unlinkSync(path.join(root, 'shards', name));
  assert.throws(() => readLedger({root, expectedManifestHash:ledger.manifestHash}));
  fs.writeFileSync(path.join(root, 'manifest.json'), '{}\n');
  assert.throws(() => readLedger({root, expectedManifestHash:ledger.manifestHash}), /manifest hash/);
});

test('empty first ledger is supported and idempotent appends retain identical manifest hash', t => {
  const root = temporary(t), empty = writeLedger({root, entries:[], expectedManifestHash:null});
  assert.equal(empty.entries.length, 0);
  const entry = createLedgerEntry(fixture());
  const first = writeLedger({root, entries:[entry], expectedManifestHash:empty.manifestHash});
  const second = writeLedger({root, entries:[entry], expectedManifestHash:first.manifestHash});
  assert.equal(first.manifestHash, second.manifestHash);
});

test('rejects arbitrary persisted metadata and oversized files; leaves prior manifest intact on failure', t => {
  const root = temporary(t), f = fixture(), entry = createLedgerEntry(f);
  assert.throws(() => writeLedger({root, entries:[{...entry, replay:'secret'}], expectedManifestHash:null}));
  const ledger = writeLedger({root, entries:[entry], expectedManifestHash:null});
  assert.throws(() => writeLedger({root, entries:[{...entry, name:'private'}], expectedManifestHash:ledger.manifestHash}));
  assert.deepEqual(readLedger({root, expectedManifestHash:ledger.manifestHash}), ledger);
  fs.writeFileSync(path.join(root, 'manifest.json'), Buffer.alloc(MAX_LEDGER_FILE_BYTES + 1));
  assert.throws(() => readLedger({root, expectedManifestHash:ledger.manifestHash}), /oversized/);
});

test('overlay does not mutate input, reorder rows, alter times, or invent ranks/RP', t => {
  const f = fixture(), ledger = writeLedger({root:temporary(t), entries:[createLedgerEntry(f)], expectedManifestHash:null});
  const board = {trackId:track, entries:[{...f.job, rank:5, rp:17, runVerified:false}]}, before = structuredClone(board);
  const result = overlay(f, ledger, {board}); assert.deepEqual(board, before);
  assert.equal(result.board.entries[0].rank, 5); assert.equal(result.board.entries[0].rp, 17);
  assert.equal(result.board.entries[0].timeMs, f.job.timeMs);
});
