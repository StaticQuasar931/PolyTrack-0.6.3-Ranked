import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Socket} from 'node:net';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {preparePublicationPages, PUBLIC_PAGE_COLLECTION, PUBLIC_MANIFEST_COLLECTION} from '../src/paged-publication.js';
import {verificationShardId} from '../src/verification-shards.js';
import {EXTRA_TRACK_IDS} from '../src/extra-track-ids.js';
import {PERMANENT_ROLLING_HILLS} from '../src/permanent-rolling-hills.js';
const quotaBaseline = process.env.WORKER_QUOTA_BASELINE === '1';
const workerApi = quotaBaseline ? await import('data:text/javascript,' + encodeURIComponent(execFileSync('git',
  ['show','376b05cc1:workers/ranked/src/index.js'], {encoding:'utf8'})
  .replace(/from '(\.\/[^']+)'/g, (_, path) => `from '${new URL('../src/' + path.slice(2), import.meta.url).href}'`)))
  : await import('../src/index.js');
const {default:worker,computeTrackEntries,handleRequest,reconcileCanonicalChanges,persistTrackSnapshot} = workerApi;
import {eventEncode as encode, eventDecode as decode} from '../src/events-store.js';
import {pendingSlot, verificationKey, verificationSchedule, VERIFICATION_COLLECTION,
  VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION, PRE_REPLAY_UI_PROOF_ENGINE, hasAcceptedVerifiedProof} from '../src/verification.js';
import {COMPETITIVE_REVIEW_REASON} from '../src/competitive-review.js';
import {sourceCatalogFromScan} from '../src/overall-source-cache.js';

globalThis.fetch = () => {throw Error('OFFLINE_COALESCED_PUBLICATION_TEST');};
Socket.prototype.connect = globalThis.fetch;

const track = '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const base = 'projects/polytrack-052/databases/(default)/documents/';
const jobKey = '0.6.2_s1_worker_jobs/canonical_reconcile_v2';
const boardKey = '0.6.2_s1_leaderboards_track/' + track;
const queueKey = VERIFICATION_COLLECTION + '/' + track;
const metaKey = '0.6.2_s1_release_meta/current';
const canonicalKey = row => '0.6.2_race_results/' + row.accountId + '_' + row.trackId;
const proof = row => ({...pendingSlot(row), status: 'verified',
  engineDigest: VERIFIER_ENGINE_DIGEST, verifierVersion: VERIFIER_VERSION});
const replay = 'coalesced-offline-replay';
const row = (accountId, timeMs, uploadId = 1) => ({accountId, ownerUid: 'owner', trackId: track,
  name: 'Racer ' + accountId[0], timeMs, frames: timeMs, raceTimeFrames: timeMs, uploadId, pbAt: 1000,
  replay, replayHash: createHash('sha256').update(replay).digest('hex'), integrityVerified: true});

function fixture({missingJob = false, trackId = track, population = 3} = {}) {
  const boardKey = '0.6.2_s1_leaderboards_track/' + trackId;
  const queueKey = VERIFICATION_COLLECTION + '/' + trackId;
  const rows = population === 3
    ? [row('b'.repeat(64), 20000), row('c'.repeat(64), 18000), row('d'.repeat(64), 17000)].map(r => ({...r,trackId}))
    : Array.from({length:population}, (_, i) => ({...row((i + 1).toString(16).padStart(64, '0'), 20000 + i),trackId}));
  const slots = Object.fromEntries(rows.map(r => [r.accountId, proof(r)]));
  const entries = computeTrackEntries(rows, trackId, {}, slots);
  const data = new Map(), versions = new Map(), commits = [], canonicalReads = [], tasks = [], documentReads = new Map();
  const noteRead = key => documentReads.set(key, (documentReads.get(key) || 0) + 1);
  data.set(boardKey, {trackId, entries, complete: true, sourceComplete: true,
    totalEntries: rows.length, totalEntriesExact: true, revision: 1, sourceRevision: 1,
    schemaVersion: 6, algorithmVersion: 'participation-v8-s1', signature: 'fixture-current'});
  data.set(queueKey, {trackId, slots, ...verificationSchedule(slots), marker: 'keep-queue'});
  data.set(metaKey, {revision: 1, builtRevision: 1, dirty: false});
  if (!missingJob) data.set(jobKey, {backfillComplete: true, schemaVersion: 2,
    cursorIngestedAt: '2026-10-28T00:00:00.000000000Z', cursorDocumentId: 'saved-cursor',
    backfillDocumentId: 'saved-backfill', pendingTrackIds: [], pendingFullRebuildTrackIds: [], pendingResultIds: {}});
  for (const r of rows) data.set(canonicalKey(r), r);
  const counts = {reads: 0, writes: 0, queries: 0, commitAttempts: 0};
  const wire = key => data.has(key) ? {name: base + key, fields: encode(data.get(key)).mapValue.fields,
    updateTime: 'v' + (versions.get(key) || 0)} : null;
  let beforeCommit = null, beforeRead = null;
  const env = {ALLOWED_ORIGINS: 'https://audit.invalid', __TEST_UID: 'owner', PB_PUBLICATION_MODE: 'coalesced',
    PB_NOTIFY_RATE_LIMITER: {limit: async () => ({success: true})},
    __TEST_FIRESTORE: async (path, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      if (path === ':runQuery') {counts.queries++; throw Error('FORBIDDEN_CANONICAL_QUERY');}
      if (path === ':batchGet') {
        counts.reads += body.documents.length;
        return body.documents.map(name => {
          const key = name.slice(base.length);
          noteRead(key);
          if (key.startsWith('0.6.2_race_results/')) canonicalReads.push(key);
          const document = wire(key); return document ? {found: document} : {missing: name};
        });
      }
      if (path === ':commit') {
        counts.commitAttempts++;
        const writes = body.writes;
        if (beforeCommit) await beforeCommit(writes);
        // Validate the whole CAS batch before applying any part of it.
        for (const write of writes) {
          const key = write.update.name.slice(base.length), expected = data.has(key)
            ? {updateTime: 'v' + (versions.get(key) || 0)} : {exists: false};
          if (!write.currentDocument) {
            assert.ok(key.startsWith(PUBLIC_PAGE_COLLECTION + '/') || key.startsWith(PUBLIC_MANIFEST_COLLECTION + '/'),
              'only immutable staged publication artifacts may omit CAS');
            continue;
          }
          if (JSON.stringify(write.currentDocument) !== JSON.stringify(expected)) throw Error('FIRESTORE_412');
        }
        for (const write of writes) {
          const key = write.update.name.slice(base.length);
          data.set(key, decode({mapValue: {fields: write.update.fields}}));
          versions.set(key, (versions.get(key) || 0) + 1); counts.writes++;
        }
        commits.push(writes);
        return {writeResults: writes.map(w => ({updateTime: 'v' + versions.get(w.update.name.slice(base.length))}))};
      }
      counts.reads++;
      const key = decodeURIComponent(new URL('https://mock.invalid' + path).pathname.slice(1));
      noteRead(key);
      if (beforeRead) await beforeRead(key);
      return wire(key);
    }};
  const notify = (r = rows[0], direct = false) => {
    const request = new Request('https://audit.invalid/v1/pb/notify', {method: 'POST',
      headers: {Origin: 'https://audit.invalid', 'Content-Type': 'application/json'},
      body: JSON.stringify({resultId: r.accountId + '_' + r.trackId})});
    const context = {waitUntil: task => tasks.push(task)};
    return direct ? handleRequest(request, env, context) : worker.fetch(request, env, context);
  };
  const reset = () => {for (const key of Object.keys(counts)) counts[key] = 0; commits.length = 0; canonicalReads.length = 0; documentReads.clear();};
  return {data, versions, counts, commits, rows, env, tasks, canonicalReads, documentReads, notify, reset,
    setCommitHook: fn => {beforeCommit = fn;}, setReadHook: fn => {beforeRead = fn;}};
}

async function quotaPagedFixture(population = 1136, verified = true) {
  const f = fixture({population}), slots = f.data.get(queueKey).slots;
  if (!verified) slots[f.rows[0].accountId] = pendingSlot(f.rows[0]);
  const entries = computeTrackEntries(f.rows,track,{},slots);
  await persistTrackSnapshot(f.env,track,entries,
    {data:f.data.get(boardKey),updateTime:'v0'});
  f.data.set(queueKey,{trackId:track,storageVersion:2,migrationComplete:true,slots:{}});
  for (const r of f.rows) {
    const queueId = verificationShardId(track,r.accountId);
    f.data.set(VERIFICATION_COLLECTION + '/' + queueId,
      {trackId:track,queueId,storageVersion:2,slots:{[r.accountId]:slots[r.accountId]}});
  }
  f.reset();
  return f;
}

for (const population of [501,1136]) for (const count of [1,16])
test('quota exact coalesced duplicate drain retains proofs without page fanout: '+population+'/'+count,async () => {
  const f = await quotaPagedFixture(population);
  for (const r of f.rows.slice(0,count)) assert.equal((await f.notify(r)).status,200);
  const before = structuredClone(f.data.get(boardKey)); f.reset();
  const result = await reconcileCanonicalChanges(f.env,{scanResults:false});
  assert.equal(result.pending,0); assert.equal(result.targeted,count);
  const pages = Math.ceil(population/100), expectedReads = 3 + 2*count + (quotaBaseline ? pages : 0);
  assert.equal(f.counts.reads,expectedReads); assert.equal(f.counts.writes,1);
  assert.equal(f.counts.queries,0); assert.deepEqual(f.data.get(boardKey),before);
  for (const r of f.rows.slice(0,count)) {
    assert.equal(f.documentReads.get(canonicalKey(r)),1);
    assert.equal(f.documentReads.get(VERIFICATION_COLLECTION+'/'+verificationShardId(track,r.accountId)),1);
  }
  assert.equal([...f.documentReads.keys()].filter(k=>k.startsWith(PUBLIC_PAGE_COLLECTION+'/')).length,quotaBaseline ? pages : 0);
  assert.deepEqual(f.data.get(jobKey).pendingResultBindings,{});
  console.log('QUOTA_DUPLICATE_DRAIN_COST '+JSON.stringify({baseline:quotaBaseline,population,count,...f.counts}));
  f.reset(); await reconcileCanonicalChanges(f.env,{scanResults:false});
  assert.equal(f.counts.reads,1); assert.equal(f.counts.writes,0);
});

for (const mode of ['promote','hold','stale-proof','binding','outside-prefix','identity','short-prefix'])
test('quota uncertain duplicate still hydrates and publishes current authority: '+mode,async () => {
  const f = await quotaPagedFixture(1136,mode!=='promote');
  const r = f.rows[mode==='outside-prefix'?1000:0], key=VERIFICATION_COLLECTION+'/'+verificationShardId(track,r.accountId);
  if(mode==='promote') f.data.get(key).slots[r.accountId]=proof(r);
  if(mode==='hold') f.data.get(key).slots[r.accountId]={...pendingSlot(r),status:'unavailable',reason:COMPETITIVE_REVIEW_REASON,retryAt:Number.MAX_SAFE_INTEGER};
  if(mode==='stale-proof') f.data.get(key).slots[r.accountId]={...proof(r),key:'stale'};
  if(mode==='binding') f.data.get(canonicalKey(r)).uploadId++;
  if(mode==='identity') f.data.get(canonicalKey(r)).name='Current Name';
  if(mode==='short-prefix') f.data.get(boardKey).entries=f.data.get(boardKey).entries.slice(0,100);
  await f.notify(r); f.reset();
  const result=await reconcileCanonicalChanges(f.env,{scanResults:false});
  assert.equal(result.pending,0);
  assert.equal([...f.documentReads.keys()].filter(k=>k.startsWith(PUBLIC_PAGE_COLLECTION+'/')).length,12);
  const entry=f.data.get(boardKey).entries.find(e=>e.accountId===r.accountId);
  if(mode==='promote') assert.equal(entry.runVerified,true);
  if(['hold','stale-proof','binding'].includes(mode)) assert.equal(entry.runVerified,false);
  if(mode==='identity') assert.equal(entry.name,'Current Name');
});

for (const mode of ['proof-read','proof-write','page-missing','queue-cas'])
test('quota duplicate drain failures retain work and do not falsely publish: '+mode,async () => {
  const f=await quotaPagedFixture(),r=f.rows[0],key=VERIFICATION_COLLECTION+'/'+verificationShardId(track,r.accountId);
  await f.notify(r);
  if(mode==='proof-write'||mode==='page-missing') f.data.get(key).slots[r.accountId]={...proof(r),key:'stale'};
  if(mode==='page-missing') f.data.delete([...f.data.keys()].find(k=>k.startsWith(PUBLIC_PAGE_COLLECTION+'/')));
  const oldBoard=structuredClone(f.data.get(boardKey)),oldQueue=structuredClone(f.data.get(key));
  if(mode==='proof-read') {
    const request=f.env.__TEST_FIRESTORE;
    f.env.__TEST_FIRESTORE=async(path,init)=>{
      if(path===':batchGet'&&JSON.parse(init.body).documents.some(name=>name===base+key))throw Error('FIRESTORE_429');
      return request(path,init);
    };
  }
  if(mode==='proof-write'||mode==='queue-cas') f.setCommitHook(writes=>{
    if(writes.some(w=>w.update.name===base+(mode==='proof-write'?key:jobKey)))throw Error('FIRESTORE_412');
  });
  f.reset();
  if(mode==='queue-cas')await assert.rejects(reconcileCanonicalChanges(f.env,{scanResults:false}),/FIRESTORE_412/);
  else await reconcileCanonicalChanges(f.env,{scanResults:false});
  assert.deepEqual(f.data.get(boardKey),oldBoard); assert.deepEqual(f.data.get(key),oldQueue);
  assert.deepEqual(f.data.get(jobKey).pendingResultIds[track],[r.accountId+'_'+track]);
});

for(const [family,trackId] of [['native','7eac4fee1111152cfba4d3737410264ca0f22c7f5a2211e79f0099589b8b48c0'],
  ['rolling',PERMANENT_ROLLING_HILLS.trackId],['extra',[...EXTRA_TRACK_IDS][0]]])
for(const submissions of [1,10])test('quota all-track mode entire pipeline: '+family+'/'+submissions,async()=>{
  const costs={};
  for(const mode of ['immediate','coalesced']){
    const f=fixture({trackId,population:29}); f.env.PB_PUBLICATION_MODE=mode;
    assert.equal(f.env.PB_COALESCED_TRACK_IDS_JSON,undefined,'unset scope means all tracks, not an empty scope');
    const oldQueue=VERIFICATION_COLLECTION+'/'+trackId;
    if(family==='extra'){
      f.data.set('0.6.2_s1_extra_verification/'+trackId,f.data.get(oldQueue));f.data.delete(oldQueue);
      f.data.set('0.6.2_s1_worker_jobs/extra_verification_queue_migration_v1',
        {complete:true,registry:[...EXTRA_TRACK_IDS].sort().join(',')});
    }
    let latest;
    for(let i=0;i<submissions;i++){
      latest={...f.rows[0],timeMs:10000-i,frames:10000-i,raceTimeFrames:10000-i,uploadId:2+i};
      f.data.set(canonicalKey(latest),latest);
      assert.equal((await f.notify(latest)).status,200);
    }
    if(mode==='coalesced')assert.equal((await reconcileCanonicalChanges(f.env,{scanResults:false})).pending,0);
    assert.equal(f.data.get('0.6.2_s1_leaderboards_track/'+trackId).entries[0].timeMs,latest.timeMs);
    const rolling=Number(family==='rolling'),extra=Number(family==='extra');
    costs[mode]={reads:f.counts.reads,writes:f.counts.writes};
    assert.deepEqual(costs[mode],mode==='immediate'
      ? {reads:(4+rolling+extra)*submissions,writes:(3+rolling)*submissions}
      : {reads:2*submissions+5+rolling,writes:submissions+4+rolling});
  }
  console.log('QUOTA_ALL_TRACK_COST '+JSON.stringify({family,submissions,costs}));
});

test('actual PB route costs first 2R/1W and duplicate 2R/0W, without immediate publication or background work', async () => {
  for (const missingJob of [false, true]) {
    const f = fixture({missingJob}), board = structuredClone(f.data.get(boardKey)), queue = structuredClone(f.data.get(queueKey));
    const first = await f.notify(); assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.accepted, true); assert.equal(body.changed, true); assert.equal(body.publicationPending, true);
    assert.equal(body.integrityVerified, true); assert.equal(body.overallPending, true);
    assert.deepEqual(f.counts, {reads: 2, writes: 1, queries: 0, commitAttempts: 1});
    assert.equal(f.commits[0][0].update.name, base + jobKey);
    assert.deepEqual(f.data.get(boardKey), board); assert.deepEqual(f.data.get(queueKey), queue);
    assert.equal(f.data.get(metaKey).dirty, false); assert.equal(f.tasks.length, 0);
    f.reset(); const duplicate = await f.notify(); assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).changed, false);
    assert.deepEqual(f.counts, {reads: 2, writes: 0, queries: 0, commitAttempts: 0});
    assert.deepEqual(f.data.get(queueKey), queue);
  }
});

test('drain reads latest canonical PB and coalesces two results into one track generation', async () => {
  const f = fixture(), cursor = structuredClone(f.data.get(jobKey));
  for (const r of f.rows.slice(0, 2)) assert.equal((await f.notify(r)).status, 200);
  const latest = row(f.rows[0].accountId, 14000, 2), second = row(f.rows[1].accountId, 15000, 2);
  f.data.set(canonicalKey(latest), latest); f.data.set(canonicalKey(second), second);
  // A newer binding for the same document must fence an in-flight drain.
  f.reset(); assert.equal((await (await f.notify(latest)).json()).changed, true);
  assert.equal(f.counts.writes, 1);
  const queued = f.data.get(jobKey);
  assert.deepEqual(queued.pendingResultIds[track], [latest, second].map(r => r.accountId + '_' + track));
  assert.equal(queued.pendingResultBindings[latest.accountId + '_' + track], verificationKey(latest));
  assert.equal(Object.hasOwn(queued, 'entries'), false, 'private markers are not a published board');
  f.reset(); const drained = await reconcileCanonicalChanges(f.env, {scanResults: false});
  assert.equal(drained.targeted, 2); assert.equal(drained.rebuilt, 1); assert.equal(drained.pending, 0);
  assert.deepEqual(f.canonicalReads, [canonicalKey(latest), canonicalKey(second)]);
  const board = f.data.get(boardKey);
  assert.equal(board.revision, 2); assert.equal(board.entries.length, 3);
  for (const r of [latest, second]) {
    const entry = board.entries.find(e => e.accountId === r.accountId);
    assert.equal(entry.timeMs, r.timeMs); assert.equal(entry.uploadId, 2);
    assert.equal(entry.runVerified, false, 'proof for the previous upload is not reused');
    assert.equal(f.data.get(queueKey).slots[r.accountId].key, verificationKey(r));
    assert.equal(f.data.get(queueKey).slots[r.accountId].status, 'waiting');
  }
  assert.equal(f.data.get(boardKey).entries.find(e => e.accountId === f.rows[2].accountId).runVerified, true);
  assert.equal(f.data.get(metaKey).dirty, true); assert.equal(f.counts.queries, 0);
  assert.equal(f.commits.flat().filter(w => w.update.name === base + boardKey).length, 1);
  for (const key of ['cursorIngestedAt', 'cursorDocumentId', 'backfillDocumentId', 'backfillComplete'])
    assert.deepEqual(f.data.get(jobKey)[key], cursor[key], key);
});

for (const hold of [false, true]) test('drain preserves ' + (hold ? 'competitive review hold' : 'matching accepted proof') + ' and unrelated bindings', async () => {
  const f = fixture(), target = f.rows[0];
  if (hold) f.data.get(queueKey).slots[target.accountId] = {...pendingSlot(target), status: 'unavailable',
    reason: COMPETITIVE_REVIEW_REASON, retryAt: Number.MAX_SAFE_INTEGER, marker: 'keep-hold'};
  const before = structuredClone(f.data.get(queueKey));
  assert.equal((await f.notify()).status, 200); f.reset();
  await reconcileCanonicalChanges(f.env, {scanResults: false});
  assert.deepEqual(f.data.get(queueKey), before);
  assert.equal(f.commits.flat().filter(w => w.update.name === base + queueKey).length, 0);
  assert.equal(f.data.get(boardKey).entries.find(e => e.accountId === target.accountId).runVerified, !hold);
});

test('route preserves unrelated active/full rebuild checkpoint, cursors and failure state', async () => {
  const f = fixture(), other = 'e'.repeat(64);
  const job = {...f.data.get(jobKey), pendingTrackIds: [other], pendingFullRebuildTrackIds: [other],
    activeFullRebuildTrackId: other, failedFullRebuilds: {[other]: {attempts: 2, retryAt: 9999999999999}}};
  f.data.set(jobKey, structuredClone(job));
  assert.equal((await f.notify()).status, 200);
  const after = f.data.get(jobKey);
  for (const key of Object.keys(job).filter(key => !['pendingTrackIds', 'pendingResultIds'].includes(key)))
    assert.deepEqual(after[key], job[key], key);
  assert.deepEqual(after.pendingTrackIds, [other, track]);
});

test('capacity and active rebuild produce 503, never a false accepted response', async () => {
  for (const patch of [
    {pendingTrackIds: [track], pendingResultIds: {[track]: Array.from({length: 200}, (_, i) => 'r' + i + '_' + track)}},
    {pendingTrackIds: [track], pendingFullRebuildTrackIds: [track], activeFullRebuildTrackId: track}
  ]) {
    const f = fixture(); f.data.set(jobKey, {...f.data.get(jobKey), ...patch});
    const before = structuredClone(f.data.get(jobKey));
    const response = await f.notify(); assert.equal(response.status, 503);
    assert.equal((await response.json()).accepted, undefined);
    assert.deepEqual(f.counts, {reads: 2, writes: 0, queries: 0, commitAttempts: 0});
    assert.deepEqual(f.data.get(jobKey), before);
  }
});

test('actual route retries only queue CAS conflicts, caps attempts and does not retry 429', async () => {
  for (const code of [409, 412, 429]) {
    const f = fixture(); f.setCommitHook(() => {throw Error('FIRESTORE_' + code);});
    const response = await f.notify(); assert.equal(response.status, 503);
    assert.equal((await response.json()).accepted, undefined);
    const tries = code === 429 ? 1 : 3;
    assert.deepEqual(f.counts, {reads: 1 + tries, writes: 0, queries: 0, commitAttempts: tries});
    assert.deepEqual(f.data.get(jobKey).pendingTrackIds, []);
  }
  const f = fixture(); let injected = false;
  f.setCommitHook(() => {
    if (injected) return; injected = true;
    f.data.set(jobKey, {...f.data.get(jobKey), cursorDocumentId: 'concurrent-cursor'});
    f.versions.set(jobKey, 1); throw Error('FIRESTORE_412');
  });
  assert.equal((await f.notify()).status, 200);
  assert.deepEqual(f.counts, {reads: 3, writes: 1, queries: 0, commitAttempts: 2});
  assert.equal(f.data.get(jobKey).cursorDocumentId, 'concurrent-cursor');
});

test('verification queue CAS failure leaves publication pending and preserves the original proof/board', async () => {
  const f = fixture(), latest = row(f.rows[0].accountId, 14000, 2);
  f.data.set(canonicalKey(latest), latest); await f.notify(latest);
  const before = structuredClone(f.data.get(boardKey)), queue = structuredClone(f.data.get(queueKey));
  let fail = true;
  f.setCommitHook(writes => {
    if (fail && writes.some(w => w.update.name === base + queueKey)) throw Error('FIRESTORE_412');
  });
  await reconcileCanonicalChanges(f.env, {scanResults: false});
  assert.deepEqual(f.data.get(boardKey), before); assert.deepEqual(f.data.get(queueKey), queue);
  assert.deepEqual(f.data.get(jobKey).pendingResultIds[track], [latest.accountId + '_' + track]);
  fail = false; await reconcileCanonicalChanges(f.env, {scanResults: false});
  assert.deepEqual(f.data.get(jobKey).pendingTrackIds, []);
  assert.equal(f.data.get(queueKey).slots[latest.accountId].key, verificationKey(latest));
});

test('concurrent different-result enqueue fences the drain checkpoint and preserves both results', async () => {
  const f = fixture(), first = row(f.rows[0].accountId, 14000, 2), second = row(f.rows[1].accountId, 15000, 2);
  f.data.set(canonicalKey(first), first); await f.notify(first);
  let injected = false;
  f.setReadHook(async key => {
    if (key !== boardKey || injected) return;
    injected = true; f.data.set(canonicalKey(second), second);
    assert.equal((await f.notify(second)).status, 200);
  });
  await assert.rejects(reconcileCanonicalChanges(f.env, {scanResults: false}), /FIRESTORE_412/);
  assert.deepEqual(f.data.get(jobKey).pendingResultIds[track], [first, second].map(r => r.accountId + '_' + track));
  f.setReadHook(null);
  await reconcileCanonicalChanges(f.env, {scanResults: false});
  assert.deepEqual(f.data.get(jobKey).pendingTrackIds, []);
  for (const r of [first, second]) assert.equal(f.data.get(boardKey).entries.find(e => e.accountId === r.accountId).timeMs, r.timeMs);
  assert.equal(f.counts.queries, 0);
});

for (const change of ['new-pb', 'replay-repair']) test(`same-result ${change} after drain fetch is fenced even with unchanged ingestedAt`, async () => {
  const f = fixture(), queued = {...row(f.rows[0].accountId, 16000, 2), ingestedAt: '2026-10-28T00:00:00Z'};
  const repairedReplay = 'repaired-offline-replay';
  const newer = change === 'new-pb' ? {...row(queued.accountId, 14000, 3), ingestedAt: queued.ingestedAt}
    : {...queued, replay: repairedReplay, replayHash: createHash('sha256').update(repairedReplay).digest('hex')};
  const resultId = queued.accountId + '_' + track;
  f.data.get(queueKey).slots[queued.accountId] = proof(queued);
  f.data.set(canonicalKey(queued), queued); await f.notify(queued);
  let injected = false;
  f.setReadHook(async key => {
    if (key !== boardKey || injected) return;
    injected = true; f.data.set(canonicalKey(newer), newer);
    f.versions.set(canonicalKey(newer), 1);
    const before = {...f.counts}, response = await f.notify(newer);
    assert.equal(response.status, 200); assert.equal((await response.json()).changed, true);
    assert.equal(f.counts.reads - before.reads, 2); assert.equal(f.counts.writes - before.writes, 1);
  });
  await assert.rejects(reconcileCanonicalChanges(f.env, {scanResults: false}), /FIRESTORE_412/);
  assert.deepEqual(f.data.get(jobKey).pendingResultIds[track], [resultId], 'failed checkpoint must retain the repair');
  assert.equal(f.data.get(jobKey).pendingResultBindings[resultId], verificationKey(newer));
  assert.equal(f.data.get(canonicalKey(newer)).ingestedAt, queued.ingestedAt);
  if (change === 'replay-repair') for (const key of ['timeMs', 'uploadId', 'frames', 'raceTimeFrames', 'pbAt'])
    assert.equal(newer[key], queued[key], key + ' unchanged');
  f.setReadHook(null); f.reset();
  await reconcileCanonicalChanges(f.env, {scanResults: false});
  const published = f.data.get(boardKey).entries.find(e => e.accountId === newer.accountId);
  assert.equal(published.timeMs, newer.timeMs); assert.equal(published.replayHash, newer.replayHash);
  assert.equal(published.runVerified, false, 'the old binding proof must not verify the repaired replay');
  assert.equal(f.data.get(queueKey).slots[newer.accountId].key, verificationKey(newer));
  assert.equal(f.data.get(queueKey).slots[newer.accountId].status, 'waiting');
  assert.deepEqual(f.canonicalReads, [canonicalKey(newer)]); assert.equal(f.documentReads.get(queueKey), 1);
  assert.deepEqual(f.data.get(jobKey).pendingTrackIds, []);
  assert.deepEqual(f.data.get(jobKey).pendingResultIds, {}); assert.equal(f.counts.queries, 0);
});

test('route read 429s stop immediately without any retry or publication ACK', async () => {
  for (const failingKey of [canonicalKey(row('b'.repeat(64), 20000)), jobKey]) {
    const f = fixture();
    f.setReadHook(key => {if (key === failingKey) throw Error('FIRESTORE_429');});
    const response = await f.notify(); assert.equal(response.status, 503);
    assert.equal((await response.json()).accepted, undefined);
    assert.deepEqual(f.counts, {reads: failingKey === jobKey ? 2 : 1, writes: 0, queries: 0, commitAttempts: 0});
  }
});

test('route ownership and unsafe canonical identities cannot enqueue or mutate prototypes', async () => {
  const f = fixture(); f.env.__TEST_UID = 'not-owner';
  assert.equal((await f.notify()).status, 403);
  assert.deepEqual(f.counts, {reads: 1, writes: 0, queries: 0, commitAttempts: 0});
  for (const unsafe of [row('__proto__', 20000), {...row('b'.repeat(64), 20000), trackId: 'constructor'}]) {
    const g = fixture(); g.data.set(canonicalKey(unsafe), unsafe);
    const before = structuredClone(g.data.get(jobKey));
    assert.equal((await g.notify(unsafe)).status, 503);
    assert.deepEqual(g.data.get(jobKey), before); assert.equal(g.counts.writes, 0);
  }
  assert.equal(Object.prototype.polluted, undefined);
});

test('board CAS failure retains pending publication after verification repair; next drain recovers', async () => {
  const f = fixture(), latest = row(f.rows[0].accountId, 14000, 2);
  f.data.set(canonicalKey(latest), latest); await f.notify(latest);
  const before = structuredClone(f.data.get(boardKey)); let fail = true;
  f.setCommitHook(writes => {if (fail && writes.some(w => w.update.name === base + boardKey)) throw Error('FIRESTORE_412');});
  await reconcileCanonicalChanges(f.env, {scanResults: false});
  assert.deepEqual(f.data.get(boardKey), before);
  assert.deepEqual(f.data.get(jobKey).pendingResultIds[track], [latest.accountId + '_' + track]);
  assert.equal(f.data.get(queueKey).slots[latest.accountId].key, verificationKey(latest));
  assert.equal(f.data.get(queueKey).slots[latest.accountId].status, 'waiting');
  fail = false; await reconcileCanonicalChanges(f.env, {scanResults: false});
  assert.equal(f.data.get(boardKey).entries[0].timeMs, 14000);
  assert.deepEqual(f.data.get(jobKey).pendingTrackIds, []);
});

for (const mode of ['verified', 'compatible-proof', 'review-hold', 'stale-proof'])
  test(`end-to-end ${mode} drain reads the proof queue once and preserves PB/proof dates`, async () => {
    const f = fixture(), at = Date.UTC(2026, 9, 29, 12);
    const updates = f.rows.slice(0, 2).map((r, i) => ({...row(r.accountId, 14000 + i * 1000, 2), pbAt: at + i}));
    const queuedAt = at - 5000, checkedAt = at - 1000;
    if (mode !== 'stale-proof') for (const r of updates)
      f.data.get(queueKey).slots[r.accountId] = {...proof(r), queuedAt, checkedAt};
    if (mode === 'compatible-proof') for (const r of updates) {
      const slot = f.data.get(queueKey).slots[r.accountId], key = JSON.parse(slot.key);
      key[1] = PRE_REPLAY_UI_PROOF_ENGINE;
      slot.key = JSON.stringify(key); slot.engineDigest = PRE_REPLAY_UI_PROOF_ENGINE;
      assert.equal(hasAcceptedVerifiedProof(r, slot), true, 'fixture uses an explicitly supported older engine');
    }
    if (mode === 'review-hold') f.data.get(queueKey).slots[updates[0].accountId] = {
      ...pendingSlot(updates[0], queuedAt), status: 'unavailable', reason: COMPETITIVE_REVIEW_REASON,
      checkedAt, retryAt: Number.MAX_SAFE_INTEGER, marker: 'preserve-review-dates'};
    const beforeQueue = structuredClone(f.data.get(queueKey));
    for (const r of updates) {
      f.data.set(canonicalKey(r), r);
      const first = await f.notify(r); assert.equal(first.status, 200);
      assert.equal((await first.json()).changed, true);
      const duplicate = await f.notify(r); assert.equal(duplicate.status, 200);
      assert.equal((await duplicate.json()).changed, false);
    }
    assert.equal(f.documentReads.get(queueKey) || 0, 0, 'notify never reads the proof queue');
    assert.deepEqual(f.data.get(queueKey), beforeQueue, 'enqueue never modifies proofs');
    f.reset();
    const result = await reconcileCanonicalChanges(f.env, {scanResults: false});
    assert.equal(result.targeted, 2); assert.equal(result.rebuilt, 1); assert.equal(result.pending, 0);
    assert.equal(f.documentReads.get(queueKey), 1, 'one proof-root read per touched unsharded track, not per PB');
    assert.equal(f.documentReads.get(jobKey), 1);
    assert.equal(f.documentReads.get(boardKey), 1);
    for (const r of updates) assert.equal(f.documentReads.get(canonicalKey(r)), 1);
    const writes = f.commits.flat(), queue = f.data.get(queueKey), board = f.data.get(boardKey);
    assert.equal(writes.filter(w => w.update.name === base + queueKey).length, mode === 'stale-proof' ? 1 : 0);
    assert.equal(writes.filter(w => w.update.name === base + boardKey).length, 1);
    assert.equal(board.revision, 2); assert.equal(board.entries.length, f.rows.length);
    for (const [i, r] of updates.entries()) {
      const published = board.entries.find(e => e.accountId === r.accountId);
      assert.equal(published.timeMs, r.timeMs); assert.equal(published.pbAt, r.pbAt);
      assert.equal(published.runVerified, mode !== 'stale-proof' && !(mode === 'review-hold' && i === 0));
      const slot = queue.slots[r.accountId];
      if (mode === 'stale-proof') {
        assert.equal(slot.status, 'waiting'); assert.equal(slot.key, verificationKey(r));
      } else {
        assert.deepEqual(slot, beforeQueue.slots[r.accountId]);
        assert.equal(slot.queuedAt, queuedAt); assert.equal(slot.checkedAt, checkedAt);
      }
    }
    assert.deepEqual(queue.slots[f.rows[2].accountId], beforeQueue.slots[f.rows[2].accountId]);
    assert.equal([...f.documentReads.keys()].some(key => key.startsWith('0.6.2_profiles_public/')), false);
    assert.equal(writes.some(w => w.update.name.startsWith(base + '0.6.2_profiles_public/')), false);
    assert.equal(f.counts.queries, 0); assert.equal(f.tasks.length, 0);
    assert.deepEqual(f.data.get(jobKey).pendingTrackIds, []);
    assert.deepEqual(f.data.get(jobKey).pendingResultIds, {});
  });

test('unset and legacy publication modes retain direct notification behavior without touching coalesced work', async () => {
  for (const mode of [undefined, 'immediate']) {
    const f = fixture(), target = {...row(f.rows[0].accountId, 14000, 2), pbAt: Date.UTC(2026, 9, 29, 12)};
    if (mode === undefined) delete f.env.PB_PUBLICATION_MODE;
    else f.env.PB_PUBLICATION_MODE = mode;
    f.data.set(canonicalKey(target), target);
    const job = structuredClone(f.data.get(jobKey));
    const response = await f.notify(target); assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.accepted, true); assert.equal(body.changed, true);
    assert.equal(body.publicationPending, undefined);
    assert.equal(f.data.get(boardKey).entries.find(e => e.accountId === target.accountId).timeMs, 14000);
    assert.deepEqual(f.data.get(jobKey), job);
    assert.equal(f.documentReads.get(jobKey) || 0, 0);
    assert.equal(f.commits.flat().some(w => w.update.name === base + jobKey), false);
    assert.equal(f.data.get(queueKey).slots[target.accountId].key, verificationKey(target));
    assert.equal(f.tasks.length, 0); assert.equal(f.counts.queries, 0);
  }
});

test('actual route cost before and after coalescing includes the deferred drain cost', async () => {
  const cases = [];
  for (const mode of ['immediate', 'coalesced']) for (const binding of ['matching-proof', 'stale-proof']) {
    const f = fixture(), latest = {...row(f.rows[0].accountId, 14000, 2), pbAt: Date.UTC(2026, 9, 29, 12)};
    f.env.PB_PUBLICATION_MODE = mode; f.data.set(canonicalKey(latest), latest);
    if (binding === 'matching-proof') f.data.get(queueKey).slots[latest.accountId] = proof(latest);
    const first = await f.notify(latest); assert.equal(first.status, 200);
    const firstBody = await first.json(), firstCost = {...f.counts};
    assert.equal(firstBody.changed, true);
    assert.deepEqual(firstCost, {reads: mode === 'coalesced' ? 2 : 4,
      writes: mode === 'coalesced' ? 1 : binding === 'matching-proof' ? 2 : 3,
      queries: 0, commitAttempts: mode === 'coalesced' ? 1 : binding === 'matching-proof' ? 1 : 2});
    f.reset();
    const duplicate = await f.notify(latest); assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).changed, false);
    const duplicateCost = {...f.counts};
    assert.deepEqual(duplicateCost, {reads: mode === 'coalesced' ? 2 : 3, writes: 0, queries: 0, commitAttempts: 0});
    let drainCost = null;
    if (mode === 'coalesced') {
      f.reset();
      const drain = await reconcileCanonicalChanges(f.env, {scanResults: false});
      assert.equal(drain.targeted, 1); assert.equal(drain.pending, 0);
      drainCost = {...f.counts};
      assert.equal(drainCost.reads, 5);
      assert.equal(drainCost.writes, binding === 'matching-proof' ? 3 : 4);
      assert.equal(f.documentReads.get(queueKey), 1);
    }
    assert.equal(f.data.get(boardKey).entries[0].timeMs, 14000);
    assert.equal(f.counts.queries, 0);
    cases.push({mode, binding, firstNotify: firstCost, duplicateNotify: duplicateCost, deferredDrain: drainCost});
  }
  // Keep this opt-in output suitable for a private, repeatable evidence file.
  if (process.env.POLYTRACK_TEST_PB_COST_REPORT === '1') console.log('PB_PUBLICATION_COST_FIXTURE ' + JSON.stringify({
    schemaVersion: 1, source: 'actual Worker.fetch and reconcileCanonicalChanges, offline __TEST_FIRESTORE',
    scope: 'one touched unsharded track, one newer canonical PB plus one duplicate notification', cases}));
});

test('unknown configured PB publication mode fails closed before canonical read', async () => {
  for (const mode of ['coalsced', 'COALESCED', 'coalesced ', '', null, true]) {
    const f = fixture(); f.env.PB_PUBLICATION_MODE = mode;
    const before = structuredClone([...f.data]);
    const response = await f.notify(); assert.equal(response.status, 503, JSON.stringify(mode));
    assert.equal((await response.json()).accepted, undefined);
    assert.deepEqual(f.counts, {reads: 0, writes: 0, queries: 0, commitAttempts: 0});
    assert.equal(f.documentReads.size, 0);
    assert.deepEqual([...f.data], before);
  }
});

test('scoped coalescing includes Summer1 and keeps first 2R/1W and same-binding duplicate 2R/0W', async () => {
  const boundaryScope = [track, ...Array.from({length: 31}, (_, i) => i.toString(16).padStart(64, '0'))];
  for (const ids of [[track], boundaryScope]) {
    const f = fixture(), beforeBoard = structuredClone(f.data.get(boardKey)), beforeQueue = structuredClone(f.data.get(queueKey));
    f.env.PB_COALESCED_TRACK_IDS_JSON = JSON.stringify(ids);
    const response = await f.notify(); assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.accepted, true); assert.equal(body.changed, true); assert.equal(body.publicationPending, true);
    assert.deepEqual(f.counts, {reads: 2, writes: 1, queries: 0, commitAttempts: 1});
    assert.deepEqual(f.data.get(jobKey).pendingResultIds[track], [f.rows[0].accountId + '_' + track]);
    assert.equal(f.data.get(jobKey).pendingResultBindings[f.rows[0].accountId + '_' + track], verificationKey(f.rows[0]));
    assert.deepEqual(f.data.get(boardKey), beforeBoard); assert.deepEqual(f.data.get(queueKey), beforeQueue);
    assert.equal(f.commits.flat().every(write => write.update.name === base + jobKey), true);
    f.reset();
    const duplicate = await f.notify(); assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).changed, false);
    assert.deepEqual(f.counts, {reads: 2, writes: 0, queries: 0, commitAttempts: 0});
  }
});

test('scoped coalescing excludes Summer1 and publishes immediately without reading or writing its job queue', async () => {
  const f = fixture(), latest = {...row(f.rows[0].accountId, 14000, 2), pbAt: Date.UTC(2026, 9, 29, 12)};
  f.env.PB_COALESCED_TRACK_IDS_JSON = JSON.stringify(['e'.repeat(64)]);
  f.data.set(canonicalKey(latest), latest); f.data.get(queueKey).slots[latest.accountId] = proof(latest);
  const beforeJob = structuredClone(f.data.get(jobKey)), beforeQueue = structuredClone(f.data.get(queueKey));
  const response = await f.notify(latest); assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.accepted, true); assert.equal(body.changed, true); assert.equal(body.publicationPending, undefined);
  assert.deepEqual(f.counts, {reads: 4, writes: 2, queries: 0, commitAttempts: 1});
  assert.equal(f.data.get(boardKey).entries.find(entry => entry.accountId === latest.accountId).timeMs, 14000);
  assert.deepEqual(f.data.get(jobKey), beforeJob); assert.deepEqual(f.data.get(queueKey), beforeQueue);
  assert.equal(f.documentReads.get(jobKey) || 0, 0);
  assert.equal(f.commits.flat().some(write => write.update.name === base + jobKey), false);
  assert.equal(f.tasks.length, 0);
});

test('scoped coalescing rejects malformed JSON, non-64-hex arrays and over-32 scope before any DB access', async () => {
  const tooMany = Array.from({length: 33}, (_, i) => i.toString(16).padStart(64, '0'));
  const invalidScopes = ['{', '', 'null', '{}', '1', JSON.stringify('not-an-array'),
    JSON.stringify([1]), JSON.stringify([null]), JSON.stringify(['g'.repeat(64)]),
    JSON.stringify(['a'.repeat(63)]), JSON.stringify(['a'.repeat(65)]), JSON.stringify(tooMany),
    JSON.stringify([track + '\n'])];
  for (const scope of invalidScopes) {
    const f = fixture(); f.env.PB_COALESCED_TRACK_IDS_JSON = scope;
    const before = structuredClone([...f.data]);
    const response = await f.notify(); assert.equal(response.status, 503, scope);
    const body = await response.json(); assert.equal(body.error, 'invalid_pb_publication_scope');
    assert.equal(body.accepted, undefined);
    assert.deepEqual(f.counts, {reads: 0, writes: 0, queries: 0, commitAttempts: 0});
    assert.equal(f.documentReads.size, 0); assert.deepEqual([...f.data], before);
  }
});

const summer3 = '148826aa16ffaa23dbc453b32cff05e025ddbce1773fc7733cc13d218926515a';
const rolling = PERMANENT_ROLLING_HILLS.trackId;
// Investigation only: these targets are not enabled by the release configuration.
const optInBusy = [track, rolling, summer3];
const configuredBusy = () => JSON.parse(JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url))).vars.PB_COALESCED_TRACK_IDS_JSON);

test('checked-in release scope is Summer1 plus a bounded Summer2 trial; other tracks remain unchanged', () => {
  const catalog=JSON.parse(readFileSync(new URL('../../../tracks/catalog.json',import.meta.url))).tracks;
  const summer2=catalog.find(row=>row.name==='Summer 2').id;
  assert.equal(summer2,'7eac4fee1111152cfba4d3737410264ca0f22c7f5a2211e79f0099589b8b48c0');
  assert.deepEqual(configuredBusy(), [track,summer2]);
  assert.equal(configuredBusy().includes(rolling),false);
  assert.equal(configuredBusy().includes(summer3),false);
});

for (const [name, trackId, population] of [['Summer3', summer3, 496], ['RollingHills', rolling, 155]]) {
  for (const submissions of [1, 10]) test('opt-in scenario: ' + name + ' whole notify/drain cost at saved population, ' + submissions + ' newer PBs', async () => {
    const costs = {};
    for (const mode of ['immediate', 'coalesced']) {
      const f = fixture({trackId, population});
      f.env.PB_PUBLICATION_MODE = mode;
      f.env.PB_COALESCED_TRACK_IDS_JSON = JSON.stringify(optInBusy);
      const boardPath = '0.6.2_s1_leaderboards_track/' + trackId;
      const queuePath = VERIFICATION_COLLECTION + '/' + trackId;
      const originalProofs = structuredClone(f.data.get(queuePath));
      const originalBoard = structuredClone(f.data.get(boardPath));
      let latest;
      for (let i = 0; i < submissions; i++) {
        latest = {...f.rows[0], timeMs:14000 - i * 100, frames:14000 - i * 100,
          raceTimeFrames:14000 - i * 100, uploadId:i + 2, pbAt:10000 + i};
        f.data.set(canonicalKey(latest), latest);
        const response = await f.notify(latest);
        assert.equal(response.status, 200);
        const body = await response.json();
        assert.equal(body.accepted, true);
        assert.equal(body.publicationPending, mode === 'coalesced' ? true : undefined);
        if (mode === 'coalesced') {
          assert.deepEqual(f.data.get(queuePath), originalProofs);
          assert.deepEqual(f.data.get(boardPath), originalBoard);
        }
      }
      if (mode === 'coalesced') {
        const result = await reconcileCanonicalChanges(f.env, {scanResults:false});
        assert.equal(result.targeted, 1, 'latest exact canonical binding, not every obsolete improvement');
        assert.equal(result.pending, 0);
      }
      const board = f.data.get(boardPath), pending = f.data.get(queuePath).slots[latest.accountId];
      assert.equal(board.entries.find(r => r.accountId === latest.accountId).timeMs, latest.timeMs);
      assert.equal(board.totalEntries, population);
      assert.equal(pending.status, 'waiting');
      assert.equal(pending.key, verificationKey(latest));
      if (trackId === rolling) assert.equal(f.data.get('0.6.2_event_public/totals').publicationPending, true);
      assert.equal(f.counts.queries, 0); assert.equal(f.tasks.length, 0);
      const extra = trackId === rolling ? 1 : 0;
      const expected = mode === 'immediate'
        ? {reads:(4 + extra) * submissions, writes:(3 + extra) * submissions}
        : {reads:2 * submissions + 5 + extra, writes:submissions + 4 + extra};
      costs[mode] = {reads:f.counts.reads, writes:f.counts.writes};
      assert.deepEqual(costs[mode], expected);
      assert.equal(f.commits.flat().filter(w => w.update.name.endsWith('/' + boardPath)).length,
        mode === 'immediate' ? submissions : 1);
    }
    console.log('BUSY_SCOPE_COST ' + JSON.stringify({scenario:'explicit-opt-in-not-release-scope',name, population, submissions, costs,
      canonicalClientBase:{reads:submissions * 2, writes:submissions * 2},
      excludes:'native verification, subsequent proof publication, Overall, event totals assembly, capture, optional client work'}));
  });
}

test('release scope leaves Rolling Hills, Summer3, other native and sparse Extra immediate without publication-job costs', async () => {
  const sparseExtra = '7a8afe73c01cf77bf16c9c87f8e0f8732023bdf4b9b6bb4a0120e97553dd447d';
  const unselectedNative = JSON.parse(readFileSync(new URL('../../../tracks/catalog.json',import.meta.url))).tracks.find(row=>row.name==='Summer 4').id;
  for (const trackId of [rolling, summer3, unselectedNative, sparseExtra]) {
    const f = fixture({trackId});
    f.env.PB_COALESCED_TRACK_IDS_JSON = JSON.stringify(configuredBusy());
    if (trackId === sparseExtra) {
      const old = VERIFICATION_COLLECTION + '/' + trackId;
      f.data.set('0.6.2_s1_extra_verification/' + trackId, f.data.get(old)); f.data.delete(old);
      f.data.set('0.6.2_s1_worker_jobs/extra_verification_queue_migration_v1',
        {complete:true,registry:[...EXTRA_TRACK_IDS].sort().join(',')});
    }
    const latest = {...f.rows[0], timeMs:14000, frames:14000, raceTimeFrames:14000, uploadId:2};
    f.data.set(canonicalKey(latest), latest);
    const response = await f.notify(latest);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).publicationPending, undefined);
    assert.equal(f.documentReads.get(jobKey) || 0, 0);
    assert.equal(f.commits.flat().some(w => w.update.name.endsWith('/' + jobKey)), false);
    assert.deepEqual({reads:f.counts.reads,writes:f.counts.writes}, {reads:trackId === sparseExtra || trackId === rolling ? 5 : 4,writes:trackId === rolling ? 4 : 3});
  }
});

for (const trackId of [rolling, summer3]) test('opt-in scenario keeps ownership, quota and active-build admission fences: ' + trackId.slice(0, 8), async () => {
  for (const failure of ['ownership', 'quota', 'active-build']) {
    const f = fixture({trackId});
    f.env.PB_COALESCED_TRACK_IDS_JSON = JSON.stringify(optInBusy);
    if (failure === 'ownership') f.data.get(canonicalKey(f.rows[0])).ownerUid = 'different-owner';
    if (failure === 'quota') f.setReadHook(key => {if (key === jobKey) throw Error('FIRESTORE_429');});
    if (failure === 'active-build') f.data.get(jobKey).activeFullRebuildTrackId = trackId;
    const response = await f.notify();
    assert.equal(response.status, failure === 'ownership' ? 403 : 503);
    assert.equal(f.counts.writes, 0);
    assert.equal(f.counts.reads, failure === 'ownership' ? 1 : 2);
    assert.equal((await response.json()).accepted, undefined);
  }
});

for (const [name, trackId, population] of [['Summer3', summer3, 496], ['RollingHills', rolling, 160]]) {
  test('opt-in scenario: ' + name + ' ten distinct racers batch one generation without skipping canonical proofs', async () => {
    const costs = {};
    for (const mode of ['immediate', 'coalesced']) {
      const f = fixture({trackId, population});
      f.env.PB_PUBLICATION_MODE = mode;
      f.env.PB_COALESCED_TRACK_IDS_JSON = JSON.stringify(optInBusy);
      const updates = f.rows.slice(0, 10).map((r, i) => ({...r, timeMs:14000 + i,
        frames:14000 + i, raceTimeFrames:14000 + i, uploadId:2}));
      for (const r of updates) {
        f.data.set(canonicalKey(r), r);
        assert.equal((await f.notify(r)).status, 200);
      }
      if (mode === 'coalesced') {
        const result = await reconcileCanonicalChanges(f.env, {scanResults:false});
        assert.equal(result.targeted, 10); assert.equal(result.pending, 0);
        for (const r of updates) assert.equal(f.documentReads.get(canonicalKey(r)), 2,
          'one notify read and one fresh drain read per exact binding');
      }
      for (const r of updates) assert.equal(f.data.get(VERIFICATION_COLLECTION + '/' + trackId).slots[r.accountId].key, verificationKey(r));
      const extra = trackId === rolling ? 1 : 0;
      costs[mode] = {reads:f.counts.reads, writes:f.counts.writes};
      assert.deepEqual(costs[mode], mode === 'immediate'
        ? {reads:40 + 10 * extra, writes:30 + 10 * extra}
        : {reads:34 + extra, writes:14 + extra});
    }
    console.log('BUSY_DISTINCT_COST ' + JSON.stringify({scenario:'explicit-opt-in-not-release-scope',name, population, racers:10, costs,
      canonicalClientBase:{reads:20, writes:20}, excludes:'native verification, subsequent proof publication, Overall, event totals assembly, capture, optional client work'}));
  });
}

test('Summer1 saved 1136-racer paged population makes repeated unseen generations expensive', async () => {
  const costs = {};
  for (const mode of ['immediate', 'coalesced']) {
    const f = fixture({population:1136});
    f.env.PB_PUBLICATION_MODE = mode;
    f.env.PB_COALESCED_TRACK_IDS_JSON = JSON.stringify(configuredBusy());
    const board = f.data.get(boardKey);
    const publication = await preparePublicationPages('track', track, board.entries,
      {sourceRevision:1, sourceComplete:true});
    for (const document of publication.documents) f.data.set(document.collection + '/' + document.id, document.data);
    f.data.set(boardKey, {...board, entries:board.entries.slice(0, 500), complete:false,
      sourceComplete:true, pagination:publication.pagination});
    const slots = f.data.get(queueKey).slots;
    f.data.set(queueKey, {trackId:track, storageVersion:2, slots:{}, migrationComplete:true});
    for (const r of f.rows) {
      const queueId = verificationShardId(track, r.accountId);
      f.data.set(VERIFICATION_COLLECTION + '/' + queueId,
        {trackId:track, queueId, storageVersion:2, slots:{[r.accountId]:slots[r.accountId]}});
    }
    let latest;
    for (let i = 0; i < 10; i++) {
      latest = {...f.rows[0], timeMs:14000 - i * 100, frames:14000 - i * 100,
        raceTimeFrames:14000 - i * 100, uploadId:i + 2};
      f.data.set(canonicalKey(latest), latest);
      assert.equal((await f.notify(latest)).status, 200);
    }
    if (mode === 'coalesced') assert.equal((await reconcileCanonicalChanges(f.env, {scanResults:false})).pending, 0);
    assert.equal(f.data.get(boardKey).totalEntries, 1136);
    assert.equal(f.data.get(boardKey).entries.find(r => r.accountId === latest.accountId).timeMs, latest.timeMs);
    assert.equal(f.data.get(VERIFICATION_COLLECTION + '/' + verificationShardId(track, latest.accountId))
      .slots[latest.accountId].key, verificationKey(latest));
    costs[mode] = {reads:f.counts.reads, writes:f.counts.writes};
    assert.deepEqual(costs[mode], mode === 'immediate' ? {reads:170,writes:160} : {reads:38,writes:27});
  }
  console.log('BUSY_PAGED_COST ' + JSON.stringify({name:'Summer1', population:1136, improvements:10,
    sourcePages:12, costs, canonicalClientBase:{reads:20,writes:20},
    excludes:'native verification, subsequent proof publication, Overall, capture, optional client work'}));
});

test('coordinated Summer1 queue publishes stale paged roots outside capture windows and marks sources dirty', async t => {
  const now = Date.UTC(2026, 10, 6, 3, 5), oldAt = Date.UTC(2026, 9, 29);
  t.mock.method(Date, 'now', () => now);
  const errors = [], audits = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  t.mock.method(console, 'log', (message, payload) => {
    if (message === 'Ranked scheduled Firestore reads') audits.push(JSON.parse(payload));
  });
  const f = fixture({population:1136});
  f.env.BACKGROUND_MAINTENANCE_MODE = 'coordinated';
  f.env.PB_COALESCED_TRACK_IDS_JSON = JSON.stringify(configuredBusy());
  f.env.PUBLIC_FIRESTORE_READ_MODE = 'capture-only';
  const old = f.data.get(boardKey), publication = await preparePublicationPages('track', track, old.entries,
    {sourceRevision:1, sourceComplete:true});
  for (const document of publication.documents) f.data.set(document.collection + '/' + document.id, document.data);
  f.data.set(boardKey, {...old, updatedAt:oldAt, builtAt:oldAt, entries:old.entries.slice(0, 500),
    complete:false, pagination:publication.pagination});
  const slots = f.data.get(queueKey).slots;
  f.data.set(queueKey, {trackId:track, storageVersion:2, slots:{}, migrationComplete:true});
  for (const r of f.rows) {
    const queueId = verificationShardId(track, r.accountId);
    f.data.set(VERIFICATION_COLLECTION + '/' + queueId,
      {trackId:track, queueId, storageVersion:2, slots:{[r.accountId]:slots[r.accountId]}});
  }
  const catalog = sourceCatalogFromScan([{id:track, data:f.data.get(boardKey), updateTime:'v0'}],
    {fullScan:true, limitReached:false, scannedAt:oldAt});
  assert.ok(catalog);
  f.data.set(metaKey, {...f.data.get(metaKey), sourceCatalog:catalog});
  const latest = {...f.rows[0], timeMs:14000, frames:14000, raceTimeFrames:14000,
    uploadId:2, pbAt:Date.UTC(2026, 10, 5)};
  f.data.set(canonicalKey(latest), latest);
  assert.equal((await (await f.notify(latest)).json()).publicationPending, true);
  assert.equal(f.data.get(metaKey).dirty, false, 'enqueue does not falsely claim published sources changed');
  assert.equal(f.data.get(boardKey).updatedAt, oldAt);
  assert.deepEqual(f.counts, {reads:2, writes:1, queries:0, commitAttempts:1});
  f.reset();
  const turn = async at => {
    let completion;
    worker.scheduled({cron:'*/5 * * * *', scheduledTime:at}, f.env, {waitUntil:p => {completion = p;}});
    assert.ok(completion, 'coordinated queue draining is not gated to a capture window');
    await completion;
  };
  await turn(now);
  assert.deepEqual(errors, []);
  assert.equal(f.data.get(boardKey).updatedAt, now);
  assert.equal(f.data.get(boardKey).entries.find(r => r.accountId === latest.accountId).timeMs, latest.timeMs);
  assert.equal(f.data.get(boardKey).totalEntries, 1136);
  assert.equal(f.data.get(metaKey).dirty, true);
  assert.notDeepEqual(f.data.get(metaKey).sourceCatalog.tracks[track], catalog.tracks[track]);
  assert.deepEqual(f.data.get(jobKey).pendingTrackIds, []);
  assert.deepEqual(f.data.get(jobKey).pendingResultBindings, {});
  assert.deepEqual(f.counts, {reads:18, writes:17, queries:0, commitAttempts:4});
  assert.equal(audits[0].documentReadEstimate, 18);
  assert.equal(audits[0].writeEstimate, 17);
  f.reset();
  await turn(now + 5 * 60000);
  assert.deepEqual(errors, []);
  assert.deepEqual(f.counts, {reads:1, writes:0, queries:0, commitAttempts:0});
  process.stdout.write('COALESCED_STALE_ROOT_COST ' + JSON.stringify({population:1136,
    enqueue:{reads:2,writes:1}, drain:{reads:18,writes:17}, cleanFollowup:{reads:1,writes:0},
    excludes:'Overall aggregation, native verification and capture'}) + '\n');
});


test('configured Summer2 enters the existing bounded lane without immediate board publication',async()=>{
 const summer2='7eac4fee1111152cfba4d3737410264ca0f22c7f5a2211e79f0099589b8b48c0';
 const f=fixture({trackId:summer2});f.env.PB_COALESCED_TRACK_IDS_JSON=JSON.stringify(configuredBusy());
 const key='0.6.2_s1_leaderboards_track/'+summer2,before=structuredClone(f.data.get(key));
 const response=await f.notify();assert.equal(response.status,200);assert.equal((await response.json()).publicationPending,true);
 assert.deepEqual(f.data.get(key),before);assert.equal(f.documentReads.get(key)||0,0);
 assert.deepEqual(f.data.get(jobKey).pendingResultIds[summer2],[f.rows[0].accountId+'_'+summer2]);
 assert.deepEqual(f.counts,{reads:2,writes:1,queries:0,commitAttempts:1});
});
