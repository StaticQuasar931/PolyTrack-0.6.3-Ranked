import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import worker, {computeTrackEntries} from '../src/index.js';
import {eventEncode, eventDecode} from '../src/events-store.js';
import {pendingSlot, VERIFICATION_COLLECTION, VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION, verificationSchedule} from '../src/verification.js';
import {verificationShardId} from '../src/verification-shards.js';
import {loadPublicationEntries} from '../src/paged-publication.js';
import {TRACK_BUILD_JOBS, trackBuildId, TRACK_BUILD_MAX_AGE_MS} from '../src/track-build.js';

const base='projects/polytrack-052/databases/(default)/documents/';
const jobs='0.6.2_s1_worker_jobs',boards='0.6.2_s1_leaderboards_track',results='0.6.2_race_results';
const tracks=['a','b','c','d'].map(letter=>letter.repeat(64));
const jobKey=jobs+'/profile_quota';
const replay='maintenance-quota-proof',replayHash=createHash('sha256').update(replay).digest('hex');
const identity={accountId:'racer',name:'Updated racer',countryCode:'CA',carId:'new-car',carColors:'new-colors',carStyle:'new-style',profileCosmetics:{version:7,theme:'classic'},identityUpdatedAt:3000,groupCode:'123456',groupCodeUpdatedAt:3000};
const race=(trackId,index=0)=>({accountId:index?`z${String(index).padStart(4,'0')}`:'racer',name:'Old racer',trackId,timeMs:10000+index,frames:10000+index,raceTimeFrames:10000+index,uploadId:1,replay,replayHash,pbAt:1000});
const proof=row=>({...pendingSlot(row),status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION});

function fixture(t,pending=tracks.slice(0,3)) {
 t.mock.method(console,'log',()=>{});t.mock.method(console,'error',()=>{});
 t.mock.method(globalThis,'fetch',async()=>{throw Error('LIVE_NETWORK_FORBIDDEN');});
 const data=new Map(),versions=new Map(),calls=[],queries=[],commits=[],snapshots=new Map();
 const wire=(key,value=data.get(key))=>({name:base+key,fields:eventEncode(value).mapValue.fields,updateTime:'v'+(versions.get(key)||0)});
 data.set(jobKey,{kind:'profile',active:true,accountId:identity.accountId,identity,signature:'job-signature',pendingTrackIds:pending,processed:0,changed:0,createdAt:1});
 const f={data,calls,queries,commits,failure:null,queryJobs:[jobKey],
  addRows(trackId,count){
   const rows=Array.from({length:count},(_,i)=>race(trackId,i));
   for(const row of rows)data.set(results+'/'+row.accountId+'_'+trackId,row);
   const slots=Object.fromEntries(rows.slice(0,500).map(row=>[row.accountId,proof(row)]));
   for(const row of rows.slice(500)){const queueId=verificationShardId(trackId,row.accountId),slots={[row.accountId]:proof(row)};data.set(VERIFICATION_COLLECTION+'/'+queueId,{trackId,queueId,storageVersion:2,slots,...verificationSchedule(slots)});}
   data.set(VERIFICATION_COLLECTION+'/'+trackId,{trackId,slots,...verificationSchedule(slots)});
   return rows;
  },
  ready(trackId,rows=[race(trackId)]){
   const verdicts=Object.fromEntries(rows.map(row=>[row.accountId,proof(row)]));
   const entries=computeTrackEntries(rows.map(row=>({...row,integrityVerified:true})),trackId,{},verdicts);
   data.set(boards+'/'+trackId,{trackId,entries,complete:true,sourceComplete:true,totalEntries:entries.length,revision:1,schemaVersion:6,algorithmVersion:'participation-v8-s1',signature:'seed'});
   return structuredClone(entries);
  },
  fail(stage,error='FIRESTORE_503'){f.failure={stage,error};},
  job:()=>data.get(jobKey),
  starts:()=>calls.filter(call=>call.path.startsWith('/'+TRACK_BUILD_JOBS+'/capacity_track_')),
  async turn(){
   const offset=calls.length;let completion;
   worker.scheduled({cron:'2-59/5 * * * *',scheduledTime:420000},f.env,{waitUntil:task=>{completion=task;}});
   await completion;
   const turn=calls.slice(offset);
   assert.ok(turn.filter(call=>call.path.startsWith('/'+TRACK_BUILD_JOBS+'/capacity_track_')).length<=1,'at most one fallback attempt, even when it fails');
   assert.ok(turn.length<=50,'maintenance fixture stays within 50 Firestore requests');
   assert.equal(turn.some(call=>call.path.includes('leaderboards_overall')),false,'maintenance never starts Overall aggregation');
   return turn;
  }
 };
 const fail=stage=>{if(f.failure?.stage===stage){const {error}=f.failure;f.failure=null;throw Error(error);}};
 f.env={__TEST_FIRESTORE:async(path,init={})=>{
  calls.push({path,init});
  if(path===':runQuery'){
   const body=JSON.parse(init.body),query=body.structuredQuery;queries.push(body);
   if(query.from[0].collectionId===jobs)return f.queryJobs.flatMap(key=>data.get(key)?.active?[{document:wire(key)}]:[]);
   assert.equal(query.from[0].collectionId,results);fail('canonical-query');
   const readTime=body.readTime||new Date().toISOString();
   if(!body.readTime)snapshots.set(readTime,structuredClone(data));
   const source=snapshots.get(readTime),trackId=query.where.fieldFilter.value.stringValue,after=query.startAt?.values?.[0]?.referenceValue||'';
   return [...source].filter(([key,row])=>key.startsWith(results+'/')&&row.trackId===trackId&&base+key>after)
    .sort(([a],[b])=>a.localeCompare(b)).slice(0,query.limit).map(([key,row])=>({document:wire(key,row),readTime}));
  }
  if(path===':batchGet'){
   const body=JSON.parse(init.body),source=body.readTime?snapshots.get(body.readTime):data;
   return body.documents.map(name=>{const key=name.slice(base.length);return source.has(key)?{found:wire(key,source.get(key))}:{missing:name};});
  }
  if(path===':commit'){
   const writes=JSON.parse(init.body).writes;
   if(writes.some(write=>write.update?.name.startsWith(base+boards+'/')))fail('publication');
   if(writes.some(write=>write.update?.name===base+jobKey))fail('checkpoint');
   for(const write of writes){
    const key=write.update.name.slice(base.length);
    if(write.currentDocument)assert.deepEqual(write.currentDocument,data.has(key)?{updateTime:'v'+(versions.get(key)||0)}:{exists:false},'keep compare-and-set preconditions');
   }
   commits.push(writes);
   for(const write of writes){const key=write.update.name.slice(base.length);data.set(key,eventDecode({mapValue:{fields:write.update.fields}}));versions.set(key,(versions.get(key)||0)+1);}
   return {writeResults:writes.map(write=>({updateTime:'v'+versions.get(write.update.name.slice(base.length))}))};
  }
  assert.equal(init.method,undefined,'no unexpected Firestore transport');
  const url=new URL('https://fixture.invalid'+path),key=decodeURIComponent(url.pathname.slice(1));
  if(key.startsWith(TRACK_BUILD_JOBS+'/capacity_track_'))fail('build-read');
  const source=url.searchParams.has('readTime')?snapshots.get(url.searchParams.get('readTime')):data;
  return source?.has(key)?wire(key,source.get(key)):null;
 }};
 return f;
}

test('three missing tracks share one fallback per invocation and eventually complete',async t=>{
 const f=fixture(t);
 await f.turn();assert.equal(f.starts().length,1);assert.deepEqual(f.job().pendingTrackIds,tracks.slice(0,3));assert.equal(f.job().active,true);assert.equal(f.job().processed,0);
 for(let i=0;i<6&&f.job().active;i++)await f.turn();
 assert.equal(f.starts().length,3);assert.equal(f.job().active,false);assert.deepEqual(f.job().pendingTrackIds,[]);assert.equal(f.job().processed,3);
});

test('a pending multi-page build stays queued through publication, then applies identity without rebuilding',async t=>{
 const trackId=tracks[0],f=fixture(t,[trackId]),rows=f.addRows(trackId,101);
 await f.turn();assert.equal(f.job().active,true);assert.equal(f.job().processed,0);assert.equal(f.data.has(boards+'/'+trackId),false);
 await f.turn();assert.equal(f.job().active,true);assert.deepEqual(f.job().pendingTrackIds,[trackId]);assert.equal(f.job().processed,0);
 const published=structuredClone(f.data.get(boards+'/'+trackId)),old=published.entries.find(row=>row.accountId==='racer');
 assert.equal(old.name,'Old racer','paged rebuild itself does not apply identityOverride');
 const before=f.starts().length,queryCount=f.queries.filter(query=>query.structuredQuery.from[0].collectionId===results).length;
 await f.turn();
 assert.equal(f.starts().length,before);assert.equal(f.queries.filter(query=>query.structuredQuery.from[0].collectionId===results).length,queryCount);
 assert.equal(f.job().active,false);assert.equal(f.job().processed,1);assert.equal(f.job().changed,1);
 const updated=f.data.get(boards+'/'+trackId).entries.find(row=>row.accountId==='racer');
 for(const key of ['name','countryCode','carId','carColors','carStyle','identityUpdatedAt','groupCode','groupCodeUpdatedAt'])assert.equal(updated[key],identity[key]);
 for(const key of ['timeMs','replayHash','uploadId','rank','position','fieldSize','integrityVerified','runVerified','verified'])assert.deepEqual(updated[key],old[key],key+' must not change');
 assert.equal(updated.runVerified,true);assert.equal(f.data.get(boards+'/'+trackId).entries.length,rows.length);
 assert.equal(f.data.get(TRACK_BUILD_JOBS+'/'+trackBuildId(trackId)).complete,true);
});

for(const blocked of [false,true])test('unfinished/blocked builds retain their track; later ready tracks are not starved: '+blocked,async t=>{
 const f=fixture(t,tracks);
 for(const trackId of tracks.slice(0,3))f.data.set(TRACK_BUILD_JOBS+'/'+trackBuildId(trackId),{trackId,complete:false,baseVersion:'',readTime:new Date(Date.now()-TRACK_BUILD_MAX_AGE_MS-1000).toISOString(),blocked,blockedReason:'snapshot_expired'});
 f.ready(tracks[3]);
 await f.turn();assert.deepEqual(f.job().pendingTrackIds,[tracks[3],...tracks.slice(0,3)]);assert.equal(f.job().processed,0);
 const build=f.data.get(TRACK_BUILD_JOBS+'/'+trackBuildId(tracks[0]));assert.equal(build.blocked,true);
 await f.turn();assert.equal(f.job().processed,1);assert.equal(f.job().active,true);assert.equal(f.job().pendingTrackIds.length,3);assert(!f.job().pendingTrackIds.includes(tracks[3]));
 assert.equal(f.queries.filter(query=>query.structuredQuery.from[0].collectionId===results).length,0,'expired/blocked builds cannot start new canonical scans');
 assert.equal(f.data.get(boards+'/'+tracks[3]).entries[0].name,identity.name);
 for(const trackId of tracks.slice(0,3))f.ready(trackId);
 const attempts=f.starts().length;
 await f.turn();assert.equal(f.job().active,false);assert.equal(f.job().processed,4);assert.equal(f.starts().length,attempts,'repaired publications receive identity without another rebuild');
});

for(const stage of ['build-read','canonical-query','publication'])test('failed fallback consumes the allowance and unfinished tracks are retained: '+stage,async t=>{
 const f=fixture(t);f.fail(stage);
 await f.turn();assert.equal(f.starts().length,1);assert.deepEqual(f.job().pendingTrackIds,tracks.slice(0,3));assert.equal(f.job().active,true);assert.equal(f.job().processed,0);
});

test('failed fallback does not discard a successfully updated ready sibling',async t=>{
 const f=fixture(t);f.ready(tracks[1]);f.fail('build-read');
 await f.turn();assert.equal(f.starts().length,1);assert.equal(f.job().processed,1);assert.equal(f.job().changed,1);assert.deepEqual(f.job().pendingTrackIds,[tracks[0],tracks[2]]);
 assert.equal(f.data.get(boards+'/'+tracks[1]).entries[0].name,identity.name);
});

test('all three ready tracks remain cheap and complete in one pass',async t=>{
 const f=fixture(t);for(const trackId of tracks.slice(0,3))f.ready(trackId);
 await f.turn();assert.equal(f.starts().length,0);assert.equal(f.job().active,false);assert.equal(f.job().processed,3);assert.equal(f.job().changed,3);
 assert.equal(f.queries.length,1,'only the active profile job query');
});

test('an absent racer on a complete board completes as a no-op without rebuilding',async t=>{
 const f=fixture(t,[tracks[0]]);f.ready(tracks[0],[race(tracks[0],1)]);
 await f.turn();assert.equal(f.starts().length,0);assert.equal(f.job().active,false);assert.equal(f.job().processed,1);assert.equal(f.job().changed,0);
 assert.equal(f.commits.flat().filter(write=>write.update.name.startsWith(base+boards+'/')).length,0);
});

test('429 stops maintenance immediately without checkpointing or losing pending tracks',async t=>{
 const f=fixture(t);f.ready(tracks[1]);const prior=structuredClone(f.job());f.fail('build-read','FIRESTORE_429');
 const calls=await f.turn();assert.equal(calls.at(-1).path,'/'+TRACK_BUILD_JOBS+'/'+trackBuildId(tracks[0]));assert.deepEqual(f.job(),prior);
 assert.equal(f.data.get(boards+'/'+tracks[1]).entries[0].name,'Old racer');
});

test('job checkpoint conflict retains work and a later invocation finishes without duplicate identity writes',async t=>{
 const f=fixture(t,[tracks[0]]);f.ready(tracks[0]);const prior=structuredClone(f.job());f.fail('checkpoint','FIRESTORE_412');
 await f.turn();assert.deepEqual(f.job(),prior);assert.equal(f.data.get(boards+'/'+tracks[0]).entries[0].name,identity.name);
 const count=()=>f.commits.flat().filter(write=>write.update.name.startsWith(base+boards+'/')).length,before=count();
 await f.turn();assert.equal(f.job().active,false);assert.equal(f.job().processed,1);assert.equal(count(),before);
});


test('identity reaches all immutable pages after a 531-racer build without another fallback',async t=>{
 const trackId=tracks[0],f=fixture(t,[trackId]);f.addRows(trackId,531);
 const read=async(collection,id)=>f.data.has(collection+'/'+id)?{data:f.data.get(collection+'/'+id)}:null;
 let published;
 for(let turn=0;turn<10;turn++){
  await f.turn();published=f.data.get(boards+'/'+trackId);
  if(published?.sourceComplete)break;
 }
 assert.equal(published?.totalEntries,531);assert.equal(published.complete,false);assert.equal(published.pagination.pageCount,6);
 assert.equal(f.job().active,true);assert.deepEqual(f.job().pendingTrackIds,[trackId]);
 const before=await loadPublicationEntries(published,'track',trackId,read),attempts=f.starts().length;
 await f.turn();assert.equal(f.starts().length,attempts);assert.equal(f.job().active,false);assert.equal(f.job().processed,1);
 const after=await loadPublicationEntries(f.data.get(boards+'/'+trackId),'track',trackId,read);
 assert.equal(after.length,531);assert.equal(after.find(row=>row.accountId==='racer').name,identity.name);
 for(let i=0;i<after.length;i++)for(const key of ['accountId','timeMs','rank','position','fieldSize','uploadId','replayHash','runVerified','integrityVerified'])assert.deepEqual(after[i][key],before[i][key],key+' is unchanged by identity propagation');
});


test('cron invocation processes only one profile job even when the query returns multiple jobs',async t=>{
 const f=fixture(t),otherKey=jobs+'/profile_second',otherJob={...structuredClone(f.job()),accountId:'other-racer',pendingTrackIds:[tracks[3]]};
 f.data.set(otherKey,otherJob);f.queryJobs.push(otherKey);
 await f.turn();
 assert.equal(f.queries[0].structuredQuery.limit,1,'cron queries only the one job it can process');
 assert.equal(f.starts().length,1,'there is only one fallback allowance in this maintenance invocation');
 assert.deepEqual(f.data.get(otherKey),otherJob,'the extra returned job is not processed with a fresh budget');
 assert.equal(f.commits.flat().some(write=>write.update.name===base+otherKey),false);
 assert.equal(f.calls.some(call=>call.path.includes(tracks[3])),false,'no work starts for the second job');
});
