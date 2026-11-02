import test from 'node:test';
import assert from 'node:assert/strict';
import {publishEventCapacity} from '../src/event-publication.js';
import {eventRuntime} from '../src/events-runtime.js';
import {EVENT_COLLECTIONS as C,eventPeriod} from '../src/events.js';
import {eventEncode,eventDecode} from '../src/events-store.js';
import {createFirestoreAudit,recordFirestoreReads} from '../src/firestore-read-cost.js';
import {PERMANENT_ROLLING_HILLS as R} from '../src/permanent-rolling-hills.js';
import {PUBLIC_PAGE_COLLECTION,loadPublicationEntries} from '../src/paged-publication.js';
import {maintenanceWindowAllows} from '../src/index.js';

const start=Date.UTC(2026,10,1),base='projects/test-project/databases/(default)/documents/';
const jobs='0.6.2_event_publication_jobs',parts='0.6.2_event_publication_parts';
const cursor=C.cursors+'/public_capacity',jobPath=jobs+'/event_totals_main';
const old={entries:[{accountId:'old',name:'Old',rp:1,events:1}],builtAt:start-86400000};

// REST boundary mock runs the real Firestore adapter, coordinator, projections,
// page generator and final transaction. No credentials or network are involved.
function fixture() {
  const data=new Map(),audit=createFirestoreAudit(),calls=[];
  let now=start,nonce=0,transaction=null,staged=false,fail=true,attempts=0,transactionsAfterFailure=0;
  let stopped=false,beforeBegin=null;
  data.set(C.public+'/totals',{revision:1,publicationPending:true});
  data.set(C.public+'/totals_full',structuredClone(old));
  data.set(jobPath,{kind:'event_totals',id:'main',sourceRevision:1,generation:'saved',
    readTime:new Date(start-86400000).toISOString(),afterName:'last',parts:50,complete:true,scanComplete:true});
  for(let page=0;page<50;page++)data.set(parts+'/saved_'+page,{entries:Array.from({length:200},(_,i)=>({
    accountId:'racer-'+String(page*200+i).padStart(5,'0'),name:'Racer',rp:10000-page*200-i,events:1}))});
  data.set(R.collection+'/'+R.trackId,{trackId:R.trackId,algorithmVersion:R.algorithmVersion,
    schemaVersion:R.minimumSchemaVersion,revision:2,sourceRevision:2,signature:'rolling_revision_2',
    builtAt:start,updatedAt:start,complete:true,totalEntries:1,entries:[{accountId:'rolling',name:'Rolling',
      trackId:R.trackId,timeMs:10000,frames:10000,raceTimeFrames:10000,replayHash:'a'.repeat(64),
      runVerified:true,integrityVerified:true}]});
  const wire=key=>({name:base+key,fields:eventEncode(data.get(key)).mapValue.fields,updateTime:'v1'});
  const request=async(path,init={})=>{
    if(stopped){transactionsAfterFailure++;assert.fail('no work after budget failure');}
    calls.push(path);
    const body=init.body?JSON.parse(init.body):null;
    let result;
    if(path===':beginTransaction') {
      if(beforeBegin){const hook=beforeBegin;beforeBegin=null;hook(data);}
      if(staged&&fail){attempts++;staged=false;stopped=true;throw Error('MOCK_PRETRANSPORT_BUDGET_EXHAUSTED');}
      assert.equal(transaction,null);transaction='tx-'+(++nonce);result={transaction};
    } else if(path===':rollback') {assert.equal(body.transaction,transaction);transaction=null;result={};}
    else if(path===':batchGet') result=body.documents.map(name=>{
      const key=name.slice(base.length);return data.has(key)?{found:wire(key)}:{missing:name};
    });
    else if(path===':commit') {
      if(body.transaction)assert.equal(body.transaction,transaction);
      for(const w of body.writes){
        const key=(w.update?.name||w.delete).slice(base.length);
        if(w.delete)data.delete(key);
        else {
          const value=eventDecode({mapValue:{fields:w.update.fields}});
          data.set(key,w.updateMask?{...data.get(key),...value}:value);
          if(key.startsWith(PUBLIC_PAGE_COLLECTION+'/'))staged=true;
        }
      }
      if(body.transaction)transaction=null;
      result={};
    } else if(path===':runQuery') assert.fail('completed finite source must never be rescanned');
    else {
      assert.ok(path.startsWith('/'));
      const key=decodeURIComponent(path.slice(1).split('?')[0]);
      result=data.has(key)?wire(key):null;
    }
    recordFirestoreReads(audit,path,init,result);return result;
  };
  const runtime=eventRuntime(request,{projectId:'test-project',now:()=>now});
  return {data,audit,calls,runtime,attempts:()=>attempts,transactionsAfterFailure:()=>transactionsAfterFailure,
    fail:value=>{fail=value;},time:value=>{now=value;stopped=false;staged=false;},
    beforeBegin:hook=>{beforeBegin=hook;}};
}

for(const mode of ['continuous','coordinated'])test('completed-part staging failure has durable bounded cost: '+mode,async()=>{
  const f=fixture();let failed=0;
  for(let minute=0;minute<1440;minute++){
    const at=start+minute*60000;
    if(![2,4].includes(minute%5)||!maintenanceWindowAllows('* * * * *',at,mode))continue;
    f.time(at);
    try{assert.equal((await publishEventCapacity(f.runtime)).reason,'publication_backoff');}
    catch(error){assert.equal(error.message,'MOCK_PRETRANSPORT_BUDGET_EXHAUSTED');failed++;}
    assert.deepEqual(f.data.get(C.public+'/totals_full'),old);
    assert.equal(f.data.get(C.public+'/totals').publicationPending,true);
  }
  assert.equal(f.transactionsAfterFailure(),0);
  const measured={attempts:failed,reads:f.audit.documentReadEstimate,writes:f.audit.writeEstimate,
    deletes:f.audit.deleteEstimate,requests:f.calls.length};
  console.log('EVENT_REUSE_COST '+mode+' '+JSON.stringify(measured));
  assert.deepEqual(measured,mode==='continuous'
    ? {attempts:50,reads:3852,writes:5100,deletes:0,requests:1752}
    : {attempts:10,reads:684,writes:1020,deletes:0,requests:264});
  assert.equal(f.audit.collections[parts],failed*50);
  assert.equal(f.audit.writeCollections[PUBLIC_PAGE_COLLECTION].writes,failed*101);
  f.fail(false);f.time(start+86400000+1800000);
  const result=await publishEventCapacity(f.runtime);
  assert.equal(result.published,true);assert.equal(result.totalEntries,10001);
  assert.equal(f.data.get(C.public+'/totals').publicationPending,false);
  assert.equal(f.data.get(jobPath).complete,true);
  const all=await loadPublicationEntries(f.data.get(C.public+'/totals_full'),'event_totals','main',
    async(collection,id)=>({data:f.data.get(collection+'/'+id)}));
  assert.equal(all.length,10001);assert.equal(all[0].accountId,'racer-00000');
  assert.equal(f.data.get(cursor).retries,undefined);
});

test('completed-part reuse reserves before paid reads and cannot overwrite a winning coordinator',async()=>{
  const f=fixture(),winner={active:true,periodId:'winner',offset:3};
  f.beforeBegin(data=>data.set(cursor,winner));
  await assert.rejects(publishEventCapacity(f.runtime),error=>error.code==='event_publication_conflict');
  assert.deepEqual(f.data.get(cursor),winner);
  assert.equal(f.calls.includes(':batchGet'),false);
  assert.equal(f.audit.writeEstimate,0);
});

test('healthy completed-part reuse has bounded coordinator overhead and no finite rescan',async()=>{
  const f=fixture();f.fail(false);f.time(start+2*60000);
  assert.equal((await publishEventCapacity(f.runtime)).published,true);
  assert.deepEqual({reads:f.audit.documentReadEstimate,writes:f.audit.writeEstimate,
    deletes:f.audit.deleteEstimate,requests:f.calls.length},
    {reads:62,writes:107,deletes:0,requests:23});
  assert.equal(f.audit.collections[C.totals]||0,0);
  assert.equal(f.data.get(cursor).retries,undefined);
});

test('completed-part reuse starts no paid work if reservation is unavailable',async()=>{
  const f=fixture();
  f.runtime.store={transaction:async()=>{throw Error('RESERVATION_UNAVAILABLE');}};
  await assert.rejects(publishEventCapacity(f.runtime),/RESERVATION_UNAVAILABLE/);
  assert.equal(f.calls.includes(':batchGet'),false);
  assert.equal(f.audit.writeEstimate,0);
  assert.deepEqual(f.data.get(C.public+'/totals_full'),old);
});

test('unfinished terminal event checkpoint also reserves before saved-part reads',async()=>{
  const f=fixture(),id='terminal_event',eventJob=jobs+'/event_'+id;
  f.data.set(C.public+'/totals',{publicationPending:false,pendingPeriodIds:[id]});
  f.data.set(C.public+'/'+id,{publicationPending:true,revision:1,entries:[]});
  f.data.set(C.periods+'/'+id,eventPeriod({id,kind:'daily',enabled:true,trackId:'b'.repeat(64),
    startsAt:start-86400000,endsAt:start+86400000,graceMs:86400000,targetMs:10000,maxRp:100,
    eligibility:'best-submitted-during-period',capacity:{policyVersion:'test',entrants:200,
      admissionsPerPeriod:2048,replayBytesPerPeriod:16777216,minIntervalMs:5000,verificationsPerDay:1536}}));
  f.data.set(eventJob,{...f.data.get(jobPath),kind:'event',id,complete:false,
    readTime:new Date(start).toISOString(),parts:1});
  f.data.set(parts+'/saved_0',{entries:[{accountId:'c'.repeat(64),name:'Racer',timeMs:20000,submittedAt:start}]});
  f.data.delete(jobPath);
  f.time(start+2*60000);
  await assert.rejects(publishEventCapacity(f.runtime),/MOCK_PRETRANSPORT_BUDGET_EXHAUSTED/);
  assert.equal(f.data.get(cursor).retries['event_'+id].retryAt,start+7*60000);
  f.time(start+4*60000);
  assert.equal((await publishEventCapacity(f.runtime)).reason,'publication_backoff');
  assert.equal(f.audit.collections[parts],1);
  f.time(start+7*60000);f.fail(false);
  assert.equal((await publishEventCapacity(f.runtime)).published,true);
  assert.equal(f.data.get(C.public+'/'+id).entries[0].accountId,'c'.repeat(64));
  assert.deepEqual(f.data.get(C.public+'/totals').pendingPeriodIds,[]);
});
