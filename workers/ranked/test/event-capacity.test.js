import {recordFirestoreReads} from '../src/firestore-read-cost.js';
import {publicationRetry,publicationRetries,EVENT_PUBLICATION_RETRY_MAX_MS} from '../src/event-publication-retry.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createEventService,EVENT_COLLECTIONS as C,eventPeriod} from '../src/events.js';
import {eventEncode,eventDecode} from '../src/events-store.js';
import {VERIFIER_ENGINE_DIGEST,VERIFIER_VERSION,pendingSlot,VERIFICATION_COLLECTION} from '../src/verification.js';
import {mergeCanonicalResultIntoTrack,maintenanceWindowAllows} from '../src/index.js';
import {PERMANENT_ROLLING_HILLS as R} from '../src/permanent-rolling-hills.js';
import {advanceEventPublication,publishEventCapacity} from '../src/event-publication.js';
import {EVENT_RETENTION_COLLECTION} from '../src/event-capacity.js';
import fs from 'node:fs';
import {loadPublicationEntries,decodePublicationPage,preparePublicationPages,PUBLIC_PAGE_COLLECTION} from '../src/paged-publication.js';

const track='a'.repeat(64),hash=v=>createHash('sha256').update(v).digest('hex');
const capacity={policyVersion:'event-capacity-test-v2',entrants:531,admissionsPerPeriod:2048,replayBytesPerPeriod:16777216,minIntervalMs:1000,verificationsPerDay:1536,storageVersion:2};
const period={id:'capacity_day',trackId:track,enabled:true,startsAt:1000,endsAt:86401000,graceMs:1000,targetMs:10000,maxRp:100,kind:'daily',eligibility:'best-submitted-during-period',capacity};
function fixture(){
 const data=new Map(),counts=[],calls=[];let time=0,nonce=0,snapshot=null;
 const store={transaction:async fn=>{
   const copy=structuredClone(data),reads=new Set();let writing=false,writes=0;
   const get=async key=>{assert.equal(writing,false);reads.add(key);assert.ok(reads.size<=16);return structuredClone(copy.get(key)||null);};
   const write=(key,value,mode)=>{writing=true;assert.ok(++writes<=16);if(mode!=='create')assert.ok(reads.has(key));if(mode==='create')assert.equal(copy.has(key),false);if(mode==='delete')copy.delete(key);else copy.set(key,structuredClone(mode==='patch'?{...copy.get(key),...value}:value));};
   const result=await fn({get,set:(k,v)=>write(k,v,'set'),create:(k,v)=>write(k,v,'create'),patch:(k,v)=>write(k,v,'patch'),delete:k=>write(k,null,'delete')});
   data.clear();for(const [k,v]of copy)data.set(k,v);counts.push({reads:reads.size,writes});return result;
 }};
 const base='projects/polytrack-052/databases/(default)/documents/';
 const wire=(key,source=data)=>({name:base+key,fields:eventEncode(source.get(key)).mapValue.fields,updateTime:'v1'});
 const request=async(route,init={})=>{
   calls.push(route);const body=init.body?JSON.parse(init.body):null;
   if(route===':runQuery'){
     if(!body.readTime)snapshot=structuredClone(data);
     const source=body.readTime?snapshot:data,q=body.structuredQuery,collection=q.from[0].collectionId;
     const after=q.startAt?.values?.[0]?.referenceValue||'',filter=q.where?.fieldFilter;
     const rows=[...source].filter(([key,value])=>key.startsWith(collection+'/')&&base+key>after&&(!filter||value[filter.field.fieldPath]===filter.value.stringValue)).sort(([a],[b])=>a.localeCompare(b)).slice(0,q.limit);
     return rows.length?rows.map(([key])=>({document:wire(key,source),readTime:new Date(time).toISOString()})):[{readTime:new Date(time).toISOString()}];
   }
   if(route===':batchGet'){const source=body.readTime?snapshot:data;return body.documents.map(name=>source.has(name.slice(base.length))?{found:wire(name.slice(base.length),source)}:{missing:name});}
   if(route===':commit'){for(const w of body.writes)data.set(w.update.name.slice(base.length),eventDecode({mapValue:{fields:w.update.fields}}));return {};}
   const key=route.slice(1);return data.has(key)?wire(key):null;
 };
 const service=createEventService({store,now:()=>time,hash,randomId:()=>`lease_${nonce++}`});
 const runtime={store,service,request,now:()=>time,projectId:'polytrack-052'};
 return {data,counts,calls,service,runtime,time:t=>time=t,wire};
}
const verdict=job=>({resultId:job.resultId,trackId:job.trackId,timeMs:job.timeMs,replayHash:job.replayHash,status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,
 binding:{resultId:job.resultId,trackId:job.trackId,nativeTrackId:job.trackId,timeMs:job.timeMs,replayHash:job.replayHash,actualReplayHash:job.replayHash,engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION}});

test('production capacity upgrade preserves old run bindings with one four-document migration',async()=>{
 const target=JSON.parse(JSON.parse(fs.readFileSync(new URL('../wrangler.jsonc',import.meta.url),'utf8')).vars.EVENT_CAPACITY_JSON);
 const f=fixture();await f.service.createPeriod({...period,capacity:{...target,storageVersion:undefined,entrants:200}});f.time(2000);
 const accountId=hash('pre-upgrade-racer');f.data.set(C.profiles+'/'+accountId,{accountId,ownerUid:'owner',name:'Racer'});
 const submitted=await f.service.submit(period.id,'owner',{accountId,trackId:track,attemptId:'attempt',timeMs:10000,frames:10000,replay:'abcd',carStyle:'style'});
 const before=structuredClone(f.data.get(C.runs+'/'+submitted.runId));
 const result=await f.service.upgradeCapacity(period.id,target);
 assert.equal(result.entrants,2000);
 assert.equal(f.counts.at(-1).reads,4);assert.equal(f.counts.at(-1).writes,4);
 assert.deepEqual(f.data.get(C.runs+'/'+submitted.runId),before);
 assert.equal(f.data.get(C.periods+'/'+period.id).proofCapacity.entrants,200);
 assert.equal(f.data.get(C.public+'/catalog').periods[0].entrantLimit,2000);
});

test('storage-v2 admits racer 201, preserves pre-upgrade bindings, and pages real verified PBs and totals',async()=>{
 const f=fixture();await f.service.createPeriod({...period,capacity:{...capacity,storageVersion:undefined,entrants:200}});f.time(2000);
 let oldest;
 for(let i=0;i<201;i++){
   const accountId=hash('event-racer-'+i),ownerUid='owner-'+i;f.data.set(C.profiles+'/'+accountId,{accountId,ownerUid,name:'Racer '+i});
   if(i===1)await f.service.upgradeCapacity(period.id,capacity);
   const submitted=await f.service.submit(period.id,ownerUid,{accountId,trackId:track,attemptId:'attempt',timeMs:10000+i,frames:10000+i,replay:'abcd',carStyle:'style'});
   if(!i)oldest={...f.data.get(C.runs+'/'+submitted.runId)};
 }
 const queue=f.data.get(C.queues+'/'+period.id);
 assert.equal(queue.entrants,201);assert.equal(queue.runIds.length,1);assert.equal(queue.subjects.length,1);assert.equal(queue.retentionPages,2);
 for(const [key,value]of f.data)if(key.startsWith(EVENT_RETENTION_COLLECTION+'/'))assert.ok(value.runIds.length<=100);
 assert.equal(f.data.get(C.runs+'/'+oldest.runId).eventKey,oldest.eventKey);
 for(let batch=0;batch<51;batch++)await f.service.processBatch(period.id,async jobs=>jobs.map(verdict));
 assert.equal(f.data.get(C.pbs+'/'+period.id+'_'+oldest.accountId).timeMs,10000);
 assert.equal(f.data.get(C.queues+'/'+period.id).slots.length,0);
 assert.deepEqual(f.data.get(C.public+'/totals').pendingPeriodIds,[period.id]);
 const built=await advanceEventPublication(f.runtime,period.id);assert.equal(built.totalEntries,201);
 assert.deepEqual(f.data.get(C.public+'/totals').pendingPeriodIds,[]);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
 const board=await f.service.snapshot(period.id);assert.equal(board.entries.length,200);assert.equal(board.totalEntries,201);assert.equal(board.sourceComplete,true);
 const last=await f.service.publicPage('event',period.id,board.pagination.generation,2);assert.equal(last.entries.length,1);assert.equal(last.entries[0].name,'Racer 200');
 const replay=await f.service.replay(period.id,hash('event-racer-200'));assert.equal(replay.verified,true);
 const totals=await advanceEventPublication(f.runtime);assert.equal(totals.totalEntries,201);
 const publicTotals=await f.service.totals();assert.equal(publicTotals.entries.length,200);assert.equal(publicTotals.totalEntries,201);
 assert.ok(f.counts.every(c=>c.reads<=16&&c.writes<=16));
 f.time(period.endsAt+period.graceMs);await f.service.archivePeriod(period.id);const archived=await f.service.snapshot(period.id);assert.equal(archived.pagination.totalEntries,201);
});

test('531 event PBs and 1001 finite totals publish all rows with cross-page tied ranks',async()=>{
 const f=fixture();await f.service.createPeriod(period);f.time(2000);
 for(let i=0;i<1001;i++){
   const accountId=hash('fixture-'+i),timeMs=10000+Math.floor(i/2);
   f.data.set(C.totals+'/'+accountId,{accountId,name:'Full Racer '+i,rp:1000-Math.floor(i/2),events:1});
   if(i<531)f.data.set(C.pbs+'/'+period.id+'_'+accountId,{periodId:period.id,accountId,name:'Full Racer '+i,timeMs,submittedAt:2000,carStyle:'style'});
 }
 f.data.set(C.live+'/'+period.id,{period:eventPeriod(period),entries:[],racerCount:531,publicationPending:true,revision:531});
 f.data.set(C.public+'/totals',{entries:[],publicationPending:true,revision:1001});
 for(const target of [period.id,null]){let result;for(let pass=0;pass<8;pass++){const start=f.calls.length;result=await advanceEventPublication(f.runtime,target);assert.ok(f.calls.length-start<50);if(!result.pending)break;}assert.equal(result.published,true);}
 const board=await f.service.snapshot(period.id),entries=await loadPublicationEntries(board,'event',period.id,async(c,id)=>({data:f.data.get(c+'/'+id)}));
 assert.equal(entries.length,531);assert.equal(entries[99].rank,99);assert.equal(entries[100].rank,101);
 const totals=await f.service.totals(),all=await loadPublicationEntries(totals,'event_totals','main',async(c,id)=>({data:f.data.get(c+'/'+id)}));
 assert.equal(all.length,1001);assert.equal(all[999].rank,999);assert.equal(all[1000].rank,1001);
});

test('large per-page planner data is compressed at rest and fully retained on the wire',async()=>{
 const rows=Array.from({length:100},(_,i)=>({userId:'racer-'+i,resultSamples:Array.from({length:200},(_,j)=>({trackId:'track-'+j,rank:i+1,fieldSize:1001,weight:3.234,competition:1,timeMs:20000+i+j,pbAt:1000}))}));
 const paged=await preparePublicationPages('overall','main',rows,{sourceRevision:7});
 assert.equal(paged.documents.length,1);assert.ok(paged.documents[0].data.pageBundle);assert.ok(JSON.stringify(paged.documents[0].data).length<800000);
 const decoded=await decodePublicationPage(paged.documents[0].data);assert.deepEqual(decoded.entries,rows);
});


async function combinedFixture(){
 const f=fixture(),a=hash('rolling-a'),b=hash('rolling-b'),c=hash('finite-c');
 const canonical=(accountId,timeMs,uploadId=1)=>({accountId,userId:accountId,trackId:R.trackId,timeMs,frames:timeMs,raceTimeFrames:timeMs,
   replay:'abcd',replayHash:hash('abcd'),uploadId,createdAt:1000,updatedAt:1000,pbAt:1000,name:accountId===a?'Rolling A':'Rolling B'});
 const rows=[canonical(a,10000),canonical(b,20000)];
 for(const row of rows)f.data.set('0.6.2_race_results/'+row.accountId+'_'+R.trackId,row);
 f.data.set(VERIFICATION_COLLECTION+'/'+R.trackId,{trackId:R.trackId,slots:Object.fromEntries(rows.map(row=>[row.accountId,
   {...pendingSlot(row,1000),status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION}]))});
 f.data.set(R.collection+'/'+R.trackId,{trackId:R.trackId,algorithmVersion:R.algorithmVersion,schemaVersion:R.minimumSchemaVersion,
   revision:1,sourceRevision:1,signature:'valid_rolling_snapshot_1',builtAt:2000,updatedAt:2000,complete:true,totalEntries:2,
   entries:rows.map((row,i)=>({...row,runVerified:true,integrityVerified:true,rank:i+1,position:i+1,fieldSize:2}))});
 const finite=[{accountId:b,name:'Rolling B',rp:400,events:1},{accountId:c,name:'Finite C',rp:950,events:1}];
 for(const row of finite)f.data.set(C.totals+'/'+row.accountId,row);
 f.data.set(C.public+'/totals',{entries:finite,totalEntries:2,complete:true,revision:7,publicationPending:true});
 f.time(2000);assert.equal((await advanceEventPublication(f.runtime)).published,true);
 const commits=[];
 const env={__TEST_FIRESTORE:async(route,init)=>{if(route===':commit')commits.push(JSON.parse(init.body));return f.runtime.request(route,init);}};
 const improve=async(timeMs=9000,uploadId=2)=>{
   const row=canonical(b,timeMs,uploadId);f.time(2000+uploadId*1000);
   f.data.set('0.6.2_race_results/'+b+'_'+R.trackId,row);
   const queue=f.data.get(VERIFICATION_COLLECTION+'/'+R.trackId);
   queue.slots[b]={...pendingSlot(row,3000),status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION};
   const result=await mergeCanonicalResultIntoTrack(env,R.trackId,row,true);
   return {result,row};
 };
 return {...f,a,b,c,improve,env,commits};
}

test('Rolling Hills-only PB invalidates combined RP atomically, preserves last good generation, and rebuilds ranks',async()=>{
 const f=await combinedFixture(),prior=structuredClone(f.data.get(C.public+'/totals_full'));
 assert.deepEqual(prior.entries.map(row=>[row.accountId,row.rp,row.rank]),[[f.a,1001,1],[f.c,950,2],[f.b,900,3]]);
 const finite=structuredClone([...f.data].filter(([key])=>key.startsWith(C.totals+'/')));
 const {result,row}=await f.improve();assert.equal(result.changed,true);
 assert.equal(result.entries.find(value=>value.accountId===f.b).runVerified,true);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
 assert.equal(f.data.get(C.public+'/totals').revision,7);
 assert.deepEqual([...f.data].filter(([key])=>key.startsWith(C.totals+'/')),finite);
 assert.deepEqual(f.data.get(C.public+'/totals_full'),prior);
 const mutation=f.commits.find(commit=>commit.writes.some(w=>w.update.name.endsWith('/'+R.collection+'/'+R.trackId)));
 assert.ok(mutation);
 for(const path of [R.collection+'/'+R.trackId,C.public+'/totals']){
   const write=mutation.writes.find(w=>w.update.name.endsWith('/'+path));assert.ok(write);assert.equal(write.currentDocument.updateTime,'v1');
 }
 const after=f.calls.length;assert.equal((await publishEventCapacity(f.runtime)).published,true);assert.ok(f.calls.length-after<50);
 const current=f.data.get(C.public+'/totals_full');assert.notEqual(current.pagination.generation,prior.pagination.generation);
 assert.deepEqual(current.entries.map(value=>[value.accountId,value.rp,value.rank]),[[f.b,1401,1],[f.c,950,2],[f.a,900,3]]);
 assert.equal(current.dynamicComponents.permanentRollingHills.sourceRevision,2);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,false);
 assert.equal((await f.service.publicPage('event_totals','main',prior.pagination.generation,0)).entries[0].accountId,f.a);
 const beforeDuplicate=f.calls.length;assert.equal((await mergeCanonicalResultIntoTrack(f.env,R.trackId,row,true)).changed,false);
 assert.ok(!f.calls.slice(beforeDuplicate).includes('/'+C.public+'/totals'));
 assert.equal(f.data.get(C.public+'/totals').publicationPending,false);
 assert.ok(f.counts.every(value=>value.reads<=16&&value.writes<=16));
});

test('combined publication defers an unavailable permanent source without replacing last good totals',async()=>{
 const f=await combinedFixture(),prior=structuredClone(f.data.get(C.public+'/totals_full'));
 await f.improve();const rolling=f.data.get(R.collection+'/'+R.trackId);rolling.complete=false;
 const result=await publishEventCapacity(f.runtime);assert.equal(result.reason,'permanent_source_unavailable');assert.equal(result.pending,true);
 assert.deepEqual(f.data.get(C.public+'/totals_full'),prior);assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
 f.data.get(R.collection+'/'+R.trackId).complete=true;advanceRetryClock(f);assert.equal((await publishEventCapacity(f.runtime)).published,true);
 assert.equal(f.data.get(C.public+'/totals_full').dynamicComponents.permanentRollingHills.sourceRevision,2);
});

test('PB racing immutable page staging cannot publish obsolete combined ranks or clear durable work',async()=>{
 const f=await combinedFixture(),prior=structuredClone(f.data.get(C.public+'/totals_full'));
 await f.improve();const request=f.runtime.request;let raced=false,staged=[];
 f.runtime.request=async(route,init)=>{
   const result=await request(route,init);
   if(route===':commit'&&!raced){
     const writes=JSON.parse(init.body).writes;
     if(writes.some(w=>w.update.name.includes('/'+PUBLIC_PAGE_COLLECTION+'/'))){raced=true;staged=writes;await f.improve(8000,3);}
   }
   return result;
 };
 const result=await publishEventCapacity(f.runtime);assert.equal(raced,true);assert.equal(result.reason,'permanent_source_changed');
 assert.deepEqual(f.data.get(C.public+'/totals_full'),prior);assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
 const stagedGeneration=eventDecode({mapValue:{fields:staged[0].update.fields}}).generation;
 await assert.rejects(()=>f.service.publicPage('event_totals','main',stagedGeneration,0));
 f.runtime.request=request;advanceRetryClock(f);assert.equal((await publishEventCapacity(f.runtime)).published,true);
 assert.equal(f.data.get(C.public+'/totals_full').dynamicComponents.permanentRollingHills.sourceRevision,3);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,false);
});

test('idle event coordinator reads exactly one dirty-signal document and never writes or scans',async()=>{
 const f=fixture();assert.deepEqual(await publishEventCapacity(f.runtime),{idle:true});
 f.data.set(C.public+'/totals',{revision:4,publicationPending:false,pendingPeriodIds:[]});
 f.calls.length=0;const transactions=f.counts.length;
 for(let i=0;i<10;i++)assert.deepEqual(await publishEventCapacity(f.runtime),{idle:true});
 assert.deepEqual(f.calls,Array(10).fill('/'+C.public+'/totals'));assert.equal(f.counts.length,transactions);
});

test('Rolling-only refresh reuses completed finite scan even after snapshot query expiry',async()=>{
 const f=await combinedFixture();
 // Force several finite-total pages, then publish a completed current revision.
 for(let i=0;i<250;i++)f.data.set(C.totals+'/extra-'+i,{accountId:'extra-'+i,name:'Extra',rp:i,events:1});
 f.data.get(C.public+'/totals').revision++;
 f.data.get(C.public+'/totals').publicationPending=true;
 await advanceEventPublication(f.runtime);
 const job=f.data.get('0.6.2_event_publication_jobs/event_totals_main');
 assert.equal(job.scanComplete,true);assert.equal(job.complete,true);assert.equal(job.parts,2);
 await f.improve();f.time(3600000);
 const start=f.calls.length;
 assert.equal((await publishEventCapacity(f.runtime)).published,true);
 assert.equal(f.calls.slice(start).includes(':runQuery'),false,'unchanged finite totals are never requeried');
 assert.equal(f.data.get(C.public+'/totals_full').totalEntries,253);
 assert.equal(f.data.get(C.public+'/totals_full').dynamicComponents.permanentRollingHills.sourceRevision,2);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,false);
 // A real finite revision change MUST start a fresh authoritative scan.
 f.data.set(C.totals+'/new',{accountId:'new',name:'New',rp:9999,events:1});
 f.data.get(C.public+'/totals').revision++;
 f.data.get(C.public+'/totals').publicationPending=true;
 f.time(f.runtime.now()+15*60000); // Scheduled finite refresh coalesces new revisions.
 const next=f.calls.length;
 assert.equal((await publishEventCapacity(f.runtime)).published,true);
 assert.equal(f.calls.slice(next).includes(':runQuery'),true);
 assert.equal(f.data.get(C.public+'/totals_full').entries[0].accountId,'new');
 assert.equal(f.data.get(C.public+'/totals_full').totalEntries,254);
});

test('repeated blocked combined refreshes never query finite totals or read staged parts',async()=>{
 const f=await combinedFixture(),prior=structuredClone(f.data.get(C.public+'/totals_full'));
 await f.improve();f.data.get(R.collection+'/'+R.trackId).complete=false;
 assert.equal((await publishEventCapacity(f.runtime)).reason,'permanent_source_unavailable');
 const start=f.calls.length;
 for(let i=0;i<5;i++)assert.equal((await publishEventCapacity(f.runtime)).reason,'publication_backoff');
 const calls=f.calls.slice(start);
 assert.equal(calls.includes(':runQuery'),false);
 assert.equal(calls.includes(':batchGet'),false);
 assert.equal(calls.some(route=>route.includes('event_publication_jobs')),false);
 assert.deepEqual(f.data.get(C.public+'/totals_full'),prior);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
 f.data.get(R.collection+'/'+R.trackId).complete=true;advanceRetryClock(f);
 assert.equal((await publishEventCapacity(f.runtime)).published,true,'recovery succeeds when the durable retry is due');
 assert.equal(f.data.get(C.public+'/totals_full').dynamicComponents.permanentRollingHills.sourceRevision,2);
});

test('one blocked combined source does not rewrite its cursor on every scheduled pass',async()=>{
 const f=await combinedFixture();await f.improve();
 f.data.get(R.collection+'/'+R.trackId).complete=false;
 assert.equal((await publishEventCapacity(f.runtime)).reason,'permanent_source_unavailable');
 const cursorPath=C.cursors+'/public_capacity';
 f.data.set(cursorPath,Object.fromEntries(Object.entries(f.data.get(cursorPath)).reverse()));
 const start=f.calls.length,transactions=f.counts.length;
 for(let i=0;i<20;i++)assert.equal((await publishEventCapacity(f.runtime)).reason,'publication_backoff');
 assert.equal(f.counts.length,transactions,'no cursor transaction or write on unchanged deferral');
 assert.equal(f.calls.slice(start).filter(path=>path==='/'+C.public+'/totals').length,20,'one root read per invocation');
 f.data.get(R.collection+'/'+R.trackId).complete=true;advanceRetryClock(f);
 assert.equal((await publishEventCapacity(f.runtime)).published,true,'bounded retry permits recovery');
});

test('legacy completed jobs without an explicit scan-complete checkpoint rescan safely',async()=>{
 const f=await combinedFixture();
 delete f.data.get('0.6.2_event_publication_jobs/event_totals_main').scanComplete;
 await f.improve();const start=f.calls.length;
 assert.equal((await publishEventCapacity(f.runtime)).published,true);
 assert.equal(f.calls.slice(start).includes(':runQuery'),true);
 assert.equal(f.data.get(C.public+'/totals_full').dynamicComponents.permanentRollingHills.sourceRevision,2);
});

test('missing reused immutable parts fail closed without replacing or acknowledging totals',async()=>{
 const f=await combinedFixture(),prior=structuredClone(f.data.get(C.public+'/totals_full'));
 const job=f.data.get('0.6.2_event_publication_jobs/event_totals_main');
 f.data.delete('0.6.2_event_publication_parts/'+job.generation+'_0');
 await f.improve();
 assert.equal((await publishEventCapacity(f.runtime)).reason,'source_parts_missing');
 assert.deepEqual(f.data.get(C.public+'/totals_full'),prior);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
 advanceRetryClock(f);const start=f.calls.length;
 assert.equal((await publishEventCapacity(f.runtime)).published,true);
 assert.equal(f.calls.slice(start).includes(':runQuery'),true,'lost parts trigger authoritative recovery');
 assert.equal(f.data.get(C.public+'/totals_full').dynamicComponents.permanentRollingHills.sourceRevision,2);
});

for(const revision of [0,8])test(`finite revision ${revision} changing during a multi-pass scan preserves published totals and rescans`,async()=>{
 const f=await combinedFixture(),prior=structuredClone(f.data.get(C.public+'/totals_full'));
 for(let i=0;i<900;i++)f.data.set(C.totals+'/extra-'+i,{accountId:'extra-'+i,name:'Extra',rp:i,events:1});
 Object.assign(f.data.get(C.public+'/totals'),{revision,publicationPending:true});
 assert.equal((await advanceEventPublication(f.runtime)).pending,true);
 const request=f.runtime.request;let changed=false;
 f.runtime.request=async(route,init)=>{
   const result=await request(route,init);
   if(route===':runQuery'&&!changed){
     changed=true;
     f.data.set(C.totals+'/new',{accountId:'new',name:'New',rp:9999,events:1});
     f.data.get(C.public+'/totals').revision++;
   }
   return result;
 };
 assert.equal((await advanceEventPublication(f.runtime)).reason,'finite_source_changed');
 assert.equal(changed,true);
 assert.deepEqual(f.data.get(C.public+'/totals_full'),prior);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
 const jobPath='0.6.2_event_publication_jobs/event_totals_main';
 assert.equal(f.data.get(jobPath).restartRequired,true);
 f.runtime.request=request;
 assert.equal((await advanceEventPublication(f.runtime)).pending,true);
 assert.equal((await advanceEventPublication(f.runtime)).published,true);
 const current=f.data.get(C.public+'/totals_full');
 assert.equal(current.totalEntries,904);assert.equal(current.entries[0].accountId,'new');
 assert.equal(current.sourceRevision,revision+1);
 assert.equal(f.data.get(jobPath).restartRequired,undefined);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,false);
 assert.deepEqual(await publishEventCapacity(f.runtime),{idle:true});
});

test('missing unfinished scan parts invalidate immediately and recover without an expiry or reset loop',async()=>{
 const f=await combinedFixture(),prior=structuredClone(f.data.get(C.public+'/totals_full'));
 for(let i=0;i<900;i++)f.data.set(C.totals+'/extra-'+i,{accountId:'extra-'+i,name:'Extra',rp:i,events:1});
 f.data.get(C.public+'/totals').revision++;f.data.get(C.public+'/totals').publicationPending=true;
 assert.equal((await advanceEventPublication(f.runtime)).pending,true);
 const jobPath='0.6.2_event_publication_jobs/event_totals_main',job=f.data.get(jobPath);
 f.data.delete('0.6.2_event_publication_parts/'+job.generation+'_0');
 assert.equal((await advanceEventPublication(f.runtime)).reason,'source_parts_missing');
 assert.equal(f.data.get(jobPath).restartRequired,true);
 assert.deepEqual(f.data.get(C.public+'/totals_full'),prior);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
 assert.equal((await advanceEventPublication(f.runtime)).pending,true);
 assert.equal((await advanceEventPublication(f.runtime)).published,true);
 assert.equal(f.data.get(C.public+'/totals_full').totalEntries,903);
 assert.equal(f.data.get(jobPath).restartRequired,undefined);
 await f.improve();const start=f.calls.length;
 assert.equal((await advanceEventPublication(f.runtime)).published,true);
 assert.equal(f.calls.slice(start).includes(':runQuery'),false,'repaired checkpoint remains reusable');
});

test('older reuse invocation cannot overwrite a newer finite publication',async()=>{
 const f=await combinedFixture();await f.improve();
 const request=f.runtime.request;let overlapped=false,newer;
 f.runtime.request=async(route,init)=>{
   const result=await request(route,init);
   if(route===':commit'&&!overlapped){
     overlapped=true;
     f.data.set(C.totals+'/new',{accountId:'new',name:'New',rp:9999,events:1});
     f.data.get(C.public+'/totals').revision++;
     assert.equal((await advanceEventPublication(f.runtime)).published,true);
     newer=structuredClone(f.data.get(C.public+'/totals_full'));
   }
   return result;
 };
 await assert.rejects(advanceEventPublication(f.runtime),error=>error.code==='event_publication_conflict');
 assert.equal(overlapped,true);
 assert.deepEqual(f.data.get(C.public+'/totals_full'),newer);
 assert.equal(newer.entries[0].accountId,'new');assert.equal(newer.sourceRevision,8);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,false);
});

test('missing-part invalidation cannot clobber an overlapping completed checkpoint',async()=>{
 const f=await combinedFixture();await f.improve();
 const jobPath='0.6.2_event_publication_jobs/event_totals_main',job=f.data.get(jobPath);
 // Model a terminal scan checkpoint whose final publication has not committed.
 job.complete=false;
 const partPath='0.6.2_event_publication_parts/'+job.generation+'_0',part=f.data.get(partPath);
 f.data.delete(partPath);
 const request=f.runtime.request;let overlapped=false,newer;
 f.runtime.request=async(route,init)=>{
   const result=await request(route,init);
   if(route===':batchGet'&&!overlapped){
     overlapped=true;f.data.set(partPath,part);
     assert.equal((await advanceEventPublication(f.runtime)).published,true);
     newer=structuredClone(f.data.get(C.public+'/totals_full'));
   }
   return result;
 };
 await assert.rejects(advanceEventPublication(f.runtime),error=>error.code==='event_publication_conflict');
 assert.equal(overlapped,true);
 assert.deepEqual(f.data.get(C.public+'/totals_full'),newer);
 assert.equal(f.data.get(jobPath).complete,true);assert.equal(f.data.get(jobPath).restartRequired,undefined);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,false);
});


test('blocked permanent dependency yields to pending event periods without acknowledging combined work',async()=>{
 const f=await combinedFixture();f.time(0);await f.service.createPeriod(period);await f.improve();
 f.data.get(R.collection+'/'+R.trackId).complete=false;
 f.data.get(C.public+'/totals').pendingPeriodIds=[period.id];
 f.data.set(C.public+'/'+period.id,{period:eventPeriod(period),entries:[],publicationPending:true,revision:1,racerCount:1});
 f.data.set(C.pbs+'/'+period.id+'_'+f.a,{periodId:period.id,accountId:f.a,name:'Rolling A',timeMs:10000,submittedAt:2000});
 assert.equal((await publishEventCapacity(f.runtime)).reason,'permanent_source_unavailable');
 const result=await publishEventCapacity(f.runtime);assert.equal(result.published,true);assert.equal(result.id,period.id);
 assert.deepEqual(f.data.get(C.public+'/totals').pendingPeriodIds,[]);assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
});


test('legacy inline event publication leaves no period work behind or perpetual polling',async()=>{
 const f=fixture();await f.service.createPeriod({...period,capacity:{...capacity,storageVersion:undefined,entrants:200}});f.time(2000);
 const accountId=hash('legacy-inline'),ownerUid='legacy-owner';
 f.data.set(C.profiles+'/'+accountId,{accountId,ownerUid,name:'Legacy Racer'});
 f.data.set(C.public+'/totals',{entries:[],revision:0,pendingPeriodIds:[period.id]});
 await f.service.submit(period.id,ownerUid,{accountId,trackId:track,attemptId:'legacy',timeMs:10000,frames:10000,replay:'abcd',carStyle:'style'});
 await f.service.processBatch(period.id,async jobs=>jobs.map(verdict));
 assert.equal(f.data.get(C.public+'/'+period.id).publicationPending,false);
 assert.deepEqual(f.data.get(C.public+'/totals').pendingPeriodIds,[]);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
 assert.equal((await publishEventCapacity(f.runtime)).published,true);
 const start=f.calls.length,transactions=f.counts.length;
 assert.deepEqual(await publishEventCapacity(f.runtime),{idle:true});
 assert.deepEqual(f.calls.slice(start),['/'+C.public+'/totals']);assert.equal(f.counts.length,transactions);
});


function advanceRetryClock(f) {
 const retries=f.data.get(C.cursors+'/public_capacity')?.retries||{};
 f.time(Math.max(f.runtime.now(),...Object.values(retries).map(value=>value.retryAt)));
}
function readMeter(f) {
 const audit={documentReadEstimate:0,collections:{}},start=f.counts.length,request=f.runtime.request;
 f.runtime.request=async(route,init={})=>{
   const result=await request(route,init);recordFirestoreReads(audit,route,init,result);return result;
 };
 return {audit,total:()=>audit.documentReadEstimate+f.counts.slice(start).reduce((sum,value)=>sum+value.reads,0),
   writes:()=>(audit.writeEstimate||0)+(audit.deleteEstimate||0)+f.counts.slice(start).reduce((sum,value)=>sum+value.writes,0)};
}

test('24h thrown profile lookup failure backs off before repeating a successful source scan',async()=>{
 const f=fixture(),start=Date.UTC(2026,9,20);
 await f.service.createPeriod(period);
 const old={entries:[{accountId:'previous',name:'Published racer'}],revision:1,publicationPending:true};
 f.data.set(C.public+'/'+period.id,structuredClone(old));
 f.data.set(C.public+'/totals',{pendingPeriodIds:[period.id],publicationPending:false});
 for(let i=0;i<200;i++)f.data.set(C.pbs+'/'+period.id+'_'+i,{periodId:period.id,accountId:hash('legacy-'+i),timeMs:10000+i,submittedAt:2000});
 const request=f.runtime.request,error=Error('FIRESTORE_503');let attempts=0;
 f.runtime.request=async(route,init)=>{
   if(route===':batchGet'&&JSON.parse(init.body).documents.some(name=>name.includes('/'+C.profiles+'/'))){attempts++;throw error;}
   return request(route,init);
 };
 const meter=readMeter(f);
 for(let minute=0;minute<1440;minute++)if([2,4].includes(minute%5)){
   f.time(start+minute*60000);
   try{assert.equal((await publishEventCapacity({...f.runtime})).reason,'publication_backoff');}
   catch(caught){assert.equal(caught,error,'failed attempts retain the original error');}
 }
 assert.equal(attempts,50,'durable exponential backoff bounds failed attempts across fresh runtimes');
 assert.equal(meter.audit.collections[C.pbs],attempts*200);
 assert.equal(meter.total(),11352,'includes job/root/coordinator and transaction reads, excludes failed requests');
 assert.deepEqual(f.data.get(C.public+'/'+period.id),old,'failure never replaces the last published board');
 assert.deepEqual(f.data.get(C.public+'/totals').pendingPeriodIds,[period.id]);
 console.log('EVENT_THROW_COST 24h: attempts='+attempts+' sourceReads='+meter.audit.collections[C.pbs]+' totalReads='+meter.total());
 f.runtime.request=request;advanceRetryClock(f);
 assert.equal((await publishEventCapacity({...f.runtime})).published,true,'due retry recovers without discarding pending work');
 assert.equal(f.data.get(C.cursors+'/public_capacity').retries,undefined);
});

test('reserved source failure yields to healthy work; unavailable reservation bookkeeping starts no scan',async()=>{
 const f=fixture();await f.service.createPeriod(period);
 await f.service.createPeriod({...period,id:'healthy_day',kind:'weekly',maxRp:500});f.time(2000);
 f.data.set(C.public+'/'+period.id,{publicationPending:true,revision:1});
 f.data.set(C.public+'/healthy_day',{publicationPending:true,revision:1});
 f.data.set(C.public+'/totals',{pendingPeriodIds:[period.id,'healthy_day']});
 f.data.set(C.pbs+'/'+period.id+'_legacy',{periodId:period.id,accountId:hash('legacy'),timeMs:10000,submittedAt:2000});
 const request=f.runtime.request,error=Error('FIRESTORE_503');
 f.runtime.request=async(route,init)=>{
   if(route===':batchGet'&&JSON.parse(init.body).documents.some(name=>name.includes('/'+C.profiles+'/')))throw error;
   return request(route,init);
 };
 await assert.rejects(publishEventCapacity(f.runtime),caught=>caught===error);
 assert.equal((await publishEventCapacity(f.runtime)).id,'healthy_day');
 assert.deepEqual(f.data.get(C.public+'/totals').pendingPeriodIds,[period.id]);
 advanceRetryClock(f);
 const before=f.calls.filter(route=>route===':runQuery').length;
 f.runtime.store.transaction=async()=>{throw Error('BOOKKEEPING_UNAVAILABLE');};
 await assert.rejects(publishEventCapacity(f.runtime),/BOOKKEEPING_UNAVAILABLE/);
 assert.equal(f.calls.filter(route=>route===':runQuery').length,before,'no source scan starts without durable reservation');
});

for(const message of ['FIRESTORE_429','FIRESTORE_503','OVERALL_REQUEST_BUDGET_EXHAUSTED','Too many subrequests'])
test('reserved scan needs no post-failure bookkeeping: '+message,async()=>{
 const f=fixture();await f.service.createPeriod(period);f.time(2000);
 f.data.set(C.public+'/'+period.id,{publicationPending:true,revision:1});
 f.data.set(C.public+'/totals',{pendingPeriodIds:[period.id]});
 for(let i=0;i<200;i++)f.data.set(C.pbs+'/'+period.id+'_'+i,{periodId:period.id,accountId:hash('legacy-'+i),timeMs:10000+i,submittedAt:2000});
 const request=f.runtime.request,transaction=f.runtime.store.transaction,error=Error(message);
 let stopped=false,sourceReads=0,transactionsAfterFailure=0;
 f.runtime.store.transaction=async fn=>{
   if(stopped){transactionsAfterFailure++;throw Error('NO_BOOKKEEPING_BUDGET');}
   return transaction(fn);
 };
 f.runtime.request=async(route,init)=>{
   assert.equal(stopped,false,'quota/budget failure stops all subsequent Firestore requests in this invocation');
   if(route===':batchGet'){stopped=true;throw error;}
   const result=await request(route,init);
   if(route===':runQuery')sourceReads+=result.filter(row=>row.document).length;
   return result;
 };
 await assert.rejects(publishEventCapacity({...f.runtime}),caught=>caught===error);
 assert.equal(transactionsAfterFailure,0);
 assert.equal(sourceReads,200);
 assert.ok(f.data.get(C.cursors+'/public_capacity').retries['event_'+period.id].retryAt>f.runtime.now());
 // A new invocation has a fresh request budget but must honor the durable gate.
 stopped=false;
 assert.equal((await publishEventCapacity({...f.runtime})).reason,'publication_backoff');
 assert.equal(sourceReads,200,'bookkeeping exhaustion cannot immediately repeat the successful source scan');
 assert.equal(f.data.get(C.public+'/'+period.id).publicationPending,true);
});

for(const conflict of [new Error('FIRESTORE_409'),new Error('FIRESTORE_412'),Object.assign(new Error('conflict'),{code:'event_publication_conflict'})])
test('publication conflict does not persist failure backoff: '+conflict.message,async()=>{
 const f=fixture();await f.service.createPeriod(period);f.time(2000);
 f.data.set(C.public+'/'+period.id,{publicationPending:true});
 f.data.set(C.public+'/totals',{pendingPeriodIds:[period.id]});
 const request=f.runtime.request,before=f.counts.length;
 f.runtime.request=async(route,init)=>{
   if(route==='/0.6.2_event_publication_jobs/event_'+period.id)throw conflict;
   return request(route,init);
 };
 await assert.rejects(publishEventCapacity(f.runtime),caught=>caught===conflict);
 assert.equal(f.counts.length,before,'conflicting work causes no coordinator transaction');
 assert.equal(f.data.has(C.cursors+'/public_capacity'),false);
});

for(const phase of ['reservation','completion'])test('source reservation CAS race never rewinds winning state: '+phase,async()=>{
 const f=fixture();await f.service.createPeriod(period);f.time(2000);
 f.data.set(C.public+'/'+period.id,{publicationPending:true,revision:1});
 f.data.set(C.public+'/totals',{pendingPeriodIds:[period.id]});
 const path=C.cursors+'/public_capacity',transaction=f.runtime.store.transaction;
 const winning={active:true,periodId:'newer_period',offset:7,retries:{}};
 let turns=0;
 f.runtime.store.transaction=async fn=>{
   turns++;
   if(turns===(phase==='reservation'?1:4))f.data.set(path,structuredClone(winning));
   return transaction(fn);
 };
 await assert.rejects(publishEventCapacity(f.runtime),error=>error.code==='event_publication_conflict');
 assert.deepEqual(f.data.get(path),winning);
 if(phase==='reservation')assert.equal(f.calls.includes(':runQuery'),false,'lost admission CAS performs no source query');
 else assert.equal(f.data.get('0.6.2_event_publication_jobs/event_'+period.id).complete,true,'completed source checkpoint is not rewound');
});
async function finishedEventFixture(extra=0) {
 const f=fixture();await f.service.createPeriod(period);f.time(2000);
 const accountId=hash('plateau-racer'),ownerUid='plateau-owner';
 f.data.set(C.profiles+'/'+accountId,{accountId,ownerUid,name:'Plateau Racer'});
 f.data.set(R.collection+'/'+R.trackId,{trackId:R.trackId,algorithmVersion:R.algorithmVersion,
   schemaVersion:R.minimumSchemaVersion,revision:1,sourceRevision:1,signature:'valid_rolling_snapshot_1',
   builtAt:2000,updatedAt:2000,complete:true,totalEntries:1,entries:[{accountId,name:'Plateau Racer',
     trackId:R.trackId,timeMs:10000,frames:10000,raceTimeFrames:10000,replayHash:hash('abcd'),
     runVerified:true,integrityVerified:true}]});
 await f.service.submit(period.id,ownerUid,{accountId,trackId:track,attemptId:'first',timeMs:21000,frames:21000,replay:'abcd',carStyle:'style'});
 await f.service.processBatch(period.id,async jobs=>jobs.map(verdict));
 await advanceEventPublication(f.runtime,period.id);
 for(let i=0;i<extra;i++)f.data.set(C.totals+'/extra-'+i,{accountId:'extra-'+i,name:'Other',rp:i,events:1});
 let result;
 for(let i=0;i<10;i++){result=await advanceEventPublication(f.runtime);if(result.published)break;}
 assert.equal(result.published,true);
 return {...f,accountId,ownerUid};
}
async function improveEvent(f,{timeMs=20999,periodId=period.id}={}) {
 f.time(4000);
 await f.service.submit(periodId,f.ownerUid,{accountId:f.accountId,trackId:track,attemptId:'second',timeMs,frames:timeMs,replay:'abcd',carStyle:'style-new'});
 await f.service.processBatch(periodId,async jobs=>jobs.map(verdict));
}

test('unchanged finite input saves 1000 source reads without suppressing improved PB, replay or event publication',async()=>{
 const f=await finishedEventFixture(999),before=structuredClone(f.data.get(C.public+'/totals'));
 assert.equal(f.data.get(C.public+'/totals_full').eventRpComplete,true,'the source is healthy, not a blocked scan');
 const previousReplay=f.data.get(C.replays+'/'+period.id+'_'+f.accountId).runId;
 const meter=readMeter(f);
 await improveEvent(f);
 const work=f.data.get(C.public+'/totals');
 assert.equal(work.revision,before.revision);assert.equal(work.publicationPending,false);
 assert.equal(work.updatedAt,before.updatedAt);assert.deepEqual(work.pendingPeriodIds,[period.id]);
 assert.equal(f.data.get(C.pbs+'/'+period.id+'_'+f.accountId).timeMs,20999);
 assert.notEqual(f.data.get(C.replays+'/'+period.id+'_'+f.accountId).runId,previousReplay);
 assert.equal(f.data.get(C.replays+'/'+period.id+'_'+f.accountId).timeMs,20999);
 assert.equal(f.data.get(C.live+'/'+period.id).publicationPending,true);
 assert.equal((await publishEventCapacity(f.runtime)).published,true);
 assert.equal(meter.audit.collections[C.totals]||0,0);
 assert.deepEqual(f.data.get(C.public+'/totals').pendingPeriodIds,[]);
 console.log('EVENT_COST plateau total source reads: before=1000 after=0 (event board still published)');
});


for(const shape of ['exact-reordered','legacy-extra','projection-equal-name'])test('canonical total write suppression: '+shape,async()=>{
 const f=await finishedEventFixture(),totalPath=C.totals+'/'+f.accountId;
 const total=structuredClone(f.data.get(totalPath)),revision=f.data.get(C.public+'/totals').revision;
 if(shape==='exact-reordered')f.data.set(totalPath,{events:total.events,rp:total.rp,name:total.name,accountId:total.accountId});
 if(shape==='legacy-extra')f.data.get(totalPath).legacyInternalMarker='remove me';
 if(shape==='projection-equal-name')f.data.get(totalPath).name=' '+total.name+' ';
 const transaction=f.runtime.store.transaction,written=[];
 f.runtime.store.transaction=fn=>transaction(tx=>fn({...tx,set:(key,value)=>{written.push(key);return tx.set(key,value);}}));
 await improveEvent(f);
 assert.equal(written.filter(key=>key===totalPath).length,shape==='exact-reordered'?0:1);
 assert.deepEqual(f.data.get(totalPath),total,'canonical rewrite must remove or normalize all legacy fields');
 assert.equal(f.data.get(C.public+'/totals').revision,revision,'canonical cleanup alone is not a public change');
 assert.ok(written.includes(C.pbs+'/'+period.id+'_'+f.accountId));
 assert.ok(written.includes(C.replays+'/'+period.id+'_'+f.accountId));
});

test('100 unchanged-RP PB cycles meter submission, verification and event publication independently of finite population',async()=>{
 const f=await finishedEventFixture(999),meter=readMeter(f);
 for(let i=0;i<100;i++){
   f.time(4000+i*2000);
   const timeMs=20999-i;
   await f.service.submit(period.id,f.ownerUid,{accountId:f.accountId,trackId:track,attemptId:'budget-'+i,
     timeMs,frames:timeMs,replay:'abcd',carStyle:'style-new'});
   await f.service.processBatch(period.id,async jobs=>jobs.map(verdict));
   assert.equal((await publishEventCapacity(f.runtime)).published,true);
 }
 assert.equal(meter.audit.collections[C.totals]||0,0);
 assert.equal(meter.total(),4700,'reservation plus clearing costs 199 extra reads across 100 cycles');
 assert.equal(meter.writes(),2800,'reservation plus clearing costs 199 extra writes across 100 cycles');
 assert.equal(f.data.get(C.public+'/totals').publicationPending,false);
 console.log('EVENT_COST 100 unchanged-RP active cycles: reads='+meter.total()+' writes='+meter.writes()+' finite total scans=0');
});

for(const change of ['rp','name','events','carStyle-removal','country-removal','legacy-name'])test('meaningful finite input still invalidates: '+change,async()=>{
 const f=await finishedEventFixture(),total=f.data.get(C.totals+'/'+f.accountId),work=f.data.get(C.public+'/totals');
 const revision=work.revision;work.operatorMarker='preserved';
 let periodId=period.id;
 if(change==='name')f.data.get(C.profiles+'/'+f.accountId).name='Changed Name';
 if(change==='carStyle-removal')total.carStyle='older-style';
 if(change==='country-removal')total.countryCode='US';
 if(change==='legacy-name')delete total.name;
 if(change==='events'){f.time(0);periodId='second_day';await f.service.createPeriod({...period,id:periodId,kind:'weekly',maxRp:500});}
 await improveEvent(f,{timeMs:change==='rp'?10000:20999,periodId});
 assert.equal(f.data.get(C.public+'/totals').revision,revision+1);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
 assert.equal(f.data.get(C.public+'/totals').operatorMarker,'preserved');
});

test('unchanged finite input cannot acknowledge already pending combined work',async()=>{
 const f=await finishedEventFixture();f.data.get(C.public+'/totals').publicationPending=true;
 const revision=f.data.get(C.public+'/totals').revision;
 await improveEvent(f);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
 assert.equal(f.data.get(C.public+'/totals').revision,revision);
});

test('24h unchanged blocked dependency: durable gates survive fresh runtimes and bound reads',async()=>{
 const f=await combinedFixture();await f.improve();
 f.data.get(R.collection+'/'+R.trackId).complete=false;
 const start=Date.UTC(2026,9,20);f.time(start);
 assert.equal((await publishEventCapacity(f.runtime)).reason,'permanent_source_unavailable');
 const previous=structuredClone(f.data.get(C.public+'/totals_full')),meter=readMeter(f);
 for(let minute=0;minute<1440;minute++)if([2,4].includes(minute%5)){
   f.time(start+minute*60000);await publishEventCapacity({...f.runtime});
 }
 const reads=meter.total();
 assert.equal(reads,1299);
 assert.equal(meter.writes(),49);
 assert.equal(meter.audit.collections[C.totals]||0,0);
 assert.deepEqual(f.data.get(C.public+'/totals_full'),previous);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
 console.log('EVENT_COST blocked dependency 24h: before=2304 after='+reads+' (49 retry cursor writes; priming excluded)');
 f.data.get(R.collection+'/'+R.trackId).complete=true;advanceRetryClock(f);
 assert.equal((await publishEventCapacity({...f.runtime})).published,true);
 assert.equal(f.data.get(C.cursors+'/public_capacity').retries,undefined);
});

test('24h finite revision churn bounds restart scans; quiescent recovery preserves exact ties and deletions',async()=>{
 const f=await combinedFixture(),start=Date.UTC(2026,9,20);
 for(let i=0;i<999;i++)f.data.set(C.totals+'/extra-'+i,{accountId:'extra-'+i,name:'Other',rp:Math.floor(i/2),events:1});
 const meter=readMeter(f),prior=structuredClone(f.data.get(C.public+'/totals_full'));
 for(let minute=0;minute<1440;minute++)if([2,4].includes(minute%5)){
   f.time(start+minute*60000);
   f.data.get(C.totals+'/'+f.c).rp++;
   const work=f.data.get(C.public+'/totals');work.revision++;work.publicationPending=true;
   await publishEventCapacity({...f.runtime});
 }
 const sourceReads=meter.audit.collections[C.totals]||0;
 assert.ok(sourceReads>0&&sourceReads<=40000,'source scans must be bounded across cold runtimes');
 assert.deepEqual(f.data.get(C.public+'/totals_full'),prior);
 console.log('EVENT_COST 24h churn source reads: before=230400 after='+sourceReads);
 let result;
 for(let pass=0;pass<12;pass++){advanceRetryClock(f);f.time(f.runtime.now()+180000);result=await publishEventCapacity(f.runtime);if(result.published)break;}
 assert.equal(result.published,true);
 const board=f.data.get(C.public+'/totals_full');
 const actual=await loadPublicationEntries(board,'event_totals','main',async(c,id)=>({data:f.data.get(c+'/'+id)}));
 const scores=new Map([...f.data].filter(([key])=>key.startsWith(C.totals+'/')).map(([,row])=>[row.accountId,row.rp]));
 scores.set(f.a,(scores.get(f.a)||0)+1001);scores.set(f.b,(scores.get(f.b)||0)+500);
 const expected=[...scores].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));let rank=0;
 assert.deepEqual(actual.map(row=>[row.accountId,row.rp,row.rank]),expected.map(([id,rp],i)=>{if(!i||rp!==expected[i-1][1])rank=i+1;return [id,rp,rank];}));
 f.data.delete(C.totals+'/'+f.c);f.data.get(C.public+'/totals').revision++;f.data.get(C.public+'/totals').publicationPending=true;
 for(let pass=0;pass<8;pass++){f.time(f.runtime.now()+180000);result=await publishEventCapacity(f.runtime);if(result.published)break;}
 assert.equal(result.published,true);
 const deleted=await loadPublicationEntries(f.data.get(C.public+'/totals_full'),'event_totals','main',async(c,id)=>({data:f.data.get(c+'/'+id)}));
 assert.equal(deleted.some(row=>row.accountId===f.c),false);
});

test('abandoned scan reads zero more source rows before durable coalescing; failed CAS keeps winning checkpoint',async()=>{
 const f=await combinedFixture();
 for(let i=0;i<900;i++)f.data.set(C.totals+'/extra-'+i,{accountId:'extra-'+i,name:'Other',rp:i,events:1});
 f.data.get(C.public+'/totals').revision++;f.data.get(C.public+'/totals').publicationPending=true;
 assert.equal((await advanceEventPublication(f.runtime)).pending,true);
 f.data.get(C.public+'/totals').revision++;
 const meter=readMeter(f),transaction=f.runtime.store.transaction,jobPath='0.6.2_event_publication_jobs/event_totals_main';
 f.runtime.store.transaction=async fn=>{f.data.get(jobPath).generation='winning-generation';return transaction(fn);};
 await assert.rejects(advanceEventPublication(f.runtime),error=>error.code==='event_publication_conflict');
 assert.equal(meter.audit.collections[C.totals]||0,0);
 assert.equal(f.data.get(jobPath).generation,'winning-generation');
 assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
});

test('coordinator CAS includes nested retry fields and cannot overwrite concurrent retry changes',async()=>{
 const f=await combinedFixture();await f.improve();f.data.get(R.collection+'/'+R.trackId).complete=false;
 await publishEventCapacity(f.runtime);advanceRetryClock(f);
 const transaction=f.runtime.store.transaction,cursorPath=C.cursors+'/public_capacity';
 let winning;
 f.runtime.store.transaction=async fn=>{
   f.data.get(cursorPath).retries.event_totals_main.retryAt++;
   winning=structuredClone(f.data.get(cursorPath));return transaction(fn);
 };
 await assert.rejects(publishEventCapacity(f.runtime),error=>error.code==='event_publication_conflict');
 assert.deepEqual(f.data.get(cursorPath),winning);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
});

test('retry state rejects malformed or distant timestamps and never exceeds thirty minutes',()=>{
 const now=1800000000000,key='event_totals_main';
 for(const retryAt of [NaN,Infinity,-1,now+EVENT_PUBLICATION_RETRY_MAX_MS+1,'later'])
   assert.deepEqual(publicationRetries({[key]:{attempts:1,reason:'finite_source_changed',retryAt}},[key],now),{});
 let state;
 for(let i=0;i<20;i++){state=publicationRetry(state,'finite_source_changed',now);assert.ok(state.retryAt>now&&state.retryAt<=now+EVENT_PUBLICATION_RETRY_MAX_MS);}
 assert.equal(state.retryAt,now+EVENT_PUBLICATION_RETRY_MAX_MS);
 assert.deepEqual(publicationRetries({discarded:state},[key],now),{});
});


for(const kind of ['event','event_totals'])test('10000-row '+kind+' publication completes before snapshot expiry at actual scheduler cadence',async()=>{
 const f=fixture(),maximum={...period,capacity:{...capacity,entrants:10000,admissionsPerPeriod:10000}};
 await f.service.createPeriod(maximum);
 const event=eventPeriod(maximum);
 for(let i=0;i<10000;i++){
   const accountId=hash('maximum-'+i);
   if(kind==='event')f.data.set(C.pbs+'/'+period.id+'_'+accountId,{periodId:period.id,accountId,
     name:'Racer',timeMs:10000+Math.floor(i/2),submittedAt:2000,carStyle:'style'});
   else f.data.set(C.totals+'/'+accountId,{accountId,name:'Racer',rp:10000-Math.floor(i/2),events:1});
 }
 if(kind==='event')f.data.set(C.public+'/'+period.id,{period:event,entries:[],racerCount:10000,
   revision:10000,publicationPending:true});
 f.data.set(C.public+'/totals',{revision:10000,publicationPending:kind==='event_totals',
   pendingPeriodIds:kind==='event'?[period.id]:[]});
 const meter=readMeter(f);let result,minute,passes=0;
 for(minute=2;minute<54;minute++)if([2,4].includes(minute%5)){
   assert.equal(maintenanceWindowAllows('* * * * *',Date.UTC(2026,9,29,0,minute),'four-window'),true,
     'coordinated maintenance must allow enough consecutive pages before snapshot expiry');
   f.time(minute*60000);passes++;
   result=await publishEventCapacity({...f.runtime});
   assert.notEqual(result.reason,'snapshot_expired');
   if(result.published)break;
 }
 assert.equal(result.published,true);assert.equal(passes,13);assert.equal(minute,32);
 assert.equal(result.totalEntries,10000);
 assert.equal(meter.audit.collections[kind==='event'?C.pbs:C.totals],10001);
 const board=f.data.get(C.public+'/'+(kind==='event'?period.id:'totals_full'));
 const entries=await loadPublicationEntries(board,kind,kind==='event'?period.id:'main',async(c,id)=>({data:f.data.get(c+'/'+id)}));
 assert.equal(entries.length,10000);assert.equal(entries[0].rank,1);assert.equal(entries[1].rank,1);
 assert.equal(entries[9999].rank,9999);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,false);
 assert.deepEqual(f.data.get(C.public+'/totals').pendingPeriodIds,[]);
 console.log('EVENT_COST stable 10000-row '+kind+': 13 passes / 30 elapsed minutes / 10001 source reads');
});

test('reordered Firestore job maps complete multi-page publication without false CAS conflicts',async()=>{
 const f=await combinedFixture();
 for(let i=0;i<999;i++)f.data.set(C.totals+'/extra-'+i,{accountId:'extra-'+i,name:'Racer',rp:i,events:1});
 const work=f.data.get(C.public+'/totals');work.revision++;work.publicationPending=true;
 const transaction=f.runtime.store.transaction,jobPath='0.6.2_event_publication_jobs/event_totals_main';
 f.runtime.store.transaction=fn=>{
   const job=f.data.get(jobPath);
   if(job)f.data.set(jobPath,Object.fromEntries(Object.entries(job).sort(([a],[b])=>a.localeCompare(b))));
   return transaction(fn);
 };
 const meter=readMeter(f);
 assert.equal((await advanceEventPublication(f.runtime)).pending,true);
 assert.equal((await advanceEventPublication(f.runtime)).published,true);
 assert.equal(meter.audit.collections[C.totals],1001,'key ordering must not cause rereads');
 assert.equal(f.data.get(C.public+'/totals').publicationPending,false);
});


test('finite totals coalesce new revisions without rereading participants; dirty work survives',async()=>{
 const f=await combinedFixture(),before=structuredClone(f.data.get(C.public+'/totals_full'));
 f.data.set(C.totals+'/'+f.c,{accountId:f.c,name:'Finite C',rp:960,events:2});
 const work=f.data.get(C.public+'/totals');work.revision++;work.publicationPending=true;work.pendingPeriodIds=[];
 f.time(3000);const meter=readMeter(f),held=await publishEventCapacity(f.runtime);
 assert.equal(held.reason,'finite_totals_coalescing');assert.equal(held.retryAt,902000);
 assert.equal(meter.audit.collections[C.totals]||0,0);
 assert.deepEqual(f.data.get(C.public+'/totals_full'),before);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
 f.time(902000);assert.equal((await publishEventCapacity(f.runtime)).published,true);
 assert.equal(f.data.get(C.public+'/totals_full').entries.find(row=>row.accountId===f.c).rp,960);
 assert.equal(f.data.get(C.public+'/totals').publicationPending,false);
});
