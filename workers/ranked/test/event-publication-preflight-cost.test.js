import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {eventRuntime} from '../src/events-runtime.js';
import {eventWorkerMaintenance} from '../src/events-worker.js';
import {EVENT_COLLECTIONS as C} from '../src/events.js';
import {eventEncode,eventDecode} from '../src/events-store.js';
import {createFirestoreAudit,recordFirestoreReads,recordFirestoreFailure} from '../src/firestore-read-cost.js';
import {PERMANENT_ROLLING_HILLS as R} from '../src/permanent-rolling-hills.js';
import {preparePublicationPages,loadPublicationEntries,PUBLIC_PAGE_COLLECTION as P} from '../src/paged-publication.js';

const baseline=process.env.EVENT_PUBLICATION_PREFLIGHT_BASELINE;
const {publishEventCapacity}=baseline
  ?await import('data:text/javascript,'+encodeURIComponent(readFileSync(baseline,'utf8')
    .replace(/from '(\.\/[^']+)'/g,(_,path)=>`from '${new URL('../src/'+path.slice(2),import.meta.url).href}'`)))
  :await import('../src/event-publication.js');
const start=Date.UTC(2026,10,5,8,2),base='projects/test-project/databases/(default)/documents/';
const job='0.6.2_event_publication_jobs/event_totals_main',cursor=C.cursors+'/public_capacity';
const rollingKey=R.collection+'/'+R.trackId,part='0.6.2_event_publication_parts/saved_0';

async function fixture(t,{gate='',unavailable=false,population=1136,finitePopulation=1}={}) {
  t.mock.method(globalThis,'fetch',async()=>assert.fail('network forbidden'));
  const data=new Map(),versions=new Map(),calls=[],audit=createFirestoreAudit();
  let now=start,version=0,transaction=null,hook=()=>{};
  const set=(key,value)=>{data.set(key,structuredClone(value));versions.set(key,'v'+(++version));};
  const wire=key=>({name:base+key,fields:eventEncode(data.get(key)).mapValue.fields,updateTime:versions.get(key)});
  const rows=Array.from({length:population},(_,i)=>({accountId:'rolling-'+i,name:'Racer '+i,trackId:R.trackId,
    timeMs:10000+i,frames:10000+i,raceTimeFrames:10000+i,replayHash:'a'.repeat(64),
    runVerified:true,integrityVerified:true}));
  const pages=await preparePublicationPages('track',R.trackId,rows,{sourceRevision:2,sourceComplete:true});
  for(const doc of pages.documents)set(doc.collection+'/'+doc.id,doc.data);
  set(rollingKey,{trackId:R.trackId,algorithmVersion:R.algorithmVersion,schemaVersion:R.minimumSchemaVersion,
    revision:2,sourceRevision:2,signature:'rolling_revision_2',builtAt:start,updatedAt:start,
    complete:population<=500,sourceComplete:true,totalEntries:rows.length,entries:rows.slice(0,500),
    ...(population>500?{pagination:pages.pagination}:{})});
  if(unavailable)data.delete(rollingKey);
  set(C.public+'/totals',{revision:2,publicationPending:true});
  const old={entries:[{accountId:'old',name:'Old',rp:1}],builtAt:gate==='coalescing'?start-60000:start-86400000};
  set(C.public+'/totals_full',old);
  set(job,{kind:'event_totals',id:'main',sourceRevision:['coalescing','changed'].includes(gate)?1:2,generation:'saved',
    readTime:new Date(start-(gate==='expired'?51*60000:60000)).toISOString(),parts:Math.ceil(finitePopulation/200),
    complete:!['changed','expired'].includes(gate),scanComplete:gate!=='expired'});
  set(part,{entries:[{accountId:'finite',name:'Finite',rp:100,events:1}]});
  if(finitePopulation>1)for(let i=0;i<Math.ceil(finitePopulation/200);i++)
    set('0.6.2_event_publication_parts/saved_'+i,{entries:Array.from({length:Math.min(200,finitePopulation-i*200)},(_,j)=>({
      accountId:'finite-'+(i*200+j),name:'Finite '+(i*200+j),rp:100,events:1}))});
  const request=async(path,init={})=>{
    const body=init.body?JSON.parse(init.body):null,call={path,body};calls.push(call);
    try{hook(call);}catch(error){recordFirestoreFailure(audit,path,init);throw error;}
    let result;
    if(path===':beginTransaction') {
      assert.equal(transaction,null);transaction={id:'tx-'+version,reads:new Map()};result={transaction:transaction.id};
    } else if(path===':rollback') {assert.equal(body.transaction,transaction.id);transaction=null;result={};}
    else if(path===':commit') {
      if(body.transaction){
        assert.equal(body.transaction,transaction.id);assert.ok(body.writes.length<=16);
        for(const [key,v] of transaction.reads)assert.equal(versions.get(key),v,'fresh transaction fence');
      }
      for(const w of body.writes){
        const key=w.update.name.slice(base.length);
        assert.ok(w.currentDocument,'write preconditions retained');
        if(w.currentDocument.exists===false)assert.equal(data.has(key),false);
        if(w.currentDocument.updateTime)assert.equal(versions.get(key),w.currentDocument.updateTime);
      }
      for(const w of body.writes){
        const key=w.update.name.slice(base.length),value=eventDecode({mapValue:{fields:w.update.fields}});
        set(key,w.updateMask?{...data.get(key),...value}:value);
      }
      if(body.transaction)transaction=null;result={};
    } else if(path===':batchGet') result=body.documents.map(name=>data.has(name.slice(base.length))
      ?{found:wire(name.slice(base.length))}:{missing:name});
    else if(path===':runQuery') assert.fail('preflight and saved-part reuse cannot rescan finite rows');
    else {
      const key=decodeURIComponent(path.slice(1).split('?')[0]);
      if(path.includes('?transaction=')){assert.ok(transaction);transaction.reads.set(key,versions.get(key));}
      result=data.has(key)?wire(key):null;
    }
    recordFirestoreReads(audit,path,init,result);return result;
  };
  const runtime=eventRuntime(request,{projectId:'test-project',now:()=>now});
  return {data,set,calls,audit,runtime,old,pages,time:value=>{now=value;},hook:value=>{hook=value;},
    retry:()=>{now=Math.max(now,...Object.values(data.get(cursor)?.retries||{}).map(v=>v.retryAt));},
    run:()=>publishEventCapacity(runtime,{coalescePeriods:true}),
    closed:()=>assert.equal(transaction,null),
    cost:()=>({reads:audit.documentReadEstimate,writes:audit.writeEstimate,requests:calls.length,
      rollingReads:calls.filter(c=>c.path.split('?')[0]==='/'+rollingKey||c.path.startsWith('/'+P+'/track_')).length})};
}
function measured(label,f) {console.log('EVENT_PREFLIGHT_COST '+JSON.stringify({version:baseline?'release292':'candidate',label,...f.cost()}));}

for(const gate of ['coalescing','changed','expired'])test('cheap '+gate+' gate avoids full Rolling Hills load; repeated turns retain work',async t=>{
  const f=await fixture(t,{gate}),oldJob=structuredClone(f.data.get(job));
  assert.equal((await f.run()).reason,{coalescing:'finite_totals_coalescing',changed:'finite_source_changed',expired:'snapshot_expired'}[gate]);
  assert.equal(f.data.get(job).restartRequired,gate!=='coalescing'?true:undefined);
  if(gate==='coalescing')assert.deepEqual(f.data.get(job),oldJob);
  measured(gate+'-first',f);
  assert.deepEqual(f.cost(),gate==='coalescing'
    ?{reads:baseline?18:5,writes:1,requests:baseline?20:7,rollingReads:baseline?13:0}
    :{reads:baseline?19:6,writes:2,requests:baseline?23:10,rollingReads:baseline?13:0});
  const before=f.cost(),checkpoint=structuredClone(f.data.get(cursor));
  for(let i=0;i<8;i++)assert.equal((await f.run()).reason,'publication_backoff');
  assert.equal(f.cost().reads-before.reads,16);assert.equal(f.cost().requests-before.requests,16);
  assert.equal(f.cost().writes,before.writes);assert.deepEqual(f.data.get(cursor),checkpoint);
  assert.deepEqual(f.data.get(C.public+'/totals_full'),f.old);assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
  assert.equal(f.calls.some(c=>c.path===':batchGet'||c.path===':runQuery'),false);f.closed();
});

test('coalesced deadline still reloads all pages and fails closed if a page became unavailable',async t=>{
  const f=await fixture(t,{gate:'coalescing'});
  assert.equal((await f.run()).reason,'finite_totals_coalescing');f.retry();
  const last=f.pages.documents.at(-1);f.data.delete(last.collection+'/'+last.id);
  const before=f.cost();assert.equal((await f.run()).reason,'permanent_source_unavailable');
  assert.equal(f.cost().rollingReads-before.rollingReads,13);
  assert.deepEqual(f.data.get(C.public+'/totals_full'),f.old);
  assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
  assert.equal(f.calls.some(c=>c.path===':batchGet'||c.path===':runQuery'),false);f.closed();
});

test('idle maintenance performs just its work-signal read',async t=>{
  const f=await fixture(t);f.set(C.public+'/totals',{publicationPending:false});
  assert.deepEqual(await f.run(),{idle:true});
  assert.deepEqual(f.cost(),{reads:1,writes:0,requests:1,rollingReads:0});measured('idle',f);f.closed();
});

for(const code of ['FIRESTORE_429','MOCK_JOB_READ_FAILED'])test('job read failure stops before the full source: '+code,async t=>{
  const f=await fixture(t),saved=structuredClone(f.data.get(job));
  f.hook(call=>{if(call.path==='/'+job)throw Error(code);});
  await assert.rejects(f.run(),new RegExp(code));measured(code,f);
  assert.deepEqual(f.cost(),{reads:null,writes:0,requests:baseline?17:4,rollingReads:baseline?13:0});
  assert.equal(f.audit.unknownReadRequests,1,'failed transport cost is unknown, not zero');
  assert.deepEqual(f.data.get(job),saved);assert.deepEqual(f.data.get(C.public+'/totals_full'),f.old);
  assert.equal(f.data.get(C.public+'/totals').publicationPending,true);assert.equal(f.data.has(cursor),false);
  f.hook(()=>{});assert.equal((await f.run()).published,true,'later invocation can recover without a cached failure');f.closed();
});

test('unavailable source stays pending with bounded backoff and recovers from fresh complete pages',async t=>{
  const f=await fixture(t,{unavailable:true}),root=rollingKey;
  assert.equal((await f.run()).reason,'permanent_source_unavailable');
  measured('unavailable-first',f);
  assert.deepEqual(f.cost(),{reads:baseline?5:6,writes:1,requests:baseline?7:8,rollingReads:1});
  assert.deepEqual(f.data.get(C.public+'/totals_full'),f.old);assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
  const before=f.cost();for(let i=0;i<8;i++)assert.equal((await f.run()).reason,'publication_backoff');
  assert.equal(f.cost().reads-before.reads,16);assert.equal(f.cost().writes,before.writes);
  const healthy=await fixture(t);f.set(root,healthy.data.get(root));f.retry();
  const recoverBefore=f.cost();assert.equal((await f.run()).published,true);
  assert.equal(f.cost().rollingReads-recoverBefore.rollingReads,14,'full root/pages plus final fresh root');
  assert.equal(f.data.get(C.public+'/totals_full').totalEntries,1137);
  assert.equal(f.data.get(C.public+'/totals').publicationPending,false);f.closed();
});

test('due healthy saved parts retain full source and final fences with unchanged request cost',async t=>{
  const f=await fixture(t);assert.equal((await f.run()).published,true);measured('healthy',f);
  assert.deepEqual(f.cost(),{reads:25,writes:18,requests:31,rollingReads:14});
  const all=await loadPublicationEntries(f.data.get(C.public+'/totals_full'),'event_totals','main',
    async(c,id)=>({data:f.data.get(c+'/'+id)}));
  assert.equal(all.length,1137);assert.equal(all.some(row=>row.accountId==='rolling-1135'),true);
  assert.equal(f.calls.some(c=>c.path.startsWith('/'+rollingKey+'?transaction=')),true);f.closed();
});

test('coordinated phase-2 uses the cheap gate rather than falling into inbox intake',{skip:!!baseline},async t=>{
  const f=await fixture(t,{gate:'coalescing'});
  const result=await eventWorkerMaintenance({EVENTS_ENABLED:'true',BACKGROUND_MAINTENANCE_MODE:'coordinated'},
    {request:f.runtime.request,officialIds:[],allIds:[],at:start,now:f.runtime.now});
  assert.equal(result.reason,'finite_totals_coalescing');
  assert.equal(f.cost().rollingReads,0);assert.equal(f.calls.some(c=>c.path===':runQuery'),false);f.closed();
});

test('retained 155-racer Rolling Hills size uses an inline source, not the 1136-row stress cost',async t=>{
  for(const gate of ['coalescing','changed','expired']){
    const f=await fixture(t,{gate,population:155});await f.run();measured('inline155-'+gate,f);
    assert.deepEqual(f.cost(),gate==='coalescing'
      ?{reads:baseline?6:5,writes:1,requests:baseline?8:7,rollingReads:baseline?1:0}
      :{reads:baseline?7:6,writes:2,requests:baseline?11:10,rollingReads:baseline?1:0});
    const before=f.cost();for(let i=0;i<8;i++)assert.equal((await f.run()).reason,'publication_backoff');
    assert.equal(f.cost().reads-before.reads,16);assert.equal(f.cost().writes,before.writes);f.closed();
  }
  const healthy=await fixture(t,{population:155});assert.equal((await healthy.run()).published,true);
  measured('inline155-healthy',healthy);
  assert.deepEqual(healthy.cost(),{reads:13,writes:8,requests:19,rollingReads:2});healthy.closed();
  const absent=await fixture(t,{population:155,unavailable:true});
  assert.equal((await absent.run()).reason,'permanent_source_unavailable');measured('inline155-unavailable',absent);
  assert.deepEqual(absent.cost(),{reads:baseline?5:6,writes:1,requests:baseline?7:8,rollingReads:1});absent.closed();
});

test('ten Rolling-only ERP updates reuse named finite parts with zero profile hydration or canonical scans',async t=>{
  const f=await fixture(t,{population:155,finitePopulation:1000});
  for(let i=0;i<10;i++){
    f.set(rollingKey,{...f.data.get(rollingKey),revision:i+2,sourceRevision:i+2,signature:'rolling_revision_'+(i+2)});
    f.set(C.public+'/totals',{...f.data.get(C.public+'/totals'),publicationPending:true});
    assert.equal((await f.run()).published,true);
    assert.equal(f.data.get(C.public+'/totals').revision,2,'Rolling-only changes do not increment finite revision');
    assert.equal(f.data.get(C.public+'/totals').publicationPending,false);
    assert.equal(f.data.get(C.public+'/totals_full').totalEntries,1155);
  }
  assert.equal(f.audit.collections[C.profiles]||0,0);assert.equal(f.audit.collections[C.totals]||0,0);
  assert.equal(f.audit.collections['0.6.2_event_publication_parts'],50,'five parts per generation, not 1000 profile joins');
  assert.equal(f.calls.some(c=>c.path===':runQuery'),false);
  measured('rolling-only-155-plus-1000-finite',f);f.closed();
});
