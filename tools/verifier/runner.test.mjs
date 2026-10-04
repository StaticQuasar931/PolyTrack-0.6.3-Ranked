import assert from 'node:assert/strict';
import test from 'node:test';
import {publishResults} from './runner.mjs';
import {VERIFICATION_COLLECTION, VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION, verificationKey} from '../../workers/ranked/src/verification.js';

const TRACK='5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const row={accountId:'racer',trackId:TRACK,timeMs:20000,raceTimeFrames:20000,frames:20000,uploadId:7,replayHash:'a'.repeat(64),replay:'fixture'};
const job={...row,resultId:`racer_${TRACK}`,queueKey:verificationKey(row),queueCollection:VERIFICATION_COLLECTION};
const verified={resultId:job.resultId,status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,reason:''};

test('publication adds the exact result ID to bounded reconciliation work in the same CAS transaction',async()=>{
 let committed;
 const queue={data:{trackId:TRACK,slots:{racer:{accountId:'racer',resultId:job.resultId,trackId:TRACK,key:job.queueKey,status:'waiting',attempts:0}}},updateTime:'queue-v1'};
 const db={
  get:async(collection,id)=>collection===VERIFICATION_COLLECTION?queue:collection==='0.6.2_race_results'?{data:row,updateTime:'result-v1'}:collection==='0.6.2_s1_worker_jobs'?{data:{pendingTrackIds:[],pendingResultIds:{}},updateTime:'job-v1'}:null,
  write:(collection,id,data,prior)=>({collection,id,data,prior}),
  call:async(path,{writes})=>{committed=writes;return {};}
 };
 await publishResults(db,[job],[verified]);
 const wake=committed.find(write=>write.collection==='0.6.2_s1_worker_jobs');
 assert.deepEqual(wake.data.pendingTrackIds,[TRACK]);
 assert.deepEqual(wake.data.pendingResultIds,{[TRACK]:[job.resultId]});
 assert.equal(wake.prior.updateTime,'job-v1');
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
