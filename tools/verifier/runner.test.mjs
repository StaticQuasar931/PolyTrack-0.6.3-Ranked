import assert from 'node:assert/strict';
import test from 'node:test';
import {encode, decode} from './firestore.mjs';
import {orderSelectedJobsFastestFirst, publishResults, prioritizeQueueDocuments, selectJobs, verifiedControlReference, verifiedTrackCounts} from './runner.mjs';
import {VERIFICATION_COLLECTION, VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION, pendingSlot, verificationKey} from '../../workers/ranked/src/verification.js';

const TRACK='5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const row={accountId:'racer',trackId:TRACK,timeMs:20000,raceTimeFrames:20000,frames:20000,uploadId:7,replayHash:'a'.repeat(64),replay:'fixture'};
const job={...row,resultId:`racer_${TRACK}`,queueKey:verificationKey(row),queueCollection:VERIFICATION_COLLECTION};
const verified={resultId:job.resultId,status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,reason:''};

test('native job ordering sorts each track by time without changing track slots',()=>{
 const jobs=[{trackId:'a',timeMs:900,tag:'slow'},{trackId:'b',timeMs:600,tag:'other'},
  {trackId:'a',timeMs:100,tag:'fast'},{trackId:'a',timeMs:400,tag:'middle'}];
 assert.deepEqual(orderSelectedJobsFastestFirst(jobs).map(job=>job.tag),['fast','other','middle','slow']);
});

test('verified control references require current engine and exact key bindings',()=>{
 const key=JSON.stringify([VERIFIER_VERSION,VERIFIER_ENGINE_DIGEST,'other',TRACK,20000,1,7,'a'.repeat(64)]);
 const slot={accountId:'other',resultId:`other_${TRACK}`,trackId:TRACK,status:'verified',key,
  engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,
  controlProof:{version:1,engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,key,
   accountId:'other',trackId:TRACK,timeMs:20000,replayHash:'a'.repeat(64),signature:'b'.repeat(64),transitions:20,informative:true}};
 assert.equal(verifiedControlReference(slot,TRACK).signature,'b'.repeat(64));
 assert.equal(verifiedControlReference({...slot,engineDigest:'stale'},TRACK),null);
 assert.equal(verifiedControlReference({...slot,controlProof:{...slot.controlProof,informative:false}},TRACK),null);
 assert.equal(verifiedControlReference({...slot,controlProof:{...slot.controlProof,key:'mismatch'}},TRACK),null);
});

test('unavailable retry preserves a matching accepted current-engine slot and proof',async()=>{
 const key=job.queueKey;
 const proof={version:1,engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,key,
  accountId:'racer',trackId:TRACK,timeMs:row.timeMs,replayHash:row.replayHash,signature:'c'.repeat(64),transitions:24,informative:true};
 const accepted={accountId:'racer',resultId:job.resultId,trackId:TRACK,key,status:'verified',attempts:2,
  engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,controlProof:proof};
 const queue={data:{trackId:TRACK,slots:{racer:accepted}},updateTime:'queue-v1'};const reads={queue:0,canonical:0,state:0,audit:0};let writes=0,commits=0;
 const db={get:async(collection)=>{
   if(collection===VERIFICATION_COLLECTION){reads.queue++;return queue;}
   if(collection==='0.6.2_race_results'){reads.canonical++;return {data:row,updateTime:'result-v1'};}
   if(collection==='0.6.2_s1_worker_jobs'){reads.state++;return {data:{pendingTrackIds:[],pendingResultIds:{}},updateTime:'state-v1'};}
   if(collection==='0.6.2_s1_verification_audit'){reads.audit++;return null;}
   return null;
  },write:(...args)=>{writes++;return args;},call:async()=>{commits++;}};
 const totals=await publishResults(db,[job],[{resultId:job.resultId,status:'unavailable',reason:'native_engine_error'}]);
 assert.equal(totals.unavailable,0);
 assert.equal(totals.deferred,1);
 assert.equal(totals.reasons.accepted_proof_preserved,1);
 assert.deepEqual(reads,{queue:1,canonical:1,state:0,audit:0});
 assert.equal(writes,0);
 assert.equal(commits,0);
 assert.equal(queue.data.slots.racer.status,'verified');
 assert.equal(queue.data.slots.racer.engineDigest,VERIFIER_ENGINE_DIGEST);
 assert.deepEqual(queue.data.slots.racer.controlProof,proof);
 assert.equal(queue.data.slots.racer.attempts,2);
});

test('accepted proof preservation requires a fresh queue and matching current canonical key',async()=>{
 const key=job.queueKey;
 const proof={version:1,engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,key,
  accountId:'racer',trackId:TRACK,timeMs:row.timeMs,replayHash:row.replayHash,signature:'e'.repeat(64),transitions:24,informative:true};
 const accepted={accountId:'racer',resultId:job.resultId,trackId:TRACK,key,status:'verified',attempts:2,
  engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,controlProof:proof};
 const stalePreimage={data:{trackId:TRACK,slots:{racer:{accountId:'racer',resultId:job.resultId,trackId:TRACK,key,status:'waiting',attempts:0}}},updateTime:'queue-stale'};
 const freshQueue={data:{trackId:TRACK,slots:{racer:accepted,other:{accountId:'other',status:'waiting'}}},updateTime:'queue-fresh'};
 const changedCanonical={...row,timeMs:row.timeMs+1};const reads={queue:0,state:0,audit:0};let commits=0;
 const selection=await selectJobs({get:async collection=>collection==='0.6.2_race_results'?{data:row,updateTime:'result-v1'}:null,
  write:(...args)=>args,call:async()=>{}},[stalePreimage],Date.now());
 assert.equal(selection.jobs.length,1);
 const db={get:async(collection)=>{
   if(collection===VERIFICATION_COLLECTION){reads.queue++;return freshQueue;}
   if(collection==='0.6.2_race_results')return {data:changedCanonical,updateTime:'result-v2'};
   if(collection==='0.6.2_s1_worker_jobs'){reads.state++;return {data:{pendingTrackIds:[],pendingResultIds:{}},updateTime:'state-v1'};}
   if(collection==='0.6.2_s1_verification_audit'){reads.audit++;return null;}
   return null;
  },write:(...args)=>args,call:async()=>{commits++;}};
 const totals=await publishResults(db,selection.jobs,[{resultId:job.resultId,status:'unavailable',reason:'native_engine_error'}]);
 assert.equal(totals.superseded,1);
 assert.equal(totals.deferred,0);
 assert.deepEqual(reads,{queue:1,state:0,audit:0});
 assert.equal(commits,0);
 assert.equal(freshQueue.data.slots.racer.status,'verified','the fresh queue contains the concurrent accepted proof');
});

test('unavailable retry does not preserve a stale-engine native receipt',async()=>{
 const key=job.queueKey;
 const staleProof={version:1,engineDigest:'stale-engine',verifierVersion:VERIFIER_VERSION,key,
  accountId:'racer',trackId:TRACK,timeMs:row.timeMs,replayHash:row.replayHash,signature:'d'.repeat(64),transitions:24,informative:true};
 const accepted={accountId:'racer',resultId:job.resultId,trackId:TRACK,key,status:'verified',attempts:2,
  engineDigest:'stale-engine',verifierVersion:VERIFIER_VERSION,controlProof:staleProof};
 const queue={data:{trackId:TRACK,slots:{racer:accepted}},updateTime:'queue-v1'};let committed;
 const db={get:async(collection)=>collection===VERIFICATION_COLLECTION?queue:collection==='0.6.2_race_results'?{data:row,updateTime:'result-v1'}:collection==='0.6.2_s1_worker_jobs'?{data:{pendingTrackIds:[],pendingResultIds:{}},updateTime:'state-v1'}:null,
  write:(collection,id,data,prior)=>({collection,id,data,prior}),call:async(_path,{writes})=>{committed=writes;return {};}};
 await publishResults(db,[job],[{resultId:job.resultId,status:'unavailable',reason:'native_engine_error'}]);
 const saved=committed.find(write=>write.collection===VERIFICATION_COLLECTION).data.slots.racer;
 assert.equal(saved.status,'unavailable');
 assert.equal(saved.controlProof,undefined);
});

test('missing leaderboard metadata uses neutral track impact and names verified tracks',async()=>{
 const docs=['unknown-track', 'known-track'].map((trackId,index)=>({data:{trackId,notBefore:index}}));
 const prioritized=await prioritizeQueueDocuments({get:async()=>({data:{trackSummaries:[{trackId:'known-track',weight:0}]}})},docs,100);
 assert.equal(prioritized.find(doc=>doc.data.trackId==='unknown-track').priorityWeight,1);
 assert.equal(prioritized.find(doc=>doc.data.trackId==='known-track').priorityWeight,0);
 const named=verifiedTrackCounts({[TRACK]:6,'unknown-track':2,'8afde3be59f8ec440e9969675babe4b27304fe6f26e97c6e8ab7b06f62616be4':3,'05c240fcc165ececc98db82a2218afee47e6c14947fc1e0df591c4c6d110493f':4});
 assert.deepEqual(named.find(track=>track.trackId===TRACK),{trackId:TRACK,trackName:'Summer 1',count:6});
 assert.deepEqual(named.find(track=>track.trackId==='8afde3be59f8ec440e9969675babe4b27304fe6f26e97c6e8ab7b06f62616be4'),{trackId:'8afde3be59f8ec440e9969675babe4b27304fe6f26e97c6e8ab7b06f62616be4',trackName:'Sylvan Speedway',count:3});
 assert.deepEqual(named.find(track=>track.trackId==='05c240fcc165ececc98db82a2218afee47e6c14947fc1e0df591c4c6d110493f'),{trackId:'05c240fcc165ececc98db82a2218afee47e6c14947fc1e0df591c4c6d110493f',trackName:'A10 Acrobatic',count:4});
 assert.deepEqual(named.find(track=>track.trackId==='unknown-track'),{trackId:'unknown-track',trackName:'unknown-track',count:2});
});

test('publication adds the exact result ID to bounded reconciliation work in the same CAS transaction',async()=>{
 let committed;
 const queue={data:{trackId:TRACK,slots:{racer:{accountId:'racer',resultId:job.resultId,trackId:TRACK,key:job.queueKey,status:'waiting',attempts:0}}},updateTime:'queue-v1'};
 const db={
  get:async(collection,id)=>collection===VERIFICATION_COLLECTION?queue:collection==='0.6.2_race_results'?{data:row,updateTime:'result-v1'}:collection==='0.6.2_s1_worker_jobs'?{data:{pendingTrackIds:[],pendingResultIds:{}},updateTime:'job-v1'}:null,
  write:(collection,id,data,prior)=>({collection,id,data,prior}),
  call:async(path,{writes})=>{committed=writes;return {};}
 };
 const totals=await publishResults(db,[job],[verified]);
 assert.deepEqual(totals.verifiedByTrack,{[TRACK]:1});
 const wake=committed.find(write=>write.collection==='0.6.2_s1_worker_jobs');
 assert.deepEqual(wake.data.pendingTrackIds,[TRACK]);
 assert.deepEqual(wake.data.pendingResultIds,{[TRACK]:[job.resultId]});
 assert.equal(wake.prior.updateTime,'job-v1');
});

test('selection queue CAS preimage avoids a publication queue read when unchanged',async()=>{
 const slot=pendingSlot(row),queue={data:{trackId:TRACK,slots:{racer:slot}},updateTime:'queue-v1'};
 const reads={queue:0,canonical:0,state:0,audit:0};let committed;
 const db={get:async(collection)=>{
  if(collection===VERIFICATION_COLLECTION){reads.queue++;return queue;}
  if(collection==='0.6.2_race_results'){reads.canonical++;return {data:row,updateTime:'canonical-v1'};}
  if(collection==='0.6.2_s1_worker_jobs'){reads.state++;return {data:{pendingTrackIds:[],pendingResultIds:{}},updateTime:'state-v1'};}
  if(collection==='0.6.2_s1_verification_audit'){reads.audit++;return null;}
  return null;
 },write:(collection,id,data,prior)=>({collection,id,data,prior}),call:async(_path,{writes})=>{committed=writes;return {writeResults:[{updateTime:'queue-v2'},{updateTime:'state-v2'}]};}};
 const selection=await selectJobs(db,[queue],Date.now());
 assert.equal(selection.jobs.length,1);
 await publishResults(db,selection.jobs,[{...verified,resultId:job.resultId}]);
 assert.deepEqual(reads,{queue:0,canonical:2,state:1,audit:1});
 assert.equal(committed[0].prior.updateTime,'queue-v1');
});

test('stale selected queue preimage conflicts, rereads, and preserves concurrent queue changes',async()=>{
 const slot=pendingSlot(row),stale={data:{trackId:TRACK,slots:{racer:slot}},updateTime:'queue-v1'};
 let live={...stale},attempt=0,queueReads=0,committedQueue;
 const conflict=Object.assign(Error('stale queue'),{status:412});
 const db={get:async(collection)=>{
  if(collection===VERIFICATION_COLLECTION){queueReads++;return live;}
  if(collection==='0.6.2_race_results')return {data:row,updateTime:'canonical-v1'};
  if(collection==='0.6.2_s1_worker_jobs')return {data:{pendingTrackIds:[],pendingResultIds:{}},updateTime:'state-v1'};
  return null;
 },write:(collection,id,data,prior)=>({collection,id,data,prior}),call:async(_path,{writes})=>{
  attempt++;
  if(attempt===1){
   live={data:{...live.data,slots:{...live.data.slots,other:{accountId:'other',status:'waiting'}}},updateTime:'queue-v2'};
   throw conflict;
  }
  committedQueue=writes[0];
  return {writeResults:[{updateTime:'queue-v3'},{updateTime:'state-v3'}]};
 }};
 const selection=await selectJobs(db,[stale],Date.now());
 await publishResults(db,selection.jobs,[{...verified,resultId:job.resultId}]);
 assert.equal(attempt,2);
 assert.equal(queueReads,1);
 assert.equal(committedQueue.prior.updateTime,'queue-v2');
 assert.deepEqual(committedQueue.data.slots.other,live.data.slots.other);
});

test('later same-track jobs cannot reuse selection preimages after cache invalidation',async()=>{
 const secondRow={...row,accountId:'racer2',uploadId:8};
 const slots={racer:pendingSlot(row),racer2:pendingSlot(secondRow)};
 const original={data:{trackId:TRACK,slots},updateTime:'queue-v1'};
 let live={...original},queueReads=0,commits=0,retryWrite;
 const state={data:{pendingTrackIds:[],pendingResultIds:{}},updateTime:'state-v1'};
 const db={get:async(collection,id)=>{
  if(collection==='0.6.2_race_results')return {data:id===job.resultId?row:secondRow,updateTime:'canonical-v1'};
  if(collection===VERIFICATION_COLLECTION){queueReads++;return live;}
  if(collection==='0.6.2_s1_worker_jobs')return state;
  if(collection==='0.6.2_s1_verification_audit')return null;
  return null;
 },write:(collection,id,data,prior)=>({collection,id,data,prior}),call:async(_path,{writes})=>{
  commits++;
  if(commits===1){live={data:writes[0].data,updateTime:'queue-after-first'};return {};}
  if(commits===2){
   live={data:{...live.data,slots:{...live.data.slots,other:{accountId:'other',status:'waiting'}}},updateTime:'queue-external'};
   throw Object.assign(Error('concurrent queue update'),{status:412});
  }
  retryWrite=writes[0];return {};
 }};
 const selection=await selectJobs(db,[original],Date.now());
 assert.deepEqual(selection.jobs.map(item=>item.accountId),['racer','racer2']);
 await publishResults(db,selection.jobs,[{...verified,resultId:job.resultId},{...verified,resultId:secondRow.accountId+'_'+TRACK}]);
 assert.equal(commits,3);
 assert.equal(queueReads,2,'second job conflict and retry both fetch current queue state');
 assert.equal(retryWrite.prior.updateTime,'queue-external');
 assert.deepEqual(retryWrite.data.slots.other,live.data.slots.other);
});

test('publication falls back to the existing track queue when the 200-ID bound is full',async()=>{
 let wake;
 const queue={data:{trackId:TRACK,slots:{racer:{accountId:'racer',resultId:job.resultId,trackId:TRACK,key:job.queueKey,status:'waiting',attempts:0}}},updateTime:'queue-v1'};
 const pendingResultIds=Object.fromEntries(Array.from({length:200},(_,index)=>[`track-${index}`,[`racer_track-${index}`]]));
 const db={get:async(collection)=>collection===VERIFICATION_COLLECTION?queue:collection==='0.6.2_race_results'?{data:row}:collection==='0.6.2_s1_worker_jobs'?{data:{pendingTrackIds:[],pendingResultIds},updateTime:'job-v1'}:null,
  write:(collection,id,data,prior)=>({collection,id,data,prior}),call:async(path,{writes})=>{wake=writes.find(write=>write.collection==='0.6.2_s1_worker_jobs');return {};}};
 await publishResults(db,[job],[verified]);
 assert.deepEqual(wake.data.pendingTrackIds,[TRACK]);
 assert.equal(wake.data.pendingResultIds[TRACK],undefined);
 assert.equal(Object.values(wake.data.pendingResultIds).reduce((n,ids)=>n+ids.length,0),200);
});

test('a later publication cannot turn an overflow fallback track back into targeted work',async()=>{
 const secondRow={...row,accountId:'racer2',uploadId:8};
 const secondJob={...job,...secondRow,resultId:`racer2_${TRACK}`,queueKey:verificationKey(secondRow)};
 let state={pendingTrackIds:[],pendingResultIds:Object.fromEntries(Array.from({length:200},(_,index)=>[`track-${index}`,[`racer_track-${index}`]]))};
 const queue={data:{trackId:TRACK,slots:{
  racer:{accountId:'racer',resultId:job.resultId,trackId:TRACK,key:job.queueKey,status:'waiting',attempts:0},
  racer2:{accountId:'racer2',resultId:secondJob.resultId,trackId:TRACK,key:secondJob.queueKey,status:'waiting',attempts:0}
 }},updateTime:'queue-v1'};
 const db={get:async(collection,id)=>collection===VERIFICATION_COLLECTION?queue:collection==='0.6.2_race_results'?{data:id===job.resultId?row:secondRow}:collection==='0.6.2_s1_worker_jobs'?{data:state,updateTime:'job-v1'}:null,
  write:(collection,id,data,prior)=>({collection,id,data,prior}),call:async(path,{writes})=>{const update=writes.find(write=>write.collection==='0.6.2_s1_worker_jobs');if(update)state=update.data;const q=writes.find(write=>write.collection===VERIFICATION_COLLECTION);if(q)queue.data=q.data;return {};}};
 await publishResults(db,[job],[verified]);
 assert.ok(state.pendingFullRebuildTrackIds.includes(TRACK));
 await publishResults(db,[secondJob],[{...verified,resultId:secondJob.resultId}]);
 assert.ok(state.pendingFullRebuildTrackIds.includes(TRACK));
 assert.equal(state.pendingResultIds[TRACK],undefined);
});

test('successful same-invocation publications reuse CAS-versioned queue and reconciliation reads',async()=>{
 const secondRow={...row,accountId:'racer2',uploadId:8};
 const secondJob={...job,...secondRow,resultId:`racer2_${TRACK}`,queueKey:verificationKey(secondRow)};
 let queue={data:{trackId:TRACK,slots:Object.fromEntries([job,secondJob].map(item=>[item.accountId,
  {accountId:item.accountId,resultId:item.resultId,trackId:TRACK,key:item.queueKey,status:'waiting',attempts:0}]))},updateTime:'queue-v1'};
 let state={data:{pendingTrackIds:[],pendingResultIds:{}},updateTime:'state-v1'};
 let version=1;
 const reads={queue:0,state:0,canonical:0,audit:0};
 const db={
  get:async(collection,id)=>{
   if(collection===VERIFICATION_COLLECTION){reads.queue++;return queue;}
   if(collection==='0.6.2_race_results'){reads.canonical++;return {data:id===job.resultId?row:secondRow,updateTime:'canonical-'+id};}
   if(collection==='0.6.2_s1_worker_jobs'){reads.state++;return state;}
   if(collection==='0.6.2_s1_verification_audit'){reads.audit++;return null;}
   return null;
  },
  write:(collection,id,data,prior)=>({collection,id,data,prior}),
  call:async(_path,{writes})=>{
   const writeResults=[];
   for(const write of writes){
    const updateTime='commit-v'+version++;
    writeResults.push({updateTime});
    if(write.collection===VERIFICATION_COLLECTION)queue={data:write.data,updateTime};
    if(write.collection==='0.6.2_s1_worker_jobs')state={data:write.data,updateTime};
   }
   return {writeResults};
  }
 };
 const totals=await publishResults(db,[job,secondJob],[verified,{...verified,resultId:secondJob.resultId}]);
 assert.equal(totals.verified,2);
 assert.deepEqual(reads,{queue:1,state:1,canonical:2,audit:2});
 assert.deepEqual(state.data.pendingResultIds[TRACK],[job.resultId,secondJob.resultId]);
 assert.equal(queue.data.slots.racer.status,'verified');
 assert.equal(queue.data.slots.racer2.status,'verified');
});

test('publication CAS conflicts invalidate invocation caches and reread concurrent state',async()=>{
 const secondRow={...row,accountId:'racer2',uploadId:8};
 const secondJob={...job,...secondRow,resultId:`racer2_${TRACK}`,queueKey:verificationKey(secondRow)};
 let queue={data:{trackId:TRACK,slots:Object.fromEntries([job,secondJob].map(item=>[item.accountId,
  {accountId:item.accountId,resultId:item.resultId,trackId:TRACK,key:item.queueKey,status:'waiting',attempts:0}]))},updateTime:'queue-v1'};
 let state={data:{pendingTrackIds:[],pendingResultIds:{}},updateTime:'state-v1'};
 let attempt=0,version=1;
 const reads={queue:0,state:0,canonical:0,audit:0};
 let retriedWrites;
 const conflict=Object.assign(Error('conflict'),{code:'ABORTED'});
 const db={
  get:async(collection,id)=>{
   if(collection===VERIFICATION_COLLECTION){reads.queue++;return queue;}
   if(collection==='0.6.2_race_results'){reads.canonical++;return {data:id===job.resultId?row:secondRow,updateTime:'canonical-'+id};}
   if(collection==='0.6.2_s1_worker_jobs'){reads.state++;return state;}
   if(collection==='0.6.2_s1_verification_audit'){reads.audit++;return null;}
   return null;
  },
  write:(collection,id,data,prior)=>({collection,id,data,prior}),
  call:async(_path,{writes})=>{
   attempt++;
   if(attempt===2){
    queue={...queue,data:{...queue.data,concurrentQueueField:true},updateTime:'external-queue-v2'};
    state={...state,data:{...state.data,concurrentStateField:true},updateTime:'external-state-v2'};
    throw conflict;
   }
   if(attempt===3)retriedWrites=writes;
   const writeResults=[];
   for(const write of writes){
    const updateTime='commit-v'+version++;
    writeResults.push({updateTime});
    if(write.collection===VERIFICATION_COLLECTION)queue={data:write.data,updateTime};
    if(write.collection==='0.6.2_s1_worker_jobs')state={data:write.data,updateTime};
   }
   return {writeResults};
  }
 };
 const totals=await publishResults(db,[job,secondJob],[verified,{...verified,resultId:secondJob.resultId}]);
 assert.equal(totals.verified,2);
 assert.equal(totals.deferred,0);
 assert.equal(attempt,3);
 assert.deepEqual(reads,{queue:2,state:2,canonical:3,audit:3});
 assert.equal(retriedWrites[0].prior.updateTime,'external-queue-v2');
 assert.equal(retriedWrites[0].data.concurrentQueueField,true);
 assert.equal(retriedWrites[1].prior.updateTime,'external-state-v2');
 assert.equal(retriedWrites[1].data.concurrentStateField,true);
});

for(const optionalProof of [undefined,{informative:false},{version:1,verifierVersion:'undefined'}]){
 test('failed recheck preserves native verification without a usable clone signature '+JSON.stringify(optionalProof),async()=>{
  const accepted={...pendingSlot(row),status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,...(optionalProof?{controlProof:optionalProof}:{})};
  let reads=0,writes=0;const db={get:async collection=>{reads++;if(collection===VERIFICATION_COLLECTION)return {data:{slots:{racer:accepted}}};if(collection==='0.6.2_race_results')return {data:row};throw Error('Unneeded read');},write:()=>{writes++;throw Error('Unexpected write');}};
  const totals=await publishResults(db,[job],[{resultId:job.resultId,status:'unavailable',reason:'native_engine_error'}]);
  assert.equal(totals.deferred,1);assert.equal(totals.unavailable,0);assert.equal(reads,2);assert.equal(writes,0);
  assert.equal(verifiedControlReference(accepted,TRACK),null,'unusable clone signatures remain rejected');
 });
}


test('verification summaries use the current Kodub track name instead of a formatted hash',async()=>{
 const fs=await import('node:fs/promises');
 const feed=JSON.parse(await fs.readFile(new URL('../../events/kodub/current.json',import.meta.url),'utf8'));
 const {verifiedTrackCounts}=await import('./runner.mjs');
 const result=verifiedTrackCounts({[feed.current.trackId]:3});
 assert.equal(result[0].trackName,feed.current.name);assert.equal(result[0].count,3);
 const history=JSON.parse(await fs.readFile(new URL('../../events/kodub/history.json',import.meta.url),'utf8'));
 const archived=history.find(row=>row.name&&row.trackId!==feed.current.trackId);assert.equal(verifiedTrackCounts({[archived.trackId]:1})[0].trackName,archived.name);
});
// REST-shaped mock applies masks/transforms atomically and preserves raw timestamp precision.
function timingCorrectionPublicationFixture({legacy=true,status='verified'}={}){
 const canonical={...row,timeMs:legacy?Math.round(row.frames*1000/60):row.frames,timingVersion:legacy?1:2};
 const correctionJob={...canonical,resultId:job.resultId,queueKey:verificationKey(canonical),queueCollection:VERIFICATION_COLLECTION,
  timeMs:row.frames,correctionCandidate:legacy?{frames:row.frames,originalTimeMs:canonical.timeMs}:null};
 const verdict={...verified,trackId:TRACK,timeMs:correctionJob.timeMs,replayHash:canonical.replayHash,status};
 const canonicalName='0.6.2_race_results/'+job.resultId,queueName=VERIFICATION_COLLECTION+'/'+TRACK;
 const documents=new Map(),commits=[],reads=[],serverTime='2026-11-08T01:02:03.456Z';let version=0;
 const rawCanonical={...encode(canonical).mapValue.fields,
  ingestedAt:{timestampValue:'2026-11-01T01:00:00.123456789Z'},pbAt:{timestampValue:'2026-10-31T01:00:00.987654321Z'},
  updatedAt:{timestampValue:'2026-11-01T01:00:00.111222333Z'},custom:{mapValue:{fields:{keep:{stringValue:'unchanged'}}}}};
 documents.set(canonicalName,{fields:structuredClone(rawCanonical),updateTime:'canonical-v1'});
 documents.set(queueName,{fields:encode({trackId:TRACK,slots:{racer:pendingSlot(canonical,0)}}).mapValue.fields,updateTime:'queue-v1'});
 const db={
  get:async(collection,id)=>{const name=collection+'/'+id;reads.push(name);const doc=documents.get(name);return doc?{...structuredClone(doc),data:decode({mapValue:{fields:doc.fields}})}:null;},
  write:(collection,id,data,prior)=>({update:{name:collection+'/'+id,fields:encode(data).mapValue.fields},currentDocument:prior?.updateTime?{updateTime:prior.updateTime}:{exists:false}}),
  call:async(endpoint,{writes})=>{
   assert.equal(endpoint,':commit');commits.push(structuredClone(writes));
   for(const write of writes){const old=documents.get(write.update.name);if(write.currentDocument.updateTime!==undefined)assert.equal(write.currentDocument.updateTime,old?.updateTime);else assert.equal(old,undefined);}
   const writeResults=[];
   for(const write of writes){
    const old=documents.get(write.update.name),fields=write.updateMask?structuredClone(old.fields):{};
    for(const field of write.updateMask?.fieldPaths||Object.keys(write.update.fields))fields[field]=structuredClone(write.update.fields[field]);
    for(const transform of write.updateTransforms||[]){assert.deepEqual(transform,{fieldPath:'ingestedAt',setToServerValue:'REQUEST_TIME'});fields.ingestedAt={timestampValue:serverTime};}
    const updateTime='committed-v'+ ++version;documents.set(write.update.name,{fields,updateTime});writeResults.push({updateTime});
   }
   return {writeResults};
  }
 };
 return {db,correctionJob,verdict,documents,commits,reads,rawCanonical,canonicalName,queueName,serverTime};
}

test('timing correction advances ingestion in the same four-write CAS commit and preserves PB chronology',async()=>{
 const f=timingCorrectionPublicationFixture();
 const totals=await publishResults(f.db,[f.correctionJob],[f.verdict]);
 assert.equal(totals.corrected,1);assert.equal(totals.verified,1);
 assert.equal(f.commits.length,1);assert.equal(f.commits[0].length,4,'transform adds no document write');
 assert.equal(f.reads.length,4,'queue, canonical, reconcile state and audit only');
 const writes=f.commits[0],canonicalWrites=writes.filter(w=>w.update.name===f.canonicalName);
 assert.equal(canonicalWrites.length,1);const write=canonicalWrites[0];
 assert.deepEqual(write.currentDocument,{updateTime:'canonical-v1'});
 assert.deepEqual(write.updateMask,{fieldPaths:['timeMs','timingVersion']});
 assert.deepEqual(write.update.fields,encode({timeMs:row.frames,timingVersion:2}).mapValue.fields);
 assert.deepEqual(write.updateTransforms,[{fieldPath:'ingestedAt',setToServerValue:'REQUEST_TIME'}]);
 assert.ok(writes.filter(w=>w!==write).every(w=>!Object.hasOwn(w,'updateTransforms')),'no transform on queue/state/audit');
 const stored=f.documents.get(f.canonicalName).fields;
 assert.deepEqual(stored,{...f.rawCanonical,...encode({timeMs:row.frames,timingVersion:2}).mapValue.fields,ingestedAt:{timestampValue:f.serverTime}});
 const corrected=decode({mapValue:{fields:stored}}),key=verificationKey(corrected);
 const slot=decode({mapValue:{fields:f.documents.get(f.queueName).fields}}).slots.racer;
 assert.equal(slot.key,key);assert.notEqual(key,f.correctionJob.queueKey);
 assert.equal(verificationKey({...corrected,ingestedAt:new Date(0)}),key,'ingestion timestamp cannot alter native proof binding');
 const audit=writes.find(w=>w.update.name.startsWith('0.6.2_s1_verification_audit/'));
 assert.equal(decode({mapValue:{fields:audit.update.fields}}).key,key);
});

test('repeating an already applied correction is a no-op and cannot bump ingestion again',async()=>{
 const f=timingCorrectionPublicationFixture();
 await publishResults(f.db,[f.correctionJob],[f.verdict]);
 const stored=structuredClone(f.documents.get(f.canonicalName));
 const totals=await publishResults(f.db,[f.correctionJob],[f.verdict]);
 assert.equal(totals.corrected,0);assert.equal(totals.superseded,1);
 assert.equal(f.commits.length,1);assert.deepEqual(f.documents.get(f.canonicalName),stored);
});

for(const options of [{legacy:false},{status:'unavailable'},{status:'mismatch'}]){
 test('only a verified legacy correction gets an ingestion transform '+JSON.stringify(options),async()=>{
  const f=timingCorrectionPublicationFixture(options),before=structuredClone(f.documents.get(f.canonicalName));
  const totals=await publishResults(f.db,[f.correctionJob],[f.verdict]);
  assert.equal(totals.corrected,0);assert.equal(f.commits.length,1);assert.equal(f.commits[0].length,3);
  assert.ok(f.commits[0].every(w=>w.update.name!==f.canonicalName&&!Object.hasOwn(w,'updateTransforms')));
  assert.deepEqual(f.documents.get(f.canonicalName),before);
 });
}

test('a competing canonical PB cancels correction and timestamp atomically after CAS conflict',async()=>{
 const f=timingCorrectionPublicationFixture();let attempted=0;
 const newer={...f.rawCanonical,...encode({timeMs:row.frames-1,frames:row.frames-1,raceTimeFrames:row.frames-1,uploadId:8}).mapValue.fields};
 f.db.call=async(endpoint,{writes})=>{
  assert.equal(endpoint,':commit');attempted++;
  assert.equal(writes.length,4);assert.deepEqual(writes[3].currentDocument,{updateTime:'canonical-v1'});
  assert.deepEqual(writes[3].updateTransforms,[{fieldPath:'ingestedAt',setToServerValue:'REQUEST_TIME'}]);
  f.documents.set(f.canonicalName,{fields:structuredClone(newer),updateTime:'concurrent-v2'});
  throw Error('Firestore request failed: 409');
 };
 const totals=await publishResults(f.db,[f.correctionJob],[f.verdict]);
 assert.equal(attempted,1);assert.equal(totals.corrected,0);assert.equal(totals.superseded,1);
 assert.deepEqual(f.documents.get(f.canonicalName),{fields:newer,updateTime:'concurrent-v2'});
 assert.equal(f.documents.get(f.queueName).updateTime,'queue-v1');
});
