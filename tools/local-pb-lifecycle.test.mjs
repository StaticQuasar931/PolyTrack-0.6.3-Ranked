import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {localPbSignature, canonicalPbMatches, localPbIsConfirmed, pendingLocalPbs, persistLocalPb, prepareOwnLocalPbPlayback} from './local-pb-lifecycle.mjs';
import {renderPracticeProfile} from './practice-profile.mjs';
import {preparePublicRecordingPlayback} from './public-replay-playback.mjs';

const recording = deflateSync(Buffer.alloc(15)).toString('base64url');
const digest = value => createHash('sha256').update(value).digest('hex');
const row = (extra = {}) => ({accountId: 'a'.repeat(64), trackId: 'b'.repeat(64), timeMs: 1000,
  frames: 100, uploadId: 7, replay: recording, replayHash: digest(recording), carStyle: 'style', ...extra});
function store(initial = []) {
  let raw = JSON.stringify(initial), writes = 0;
  return {readRows: () => JSON.parse(raw), writeRows: rows => {writes++; raw = JSON.stringify(rows); return true;},
    raw: () => raw, writes: () => writes};
}
const confirmed = value => ({[value.accountId]: {confirmed: {[value.trackId]: localPbSignature(value)}}});

test('existing PB rows are the durable outbox across reload, without a second storage key', () => {
  const s = store(), pb = row();
  assert.deepEqual(persistLocalPb(pb, s), {localSaved: true, row: pb, changed: true});
  const reopened = store(JSON.parse(s.raw()));
  assert.deepEqual(pendingLocalPbs(reopened.readRows(), pb.accountId), [pb]);
  assert.equal(persistLocalPb(pb, reopened).localSaved, true);
  assert.equal(reopened.writes(), 0, 'replayed enqueue is idempotent');
});

test('storage exceptions and false or undefined acknowledgements never claim a local save', () => {
  for (const writeRows of [() => false, () => undefined, () => {throw Error('quota');}]) {
    assert.equal(persistLocalPb(row(), {readRows: () => [], writeRows}).localSaved, false);
  }
  assert.equal(persistLocalPb(row(), {readRows: () => {throw Error('denied');}, writeRows: () => true}).localSaved, false);
});

test('a memory-only or overwritten write fails durable readback', () => {
  assert.equal(persistLocalPb(row(), {readRows: () => [], writeRows: () => true}).reason, 'storage-readback-failed');
});

test('actual production JSON writer acknowledgement integrates with the existing PB key', () => {
  const source = readFileSync(new URL('../polytrack_062_patch.js', import.meta.url), 'utf8');
  const start = source.indexOf('  function writeJsonStorage(key, value){');
  const end = source.indexOf('  function readOverallSnapshotCache(', start);
  assert.ok(start > 0 && end > start);
  const key = 'polytrack-0.6.2-local-race-results-v1', disk = new Map();
  let fail = false;
  const context = vm.createContext({JSON, Date, jsonStorageCache: new Map(), volatileLeaderboardCache: new Map(), hotSnapshotStorageKeys: new Set(),
    localStorage: {setItem(k, value) {if (fail) throw Error('quota'); disk.set(k, value);}}});
  vm.runInContext(source.slice(start, end), context);
  const adapters = {readRows: () => JSON.parse(disk.get(key) || '[]'), writeRows: rows => context.writeJsonStorage(key, rows)};
  assert.equal(persistLocalPb(row(), adapters).localSaved, true);
  fail = true;
  assert.equal(persistLocalPb(row({timeMs: 900}), adapters).localSaved, false);
  assert.equal(adapters.readRows()[0].timeMs, 1000);
  assert.equal(context.volatileLeaderboardCache.has(key), false);
});

test('capacity does not drop older pending rows or falsely acknowledge the incoming PB', () => {
  const older = row({accountId: 'c'.repeat(64)}), s = store([older]);
  assert.equal(persistLocalPb(row(), {...s, maxRows: 1}).reason, 'capacity');
  assert.deepEqual(s.readRows(), [older]);
  assert.equal(s.writes(), 0);
});

test('faster PB replaces only its account/track and preserves unrelated metadata', () => {
  const foreign = row({accountId: 'c'.repeat(64), privateLegacyField: {x: 1}});
  const s = store([row(), foreign]);
  assert.equal(persistLocalPb(row({timeMs: 900}), {...s, maxRows: 2}).localSaved, true);
  assert.deepEqual(s.readRows()[1], foreign);
  assert.equal(persistLocalPb(row({timeMs: 950}), s).reason, 'superseded');
  assert.equal(s.readRows()[0].timeMs, 900);
});

test('equal-time changed replay does not silently replace the saved best binding', () => {
  const s = store([row()]);
  assert.equal(persistLocalPb(row({replay: 'different', replayHash: digest('different')}), s).reason, 'superseded');
  assert.equal(s.writes(), 0);
});

test('missing inline recording can be repaired without changing PB history dates', () => {
  const pb = row({createdAt: 123, pbAt: 123}), s = store([{...pb, replay: ''}]);
  assert.equal(persistLocalPb(pb, s).localSaved, true);
  assert.equal(s.readRows()[0].pbAt, 123);
});

test('publication acceptance is not canonical confirmation and does not dequeue a PB', () => {
  const pb = row(), s = store([pb]);
  assert.equal(canonicalPbMatches(pb, {...pb, accepted: true}), false);
  assert.deepEqual(pendingLocalPbs(s.readRows(), pb.accountId, {accepted: true}), [pb]);
  assert.equal(canonicalPbMatches(pb, pb, {serverConfirmed: true}), true);
  assert.deepEqual(pendingLocalPbs(s.readRows(), pb.accountId, confirmed(pb)), []);
});

test('exact canonical confirmation rejects different account, track, time and equal-time replay', () => {
  const pb = row();
  for (const change of [{accountId: 'c'.repeat(64)}, {trackId: 'c'.repeat(64)}, {timeMs: 999}, {replayHash: digest('other')}]) {
    assert.equal(canonicalPbMatches(pb, {...pb, ...change}, {serverConfirmed: true}), false);
  }
  assert.equal(canonicalPbMatches(row({replayHash: ''}), row({replayHash: ''}), {serverConfirmed: true}), false);
});

test('old in-flight acknowledgement cannot remove a newer PB from the derived outbox', () => {
  const old = row(), next = row({timeMs: 900}), s = store([old]);
  persistLocalPb(next, s);
  assert.deepEqual(pendingLocalPbs(s.readRows(), next.accountId, confirmed(old)), [next]);
});

test('resume selects one best per track, isolates accounts and retains missing-replay work', () => {
  const pb = row(), faster = row({timeMs: 900, replay: ''});
  assert.deepEqual(pendingLocalPbs([pb, faster, row({accountId: 'other'})], pb.accountId), [faster]);
});

test('prototype names and inherited confirmation properties cannot acknowledge work', () => {
  const pb = row();
  assert.equal(localPbIsConfirmed(pb, Object.create(confirmed(pb))), false);
  assert.equal(localPbIsConfirmed(pb, {[pb.accountId]: {confirmed: Object.create({[pb.trackId]: localPbSignature(pb)})}}), false);
  for (const accountId of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(persistLocalPb(row({accountId}), store()).localSaved, false);
  }
});

const options = pb => ({accountId: pb.accountId, trackId: pb.trackId, recordingId: pb.uploadId, isSelf: true, explicitSelection: true});
const payload = pb => ({recording: pb.replay, frames: pb.frames, carStyle: pb.carStyle, verifiedState: 0});

test('manual own unverified local-only PB prepares without a public board or network', async () => {
  const pb = row({verified: false, verifiedState: 0});
  const prepared = await prepareOwnLocalPbPlayback(pb, payload(pb), options(pb));
  assert.equal(prepared.recording, pb.replay);
  assert.equal(prepared.verifiedState, 0);
  assert.equal(prepared.runVerified, false);
  assert.equal(prepared.integrityVerified, false);
  assert.equal(prepared.eventRpEligible, false);
  assert.equal(prepared._dataSource, 'own-local-pb-playback');
});

test('own local playback requires explicit manual self/account/track/recording binding', async () => {
  const pb = row();
  for (const change of [{isSelf: false}, {explicitSelection: false}, {accountId: 'other'}, {trackId: 'other'}, {recordingId: 8}]) {
    await assert.rejects(prepareOwnLocalPbPlayback(pb, payload(pb), {...options(pb), ...change}), /binding/);
  }
});

test('local playback rejects changed bytes, frames, style, hash and invalid recording structure', async () => {
  const pb = row();
  for (const change of [{recording: 'different'}, {frames: 101}, {carStyle: 'different'}]) {
    await assert.rejects(prepareOwnLocalPbPlayback(pb, {...payload(pb), ...change}, options(pb)), /binding/);
  }
  await assert.rejects(prepareOwnLocalPbPlayback({...pb, replayHash: digest('other')}, payload(pb), options(pb)), /hash/);
  const invalid = row({replay: 'bad', replayHash: digest('bad')});
  await assert.rejects(prepareOwnLocalPbPlayback(invalid, payload(invalid), options(invalid)));
});

test('public opponent playback still rejects an unverified local-only row', async () => {
  const pb = row({runVerified: false, integrityVerified: false, verified: false, verifiedState: 0});
  await assert.rejects(preparePublicRecordingPlayback({...payload(pb), ...pb}, pb, {allowPending: true}), /not eligible/);
});

test('explicit unconfirmed evidence never inherits an uploaded label from cloud provenance', () => {
  const render = result => renderPracticeProfile({rows: [{trackId: 'track', attempts: 1, finishes: 1}], results: [{trackId: 'track', timeMs: 1000, ...result}]});
  assert.doesNotMatch(render({source: 'cloud', cloudConfirmed: false}), /Submitted PB/);
  assert.match(render({source: 'cloud', cloudConfirmed: false}), /source not confirmed/);
  assert.match(render({localPending: true, cloudConfirmed: false}), /Local PB/);
  assert.match(render({localPending: true, cloudConfirmed: true}), /Submitted PB/);
});
