import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {inlineEventPublicationFits} from '../src/event-publication-staging.js';
import {eventRuntime} from '../src/events-runtime.js';
import {EVENT_COLLECTIONS as C,eventPeriod} from '../src/events.js';
import {eventEncode,eventDecode} from '../src/events-store.js';
import {createFirestoreAudit,recordFirestoreReads} from '../src/firestore-read-cost.js';
import {PERMANENT_ROLLING_HILLS as R} from '../src/permanent-rolling-hills.js';
import {PUBLIC_PAGE_COLLECTION as P,PUBLIC_MANIFEST_COLLECTION as M,loadPublicationEntries} from '../src/paged-publication.js';

const api=process.env.EVENT_PUBLICATION_BASELINE
  ?await import('data:text/javascript,'+encodeURIComponent(readFileSync(process.env.EVENT_PUBLICATION_BASELINE,'utf8')
    .replace(/from '(\.\/[^']+)'/g,(_,path)=>`from '${new URL('../src/'+path.slice(2),import.meta.url).href}'`)))
  :await import('../src/event-publication.js');
const {publishEventCapacity}=api;
const start=Date.UTC(2026,10,4),base='projects/test-project/databases/(default)/documents/';
const J='0.6.2_event_publication_jobs',S='0.6.2_event_publication_parts',job=J+'/event_totals_main';
const cursor=C.cursors+'/public_capacity',old={entries:[{accountId:'old',name:'Old',rp:1}],builtAt:start-86400000};
const account=i=>i.toString(16).padStart(64,'0');
const decode=doc=>eventDecode({mapValue:{fields:doc.fields}});

function fixture({completed=0,legacy=0,kind='event_totals'}={}) {
  const data=new Map(),versions=new Map(),snapshots=new Map(),calls=[],audit=createFirestoreAudit();
  let now=start,version=0,tx=null,begins=0,hook=()=>{},after=()=>{},limit=Infinity,turnCalls=0;
  const set=(key,value)=>{data.set(key,structuredClone(value));versions.set(key,'v'+(++version));};
  const period=eventPeriod({id:'checkpoint_day',kind:'daily',enabled:true,trackId:'a'.repeat(64),
    startsAt:start-86400000,endsAt:start+86400000,graceMs:86400000,targetMs:10000,maxRp:100,
    eligibility:'best-submitted-during-period',capacity:{policyVersion:'test',storageVersion:2,entrants:10000,
      admissionsPerPeriod:10000,replayBytesPerPeriod:16777216,minIntervalMs:5000,verificationsPerDay:1536}});
  const jobPath=kind==='event'?J+'/event_'+period.id:job;
  const target=kind==='event'?C.public+'/'+period.id:C.public+'/totals_full';
  set(C.public+'/totals',{revision:1,publicationPending:kind!=='event',pendingPeriodIds:kind==='event'?[period.id]:[]});
  set(target,{...old,...(kind==='event'?{revision:1,publicationPending:true}:{})});
  set(C.periods+'/'+period.id,period);
  set(R.collection+'/'+R.trackId,{trackId:R.trackId,algorithmVersion:R.algorithmVersion,
    schemaVersion:R.minimumSchemaVersion,revision:2,sourceRevision:2,signature:'rolling_revision_2',
    builtAt:start,updatedAt:start,complete:true,totalEntries:1,entries:[{accountId:'rolling',name:'Rolling',
      trackId:R.trackId,timeMs:10000,frames:10000,raceTimeFrames:10000,replayHash:'a'.repeat(64),
      runVerified:true,integrityVerified:true}]});
  if(completed){
    set(jobPath,{kind,id:kind==='event'?period.id:'main',sourceRevision:1,generation:'saved',
      readTime:new Date(start-86400000).toISOString(),afterName:'last',parts:Math.ceil(completed/200),complete:true,scanComplete:true});
    for(let p=0;p<Math.ceil(completed/200);p++)set(S+'/saved_'+p,{entries:Array.from({length:Math.min(200,completed-p*200)},(_,i)=>({
      accountId:account(p*200+i),name:'Racer',rp:completed-p*200-i,events:1}))});
  }
  for(let i=0;i<legacy;i++){
    const id=account(i),row={accountId:id,...(kind==='event'?{periodId:period.id,timeMs:10000+i,submittedAt:start}:{rp:legacy-i,events:1})};
    set((kind==='event'?C.pbs+'/'+period.id+'_':C.totals+'/')+id,row);
    set(C.profiles+'/'+id,{accountId:id,name:'Identity '+i,carStyle:'style_'+i,ownerUid:'private-owner'});
  }
  const wire=(key,source=data)=>({name:base+key,fields:eventEncode(source.get(key)).mapValue.fields,updateTime:versions.get(key)});
  const request=async(path,init={})=>{
    if(++turnCalls>limit)throw Error('MOCK_REQUEST_LIMIT');
    const body=init.body?JSON.parse(init.body):null,call={path,body,begin:begins};calls.push(call);
    if(path===':beginTransaction')call.begin=++begins;
    await hook(call);
    let result;
    if(path===':beginTransaction') {assert.equal(tx,null);tx={id:'tx-'+version,reads:new Map()};result={transaction:tx.id};}
    else if(path===':rollback') {assert.equal(body.transaction,tx.id);tx=null;result={};}
    else if(path===':runQuery') {
      const at=body.readTime||new Date(now).toISOString();
      if(!body.readTime)snapshots.set(at,structuredClone(data));
      assert.ok(snapshots.has(at),'snapshot must exist');
      const source=snapshots.get(at),q=body.structuredQuery,collection=q.from[0].collectionId,filter=q.where?.fieldFilter;
      const keys=[...source.keys()].filter(key=>key.startsWith(collection+'/')&&base+key>(q.startAt?.values[0].referenceValue||'')&&
        (!filter||source.get(key)[filter.field.fieldPath]===filter.value.stringValue)).sort().slice(0,q.limit);
      result=keys.length?keys.map(key=>({document:wire(key,source),readTime:at})):[{readTime:at}];
    } else if(path===':batchGet') {
      const source=body.readTime?snapshots.get(body.readTime):data;assert.ok(source);
      result=body.documents.map(name=>source.has(name.slice(base.length))?{found:wire(name.slice(base.length),source)}:{missing:name});
    } else if(path===':commit') {
      const conflict=()=>{throw Object.assign(Error('FIRESTORE_409'),{status:409});};
      if(body.transaction){assert.ok(body.writes.length<=16);assert.equal(body.transaction,tx.id);for(const [key,v]of tx.reads)if(versions.get(key)!==v)conflict();}
      for(const w of body.writes){const key=w.update.name.slice(base.length),c=w.currentDocument;
        if(c?.updateTime&&c.updateTime!==versions.get(key)||c?.exists===false&&data.has(key))conflict();}
      for(const w of body.writes){const key=w.update.name.slice(base.length),value=decode(w.update);set(key,w.updateMask?{...data.get(key),...value}:value);}
      if(body.transaction)tx=null;
      result={};
    } else {
      assert.ok(path.startsWith('/'));const key=decodeURIComponent(path.slice(1).split('?')[0]);
      if(path.includes('?transaction=')){assert.ok(tx);tx.reads.set(key,versions.get(key));assert.ok(tx.reads.size<=16);}
      result=data.has(key)?wire(key):null;
    }
    recordFirestoreReads(audit,path,init,result);call.success=true;
    const changed=await after(call,result);return changed===undefined?result:changed;
  };
  const runtime=eventRuntime(request,{projectId:'test-project',now:()=>now});
  return {data,set,calls,audit,runtime,period,jobPath,target,hook:value=>hook=value,after:value=>after=value,
    time:value=>{now=value;begins=0;turnCalls=0;},limit:value=>limit=value,closed:()=>assert.equal(tx,null),
    retry:()=>{now=Math.max(now,...Object.values(data.get(cursor)?.retries||{}).map(v=>v.retryAt));begins=0;turnCalls=0;},
    metrics:()=>({reads:audit.documentReadEstimate,writes:audit.writeEstimate,deletes:audit.deleteEstimate,
      attemptedRequests:calls.length,successfulRequests:calls.filter(c=>c.success).length,
      sourceReads:audit.collections[C.pbs]||audit.collections[C.totals]||0,pageWrites:audit.writeCollections[P]?.writes||0})};
}
const isProfiles=call=>call.path===':batchGet'&&call.body.documents.some(name=>name.includes('/'+C.profiles+'/'));
const isStaging=call=>call.path===':commit'&&!call.body.transaction&&call.body.writes.some(w=>w.update.name.includes('/'+P+'/'));

for(const kind of ['event','event_totals'])test('empty '+kind+' source never sends an empty document batch',async()=>{
  const f=fixture({kind});
  assert.equal((await publishEventCapacity(f.runtime)).published,true);
  assert.equal(f.data.get(f.target).totalEntries,kind==='event'?0:1);
  assert.equal(f.data.get(f.jobPath).complete,true);
  assert.equal(f.data.get(C.public+'/totals').publicationPending,false);
  console.log('EVENT_EMPTY_PUBLICATION_COST '+JSON.stringify({kind,...f.metrics()}));
  assert.equal(f.calls.some(call=>call.path===':batchGet'&&!call.body.documents.length),false,'empty batch has no documents to read');
  f.closed();
});

test('completed parts survive three final failures without restaging a committed generation',async()=>{
  const f=fixture({completed:10000});
  f.hook(call=>{if(call.path===':beginTransaction'&&call.begin===2)throw Error('MOCK_FINAL_PRETRANSPORT');});
  for(let i=0;i<3;i++){f.retry();await assert.rejects(publishEventCapacity(f.runtime),/MOCK_FINAL_PRETRANSPORT/);
    assert.deepEqual(f.data.get(f.target),old);assert.equal(f.data.get(C.public+'/totals').publicationPending,true);f.closed();}
  f.hook(()=>{});f.retry();assert.equal((await publishEventCapacity(f.runtime)).published,true);
  const entries=await loadPublicationEntries(f.data.get(f.target),'event_totals','main',async(c,id)=>({data:f.data.get(c+'/'+id)}));
  assert.equal(entries.length,10001);assert.equal(f.audit.collections[C.totals]||0,0);f.closed();
  console.log('CHECKPOINT_COST final-retry '+JSON.stringify(f.metrics()));
  assert.equal(f.metrics().pageWrites,101);
});

test('failed legacy hydration retries saved source rows at their original snapshot',async()=>{
  const f=fixture({legacy:200,kind:'event'});let attempts=0;
  f.hook(call=>{if(isProfiles(call)&&++attempts<=3)throw Error('MOCK_PROFILE_PRETRANSPORT');});
  for(let i=0;i<3;i++){f.retry();await assert.rejects(publishEventCapacity(f.runtime),/MOCK_PROFILE_PRETRANSPORT/);f.closed();}
  f.set(C.profiles+'/'+account(0),{name:'Later identity'});
  f.hook(()=>{});f.retry();assert.equal((await publishEventCapacity(f.runtime)).published,true);
  console.log('CHECKPOINT_COST identity-retry '+JSON.stringify(f.metrics()));
  assert.equal(f.data.get(f.target).entries[0].name,'Identity 0');
  const readTimes=f.calls.filter(isProfiles).map(call=>call.body.readTime);assert.equal(new Set(readTimes).size,1);
  assert.equal(f.metrics().sourceReads,201);assert.equal(f.data.get(f.jobPath).pendingHydration,undefined);
});

for(const lost of ['before','after'])test('staging '+lost+'-commit failure resumes the atomic prefix',async()=>{
  const f=fixture({completed:10000});let seen=0;
  const fail=call=>{if(isStaging(call)&&++seen===2)throw Error('MOCK_STAGE_FAILURE');};
  if(lost==='before')f.hook(fail);else f.after(fail);
  await assert.rejects(publishEventCapacity(f.runtime),/MOCK_STAGE_FAILURE/);f.closed();
  assert.equal([...f.data.keys()].some(key=>key.startsWith(M+'/')),false);
  f.hook(()=>{});f.after(()=>{});f.retry();assert.equal((await publishEventCapacity(f.runtime)).published,true);
  assert.equal(f.metrics().pageWrites,101);assert.equal(f.data.get(f.jobPath).staged.nextPage,101);
});

test('staging job CAS loss cannot write pages or overwrite a winning job',async()=>{
  const f=fixture({completed:200});let winner;
  f.hook(call=>{if(isStaging(call)){winner={...f.data.get(f.jobPath),generation:'winner'};f.set(f.jobPath,winner);}});
  await assert.rejects(publishEventCapacity(f.runtime,{inlinePages:false}),/FIRESTORE_409/);
  assert.deepEqual(f.data.get(f.jobPath),winner);assert.deepEqual(f.data.get(f.target),old);
  assert.equal(f.metrics().pageWrites,0);f.closed();
});

test('changed Rolling revision and proof eligibility cannot reuse a staged generation',async()=>{
  const f=fixture({completed:200});let first=true;
  f.after(call=>{if(isStaging(call)&&first){first=false;const row=structuredClone(f.data.get(R.collection+'/'+R.trackId));
    row.revision=row.sourceRevision=3;row.signature='rolling_revision_3';row.entries[0].runVerified=false;f.set(R.collection+'/'+R.trackId,row);}});
  assert.equal((await publishEventCapacity(f.runtime,{inlinePages:false})).reason,'permanent_source_changed');
  assert.deepEqual(f.data.get(f.target),old);f.retry();
  assert.equal((await publishEventCapacity(f.runtime,{inlinePages:false})).reason,'permanent_source_unavailable');
  assert.deepEqual(f.data.get(f.target),old);
  const row=structuredClone(f.data.get(R.collection+'/'+R.trackId));row.entries[0].runVerified=true;
  row.entries[0].timeMs=row.entries[0].frames=row.entries[0].raceTimeFrames=20000;f.set(R.collection+'/'+R.trackId,row);
  const staged=f.data.get(f.jobPath).staged.generation;f.retry();assert.equal((await publishEventCapacity(f.runtime,{inlinePages:false})).published,true);
  assert.notEqual(f.data.get(f.jobPath).staged.generation,staged);
  assert.equal(f.data.get(f.target).dynamicComponents.permanentRollingHills.sourceRevision,3);f.closed();
});

test('hydration snapshot expiry restarts instead of reusing a stale identity snapshot',async()=>{
  const f=fixture({legacy:200,kind:'event'});
  f.hook(call=>{if(isProfiles(call))throw Error('MOCK_PROFILE_PRETRANSPORT');});
  await assert.rejects(publishEventCapacity(f.runtime),/MOCK_PROFILE_PRETRANSPORT/);
  f.time(start+51*60000);f.hook(()=>{});
  assert.equal((await publishEventCapacity(f.runtime)).reason,'snapshot_expired');
  f.set(C.profiles+'/'+account(0),{name:'Current identity'});f.retry();
  assert.equal((await publishEventCapacity(f.runtime)).published,true);
  assert.equal(f.data.get(f.target).entries[0].name,'Current identity');f.closed();
});

test('incomplete identity batch cannot publish defaults or clear pending hydration',async()=>{
  const f=fixture({legacy:1,kind:'event'});f.after((call,result)=>isProfiles(call)?result.slice(1):undefined);
  await assert.rejects(publishEventCapacity(f.runtime),/EVENT_PUBLICATION_BATCH_INCOMPLETE/);
  assert.deepEqual(f.data.get(f.jobPath).pendingHydration,[0]);assert.equal(f.data.get(f.target).publicationPending,true);
  f.after(()=>{});f.retry();assert.equal((await publishEventCapacity(f.runtime)).published,true);f.closed();
});

for(const kind of ['event','event_totals'])test('10000 legacy '+kind+' rows complete within 50 requests/turn and snapshot lifetime',async()=>{
  const f=fixture({legacy:10000,kind});f.limit(50);let result,turns=0,maxRequests=0;
  for(let minute=2;minute<50&&!result?.published;minute++)if([2,4].includes(minute%5)){
    f.time(start+minute*60000);const before=f.calls.length;result=await publishEventCapacity(f.runtime);
    maxRequests=Math.max(maxRequests,f.calls.length-before);turns++;f.closed();
  }
  assert.equal(result.published,true);assert.ok(turns<=15);assert.ok(maxRequests<=50);
  assert.equal(f.metrics().sourceReads,10001);assert.equal(f.audit.collections[C.profiles],10000);
  assert.equal(f.data.get(f.target).totalEntries,kind==='event'?10000:10001);
  console.log('CHECKPOINT_COST legacy-capacity '+kind+' '+JSON.stringify({...f.metrics(),turns,maxRequests}));
});

test('a wide completed generation stages at most 128 pages per pass',async()=>{
  const f=fixture({completed:13000});
  assert.equal((await publishEventCapacity(f.runtime)).pending,true);
  assert.equal(f.metrics().pageWrites,128);assert.deepEqual(f.data.get(f.target),old);
  f.time(start+120000);assert.equal((await publishEventCapacity(f.runtime)).published,true);
  assert.equal(f.metrics().pageWrites,131);f.closed();
});

test('a receipt for an old generation cannot omit changed source pages',async()=>{
  const f=fixture({completed:200});
  f.hook(call=>{if(call.path===':beginTransaction'&&call.begin===2)throw Error('MOCK_FINAL_PRETRANSPORT');});
  await assert.rejects(publishEventCapacity(f.runtime,{inlinePages:false}),/MOCK_FINAL_PRETRANSPORT/);
  const prior=structuredClone(f.data.get(f.jobPath));
  const part=structuredClone(f.data.get(S+'/saved_0'));part.entries[0].rp=99999;
  f.set(S+'/replacement_0',part);
  f.set(f.jobPath,{...prior,generation:'replacement',sourceRevision:2});
  f.set(C.public+'/totals',{...f.data.get(C.public+'/totals'),revision:2});
  f.hook(()=>{});f.retry();assert.equal((await publishEventCapacity(f.runtime,{inlinePages:false})).published,true);
  assert.equal(f.data.get(f.target).entries[0].rp,99999);
  assert.notEqual(f.data.get(f.jobPath).staged.generation,prior.staged.generation);
  assert.equal(f.metrics().pageWrites,6);f.closed();
});

test('fully staged stale receipt still loses final job CAS without overwriting the winner',async()=>{
  const f=fixture({completed:200});
  f.hook(call=>{if(call.path===':beginTransaction'&&call.begin===2)throw Error('MOCK_FINAL_PRETRANSPORT');});
  await assert.rejects(publishEventCapacity(f.runtime,{inlinePages:false}),/MOCK_FINAL_PRETRANSPORT/);
  const writes=f.metrics().pageWrites;let winner;
  f.hook(call=>{if(call.path===':beginTransaction'&&call.begin===2){
    winner={...f.data.get(f.jobPath),generation:'winning-generation',staged:{}};f.set(f.jobPath,winner);}});
  f.retry();await assert.rejects(publishEventCapacity(f.runtime,{inlinePages:false}),error=>error.code==='event_publication_conflict');
  assert.deepEqual(f.data.get(f.jobPath),winner);assert.deepEqual(f.data.get(f.target),old);
  assert.equal(f.metrics().pageWrites,writes);assert.equal(f.data.get(C.public+'/totals').publicationPending,true);f.closed();
});

test('hydration checkpoint CAS does not erase a winning job or mutate its raw parts',async()=>{
  const f=fixture({legacy:1,kind:'event'});let winner;
  f.hook(call=>{if(call.path===':beginTransaction'&&call.begin===3){winner={...f.data.get(f.jobPath),generation:'winner'};f.set(f.jobPath,winner);}});
  await assert.rejects(publishEventCapacity(f.runtime),error=>error.code==='event_publication_conflict');
  assert.deepEqual(f.data.get(f.jobPath),winner);assert.equal(f.data.get(f.target).publicationPending,true);
  for(const [key,value]of f.data)if(key.startsWith(S+'/'))assert.equal(value.entries[0].name,undefined);
  f.closed();
});

test('missing pending hydration part invalidates rather than stranding durable work',async()=>{
  const f=fixture({legacy:1,kind:'event'});
  f.hook(call=>{if(isProfiles(call))throw Error('MOCK_PROFILE_PRETRANSPORT');});
  await assert.rejects(publishEventCapacity(f.runtime),/MOCK_PROFILE_PRETRANSPORT/);
  const state=f.data.get(f.jobPath);f.data.delete(S+'/'+state.generation+'_0');
  f.hook(()=>{});f.retry();assert.equal((await publishEventCapacity(f.runtime)).reason,'source_parts_missing');
  assert.equal(f.data.get(f.jobPath).restartRequired,true);f.retry();
  assert.equal((await publishEventCapacity(f.runtime)).published,true);f.closed();
});

test('terminal hydrated checkpoint needs no expired snapshot query to finish publication',async()=>{
  const f=fixture({completed:200});f.set(f.jobPath,{...f.data.get(f.jobPath),complete:false});
  assert.equal((await publishEventCapacity(f.runtime)).published,true);
  assert.equal(f.calls.some(call=>call.path===':runQuery'),false);f.closed();
});

const isInline=call=>call.path===':commit'&&!!call.body.transaction&&call.body.writes.some(w=>w.update.name.includes('/'+P+'/'));

test('healthy small publication keeps baseline document cost and saves one staging request',async()=>{
  const f=fixture({completed:200});assert.equal((await publishEventCapacity(f.runtime)).published,true);
  console.log('CHECKPOINT_COST healthy-small '+JSON.stringify(f.metrics()));
  const commits=f.calls.filter(isInline);assert.equal(commits.length,1);
  const pages=commits[0].body.writes.filter(w=>w.update.name.includes('/'+P+'/'));
  assert.equal(pages.length,3);assert.ok(pages.every(w=>w.currentDocument.exists===false));
  assert.equal(f.calls.some(isStaging),false);
  assert.deepEqual(f.metrics(),{reads:13,writes:9,deletes:0,attemptedRequests:19,successfulRequests:19,sourceReads:0,pageWrites:3});
  f.closed();
});

test('twelve inline pages fit exactly in the sixteen-write transaction limit',async()=>{
  const f=fixture({completed:1100});assert.equal((await publishEventCapacity(f.runtime)).published,true);
  const commits=f.calls.filter(isInline);assert.equal(commits.length,1);
  assert.equal(commits[0].body.writes.length,16);assert.equal(f.calls.some(isStaging),false);f.closed();
});

test('inline byte and page bounds select durable staging without increasing capacity',()=>{
  const runtime={projectId:'test-project'},doc=size=>({collection:P,id:'bounded',data:{payload:'x'.repeat(size)}});
  assert.equal(inlineEventPublicationFits(runtime,{documents:Array.from({length:12},()=>doc(10))}),true);
  assert.equal(inlineEventPublicationFits(runtime,{documents:Array.from({length:13},()=>doc(10))}),false);
  assert.equal(inlineEventPublicationFits(runtime,{documents:[doc(800000)]}),false);
  assert.equal(inlineEventPublicationFits(runtime,{documents:Array.from({length:6},()=>doc(700000))}),false);
});

test('an existing orphan page fails atomic create then recovers through guarded staging',async()=>{
  const f=fixture({completed:200});let orphan;
  f.hook(call=>{if(isInline(call)){
    orphan=call.body.writes.find(w=>w.update.name.includes('/'+P+'/')).update.name.slice(base.length);
    f.set(orphan,{entries:[{name:'Wrong page'}]});
  }});
  await assert.rejects(publishEventCapacity(f.runtime),/FIRESTORE_409/);
  assert.deepEqual(f.data.get(f.target),old);assert.equal([...f.data.keys()].some(key=>key.startsWith(M+'/')),false);
  assert.equal(f.data.get(f.jobPath).staged,undefined);f.closed();
  f.hook(()=>{});f.retry();assert.equal((await publishEventCapacity(f.runtime)).published,true);
  assert.ok(f.calls.some(isStaging));assert.equal(f.data.get(orphan).entries[0].name,'Rolling');
  const entries=await loadPublicationEntries(f.data.get(f.target),'event_totals','main',async(c,id)=>({data:f.data.get(c+'/'+id)}));
  assert.equal(entries.length,201);assert.equal(entries.some(row=>row.name==='Wrong page'),false);f.closed();
});

for(const changed of ['root','job','rolling'])test('inline final '+changed+' CAS conflict commits no pages or manifest',async()=>{
  const f=fixture({completed:200});let path,winner;
  f.hook(call=>{if(isInline(call)){
    path=changed==='root'?C.public+'/totals':changed==='job'?f.jobPath:R.collection+'/'+R.trackId;
    winner={...f.data.get(path),...(changed==='job'?{generation:'winner'}:{revision:3})};
    if(changed==='rolling'){winner.sourceRevision=3;winner.signature='rolling_revision_3';}
    f.set(path,winner);
  }});
  await assert.rejects(publishEventCapacity(f.runtime),/FIRESTORE_409/);
  assert.deepEqual(f.data.get(path),winner);assert.deepEqual(f.data.get(f.target),old);
  assert.equal([...f.data.keys()].some(key=>key.startsWith(M+'/')||key.startsWith(P+'/')),false);
  assert.equal(f.data.get(C.public+'/totals').publicationPending,true);f.closed();
});

test('lost successful inline response leaves publication atomic and next poll idle',async()=>{
  const f=fixture({completed:200});f.after(call=>{if(isInline(call))throw Error('MOCK_LOST_FINAL_RESPONSE');});
  await assert.rejects(publishEventCapacity(f.runtime),/MOCK_LOST_FINAL_RESPONSE/);
  assert.equal(f.data.get(C.public+'/totals').publicationPending,false);
  assert.equal(f.data.get(f.jobPath).staged.nextPage,3);assert.equal(f.data.get(f.jobPath).complete,true);f.closed();
  const entries=await loadPublicationEntries(f.data.get(f.target),'event_totals','main',async(c,id)=>({data:f.data.get(c+'/'+id)}));
  assert.equal(entries.length,201);const writes=f.metrics().writes;
  f.after(()=>{});f.retry();assert.equal((await publishEventCapacity(f.runtime)).idle,true);
  assert.equal(f.metrics().writes,writes);f.closed();
});
for(const reason of ['finite_totals_coalescing','event_period_coalescing'])test('due '+reason+' keeps the healthy small atomic path',async()=>{
  const f=fixture({completed:200});
  f.set(cursor,{active:false,periodId:null,offset:0,retries:{event_totals_main:{reason,attempts:1,retryAt:start}}});
  assert.equal((await publishEventCapacity(f.runtime)).published,true);
  assert.equal(f.calls.filter(isInline).length,1);assert.equal(f.calls.some(isStaging),false);
  assert.equal(f.metrics().reads,13);assert.equal(f.metrics().writes,9);f.closed();
});
