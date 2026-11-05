import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Socket} from 'node:net';
import {readFileSync} from 'node:fs';
const identityBaseline=process.env.IDENTITY_BUILD_BASELINE;
const {default:rankedWorker,rebuildTrack, reconcileCanonicalChanges, updateTrackIdentity, computeTrackEntries, persistTrackSnapshot}=identityBaseline
  ?await import('data:text/javascript,'+encodeURIComponent(readFileSync(identityBaseline,'utf8')
    .replace(/from '(\.\/[^']+)'/g,(_,path)=>`from '${new URL('../src/'+path.slice(2),import.meta.url).href}'`)))
  :await import('../src/index.js');
import {eventEncode, eventDecode} from '../src/events-store.js';
import {pendingSlot, verificationKey, verificationSchedule, VERIFICATION_COLLECTION, VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION} from '../src/verification.js';
import {COMPETITIVE_REVIEW_REASON} from '../src/competitive-review.js';
import {PERMANENT_ROLLING_HILLS} from '../src/permanent-rolling-hills.js';
import {verificationShardId} from '../src/verification-shards.js';
import {preparePublicationPages, loadPublicationEntries, PUBLIC_PAGE_COLLECTION, PUBLIC_MANIFEST_COLLECTION} from '../src/paged-publication.js';
import {TRACK_BUILD_JOBS, TRACK_BUILD_PARTS, trackBuildId} from '../src/track-build.js';

const track = '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const base = 'projects/audit275-offline/databases/(default)/documents/';
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
  const now = Date.UTC(2026, 10, 3, 8);
  t.mock.method(Date, 'now', () => now);
  const data = new Map(), versions = new Map(), snapshots = new Map();
  const reads = [], queries = [], commits = [];
  const stats = {reads:0, writes:0, requests:0, fixedProof:0, currentProof:0, canonicalRows:0};
  let maxCheckpointBytes=0;
  let serial = 0;
  const version = key => versions.get(key) || '2026-11-03T07:00:00.000Z';
  const set = (key, value) => {
    data.set(key, structuredClone(value));
    versions.set(key, new Date(Date.UTC(2026, 10, 3, 7) + ++serial).toISOString());
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
      if(q.from[0].collectionId===TRACK_BUILD_JOBS){
        assert.equal(q.limit,1);assert.equal(q.where.fieldFilter.field.fieldPath,'active');
        const keys=[...data.keys()].filter(key=>key.startsWith(TRACK_BUILD_JOBS+'/')&&data.get(key).active===true);
        stats.reads+=Math.max(1,keys.length?1:0);return keys.slice(0,1).map(key=>({document:wire(key)}));
      }
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
      const readTime = body.readTime || new Date(now - 1000 + snapshots.size).toISOString();
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
      assert.ok(writes.length <= 32, 'every commit stays within the existing staging batch bound');
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
    if(control.beforeRead)control.beforeRead(key);
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
  const report = scenario => process.stdout.write('AUDIT275_COST ' + JSON.stringify({scenario, ...stats,
    canonicalQueries:queries.length, prefixQueries:queries.filter(q => !q.readTime).length}) + '\n');
  const finishFull = async () => {
    for (let pass = 0; pass < 20; pass++) {
      await reconcileCanonicalChanges(env, {scanResults:false});
      if (data.get(buildKey)?.complete === true) return;
    }
    assert.fail('full build did not finish');
  };
  return {data, env, rows, reads, queries, stats, commits, control, errors, finish, finishFull, identity, report, set,
    keys:{boardKey, buildKey}, maxCheckpointBytes:()=>maxCheckpointBytes,
    prior:key => ({data:structuredClone(data.get(key)), updateTime:version(key)})};
}

test('audit275: stationary 1136-row rebuild reads each historical and current proof once', async t => {
  const f = await fixture(t);
  await f.finish();
  assert.equal(f.stats.canonicalRows, population);
  assert.equal(f.stats.fixedProof, population);
  assert.equal(f.stats.currentProof, population);
  assert.equal(f.queries.filter(q => !q.readTime).length, 1);
  const entries = await loadPublicationEntries(f.data.get(boardKey), 'track', track,
    async (c, id) => ({data:f.data.get(c + '/' + id)}));
  assert.equal(entries.length, population);
  assert.ok(entries.every(row => row.runVerified));
  assert.deepEqual(f.errors, []);
  assert.deepEqual({reads:f.stats.reads,writes:f.stats.writes,requests:f.stats.requests},
    {reads:3472,writes:41,requests:93},'page batching and historical-root reuse do not skip any per-racer proof');
  const rootReads=f.reads.filter(read=>read.key===VERIFICATION_COLLECTION+'/'+track);
  assert.equal(rootReads.filter(read=>read.readTime).length,7,'one historical root per rebuild invocation');
  assert.equal(rootReads.filter(read=>!read.readTime).length,12,'current root stays fresh on every page');
  f.report('stationary-full-rebuild');
});

test('audit275: cosmetic fanout after 900 scanned rows invalidates the full-build base', async t => {
  const f = await fixture(t);
  for (let pass = 0; pass < 5; pass++) assert.equal((await rebuildTrack(f.env, track)).pending, true);
  const checkpoint = structuredClone(f.data.get(buildKey));
  assert.equal(checkpoint.sourceCount, 900);
  const updated = await updateTrackIdentity(f.env, track, f.identity);
  assert.equal(updated.changed, true);
  assert.equal((await rebuildTrack(f.env, track)).pending, true);
  assert.notEqual(f.data.get(buildKey).generation, checkpoint.generation);
  assert.equal(f.data.get(buildKey).sourceCount, 100, '900 rows of paid work are abandoned');
  await f.finish();
  assert.equal(f.stats.canonicalRows, population + 900);
  assert.equal(f.stats.fixedProof, population + 900);
  assert.equal(f.stats.currentProof, population + 900);
  assert.equal(f.data.get(boardKey).entries[0].name, f.identity.name);
  assert.deepEqual(f.errors, []);
  assert.deepEqual({reads:f.stats.reads,writes:f.stats.writes,requests:f.stats.requests},
    {reads:6215,writes:74,requests:163},'base-version restart remains mandatory; only repeated requests are coalesced');
  f.report('cosmetic-invalidates-900-row-prefix');
});

test('coordinated identity fanout preserves a live full build and applies after completion',async t=>{
  const f=await fixture(t);f.env.BACKGROUND_MAINTENANCE_MODE='coordinated';
  for(let pass=0;pass<5;pass++)await rebuildTrack(f.env,track);
  const checkpoint=structuredClone(f.data.get(buildKey)),board=structuredClone(f.data.get(boardKey));
  const before={...f.stats},result=await updateTrackIdentity(f.env,track,f.identity);
  if(!identityBaseline){
    assert.equal(result.reason,'active_track_build_identity');assert.equal(result.pending,true);
    assert.deepEqual(f.data.get(buildKey),checkpoint);assert.deepEqual(f.data.get(boardKey),board);
    assert.equal(f.stats.reads-before.reads,3);assert.equal(f.stats.writes,before.writes);
  }
  await f.finish();
  if(!identityBaseline)assert.equal(f.data.get(buildKey).generation,checkpoint.generation);
  if(!identityBaseline)assert.equal((await updateTrackIdentity(f.env,track,f.identity)).changed,true);
  assert.equal(f.data.get(boardKey).entries[0].name,f.identity.name);
  assert.equal(f.stats.canonicalRows,identityBaseline?2036:1136);
  assert.equal(f.stats.fixedProof,f.stats.canonicalRows);assert.equal(f.stats.currentProof,f.stats.canonicalRows);
  f.report(identityBaseline?'identity-gate-before':'identity-gate-after');
  assert.deepEqual({reads:f.stats.reads,writes:f.stats.writes,requests:f.stats.requests},identityBaseline
    ?{reads:6215,writes:74,requests:163}:{reads:3490,writes:56,requests:102});
  assert.deepEqual(f.errors,[]);
});

for(const shape of ['expired','unowned','base-changed','blocked','complete'])test('identity gate never strands '+shape+' build',async t=>{
  const f=await fixture(t);f.env.BACKGROUND_MAINTENANCE_MODE='coordinated';
  await rebuildTrack(f.env,track);
  if(shape==='expired')f.set(buildKey,{...f.data.get(buildKey),readTime:new Date(Date.now()-51*60000).toISOString()});
  if(shape==='unowned')f.set(reconcileKey,{...f.data.get(reconcileKey),activeFullRebuildTrackId:'other'});
  if(shape==='base-changed')f.set(buildKey,{...f.data.get(buildKey),baseVersion:'old-version'});
  if(shape==='blocked')f.set(buildKey,{...f.data.get(buildKey),blocked:true});
  if(shape==='complete')f.set(buildKey,{...f.data.get(buildKey),complete:true});
  assert.equal((await updateTrackIdentity(f.env,track,f.identity)).changed,true);
  assert.equal(f.data.get(boardKey).entries[0].name,f.identity.name);
});

test('scheduled identity deferral retains its durable job without heartbeat writes, including read failure recovery',{skip:!!identityBaseline},async t=>{
  const f=await fixture(t);f.env.BACKGROUND_MAINTENANCE_MODE='coordinated';
  for(let pass=0;pass<5;pass++)await rebuildTrack(f.env,track);
  const key=TRACK_BUILD_JOBS+'/profile_'+f.identity.accountId;
  const profile={kind:'profile',active:true,identity:f.identity,pendingTrackIds:[track],
    trackDiscovery:{version:1,complete:true,cursor:''},processed:0,changed:0};f.set(key,profile);
  const checkpoint=structuredClone(f.data.get(buildKey));
  const turn=async()=>{let done;rankedWorker.scheduled({cron:'2-59/5 * * * *',scheduledTime:420000},f.env,
    {waitUntil:p=>{done=p;}});await done;};
  let before={...f.stats};await turn();await turn();
  assert.equal(f.stats.reads-before.reads,8);assert.equal(f.stats.writes,before.writes);
  assert.deepEqual(f.data.get(key),profile);assert.deepEqual(f.data.get(buildKey),checkpoint);
  f.control.beforeRead=key=>{if(key===buildKey)throw Error('FIRESTORE_429');};before={...f.stats};
  await turn();assert.equal(f.stats.writes,before.writes);assert.deepEqual(f.data.get(key),profile);
  assert.equal(f.errors.length,1);f.control.beforeRead=null;await turn();
  await f.finish();assert.equal(f.data.get(buildKey).generation,checkpoint.generation);await turn();
  assert.equal(f.data.get(key).active,false);assert.deepEqual(f.data.get(key).pendingTrackIds,[]);
  assert.equal(f.data.get(boardKey).entries[0].name,f.identity.name);assert.equal(f.stats.canonicalRows,1136);
});

test('three paged identity updates retain unfinished work within the shared request cap',{skip:!!identityBaseline},async t=>{
  const f=await fixture(t);f.env.BACKGROUND_MAINTENANCE_MODE='coordinated';
  const ids=[track,'identity-second','identity-third'],source=f.data.get(boardKey);
  const all=await loadPublicationEntries(source,'track',track,async(c,id)=>({data:f.data.get(c+'/'+id)}));
  for(const id of ids.slice(1)){
    const entries=all.map(row=>({...row,trackId:id}));
    const paged=await preparePublicationPages('track',id,entries,{sourceRevision:1,sourceComplete:true});
    for(const doc of paged.documents)f.set(doc.collection+'/'+doc.id,doc.data);
    f.set(boards+'/'+id,{...source,trackId:id,entries:entries.slice(0,500),pagination:paged.pagination});
  }
  const key=TRACK_BUILD_JOBS+'/profile_'+f.identity.accountId;
  f.set(key,{kind:'profile',active:true,identity:f.identity,pendingTrackIds:ids,
    trackDiscovery:{version:1,complete:true,cursor:''},processed:0,changed:0});
  const turn=async()=>{const before=f.stats.requests;let done;
    rankedWorker.scheduled({cron:'2-59/5 * * * *',scheduledTime:420000},f.env,{waitUntil:p=>{done=p;}});await done;
    assert.ok(f.stats.requests-before<=43,'42 work requests plus the reserved job checkpoint');};
  f.control.beforeRead=key=>{if(key===boards+'/identity-third')throw Error('OVERALL_REQUEST_BUDGET_EXHAUSTED');};
  await turn();assert.equal(f.data.get(key).active,true);assert.deepEqual(f.data.get(key).pendingTrackIds,['identity-third']);
  f.control.beforeRead=null;
  await turn();assert.equal(f.data.get(key).active,false);assert.deepEqual(f.data.get(key).pendingTrackIds,[]);
  for(const id of ids)assert.equal(f.data.get(boards+'/'+id).entries[0].name,f.identity.name);
  assert.deepEqual(f.errors,[]);
});

const contains = (writes, key) => writes.some(w => w.update?.name.endsWith('/' + key));
const completed = (writes, key = buildKey) => writes.some(w => w.update?.name.endsWith('/' + key)
  && eventDecode({mapValue:{fields:w.update.fields}}).complete === true);

test('audit275: queue conflict rejects the whole final publication and retries without a full rescan', async t => {
  const f = await fixture(t);
  f.set(reconcileKey, {...f.data.get(reconcileKey), activeFullRebuildTrackId:track});
  let failed = false;
  f.control.beforeCommit = writes => {
    if (!failed && contains(writes, reconcileKey) && completed(writes)) {
      failed = true;
      throw Error('FIRESTORE_412');
    }
  };
  await assert.rejects(f.finish(true), /FIRESTORE_412/);
  assert.equal(f.data.get(buildKey).complete, false);
  assert.equal(f.data.get(boardKey).revision, 1);
  assert.deepEqual(f.data.get(reconcileKey).pendingFullRebuildTrackIds, [track]);
  assert.equal(f.stats.canonicalRows, population);
  const before = {...f.stats};
  f.control.beforeCommit = null;
  await f.finish(true);
  assert.equal(f.stats.canonicalRows - before.canonicalRows, 0);
  assert.equal(f.stats.fixedProof - before.fixedProof, 0);
  assert.equal(f.stats.currentProof - before.currentProof, 0);
  assert.equal(f.queries.filter(q => !q.readTime).length, 1);
  const final = f.commits.find(writes => completed(writes));
  assert.ok(contains(final, boardKey) && contains(final, reconcileKey) && contains(final, metaKey));
  assert.equal(f.data.get(reconcileKey).cursorDocumentId, 'preserve-cursor');
  assert.equal(f.data.get(reconcileKey).backfillDocumentId, 'preserve-backfill');
  assert.deepEqual(f.errors, []);
  f.report('atomic-final-conflict-retry');
  process.stdout.write('AUDIT275_RETRY_DELTA ' + JSON.stringify(Object.fromEntries(
    Object.entries(f.stats).map(([key, value]) => [key, value - before[key]]))) + '\n');
});

test('audit275: canonical caller owns initial enqueue without a nested queue CAS conflict', async t => {
  const f = await fixture(t);
  await reconcileCanonicalChanges(f.env, {scanResults:false});
  assert.equal(f.data.get(buildKey).sourceCount, 100);
  assert.equal(f.data.get(reconcileKey).activeFullRebuildTrackId, track);
  await f.finish(true);
  assert.equal(f.stats.canonicalRows, population, 'durable build checkpoint prevents a prefix rescan');
  assert.equal(f.queries.filter(q => !q.readTime).length, 1);
  assert.deepEqual(f.errors, []);
  f.report('atomic-canonical-full-rebuild');
});

test('audit275: lost page checkpoint retries only that 100-row page at the same readTime', async t => {
  const f = await fixture(t);
  await rebuildTrack(f.env, track);
  const checkpoint = structuredClone(f.data.get(buildKey));
  let failed = false;
  f.control.beforeCommit = writes => {
    if (!failed && writes.some(w => w.update.name.endsWith('/' + buildKey))) {
      failed = true;
      throw Error('FIRESTORE_412');
    }
  };
  await assert.rejects(rebuildTrack(f.env, track), /FIRESTORE_412/);
  assert.deepEqual(f.data.get(buildKey), checkpoint);
  f.control.beforeCommit = null;
  await f.finish();
  assert.equal(f.stats.canonicalRows, population + 100);
  assert.equal(f.stats.fixedProof, population + 100);
  assert.equal(f.stats.currentProof, population + 100);
  assert.equal(f.queries.filter(q => !q.readTime).length, 1);
  assert.deepEqual(f.errors, []);
  f.report('lost-page-checkpoint-bounded-retry');
});

test('audit275: lost final response leaves publication and discharge durable with no repeat scan', async t => {
  const f = await fixture(t);
  let failed = false;
  f.control.afterCommit = writes => {
    if (!failed && completed(writes)) {failed=true;throw Error('LOST_COMMIT_RESPONSE');}
  };
  await assert.rejects(f.finish(true), /LOST_COMMIT_RESPONSE/);
  assert.equal(f.data.get(buildKey).complete, true);
  assert.deepEqual(f.data.get(reconcileKey).pendingTrackIds, []);
  assert.equal(f.data.get(boardKey).revision, 2);
  const before = {...f.stats};
  await f.finish(true);
  assert.equal(f.stats.reads - before.reads, 1);
  assert.equal(f.stats.writes - before.writes, 0);
  assert.equal(f.stats.canonicalRows, population);
  f.report('lost-response-durable-atomic-commit');
});

test('audit275: concurrent newer PB binding survives fresh retry of the older full snapshot', async t => {
  const f = await fixture(t), resultId = f.rows[0].accountId + '_' + track;
  const newer = {...f.rows[0], timeMs:9000, frames:9000, raceTimeFrames:9000, uploadId:2};
  let raced = false;
  f.control.beforeCommit = writes => {
    if (!raced && completed(writes)) {
      raced=true;
      f.set(results + '/' + resultId, newer);
      f.set(reconcileKey, {...f.data.get(reconcileKey), pendingResultIds:{[track]:[resultId]},
        pendingResultBindings:{[resultId]:verificationKey(newer)}});
    }
  };
  await assert.rejects(f.finish(true), /FIRESTORE_412/);
  assert.equal(f.data.get(boardKey).revision, 1);
  assert.equal(f.data.get(buildKey).complete, false);
  const generation = f.data.get(buildKey).generation;
  await f.finishFull();
  assert.equal(f.data.get(buildKey).generation, generation);
  const queued = f.data.get(reconcileKey);
  assert.deepEqual(queued.pendingResultIds[track], [resultId]);
  assert.equal(queued.pendingResultBindings[resultId], verificationKey(newer));
  assert.deepEqual(queued.pendingFullRebuildTrackIds, []);
  assert.equal(f.data.get(boardKey).entries[0].timeMs, 10000, 'fixed snapshot does not include the later PB');
  await f.finish(true);
  assert.equal(f.data.get(boardKey).entries[0].timeMs, 9000);
  assert.equal(f.data.get(boardKey).entries[0].runVerified, false, 'old proof cannot verify the new PB');
  assert.deepEqual(f.data.get(reconcileKey).pendingResultBindings, {});
  assert.equal(f.queries.filter(q => !q.readTime).length, 1);
});

for (const conflict of ['root', 'meta', 'queue-sibling']) test('audit275: concurrent ' + conflict + ' change rejects final CAS', async t => {
  const f = await fixture(t), sibling = 'sibling-track', siblingId = 'other_' + sibling;
  let raced = false, expected;
  const key = conflict === 'root' ? boardKey : conflict === 'meta' ? metaKey : reconcileKey;
  f.control.beforeCommit = writes => {
    if (!raced && completed(writes)) {
      raced=true;
      expected = conflict === 'queue-sibling'
        ? {...f.data.get(key), pendingTrackIds:[track,sibling], pendingResultIds:{[sibling]:[siblingId]}, pendingResultBindings:{[siblingId]:'newest-binding'}}
        : {...f.data.get(key), revision:999, newerMarker:true};
      f.set(key, expected);
    }
  };
  await assert.rejects(f.finish(true), /FIRESTORE_412/);
  assert.deepEqual(f.data.get(key), expected);
  assert.equal(f.data.get(buildKey).complete, false);
  if (conflict !== 'root') assert.equal(f.data.get(boardKey).revision, 1);
  const generation = f.data.get(buildKey).generation;
  if (conflict === 'root') {
    await reconcileCanonicalChanges(f.env, {scanResults:false});
    assert.notEqual(f.data.get(buildKey).generation, generation);
    assert.equal(f.queries.filter(q => !q.readTime).length, 2, 'a changed root still requires a fresh snapshot');
  } else {
    await f.finishFull();
    assert.equal(f.data.get(buildKey).generation, generation);
    if (conflict === 'meta') assert.equal(f.data.get(metaKey).newerMarker, true);
    else {
      assert.deepEqual(f.data.get(reconcileKey).pendingTrackIds, [sibling]);
      assert.equal(f.data.get(reconcileKey).pendingResultBindings[siblingId], 'newest-binding');
    }
  }
});

test('audit275: unchanged full-build signature still completes only with queue discharge', async t => {
  const f = await fixture(t);
  await f.finish();
  const signature = f.data.get(boardKey).signature;
  f.set(reconcileKey, {...f.data.get(reconcileKey), pendingTrackIds:[track], pendingFullRebuildTrackIds:[track], activeFullRebuildTrackId:track});
  let rejected = false;
  f.control.beforeCommit = writes => {
    if (!rejected && completed(writes)) {rejected=true;throw Error('FIRESTORE_412');}
  };
  await assert.rejects(f.finish(true), /FIRESTORE_412/);
  assert.equal(f.data.get(buildKey).complete, false);
  assert.equal(f.data.get(boardKey).signature, signature);
  await f.finish(true);
  assert.equal(f.data.get(boardKey).signature, signature);
  for (const writes of f.commits.filter(writes => completed(writes))) {
    if (contains(writes, reconcileKey)) assert.ok(contains(writes, boardKey));
  }
});

test('audit275: current proof holds are not replaced by historical scoring proofs', async t => {
  const f = await fixture(t), row = f.rows[200];
  await reconcileCanonicalChanges(f.env, {scanResults:false});
  const key = VERIFICATION_COLLECTION + '/' + verificationShardId(track, row.accountId);
  const hold = {...pendingSlot(row), status:'unavailable', reason:COMPETITIVE_REVIEW_REASON, retryAt:Number.MAX_SAFE_INTEGER};
  f.set(key, {...f.data.get(key), slots:{[row.accountId]:hold}});
  await f.finish(true);
  assert.deepEqual(f.data.get(key).slots[row.accountId], hold);
  assert.equal(f.stats.fixedProof, population);
  assert.equal(f.stats.currentProof, population);
  assert.equal(f.data.get(boardKey).entries.find(entry => entry.accountId === row.accountId).runVerified, true,
    'historical scoring uses the old proof while current queue preparation preserves the newer hold');
});

test('audit275: Rolling final commit includes its extra invalidation within six writes', async t => {
  const f = await fixture(t, {trackId:PERMANENT_ROLLING_HILLS.trackId, count:501});
  await f.finish(true);
  const writes = f.commits.find(writes => completed(writes, f.keys.buildKey));
  assert.equal(writes.length, 6);
  const invalidation = writes.find(w => w.update.name.endsWith('/0.6.2_event_public/totals'));
  assert.ok(invalidation);
  assert.equal(eventDecode({mapValue:{fields:invalidation.update.fields}}).publicationPending, true);
});

test('audit275: direct unchanged-signature no-op does not add queue or build writes', async t => {
  const f = await fixture(t, {count:29});
  await f.finish();
  const before = f.stats.writes, prior = f.prior(boardKey);
  const result = await persistTrackSnapshot(f.env, track, prior.data.entries, prior);
  assert.equal(result.changed, false);
  assert.equal(f.stats.writes, before);
});

test('audit275: discovered post-snapshot PB survives cursor advancement and full completion', async t => {
  const f = await fixture(t), resultId = f.rows[0].accountId + '_' + track;
  await reconcileCanonicalChanges(f.env, {scanResults:false});
  const newer = {...f.rows[0], timeMs:8000, frames:8000, raceTimeFrames:8000, uploadId:3};
  f.set(results + '/' + resultId, newer);
  const ingestedAt = '2026-11-03T08:00:00.000Z';
  f.control.discovery.push({key:results + '/' + resultId, ingestedAt});
  await reconcileCanonicalChanges(f.env);
  assert.deepEqual(f.data.get(reconcileKey).pendingResultIds[track], [resultId]);
  assert.equal(f.data.get(reconcileKey).cursorIngestedAt, ingestedAt);
  assert.equal(f.data.get(reconcileKey).cursorDocumentId, resultId);
  await f.finishFull();
  assert.deepEqual(f.data.get(reconcileKey).pendingResultIds[track], [resultId]);
  assert.equal(f.data.get(boardKey).entries[0].timeMs, 10000);
  await f.finish(true);
  assert.equal(f.data.get(boardKey).entries[0].timeMs, 8000);
  assert.equal(f.queries.filter(q => !q.readTime).length, 1);
});

test('audit275: full target capacity defers discovery cursor instead of losing later work', async t => {
  const f = await fixture(t), resultId = f.rows[200].accountId + '_' + track;
  await reconcileCanonicalChanges(f.env, {scanResults:false});
  const ids = f.rows.slice(0,200).map(row => row.accountId + '_' + track);
  f.set(reconcileKey, {...f.data.get(reconcileKey), pendingResultIds:{[track]:ids}});
  const before = structuredClone(f.data.get(reconcileKey));
  f.control.discovery.push({key:results + '/' + resultId});
  await reconcileCanonicalChanges(f.env);
  assert.equal(f.data.get(reconcileKey).cursorIngestedAt, before.cursorIngestedAt);
  assert.equal(f.data.get(reconcileKey).cursorDocumentId, before.cursorDocumentId);
  assert.deepEqual(f.data.get(reconcileKey).pendingResultIds[track], ids);
  await f.finishFull();
  assert.deepEqual(f.data.get(reconcileKey).pendingResultIds[track], ids);
  const count = f.stats.canonicalRows;
  const result = await reconcileCanonicalChanges(f.env, {scanResults:false});
  assert.equal(result.targeted,16);
  assert.equal(f.data.get(reconcileKey).pendingResultIds[track].length,184);
  assert.equal(f.stats.canonicalRows,count);
});

test('audit275: bounded force-full conversion leaves retained IDs eligible for keyed merge', async t => {
  const f = await fixture(t), resultId = f.rows[0].accountId + '_' + track;
  f.set(reconcileKey, {...f.data.get(reconcileKey), forceFullRebuildAll:true,
    pendingFullRebuildTrackIds:[], pendingResultIds:{[track]:[resultId]}, pendingResultBindings:{[resultId]:verificationKey(f.rows[0])}});
  await f.finishFull();
  assert.equal(f.data.get(reconcileKey).forceFullRebuildAll,false);
  assert.deepEqual(f.data.get(reconcileKey).pendingFullRebuildTrackIds,[]);
  assert.deepEqual(f.data.get(reconcileKey).pendingResultIds[track],[resultId]);
  const rows = f.stats.canonicalRows;
  await f.finish(true);
  assert.equal(f.stats.canonicalRows,rows);
});

test('audit275: repeated metadata bumps never overwrite a newer preimage or restart canonical scan', async t => {
  const f = await fixture(t);
  let conflicts = 0;
  f.control.beforeCommit = writes => {
    if (completed(writes) && conflicts < 3) {
      conflicts++;
      f.set(metaKey, {...f.data.get(metaKey), revision:1000+conflicts, newerMarker:conflicts});
    }
  };
  for(let i=0;i<3;i++) {
    await assert.rejects(f.finish(true), /FIRESTORE_412/);
    assert.equal(f.data.get(metaKey).revision,1001+i);
    assert.equal(f.data.get(boardKey).revision,1);
    assert.equal(f.data.get(buildKey).complete,false);
  }
  await f.finish(true);
  assert.equal(f.data.get(metaKey).newerMarker,3);
  assert.ok(f.data.get(metaKey).revision>=1003);
  assert.equal(f.stats.canonicalRows,population);
  assert.equal(f.queries.filter(q => !q.readTime).length,1);
});

test('audit275: targeted sibling publishes with fresh proof before full continuation and is discharged once', async t => {
  const f = await fixture(t), sibling = 'sibling-track';
  const row = {...f.rows[0], accountId:'sibling-racer', trackId:sibling};
  const id = row.accountId + '_' + sibling, binding = verificationKey(row);
  f.set(results + '/' + id,row);
  const proof={...pendingSlot(row),status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION};
  f.set(VERIFICATION_COLLECTION+'/'+sibling,{trackId:sibling,slots:{[row.accountId]:proof}});
  f.set(boards + '/' + sibling,{trackId:sibling,entries:[],complete:true,sourceComplete:true,
    totalEntries:0,revision:1,signature:'empty-sibling',schemaVersion:6,algorithmVersion:'participation-v8-s1'});
  f.set(reconcileKey,{...f.data.get(reconcileKey),pendingTrackIds:[track,sibling],pendingResultIds:{[sibling]:[id]},
    pendingResultBindings:{[id]:binding},opaqueCursorMarker:'preserve'});
  const result=await reconcileCanonicalChanges(f.env,{scanResults:false});
  assert.equal(result.targeted,1);
  const entry=f.data.get(boards+'/'+sibling).entries[0];
  assert.equal(entry.accountId,row.accountId);
  assert.equal(entry.timeMs,row.timeMs);
  assert.equal(entry.integrityVerified,true);
  assert.equal(entry.runVerified,true,'early publication still requires its exact private proof');
  assert.equal(proof.key,binding);
  assert.ok(f.reads.some(read=>read.key===results+'/'+id&&!read.readTime),'target reads fresh canonical data');
  assert.ok(f.reads.some(read=>read.key===VERIFICATION_COLLECTION+'/'+sibling&&!read.readTime),'target reads current private proof');
  assert.equal(f.data.get(buildKey).sourceCount,100);
  assert.equal(f.data.get(buildKey).complete,false,'target progresses before the full build finishes');
  assert.deepEqual(f.data.get(reconcileKey).pendingTrackIds,[track]);
  assert.deepEqual(f.data.get(reconcileKey).pendingFullRebuildTrackIds,[track]);
  assert.deepEqual(f.data.get(reconcileKey).pendingResultIds,{});
  assert.deepEqual(f.data.get(reconcileKey).pendingResultBindings,{});
  const siblingRevision=f.data.get(boards+'/'+sibling).revision;
  await f.finishFull();
  assert.deepEqual(f.data.get(reconcileKey).pendingTrackIds,[]);
  assert.deepEqual(f.data.get(reconcileKey).pendingFullRebuildTrackIds,[]);
  assert.equal(f.data.get(boards+'/'+sibling).revision,siblingRevision,'full continuation does not republish the discharged sibling');
  assert.equal(f.stats.canonicalRows,population);
  assert.equal(f.stats.fixedProof,population);
  assert.equal(f.stats.currentProof,population);
  assert.equal(f.queries.filter(q=>!q.readTime).length,1);
  assert.ok(f.queries.every(q=>q.trackId===track),'the targeted sibling never receives a full scan');
  const before={...f.stats};
  assert.equal((await reconcileCanonicalChanges(f.env,{scanResults:false})).targeted,0);
  assert.equal(f.stats.reads-before.reads,1);
  assert.equal(f.stats.writes-before.writes,0);
  assert.equal(f.data.get(reconcileKey).opaqueCursorMarker,'preserve');
  assert.equal(f.data.get(reconcileKey).cursorDocumentId,'preserve-cursor');
  assert.equal(f.data.get(reconcileKey).backfillDocumentId,'preserve-backfill');
  assert.deepEqual(f.errors,[]);
});

test('audit275: unchanged single-page canonical rebuild checkpoints its no-op without republishing', async t => {
  const f=await fixture(t,{count:29});
  await f.finish();
  const prior=structuredClone(f.data.get(boardKey)),before=f.stats.writes;
  await f.finish(true);
  assert.deepEqual(f.data.get(boardKey),prior);
  assert.equal(f.stats.writes-before,1,'only queue discharge writes; there is no build completion to mark separately');
  assert.deepEqual(f.data.get(reconcileKey).pendingTrackIds,[]);
});

test('audit275: global full intent expands once for primary and siblings without re-forcing retained targets', async t => {
  const f=await fixture(t),sibling='global-full-sibling',id=f.rows[0].accountId+'_'+track;
  const siblingRow={...f.rows[0],accountId:'sibling-racer',trackId:sibling};
  f.set(results+'/'+siblingRow.accountId+'_'+sibling,siblingRow);
  f.set(reconcileKey,{...f.data.get(reconcileKey),forceFullRebuildAll:true,pendingTrackIds:[track,sibling],
    pendingFullRebuildTrackIds:[],pendingResultIds:{[track]:[id]},pendingResultBindings:{[id]:verificationKey(f.rows[0])},
    failedFullRebuilds:{[sibling]:{attempts:1,retryAt:Date.now()+60000}}});
  await f.finishFull();
  const queued=f.data.get(reconcileKey);
  assert.equal(queued.forceFullRebuildAll,false);
  assert.deepEqual(queued.pendingFullRebuildTrackIds,[sibling]);
  assert.deepEqual(queued.pendingResultIds[track],[id]);
  assert.equal(queued.pendingResultBindings[id],verificationKey(f.rows[0]));
  const count=f.queries.length;
  const next=await reconcileCanonicalChanges(f.env,{scanResults:false});
  assert.equal(next.targeted,1,'completed track receives only a fresh keyed merge next turn');
  assert.equal(f.queries.length,count,'no second full scan of the completed track');
  assert.deepEqual(f.data.get(reconcileKey).pendingFullRebuildTrackIds,[sibling]);
  assert.deepEqual(f.data.get(reconcileKey).pendingTrackIds,[sibling]);
  f.set(reconcileKey,{...f.data.get(reconcileKey),failedFullRebuilds:{}});
  await reconcileCanonicalChanges(f.env,{scanResults:false});
  assert.equal(f.queries.filter(q=>q.trackId===sibling).length,1,'original sibling full repair intent is not lost');
  assert.deepEqual(f.data.get(reconcileKey).pendingFullRebuildTrackIds,[]);
  assert.deepEqual(f.data.get(reconcileKey).pendingTrackIds,[]);
});

test('audit275: empty global force is durably consumed rather than inherited by future work',async t=>{
  const f=await fixture(t);
  f.set(reconcileKey,{...f.data.get(reconcileKey),forceFullRebuildAll:true,pendingTrackIds:[],pendingFullRebuildTrackIds:[]});
  await reconcileCanonicalChanges(f.env,{scanResults:false});
  assert.equal(f.data.get(reconcileKey).forceFullRebuildAll,false);
  assert.equal(f.queries.length,0);
});

for(const count of [201,300,512])test('audit275: '+count+' legacy global full requests drain once with bounded turns and no target loss',async t=>{
  const f=await fixture(t,{count:1}),id=f.rows[0].accountId+'_'+track;
  const ids=Array.from({length:count},(_,i)=>i===0?track:('legacy-track-'+String(i).padStart(4,'0')).padEnd(80,'x'));
  const binding=verificationKey(f.rows[0]);
  f.set(reconcileKey,{...f.data.get(reconcileKey),forceFullRebuildAll:true,pendingTrackIds:ids,pendingFullRebuildTrackIds:[],
    pendingResultIds:{[track]:[id]},pendingResultBindings:{[id]:binding}});
  let maxRequests=0,maxReads=0,maxWrites=0;
  for(let pass=0;pass<count;pass++) {
    const before={...f.stats},queries=f.queries.length,readStart=f.reads.length;
    const result=await reconcileCanonicalChanges(f.env,{scanResults:false});
    maxRequests=Math.max(maxRequests,f.stats.requests-before.requests);
    maxReads=Math.max(maxReads,f.stats.reads-before.reads);
    maxWrites=Math.max(maxWrites,f.stats.writes-before.writes);
    assert.ok(f.stats.requests-before.requests<=45,'catalog capacity does not expand the per-pass request budget');
    assert.ok(f.stats.writes-before.writes<=6,'each pass retains the existing final-write cap');
    assert.equal(f.queries.length-queries,1,'each turn performs exactly one full source query');
    assert.equal(f.data.get(reconcileKey).forceFullRebuildAll,false,'explicit flags are not folded back into global force at 200');
    assert.deepEqual(f.data.get(reconcileKey).pendingFullRebuildTrackIds,ids.slice(pass+1));
    assert.deepEqual(f.data.get(reconcileKey).pendingTrackIds,[...ids.slice(pass+1),...(pass===0?[track]:[])]);
    if(pass===0){
      assert.equal(result.targeted,0);
      assert.deepEqual(f.data.get(reconcileKey).pendingResultIds[track],[id]);
      assert.equal(f.data.get(reconcileKey).pendingResultBindings[id],binding);
    }else{
      assert.equal(result.targeted,pass===1?1:0,'retained keyed work progresses on the next turn, not after the entire full queue');
      assert.deepEqual(f.data.get(reconcileKey).pendingResultIds,{});
      assert.deepEqual(f.data.get(reconcileKey).pendingResultBindings,{});
      assert.equal(f.data.get(boardKey).entries[0].runVerified,true);
      const proofKey=VERIFICATION_COLLECTION+'/'+verificationShardId(track,f.rows[0].accountId);
      assert.equal(f.data.get(proofKey).slots[f.rows[0].accountId].key,binding);
      if(pass===1){
        const freshReads=f.reads.slice(readStart).filter(read=>!read.readTime);
        assert.ok(freshReads.some(read=>read.key===results+'/'+id));
        assert.ok(freshReads.some(read=>read.key===proofKey),'keyed discharge uses the current proof, not the completed full snapshot');
      }
    }
  }
  assert.deepEqual(f.data.get(reconcileKey).pendingTrackIds,[]);
  const queries=f.queries.length,before={...f.stats};
  const last=await reconcileCanonicalChanges(f.env,{scanResults:false});
  assert.equal(last.targeted,0);
  assert.equal(last.unchanged,true);
  assert.equal(f.stats.reads-before.reads,1);
  assert.equal(f.stats.writes-before.writes,0);
  assert.equal(f.queries.length,queries,'completed work never starts another full scan');
  assert.equal(f.queries.length,count);
  assert.equal(new Set(f.queries.map(q=>q.trackId)).size,count);
  assert.deepEqual(f.data.get(reconcileKey).pendingTrackIds,[]);
  assert.deepEqual(f.data.get(reconcileKey).pendingFullRebuildTrackIds,[]);
  assert.deepEqual(f.data.get(reconcileKey).pendingResultBindings,{});
  assert.equal(f.data.get(reconcileKey).cursorDocumentId,'preserve-cursor');
  assert.equal(f.data.get(reconcileKey).backfillDocumentId,'preserve-backfill');
  assert.deepEqual(f.errors,[]);
  process.stdout.write('AUDIT275_LEGACY_CAPACITY '+JSON.stringify({count,maxRequests,maxReads,maxWrites,maxCheckpointBytes:f.maxCheckpointBytes()})+'\n');
});

test('audit275: legacy catalog capacity is independent of the 200 keyed-ID capacity',async t=>{
  const f=await fixture(t,{count:1}),ids=Array.from({length:512},(_,i)=>i===0?track:('legacy-full-'+i).padEnd(80,'x'));
  const targetIds=Array.from({length:200},(_,i)=>('racer-'+i).padEnd(128,'x')+'_'+track);
  const bindings=Object.fromEntries(targetIds.map(id=>[id,'b'.repeat(1024)]));
  f.set(reconcileKey,{...f.data.get(reconcileKey),forceFullRebuildAll:true,pendingTrackIds:ids,pendingFullRebuildTrackIds:[],
    pendingResultIds:{[track]:targetIds},pendingResultBindings:bindings});
  await reconcileCanonicalChanges(f.env,{scanResults:false});
  assert.deepEqual(f.data.get(reconcileKey).pendingFullRebuildTrackIds,ids.slice(1));
  assert.deepEqual(f.data.get(reconcileKey).pendingResultIds[track],targetIds);
  assert.deepEqual(f.data.get(reconcileKey).pendingResultBindings,bindings);
  assert.ok(f.maxCheckpointBytes()<=800000);
  process.stdout.write('AUDIT275_WORST_JOB_BYTES '+f.maxCheckpointBytes()+'\n');
});

test('audit275: checkpoint byte budget fails before atomic publication instead of writing an oversized job',async t=>{
  const f=await fixture(t,{count:1});
  f.set(reconcileKey,{...f.data.get(reconcileKey),extraField:'x'.repeat(800000)});
  const job=structuredClone(f.data.get(reconcileKey)),board=structuredClone(f.data.get(boardKey));
  await assert.rejects(reconcileCanonicalChanges(f.env,{scanResults:false}),/RECONCILE_JOB_DOCUMENT_BUDGET/);
  assert.deepEqual(f.data.get(reconcileKey),job);
  assert.deepEqual(f.data.get(boardKey),board);
  assert.equal(f.stats.writes,0);
});

test('audit275: full-track bound above the supported legacy catalog fails without losing repair intent',async t=>{
  const f=await fixture(t,{count:1}),ids=Array.from({length:513},(_,i)=>'legacy-track-'+i);
  f.set(reconcileKey,{...f.data.get(reconcileKey),forceFullRebuildAll:true,pendingTrackIds:ids,pendingFullRebuildTrackIds:[]});
  const before=structuredClone(f.data.get(reconcileKey));
  await assert.rejects(reconcileCanonicalChanges(f.env,{scanResults:false}),/RECONCILE_FULL_REBUILD_QUEUE_CAPACITY/);
  assert.deepEqual(f.data.get(reconcileKey),before);
  assert.equal(f.queries.length,0);
  assert.equal(f.stats.writes,0);
});
