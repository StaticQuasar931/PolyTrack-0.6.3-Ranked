import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Socket} from 'node:net';
import {rebuildTrack, reconcileCanonicalChanges, updateTrackIdentity, computeTrackEntries, migrateExtraVerificationQueues} from '../src/index.js';
import {eventEncode, eventDecode} from '../src/events-store.js';
import {pendingSlot, verificationKey, verificationSchedule, VERIFICATION_COLLECTION, VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION} from '../src/verification.js';
import {PERMANENT_ROLLING_HILLS} from '../src/permanent-rolling-hills.js';
import {verificationShardId} from '../src/verification-shards.js';
import {preparePublicationPages, loadPublicationEntries, PUBLIC_PAGE_COLLECTION, PUBLIC_MANIFEST_COLLECTION} from '../src/paged-publication.js';
import {TRACK_BUILD_JOBS, TRACK_BUILD_PARTS, trackBuildId} from '../src/track-build.js';

const track = '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const base = 'projects/quota-a-offline/databases/(default)/documents/';
const results = '0.6.2_race_results', boards = '0.6.2_s1_leaderboards_track';
const boardKey = boards + '/' + track;
const buildKey = TRACK_BUILD_JOBS + '/' + trackBuildId(track);
const reconcileKey = TRACK_BUILD_JOBS + '/canonical_reconcile_v2';
const metaKey = '0.6.2_s1_release_meta/current';
const population = 1136;

async function fixture(t, {trackId = track, count = population} = {}) {
  const track = trackId, boardKey = boards + '/' + track;
  const buildKey = TRACK_BUILD_JOBS + '/' + trackBuildId(track);
  const blocked = () => { throw Error('AUDIT275_NETWORK_FORBIDDEN'); };
  t.mock.method(globalThis, 'fetch', blocked);
  t.mock.method(Socket.prototype, 'connect', blocked);
  t.mock.method(console, 'log', () => {});
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args));
  let now = Date.UTC(2026, 10, 3, 8);
  t.mock.method(Date, 'now', () => now);
  const data = new Map(), versions = new Map(), snapshots = new Map();
  const reads = [], queries = [], commits = [];
  const stats = {reads:0, writes:0, requests:0, fixedProof:0, currentProof:0, canonicalRows:0};
  let maxCheckpointBytes=0;
  let serial = 0;
  const version = key => versions.get(key) || '2026-11-03T07:00:00.000Z';
  const set = (key, value) => {
    data.set(key, structuredClone(value));
    versions.set(key, new Date(snapshots.size ? ++now : Date.UTC(2026, 10, 3, 7) + ++serial).toISOString());
  };
  const wire = (key, source = data, sourceVersions = versions) => ({name:base + key,
    fields:eventEncode(source.get(key)).mapValue.fields,
    updateTime:sourceVersions.get(key) || '2026-11-03T07:00:00.000Z'});
  const replay = 'audit275-local-proof', replayHash = createHash('sha256').update(replay).digest('hex');
  const rows = Array.from({length:count}, (_, i) => ({accountId:'r' + String(i).padStart(4, '0'),
    trackId:track, name:'Racer ' + i, timeMs:10000 + i, frames:10000 + i, raceTimeFrames:10000 + i,
    uploadId:1, replay, replayHash, pbAt:1000, integrityVerified:true}));
  const slots = Object.fromEntries(rows.map(row => [row.accountId, {...pendingSlot(row), status:'verified',
    engineDigest:VERIFIER_ENGINE_DIGEST, verifierVersion:VERIFIER_VERSION}]));
  for (const row of rows) {
    set(results + '/' + row.accountId + '_' + track, row);
    const id = verificationShardId(track, row.accountId), accountSlots = {[row.accountId]:slots[row.accountId]};
    set(VERIFICATION_COLLECTION + '/' + id, {trackId:track, queueId:id, storageVersion:2,
      slots:accountSlots, ...verificationSchedule(accountSlots)});
  }
  set(VERIFICATION_COLLECTION + '/' + track, {trackId:track, slots:{}, storageVersion:2, migrationComplete:true});
  const entries = computeTrackEntries(rows, track, {}, slots);
  const pages = count > 500 ? await preparePublicationPages('track', track, entries, {sourceRevision:1, sourceComplete:true}) : null;
  for (const doc of pages?.documents || []) set(doc.collection + '/' + doc.id, doc.data);
  set(boardKey, {trackId:track, entries:entries.slice(0, 500), ...(pages ? {pagination:pages.pagination} : {}),
    totalEntries:count, totalEntriesExact:true, sourceComplete:true, complete:count <= 500, revision:1,
    sourceRevision:1, schemaVersion:6, algorithmVersion:'participation-v8-s1', signature:'audit275-seed'});
  set(metaKey, {revision:1, builtRevision:1, dirty:false});
  set(reconcileKey, {backfillComplete:true, schemaVersion:2, cursorIngestedAt:'2026-11-03T00:00:00Z',
    cursorDocumentId:'preserve-cursor', backfillDocumentId:'preserve-backfill',
    pendingTrackIds:[track], pendingFullRebuildTrackIds:[track], pendingResultIds:{}});
  const control = {beforeCommit:null, afterCommit:null, discovery:[]};
  const noteRead = (key, readTime = '') => {
    stats.reads++;
    reads.push({key, readTime});
    if (key.startsWith(VERIFICATION_COLLECTION + '/' + track + '_')) {
      if (readTime) stats.fixedProof++; else stats.currentProof++;
    }
  };
  const env = {__TEST_FIRESTORE:async (route, init = {}) => {
    stats.requests++;
    const body = init.body ? JSON.parse(init.body) : null;
    if (route === ':runQuery') {
      const q = body.structuredQuery;
      assert.equal(q.from[0].collectionId, results);
      if (q.where?.fieldFilter?.field?.fieldPath !== 'trackId') {
        const found = control.discovery.splice(0, q.limit);
        stats.reads += Math.max(1, found.length);
        return found.map(row => {const document=wire(row.key);return {document:{...document,
          fields:{...document.fields,ingestedAt:{timestampValue:row.ingestedAt || new Date(now).toISOString()}}},
          readTime:new Date(now).toISOString()};});
      }
      assert.equal(q.where.fieldFilter.field.fieldPath, 'trackId');
      const requestedTrack = q.where.fieldFilter.value.stringValue;
      assert.equal(q.limit, 100);
      const readTime = body.readTime || new Date(now).toISOString();
      if (!body.readTime) {
        const inputs=new Map([...data].filter(([key])=>key.startsWith(results+'/')||key.startsWith(VERIFICATION_COLLECTION+'/')));
        snapshots.set(readTime, {data:structuredClone(inputs), versions:new Map([...versions].filter(([key])=>inputs.has(key)))});
      }
      const source = snapshots.get(readTime);
      assert.ok(source, 'every historical read must use an established immutable snapshot');
      const after = q.startAt?.values?.[0]?.referenceValue || '';
      const found = [...source.data.keys()].filter(key => key.startsWith(results + '/')
        && source.data.get(key).trackId === requestedTrack && base + key > after)
        .sort().slice(0, q.limit);
      stats.canonicalRows += found.length;
      if (!found.length) stats.reads++;
      for (const key of found) noteRead(key, readTime);
      queries.push({trackId:requestedTrack,readTime:body.readTime || '', after, count:found.length});
      return found.length ? found.map(key => ({document:wire(key, source.data, source.versions), readTime})) : [{readTime}];
    }
    if (route === ':batchGet') {
      const source = body.readTime ? snapshots.get(body.readTime) : {data, versions};
      assert.ok(source);
      return body.documents.map(name => {
        const key = name.split('/documents/')[1];
        noteRead(key, body.readTime);
        return source.data.has(key) ? {found:wire(key, source.data, source.versions)} : {missing:name};
      });
    }
    if (route === ':commit') {
      const writes = body.writes;
      const proofBatch=writes.every(w=>w.update?.name.includes('/'+VERIFICATION_COLLECTION+'/'));
      assert.ok(writes.length <= (proofBatch ? 49 : 32), 'proof migration and publication staging keep their existing bounds');
      if (writes.some(w => w.update?.name.endsWith('/' + reconcileKey)))
        assert.ok(writes.length <= 6, 'combined final commit includes at most six writes, including Rolling');
      for (const w of writes.filter(w=>w.update?.name.endsWith('/'+reconcileKey))) {
        const bytes=new TextEncoder().encode(JSON.stringify(w.update)).length;
        maxCheckpointBytes=Math.max(maxCheckpointBytes,bytes);
        assert.ok(bytes<=800000,'the serialized Firestore job document stays within 800 KB');
      }
      if (control.beforeCommit) await control.beforeCommit(writes);
      for (const w of writes) {
        assert.ok(w.update, 'no deletes in this fixture');
        const key = w.update.name.split('/documents/')[1];
        if (w.currentDocument) {
          const expected = data.has(key) ? {updateTime:version(key)} : {exists:false};
          if (JSON.stringify(w.currentDocument) !== JSON.stringify(expected)) throw Error('FIRESTORE_412');
        } else assert.ok([PUBLIC_PAGE_COLLECTION, PUBLIC_MANIFEST_COLLECTION, TRACK_BUILD_PARTS]
          .some(collection => key.startsWith(collection + '/')), 'only immutable staged artifacts omit CAS');
      }
      const writeResults = writes.map(w => {
        const key = w.update.name.split('/documents/')[1];
        set(key, eventDecode({mapValue:{fields:w.update.fields}}));
        stats.writes++;
        return {updateTime:version(key)};
      });
      commits.push(writes);
      if (control.afterCommit) await control.afterCommit(writes);
      return {writeResults};
    }
    assert.equal(init.method || 'GET', 'GET');
    const url = new URL('https://offline.invalid' + route), key = decodeURIComponent(url.pathname.slice(1));
    const readTime = url.searchParams.get('readTime') || '';
    const source = readTime ? snapshots.get(readTime) : {data, versions};
    assert.ok(source);
    noteRead(key, readTime);
    return source.data.has(key) ? wire(key, source.data, source.versions) : null;
  }};
  const finish = async (reconcile = false) => {
    for (let pass = 0; pass < 20; pass++) {
      const requests = stats.requests;
      const result = reconcile ? await reconcileCanonicalChanges(env, {scanResults:false, now}) : await rebuildTrack(env, track);
      assert.ok(stats.requests - requests <= 45, 'bounded pass leaves cold-auth headroom');
      if (reconcile ? result.pending === 0 : !result.pending) return result;
    }
    assert.fail('stationary source must finish within twenty passes');
  };
  const identity = {accountId:rows[0].accountId, name:'Cosmetic Racer', countryCode:'US',
    profileCosmetics:{version:1, theme:'cyan'}, identityUpdatedAt:now};
  const report = scenario => process.stdout.write('QUOTA_A_COST ' + JSON.stringify({scenario, ...stats,
    canonicalQueries:queries.length, prefixQueries:queries.filter(q => !q.readTime).length}) + '\n');
  const finishFull = async () => {
    for (let pass = 0; pass < 20; pass++) {
      await reconcileCanonicalChanges(env, {scanResults:false});
      if (data.get(buildKey)?.complete === true) return;
    }
    assert.fail('full build did not finish');
  };
  return {data, env, rows, reads, queries, stats, commits, control, errors, finish, finishFull, identity, report, set,
    keys:{boardKey, buildKey}, maxCheckpointBytes:()=>maxCheckpointBytes, tick:ms=>{now+=ms;},
    prior:key => ({data:structuredClone(data.get(key)), updateTime:version(key)})};
}

async function seedTargets(f, {count = 3, population = 1} = {}) {
  const tracks = Array.from({length:count}, (_, i) => 'quota-target-' + i);
  const ids = [], bindings = {};
  for (const trackId of tracks) {
    const rows = Array.from({length:population}, (_, i) => ({...f.rows[0], trackId,
      accountId:'target-' + i, timeMs:12000+i, frames:12000+i, raceTimeFrames:12000+i}));
    const slots = Object.fromEntries(rows.map(row => [row.accountId, {...pendingSlot(row),
      status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION}]));
    const entries = computeTrackEntries(rows, trackId, {}, slots);
    const pages = population > 500 ? await preparePublicationPages('track', trackId, entries,
      {sourceRevision:1,sourceComplete:true}) : null;
    for (const doc of pages?.documents || []) f.set(doc.collection + '/' + doc.id, doc.data);
    f.set(boards + '/' + trackId, {trackId,entries:entries.slice(0,500),
      ...(pages ? {pagination:pages.pagination} : {}),totalEntries:population,totalEntriesExact:true,
      sourceComplete:true,complete:population <= 500,revision:1,sourceRevision:1,schemaVersion:6,
      algorithmVersion:'participation-v8-s1',signature:'seed-target'});
    const row = rows[0], id = row.accountId + '_' + trackId;
    f.set(results + '/' + id, row);
    f.set(VERIFICATION_COLLECTION + '/' + trackId, {trackId,slots:{[row.accountId]:slots[row.accountId]}});
    ids.push(id); bindings[id] = verificationKey(row);
  }
  f.set(reconcileKey, {...f.data.get(reconcileKey),pendingTrackIds:[track,...tracks],
    pendingResultIds:Object.fromEntries(tracks.map((id,i) => [id,[ids[i]]])),pendingResultBindings:bindings});
  return {tracks,ids,bindings};
}

test('quota A cost trace: full continuation with three waiting targets', async t => {
  const f = await fixture(t), targets = await seedTargets(f);
  const passes = [];
  for (let pass=0;pass<10;pass++) {
    const before = {...f.stats};
    const result = await reconcileCanonicalChanges(f.env, {scanResults:false});
    passes.push({pass,...result,reads:f.stats.reads-before.reads,writes:f.stats.writes-before.writes,
      requests:f.stats.requests-before.requests});
    if (!result.pending) break;
  }
  assert.deepEqual(f.data.get(reconcileKey).pendingTrackIds, []);
  assert.equal(f.stats.canonicalRows, population);
  assert.equal(f.stats.fixedProof, 0);
  assert.equal(f.stats.currentProof, population);
  assert.deepEqual(f.errors, []);
  process.stdout.write('QUOTA_A_LANES ' + JSON.stringify({passes,targetReads:f.reads.filter(row =>
    targets.ids.some(id => row.key === results + '/' + id)).length}) + '\n');
  f.report('full-plus-three-targets');
});

for (const size of [1,1136]) test('quota A: targeted siblings progress before each full continuation, target population '+size, async t => {
  const f = await fixture(t), targets = await seedTargets(f, {population:size});
  const lastProgress=new Map(targets.tracks.map(id=>[id,-1]));
  let maxRequests=0;
  for (let pass=0;pass<7;pass++) {
    const before = {...f.stats};
    const result = await reconcileCanonicalChanges(f.env, {scanResults:false});
    assert.equal(result.targeted, size===1?3:2, 'large targets share the lane without stealing full headroom');
    maxRequests=Math.max(maxRequests,f.stats.requests-before.requests);
    assert.ok(f.stats.requests-before.requests <= 45, 'mixed lanes retain cold-auth headroom');
    assert.equal(f.data.get(buildKey).sourceCount, Math.min(population,100+pass*200));
    for (const trackId of targets.tracks) {
      const board = f.data.get(boards+'/'+trackId);
      assert.equal(board.entries[0].runVerified, true);
      assert.equal(board.totalEntries, size);
      if (board.entries[0].timeMs === (pass ? 11001-pass : 12000)) lastProgress.set(trackId,pass);
      assert.ok(pass-lastProgress.get(trackId)<=1, 'every targeted sibling progresses within two turns despite sustained work');
    }
    assert.deepEqual(f.errors, []);
    if (pass<6) {
      f.tick(5*60000);
      const queued = f.data.get(reconcileKey);
      for (let i=0;i<targets.tracks.length;i++) {
        const trackId=targets.tracks[i], id=targets.ids[i];
        const row={...f.data.get(results+'/'+id),timeMs:11000-pass,frames:11000-pass,
          raceTimeFrames:11000-pass,uploadId:pass+2};
        f.set(results+'/'+id,row);
        targets.bindings[id]=verificationKey(row);
        f.set(VERIFICATION_COLLECTION+'/'+trackId,{trackId,slots:{[row.accountId]:{
          ...pendingSlot(row),status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION}}});
      }
      f.set(reconcileKey, {...queued,pendingTrackIds:[...new Set([...queued.pendingTrackIds,...targets.tracks])],
        pendingResultIds:Object.fromEntries(targets.tracks.map((id,i)=>[id,[targets.ids[i]]])),
        pendingResultBindings:targets.bindings});
    }
  }
  assert.equal(f.data.get(buildKey).complete, true);
  assert.equal(f.queries.filter(row=>!row.readTime).length,1);
  await reconcileCanonicalChanges(f.env,{scanResults:false});
  assert.deepEqual(f.data.get(reconcileKey).pendingTrackIds,[]);
  process.stdout.write('QUOTA_A_SUSTAINED '+JSON.stringify({targetPopulation:size,maxRequests,fullPasses:7,maxTargetWaitTurns:2})+'\n');
});

test('quota A: fresh proof-queue work cannot consume full continuation headroom', async t => {
  const f=await fixture(t),targets=await seedTargets(f,{population:1136});
  await reconcileCanonicalChanges(f.env,{scanResults:false});
  for (const row of f.rows.slice(100)) {
    const key=VERIFICATION_COLLECTION+'/'+verificationShardId(track,row.accountId);
    f.set(key,{...f.data.get(key),slots:{}});
  }
  const queue=f.data.get(reconcileKey);
  for (const trackId of targets.tracks) f.set(boards+'/'+trackId,{...f.data.get(boards+'/'+trackId),signature:'force-identity-repair'});
  f.set(reconcileKey,{...queue,pendingTrackIds:[...queue.pendingTrackIds,...targets.tracks],
    pendingResultIds:Object.fromEntries(targets.tracks.map((id,i)=>[id,[targets.ids[i]]])),pendingResultBindings:targets.bindings});
  const before={...f.stats};
  const result=await reconcileCanonicalChanges(f.env,{scanResults:false});
  assert.equal(f.data.get(buildKey).sourceCount,300,'both continuation pages retain their reservation');
  assert.equal(f.data.get(reconcileKey).activeFullRebuildTrackId,track);
  assert.deepEqual(f.data.get(reconcileKey).failedFullRebuilds,{});
  assert.ok(f.stats.requests-before.requests<=45);
  assert.deepEqual(f.errors,[]);
  process.stdout.write('QUOTA_A_PROOF_WRITES '+JSON.stringify({...result,
    reads:f.stats.reads-before.reads,writes:f.stats.writes-before.writes,requests:f.stats.requests-before.requests})+'\n');
});

const contains=(writes,key)=>writes.some(w=>w.update?.name.endsWith('/'+key));
const completed=(writes,key=buildKey)=>writes.some(w=>w.update?.name.endsWith('/'+key)
  &&eventDecode({mapValue:{fields:w.update.fields}}).complete===true);

test('quota A: targeted fallback cannot steal an active full continuation',async t=>{
  const f=await fixture(t);
  await reconcileCanonicalChanges(f.env,{scanResults:false});
  const targets=await seedTargets(f);
  for (const id of targets.tracks) f.set(boards+'/'+id,{...f.data.get(boards+'/'+id),schemaVersion:0});
  await reconcileCanonicalChanges(f.env,{scanResults:false});
  assert.equal(f.data.get(buildKey).sourceCount,300);
  assert.equal(f.data.get(reconcileKey).activeFullRebuildTrackId,track);
  assert.deepEqual(f.data.get(reconcileKey).pendingFullRebuildTrackIds,[track,...targets.tracks]);
  assert.deepEqual(f.data.get(reconcileKey).pendingResultBindings,targets.bindings);
  assert.ok(f.queries.every(q=>q.trackId===track));
  assert.deepEqual(f.errors,[]);
});

for(const conflict of ['queue','root','meta']) test('quota A: '+conflict+' CAS conflict after targeted commits preserves all queued PBs',async t=>{
  const f=await fixture(t),targets=await seedTargets(f);
  let conflicted=false,expected;
  const key=conflict==='queue'?reconcileKey:conflict==='root'?boardKey:metaKey;
  f.control.beforeCommit=writes=>{
    if(!conflicted&&contains(writes,reconcileKey)) {
      conflicted=true;
      expected={...f.data.get(key),raceMarker:'preserve-newer-state'};
      f.set(key,expected);
      // Non-final checkpoint turns do not write root/meta. Fail their queue CAS
      // too so no progress is falsely discharged in this early conflict case.
      if(key!==reconcileKey)throw Error('FIRESTORE_412');
    }
  };
  await assert.rejects(reconcileCanonicalChanges(f.env,{scanResults:false}),/FIRESTORE_412/);
  assert.deepEqual(f.data.get(key),expected);
  assert.deepEqual(f.data.get(reconcileKey).pendingResultBindings,targets.bindings);
  for(const id of targets.tracks)assert.equal(f.data.get(boards+'/'+id).entries[0].runVerified,true);
  f.control.beforeCommit=null;
  await f.finish(true);
  assert.deepEqual(f.data.get(reconcileKey).pendingTrackIds,[]);
  if(conflict!=='root')assert.equal(f.data.get(key).raceMarker,'preserve-newer-state');
  assert.equal(f.queries.filter(q=>!q.readTime).length,conflict==='root'?2:1);
});

test('quota A: final queue conflict keeps newer targeted PB binding after earlier target publication',async t=>{
  const f=await fixture(t);
  for(let pass=0;pass<6;pass++)await reconcileCanonicalChanges(f.env,{scanResults:false});
  const targets=await seedTargets(f,{count:1});
  const id=targets.ids[0],target=targets.tracks[0];
  const newer={...f.data.get(results+'/'+id),timeMs:9000,frames:9000,raceTimeFrames:9000,uploadId:2};
  let raced=false;
  f.control.beforeCommit=writes=>{
    if(!raced&&completed(writes)) {
      raced=true;
      f.set(results+'/'+id,newer);
      f.set(reconcileKey,{...f.data.get(reconcileKey),pendingResultBindings:{[id]:verificationKey(newer)}});
    }
  };
  await assert.rejects(reconcileCanonicalChanges(f.env,{scanResults:false}),/FIRESTORE_412/);
  assert.equal(f.data.get(buildKey).complete,false);
  assert.equal(f.data.get(boardKey).revision,1);
  assert.equal(f.data.get(reconcileKey).pendingResultBindings[id],verificationKey(newer));
  f.control.beforeCommit=null;
  await f.finish(true);
  assert.equal(f.data.get(boards+'/'+target).entries[0].timeMs,9000);
  assert.equal(f.data.get(boards+'/'+target).entries[0].runVerified,false,'old proof cannot admit the newer PB');
  assert.equal(f.queries.filter(q=>!q.readTime).length,1);
  assert.deepEqual(f.data.get(reconcileKey).pendingResultBindings,{});
});

test('quota A: missing target page fails closed without per-page retry or full-lane starvation',async t=>{
  const f=await fixture(t),targets=await seedTargets(f,{count:1,population:1136});
  const target=targets.tracks[0],board=f.data.get(boards+'/'+target);
  const pageId=`track_${target}_${board.pagination.generation}_0`;
  f.data.delete(PUBLIC_PAGE_COLLECTION+'/'+pageId);
  const before=structuredClone(board);
  await reconcileCanonicalChanges(f.env,{scanResults:false});
  assert.deepEqual(f.data.get(boards+'/'+target),before);
  assert.deepEqual(f.data.get(reconcileKey).pendingResultIds[target],targets.ids);
  assert.equal(f.data.get(buildKey).sourceCount,100);
  assert.equal(f.reads.filter(row=>row.key===PUBLIC_PAGE_COLLECTION+'/'+pageId).length,1);
  assert.match(JSON.stringify(f.errors),/PUBLIC_PAGE_INCOMPLETE/);
});

test('quota A: Rolling full completion remains a six-write atomic handoff after targets',async t=>{
  const f=await fixture(t,{trackId:PERMANENT_ROLLING_HILLS.trackId,count:501});
  const targets=await seedTargets(f);
  f.set(reconcileKey,{...f.data.get(reconcileKey),pendingTrackIds:[PERMANENT_ROLLING_HILLS.trackId,...targets.tracks]});
  await f.finish(true);
  const writes=f.commits.find(writes=>completed(writes,f.keys.buildKey));
  assert.equal(writes.length,6);
  assert.ok(contains(writes,f.keys.boardKey)&&contains(writes,metaKey)&&contains(writes,reconcileKey));
  assert.ok(contains(writes,'0.6.2_event_public/totals'));
  assert.deepEqual(f.errors,[]);
});

test('quota A cost trace: cosmetic fanout and identity rehydration remain separately attributable',async t=>{
  const f=await fixture(t);
  for(let pass=0;pass<5;pass++)await rebuildTrack(f.env,track);
  const scanned={...f.stats};
  assert.equal(f.data.get(buildKey).sourceCount,900);
  await updateTrackIdentity(f.env,track,f.identity);
  const identity=Object.fromEntries(Object.entries(f.stats).map(([key,value])=>[key,value-scanned[key]]));
  const afterIdentity={...f.stats};
  await f.finish();
  assert.equal(f.stats.canonicalRows,2036);
  assert.equal(f.data.get(boardKey).entries[0].name,f.identity.name);
  process.stdout.write('QUOTA_A_COSMETICS '+JSON.stringify({scanned,identity,
    restartedBuild:Object.fromEntries(Object.entries(f.stats).map(([key,value])=>[key,value-afterIdentity[key]])),
    total:f.stats})+'\n');
});

test('quota A: lost final response leaves earlier targets and full discharge durable',async t=>{
  const f=await fixture(t);
  for(let pass=0;pass<6;pass++)await reconcileCanonicalChanges(f.env,{scanResults:false});
  const targets=await seedTargets(f);
  let lost=false;
  f.control.afterCommit=writes=>{if(!lost&&completed(writes)){lost=true;throw Error('LOST_RESPONSE');}};
  await assert.rejects(reconcileCanonicalChanges(f.env,{scanResults:false}),/LOST_RESPONSE/);
  assert.equal(f.data.get(buildKey).complete,true);
  assert.deepEqual(f.data.get(reconcileKey).pendingResultBindings,{});
  for(const id of targets.tracks)assert.equal(f.data.get(boards+'/'+id).entries[0].runVerified,true);
  const before={...f.stats};
  await reconcileCanonicalChanges(f.env,{scanResults:false});
  assert.equal(f.stats.reads-before.reads,1);
  assert.equal(f.stats.writes-before.writes,0);
  assert.equal(f.stats.canonicalRows-before.canonicalRows,0);
});

test('quota A: final root/meta fences still reject races after targeted commits',async t=>{
  for(const key of [boardKey,metaKey]) {
    const f=await fixture(t);
    for(let pass=0;pass<6;pass++)await reconcileCanonicalChanges(f.env,{scanResults:false});
    const targets=await seedTargets(f,{count:1});
    let raced=false,expected;
    f.control.beforeCommit=writes=>{
      if(!raced&&completed(writes)){
        raced=true;expected={...f.data.get(key),revision:999,concurrentMarker:true};f.set(key,expected);
      }
    };
    await assert.rejects(reconcileCanonicalChanges(f.env,{scanResults:false}),/FIRESTORE_412/);
    assert.deepEqual(f.data.get(key),expected);
    assert.equal(f.data.get(buildKey).complete,false);
    assert.deepEqual(f.data.get(reconcileKey).pendingResultBindings,targets.bindings);
    if(key!==boardKey)assert.equal(f.data.get(boardKey).revision,1);
  }
});

test('quota A cost trace: legacy queue deletes are one-time atomic moves, not repeating cleanup',async t=>{
  const blocked=()=>{throw Error('QUOTA_A_NETWORK_FORBIDDEN');};
  t.mock.method(globalThis,'fetch',blocked);t.mock.method(Socket.prototype,'connect',blocked);
  const ids=Array.from({length:5},(_,i)=>String(i+1).repeat(64));
  const state=new Map(ids.map(trackId=>[VERIFICATION_COLLECTION+'/'+trackId,{trackId,slots:{
    racer:{key:'preserved-proof',status:'waiting',attempts:2}}}]));
  const stats={reads:0,writes:0,deletes:0};
  const env={__TEST_FIRESTORE:async(path,init={})=>{
    if(path===':commit'){
      const writes=JSON.parse(init.body).writes;
      for(const w of writes)assert.ok(w.currentDocument,'queue copy, delete and cursor are guarded together');
      for(const w of writes){
        const key=(w.delete||w.update.name).split('/documents/')[1];
        if(w.delete){stats.deletes++;state.delete(key);}
        else{stats.writes++;state.set(key,eventDecode({mapValue:{fields:w.update.fields}}));}
      }
      return {};
    }
    stats.reads++;
    const value=state.get(path.slice(1));
    return value?{fields:eventEncode(value).mapValue.fields,updateTime:'v1'}:null;
  }};
  assert.equal((await migrateExtraVerificationQueues(env,ids)).complete,false);
  assert.equal((await migrateExtraVerificationQueues(env,ids)).complete,true);
  assert.deepEqual(stats,{reads:12,writes:7,deletes:5});
  const before={...stats};
  await migrateExtraVerificationQueues(env,ids);
  assert.deepEqual(stats,{reads:13,writes:7,deletes:5});
  for(const id of ids){
    assert.equal(state.has(VERIFICATION_COLLECTION+'/'+id),false);
    assert.equal(state.get('0.6.2_s1_extra_verification/'+id).slots.racer.key,'preserved-proof');
  }
  process.stdout.write('QUOTA_A_DELETE_TRACE '+JSON.stringify({migration:before,completedPoll:{reads:1,writes:0,deletes:0}})+'\n');
});

for(const count of [201,300,512])test('quota A: global full intent drains '+count+' tracks while retained keyed work progresses early',async t=>{
  const f=await fixture(t,{count:1}),id=f.rows[0].accountId+'_'+track;
  const tracks=Array.from({length:count},(_,i)=>i===0?track:'quota-full-'+i);
  f.set(reconcileKey,{...f.data.get(reconcileKey),forceFullRebuildAll:true,pendingTrackIds:tracks,
    pendingFullRebuildTrackIds:[],pendingResultIds:{[track]:[id]},pendingResultBindings:{[id]:verificationKey(f.rows[0])}});
  let maxRequests=0;
  for(let pass=0;pass<count;pass++){
    const requests=f.stats.requests,queries=f.queries.length;
    const result=await reconcileCanonicalChanges(f.env,{scanResults:false});
    maxRequests=Math.max(maxRequests,f.stats.requests-requests);
    assert.ok(f.stats.requests-requests<=45);
    assert.equal(f.queries.length-queries,1,'each full intent scans once, never repeated by the legacy global flag');
    const job=f.data.get(reconcileKey);
    assert.equal(job.forceFullRebuildAll,false);
    assert.deepEqual(job.pendingFullRebuildTrackIds,tracks.slice(pass+1));
    if(pass===0){assert.deepEqual(job.pendingResultIds[track],[id]);assert.equal(result.targeted,0);}
    else{
      assert.equal(result.targeted,pass===1?1:0);
      assert.equal(job.pendingResultIds[track],undefined);
      assert.equal(job.pendingResultBindings[id],undefined);
      assert.equal(f.data.get(boardKey).entries[0].runVerified,true,'keyed discharge follows the fresh private proof');
    }
  }
  assert.deepEqual(f.data.get(reconcileKey).pendingTrackIds,[]);
  assert.equal(new Set(f.queries.map(q=>q.trackId)).size,count);
  assert.equal(f.data.get(reconcileKey).cursorDocumentId,'preserve-cursor');
  assert.equal(f.data.get(reconcileKey).backfillDocumentId,'preserve-backfill');
  assert.deepEqual(f.errors,[]);
  process.stdout.write('QUOTA_A_GLOBAL_FULL '+JSON.stringify({count,maxRequests,keyedDischargedOnPass:2})+'\n');
});
