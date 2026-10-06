const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

const source=fs.readFileSync(path.join(__dirname,'../polytrack_062_patch.js'),'utf8');
const start=source.indexOf('  async function eventCloudRead(path,collection,id){');
const end=source.indexOf('  const archiveMonthReads=new Map();',start);
const edgeStart=source.indexOf('  let rankedEdgeState = (()=>{');
const edgeEnd=source.indexOf('  const jsonStorageCache=new Map();',edgeStart);
assert.ok(start>=0&&end>start,'production event cloud read functions exist');
assert.ok(edgeStart>=0&&edgeEnd>edgeStart,'production ranked edge availability tracker exists');

function harness({status=200,fetchError=null,backup=null}={}){
  let now=100000,workerCalls=0,firestoreReads=0,quotaNotes=0;
  const context={
    Date:{now:()=>now},Math,Number,Error,Promise,Map,JSON,Array,String,
    eventCloudRequests:new Map(),eventCloudCache:new Map(),eventCloudRetryAt:new Map(),
    AbortSignal:{timeout:()=>({})},rankedBrokerUrl:()=> 'https://worker.test',
    fetch:async url=>{workerCalls++;if(fetchError)throw fetchError;const responseStatus=typeof status==='function'?status(String(url)):status;return {status:responseStatus,ok:responseStatus>=200&&responseStatus<300,headers:{get:name=>name==='Retry-After'?'120':'application/json'},json:async()=>({worker:true})};},
    RANKED_EDGE_STATE_KEY:'ranked-edge',RANKED_EDGE_BACKOFF_MS:300000,
    sessionStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},log:()=>{},noteFirebaseQuota:()=>{quotaNotes++;},
    readPublicSnapshotBackup:async()=>backup,
    db:async()=>({collection:()=>({doc:()=>({get:async()=>{firestoreReads++;return {exists:true,data:()=>({firestore:true})};}})})}),
    eventsModuleUrl:'https://game.test/',localEventCatalog:async()=>{throw Error('not used');},
  };
  vm.createContext(context);vm.runInContext(source.slice(edgeStart,edgeEnd),context);vm.runInContext(source.slice(start,end),context);
  return {context,get workerCalls(){return workerCalls;},get firestoreReads(){return firestoreReads;},get quotaNotes(){return quotaNotes;},advance:ms=>{now+=ms;}};
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
  const value=await h.context.eventCloudRead('/v1/events/test/snapshot','events','test');
  assert.deepEqual(JSON.parse(JSON.stringify(value)),backup);
  assert.equal(h.firestoreReads,0);assert.equal(h.quotaNotes,0);
});

test('event 429 leaves shared edge available for a different event path',async()=>{
  const h=harness({status:url=>url.endsWith('/path-a')?429:200});
  await assert.rejects(h.context.eventCloudRead('/path-a','events','a'),/rate limited/);
  assert.equal(h.context.rankedEdgeAvailable(),true,'429 must not poison shared edge availability');
  const value=await h.context.eventCloudRead('/path-b','events','b');
  assert.deepEqual(JSON.parse(JSON.stringify(value)),{worker:true});
  assert.equal(h.workerCalls,2);assert.equal(h.firestoreReads,0);
});

test('genuine Worker fetch failure retains direct Firestore fallback',async()=>{
  const h=harness({fetchError:Error('network unavailable')});
  const value=await h.context.eventCloudRead('/v1/events/test/snapshot','events','test');
  assert.deepEqual(JSON.parse(JSON.stringify(value)),{firestore:true});
  assert.equal(h.firestoreReads,1);assert.equal(h.quotaNotes,0);
});
