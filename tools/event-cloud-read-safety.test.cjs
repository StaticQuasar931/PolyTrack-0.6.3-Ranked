const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'../polytrack_062_patch.js'),'utf8');
const start=source.indexOf('  function chooseEventReadValue(');
const end=source.indexOf('  const archiveMonthReads=new Map();',start);
const edgeStart=source.indexOf('  let rankedEdgeState = (()=>{');
const edgeEnd=source.indexOf('  const jsonStorageCache=new Map();',edgeStart);
assert.ok(start>=0&&end>start,'production event cloud read functions exist');
assert.ok(edgeStart>=0&&edgeEnd>edgeStart,'production ranked edge availability tracker exists');

function harness({status=200,fetchError=null,backup=null,snapshotOnly=false}={}){
  let now=100000,workerCalls=0,firestoreReads=0,quotaNotes=0;
  const backupReads=[];
  const context={
    Date:{now:()=>now},Math,Number,Error,Promise,Map,JSON,Array,String,
    eventCloudRequests:new Map(),eventCloudCache:new Map(),eventCloudRetryAt:new Map(),
    eventRequestSignal:()=>({}),AbortSignal:{timeout:()=>({})},rankedBrokerUrl:()=> 'https://worker.test',
    fetch:async url=>{workerCalls++;if(fetchError)throw fetchError;const responseStatus=typeof status==='function'?status(String(url)):status;return {status:responseStatus,ok:responseStatus>=200&&responseStatus<300,headers:{get:name=>name==='Retry-After'?'120':'application/json'},json:async()=>({worker:true})};},
    RANKED_EDGE_STATE_KEY:'ranked-edge',RANKED_EDGE_BACKOFF_MS:300000,compatibilityOnlineAllowed:true,
    sessionStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},log:()=>{},noteFirebaseQuota:error=>{if(/resource-exhausted|quota/i.test(String(error?.code||'')+' '+String(error?.message||'')))quotaNotes++;},
    snapshotOnlyForNewAccount:()=>snapshotOnly,
    readPublicSnapshotBackup:async(kind,id)=>{backupReads.push({kind,id});return typeof backup==='function'?backup(kind,id):backup;},
    db:async()=>({collection:()=>({doc:()=>({get:async()=>{firestoreReads++;return {exists:true,data:()=>({firestore:true})};}})})}),
    eventsModuleUrl:'https://game.test/',localEventCatalog:async()=>{throw Error('not used');},
  };
  context.rankedFetch=context.fetch;
  vm.createContext(context);vm.runInContext(source.slice(edgeStart,edgeEnd),context);vm.runInContext(source.slice(start,end),context);
  return {context,backupReads,get workerCalls(){return workerCalls;},get firestoreReads(){return firestoreReads;},get quotaNotes(){return quotaNotes;},advance:ms=>{now+=ms;}};
}

test('event Worker 429 without backup sets cooldown and never reads Firestore or Firebase quota',async()=>{
  const h=harness({status:429});
  await assert.rejects(h.context.eventCloudRead('/v1/events/test/snapshot','events','test'),/rate limited/);
  assert.equal(h.workerCalls,1);assert.equal(h.firestoreReads,0);assert.equal(h.quotaNotes,0);
  assert.ok(h.context.eventCloudRetryAt.get('/v1/events/test/snapshot')>100000);
  await assert.rejects(h.context.eventCloudRead('/v1/events/test/snapshot','events','test'),/retry paused/);
  assert.equal(h.workerCalls,1,'cooldown suppresses another Worker request');
  assert.equal(h.firestoreReads,0);
});

test('event Worker 429 serves available public backup without Firestore',async()=>{
  const backup={periods:[{id:'event'}]};const h=harness({status:429,backup});
  const value=await h.context.eventCloudRead('/v1/events/test/snapshot','events','test',true);
  assert.deepEqual(JSON.parse(JSON.stringify(value)),{...backup,_publicBackup:true,_eventRefreshFailed:true});
  assert.equal(h.firestoreReads,0);assert.equal(h.quotaNotes,0);
});

test('event 429 leaves shared edge available for a different event path',async()=>{
  const h=harness({status:url=>url.endsWith('/path-a')?429:200});
  await assert.rejects(h.context.eventCloudRead('/path-a','events','a'),/rate limited/);
  assert.equal(h.context.rankedEdgeAvailable(),true,'429 must not poison shared edge availability');
  const value=await h.context.eventCloudRead('/path-b','events','b');
  assert.deepEqual(JSON.parse(JSON.stringify(value)),{worker:true,_eventLiveCheckedAt:100000});
  assert.equal(h.workerCalls,2);assert.equal(h.firestoreReads,0);
});

test('genuine Worker failure never falls through to direct Firestore',async()=>{
  const h=harness({fetchError:Error('network unavailable')});
  await assert.rejects(h.context.eventCloudRead('/v1/events/test/snapshot','events','test'),/not included in the current snapshot/);
  assert.equal(h.firestoreReads,0);assert.equal(h.quotaNotes,0);
});

for(const condition of ['blocked','limited'])test('Event RP totals use the correct static backup when Worker is '+condition,async()=>{
 const backup={updatedAt:100,entries:[{accountId:'racer',eventRp:400}]};
 const h=harness({fetchError:condition==='blocked'?Error('network unavailable'):null,status:condition==='limited'?429:200,backup:kind=>kind==='event-totals'?backup:null});
 const value=await h.context.eventCloudRead('/v1/events/totals','0.6.2_event_public','totals');
 assert.deepEqual(JSON.parse(JSON.stringify(value)),backup);
 assert.equal(h.workerCalls,0);
 assert.deepEqual(h.backupReads,[{kind:'event-totals',id:'totals'}]);
 assert.equal(h.firestoreReads,0,'existing static totals avoid a billable fallback read');
});
test('protected accounts use event totals snapshot without contacting either live service',async()=>{
 const backup={updatedAt:100,entries:[]};
 const h=harness({snapshotOnly:true,backup:kind=>kind==='event-totals'?backup:null});
 assert.deepEqual(await h.context.eventCloudRead('/v1/events/totals','0.6.2_event_public','totals'),backup);
 assert.equal(h.workerCalls,0);assert.equal(h.firestoreReads,0);
});


test('failed refresh and retry cooldown retain the last successful check without claiming success',async()=>{
 const h=harness();const route='/v1/events/test/snapshot';
 const first=await h.context.eventCloudRead(route,'events','test');assert.equal(first._eventLiveCheckedAt,100000);
 h.advance(300001);h.context.loadEventCloudRead=async()=>{throw Error('offline');};
 const failed=await h.context.eventCloudRead(route,'events','test');assert.equal(failed._eventRefreshFailed,true);assert.equal(failed._eventLiveCheckedAt,100000);
 const retry=await h.context.eventCloudRead(route,'events','test');assert.equal(retry._eventRefreshFailed,true);assert.equal(retry._eventLiveCheckedAt,100000);
 assert.equal(h.workerCalls,1);assert.equal(h.firestoreReads,0);
});

test('mature accounts read active event snapshots without Worker requests',async()=>{
 const backup={period:{id:'test',kind:'daily'},updatedAt:100,entries:[]};const h=harness({backup});
 assert.deepEqual(await h.context.eventCloudRead('/v1/events/test/snapshot','events','test'),backup);assert.equal(h.workerCalls,0);assert.equal(h.firestoreReads,0);
});
test('even an explicit refresh cannot turn a frozen archive into a live read',async()=>{
 const backup={period:{id:'test',kind:'kodub'},archived:true,updatedAt:100,entries:[]};const h=harness({backup});
 assert.deepEqual(await h.context.eventCloudRead('/v1/events/test/snapshot','events','test',true),backup);assert.equal(h.workerCalls,0);assert.equal(h.firestoreReads,0);
});
