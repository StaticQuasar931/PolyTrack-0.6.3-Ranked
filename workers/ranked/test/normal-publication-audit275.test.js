import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Socket} from 'node:net';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const identityBaseline=process.env.IDENTITY_BUILD_BASELINE;
const proofBaseline=process.env.PROOF_REUSE_BASELINE==='1';
const baseline=Boolean(identityBaseline||proofBaseline);
const baselineSource=proofBaseline?execFileSync('git',['show','f1d9ff030:workers/ranked/src/index.js'],{encoding:'utf8'})
  :identityBaseline?readFileSync(identityBaseline,'utf8'):null;
const {default:rankedWorker,rebuildTrack, reconcileCanonicalChanges, updateTrackIdentity, computeTrackEntries, persistTrackSnapshot}=baseline
  ?await import('data:text/javascript,'+encodeURIComponent(baselineSource
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
    // Writes after snapshot creation must have later versions than that snapshot.
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
  const control = {beforeCommit:null, afterCommit:null, discovery:[], discoveryQueries:[]};
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
        assert.equal(q.limit,1);
        if(q.where.fieldFilter.field.fieldPath==='profileRetryAt'){
          const keys=[...data.keys()].filter(key=>key.startsWith(TRACK_BUILD_JOBS+'/')&&Number.isSafeInteger(data.get(key).profileRetryAt)&&data.get(key).profileRetryAt<=now).sort((a,b)=>data.get(a).profileRetryAt-data.get(b).profileRetryAt||a.localeCompare(b));
          stats.reads+=Math.max(1,Math.min(keys.length,1));return keys.slice(0,1).map(key=>({document:wire(key)}));
        }
        assert.equal(q.where.fieldFilter.field.fieldPath,'active');
        const keys=[...data.keys()].filter(key=>key.startsWith(TRACK_BUILD_JOBS+'/')&&data.get(key).active===true);
        stats.reads+=Math.max(1,keys.length?1:0);return keys.slice(0,1).map(key=>({document:wire(key)}));
      }
      assert.equal(q.from[0].collectionId, results);
      if (q.where?.fieldFilter?.field?.fieldPath !== 'trackId') {
        control.discoveryQueries.push(structuredClone(q));
        if(control.legacyDiscovery&&!q.where){
          const after=(q.startAt?.values?.[0]?.referenceValue||'').split('/documents/').at(-1);
          const found=control.legacyDiscovery.filter(key=>!after||key>after).sort().slice(0,q.limit);
          stats.reads+=Math.max(1,found.length);
          return found.map(key=>({document:wire(key)}));
        }
        const since=q.where?.fieldFilter?.value?.timestampValue || '';
        const after=(q.startAt?.values?.[1]?.referenceValue || '').split('/documents/').at(-1);
        const found = control.cursorDiscovery
          ? control.discovery.filter(row=>(row.ingestedAt || new Date(now).toISOString())>=since &&
              (!after || (row.ingestedAt || new Date(now).toISOString())>since || row.key>after))
            .sort((a,b)=>(a.ingestedAt || '').localeCompare(b.ingestedAt || '') || a.key.localeCompare(b.key))
            .slice(0,control.discoveryLimitOverride || q.limit)
          : control.discovery.splice(0, q.limit);
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
      assert.ok(writes.length <= (proofBatch ? 49 : 32), 'proof migration and publication staging retain their existing bounds');
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
  return {data, versions, snapshots, env, rows, reads, queries, stats, commits, control, errors, finish, finishFull, identity, report, set, advance:ms=>{now+=ms;},
    keys:{boardKey, buildKey}, maxCheckpointBytes:()=>maxCheckpointBytes,
    prior:key => ({data:structuredClone(data.get(key)), updateTime:version(key)})};
}

test('audit275: stationary 1136-row rebuild reuses proven history but reads every current proof', async t => {
  const f = await fixture(t);
  const original = await loadPublicationEntries(f.data.get(boardKey), 'track', track,
    async (c, id) => ({data:f.data.get(c + '/' + id)}));
  await f.finish();
  assert.equal(f.stats.canonicalRows, population);
  assert.equal(f.stats.fixedProof, baseline ? population : 0);
  assert.equal(f.stats.currentProof, population);
  assert.equal(f.queries.filter(q => !q.readTime).length, 1);
  const entries = await loadPublicationEntries(f.data.get(boardKey), 'track', track,
    async (c, id) => ({data:f.data.get(c + '/' + id)}));
  assert.equal(entries.length, population);
  assert.ok(entries.every(row => row.runVerified));
  assert.deepEqual(entries, original, 'reuse preserves the full published field, not only counts');
  assert.equal(f.reads.some(read=>/profiles|entitlement/.test(read.key)), false,
    'this full track rebuild never reads profiles or cosmetic entitlements');
  assert.deepEqual(f.errors, []);
  assert.deepEqual({reads:f.stats.reads,writes:f.stats.writes,requests:f.stats.requests},
    baseline ? {reads:3472,writes:41,requests:93} : {reads:2329,writes:41,requests:74},
    'unchanged versions eliminate redundant history reads, not current per-racer proofs');
  const rootReads=f.reads.filter(read=>read.key===VERIFICATION_COLLECTION+'/'+track);
  assert.equal(rootReads.filter(read=>read.readTime).length,baseline ? 7 : 0);
  assert.equal(rootReads.filter(read=>!read.readTime).length,12,'current root stays fresh on every page');
  f.report('stationary-full-rebuild');
});

for (const rolling of [false,true]) test('quota identical full rebuild reuses publication and preserves final root fence: '+rolling,async t=>{
  const f=await fixture(t,{trackId:rolling?PERMANENT_ROLLING_HILLS.trackId:track,count:1136});
  await f.finish(true);
  const key=f.keys.boardKey,oldBoard=structuredClone(f.data.get(key));
  const oldMeta=structuredClone(f.data.get(metaKey));
  const totalKey='0.6.2_event_public/totals',oldTotals=structuredClone(f.data.get(totalKey));
  const id=rolling?PERMANENT_ROLLING_HILLS.trackId:track;
  f.set(reconcileKey,{...f.data.get(reconcileKey),pendingTrackIds:[id],pendingFullRebuildTrackIds:[id],activeFullRebuildTrackId:id});
  const before={...f.stats},first=f.commits.length;
  await f.finish(true);
  const delta=Object.fromEntries(Object.keys(before).map(k=>[k,f.stats[k]-before[k]]));
  assert.deepEqual({reads:delta.reads,writes:delta.writes},baseline
    ? {reads:2330+Number(rolling),writes:47+Number(rolling)} : {reads:2329,writes:33});
  assert.equal(delta.canonicalRows,1136); assert.equal(delta.currentProof,1136);
  const final=f.commits.slice(first).find(w=>completed(w,f.keys.buildKey));
  assert.ok(contains(final,key)); assert.ok(contains(final,reconcileKey));
  if(!baseline){
    assert.equal(final.length,3,'completion, unchanged root CAS, queue discharge');
    assert.deepEqual(f.data.get(key),oldBoard);
    assert.deepEqual(f.data.get(metaKey),oldMeta);
    assert.deepEqual(f.data.get(totalKey),oldTotals);
    assert.equal(f.commits.slice(first).flat().filter(w=>w.update.name.includes('/'+PUBLIC_PAGE_COLLECTION+'/')).length,0);
  }
  process.stdout.write('QUOTA_IDENTICAL_REBUILD_COST '+JSON.stringify({baseline,rolling,...delta})+'\n');
});

test('quota equal signature cannot hide changed full-field metadata',async t=>{
  const f=await fixture(t); await f.finish(true);
  const signature=f.data.get(boardKey).signature,revision=f.data.get(boardKey).revision;
  const r=f.rows[0]; f.set(results+'/'+r.accountId+'_'+track,{...r,pbCount:9});
  f.set(reconcileKey,{...f.data.get(reconcileKey),pendingTrackIds:[track],pendingFullRebuildTrackIds:[track],activeFullRebuildTrackId:track});
  await f.finish(true);
  assert.equal(f.data.get(boardKey).signature,signature,'pbCount is not part of the legacy signature');
  assert.equal(f.data.get(boardKey).revision,revision+1);
  assert.equal(f.data.get(boardKey).entries[0].pbCount,9);
});

for(const conflict of ['root','queue','lost-response'])test('quota identical full rebuild retains atomic recovery: '+conflict,async t=>{
  const f=await fixture(t); await f.finish(true);
  const old=structuredClone(f.data.get(boardKey));
  f.set(reconcileKey,{...f.data.get(reconcileKey),pendingTrackIds:[track],pendingFullRebuildTrackIds:[track],activeFullRebuildTrackId:track});
  let fired=false;
  if(conflict==='lost-response')f.control.afterCommit=writes=>{
    if(!fired&&completed(writes)){fired=true;throw Error('FIRESTORE_503');}
  };
  else f.control.beforeCommit=writes=>{
    if(!fired&&completed(writes)){
      fired=true;
      if(conflict==='root')f.set(boardKey,{...f.data.get(boardKey),revision:old.revision+1,marker:'newer'});
      else f.set(reconcileKey,{...f.data.get(reconcileKey),marker:'newer'});
    }
  };
  await assert.rejects(f.finish(true),conflict==='lost-response'?/FIRESTORE_503/:/FIRESTORE_412/);
  assert.equal(fired,true);
  if(conflict==='lost-response'){
    assert.equal(f.data.get(f.keys.buildKey).complete,true);
    assert.deepEqual(f.data.get(reconcileKey).pendingTrackIds,[]);
    const before={...f.stats};await f.finish(true);
    assert.equal(f.stats.reads-before.reads,1);assert.equal(f.stats.writes-before.writes,0);
  }else{
    assert.equal(f.data.get(f.keys.buildKey).complete,false);
    assert.deepEqual(f.data.get(reconcileKey).pendingTrackIds,[track]);
    if(conflict==='root')assert.equal(f.data.get(boardKey).marker,'newer');
    else assert.deepEqual(f.data.get(boardKey),old);
  }
});

for (const mode of ['newer-review', 'nanosecond-newer-review', 'deleted', 'missing-version', 'invalid-version'])
test('proof snapshot reuse falls back for a changed or uncertain shard: ' + mode, async t => {
  const f = await fixture(t, {count:501}), row = f.rows[0];
  const key = VERIFICATION_COLLECTION + '/' + verificationShardId(track, row.accountId);
  let changed = false, hold;
  f.control.beforeRead = path => {
    if (changed || path !== VERIFICATION_COLLECTION + '/' + track) return;
    changed = true;
    if (mode.includes('review')) {
      hold = {...pendingSlot(row), status:'unavailable', reason:COMPETITIVE_REVIEW_REASON,
        retryAt:Number.MAX_SAFE_INTEGER};
      f.set(key, {...f.data.get(key), slots:{[row.accountId]:hold}});
      if (mode === 'nanosecond-newer-review') {
        const snapshot = [...f.snapshots.keys()][0];
        f.versions.set(key, snapshot.replace(/\.(\d{3})Z$/, (_, fraction) => '.' + fraction + '000001Z'));
      }
    } else if (mode === 'deleted') { f.data.delete(key); f.versions.delete(key); }
  };
  if (mode.endsWith('version')) {
    const request = f.env.__TEST_FIRESTORE;
    f.env.__TEST_FIRESTORE = async (path, init = {}) => {
      const response = await request(path, init), body = init.body ? JSON.parse(init.body) : {};
      if (path === ':batchGet' && !body.readTime) for (const item of response) {
        if (item.found?.name !== base + key) continue;
        if (mode === 'missing-version') delete item.found.updateTime;
        else item.found.updateTime = 'unknown-version';
      }
      return response;
    };
  }
  await f.finish();
  assert.equal(f.stats.fixedProof, baseline ? 501 : 1);
  assert.equal(f.stats.currentProof, 501);
  assert.equal(f.reads.filter(read=>read.key===key&&read.readTime).length, 1);
  assert.equal(f.data.get(boardKey).entries[0].runVerified, true,
    'scoring remains bound to the historical proof, not the newer review or deletion');
  if (hold) assert.deepEqual(f.data.get(key).slots[row.accountId], hold);
  if (mode === 'deleted') assert.equal(f.data.get(key).slots[row.accountId].status, 'waiting');
  assert.deepEqual(f.errors, []);
});

for (const mode of ['migration-incomplete', 'legacy-root', 'newer-root', 'missing-root-version'])
test('proof snapshot reuse retains the full historical path for an uncertain root: ' + mode, async t => {
  const f = await fixture(t, {count:501}), key = VERIFICATION_COLLECTION + '/' + track;
  if (mode === 'migration-incomplete') f.data.get(key).migrationComplete = false;
  if (mode === 'legacy-root') f.data.get(key).storageVersion = 1;
  if (mode === 'newer-root') {
    let changed = false;
    f.control.beforeRead = path => {
      if (changed || path !== key) return;
      changed = true; f.set(key, {...f.data.get(key), marker:'newer-than-snapshot'});
    };
  }
  if (mode === 'missing-root-version') {
    const request = f.env.__TEST_FIRESTORE;
    f.env.__TEST_FIRESTORE = async (path, init) => {
      const response = await request(path, init);
      if (path === '/' + key) delete response.updateTime;
      return response;
    };
  }
  await f.finish();
  assert.equal(f.stats.fixedProof, 501);
  assert.equal(f.data.get(boardKey).totalEntries, 501);
  assert.ok(f.data.get(boardKey).entries.every(row=>row.runVerified));
  assert.deepEqual(f.errors, []);
});

for (const mode of ['current-read', 'historical-read', 'proof-cas'])
test('proof snapshot reuse propagates failures without checkpointing a partial page: ' + mode, async t => {
  const f = await fixture(t, {count:501}), key = VERIFICATION_COLLECTION + '/' + verificationShardId(track, f.rows[0].accountId);
  if (mode === 'proof-cas') {
    f.data.get(key).slots[f.rows[0].accountId].key = 'stale-binding';
    f.control.beforeCommit = writes => {
      if (writes.some(write=>write.update.name.includes('/documents/' + VERIFICATION_COLLECTION + '/'))) throw Error('FIRESTORE_412');
    };
  }
  const original = structuredClone(f.data), request = f.env.__TEST_FIRESTORE;
  f.env.__TEST_FIRESTORE = async (path, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    if (path === ':batchGet' && body.documents.some(name=>name.endsWith('/'+key))) {
      if (mode === 'current-read' && !body.readTime || mode === 'historical-read' && body.readTime)
        throw Error('FIRESTORE_429');
      const response = await request(path, init);
      if (mode === 'historical-read' && !body.readTime)
        delete response.find(item=>item.found?.name===base+key).found.updateTime;
      return response;
    }
    return request(path, init);
  };
  await assert.rejects(rebuildTrack(f.env, track), mode === 'proof-cas' ? /FIRESTORE_412/ : /FIRESTORE_429/);
  assert.deepEqual(f.data, original);
  assert.equal(f.stats.writes, 0);
  assert.equal(f.data.has(buildKey), false);
});

test('proof snapshot reuse never overwrites a concurrent review hold with a queued proof', async t => {
  const f = await fixture(t, {count:501}), row = f.rows[0];
  const key = VERIFICATION_COLLECTION + '/' + verificationShardId(track, row.accountId);
  f.data.get(key).slots[row.accountId].key = 'stale-binding';
  const hold = {...pendingSlot(row), status:'unavailable', reason:COMPETITIVE_REVIEW_REASON,
    retryAt:Number.MAX_SAFE_INTEGER};
  let injected = false;
  f.control.beforeCommit = writes => {
    if (injected || !writes.some(write=>write.update.name.endsWith('/'+key))) return;
    injected = true; f.set(key, {...f.data.get(key), slots:{[row.accountId]:hold}});
  };
  await assert.rejects(rebuildTrack(f.env, track), /FIRESTORE_412/);
  assert.deepEqual(f.data.get(key).slots[row.accountId], hold);
  assert.equal(f.data.has(buildKey), false);
  assert.equal(f.stats.writes, 0);
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
  assert.equal(f.stats.fixedProof, baseline ? population + 900 : 0);
  assert.equal(f.stats.currentProof, population + 900);
  assert.equal(f.data.get(boardKey).entries[0].name, f.identity.name);
  assert.deepEqual(f.errors, []);
  assert.deepEqual({reads:f.stats.reads,writes:f.stats.writes,requests:f.stats.requests},
    baseline ? {reads:6215,writes:74,requests:163} : {reads:4166,writes:60,requests:128},
    'base-version restart remains mandatory; its identical final generation reuses published pages');
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
  assert.equal(f.stats.fixedProof,baseline?f.stats.canonicalRows:0);assert.equal(f.stats.currentProof,f.stats.canonicalRows);
  f.report(identityBaseline?'identity-gate-before':'identity-gate-after');
  assert.deepEqual({reads:f.stats.reads,writes:f.stats.writes,requests:f.stats.requests},identityBaseline
    ?{reads:6215,writes:74,requests:163}:proofBaseline?{reads:3490,writes:56,requests:102}:{reads:2347,writes:56,requests:83});
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

test('scheduled identity deferral checkpoints bounded retry once, then keeps paid build and recovers',{skip:!!identityBaseline},async t=>{
  const f=await fixture(t);f.env.BACKGROUND_MAINTENANCE_MODE='coordinated';
  for(let pass=0;pass<5;pass++)await rebuildTrack(f.env,track);
  const key=TRACK_BUILD_JOBS+'/profile_'+f.identity.accountId;
  const profile={kind:'profile',active:true,identity:f.identity,pendingTrackIds:[track],
    trackDiscovery:{version:1,complete:true,cursor:''},processed:0,changed:0};f.set(key,profile);
  const checkpoint=structuredClone(f.data.get(buildKey));
  const turn=async()=>{let done;rankedWorker.scheduled({cron:'2-59/5 * * * *',scheduledTime:420000},f.env,
    {waitUntil:p=>{done=p;}});await done;};
  let before={...f.stats};await turn();await turn();
  assert.equal(f.stats.reads-before.reads,7);assert.equal(f.stats.writes-before.writes,1);
  assert.deepEqual(f.data.get(key).identity,profile.identity);assert.deepEqual(f.data.get(key).pendingTrackIds,profile.pendingTrackIds);assert.deepEqual(f.data.get(buildKey),checkpoint);
  f.advance(15*60000);
  f.control.beforeRead=key=>{if(key===buildKey)throw Error('FIRESTORE_429');};before={...f.stats};
  await turn();assert.equal(f.stats.writes,before.writes);assert.deepEqual(f.data.get(key).identity,profile.identity);
  assert.equal(f.errors.length,1);f.control.beforeRead=null;await turn();
  await f.finish();assert.equal(f.data.get(buildKey).generation,checkpoint.generation);f.advance(15*60000);await turn();
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
  assert.equal(f.stats.fixedProof, baseline ? population + 100 : 0);
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
  assert.equal(f.stats.fixedProof, baseline ? population : 1);
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
  assert.equal(f.stats.fixedProof,baseline?population:0);
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


// Discovery-capacity regressions use a cursor-aware query double, not a destructive inbox.
async function burstFixture(t, {pending=190, incoming=220, adaptive=false, count=population} = {}) {
  const f=await fixture(t,{count});
  if(!adaptive)f.set(VERIFICATION_COLLECTION+'/'+track,{...f.data.get(VERIFICATION_COLLECTION+'/'+track),migrationComplete:false});
  f.control.cursorDiscovery=true;
  f.env.CANONICAL_DISCOVERY_BACKPRESSURE='enabled';
  const changes=f.rows.slice(0,pending+incoming).map((row,i)=>({...row,
    timeMs:7000+i,frames:7000+i,raceTimeFrames:7000+i,uploadId:2}));
  for(const row of changes)f.set(results+'/'+row.accountId+'_'+track,row);
  const ids=changes.slice(0,pending).map(row=>row.accountId+'_'+track);
  const bindings=Object.fromEntries(changes.slice(0,pending).map(row=>[row.accountId+'_'+track,verificationKey(row)]));
  f.set(reconcileKey,{...f.data.get(reconcileKey),pendingTrackIds:[track],pendingFullRebuildTrackIds:[],
    pendingResultIds:{[track]:ids},pendingResultBindings:bindings});
  for(const row of changes.slice(pending))f.control.discovery.push({key:results+'/'+row.accountId+'_'+track,
    ingestedAt:'2026-11-03T08:00:00.000Z'});
  const held=changes[pending], shard=verificationShardId(track,held.accountId);
  const hold={...pendingSlot(held),status:'unavailable',reason:COMPETITIVE_REVIEW_REASON,retryAt:Number.MAX_SAFE_INTEGER};
  f.set(VERIFICATION_COLLECTION+'/'+shard,{...f.data.get(VERIFICATION_COLLECTION+'/'+shard),slots:{[held.accountId]:hold}});
  return {...f,changes,ids,bindings,held,hold,shard};
}

for(const backpressure of [undefined,'enabled'])test('backpressure complete burst '+String(backpressure)+': 410 PB updates including final publication and clean follow-ups',async t=>{
  const f=await burstFixture(t,{adaptive:true});
  if(backpressure===undefined)delete f.env.CANONICAL_DISCOVERY_BACKPRESSURE;
  const keyed=!identityBaseline&&backpressure==='enabled';
  let passes=0,maxRequests=0,maxKeys=0;
  const last=f.control.discovery.at(-1).key.slice(results.length+1);
  for(;passes<80;passes++) {
    const before=f.stats.requests;
    await reconcileCanonicalChanges(f.env);
    maxRequests=Math.max(maxRequests,f.stats.requests-before);
    assert.ok(f.stats.requests-before<=45,'existing 42 work / 45 checkpoint reserve is unchanged');
    const job=f.data.get(reconcileKey),count=Object.values(job.pendingResultIds||{}).reduce((n,ids)=>n+ids.length,0);
    maxKeys=Math.max(maxKeys,count);assert.ok(count<=200);
    if(keyed)assert.deepEqual(job.pendingFullRebuildTrackIds,[],'ordinary burst cannot request a full rebuild');
    if(job.pendingTrackIds.length===0&&job.cursorDocumentId===last){passes++;break;}
  }
  assert.ok(passes<80,'every discovered and previously accepted PB finishes');
  for(let follow=0;follow<3;follow++) {
    const before=f.stats.writes;
    assert.equal((await reconcileCanonicalChanges(f.env)).unchanged,true);
    assert.equal(f.stats.writes,before,'clean follow-ups add no heartbeat writes');
  }
  const published=await loadPublicationEntries(f.data.get(boardKey),'track',track,async(c,id)=>({data:f.data.get(c+'/'+id)}));
  assert.equal(published.length,population);
  for(const row of f.changes) {
    const actual=published.find(entry=>entry.accountId===row.accountId);
    assert.equal(actual.timeMs,row.timeMs);assert.equal(actual.uploadId,row.uploadId);
    assert.equal(actual.replayHash,row.replayHash);assert.equal(actual.runVerified,false,'old binding cannot approve new PB');
  }
  assert.deepEqual(f.data.get(VERIFICATION_COLLECTION+'/'+f.shard).slots[f.held.accountId],f.hold);
  assert.deepEqual(f.data.get(reconcileKey).pendingResultBindings,{});
  assert.deepEqual(f.errors,[]);
  if(keyed)assert.equal(f.stats.canonicalRows,0);
  assert.deepEqual({reads:f.stats.reads,writes:f.stats.writes},keyed?{reads:1176,writes:537}
    :baseline?{reads:7270,writes:504}:{reads:4971,writes:490});
  for(const row of f.rows.slice(f.changes.length)){
    const actual=published.find(entry=>entry.accountId===row.accountId);
    assert.equal(actual.timeMs,row.timeMs);assert.equal(actual.runVerified,true);
  }
  process.stdout.write('KEYED_BURST_COMPLETE_COST '+JSON.stringify({baseline:!!identityBaseline,backpressure:backpressure??'unset',
    updates:f.changes.length,previouslyQueued:f.ids.length,discovered:f.control.discovery.length,
    passes,followUps:3,maxRequests,maxKeys,...f.stats,fullQueries:f.queries.length,
    discoveryQueries:f.control.discoveryQueries.length})+'\n');
});

test('backpressure: full keyed capacity skips discovery while draining and preserves bindings', {skip:!!identityBaseline},async t=>{
  const f=await burstFixture(t,{pending:200,incoming:1}),before=structuredClone(f.data.get(reconcileKey));
  const result=await reconcileCanonicalChanges(f.env);
  assert.equal(f.control.discoveryQueries.length,0);assert.equal(result.targeted,16);
  const job=f.data.get(reconcileKey);
  assert.equal(job.pendingResultIds[track].length,184);
  assert.equal(job.cursorDocumentId,before.cursorDocumentId);assert.equal(job.cursorIngestedAt,before.cursorIngestedAt);
  assert.deepEqual(job.pendingFullRebuildTrackIds,[]);
  for(const id of f.ids.slice(16))assert.equal(job.pendingResultBindings[id],f.bindings[id]);
  await reconcileCanonicalChanges(f.env);
  assert.equal(f.control.discoveryQueries[0].limit,16);
  assert.equal(f.data.get(reconcileKey).cursorDocumentId,f.held.accountId+'_'+track);
  assert.equal(f.stats.canonicalRows,0);
});

test('backpressure: discovery reads only ten free IDs and advances their durable prefix', {skip:!!identityBaseline},async t=>{
  const f=await burstFixture(t);await reconcileCanonicalChanges(f.env);
  assert.equal(f.control.discoveryQueries[0].limit,10);
  const job=f.data.get(reconcileKey);
  assert.equal(job.cursorDocumentId,f.changes[199].accountId+'_'+track);
  assert.equal(job.pendingResultIds[track].length,184);
  assert.deepEqual(job.pendingFullRebuildTrackIds,[]);
});

test('backpressure: oversized adapter response never acknowledges an unaccepted suffix', {skip:!!identityBaseline},async t=>{
  const f=await burstFixture(t);f.control.discoveryLimitOverride=50;
  await reconcileCanonicalChanges(f.env);
  assert.equal(f.data.get(reconcileKey).cursorDocumentId,f.changes[199].accountId+'_'+track);
  assert.deepEqual(f.data.get(reconcileKey).pendingFullRebuildTrackIds,[]);
  f.control.discoveryLimitOverride=null;await reconcileCanonicalChanges(f.env);
  assert.equal(f.data.get(reconcileKey).cursorDocumentId,f.changes[215].accountId+'_'+track);
  assert.equal(f.stats.canonicalRows,0);
});

test('backpressure: job CAS loss cannot advance discovery or erase a concurrent binding', {skip:!!identityBaseline},async t=>{
  const f=await burstFixture(t);const before=structuredClone(f.data.get(reconcileKey));let injected=false;
  f.control.beforeCommit=async writes=>{
    if(!injected&&writes.some(w=>w.update.name.endsWith('/'+reconcileKey))) {
      injected=true;f.set(reconcileKey,{...before,pendingResultBindings:{...before.pendingResultBindings,[f.ids[0]]:'new-concurrent-binding'}});
    }
  };
  await assert.rejects(reconcileCanonicalChanges(f.env),/FIRESTORE_412/);
  assert.equal(f.data.get(reconcileKey).cursorDocumentId,before.cursorDocumentId);
  assert.equal(f.data.get(reconcileKey).pendingResultBindings[f.ids[0]],'new-concurrent-binding');
  assert.deepEqual(f.data.get(reconcileKey).pendingFullRebuildTrackIds,[]);
  f.control.beforeCommit=null;await reconcileCanonicalChanges(f.env);
  assert.equal(f.data.get(reconcileKey).cursorDocumentId,f.changes[199].accountId+'_'+track);
});


test('backpressure: duplicate already-accepted IDs advance the cursor without consuming capacity twice', {skip:!!identityBaseline},async t=>{
  const f=await burstFixture(t);
  f.control.discovery.unshift(...f.changes.slice(0,10).map(row=>({key:results+'/'+row.accountId+'_'+track,
    ingestedAt:'2026-11-03T08:00:00.000Z'})));
  await reconcileCanonicalChanges(f.env);
  assert.equal(f.data.get(reconcileKey).cursorDocumentId,f.ids[9]);
  assert.equal(f.data.get(reconcileKey).pendingResultIds[track].length,174);
  assert.deepEqual(f.data.get(reconcileKey).pendingFullRebuildTrackIds,[]);
  await reconcileCanonicalChanges(f.env);
  assert.equal(f.control.discoveryQueries[1].limit,26);
  assert.equal(f.data.get(reconcileKey).cursorDocumentId,f.changes[215].accountId+'_'+track);
});

test('backpressure: keyed saturation does not suppress independent legacy backfill requests', {skip:!!identityBaseline},async t=>{
  const f=await fixture(t,{count:1}),ids=Array.from({length:200},(_,i)=>'queued'+i+'_'+track);
  f.env.CANONICAL_DISCOVERY_BACKPRESSURE='enabled';
  f.set(reconcileKey,{...f.data.get(reconcileKey),backfillComplete:false,pendingFullRebuildTrackIds:[],
    pendingResultIds:{[track]:ids},pendingResultBindings:{[ids[0]]:'preserve-binding'}});
  const before=structuredClone(f.data.get(reconcileKey));
  f.control.discovery.push({key:results+'/'+f.rows[0].accountId+'_'+track});
  await reconcileCanonicalChanges(f.env);
  assert.equal(f.control.discoveryQueries.length,1);
  assert.equal(f.control.discoveryQueries[0].where,undefined,'only the legacy name-ordered scan runs');
  assert.equal(f.stats.canonicalRows,1,'legacy backfill still requests full authority reconstruction');
  const job=f.data.get(reconcileKey);
  assert.equal(job.cursorDocumentId,before.cursorDocumentId);
  assert.deepEqual(job.pendingResultIds[track],ids);
  assert.equal(job.pendingResultBindings[ids[0]],'preserve-binding');
  assert.equal(job.backfillComplete,true);
});


for(const flag of [undefined,false,true,'true','Enabled','enabled '])test('backpressure review flag is dormant unless exact enabled: '+String(flag),{skip:!!identityBaseline},async t=>{
  const f=await burstFixture(t,{pending:200,incoming:1});
  if(flag===undefined)delete f.env.CANONICAL_DISCOVERY_BACKPRESSURE;
  else f.env.CANONICAL_DISCOVERY_BACKPRESSURE=flag;
  await reconcileCanonicalChanges(f.env);
  assert.equal(f.control.discoveryQueries.length,1,'default discovery behavior is unchanged');
  assert.ok(f.data.get(reconcileKey).pendingFullRebuildTrackIds.includes(track));
  assert.equal(f.stats.canonicalRows,100,'legacy fallback, not adaptive publication, remains default');
});


for(const risk of ['small','migration','mixed','reserved','budget','source-size','discovery-size'])test('retained64: uncertain or shared resources fall back to 16 and progress: '+risk,async t=>{
 const f=await burstFixture(t,risk==='small'?{pending:64,incoming:10,count:99,adaptive:true}:{adaptive:true});
 if(risk==='discovery-size'){
  for(const row of f.changes.slice(190,195))f.set(results+'/'+row.accountId+'_'+track,{...row,unusedMetadata:'x'.repeat(500000)});
 }
 if(risk==='source-size'){
  const entries=await loadPublicationEntries(f.data.get(boardKey),'track',track,async(c,id)=>({data:f.data.get(c+'/'+id)}));
  const padded=entries.map((row,i)=>i>=1000?{...row,resourceFixture:'x'.repeat(16000)}:row);
  const pages=await preparePublicationPages('track',track,padded,{sourceRevision:1,sourceComplete:true});
  for(const doc of pages.documents)f.set(doc.collection+'/'+doc.id,doc.data);
  f.set(boardKey,{...f.data.get(boardKey),pagination:pages.pagination});
 }
 if(risk==='migration'){
  const rootKey=VERIFICATION_COLLECTION+'/'+track;
  f.set(rootKey,{...f.data.get(rootKey),migrationComplete:false,slots:{unrelated:{key:'preserve',status:'waiting'}}});
 }
 if(risk==='mixed'||risk==='reserved'){
  const job=f.data.get(reconcileKey),sibling='reserved-full';
  f.set(reconcileKey,{...job,pendingTrackIds:[track,sibling],
   pendingResultIds:{...job.pendingResultIds,...(risk==='mixed'?{[sibling]:['other_'+sibling]}:{})},
   pendingFullRebuildTrackIds:risk==='reserved'?[sibling]:[]});
 }
 if(risk==='budget'){
  const {createFirestoreAudit}=await import('../src/firestore-read-cost.js');
  f.env.__FIRESTORE_READ_AUDIT=createFirestoreAudit();f.env.__FIRESTORE_READ_AUDIT.operationAttempts=29;
 }
 const result=await reconcileCanonicalChanges(f.env);
 assert.equal(result.targeted,16);assert.deepEqual(f.errors,[]);assert.ok(f.stats.requests<=45);
 if(risk==='migration')assert.deepEqual(f.data.get(VERIFICATION_COLLECTION+'/'+track).slots,{unrelated:{key:'preserve',status:'waiting'}});
 if(risk==='budget')assert.ok(f.env.__FIRESTORE_READ_AUDIT.operationAttempts<=42);
 assert.equal(f.data.get(reconcileKey).pendingResultIds[track].length,(risk==='small'?74:risk==='mixed'?199:200)-16);
});

test('retained64: hard work-budget exhaustion preserves cursor and recovers next invocation',async t=>{
 const f=await burstFixture(t,{adaptive:true}),before=structuredClone(f.data.get(reconcileKey));
 const {createFirestoreAudit}=await import('../src/firestore-read-cost.js');
 f.env.__FIRESTORE_READ_AUDIT=createFirestoreAudit();f.env.__FIRESTORE_READ_AUDIT.operationAttempts=41;
 await assert.rejects(reconcileCanonicalChanges(f.env),/OVERALL_REQUEST_BUDGET_EXHAUSTED/);
 assert.deepEqual(f.data.get(reconcileKey),before);assert.equal(f.stats.writes,0);
 f.env.__FIRESTORE_READ_AUDIT=createFirestoreAudit();
 assert.equal((await reconcileCanonicalChanges(f.env)).targeted,64);
 assert.deepEqual(f.errors,[]);
});

test('retained64: oversized canonical metadata downgrades to 16 without losing accepted work or livelock',async t=>{
 const f=await burstFixture(t,{adaptive:true,pending:64,incoming:1});
 const large=f.changes[20];
 for(const row of f.changes.slice(20,25))f.set(results+'/'+row.accountId+'_'+track,{...row,unusedMetadata:'x'.repeat(500000)});
 const first=await reconcileCanonicalChanges(f.env);
 assert.equal(first.targeted,16);assert.equal(f.data.get(reconcileKey).pendingResultIds[track].length,49);
 assert.deepEqual(f.data.get(reconcileKey).pendingFullRebuildTrackIds,[]);
 let passes=0;while(f.data.get(reconcileKey).pendingTrackIds.length&&passes++<10)await reconcileCanonicalChanges(f.env);
 assert.ok(passes<10);assert.deepEqual(f.errors,[]);assert.equal(f.stats.canonicalRows,0);
 const entries=await loadPublicationEntries(f.data.get(boardKey),'track',track,async(c,id)=>({data:f.data.get(c+'/'+id)}));
 assert.equal(entries.find(row=>row.accountId===large.accountId).timeMs,large.timeMs);
});

test('retained64: near-limit UTF-8 replay burst validates full replays with bounded fetch/hash retention',async t=>{
 const f=await burstFixture(t,{adaptive:true});
 for(let i=0;i<f.changes.length;i++){
  const row=f.changes[i];row.replay='\u20ac'.repeat(9990)+String(i).padStart(9,'0');
  row.replayHash=createHash('sha256').update(row.replay).digest('hex');f.set(results+'/'+row.accountId+'_'+track,row);
 }
 const corrupt=f.changes[40];f.set(results+'/'+corrupt.accountId+'_'+track,{...corrupt,replay:corrupt.replay.slice(0,-1)+'X'});
 f.hold={...pendingSlot(f.held),status:'unavailable',reason:COMPETITIVE_REVIEW_REASON,retryAt:Number.MAX_SAFE_INTEGER};
 f.set(VERIFICATION_COLLECTION+'/'+f.shard,{...f.data.get(VERIFICATION_COLLECTION+'/'+f.shard),slots:{[f.held.accountId]:f.hold}});
 let canonicalBatchMax=0,wireCharsMax=0,hashBytes=0,hashBytesPeak=0;
 const transport=f.env.__TEST_FIRESTORE;
 f.env.__TEST_FIRESTORE=async(route,init={})=>{
  if(route===':batchGet'){
   const ids=JSON.parse(init.body).documents.filter(name=>name.includes('/'+results+'/'));
   canonicalBatchMax=Math.max(canonicalBatchMax,ids.length);
  }
  const value=await transport(route,init);
  if(route===':batchGet'||route===':runQuery')wireCharsMax=Math.max(wireCharsMax,JSON.stringify(value).length);
  return value;
 };
 const digest=crypto.subtle.digest.bind(crypto.subtle);
 t.mock.method(crypto.subtle,'digest',async(algorithm,value)=>{
  hashBytes+=value.byteLength;hashBytesPeak=Math.max(hashBytesPeak,hashBytes);
  try{return await digest(algorithm,value);}finally{hashBytes-=value.byteLength;}
 });
 let passes=0,maxRequests=0;
 while(passes++<20){
  const before=f.stats.requests;await reconcileCanonicalChanges(f.env);maxRequests=Math.max(maxRequests,f.stats.requests-before);
  if(!f.data.get(reconcileKey).pendingTrackIds.length&&f.data.get(reconcileKey).cursorDocumentId===f.changes.at(-1).accountId+'_'+track)break;
 }
 assert.ok(passes<20);
 for(let i=0;i<3;i++)assert.equal((await reconcileCanonicalChanges(f.env)).unchanged,true);
 assert.equal(canonicalBatchMax,16);assert.ok(maxRequests<=42);
 assert.ok(hashBytesPeak<8*1024*1024);assert.ok(wireCharsMax<3*1024*1024);
 const entries=await loadPublicationEntries(f.data.get(boardKey),'track',track,async(c,id)=>({data:f.data.get(c+'/'+id)}));
 for(const row of f.changes){const actual=entries.find(entry=>entry.accountId===row.accountId);
  assert.equal(actual.replayHash,row.replayHash);assert.equal(actual.integrityVerified,row.accountId!==corrupt.accountId);assert.equal(actual.runVerified,false);}
 assert.deepEqual(f.data.get(VERIFICATION_COLLECTION+'/'+f.shard).slots[f.held.accountId],f.hold);
 assert.deepEqual(f.errors,[]);assert.equal(f.stats.canonicalRows,0);
 process.stdout.write('RETAINED64_LARGE_REPLAY '+JSON.stringify({passes,maxRequests,canonicalBatchMax,wireCharsMax,hashBytesPeak,...f.stats})+'\n');
});

async function legacyBackfillFixture(t, options) {
  const f=await fixture(t,options);
  f.env.CANONICAL_DISCOVERY_BACKPRESSURE='enabled';
  f.set(reconcileKey,{...f.data.get(reconcileKey),backfillComplete:false,backfillDocumentId:'',
    pendingTrackIds:[],pendingFullRebuildTrackIds:[],pendingResultIds:{}});
  f.control.legacyDiscovery=f.rows.map(row=>results+'/'+row.accountId+'_'+track);
  return f;
}

async function finishLegacyBackfill(f, reconcile=reconcileCanonicalChanges) {
  let passes=0;
  for(;passes<120;passes++){
    const requests=f.stats.requests;
    await reconcile(f.env,{scanResults:false});
    assert.ok(f.stats.requests-requests<=45,'existing per-invocation request budget is unchanged');
    const job=f.data.get(reconcileKey);
    if(job.backfillComplete&&!job.pendingTrackIds.length&&!job.backfillCatchupTrackIds?.length)break;
    f.advance(5*60000);
  }
  assert.ok(passes<120,'enumeration, initial publications and final catch-ups all finish');
  assert.deepEqual(f.errors,[]);
  return passes+1;
}

test('legacy backfill cost: repeated account-ordered pages rebuild a 1136-racer track only twice including final catch-up',
  {skip:baseline},async t=>{
  // The comparison restores precisely the former per-page full-intent admission
  // and omits the new final catch-up; proof reuse and all budgets stay identical.
  let source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
  for(const marker of ['if(backfillQueuedTrackIds.has(trackId))continue;', 'if(!job.backfillComplete&&backfillComplete){'])
    assert.equal(source.split(marker).length,2);
  source=source.replace('if(backfillQueuedTrackIds.has(trackId))continue;','if(false)continue;')
    .replace('if(!job.backfillComplete&&backfillComplete){','if(false){')
    .replace(/from '(\.\/[^']+)'/g,(_,path)=>`from '${new URL('../src/'+path.slice(2),import.meta.url).href}'`);
  const old=(await import('data:text/javascript,'+encodeURIComponent(source))).reconcileCanonicalChanges;
  const costs={};
  for(const [name,reconcile] of [['before',old],['after',reconcileCanonicalChanges]]){
    const f=await legacyBackfillFixture(t),passes=await finishLegacyBackfill(f,reconcile);
    const job=f.data.get(reconcileKey);
    assert.equal(job.backfillDocumentId,f.rows.at(-1).accountId+'_'+track);
    assert.equal(job.backfillComplete,true);
    assert.deepEqual(job.pendingFullRebuildTrackIds,[]);
    const entries=await loadPublicationEntries(f.data.get(boardKey),'track',track,async(c,id)=>({data:f.data.get(c+'/'+id)}));
    assert.equal(entries.length,population);assert.ok(entries.every(row=>row.runVerified));
    const before={...f.stats};
    assert.equal((await reconcile(f.env,{scanResults:false})).unchanged,true);
    assert.equal(f.stats.reads-before.reads,1);assert.equal(f.stats.writes,before.writes);
    costs[name]={passes,...f.stats,fullBuilds:f.queries.filter(q=>!q.readTime).length,
      legacyPages:f.control.discoveryQueries.filter(q=>!q.where).length};
  }
  assert.equal(costs.after.fullBuilds,2);
  assert.equal(costs.after.canonicalRows,2*population);
  assert.ok(costs.before.fullBuilds>costs.after.fullBuilds);
  assert.ok(costs.after.reads<costs.before.reads*0.7);
  process.stdout.write('LEGACY_BACKFILL_COMPLETED_COST '+JSON.stringify({population,costs,
    excludes:'SDK traffic, native verification, Overall, events, capture, quota/CAS retries'})+'\n');
});

test('legacy backfill final catch-up cannot be consumed by an active older snapshot', {skip:baseline},async t=>{
  const f=await legacyBackfillFixture(t);
  await reconcileCanonicalChanges(f.env,{scanResults:false});
  assert.equal(f.data.get(reconcileKey).activeFullRebuildTrackId,track);
  const newer={...f.rows[0],timeMs:8000,frames:8000,raceTimeFrames:8000,uploadId:2};
  f.set(results+'/'+newer.accountId+'_'+track,newer);
  // Terminate enumeration while the first snapshot is still incomplete.
  f.control.legacyDiscovery=f.control.legacyDiscovery.slice(0,50);
  await reconcileCanonicalChanges(f.env,{scanResults:false});
  let job=f.data.get(reconcileKey);
  assert.equal(job.backfillComplete,true);
  assert.deepEqual(job.backfillCatchupTrackIds,[track]);
  assert.equal(f.queries.filter(q=>!q.readTime).length,1);
  await finishLegacyBackfill(f);
  job=f.data.get(reconcileKey);
  assert.equal(f.queries.filter(q=>!q.readTime).length,2);
  assert.deepEqual(job.backfillCatchupTrackIds,[]);
  const entry=f.data.get(boardKey).entries.find(row=>row.accountId===newer.accountId);
  assert.equal(entry.timeMs,8000);assert.equal(entry.runVerified,false,'changed legacy PB never inherits old verification');
  const shard=f.data.get(VERIFICATION_COLLECTION+'/'+verificationShardId(track,newer.accountId));
  assert.equal(shard.slots[newer.accountId].key,verificationKey(newer));
});

for(const loss of ['before-commit','lost-response'])test('legacy backfill cursor, seen set and full intent remain atomic: '+loss,
  {skip:baseline},async t=>{
  const f=await legacyBackfillFixture(t);let failed=false;
  const hook=loss==='before-commit'?'beforeCommit':'afterCommit';
  f.control[hook]=async writes=>{
    if(!failed&&writes.some(w=>w.update.name.endsWith('/'+reconcileKey))){failed=true;throw Error(loss==='before-commit'?'FIRESTORE_412':'LOST_RESPONSE');}
  };
  await assert.rejects(reconcileCanonicalChanges(f.env,{scanResults:false}),loss==='before-commit'?/FIRESTORE_412/:/LOST_RESPONSE/);
  const job=f.data.get(reconcileKey);
  assert.equal(job.backfillDocumentId,loss==='before-commit'?'':f.rows[49].accountId+'_'+track);
  assert.deepEqual(job.backfillQueuedTrackIds||[],loss==='before-commit'?[]:[track]);
  assert.deepEqual(job.pendingFullRebuildTrackIds,loss==='before-commit'?[]:[track]);
  f.control[hook]=null;
  await reconcileCanonicalChanges(f.env,{scanResults:false});
  const queries=f.control.discoveryQueries.filter(q=>!q.where);
  assert.equal(queries.length,2);
  assert.equal((queries[1].startAt?.values[0].referenceValue||'').split('/documents/').at(-1),
    loss==='before-commit'?'':results+'/'+f.rows[49].accountId+'_'+track);
  await finishLegacyBackfill(f);
  assert.equal(f.queries.filter(q=>!q.readTime).length,2);
});

test('legacy backfill refuses a 513th seen track before acknowledging its cursor', {skip:baseline},async t=>{
  const f=await legacyBackfillFixture(t,{count:1});
  f.set(reconcileKey,{...f.data.get(reconcileKey),backfillQueuedTrackIds:Array.from({length:512},(_,i)=>'seen-track-'+i)});
  const before=structuredClone(f.data.get(reconcileKey));
  await assert.rejects(reconcileCanonicalChanges(f.env,{scanResults:false}),/RECONCILE_BACKFILL_TRACK_CAPACITY/);
  assert.deepEqual(f.data.get(reconcileKey),before);
  assert.equal(f.stats.writes,0);
});

test('legacy backfill CAS race preserves a concurrent notified binding before replaying discovery', {skip:baseline},async t=>{
  const f=await legacyBackfillFixture(t),id=f.rows[0].accountId+'_'+track;let raced=false;
  f.control.beforeCommit=async writes=>{
    if(!raced&&writes.some(w=>w.update.name.endsWith('/'+reconcileKey))){
      raced=true;
      f.set(reconcileKey,{...f.data.get(reconcileKey),pendingTrackIds:[track],
        pendingResultIds:{[track]:[id]},pendingResultBindings:{[id]:'concurrent-notification'}});
    }
  };
  await assert.rejects(reconcileCanonicalChanges(f.env,{scanResults:false}),/FIRESTORE_412/);
  assert.equal(f.data.get(reconcileKey).backfillDocumentId,'');
  assert.deepEqual(f.data.get(reconcileKey).backfillQueuedTrackIds||[],[]);
  f.control.beforeCommit=null;
  await reconcileCanonicalChanges(f.env,{scanResults:false});
  const job=f.data.get(reconcileKey);
  assert.deepEqual(job.backfillQueuedTrackIds,[track]);
  assert.equal(job.pendingResultBindings[id],'concurrent-notification');
  assert.ok(job.pendingResultIds[track].includes(id));
  assert.ok(job.pendingFullRebuildTrackIds.includes(track));
});

test('legacy terminal-page commit failure cannot record completion without final catch-up intent', {skip:baseline},async t=>{
  const f=await legacyBackfillFixture(t,{count:1});let failed=false;
  f.control.beforeCommit=async writes=>{
    if(!failed&&writes.some(w=>w.update.name.endsWith('/'+reconcileKey))){failed=true;throw Error('FIRESTORE_412');}
  };
  await assert.rejects(reconcileCanonicalChanges(f.env,{scanResults:false}),/FIRESTORE_412/);
  assert.equal(f.data.get(reconcileKey).backfillComplete,false);
  assert.deepEqual(f.data.get(reconcileKey).backfillCatchupTrackIds||[],[]);
  f.control.beforeCommit=null;
  await reconcileCanonicalChanges(f.env,{scanResults:false});
  assert.equal(f.data.get(reconcileKey).backfillComplete,true);
  assert.deepEqual(f.data.get(reconcileKey).backfillCatchupTrackIds,[track]);
  await finishLegacyBackfill(f);
});
