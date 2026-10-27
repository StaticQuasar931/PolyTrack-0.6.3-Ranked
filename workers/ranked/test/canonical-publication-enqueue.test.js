import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {reconcileCanonicalChanges, computeTrackEntries, handleRequest, rebuildOverall} from '../src/index.js';
import {encode, decode} from '../../../tools/verifier/firestore.mjs';
import {verificationKey, verificationSchedule, pendingSlot, hasAcceptedVerifiedProof,
  verificationCollectionForTrack, PRE_REPLAY_UI_PROOF_ENGINE, VERIFIER_VERSION, VERIFIER_ENGINE_DIGEST} from '../src/verification.js';
import {EXTRA_TRACK_IDS} from '../src/extra-track-ids.js';

const track = '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const base = 'projects/polytrack-052/databases/(default)/documents/';
const jobPath = '0.6.2_s1_worker_jobs/canonical_reconcile_v2';
const row = (accountId = 'racer', trackId = track) => ({accountId, trackId, timeMs: 19000,
  frames: 19000, raceTimeFrames: 19000, uploadId: 2, replay: 'queue-regression',
  replayHash: createHash('sha256').update('queue-regression').digest('hex'), pbAt: 2000, ownerUid: 'owner'});
const proof = canonical => ({...pendingSlot(canonical), status: 'verified',
  engineDigest: VERIFIER_ENGINE_DIGEST, verifierVersion: VERIFIER_VERSION});

function fixture({rows = [row()], discovery = false, slot = proof, missingQueue = false, conflict = false} = {}) {
  const data = new Map(), calls = [], writes = [], requestedIds = [];
  const version = key => key + '-v1';
  const wire = (key, value) => ({name: base + key, fields: encode(value).mapValue.fields, updateTime: version(key)});
  const ids = rows.map(r => r.accountId + '_' + r.trackId);
  const groups = [...new Set(rows.map(r => r.trackId))];
  for (const trackId of groups) {
    const entries = computeTrackEntries(rows.filter(r => r.trackId === trackId).map(r => ({...r,
      timeMs: 20000, frames: 20000, raceTimeFrames: 20000, uploadId: 1})), trackId);
    data.set('0.6.2_s1_leaderboards_track/' + trackId, {trackId, entries, complete: true,
      totalEntries: entries.length, revision: 1, schemaVersion: 6, algorithmVersion: 'participation-v8-s1', signature: 'old'});
    if (!missingQueue) {
      const slots = Object.fromEntries(rows.filter(r => r.trackId === trackId).flatMap(r => {
        const value = slot(r); return value ? [[r.accountId, value]] : [];
      }));
      data.set(verificationCollectionForTrack(trackId) + '/' + trackId, {trackId, slots, ...verificationSchedule(slots), marker: 'preserve'});
    }
  }
  rows.forEach((r, i) => data.set('0.6.2_race_results/' + ids[i], r));
  data.set(jobPath, {backfillComplete: true, cursorIngestedAt: '2026-10-09T00:00:00Z',
    pendingTrackIds: discovery ? [] : groups,
    pendingResultIds: discovery ? {} : Object.fromEntries(groups.map(t => [t, ids.filter(id => id.endsWith('_' + t))]))});
  let discovered = false, scans = 0, failQueue = conflict;
  const env = {__TEST_FIRESTORE: async (path, init = {}) => {
    calls.push(path);
    if (path === ':runQuery') {
      const query = JSON.parse(init.body).structuredQuery;
      if (query.where?.fieldFilter?.field?.fieldPath === 'trackId') {scans++; throw Error('FORBIDDEN_FULL_SCAN');}
      if (discovery && !discovered) {
        discovered = true;
        return rows.map((r, i) => ({document: {...wire('0.6.2_race_results/' + ids[i], r),
          fields: {...encode(r).mapValue.fields, ingestedAt: {timestampValue: '2026-10-10T00:00:00Z'}}}}));
      }
      return [];
    }
    if (path === ':batchGet') return JSON.parse(init.body).documents.map(name => {
      const key = name.slice(base.length); requestedIds.push(name.split('/').at(-1));
      return data.has(key) ? {found: wire(key, data.get(key))} : {missing: name};
    });
    if (path === ':commit') {
      const batch = JSON.parse(init.body).writes;
      const queueWrites = batch.filter(w => /\/0\.6\.2_s1_(extra_)?verification\//.test(w.update.name));
      if (failQueue && queueWrites.length) throw Error('FIRESTORE_409');
      for (const write of batch) {
        const key = write.update.name.slice(base.length);
        assert.deepEqual(write.currentDocument, data.has(key) ? {updateTime: version(key)} : {exists: false});
        data.set(key, decode({mapValue: {fields: write.update.fields}}));
        writes.push(write);
      }
      return {};
    }
    const key = path.slice(1);
    return data.has(key) ? wire(key, data.get(key)) : null;
  }};
  return {env, data, calls, writes, ids, requestedIds, scans: () => scans, allowQueue: () => {failQueue = false;},
    queue: (t = track) => data.get(verificationCollectionForTrack(t) + '/' + t),
    queueWrites: () => writes.filter(w => /\/0\.6\.2_s1_(extra_)?verification\//.test(w.update.name))};
}

for (const [label, rows] of [
  ['standard 129-character IDs', [row('b'.repeat(64))]],
  ['maximum 209-character IDs', [row('b'.repeat(128), 't'.repeat(80))]],
  ['IDs differing only after character 128', [row('b'.repeat(64), 'a'.repeat(63) + '1'), row('b'.repeat(64), 'a'.repeat(63) + '2')]]
]) test('targeted publication preserves exact ' + label + ' without fallback scans', async () => {
  const f = fixture({rows});
  await reconcileCanonicalChanges(f.env, {scanResults: false});
  assert.deepEqual(f.requestedIds, f.ids);
  assert.equal(f.scans(), 0);
  assert.equal(f.queueWrites().length, 0);
  assert.deepEqual(f.data.get(jobPath).pendingTrackIds, []);
  for (const r of rows) assert.equal(f.data.get('0.6.2_s1_leaderboards_track/' + r.trackId).entries[0].runVerified, true);
});

for (const [label, options] of [
  ['missing queue', {missingQueue: true}],
  ['missing slot', {slot: () => null}],
  ['stale terminal proof', {slot: r => proof({...r, uploadId: 1})}],
  ['canonical_missing terminal result', {slot: r => ({...pendingSlot(r), status: 'unavailable', reason: 'canonical_missing', retryAt: Number.MAX_SAFE_INTEGER})}]
]) test('discovered PB with ' + label + ' is queued before pending IDs are cleared', async () => {
  const canonical = row('b'.repeat(64));
  const f = fixture({discovery: true, rows: [canonical], ...options});
  await reconcileCanonicalChanges(f.env);
  const queue = f.queue(), slot = queue.slots[canonical.accountId];
  assert.equal(slot.key, verificationKey(canonical));
  assert.equal(slot.status, 'waiting');
  assert.equal(slot.attempts, 0);
  assert.equal(queue.pending, true);
  assert.ok(queue.notBefore <= Date.now());
  assert.equal(f.queueWrites().length, 1);
  if (!options.missingQueue) assert.equal(queue.marker, 'preserve');
  assert.equal(f.calls.filter(p => p === '/0.6.2_s1_verification/' + track).length, 1);
  assert.equal(f.scans(), 0);
  assert.deepEqual(f.requestedIds, [], 'discovery already supplied exact canonical data');
  assert.deepEqual(f.data.get(jobPath).pendingResultIds, {});
});

for (const status of ['waiting', 'unavailable', 'verified', 'compatible']) test('matching ' + status + ' binding is preserved without queue writes', async () => {
  const canonical = row();
  let slot = {...pendingSlot(canonical, 123), status, attempts: 2, checkedAt: 456, retryAt: Date.now() + 86400000};
  if (status === 'verified' || status === 'compatible') {
    slot = {...slot, ...proof(canonical)};
    if (status === 'compatible') {
      const key = JSON.parse(slot.key); key[1] = PRE_REPLAY_UI_PROOF_ENGINE;
      slot = {...slot, key: JSON.stringify(key), engineDigest: PRE_REPLAY_UI_PROOF_ENGINE};
      assert.equal(hasAcceptedVerifiedProof(canonical, slot), true);
    }
  }
  const f = fixture({discovery: true, slot: () => slot});
  await reconcileCanonicalChanges(f.env);
  assert.deepEqual(f.queue().slots.racer, slot);
  assert.equal(f.queueWrites().length, 0);
  assert.equal(f.calls.filter(p => p === '/0.6.2_s1_verification/' + track).length, 1);
  assert.equal(f.scans(), 0);
});

test('queue conflict retains targeted work and a later pass enqueues without a historical scan', async () => {
  const f = fixture({discovery: true, slot: () => null, conflict: true});
  await reconcileCanonicalChanges(f.env);
  assert.deepEqual(f.data.get(jobPath).pendingResultIds[track], f.ids);
  assert.equal(f.data.get('0.6.2_s1_leaderboards_track/' + track).revision, 1);
  f.allowQueue();
  await reconcileCanonicalChanges(f.env, {scanResults: false});
  assert.equal(f.queue().slots.racer.status, 'waiting');
  assert.deepEqual(f.data.get(jobPath).pendingResultIds, {});
  assert.equal(f.scans(), 0);
});

test('new Extra PB uses the Extra queue, never a duplicate Core queue', async () => {
  const extra = [...EXTRA_TRACK_IDS][0];
  const f = fixture({discovery: true, rows: [row('b'.repeat(64), extra)], missingQueue: true});
  await reconcileCanonicalChanges(f.env);
  assert.equal(f.queue(extra).pending, true);
  assert.equal(f.data.has('0.6.2_s1_verification/' + extra), false);
  assert.equal(f.queueWrites().length, 1);
  assert.equal(f.scans(), 0);
});

test('targeted Extra recovery defers to existing migration rather than duplicating a legacy Core queue', async () => {
  const extra = [...EXTRA_TRACK_IDS][0], canonical = row('b'.repeat(64), extra);
  const f = fixture({discovery: true, rows: [canonical], missingQueue: true});
  const legacy = {trackId: extra, slots: {[canonical.accountId]: proof(canonical)}};
  f.data.set('0.6.2_s1_verification/' + extra, legacy);
  await reconcileCanonicalChanges(f.env);
  assert.equal(f.queue(extra), undefined);
  assert.deepEqual(f.data.get('0.6.2_s1_verification/' + extra), legacy);
  assert.deepEqual(f.data.get(jobPath).pendingResultIds[extra], f.ids);
  assert.equal(f.queueWrites().length, 0);
  assert.equal(f.scans(), 0);
});

test('repairing one binding preserves other retries and accepted compatible proofs in the same queue', async () => {
  const rows = [row('missed'), row('retry'), row('compatible')];
  const f = fixture({discovery: true, rows, slot: r => {
    if (r.accountId === 'missed') return null;
    if (r.accountId === 'retry') return {...pendingSlot(r, 123), status: 'unavailable', attempts: 2, retryAt: Date.now() + 86400000};
    const slot = proof(r), key = JSON.parse(slot.key); key[1] = PRE_REPLAY_UI_PROOF_ENGINE;
    return {...slot, key: JSON.stringify(key), engineDigest: PRE_REPLAY_UI_PROOF_ENGINE};
  }});
  const prior = structuredClone(f.queue());
  await reconcileCanonicalChanges(f.env);
  assert.deepEqual(f.queue().slots.retry, prior.slots.retry);
  assert.deepEqual(f.queue().slots.compatible, prior.slots.compatible);
  assert.equal(f.queue().slots.missed.status, 'waiting');
  assert.equal(f.queueWrites().length, 1);
  assert.equal(f.calls.filter(p => p === '/0.6.2_s1_verification/' + track).length, 1);
  assert.equal(f.scans(), 0);
});

test('existing owner notification narrowly requeues a stranded current PB after discovery cursor advanced', async () => {
  const canonical = row('b'.repeat(64));
  const f = fixture({rows: [canonical], slot: r => proof({...r, uploadId: 1})});
  f.data.set(jobPath, {backfillComplete: true, cursorIngestedAt: '2026-10-11T00:00:00Z', pendingTrackIds: [], pendingResultIds: {}});
  const board = f.data.get('0.6.2_s1_leaderboards_track/' + track);
  board.entries = computeTrackEntries([{...canonical, integrityVerified: true}], track);
  const response = await handleRequest(new Request('https://audit.invalid/v1/pb/notify', {method: 'POST',
    headers: {Origin: 'https://audit.invalid', 'Content-Type': 'application/json'}, body: JSON.stringify({resultId: f.ids[0]})}),
  {...f.env, ALLOWED_ORIGINS: 'https://audit.invalid', PB_NOTIFY_RATE_LIMITER: {limit: async () => ({success:true})}, __TEST_UID: 'owner'});
  assert.equal(response.status, 200);
  assert.equal(f.queue().slots[canonical.accountId].key, verificationKey(canonical));
  assert.equal(f.queue().pending, true);
  assert.equal(f.queueWrites().length, 1);
  assert.equal(f.calls.includes(':runQuery'), false);
  assert.equal(f.scans(), 0);
  assert.equal(f.data.get(jobPath).cursorIngestedAt, '2026-10-11T00:00:00Z');
});

test('shared batch reader rejects invalid exact IDs before batchGet, never redirects to another document', async () => {
  for (const accountId of ['bad/path', 'bad%2Fpath', '.', '..']) {
    const calls = [];
    const env = {__TEST_FIRESTORE: async (path, init = {}) => {
      calls.push(path);
      if (path === ':runQuery') {
        assert.equal(JSON.parse(init.body).structuredQuery.from[0].collectionId, '0.6.2_s1_leaderboards_track');
        return [{document: {name: base + '0.6.2_s1_leaderboards_track/' + track,
          updateTime: '2026-10-18T00:00:00Z',
          fields: encode({trackId: track, entries: [row(accountId), row('other')].map(r => ({...r,
            integrityVerified: true, runVerified: true}))}).mapValue.fields}}];
      }
      assert.notEqual(path, ':batchGet');
      assert.notEqual(path, ':commit');
      return null;
    }};
    await assert.rejects(rebuildOverall(env, true), /INVALID_DOCUMENT_ID/);
    assert.equal(calls.includes(':batchGet'), false);
  }
});


test('owner PB notification marks Overall dirty without launching a second aggregator',async()=>{
 const canonical=row('b'.repeat(64)),f=fixture({rows:[canonical]});
 const tasks=[];
 const response=await handleRequest(new Request('https://audit.invalid/v1/pb/notify',{method:'POST',
 headers:{Origin:'https://audit.invalid','Content-Type':'application/json'},body:JSON.stringify({resultId:f.ids[0]})}),
 {...f.env,ALLOWED_ORIGINS:'https://audit.invalid',PB_NOTIFY_RATE_LIMITER:{limit:async()=>({success:true})},__TEST_UID:'owner'},
 {waitUntil:task=>tasks.push(task)});
 assert.equal(response.status,200);const body=await response.json();assert.equal(body.changed,true);assert.equal(body.overallPending,true);
 assert.equal(f.data.get('0.6.2_s1_release_meta/current').dirty,true);
 assert.equal(tasks.length,0,'The existing cron, not every PB request, owns aggregation');
 assert.equal(f.calls.includes('/0.6.2_s1_leaderboards_overall/main'),false);
});
