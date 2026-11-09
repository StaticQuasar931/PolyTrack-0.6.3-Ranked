import test from 'node:test';
import assert from 'node:assert/strict';
import {handleRequest, rebuildTrack} from '../src/index.js';
import {continueQueuedTrackBuild} from '../src/track-build-continuation.js';
import {advanceTrackBuild,trackBuildId,TRACK_BUILD_JOBS,TRACK_BUILD_PARTS,TRACK_BUILD_MAX_AGE_MS} from '../src/track-build.js';
import {eventEncode} from '../src/events-store.js';

const now=Date.UTC(2026,10,8),trackId='deadline-track',generation='a'.repeat(64),version='checkpoint-v1';
const queueId='canonical_reconcile_v2',boardCollection='0.6.2_s1_leaderboards_track';
const input={trackId,generation,checkpointVersion:version};
function fixture({expired=false}={}) {
  const docs=new Map(),reads=[],writes=[],rebuilds=[];
  const queue={pendingTrackIds:[trackId,'sibling-track'],pendingFullRebuildTrackIds:[trackId,'sibling-track'],
    activeFullRebuildTrackId:trackId,pendingResultIds:{[trackId]:['later-result']},pendingResultBindings:{later:'binding'},
    failedFullRebuilds:{[trackId]:{attempts:1,retryAt:now+3600000},'sibling-track':{attempts:2,retryAt:now+3600000}},
    cursorDocumentId:'unchanged',backfillComplete:true};
  docs.set(TRACK_BUILD_JOBS+'/'+queueId,{data:queue,updateTime:'queue-v1'});
  docs.set(boardCollection+'/'+trackId,{data:{revision:7},updateTime:'board-v1'});
  docs.set(TRACK_BUILD_JOBS+'/'+trackBuildId(trackId),{updateTime:version,data:{trackId,generation,
    baseVersion:'board-v1',complete:false,readTime:new Date(now-(expired?TRACK_BUILD_MAX_AGE_MS:60000)).toISOString(),
    afterName:'paid-cursor',parts:19,sourceCount:1900,
    ...(expired?{blocked:true,blockedReason:'snapshot_expired'}:{})}});
  let result={pending:true,generation,checkpointVersion:'checkpoint-v2',sourceCount:2100,
    sourceReadTime:new Date(now-60000).toISOString()};
  let error,commitError;
  const adapters={now,
    read:async(c,id)=>{reads.push([c,id]);return structuredClone(docs.get(c+'/'+id)||null);},
    commit:async batch=>{
      if(commitError)throw Error(commitError);
      for(const w of batch)assert.deepEqual(w.prior||null,docs.get(w.collection+'/'+w.id)||null,'CAS preimage');
      writes.push(...structuredClone(batch));
      for(const w of batch)docs.set(w.collection+'/'+w.id,{data:structuredClone(w.data),updateTime:'committed-'+writes.length});
      return {writeResults:batch.map(()=>({updateTime:'committed-'+writes.length}))};
    },
    rebuild:async(id,options)=>{rebuilds.push({id,options});if(error)throw Error(error);return structuredClone(result);}
  };
  return {docs,reads,writes,rebuilds,adapters,
    queue:()=>docs.get(TRACK_BUILD_JOBS+'/'+queueId).data,
    job:()=>docs.get(TRACK_BUILD_JOBS+'/'+trackBuildId(trackId)),
    result:value=>{result=value;},fail:value=>{error=value;},commitFail:value=>{commitError=value;},
    run:overrides=>continueQueuedTrackBuild({...input,...overrides},adapters)};
}

test('admin route rejects missing/wrong credentials and malformed bodies before storage',async()=>{
  const origin='https://staticquasar931.github.io',token='offline-fixture-only';
  let calls=0;
  const env={ALLOWED_ORIGINS:origin,ADMIN_REBUILD_TOKEN:token,__TEST_FIRESTORE:()=>{calls++;assert.fail('unexpected storage');}};
  const log=console.log;console.log=()=>{};
  try {
    for(const supplied of [undefined,'wrong']) {
      const response=await handleRequest(new Request('https://offline.test/v1/admin/track-build/continue',{
        method:'POST',headers:{Origin:origin,...(supplied?{'X-Admin-Token':supplied}:{})},body:'{}'}),env);
      assert.equal(response.status,403);
    }
    for(const body of ['null','[]','{','"text"','x'.repeat(2049),'{}']) {
      const response=await handleRequest(new Request('https://offline.test/v1/admin/track-build/continue',{
        method:'POST',headers:{Origin:origin,'X-Admin-Token':token},body}),env);
      assert.equal(response.status,400);
    }
  } finally {console.log=log;}
  assert.equal(calls,0);
});

test('invalid checkpoints are rejected with zero reads and no implicit rebuild',async()=>{
  for(const bad of [{trackId:'x'},{generation:'bad'},{checkpointVersion:''},{recoverExpired:1},{generation:[generation]}]) {
    const f=fixture();assert.equal((await f.run(bad)).status,400);assert.equal(f.reads.length,0);
    assert.equal(f.rebuilds.length,0);assert.equal(f.writes.length,0);
  }
});

test('explicit idle/completed track calls do one coordination read, zero writes or canonical work',async()=>{
  const f=fixture();f.queue().pendingFullRebuildTrackIds=[];
  for(let n=0;n<3;n++)assert.equal((await f.run()).body.error,'track_build_not_queued');
  assert.equal(f.reads.length,3);assert.equal(f.writes.length,0);assert.equal(f.rebuilds.length,0);
});

test('another active track is never selected or rebuilt',async()=>{
  const f=fixture();f.queue().activeFullRebuildTrackId='sibling-track';
  assert.equal((await f.run()).body.error,'another_track_build_active');
  assert.equal(f.reads.length,1);assert.equal(f.rebuilds.length,0);
});

for(const change of ['version','generation','base','completed','not-due','expired'])
test('stale, invalid or early checkpoint stops before source work: '+change,async()=>{
  const f=fixture({expired:change==='expired'}),job=f.job();
  if(change==='version')job.updateTime='different';
  if(change==='generation')job.data.generation='b'.repeat(64);
  if(change==='base')job.data.baseVersion='other';
  if(change==='completed')job.data.complete=true;
  if(change==='not-due')job.data.nextContinuationAt=now+1;
  const response=await f.run();assert.equal(response.status,change==='not-due'?429:409);
  assert.equal(f.reads.length,3);assert.equal(f.rebuilds.length,0);assert.equal(f.writes.length,0);
});

test('one scoped pass preserves sibling work, keyed bindings, cursors and queue CAS',async()=>{
  const f=fixture(),previous=structuredClone(f.queue());
  const response=await f.run();assert.equal(response.status,200);assert.equal(response.body.continueAfterMs,30000);
  assert.equal(f.rebuilds.length,1);assert.equal(f.rebuilds[0].id,trackId);
  assert.equal(f.rebuilds[0].options.continuation,true);
  assert.deepEqual(f.queue().pendingResultIds,previous.pendingResultIds);
  assert.deepEqual(f.queue().pendingResultBindings,previous.pendingResultBindings);
  assert.deepEqual(f.queue().failedFullRebuilds['sibling-track'],previous.failedFullRebuilds['sibling-track']);
  assert.equal(f.queue().cursorDocumentId,previous.cursorDocumentId);
  assert.equal(f.writes.length,1);assert.equal(f.writes[0].prior.updateTime,'queue-v1');
});

test('completion publishes original CAS documents and selected queue discharge in one commit',async()=>{
  const f=fixture(),prior=structuredClone(f.docs.get(boardCollection+'/'+trackId));
  const publication={collection:boardCollection,id:trackId,prior,data:{revision:8}};
  f.result({revision:8,publicationDocuments:[publication]});
  assert.equal((await f.run()).body.complete,true);
  assert.equal(f.writes.length,2);assert.deepEqual(f.writes[0],publication);
  assert.equal(f.queue().pendingFullRebuildTrackIds.includes(trackId),false);
  assert.equal(f.queue().pendingFullRebuildTrackIds.includes('sibling-track'),true);
  assert.equal(f.queue().pendingTrackIds.includes(trackId),true,'post-readpoint keyed work stays queued');
  assert.equal(f.queue().activeFullRebuildTrackId,'');
});

test('completion queue CAS conflict propagates without publishing or discharging',async()=>{
  const f=fixture(),before=structuredClone(f.docs);
  f.result({revision:8,publicationDocuments:[]});f.commitFail('FIRESTORE_412');
  await assert.rejects(f.run(),/FIRESTORE_412/);assert.deepEqual(f.docs,before);
});

test('legacy expired recovery archives exact checkpoint, consumes once, and preserves old parts',async()=>{
  const f=fixture({expired:true}),old=structuredClone(f.job());
  f.docs.set(TRACK_BUILD_PARTS+'/old-part',{data:{entries:['paid']}});
  assert.equal((await f.run({recoverExpired:true})).status,200);
  const archive=f.docs.get(TRACK_BUILD_JOBS+'/'+trackBuildId(trackId)+'_deadline_recovery_v1');
  assert.deepEqual(archive.data.checkpoint,old.data);assert.equal(archive.data.checkpointVersion,old.updateTime);
  assert.deepEqual(f.docs.get(TRACK_BUILD_PARTS+'/old-part'),{data:{entries:['paid']}});
  assert.equal(f.rebuilds[0].options.recovery,true);
  const again=await f.run({recoverExpired:true,checkpointVersion:f.job().updateTime});
  assert.equal(again.body.error,'track_build_recovery_not_eligible');assert.equal(f.rebuilds.length,1);
});

test('failed recovery query is consumed before source work and cannot renew forever',async()=>{
  const f=fixture({expired:true});f.fail('SOURCE_FAILED');
  await assert.rejects(f.run({recoverExpired:true}),/SOURCE_FAILED/);
  assert.equal(f.job().data.deadlineRecovery.reserved,true);
  assert.equal(f.writes.length,2,'only archive and consumed reservation');
  const response=await f.run({recoverExpired:true,checkpointVersion:f.job().updateTime});
  assert.equal(response.status,409);assert.equal(f.rebuilds.length,1);
  assert.equal((await f.run({checkpointVersion:f.job().updateTime})).body.error,'track_build_blocked');
});

test('failed recovery reservation CAS consumes no prefix and changes nothing',async()=>{
  const f=fixture({expired:true}),before=structuredClone(f.docs);f.commitFail('FIRESTORE_412');
  await assert.rejects(f.run({recoverExpired:true}),/FIRESTORE_412/);
  assert.equal(f.rebuilds.length,0);assert.deepEqual(f.docs,before);
});

test('upgraded generations, invalid clocks and different blocked reasons cannot get recovery',async()=>{
  for(const change of ['policy','reason','clock']) {
    const f=fixture({expired:true});
    if(change==='policy')f.job().data.deadlinePolicy=1;
    if(change==='reason')f.job().data.blockedReason='snapshot_time_invalid';
    if(change==='clock')f.job().data.readTime='invalid';
    assert.equal((await f.run({recoverExpired:true})).body.error,'track_build_recovery_not_eligible');
    assert.equal(f.rebuilds.length,0);assert.equal(f.writes.length,0);
  }
});

test('normalizing a later source page must reject backwards and within-page nonmonotone cursors',async()=>{
  for(const names of [['a'],['z','y'],['z','z']]) {
    await assert.rejects(advanceTrackBuild({trackId,now,prior:{updateTime:'base'},
      job:{data:{complete:false,baseVersion:'base',readTime:new Date(now).toISOString(),afterName:'m'}},
      readPage:async()=>({documents:names.map(name=>({name,data:{}})),readTime:new Date(now).toISOString()}),
      normalize:()=>assert.fail('invalid cursor must not reach normalization')}),/CURSOR_INVALID/);
  }
});

test('real rebuild adapter exhausts the shared 42-work request budget before a new source read',async()=>{
  const calls=[],budget={used:40,limit:42};
  await assert.rejects(rebuildTrack({__OVERALL_REQUEST_BUDGET:budget,
    __TEST_FIRESTORE:async(path)=>{calls.push(path);return null;}},trackId),/OVERALL_REQUEST_BUDGET_EXHAUSTED/);
  assert.equal(budget.used,42);assert.equal(calls.length,2);
  assert.equal(calls.some(path=>path.startsWith(':')),false,'no query or write escapes budget');
});

test('initial source readTime is checked after network completion, not against invocation start',async t=>{
  let clock=now;
  t.mock.method(Date,'now',()=>clock);
  const result=await rebuildTrack({__TEST_FIRESTORE:async(path,init={})=>{
    if(path===':runQuery') {
      clock+=1000;
      return Array.from({length:100},(_,i)=>({document:{name:'documents/'+String(i).padStart(8,'0'),
        fields:eventEncode({}).mapValue.fields},readTime:new Date(clock).toISOString()}));
    }
    if(path===':commit')return {writeResults:JSON.parse(init.body).writes.map(()=>({updateTime:'checkpoint'}))};
    return null;
  }},trackId);
  assert.equal(result.pending,true);
  assert.equal(result.sourceReadTime,new Date(clock).toISOString());
});
