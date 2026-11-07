import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Socket} from 'node:net';
import {execFileSync} from 'node:child_process';
import {preparePublicationPages, loadPublicationEntries} from '../src/paged-publication.js';
import {migrateVerificationChunk, prepareShardedVerification, verificationShardId} from '../src/verification-shards.js';
import {pendingSlot, verificationKey, verificationSchedule, VERIFICATION_COLLECTION,
  VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION} from '../src/verification.js';
import {COMPETITIVE_REVIEW_REASON} from '../src/competitive-review.js';
import {eventEncode as encode, eventDecode as decode} from '../src/events-store.js';

// Read-only baseline comparison; never replace the shared working source.
const baseline = process.env.PB_INLINE_NOOP_BASELINE === '1';
const api = baseline ? await import('data:text/javascript,' + encodeURIComponent(execFileSync('git',
  ['show', 'f1d9ff030:workers/ranked/src/index.js'], {encoding:'utf8'})
  .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL('../src/' + path.slice(2), import.meta.url).href}'`)))
  : await import('../src/index.js');
const {computeTrackEntries, mergeCanonicalResultIntoTrack, updateTrackIdentity, handleRequest} = api;

globalThis.fetch = () => { throw Error('OFFLINE_PB_BINDING_TEST'); };
Socket.prototype.connect = globalThis.fetch;
const track = '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const base = 'projects/polytrack-052/databases/(default)/documents/';
const boardKey = '0.6.2_s1_leaderboards_track/' + track;
const metaKey = '0.6.2_s1_release_meta/current';
const queueKey = VERIFICATION_COLLECTION + '/' + track;
const hash = value => createHash('sha256').update(value).digest('hex');
const proof = row => ({...pendingSlot(row), status: 'verified',
  engineDigest: VERIFIER_ENGINE_DIGEST, verifierVersion: VERIFIER_VERSION});
const changedReplay = row => ({...row, replay: 'replacement-replay', replayHash: hash('replacement-replay')});

async function fixture(count = 99, {legacy = false, targetIndex = count - 1} = {}) {
  const data = new Map(), versions = new Map(), calls = [], commits = [];
  const counts = {reads: 0, writes: 0, queries: 0, writeCollections: {}};
  const rows = Array.from({length: count}, (_, i) => ({accountId: 'r' + String(i).padStart(4, '0'),
    ownerUid: 'owner', trackId: track, name: 'Racer ' + i, timeMs: 10000 + i,
    frames: 10000 + i, raceTimeFrames: 10000 + i, uploadId: 1, pbAt: 1000,
    replay: 'original-replay', replayHash: hash('original-replay'), integrityVerified: true}));
  const slots = Object.fromEntries(rows.map(row => [row.accountId, proof(row)]));
  const entries = computeTrackEntries(rows, track, {}, slots);
  const paged = count > 500 ? await preparePublicationPages('track', track, entries,
    {sourceRevision: 1, sourceComplete: true}) : null;
  for (const doc of paged?.documents || []) data.set(doc.collection + '/' + doc.id, doc.data);
  data.set(boardKey, {trackId: track, entries: entries.slice(0, 500), complete: count <= 500,
    sourceComplete: true, totalEntries: count, totalEntriesExact: true, revision: 1, sourceRevision: 1,
    schemaVersion: 6, algorithmVersion: 'participation-v8-s1', signature: 'fixture-current',
    ...(paged ? {pagination: paged.pagination} : {})});
  data.set(metaKey, {revision: 1, builtRevision: 1, dirty: false});
  data.set(queueKey, count > 500 ? {trackId: track, storageVersion: 2,
    slots: legacy ? Object.fromEntries(Object.entries(slots).slice(0, 452)) : {}, migrationComplete: !legacy}
    : {trackId: track, slots, ...verificationSchedule(slots)});
  if (count > 500) for (const row of rows) {
    if (legacy && data.get(queueKey).slots[row.accountId]) continue;
    const queueId = verificationShardId(track, row.accountId);
    data.set(VERIFICATION_COLLECTION + '/' + queueId,
      {trackId: track, queueId, storageVersion: 2, slots: {[row.accountId]: proof(row)}});
  }
  for (const row of rows) data.set('0.6.2_race_results/' + row.accountId + '_' + track, row);
  const wire = key => data.has(key) ? {name: base + key, fields: encode(data.get(key)).mapValue.fields,
    updateTime: 'v' + (versions.get(key) || 0)} : null;
  let conflictCollection = '', conflictInjected = false;
  const env = {__TEST_FIRESTORE: async (path, init = {}) => {
    calls.push(path);
    const body = init.body ? JSON.parse(init.body) : null;
    if (path === ':runQuery') { counts.queries++; throw Error('FULL_REBUILD_REQUESTED'); }
    if (path === ':batchGet') {
      counts.reads += body.documents.length;
      return body.documents.map(name => {
        const doc = wire(name.slice(base.length));
        return doc ? {found: doc} : {missing: name};
      });
    }
    if (path === ':commit') {
      const writes = body.writes;
      // Mutate the version before validating the WHOLE batch, never partially apply CAS failures.
      if (!conflictInjected && conflictCollection && writes.some(w => w.update.name.startsWith(base + conflictCollection + '/'))) {
        conflictInjected = true;
        const key = writes.find(w => w.update.name.startsWith(base + conflictCollection + '/')).update.name.slice(base.length);
        versions.set(key, (versions.get(key) || 0) + 1);
        if (key === boardKey) data.set(key, {...data.get(key), revision: 99});
      }
      for (const write of writes) {
        const key = write.update.name.slice(base.length), expected = data.has(key)
          ? {updateTime: 'v' + (versions.get(key) || 0)} : {exists: false};
        if (write.currentDocument && JSON.stringify(write.currentDocument) !== JSON.stringify(expected))
          throw Error('FIRESTORE_412');
      }
      for (const write of writes) {
        const key = write.update.name.slice(base.length), collection = key.split('/')[0];
        data.set(key, decode({mapValue: {fields: write.update.fields}}));
        versions.set(key, (versions.get(key) || 0) + 1);
        counts.writes++; counts.writeCollections[collection] = (counts.writeCollections[collection] || 0) + 1;
      }
      commits.push(writes);
      return {writeResults: writes.map(write => ({updateTime: 'v' + versions.get(write.update.name.slice(base.length))}))};
    }
    counts.reads++;
    return wire(decodeURIComponent(new URL('https://mock.invalid' + path).pathname.slice(1)));
  }};
  const target = rows[targetIndex];
  const targetQueueKey = count > 500 ? VERIFICATION_COLLECTION + '/' + verificationShardId(track, target.accountId) : queueKey;
  const readPublished = () => loadPublicationEntries(data.get(boardKey), 'track', track,
    async (collection, id) => data.has(collection + '/' + id) ? {data: data.get(collection + '/' + id)} : null);
  const merge = async (row, integrity = true) => {
    const id = row.accountId + '_' + track;
    data.set('0.6.2_race_results/' + id, row);
    // Same read scope as /v1/pb/notify: one canonical prefetch plus the real single merge.
    const document = await env.__TEST_FIRESTORE('/0.6.2_race_results/' + id);
    const canonical = decode({mapValue: {fields: document.fields}});
    assert.equal(canonical.ownerUid, 'owner');
    assert.equal(id, canonical.accountId + '_' + canonical.trackId);
    return mergeCanonicalResultIntoTrack(env, track, canonical, integrity);
  };
  return {data, counts, calls, commits, rows, entries, target, targetQueueKey, env, merge, readPublished,
    slot: () => data.get(targetQueueKey).slots[target.accountId],
    setSlot: slot => data.set(targetQueueKey, {...data.get(targetQueueKey), slots: {...data.get(targetQueueKey).slots, [target.accountId]: slot}}),
    conflict: collection => { conflictCollection = collection; }};
}

for (const count of [99, 1001]) {
  test(`single-merge hash repair preserves ${count} racers and costs ${count > 500 ? '16R/15W' : '4R/3W'} including canonical prefetch`, async () => {
    const f = await fixture(count), original = await f.readPublished();
    const beforeQueues = new Map([...f.data].filter(([key]) => key.startsWith(VERIFICATION_COLLECTION + '/') && key !== f.targetQueueKey)
      .map(([key, value]) => [key, structuredClone(value)]));
    const row = changedReplay(f.target), result = await f.merge(row);
    assert.equal(result.changed, true);
    assert.equal(f.counts.reads, count > 500 ? 16 : 4);
    assert.equal(f.counts.writes, count > 500 ? 15 : 3);
    assert.equal(f.counts.queries, 0);
    const entries = await f.readPublished(), repaired = entries.find(entry => entry.accountId === row.accountId);
    assert.equal(entries.length, count);
    assert.equal(repaired.replayHash, row.replayHash);
    assert.equal(repaired.runVerified, false, 'old replay proof cannot verify a new hash');
    assert.equal(repaired.integrityVerified, true);
    assert.equal(f.slot().status, 'waiting');
    assert.equal(f.slot().key, verificationKey(row));
    assert.deepEqual(entries.filter(entry => entry.accountId !== row.accountId), original.filter(entry => entry.accountId !== row.accountId));
    for (const [key, value] of beforeQueues) assert.deepEqual(f.data.get(key), value);
    assert.equal(f.data.get(metaKey).dirty, true);
  });

  for (const upgrade of [true, false]) test(`integrity ${upgrade ? 'upgrade' : 'downgrade'} repairs one binding on ${count} racers`, async () => {
    const f = await fixture(count);
    if (upgrade) {
      if (count > 500) {
        for (const [key, value] of f.data) if (key.startsWith('0.6.2_s1_public_pages/'))
          f.data.set(key, {...value, entries: value.entries.map(row => row.accountId === f.target.accountId
            ? {...row, integrityVerified: false, runVerified: false, verified: false, verifiedState: 0} : row)});
      } else f.data.get(boardKey).entries.at(-1).integrityVerified = false;
    }
    const result = await f.merge(f.target, upgrade);
    assert.equal(result.changed, true);
    assert.equal(f.counts.queries, 0);
    assert.equal(f.counts.reads, count > 500 ? 16 : 4);
    assert.equal(f.counts.writes, count > 500 ? 14 : 2, 'unchanged proof needs no queue write');
    const entry = (await f.readPublished()).find(row => row.accountId === f.target.accountId);
    assert.equal(entry.integrityVerified, upgrade);
    assert.equal(entry.runVerified, upgrade);
    assert.equal(entry.verifiedState, upgrade ? 1 : 0);
    assert.equal(f.slot().status, 'verified');
  });

  test(`matching review hold survives hash repair on ${count} racers`, async () => {
    const f = await fixture(count), row = changedReplay(f.target);
    const hold = {...pendingSlot(row), status: 'unavailable', reason: COMPETITIVE_REVIEW_REASON,
      retryAt: Number.MAX_SAFE_INTEGER, marker: 'preserve-review'};
    f.setSlot(hold);
    await f.merge(row);
    assert.deepEqual(f.slot(), hold);
    assert.equal((await f.readPublished()).find(entry => entry.accountId === row.accountId).runVerified, false);
    assert.equal(f.counts.writeCollections[VERIFICATION_COLLECTION] || 0, 0);
    assert.equal(f.counts.queries, 0);
  });

  test(`stale review binding is invalidated on ${count} racers`, async () => {
    const f = await fixture(count), row = changedReplay(f.target);
    f.setSlot({...pendingSlot(f.target), status: 'unavailable', reason: COMPETITIVE_REVIEW_REASON});
    await f.merge(row);
    assert.equal(f.slot().status, 'waiting');
    assert.equal(f.slot().key, verificationKey(row));
    assert.equal((await f.readPublished()).find(entry => entry.accountId === row.accountId).runVerified, false);
  });
}

test('newer published identity overlay survives a single binding repair', async () => {
  const f = await fixture(), overlay = {name: 'Current Name', nickname: 'Current Name', countryCode: 'CA',
    carId: 'current-car', carColors: 'blue', carStyle: 'current-style', profileCosmetics: {theme: 'crimson'},
    identityUpdatedAt: 2000, groupCode: '123456', groupCodeUpdatedAt: 2000};
  Object.assign(f.data.get(boardKey).entries.at(-1), overlay);
  await f.merge({...changedReplay(f.target), name: 'Old Name', nickname: 'Old Name', countryCode: 'US'});
  const entry = (await f.readPublished()).at(-1);
  for (const [key, value] of Object.entries(overlay)) assert.deepEqual(entry[key], value, key);
});

test('incomplete board still requests full reconstruction for a binding mismatch', async () => {
  const f = await fixture();
  f.data.get(boardKey).complete = false;
  await assert.rejects(f.merge(changedReplay(f.target)), /FULL_REBUILD_REQUESTED/);
  assert.equal(f.counts.queries, 1);
  assert.equal(f.counts.writes, 0);
});

for (const collection of [VERIFICATION_COLLECTION, '0.6.2_s1_leaderboards_track'])
  test('single repair fails closed on ' + collection + ' CAS conflict', async () => {
    const f = await fixture(1001), original = structuredClone(f.data.get(boardKey));
    const oldPages = new Map([...f.data].filter(([key]) => key.startsWith('0.6.2_s1_public_pages/'))
      .map(([key, value]) => [key, structuredClone(value)]));
    f.conflict(collection);
    await assert.rejects(f.merge(changedReplay(f.target)), /FIRESTORE_412/);
    assert.equal(f.counts.queries, 0);
    assert.deepEqual(f.data.get(boardKey).pagination, original.pagination);
    assert.equal(f.data.get(boardKey).revision, collection === VERIFICATION_COLLECTION ? 1 : 99);
    assert.equal(f.data.get(metaKey).revision, 1);
    for (const [key, value] of oldPages) assert.deepEqual(f.data.get(key), value, 'immutable old pages survive');
    if (collection === VERIFICATION_COLLECTION) assert.equal(f.counts.writes, 0);
  });

test('actual notify computes integrity downgrade without rebuilding or accepting the old proof', async () => {
  const f = await fixture(), id = f.target.accountId + '_' + track;
  f.data.set('0.6.2_race_results/' + id, {...f.target, replay: 'corrupt-replay'});
  const response = await handleRequest(new Request('https://example.test/v1/pb/notify', {method: 'POST',
    headers: {Origin: 'https://example.test', 'Content-Type': 'application/json'}, body: JSON.stringify({resultId: id})}),
  {...f.env, ALLOWED_ORIGINS: 'https://example.test', __TEST_UID: 'owner', PB_NOTIFY_RATE_LIMITER: {limit: async () => ({success: true})}});
  assert.equal(response.status, 200);
  assert.equal((await response.json()).integrityVerified, false);
  assert.equal((await f.readPublished()).at(-1).runVerified, false);
  assert.equal(f.counts.queries, 0);
});

test('selected migration on already-sharded touched account leaves unrelated legacy slots alone: 11R/10W', async () => {
  const f = await fixture(501, {legacy: true}), rootBefore = structuredClone(f.data.get(queueKey));
  await f.merge(changedReplay(f.target));
  assert.equal(f.counts.reads, 11);
  assert.equal(f.counts.writes, 10);
  assert.deepEqual(f.data.get(queueKey), rootBefore);
  assert.equal(f.counts.writeCollections[VERIFICATION_COLLECTION], 1);
});

test('selected touched legacy account moves atomically then invalidates its old proof: 12R/12W', async () => {
  const f = await fixture(501, {legacy: true, targetIndex: 0}), before = structuredClone(f.data.get(queueKey).slots);
  const row = changedReplay(f.target);
  await f.merge(row);
  assert.equal(f.counts.reads, 12);
  assert.equal(f.counts.writes, 12);
  delete before[row.accountId];
  assert.deepEqual(f.data.get(queueKey).slots, before);
  assert.equal(f.slot().key, verificationKey(row));
  assert.equal(f.slot().status, 'waiting');
  const moves = f.commits.find(batch => batch.some(write => write.update.name === base + queueKey));
  assert.equal(moves.length, 2);
  assert.deepEqual(moves.map(write => write.currentDocument), [{exists: false}, {updateTime: 'v0'}]);
  assert.equal(f.counts.queries, 0);
});

function migrationFixture({shard, conflict = false, missingCommitVersion = false} = {}) {
  const slots = Object.fromEntries(Array.from({length: 60}, (_, i) => ['a' + i, {key: 'legacy-' + i, status: 'verified'}]));
  const root = {id: track, updateTime: 'root-v1', data: {trackId: track, slots, storageVersion: 2}};
  const data = new Map([[queueKey, structuredClone(root.data)]]), reads = [], batches = [];
  if (shard) data.set(VERIFICATION_COLLECTION + '/' + verificationShardId(track, 'a59'), structuredClone(shard));
  const read = async (collection, id) => {
    reads.push(id); const value = data.get(collection + '/' + id);
    return value ? {data: structuredClone(value), updateTime: id === track ? 'root-v2' : 'shard-v2'} : null;
  };
  const commit = async writes => {
    batches.push(writes);
    assert.equal(writes.at(-1).id, track);
    assert.equal(writes.at(-1).prior, root);
    for (const write of writes.slice(0, -1)) assert.equal(write.prior, null);
    if (conflict) throw Error('FIRESTORE_412');
    for (const write of writes) data.set(write.collection + '/' + write.id, structuredClone(write.data));
    return missingCommitVersion ? {} : {writeResults: writes.map(() => ({updateTime: 'root-v2'}))};
  };
  return {root, data, reads, batches, read, commit, args: {trackId: track, collection: VERIFICATION_COLLECTION, root, read, commit}};
}

test('selector atomically moves only the touched legacy slot with root CAS and create-only shard', async () => {
  const f = migrationFixture(), before = structuredClone(f.root.data);
  const next = await migrateVerificationChunk({...f.args, accountIds: ['a59', 'a59']});
  assert.deepEqual(f.reads, [verificationShardId(track, 'a59')]);
  assert.equal(f.batches.length, 1); assert.equal(f.batches[0].length, 2);
  assert.equal(next.updateTime, 'root-v2');
  assert.equal(next.data.migrationComplete, false);
  assert.deepEqual(f.data.get(VERIFICATION_COLLECTION + '/' + verificationShardId(track, 'a59')).slots.a59, before.slots.a59);
  delete before.slots.a59;
  assert.deepEqual(next.data.slots, before.slots);
});

test('selector keeps existing newer shard binding and removes only selected root slot', async () => {
  const shard = {slots: {a59: {key: 'newer-binding', status: 'unavailable', marker: 'keep-newer'}}};
  const f = migrationFixture({shard});
  await migrateVerificationChunk({...f.args, accountIds: ['a59']});
  assert.equal(f.batches[0].length, 1);
  assert.deepEqual(f.data.get(VERIFICATION_COLLECTION + '/' + verificationShardId(track, 'a59')), shard);
  assert.equal(f.data.get(queueKey).slots.a59, undefined);
});

test('newer shard wins migration, then a wrong binding is requeued against its exact shard CAS', async () => {
  const shard = {slots: {a59: {key: 'newer-but-wrong-binding', status: 'verified'}}};
  const f = migrationFixture({shard});
  const root = await migrateVerificationChunk({...f.args, accountIds: ['a59']});
  assert.deepEqual(f.data.get(VERIFICATION_COLLECTION + '/' + verificationShardId(track, 'a59')), shard);
  const row = {accountId: 'a59', trackId: track, timeMs: 10000, frames: 10000,
    raceTimeFrames: 10000, uploadId: 2, replayHash: hash('current-replay')};
  const writes = [];
  const verdicts = await prepareShardedVerification({trackId: track, collection: VERIFICATION_COLLECTION,
    rows: [row], root, read: f.read, commit: async batch => {writes.push(...batch); return {};}});
  assert.equal(writes.length, 1);
  assert.equal(writes[0].prior.updateTime, 'shard-v2');
  assert.equal(verdicts.a59.status, 'waiting');
  assert.equal(verdicts.a59.key, verificationKey(row));
  assert.equal(root.data.slots.a59, undefined);
});

test('selector with no matching legacy slot performs zero reads/writes and retains exact root', async () => {
  for (const accountIds of [[], ['already-sharded']]) {
    const f = migrationFixture();
    assert.equal(await migrateVerificationChunk({...f.args, accountIds}), f.root);
    assert.equal(f.reads.length, 0); assert.equal(f.batches.length, 0);
  }
});

test('omitting selector retains the default 48-slot bulk migration', async () => {
  const f = migrationFixture(), next = await migrateVerificationChunk(f.args);
  assert.equal(f.reads.length, 48);
  assert.equal(f.batches[0].length, 49);
  assert.equal(Object.keys(next.data.slots).length, 12);
  assert.equal(next.data.slots.a59.key, 'legacy-59');
});

test('selected migration uses one bounded readMany and refreshes CAS when commit omits updateTime', async () => {
  const f = migrationFixture({missingCommitVersion: true}), batches = [];
  const next = await migrateVerificationChunk({...f.args, accountIds: ['a59'], readMany: async (collection, ids) => {
    assert.equal(collection, VERIFICATION_COLLECTION); batches.push(ids); return new Map();
  }});
  assert.deepEqual(batches, [[verificationShardId(track, 'a59')]]);
  assert.deepEqual(f.reads, [track]);
  assert.equal(next.updateTime, 'root-v2');
});

test('selected migration CAS failure cannot remove the legacy proof or create its shard', async () => {
  const f = migrationFixture({conflict: true}), original = structuredClone(f.data);
  await assert.rejects(migrateVerificationChunk({...f.args, accountIds: ['a59']}), /FIRESTORE_412/);
  assert.deepEqual(f.data, original);
});

test('invalid selector values reject before any I/O', async () => {
  for (const accountIds of [null, 'a1', ['bad/path'], [null], [1], Array(49).fill('a1')]) {
    const f = migrationFixture();
    await assert.rejects(migrateVerificationChunk({...f.args, accountIds}), /INVALID_VERIFICATION/);
    assert.equal(f.reads.length, 0); assert.equal(f.batches.length, 0);
  }
});

for(const count of [99,1001])test('old-engine exact-submission manual review survives notification on '+count+' racers',async()=>{
 const f=await fixture(count),hold={...pendingSlot(f.target),status:'unavailable',reason:COMPETITIVE_REVIEW_REASON,retryAt:Number.MAX_SAFE_INTEGER};
 const key=JSON.parse(hold.key);key[1]='a'.repeat(64);hold.key=JSON.stringify(key);f.setSlot(hold);
 await f.merge(f.target);assert.deepEqual(f.slot(),hold);assert.equal(f.counts.writes,0);
 assert.equal(f.counts.reads,count>500?15:3);assert.equal(f.calls.length,count>500?5:3);
});

test('1001-row PB repair uses nine requests for unchanged sixteen reads and fifteen writes',async()=>{
 const f=await fixture(1001);await f.merge(changedReplay(f.target));
 assert.equal(f.calls.length,9);assert.equal(f.counts.reads,16);assert.equal(f.counts.writes,15);
 assert.equal(f.calls.filter(path=>path.startsWith('/0.6.2_s1_public_pages/')).length,0);
});

test('1001-row identity repair uses five requests for unchanged thirteen reads and fourteen writes',async()=>{
 const f=await fixture(1001);await updateTrackIdentity(f.env,track,{accountId:f.target.accountId,name:'Updated Racer',identityUpdatedAt:2000});
 assert.equal(f.calls.length,5);assert.equal(f.counts.reads,13);assert.equal(f.counts.writes,14);
 assert.equal((await f.readPublished()).find(row=>row.accountId===f.target.accountId).name,'Updated Racer');
});

test('missing first page fails closed after one batch, with no proof or publication writes',async()=>{
 const f=await fixture(1001),prior=structuredClone(f.data.get(boardKey));
 const first=[...f.data.keys()].find(key=>key.startsWith('0.6.2_s1_public_pages/')&&key.endsWith('_0'));f.data.delete(first);
 await assert.rejects(f.merge(changedReplay(f.target)),/PUBLIC_PAGE_INCOMPLETE/);
 assert.equal(f.calls.length,3);assert.equal(f.counts.reads,13,'batch fetch pays all eleven page reads, even when the first is missing');
 assert.equal(f.counts.writes,0);assert.deepEqual(f.data.get(boardKey),prior);
});

for (const count of [99, 1001, 1136]) test('exact inline PB duplicates retain fresh proof checks: ' + count, async () => {
  const f = await fixture(count, {targetIndex:0}), before = structuredClone(f.data);
  const reads = count <= 500 ? 3 : baseline ? Math.ceil(count / 100) + 4 : 4;
  for (let i = 0; i < 10; i++) {
    const result = await f.merge(f.target);
    assert.equal(result.changed, false);
    assert.equal(result.revision, 1);
    if (count > 500 && !baseline) assert.equal(Object.hasOwn(result, 'entries'), false,
      'a prefix must never be returned as the complete field');
  }
  assert.equal(f.counts.reads, reads * 10);
  assert.equal(f.counts.writes, 0); assert.equal(f.counts.queries, 0);
  assert.deepEqual(f.data, before);
  assert.equal(f.calls.filter(path => path === '/' + queueKey).length, 10);
  console.log('PB_INLINE_NOOP_COST ' + JSON.stringify({baseline, population:count,
    notifications:10, reads:f.counts.reads, writes:f.counts.writes}));
});

for (const mode of ['stale-proof', 'canonical-missing', 'review-hold', 'old-engine-review'])
test('exact inline PB still maintains current proof state: ' + mode, async () => {
  const f = await fixture(1001, {targetIndex:0});
  let slot = mode.includes('review') ? {...pendingSlot(f.target), status:'unavailable',
    reason:COMPETITIVE_REVIEW_REASON, retryAt:Number.MAX_SAFE_INTEGER} : proof(f.target);
  if (mode === 'stale-proof') slot.key = 'obsolete';
  if (mode === 'canonical-missing') slot.reason = 'canonical_missing';
  if (mode === 'old-engine-review') {
    const key = JSON.parse(slot.key); key[1] = 'a'.repeat(64); slot.key = JSON.stringify(key);
  }
  f.setSlot(slot);
  const board = structuredClone(f.data.get(boardKey));
  assert.equal((await f.merge(f.target)).changed, false);
  assert.equal(f.counts.reads, baseline ? 15 : 4);
  assert.equal(f.counts.writes, mode.includes('review') ? 0 : 1);
  if (mode.includes('review')) assert.deepEqual(f.slot(), slot);
  else { assert.equal(f.slot().status, 'waiting'); assert.equal(f.slot().key, verificationKey(f.target)); }
  assert.deepEqual(f.data.get(boardKey), board, 'no proof or publication is promoted by this shortcut');
});

test('exact inline PB proof read and CAS failures propagate without publication changes', async () => {
  for (const mode of ['read', 'cas']) {
    const f = await fixture(1001, {targetIndex:0});
    f.setSlot({...proof(f.target), key:'obsolete'});
    const before = structuredClone(f.data);
    if (mode === 'cas') f.conflict(VERIFICATION_COLLECTION);
    else {
      const request = f.env.__TEST_FIRESTORE;
      f.env.__TEST_FIRESTORE = async (path, init) => {
        if (path === '/' + queueKey) throw Error('FIRESTORE_429');
        return request(path, init);
      };
    }
    await assert.rejects(f.merge(f.target), mode === 'cas' ? /FIRESTORE_412/ : /FIRESTORE_429/);
    assert.deepEqual(f.data, before); assert.equal(f.counts.writes, 0);
  }
});

for (const mode of ['outside-prefix', 'short-prefix', 'wrong-track', 'incomplete', 'schema', 'future-schema',
  'page-size', 'page-count', 'generation', 'total', 'signature', 'missing-update-time'])
test('uncertain or absent inline PB still hydrates full pages: ' + mode, async () => {
  const f = await fixture(1001, {targetIndex:mode === 'outside-prefix' ? 1000 : 0});
  const board = f.data.get(boardKey);
  if (mode === 'short-prefix') board.entries = board.entries.slice(0, 100);
  if (mode === 'wrong-track') board.trackId = 'other-track';
  if (mode === 'incomplete') board.sourceComplete = false;
  if (mode === 'schema') board.schemaVersion = 0;
  if (mode === 'future-schema') board.schemaVersion = 999;
  if (mode === 'page-size') board.pagination.pageSize = 99;
  if (mode === 'page-count') board.pagination.pageCount++;
  if (mode === 'generation') board.pagination.generation = 'bad';
  if (mode === 'total') board.totalEntries++;
  if (mode === 'signature') delete board.signature;
  if (mode === 'missing-update-time') {
    const request = f.env.__TEST_FIRESTORE;
    f.env.__TEST_FIRESTORE = async (path, init) => {
      const result = await request(path, init);
      if (path === '/' + boardKey) delete result.updateTime;
      return result;
    };
  }
  const first = [...f.data.keys()].find(key => key.startsWith('0.6.2_s1_public_pages/') && key.endsWith('_0'));
  f.data.delete(first);
  await assert.rejects(f.merge(f.target), /PUBLIC_PAGE_INCOMPLETE|PUBLIC_MANIFEST_INVALID|INVALID_PUBLIC_PAGE/);
  assert.equal(f.counts.writes, 0);
});

for (const mode of ['hash', 'integrity', 'faster', 'upload'])
test('changed inline PB binding still validates pages before changing anything: ' + mode, async () => {
  const f = await fixture(1001, {targetIndex:0});
  let row = {...f.target};
  if (mode === 'hash') row = changedReplay(row);
  if (mode === 'faster') Object.assign(row, {timeMs:9000, frames:9000, raceTimeFrames:9000});
  if (mode === 'upload') row.uploadId++;
  const first = [...f.data.keys()].find(key => key.startsWith('0.6.2_s1_public_pages/') && key.endsWith('_0'));
  f.data.delete(first);
  await assert.rejects(f.merge(row, mode !== 'integrity'), /PUBLIC_PAGE_INCOMPLETE/);
  assert.equal(f.counts.writes, 0); assert.equal(f.counts.reads, 13);
});

test('exact inline PB rereads the root on every notification, not cached authority', async () => {
  const f = await fixture(1001, {targetIndex:0});
  await f.merge(f.target);
  f.data.get(boardKey).entries[0].replayHash = 'b'.repeat(64);
  const first = [...f.data.keys()].find(key => key.startsWith('0.6.2_s1_public_pages/') && key.endsWith('_0'));
  f.data.delete(first);
  await assert.rejects(f.merge(f.target), /PUBLIC_PAGE_INCOMPLETE/);
  assert.equal(f.counts.writes, 0);
});

test('actual inline duplicate route retains owner, canonical-ID and limiter guards', async () => {
  for (const mode of ['valid', 'owner', 'id', 'limited']) {
    const f = await fixture(1001, {targetIndex:0}), id = f.target.accountId + '_' + track;
    if (mode === 'owner') f.data.get('0.6.2_race_results/' + id).ownerUid = 'another-owner';
    if (mode === 'id') f.data.get('0.6.2_race_results/' + id).accountId = 'another-account';
    const response = await handleRequest(new Request('https://example.test/v1/pb/notify', {method:'POST',
      headers:{Origin:'https://example.test', 'Content-Type':'application/json'}, body:JSON.stringify({resultId:id})}),
    {...f.env, ALLOWED_ORIGINS:'https://example.test', __TEST_UID:'owner',
      PB_NOTIFY_RATE_LIMITER:{limit:async () => ({success:mode !== 'limited'})}});
    assert.equal(response.status, mode === 'valid' ? 200 : mode === 'limited' ? 429 : 403);
    assert.equal(f.counts.reads, mode === 'valid' ? baseline ? 15 : 4 : mode === 'limited' ? 0 : 1);
    assert.equal(f.counts.writes, 0); assert.equal(f.counts.queries, 0);
  }
});
