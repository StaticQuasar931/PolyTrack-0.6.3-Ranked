import {publicEventTotal,publicEventPage} from './event-public-projection.js';
import {EVENT_COLLECTIONS as C,eventLeaderboard,publicEventPeriod,EventError} from './events.js';
import {eventDecode,eventEncode} from './events-store.js';
import {contentHash,preparePublicationPages,PUBLIC_MANIFEST_COLLECTION,publicationManifestId} from './paged-publication.js';
import {PERMANENT_ROLLING_HILLS,readPermanentRollingHills,mergePermanentRollingIntoTotals} from './permanent-rolling-hills.js';

import {publicationRetries,publicationRetry,samePublicationState} from './event-publication-retry.js';

const JOBS='0.6.2_event_publication_jobs',PARTS='0.6.2_event_publication_parts';
// At phase-2/4 cadence, 800 rows/pass completes 10,000 rows in 30 minutes,
// inside the 50-minute snapshot window without increasing per-pass transactions.
const PAGE=200,PAGES_PER_PASS=4;
const decode=doc=>doc?eventDecode({mapValue:{fields:doc.fields||{}}}):null;
const post=(r,route,body)=>r.request(route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
const base=r=>`projects/${r.projectId}/databases/(default)/documents/`;
const write=(r,collection,id,data)=>({update:{name:base(r)+collection+'/'+id,fields:eventEncode(data).mapValue.fields}});

const rollingPath=PERMANENT_ROLLING_HILLS.collection+'/'+PERMANENT_ROLLING_HILLS.trackId;
function rollingRevision(source) {
  return Number.isSafeInteger(source?.sourceRevision)&&source.sourceRevision>0&&source.revision===source.sourceRevision
    ? source.sourceRevision : null;
}
// One fixed-snapshot source query per page, no per-racer verification or menu scan.
// Authoritative per-account PB/total documents already exist; only display storage was capped.
export async function advanceEventPublication(runtime,periodId=null,knownRoot=undefined) {
 const kind=periodId?'event':'event_totals',id=periodId||'main',jobId=kind+'_'+id;
 const rootPath=C.public+'/'+(periodId||'totals'),targetPath=C.public+'/'+(periodId||'totals_full');
 const root=knownRoot===undefined?decode(await runtime.request('/'+rootPath)):knownRoot;
 if(!root||!root.publicationPending)return {idle:true};
 const priorCombined=periodId?null:decode(await runtime.request('/'+targetPath));
 let rolling=null;
 if(!periodId){
   // Do not rescan finite totals while the required live component is unavailable.
   try{rolling=await readPermanentRollingHills(runtime.request);}
   catch{if(priorCombined)return {pending:true,deferred:true,reason:'permanent_source_unavailable',kind,id};}
 }
 const p=periodId?decode(await runtime.request('/'+C.periods+'/'+periodId)):null;
 if(periodId&&!p)return {idle:true};
 const priorJob=decode(await runtime.request('/'+JOBS+'/'+jobId));
 let state=priorJob;
 // Defer abandoned checkpoints before reading another source page. The durable
 // coordinator gate coalesces changes; the next due attempt may restart.
 if(state?.complete===false&&!state.restartRequired&&state.readTime&&
   (state.sourceRevision!==(root.revision||0)||runtime.now()-Date.parse(state.readTime)>50*60000)){
   await runtime.store.transaction(async tx=>{
     const current=await tx.get(JOBS+'/'+jobId);
     if(!samePublicationState(current,priorJob))throw new EventError('event_publication_conflict',409);
     await tx.set(JOBS+'/'+jobId,{...state,restartRequired:true});
   });
   return {pending:true,deferred:true,reason:state.sourceRevision!==(root.revision||0)?'finite_source_changed':'snapshot_expired',kind,id};
 }
 // Rolling-only changes leave the finite revision unchanged. Persisted immutable
 // parts remain usable; the final transaction still fences both live sources.
 const reuseComplete=!periodId&&!state?.restartRequired&&state?.complete===true&&state.scanComplete===true&&state.sourceRevision===(root.revision||0);
 if(!state||state.restartRequired||state.sourceRevision!==(root.revision||0)||(!reuseComplete&&(state.complete||runtime.now()-Date.parse(state.readTime)>50*60000))){
   state={kind,id,sourceRevision:root.revision||0,generation:await contentHash([kind,id,root.revision||0,runtime.now()]),
     readTime:'',afterName:'',parts:0,complete:false};
 }
 let ended=state.scanComplete===true;
 for(let pass=0;pass<PAGES_PER_PASS&&!ended;pass++){
   const collection=periodId?C.pbs:C.totals;
   const structuredQuery={from:[{collectionId:collection}],limit:PAGE,orderBy:[{field:{fieldPath:'__name__'},direction:'ASCENDING'}],
     ...(periodId?{where:{fieldFilter:{field:{fieldPath:'periodId'},op:'EQUAL',value:{stringValue:periodId}}}}:{}),
     ...(state.afterName?{startAt:{before:false,values:[{referenceValue:state.afterName}]}}:{})};
   const rows=await post(runtime,':runQuery',{structuredQuery,...(state.readTime?{readTime:state.readTime}:{})});
   if(!Array.isArray(rows))throw Error('EVENT_PUBLICATION_QUERY_INVALID');
   const documents=rows.filter(r=>r.document).map(r=>r.document);
   if(documents.length>PAGE)throw Error('EVENT_PUBLICATION_PAGE_OVERFLOW');
   const readTime=state.readTime||rows.at(-1)?.readTime;
   if(!readTime||!Number.isFinite(Date.parse(readTime)))throw Error('EVENT_PUBLICATION_SNAPSHOT_REQUIRED');
   const last=documents.at(-1)?.name;
   if(last===state.afterName&&documents.length)throw Error('EVENT_PUBLICATION_CURSOR_INVALID');
   const next={...state,readTime,afterName:last||state.afterName,parts:state.parts+(documents.length?1:0),scanComplete:documents.length<PAGE};
   const entries=documents.map(decode);
   // Old authoritative PBs predate public identity fields. Keyed profile lookup, never a scan.
   const missing=entries.filter(row=>!row.name);
   if(missing.length){
     const profiles=await post(runtime,':batchGet',{documents:missing.map(row=>base(runtime)+C.profiles+'/'+row.accountId),readTime});
     const byId=new Map((profiles||[]).filter(row=>row.found).map(row=>[row.found.name.split('/').pop(),decode(row.found)]));
     for(const row of missing){const profile=byId.get(row.accountId);if(profile){row.name=profile.nickname||profile.name;row.carStyle=profile.carStyle||'';}}
   }
   if(!periodId)for(let i=0;i<entries.length;i++)entries[i]=publicEventTotal(entries[i]);
   // A transactional checkpoint serializes overlapping cron/verifier invocations.
   await runtime.store.transaction(async tx=>{
     const current=await tx.get(JOBS+'/'+jobId);
     if(!samePublicationState(current,state.parts===0&&!state.readTime?priorJob:state))throw new EventError('event_publication_conflict',409);
     const partPath=PARTS+'/'+`${state.generation}_${state.parts}`;
     if(documents.length)await tx.get(partPath);
     if(documents.length)await tx.set(partPath,{entries});
     await tx.set(JOBS+'/'+jobId,next);
   });
   state=next;ended=documents.length<PAGE;
 }
 if(!ended)return {pending:true,kind,id};
 const parts=await post(runtime,':batchGet',{documents:Array.from({length:state.parts},(_,i)=>base(runtime)+PARTS+'/'+state.generation+'_'+i)});
 const byId=new Map((parts||[]).filter(row=>row.found).map(row=>[row.found.name.split('/').pop(),decode(row.found)]));
 if(Array.from({length:state.parts},(_,i)=>byId.get(state.generation+'_'+i)).some(part=>!Array.isArray(part?.entries))){
   // A lost part must not strand durable work in a permanent reuse/failure loop.
   await runtime.store.transaction(async tx=>{
     const current=await tx.get(JOBS+'/'+jobId);
     if(!samePublicationState(current,state))throw new EventError('event_publication_conflict',409);
     await tx.set(JOBS+'/'+jobId,{...state,scanComplete:false,restartRequired:true});
   });
   return {pending:true,deferred:true,reason:'source_parts_missing',kind,id};
 }
 let entries=[];
 for(let i=0;i<state.parts;i++){const part=byId.get(state.generation+'_'+i);if(!Array.isArray(part?.entries))throw Error('EVENT_PUBLICATION_PART_MISSING');entries.push(...part.entries);}
 let dynamic={},rollingSource=null;
 if(periodId)entries=eventLeaderboard(p,entries);
 else{
   entries.sort((a,b)=>b.rp-a.rp||a.accountId.localeCompare(b.accountId));
   let rank=0;entries=entries.map((row,i)=>{if(!i||row.rp!==entries[i-1].rp)rank=i+1;return {...row,rank};});
   try{
     if(!rolling)rolling=await readPermanentRollingHills(runtime.request);
     rollingSource={revision:rolling.sourceRevision,signature:rolling.sourceSignature};
     const merged=mergePermanentRollingIntoTotals({entries,totalEntries:entries.length,complete:true,updatedAt:root.updatedAt||0},rolling);
     entries=merged.entries;dynamic={dynamicComponents:merged.dynamicComponents,eventRpComplete:true};
   }catch{
     if(priorCombined)return {pending:true,deferred:true,reason:'permanent_source_unavailable',kind,id};
     dynamic={eventRpComplete:false,dynamicComponents:{permanentRollingHills:{status:'unavailable'}}};
   }
 }
 entries=publicEventPage({entries},kind).entries;
 const metadata={sourceComplete:true,sourceRevision:state.sourceRevision,sourceReadTime:state.readTime,...dynamic};
 const paged=await preparePublicationPages(kind,id,entries,metadata);
 for(let start=0;start<paged.documents.length;start+=32){
   await post(runtime,':commit',{writes:paged.documents.slice(start,start+32).map(doc=>write(runtime,doc.collection,doc.id,doc.data))});
 }
 const committed=await runtime.store.transaction(async tx=>{
   const current=await tx.get(rootPath),target=targetPath===rootPath?current:await tx.get(targetPath);
   const job=await tx.get(JOBS+'/'+jobId);
   const currentRolling=rollingSource?await tx.get(rollingPath):null;
   const workRoot=periodId?await tx.get(C.public+'/totals'):null;
   const manifestPath=PUBLIC_MANIFEST_COLLECTION+'/'+publicationManifestId(kind,id,paged.pagination.generation);await tx.get(manifestPath);
   if(!samePublicationState(job,state))throw new EventError('event_publication_conflict',409);
   if(!current||(current.revision||0)!==state.sourceRevision){
     await tx.set(JOBS+'/'+jobId,{...state,scanComplete:false,restartRequired:true});
     if(current)await tx.patch(rootPath,{publicationPending:true});
     return 'finite_source_changed';
   }
   // Fence the source inside the publication transaction. A newer PB must not
   // publish an already obsolete combined generation or clear its durable work.
   if(rollingSource&&(rollingRevision(currentRolling)!==rollingSource.revision||
       currentRolling.signature!==rollingSource.signature||
       (currentRolling.pagination?currentRolling.sourceComplete!==true:currentRolling.complete===false)))return 'permanent_source_changed';
   const publication={...(periodId?(target||current):{}),entries:entries.slice(0,200),totalEntries:entries.length,publishedEntries:Math.min(entries.length,200),
     sourceComplete:true,complete:entries.length<=200,pagination:paged.pagination,...metadata,
     updatedAt:Date.parse(state.readTime),builtAt:runtime.now(),publicationPending:(current?.revision||0)!==state.sourceRevision,
     ...(periodId?{period:publicEventPeriod({...p,racerCount:current?.racerCount||0})}:{})};
   await tx.set(manifestPath,{...paged.pagination,sourceRevision:state.sourceRevision});
   await tx.set(targetPath,publication);
   if(targetPath!==rootPath)await tx.patch(rootPath,{publicationPending:publication.publicationPending});
   if(periodId&&workRoot&&!publication.publicationPending)await tx.patch(C.public+'/totals',{pendingPeriodIds:(workRoot.pendingPeriodIds||[]).filter(value=>value!==periodId)});
   await tx.set(JOBS+'/'+jobId,{...state,complete:true});
   return true;
 });
 if(committed!==true)return {pending:true,deferred:true,reason:committed,kind,id};
 return {published:true,kind,id,totalEntries:entries.length};
}

export async function publishEventCapacity(runtime) {
 // Event PBs and Rolling Hills publication set this signal in their existing
 // guarded commits. A quiet invocation costs ONE document read and no writes.
 const work=decode(await runtime.request('/'+C.public+'/totals'));
 const periods=[...new Set(Array.isArray(work?.pendingPeriodIds)?work.pendingPeriodIds:[])];
 if(!work?.publicationPending&&!periods.length)return {idle:true};
 if(periods.length>120||periods.some(value=>typeof value!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(value)))throw Error('EVENT_PUBLICATION_WORK_INVALID');
 const candidates=[...(work.publicationPending?[null]:[]),...periods];
 const cursorPath=C.cursors+'/public_capacity';
 const cursor=decode(await runtime.request('/'+cursorPath));
 const now=runtime.now();
 if(!Number.isSafeInteger(now)||now<0)throw Error('INVALID_EVENT_PUBLICATION_CLOCK');
 const keyFor=id=>id?'event_'+id:'event_totals_main';
 const retries=publicationRetries(cursor?.retries,candidates.map(keyFor),now);
 const ready=index=>!(retries[keyFor(candidates[index])]?.retryAt>now);
 const active=cursor?.active?candidates.indexOf(cursor.periodId||null):-1;
 const offset=Number.isSafeInteger(cursor?.offset)&&cursor.offset>=0?cursor.offset%candidates.length:0;
 const index=active>=0&&ready(active)?active:Array.from({length:candidates.length},(_,i)=>(offset+i)%candidates.length).find(ready);
 if(index===undefined)return {pending:true,deferred:true,reason:'publication_backoff',
   retryAt:Math.min(...Object.values(retries).map(retry=>retry.retryAt))};
 const periodId=candidates[index],key=keyFor(periodId);
 let result=await advanceEventPublication(runtime,periodId,periodId?undefined:work);
 if(result.idle)result={pending:true,deferred:true,kind:periodId?'event':'event_totals',id:periodId||'main',reason:'event_source_not_ready'};
 if(result.published)delete retries[key];
 else if(result.deferred){
   const retry=publicationRetry(retries[key],result.reason,now);
   if(retry)retries[key]=retry;
 }
 const nextCursor={active:!!result.pending&&!result.deferred,periodId,offset:(index+1)%candidates.length,
   ...(Object.keys(retries).length?{retries}:{})};
 if(!samePublicationState(cursor,nextCursor))
 await runtime.store.transaction(async tx=>{
   const current=await tx.get(cursorPath);
   if(!samePublicationState(current,cursor))throw new EventError('event_publication_conflict',409);
   await tx.set(cursorPath,nextCursor);
 });
 return result;
}
