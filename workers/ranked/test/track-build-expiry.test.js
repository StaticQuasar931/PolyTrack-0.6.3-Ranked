import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {rebuildTrack, handleRequest} from '../src/index.js';
import {pendingSlot, VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION, verificationSchedule,
  VERIFICATION_COLLECTION} from '../src/verification.js';
import {verificationShardId} from '../src/verification-shards.js';
import {eventEncode, eventDecode} from '../src/events-store.js';
import {preparePublicationPages, loadPublicationEntries} from '../src/paged-publication.js';
import {advanceTrackBuild, trackBuildDisposition, trackBuildId, TRACK_BUILD_MAX_AGE_MS,
  TRACK_BUILD_JOBS, TRACK_BUILD_PARTS} from '../src/track-build.js';

const start = Date.UTC(2026, 9, 26);
function fixture(count) {
  const documents = Array.from({length:count}, (_, i) => ({
    name:String(i + 1).padStart(8, '0'), data:{accountId:`r${i}`}
  }));
  const published = {updateTime:'base-1', data:{revision:7, entries:[{accountId:'published'}]}};
  const parts = new Map();
  let prior = structuredClone(published), job = null;
  const stats = {prefixes:0, canonicalReads:0, requests:0, writes:0, normalizations:0, readTimes:[]};
  async function page(offset, limit, readTime) {
    stats.requests++;
    const rows = documents.slice(offset, offset + limit);
    stats.canonicalReads += rows.length;
    return {documents:rows, readTime};
  }
  async function pass(now, {preflight = true, commitFails = false, pagesPerPass = 1, readMany} = {}) {
    const before = stats.requests;
    const action = preflight ? trackBuildDisposition({prior, job, now}).action : 'start';
    let initial = null;
    if (action === 'start') {
      stats.prefixes++;
      initial = await page(0, 100, new Date(now).toISOString());
    }
    const result = await advanceTrackBuild({trackId:'expiry-track', prior, job:structuredClone(job), initial, now, pagesPerPass,
      readMany:readMany && (async (collection,ids) => {
        stats.requests++;
        assert.equal(collection, TRACK_BUILD_PARTS);
        return readMany(new Map(ids.map(id => [id,parts.get(id)])),ids);
      }),
      readPage:async (cursor, readTime, limit) => {
        stats.readTimes.push(readTime);
        return page(Number(cursor), limit, readTime);
      },
      normalize:async (rows, readTime) => {
        stats.normalizations++;
        stats.readTimes.push(readTime);
        return rows;
      },
      read:async (collection, id) => {
        stats.requests++;
        assert.equal(collection, TRACK_BUILD_PARTS);
        return parts.get(id);
      },
      commit:async writes => {
        stats.requests++;
        if (commitFails) throw Error('CAS_CONFLICT');
        stats.writes += writes.length;
        for (const write of writes) {
          assert.equal(write.unconditional === true, write.collection === TRACK_BUILD_PARTS);
          if (write.collection === TRACK_BUILD_JOBS) {
            assert.equal(write.id, trackBuildId('expiry-track'));
            assert.deepEqual(write.prior, job);
            job = {data:structuredClone(write.data), updateTime:`v${stats.writes}`};
          } else parts.set(write.id, {data:structuredClone(write.data)});
        }
        return {writeResults:writes.map(() => ({updateTime:job.updateTime}))};
      }});
    assert.deepEqual(prior.data, published.data, 'the helper must retain the published board');
    // Callback requests only. Production normalization/publication requires its own budget.
    assert(stats.requests - before < 50);
    return result;
  }
  return {stats, pass, published, parts, documents, job:() => job, setJob:value => {job = value;},
    changeBase:() => {prior = {...prior, updateTime:'base-2'};}};
}

for (const count of [1401, 10000]) for (const jitter of [0, 1, 59999]) {
  test(`${count} rows, five-minute passes with ${jitter}ms jitter block once without repeated prefix`, async () => {
    const f = fixture(count);
    let blockedWrites, blockedRequests;
    for (let minute = 0; minute < 1440; minute += 5) {
      const result = await f.pass(start + minute * 60000 + (minute ? jitter : 0));
      if (minute < 50) assert.equal(result.blocked, undefined);
      else {
        assert.equal(result.blocked, true);
        assert.equal(result.pending, true);
        assert.equal(result.reason, 'snapshot_expired');
        assert.equal(result.entries, undefined);
        blockedWrites ??= f.stats.writes;
        blockedRequests ??= f.stats.requests;
        assert.equal(f.stats.writes, blockedWrites, 'blocked passes do not rewrite the marker');
        assert.equal(f.stats.requests, blockedRequests, 'blocked passes perform no callback requests');
      }
    }
    assert.equal(f.stats.prefixes, 1);
    assert.equal(f.stats.canonicalReads, 1000);
    assert.equal(f.stats.normalizations, 10);
    assert.equal(f.stats.writes, 21, '10 parts, 10 checkpoints, one blocked marker');
    assert(f.stats.readTimes.every(time => time === new Date(start).toISOString()));
  });
}

test('999 rows complete within the fixed snapshot at five-minute cadence', async () => {
  const f = fixture(999);
  let result;
  for (let minute = 0; minute <= 45; minute += 5) result = await f.pass(start + minute * 60000);
  assert.equal(result.entries.length, 999);
  assert.equal(result.completionWrite.data.complete, true);
  assert.equal(result.sourceReadTime, new Date(start).toISOString());
  assert.equal(f.stats.prefixes, 1);
});

test('larger build can complete with sufficiently frequent bounded passes', async () => {
  const f = fixture(2001);
  let result;
  for (let minute = 0; minute <= 20; minute++) result = await f.pass(start + minute * 60000);
  assert.equal(result.entries.length, 2001);
  assert.equal(f.stats.prefixes, 1);
  assert(f.stats.readTimes.every(time => time === new Date(start).toISOString()));
});

test('new published base releases a durable block and requires a fresh initial snapshot', async () => {
  const f = fixture(1401);
  await f.pass(start);
  await f.pass(start + TRACK_BUILD_MAX_AGE_MS);
  assert.equal(f.job().data.blocked, true);
  f.changeBase();
  const result = await f.pass(start + TRACK_BUILD_MAX_AGE_MS + 60000);
  assert.equal(result.blocked, undefined);
  assert.equal(f.stats.prefixes, 2);
  assert.equal(f.job().data.baseVersion, 'base-2');
  assert.equal(f.job().data.blocked, undefined);
});

test('expiry guard is strict at 50 minutes and base changes invalidate active checkpoints too', () => {
  const prior = {updateTime:'base-1'};
  const job = {data:{complete:false,baseVersion:'base-1',readTime:new Date(start).toISOString()}};
  assert.equal(trackBuildDisposition({prior,job,now:start + TRACK_BUILD_MAX_AGE_MS - 1}).action, 'resume');
  assert.equal(trackBuildDisposition({prior,job,now:start + TRACK_BUILD_MAX_AGE_MS}).action, 'block');
  assert.equal(trackBuildDisposition({prior:{updateTime:'base-2'},job,now:start + 60000}).action, 'start');
});

test('block survives reload, and ignores an already-fetched replacement prefix', async () => {
  const f = fixture(1401);
  await f.pass(start);
  await f.pass(start + TRACK_BUILD_MAX_AGE_MS);
  f.setJob(structuredClone(f.job()));
  const before = f.stats.normalizations;
  assert.equal((await f.pass(start + 86400000, {preflight:false})).blocked, true);
  assert.equal(f.stats.normalizations, before);
});

test('failed blocked-marker CAS propagates without restarting or changing the checkpoint', async () => {
  const f = fixture(1401);
  await f.pass(start);
  const checkpoint = structuredClone(f.job());
  await assert.rejects(f.pass(start + TRACK_BUILD_MAX_AGE_MS, {commitFails:true}), /CAS_CONFLICT/);
  assert.deepEqual(f.job(), checkpoint);
  assert.equal((await f.pass(start + TRACK_BUILD_MAX_AGE_MS + 1)).blocked, true);
  assert.equal(f.stats.prefixes, 1);
});

test('invalid/future checkpoint clocks block, while a base change requests restart', async () => {
  for (const readTime of ['invalid', new Date(start + 1).toISOString()]) {
    const f = fixture(1401);
    f.setJob({data:{complete:false,baseVersion:'base-1',readTime},updateTime:'bad-clock'});
    assert.equal((await f.pass(start)).reason, 'snapshot_time_invalid');
    assert.equal(f.stats.prefixes, 0);
  }
  const result = await advanceTrackBuild({trackId:'expiry-track', prior:{updateTime:'new'},
    job:{data:{complete:false,baseVersion:'old',blocked:true}},now:start});
  assert.deepEqual(result, {restart:true});
});

test('initial snapshots must be younger than 50 minutes and never in the future', async () => {
  for (const time of [start - TRACK_BUILD_MAX_AGE_MS, start + 1]) {
    await assert.rejects(advanceTrackBuild({trackId:'expiry-track', now:start,
      initial:{readTime:new Date(time).toISOString(),documents:[]}}), /TRACK_BUILD_SNAPSHOT_EXPIRED/);
  }
  for (const now of [NaN, -1, 1.5]) assert.throws(() => trackBuildDisposition({now}), /CLOCK_INVALID/);
});

for (const jitter of [0, 1, 59999]) test(`two-page resumed passes finish 1401 rows with ${jitter}ms jitter`, async () => {
  const f = fixture(1401);
  let result;
  for (let minute = 0; minute <= 35; minute += 5)
    result = await f.pass(start + minute * 60000 + (minute ? jitter : 0), {pagesPerPass:2});
  assert.equal(result.entries.length, 1401);
  assert.equal(f.stats.prefixes, 1);
  assert.equal(result.sourceReadTime, new Date(start).toISOString());
});

test('two-page huge builds still block once rather than restarting the prefix', async () => {
  const f = fixture(10000);
  let blockedRequests;
  for (let minute = 0; minute < 1440; minute += 5) {
    const result = await f.pass(start + minute * 60000 + 1, {pagesPerPass:2});
    if (minute >= 50) {
      assert.equal(result.blocked, true);
      blockedRequests ??= f.stats.requests;
      assert.equal(f.stats.requests, blockedRequests);
    }
  }
  assert.equal(f.stats.prefixes, 1);
  assert.equal(f.stats.canonicalReads, 1900);
});

test('pages per pass cannot exceed the proven two-page ceiling', async () => {
  for (const pagesPerPass of [0, 3, 1.5, NaN])
    await assert.rejects(advanceTrackBuild({pagesPerPass}), /TRACK_BUILD_PAGE_BUDGET_INVALID/);
});

test('batch assembly restores ordered parts with no individual reads', async () => {
  const f = fixture(1401);
  let result, batches = 0, count = 0;
  const readMany = (parts,ids) => {
    batches++; count = ids.length;
    return new Map([...parts].reverse());
  };
  for (let minute = 0; minute <= 35; minute += 5)
    result = await f.pass(start + minute * 60000, {pagesPerPass:2,readMany});
  assert.equal(batches, 1);
  assert.equal(count, 15);
  assert.deepEqual(result.entries.map(row => row.accountId), Array.from({length:1401}, (_, i) => `r${i}`));
});

test('missing, malformed and failed part batches fail closed without per-part retries', async () => {
  for (const bad of [() => new Map(), () => [], () => {throw Error('BATCH_429');}]) {
    const f = fixture(100);
    await f.pass(start);
    const before = f.stats.requests;
    await assert.rejects(f.pass(start + 60000, {readMany:bad}), /PART_MISSING|PART_BATCH_INVALID|BATCH_429/);
    assert.equal(f.stats.requests - before, 3, 'one page read, checkpoint commit and batch; no individual retries');
    assert.equal(f.job().data.complete, false);
  }
});

test('legacy 501-row checkpoint resumes after its stored cursor without dropping parts', async () => {
  const f=fixture(701), generation='legacy';
  for(let offset=0;offset<501;offset+=100)
    f.parts.set(`${generation}_${offset/100}`,{data:{entries:f.documents.slice(offset,offset+100).filter((_,i)=>offset+i<501).map(d=>d.data)}});
  f.setJob({updateTime:'legacy-v1',data:{trackId:'expiry-track',generation,baseVersion:'base-1',
    readTime:new Date(start).toISOString(),afterName:f.documents[500].name,parts:6,sourceCount:501,complete:false}});
  let result;
  for(let minute=1;minute<=3;minute++)result=await f.pass(start+minute*60000);
  assert.equal(f.stats.prefixes,0);
  assert.equal(f.stats.canonicalReads,200);
  assert.deepEqual(result.entries.map(row=>row.accountId),f.documents.map(d=>d.data.accountId));
});

test('lost checkpoint commit retries the same fixed-snapshot page, not the prefix', async () => {
  const f=fixture(201);
  await f.pass(start);
  const checkpoint=structuredClone(f.job());
  await assert.rejects(f.pass(start+60000,{commitFails:true}),/CAS_CONFLICT/);
  assert.deepEqual(f.job(),checkpoint);
  await f.pass(start+120000);
  const result=await f.pass(start+180000);
  assert.equal(f.stats.prefixes,1);
  assert.deepEqual(result.entries.map(row=>row.accountId),f.documents.map(d=>d.data.accountId));
});

test('missing immutable parts fail closed and can finish after restoration', async () => {
  const f=fixture(100);
  await f.pass(start);
  const saved=new Map(f.parts);
  f.parts.clear();
  await assert.rejects(f.pass(start+60000),/PART_MISSING/);
  assert.equal(f.job().data.complete,false);
  for(const [id,part] of saved)f.parts.set(id,part);
  assert.equal((await f.pass(start+120000)).entries.length,100);
  assert.equal(f.stats.prefixes,1);
});

test('initial pages reject overflow, false completion and mismatched read times before normalization', async () => {
  for(const [documents,ended,readTime,error] of [
    [Array(101).fill({}),false,new Date(start).toISOString(),/PAGE_INVALID/],
    [Array(100).fill({}),true,new Date(start).toISOString(),/PAGE_INVALID/]
  ])await assert.rejects(advanceTrackBuild({trackId:'bounds',now:start,
    initial:{documents,ended,readTime},normalize:()=>assert.fail('must not normalize')}),error);
  const time=new Date(start).toISOString();
  await assert.rejects(advanceTrackBuild({trackId:'bounds',now:start,prior:{updateTime:'base'},
    job:{data:{complete:false,baseVersion:'base',readTime:time}},
    readPage:async()=>({documents:[],readTime:new Date(start+1).toISOString()}),
    normalize:()=>assert.fail('must not normalize')}),/READ_TIME_CHANGED/);
});

// Exercise the real Worker's normalizer, proof migration, part assembly and final
// publication, not a cheap normalize stub. Every Firestore HTTP callback is counted.
for (const [count,cadence,admin] of [[900,5],[1000,5],[1401,5],[5000,1],[5000,5],
  [2397,.5,true],[5000,.5,true],[2397,.5,'recover'],[2397,.5,'hold']]) for (const verified of [true, false]) for (const priorPaged of [false, true]) {
if (admin === 'recover' && !priorPaged) continue;
if (admin === 'hold' && (!verified || !priorPaged)) continue;
test(`real Worker ${count}-row document budget at ${cadence}-minute cadence, verified=${verified}, priorPaged=${priorPaged}, admin=${admin||false}`, async () => {
  const expires=count===5000&&cadence===5;
  const track = '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
  const base = 'projects/polytrack-052/databases/(default)/documents/';
  const results = '0.6.2_race_results', boards = '0.6.2_s1_leaderboards_track';
  const data = new Map(), versions = new Map(), requests = [], queries = [], partBatches = [];
  const proofReads = {current:0, historical:0};
  let now = start, snapshot;
  const replay = 'expiry-budget-proof', replayHash = createHash('sha256').update(replay).digest('hex');
  const rows = Array.from({length:count}, (_, i) => ({accountId:`r${String(i).padStart(4,'0')}`,
    trackId:track, timeMs:10000+i, frames:10000+i, raceTimeFrames:10000+i,
    uploadId:1, replay, replayHash, pbAt:1000}));
  for (const row of rows) data.set(`${results}/${row.accountId}_${track}`, row);
  if (priorPaged) {
    const entries = rows.map(row => ({...row,timeMs:row.timeMs+100,name:'Previously published'}));
    const publication = await preparePublicationPages('track',track,entries,{sourceRevision:1,sourceComplete:true});
    for (const document of publication.documents) data.set(document.collection+'/'+document.id,document.data);
    data.set(`${boards}/${track}`, {trackId:track,entries:entries.slice(0,500),pagination:publication.pagination,
      totalEntries:entries.length,sourceComplete:true,complete:false,revision:1,signature:'old',schemaVersion:6,
      algorithmVersion:'participation-v8-s1'});
  }
  data.set(`${VERIFICATION_COLLECTION}/${track}`, {trackId:track,slots:{},storageVersion:2,migrationComplete:true});
  if (verified) {
    const proof = row => ({...pendingSlot(row),status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION});
    for (const row of rows) {
      const id = verificationShardId(track,row.accountId), slots = {[row.accountId]:proof(row)};
      data.set(`${VERIFICATION_COLLECTION}/${id}`, {trackId:track,queueId:id,storageVersion:2,slots,...verificationSchedule(slots)});
    }
  }
  let heldProof;
  if(admin==='hold') {
    heldProof={...pendingSlot(rows[0]),status:'unavailable',reason:'similar_replay_pending_manual_review'};
    data.get(`${VERIFICATION_COLLECTION}/${verificationShardId(track,rows[0].accountId)}`).slots[rows[0].accountId]=heldProof;
  }
  const time = key => `2026-10-26T00:00:00.${String(versions.get(key)||0).padStart(9,'0')}Z`;
  const wire = (key,value=data.get(key)) => ({name:base+key,fields:eventEncode(value).mapValue.fields,updateTime:time(key)});
  let writesThisPass = 0;
  const adminToken = 'offline-fixture-only';
  const env = {ALLOWED_ORIGINS:'https://staticquasar931.github.io',ADMIN_REBUILD_TOKEN:adminToken,__TEST_FIRESTORE:async (route,init={}) => {
    requests.push(route);
    assert(requests.length <= 48, 'reserve two requests below the hard 50 for cold auth/other overhead');
    if (route === ':batchGet') {
      const body = JSON.parse(init.body), source = body.readTime ? snapshot : data;
      proofReads[body.readTime ? 'historical' : 'current'] += body.documents
        .filter(name => name.startsWith(base + VERIFICATION_COLLECTION + '/' + track + '_')).length;
      const partIds = body.documents.filter(name => name.includes('/'+TRACK_BUILD_PARTS+'/'));
      if (partIds.length) partBatches.push(partIds);
      return body.documents.map(name => {
        const key = name.slice(base.length);
        return source.has(key) ? {found:wire(key,source.get(key))} : {missing:name};
      });
    }
    if (route === ':runQuery') {
      const body = JSON.parse(init.body), q = body.structuredQuery;
      assert.equal(q.from[0].collectionId, results);
      queries.push(body);
      snapshot ??= structuredClone(data);
      const source = body.readTime ? snapshot : data, after = q.startAt?.values?.[0]?.referenceValue || '';
      return [...source].filter(([key,row]) => key.startsWith(results+'/') && row.trackId===track && base+key>after)
        .sort(([a],[b]) => a.localeCompare(b)).slice(0,q.limit)
        .map(([key,row]) => ({document:wire(key,row),readTime:new Date(start).toISOString()}));
    }
    if (route === ':commit') {
      const writes = JSON.parse(init.body).writes;
      writesThisPass += writes.length;
      for (const w of writes) {
        const key = w.update.name.slice(base.length);
        if (w.currentDocument) assert.deepEqual(w.currentDocument, data.has(key) ? {updateTime:time(key)} : {exists:false});
      }
      for (const w of writes) {
        const key = w.update.name.slice(base.length);
        data.set(key,eventDecode({mapValue:{fields:w.update.fields}}));
        versions.set(key,(versions.get(key)||0)+1);
      }
      return {writeResults:writes.map(w => ({updateTime:time(w.update.name.slice(base.length))}))};
    }
    const url = new URL('https://offline.test'+route), key = decodeURIComponent(url.pathname.slice(1));
    const source = url.searchParams.has('readTime') ? snapshot : data;
    return source?.has(key) ? wire(key,source.get(key)) : null;
  }};
  const oldParts = new Map();
  if (admin === 'recover') {
    const oldTime = new Date(start-51*60000).toISOString(), oldGeneration = 'd'.repeat(64);
    const oldJob = {trackId:track,generation:oldGeneration,baseVersion:time(`${boards}/${track}`),readTime:oldTime,
      afterName:base+results+'/'+rows[1899].accountId+'_'+track,sourceCount:1900,parts:19,complete:false,
      blocked:true,blockedReason:'snapshot_expired',startedAt:start-51*60000,updatedAt:start-60000};
    data.set(`${TRACK_BUILD_JOBS}/${trackBuildId(track)}`,oldJob);
    for(let part=0;part<19;part++) {
      const key=`${TRACK_BUILD_PARTS}/${oldGeneration}_${part}`,value={entries:[{oldPaidPart:part}]};
      oldParts.set(key,structuredClone(value));data.set(key,value);
    }
    data.set(`${TRACK_BUILD_JOBS}/canonical_reconcile_v2`,{schemaVersion:2,backfillComplete:true,
      pendingTrackIds:[track],pendingFullRebuildTrackIds:[track],activeFullRebuildTrackId:'',
      pendingResultIds:{[track]:rows.slice(0,200).map(row=>row.accountId+'_'+track)},
      pendingResultBindings:{retained:'unchanged'},failedFullRebuilds:{[track]:{attempts:1,retryAt:start+3600000}}});
  }
  const originalNow = Date.now, counts = [], documentCounts = [], writeCounts = [], cpuMicros = [];
  let result;
  Date.now = () => now;
  try {
    for (let minute = 0; minute <= (expires?55:35); minute += cadence) {
      now = start + minute * 60000 + (minute && !admin ? 59999 : 0);
      requests.length = 0;
      writesThisPass = 0;
      proofReads.current = 0; proofReads.historical = 0;
      env.__FIRESTORE_READ_AUDIT={httpRequests:0,failedRequests:0,documentReadEstimate:0,collections:{}};
      const cpuStart=process.cpuUsage(),queryStart=queries.length;
      if(admin && (minute || admin==='recover')) {
        const job=data.get(`${TRACK_BUILD_JOBS}/${trackBuildId(track)}`);
        const request=new Request('https://offline.test/v1/admin/track-build/continue',{
          method:'POST',headers:{Origin:env.ALLOWED_ORIGINS,'X-Admin-Token':env.ADMIN_REBUILD_TOKEN},
          body:JSON.stringify({trackId:track,generation:job.generation,
            checkpointVersion:time(`${TRACK_BUILD_JOBS}/${trackBuildId(track)}`),
            recoverExpired:minute===0 && admin==='recover'})});
        const originalLog=console.log;
        let response;
        console.log=(message,payload)=>{if(message==='Ranked request Firestore reads')env.__FIRESTORE_READ_AUDIT=JSON.parse(payload);};
        try { response=await handleRequest(request,env); } finally { console.log=originalLog; }
        assert.equal(response.status,200);
        const body=await response.json();
        if(body.pending) {
          assert.equal(body.continueAfterMs,30000);
          assert.equal(body.deadlineAt,start+TRACK_BUILD_MAX_AGE_MS);
          assert.equal(body.generation,data.get(`${TRACK_BUILD_JOBS}/${trackBuildId(track)}`).generation);
          result={pending:true};
        } else result={entries:await loadPublicationEntries(data.get(`${boards}/${track}`),'track',track,
          async(c,id)=>({data:data.get(c+'/'+id)}))};
        assert(requests.length<=45,'scoped endpoint retains 42 work / 45 total request cap');
      } else result = await rebuildTrack(env,track);
      const cpu=process.cpuUsage(cpuStart);cpuMicros.push(cpu.user+cpu.system);
      if(admin) {
        assert(queries.length-queryStart<=2,'no hidden page loop or global discovery');
        assert(cpuMicros.at(-1)<5e6,'offline CPU regression ceiling: five CPU seconds per bounded call, not a live SLA');
        assert(writesThisPass<=260,'bounded two-page proof/part writes plus publication and recovery/queue checkpoint');
      }
      assert(env.__FIRESTORE_READ_AUDIT.documentReadEstimate <= (minute === 0 ? 310 : 650),
        `pass document reads: ${env.__FIRESTORE_READ_AUDIT.documentReadEstimate}`);
      if(minute===0){
        assert.equal(env.__FIRESTORE_READ_AUDIT.collections[results],100);
        assert.deepEqual(proofReads, {current:100, historical:verified ? 0 : 100},
          'every fresh proof remains required; missing shards still need historical reads');
        assert.equal(env.__FIRESTORE_READ_AUDIT.collections[VERIFICATION_COLLECTION], verified ? 101 : 201,
          'one unchanged root plus every required fresh and historical shard');
      }
      documentCounts.push(env.__FIRESTORE_READ_AUDIT.documentReadEstimate);
      writeCounts.push(writesThisPass);
      counts.push(requests.length);
      if (!result.pending) break;
    }
  } finally { Date.now = originalNow; }
  if(expires){
    assert.equal(result.blocked,true);
    assert.equal(result.reason,'snapshot_expired');
    assert.equal(data.get(`${TRACK_BUILD_JOBS}/${trackBuildId(track)}`).sourceCount,1900);
    assert.equal(data.get(`${TRACK_BUILD_JOBS}/${trackBuildId(track)}`).complete,false);
    assert.equal(queries.length,19,'expiry and subsequent blocked turn do not rescan canonical data');
    assert.equal(queries.filter(q=>!q.readTime).length,1,'no repeated initial prefix');
    assert.equal(partBatches.length,0,'partial source coverage never reaches final assembly');
    assert.equal(data.get(`${boards}/${track}`)?.revision,priorPaged?1:undefined,'old board remains unchanged');
    return;
  }
  assert.equal(result.pending, undefined);
  assert.equal(result.entries.length, count);
  if(count===900||count===1000){
    assert.equal(counts.length,6,'initial pass plus five real five-minute continuation turns');
    assert(now-start<26*60000,'publication completes at 25 minutes plus sub-minute scheduler jitter');
    assert(now-start<TRACK_BUILD_MAX_AGE_MS,'publication must finish before fixed-snapshot expiry');
  }
  assert.equal(data.get(`${boards}/${track}`).totalEntries, count);
  assert.equal(result.entries.filter(row=>row.runVerified===true).length,verified?count-(heldProof?1:0):0);
  if(heldProof)assert.deepEqual(data.get(`${VERIFICATION_COLLECTION}/${verificationShardId(track,rows[0].accountId)}`).slots[rows[0].accountId],heldProof);
  assert.equal(data.get(`${TRACK_BUILD_JOBS}/${trackBuildId(track)}`).complete, true);
  assert.equal(queries.filter(q => !q.readTime).length, 1);
  assert(queries.every(q=>q.structuredQuery.limit===100));
  assert(queries.filter(q => q.readTime).every(q => q.readTime === new Date(start).toISOString()));
  assert.equal(partBatches.length, 1, 'final assembly uses exactly one batchGet');
  assert.equal(partBatches[0].length,Math.ceil(count/100),'the final batch includes every part');
  assert.equal(requests.filter(route => route.startsWith('/'+TRACK_BUILD_PARTS+'/')).length, 0);
  if(admin) {
    assert(now-start<13*60000,'2397 and 5000 rows finish within 13 minutes at bounded 30-second cadence');
    assert(now-start<TRACK_BUILD_MAX_AGE_MS);
    assert(counts.length<=26,'no more than 26 calls for a 5000-row generation, including EOF');
    const queue=data.get(`${TRACK_BUILD_JOBS}/canonical_reconcile_v2`);
    assert(!queue.pendingFullRebuildTrackIds.includes(track));
    assert.equal(queue.activeFullRebuildTrackId,'');
    if(admin==='recover') {
      for(const [key,value]of oldParts)assert.deepEqual(data.get(key),value,'never erase or freshen old paid parts');
      const archive=data.get(`${TRACK_BUILD_JOBS}/${trackBuildId(track)}_deadline_recovery_v1`);
      assert.equal(archive.checkpoint.sourceCount,1900);assert.equal(archive.checkpoint.parts,19);
      assert.equal(archive.checkpoint.blockedReason,'snapshot_expired');
      assert.equal(queue.pendingResultIds[track].length,200,'post-readpoint keyed bindings stay queued');
      assert.deepEqual(queue.pendingResultBindings,{retained:'unchanged'});
    }
  }
  console.log('Track build quota counts', JSON.stringify({count,verified,priorPaged,
    admin:admin||false,calls:counts.length,elapsedMs:now-start,
    initialDocuments:documentCounts[0],maxDocuments:Math.max(...documentCounts),maxRequests:Math.max(...counts),
    totalReads:documentCounts.reduce((a,b)=>a+b,0),totalWrites:writeCounts.reduce((a,b)=>a+b,0),
    maxWrites:Math.max(...writeCounts),maxCpuMicros:Math.max(...cpuMicros)}));
});
}
