import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {rebuildTrack, updateTrackIdentity,computeTrackEntries, mergeCanonicalResultIntoTrack, mergeCanonicalResultsIntoTrack, rebuildOverall, computeOverall, handleRequest, processMigrationJob, reconcileCanonicalChanges} from '../src/index.js';
import {pendingSlot, VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION, verificationSchedule, VERIFICATION_COLLECTION} from '../src/verification.js';
import {loadPublicationEntries, PUBLIC_PAGE_COLLECTION, preparePublicationPages} from '../src/paged-publication.js';
import {migrateVerificationChunk, verificationShardId} from '../src/verification-shards.js';
import {eventEncode, eventDecode} from '../src/events-store.js';

const track='5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const base='projects/polytrack-052/databases/(default)/documents/';
const boards='0.6.2_s1_leaderboards_track', results='0.6.2_race_results', overall='0.6.2_s1_leaderboards_overall';
const replay='capacity-proof', replayHash=createHash('sha256').update(replay).digest('hex');
const row=i=>({accountId:`r${String(i).padStart(4,'0')}`,name:`Racer ${i}`,trackId:track,timeMs:10000+Math.floor(i/2),
  frames:10000+Math.floor(i/2),raceTimeFrames:10000+Math.floor(i/2),uploadId:1,replay,replayHash,pbAt:1000});
const proof=r=>({...pendingSlot(r),status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION});
function fixture(count) {
 const data=new Map(), versions=new Map(), calls=[], commits=[], queries=[];let snapshot=null;
 const wire=(key,value=data.get(key))=>({name:base+key,fields:eventEncode(value).mapValue.fields,updateTime:`2026-10-18T00:00:00.${String(versions.get(key)||0).padStart(9,'0')}Z`});
 const rows=Array.from({length:count},(_,i)=>row(i));
 rows.forEach(r=>data.set(`${results}/${r.accountId}_${track}`,r));
 const legacy=Object.fromEntries(rows.slice(0,500).map(r=>[r.accountId,proof(r)]));
 data.set(`${VERIFICATION_COLLECTION}/${track}`,{trackId:track,slots:legacy,...verificationSchedule(legacy)});
 rows.slice(500).forEach(r=>{const queueId=verificationShardId(track,r.accountId),slots={[r.accountId]:proof(r)};
   data.set(`${VERIFICATION_COLLECTION}/${queueId}`,{trackId:track,queueId,storageVersion:2,slots,...verificationSchedule(slots)});});
 const env={ALLOWED_ORIGINS:'https://example.test',PUBLIC_READ_RATE_LIMITER:{limit:async()=>({success:true})},__TEST_FIRESTORE:async(route,init={})=>{
   calls.push(route);
   if(route===':batchGet'){
     const body=JSON.parse(init.body),source=body.readTime?snapshot:data;
     return body.documents.map(name=>{const key=name.slice(base.length);return source.has(key)?{found:wire(key,source.get(key))}:{missing:name};});
   }
   if(route===':runQuery'){
     const body=JSON.parse(init.body),q=body.structuredQuery;queries.push(body);
     if(q.from[0].collectionId===results){
       if(!snapshot)snapshot=structuredClone(data);
       const source=body.readTime?snapshot:data,after=q.startAt?.values?.[0]?.referenceValue||'';
       return [...source].filter(([key,r])=>key.startsWith(results+'/')&&r.trackId===track&&base+key>after)
         .sort(([a],[b])=>a.localeCompare(b)).slice(0,q.limit).map(([key,r])=>({document:wire(key,r),readTime:new Date().toISOString()}));
     }
     const after=q.startAt?.values?.[0]?.referenceValue||'';
     return [...data].filter(([key])=>key.startsWith(boards+'/')&&base+key>after)
       .sort(([a],[b])=>a.localeCompare(b)).slice(0,q.limit).map(([key,r])=>({document:wire(key,r)}));
   }
   if(route===':commit'){
     const writes=JSON.parse(init.body).writes;assert.ok(writes.length<=500);commits.push(writes);
     for(const w of writes){const key=w.update.name.slice(base.length);if(w.currentDocument)assert.deepEqual(w.currentDocument,data.has(key)?{updateTime:`2026-10-18T00:00:00.${String(versions.get(key)||0).padStart(9,'0')}Z`}:{exists:false});}
     for(const w of writes){const key=w.update.name.slice(base.length);data.set(key,eventDecode({mapValue:{fields:w.update.fields}}));versions.set(key,(versions.get(key)||0)+1);}
     return {writeResults:writes.map(w=>({updateTime:`2026-10-18T00:00:00.${String(versions.get(w.update.name.slice(base.length))).padStart(9,'0')}Z`}))};
   }
   const url=new URL('https://fixture.test'+route),key=decodeURIComponent(url.pathname.slice(1)),source=url.searchParams.has('readTime')?snapshot:data;
   return source?.has(key)?wire(key,source.get(key)):null;
 }};
 return {data,env,rows,calls,commits,queries,read:async(c,id)=>data.has(c+'/'+id)?{data:data.get(c+'/'+id)}:null};
}
async function build(f){let result;for(let pass=0;pass<20;pass++) {const start=f.calls.length;result=await rebuildTrack(f.env,track);assert.ok(f.calls.length-start<=50,`pass used ${f.calls.length-start} requests`);if(!result.pending)return result;}throw Error('Build failed to finish');}

for(const count of [500,501,531,1001])test(`full publication preserves ${count} racers and deterministic cross-page ties`,async()=>{
 const f=fixture(count);await build(f);
 const board=f.data.get(`${boards}/${track}`),entries=await loadPublicationEntries(board,'track',track,f.read);
 assert.equal(entries.length,count);assert.equal(board.totalEntries,count);assert.equal(board.sourceComplete,true);
 assert.equal(board.entries.length,Math.min(500,count));assert.equal(board.complete,count<=500);
 assert.deepEqual(entries.map(r=>r.accountId),f.rows.map(r=>r.accountId));
 assert.ok(entries.every((r,i)=>r.rank===i+1&&r.fieldSize===count&&r.runVerified));
 if(count>500){assert.equal(board.pagination.pageCount,Math.ceil(count/100));assert.equal(f.queries.filter(q=>q.readTime).length,Math.floor((count-501)/100)+1);}
 const before=f.commits.length;await mergeCanonicalResultsIntoTrack(f.env,track,[`${f.rows[0].accountId}_${track}`],new Map([[`${f.rows[0].accountId}_${track}`,{data:f.rows[0]}]]));
 assert.equal(f.data.get(`${boards}/${track}`).revision,board.revision,'duplicate PB is idempotent');
 assert.ok(f.commits.length-before<=1,'only unfinished migration checkpoint may change');
});

test('PB from beyond page five becomes first without dropping any public racer or accepting its old proof',async()=>{
 const f=fixture(1001);await build(f);const changed={...f.rows[1000],timeMs:9000,frames:9000,raceTimeFrames:9000,uploadId:2};
 f.data.set(`${results}/${changed.accountId}_${track}`,changed);
 await mergeCanonicalResultIntoTrack(f.env,track,changed,true);
 const board=f.data.get(`${boards}/${track}`),entries=await loadPublicationEntries(board,'track',track,f.read);
 assert.equal(entries.length,1001);assert.equal(entries[0].accountId,changed.accountId);assert.equal(entries[0].runVerified,false);
 const scored=computeOverall([{...board,entries}]);assert.equal(scored.length,1000);assert.equal(scored[0].bestTrackField,1000);
});

test('Overall publishes every 531-racer identity with 200-row legacy compatibility and full planner samples',async()=>{
 const f=fixture(531);await build(f);await rebuildOverall(f.env,true);
 const published=f.data.get(`${overall}/main`);
 assert.equal(published.entries.length,200);assert.equal(published.totalEntries,531);assert.equal(published.sourceComplete,true);assert.equal(published.complete,false);
 const entries=await loadPublicationEntries(published,'overall','main',f.read);
 assert.equal(entries.length,531);assert.equal(entries.at(-1).userId,'r0530');assert.equal(entries.at(-1).name,'Racer 530');
 assert.equal(entries.at(-1).resultSamples[0].fieldSize,531);
 assert.equal(f.data.has('0.6.2_s1_cosmetic_entitlements/r0530'),true);
});

test('migration preserves exact historical proof and checkpoint on transaction conflict',async()=>{
 const f=fixture(500),key=`${VERIFICATION_COLLECTION}/${track}`,original=structuredClone(f.data.get(key));
 const root={data:original,updateTime:'v0'};
 await assert.rejects(migrateVerificationChunk({trackId:track,collection:VERIFICATION_COLLECTION,root,read:f.read,commit:async()=>{throw Error('FIRESTORE_409');}}),/409/);
 assert.deepEqual(f.data.get(key),original);
 assert.equal(f.data.has(`${VERIFICATION_COLLECTION}/${verificationShardId(track,'r0000')}`),false);
});

test('immutable pages remain available after a newer generation is staged',async()=>{
 const first=await preparePublicationPages('track',track,[{accountId:'a'}],{sourceRevision:1});
 const next=await preparePublicationPages('track',track,[{accountId:'b'}],{sourceRevision:2});
 const all=new Map([...first.documents,...next.documents].map(d=>[d.id,d]));
 const entries=await loadPublicationEntries({pagination:first.pagination},'track',track,async(c,id)=>all.get(id));
 assert.equal(entries[0].accountId,'a');assert.notEqual(first.pagination.generation,next.pagination.generation);
});

test('normal-track ties retain the released ordinal RP policy and unique positions',()=>{
 const rows=[{...row(2),timeMs:10000},{...row(0),timeMs:10000},{...row(1),timeMs:10000}];
 const entries=computeTrackEntries(rows,track);
 assert.deepEqual(entries.map(e=>e.accountId),['r0000','r0001','r0002']);
 assert.deepEqual(entries.map(e=>e.rank),[1,2,3]);assert.deepEqual(entries.map(e=>e.position),[1,2,3]);
});
test('paged Overall never promotes incomplete canonical-source coverage to complete',async()=>{
 const f=fixture(531);await build(f);f.data.get(boards+'/'+track).sourceComplete=false;
 await rebuildOverall(f.env,true);const published=f.data.get(overall+'/main');
 assert.equal(published.pagination.complete,true);assert.equal(published.sourceComplete,false);assert.equal(published.complete,false);assert.equal(published.totalEntriesExact,false);
 const page=f.data.get(PUBLIC_PAGE_COLLECTION+'/'+('overall_main_'+published.pagination.generation+'_0'));
 assert.equal(page.sourceComplete,false);assert.equal(page.complete,true);
});
test('identity changes outside the preview update the full track generation and its public page route',async()=>{
 const f=fixture(531);await build(f);
 await updateTrackIdentity(f.env,track,{accountId:'r0530',name:'Updated Racer',countryCode:'US',carStyle:'style',identityUpdatedAt:3000});
 const board=f.data.get(boards+'/'+track);
 const response=await handleRequest(new Request('https://fixture.test/v1/snapshot/track/page?trackId='+track+'&generation='+board.pagination.generation+'&page=5',{headers:{Origin:'https://example.test','CF-Connecting-IP':'192.0.2.1'}}),f.env);
 assert.equal(response.status,200);const page=await response.json();assert.equal(page.sourceRevision,board.revision);assert.equal(page.entries.at(-1).name,'Updated Racer');
 assert.equal(page.entries.at(-1).rank,531);assert.equal(page.sourceComplete,true);
});


test('Overall trackCatalog discovers all 229 source boards without extra reads, private fields, or scoring changes',async()=>{
 const f=fixture(2);await build(f);
 const beforeBaseline=f.calls.length;await rebuildOverall(f.env,true);
 const baseline=f.data.get(overall+'/main'),baselineCalls=f.calls.slice(beforeBaseline);
 const expected=new Map([[track,baseline.trackCatalog[0].updatedAt]]);
 for(let i=0;i<228;i++){
   const id=createHash('sha256').update('catalog-source-'+i).digest('hex');
   const entries=i%3===0?[]:i%3===1?[{...row(0),trackId:id,integrityVerified:true,runVerified:true}]
     :[0,1].map(j=>({...row(j),trackId:id,integrityVerified:true,runVerified:false}));
   const board={...(i===0?{}:{trackId:id,complete:true}),entries,totalEntries:entries.length,
     updatedAt:1000+i,ownerUid:'private-owner-canary',proof:{private:'proof-canary'},replay:'private-replay-canary'};
   if(i===0){board.updatedAt=-1;board.builtAt=25;}
   if(i===1)delete board.updatedAt;
   if(i===2){board.updatedAt=1.5;board.builtAt=30;}
   f.data.set(boards+'/'+id,board);expected.set(id,i===0?25:i===1?0:i===2?30:1000+i);
 }
 const start=f.calls.length,queryStart=f.queries.length;
 await rebuildOverall(f.env,true);const published=f.data.get(overall+'/main'),calls=f.calls.slice(start);
 assert.deepEqual(published.trackCatalog,[...expected].sort(([a],[b])=>a.localeCompare(b)).map(([trackId,updatedAt])=>({trackId,updatedAt})));
 assert.equal(published.trackCatalog.length,229);assert.equal(published.trackSummaries.length,1);
 assert.deepEqual(published.entries.map(({userId,score,raceCount,rank})=>({userId,score,raceCount,rank})),
   baseline.entries.map(({userId,score,raceCount,rank})=>({userId,score,raceCount,rank})));
 assert.equal(published.sourceComplete,false,'legacy missing completeness must not be promoted');
 assert.equal(published.complete,false);assert.equal(published.totalEntriesExact,false);
 assert.equal(f.queries.length-queryStart,3,'only the existing 100-board source pages are queried');
 assert.ok(f.queries.slice(queryStart).every(q=>q.structuredQuery.from[0].collectionId===boards&&q.structuredQuery.limit===100));
 const nonQueryReads=routes=>routes.filter(route=>route!==':runQuery'&&route!==':commit');
 assert.deepEqual(nonQueryReads(calls),nonQueryReads(baselineCalls),'catalog adds no keyed reads or per-track requests');
 const response=await handleRequest(new Request('https://catalog.test/v1/snapshot/overall',{headers:{Origin:'https://example.test','CF-Connecting-IP':'192.0.2.3'}}),f.env);
 assert.equal(response.status,200);const publicBoard=await response.json();
 assert.deepEqual(publicBoard.trackCatalog,published.trackCatalog);
 for(const entry of publicBoard.trackCatalog)assert.deepEqual(Object.keys(entry).sort(),['trackId','updatedAt']);
 assert.ok(!JSON.stringify(publicBoard.trackCatalog).includes('canary'));
});

test('migration checkpoints a healthy sibling while a capacity build remains pending',async()=>{
 const f=fixture(501),healthy='7239b17057127936907a805b0caa5d8c6f6c97eca9bdabf1a5312dce479629b7';
 const original=f.env.__TEST_FIRESTORE;let largeQueries=0,healthyQueries=0;
 f.env.__TEST_FIRESTORE=async(route,init={})=>{
   if(route===':runQuery'){
     const q=JSON.parse(init.body).structuredQuery;
     if(q.from[0].collectionId===results){
       if(q.where?.fieldFilter?.value?.stringValue===healthy){healthyQueries++;return [];}
       largeQueries++;
     }
   }
   if(init.method==='PATCH'){
     const key=decodeURIComponent(route.slice(1));f.data.set(key,eventDecode({mapValue:{fields:JSON.parse(init.body).fields}}));
     return {updateTime:'migration-written'};
   }
   return original(route,init);
 };
 const job={kind:'migration',pendingTrackIds:[track,healthy],pendingBadges:['previously-earned'],awardedBadgeIds:[],processedTracks:0};
 const first=await processMigrationJob(f.env,job);
 assert.equal(first.processedTracks,0);assert.equal(first.tracksRemaining,2);
 const saved=f.data.get('0.6.2_s1_worker_jobs/release_migration');
 assert.deepEqual(saved.pendingTrackIds,[track,healthy]);assert.ok(saved.pendingBadges.includes('previously-earned'));
 const deferred=await processMigrationJob(f.env,saved);
 assert.equal(deferred.deferred,true,'migration does not compete with its active reconciliation build');
 const queued=f.data.get('0.6.2_s1_worker_jobs/canonical_reconcile_v2');
 queued.backfillComplete=true;queued.schemaVersion=2;
 await reconcileCanonicalChanges(f.env,{scanResults:false});
 await processMigrationJob(f.env,saved);
 await processMigrationJob(f.env,f.data.get('0.6.2_s1_worker_jobs/release_migration'));
 assert.equal(healthyQueries,1,'completed sibling is not rebuilt on the next pass');
 assert.equal(largeQueries,2,'migration reuses the completed publication instead of starting a second canonical scan');
});