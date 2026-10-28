import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const extract=name=>{
  const start=source.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));
  assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n  }',start)+4);
};
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
const path='/v1/events/test/snapshot';
function fixture(){
  const storage=new Map([['local-pb',{recording:'keep'}],['receipts',{accepted:true}]]),writes=[],timers=[];
  let ui=0,renders=0;
  const c=vm.createContext({Map,Promise,Date,URL,console,encodeURIComponent,
    eventCloudRequests:new Map(),eventCloudCache:new Map(),eventCloudRetryAt:new Map(),
    localEventSchedulePromise:null,localWeeklyCatalogRequest:null,localWeeklyCatalogUntil:0,localWeeklyCatalogIdentity:'',nativeWeeklySelection:null,
    eventTotalsSnapshot:null,eventTotalsRequest:null,eventTotalsState:{status:'idle',checkedAt:0},EVENT_TOTALS_CACHE_KEY:'totals',
    readJsonStorage:(key,fallback)=>storage.has(key)?storage.get(key):fallback,
    writeJsonStorage:(key,value)=>{writes.push([key,value]);storage.set(key,value);},
    cleanUserId:value=>value,sanitizeProfileCosmetics:value=>value,
    eventUi:{invalidateSnapshot:()=>{ui++;},refreshCatalog:()=>{ui++;}},overallCategory:'events',
    renderEntries:()=>{renders++;},updateRankedFreshness:()=>{},snapshotOnlyForNewAccount:()=>true,
    withTimeout:promise=>promise,noteFirebaseQuota:()=>assert.fail('stale work must not affect quota state'),log:()=>{},
    readPublicSnapshotBackup:async()=>null,rankedFetch:()=>assert.fail('unexpected live read'),
    rankedBrokerUrl:()=> 'https://worker.test',rankedWeeklyFetch:()=>{},eventRequestSignal:()=>undefined,
    eventsModuleUrl:'https://game.test/events/client.mjs?v=193',setTimeout:fn=>{timers.push(fn);},
    kodubAdapter:{loadKodubWeekly:async()=>({current:null}),withKodubWeekly:catalog=>catalog},
    scheduleModule:{scheduledCatalog:(_registry,published)=>published},fetch:async()=>({ok:true,json:async()=>({periods:[]})})
  });
  for(const name of ['invalidateEventSnapshotCaches','warmLocalWeeklyCatalog','localEventCatalog','chooseEventReadValue','eventCloudRead','loadEventCloudRead','readEventCatalog','eventIdentityPresentation','normalizeEventTotals','savedEventTotals','fetchEventTotals']){
    const code=extract(name).replace("import(new URL('./schedule.mjs',eventsModuleUrl).href)",'Promise.resolve(scheduleModule)');
    vm.runInContext(code,c);
  }
  return {c,storage,writes,timers,ui:()=>ui,renders:()=>renders};
}

test('generation hook resets only public event state and not local PBs or receipts',()=>{
  const h=fixture(),{c}=h;
  c.eventCloudCache.set(path,{value:{old:true}});c.eventCloudRequests.set(path,Promise.resolve());c.eventCloudRetryAt.set(path,999);
  c.localEventSchedulePromise=Promise.resolve();c.localWeeklyCatalogRequest=Promise.resolve();c.localWeeklyCatalogUntil=999;c.localWeeklyCatalogIdentity='old';
  c.eventTotalsSnapshot={updatedAt:1,entries:[]};c.eventTotalsRequest=Promise.resolve();h.storage.set('totals',c.eventTotalsSnapshot);
  c.invalidateEventSnapshotCaches();
  assert.equal(c.eventCloudCache.size+c.eventCloudRequests.size+c.eventCloudRetryAt.size,0);
  assert.equal(c.localEventSchedulePromise,null);assert.equal(c.localWeeklyCatalogRequest,null);assert.equal(c.localWeeklyCatalogUntil,0);assert.equal(c.localWeeklyCatalogIdentity,'');
  assert.equal(c.eventTotalsRequest,null);assert.equal(c.eventTotalsSnapshot,null);assert.equal(c.eventTotalsState.status,'idle');assert.equal(h.ui(),1);
  assert.deepEqual([...h.storage.keys()],['local-pb','receipts','totals']);assert.equal(h.storage.get('local-pb').recording,'keep');assert.equal(h.storage.get('receipts').accepted,true);
  assert.deepEqual(h.writes,[['totals',null]]);
  assert.match(source,/invalidateNativePartialReplay\(true\);\s*invalidateEventSnapshotCaches\(\);\s*metadataRecovery\.reset\(\)/);
});

for(const outcome of ['resolve','reject'])test(`old cloud ${outcome} cannot populate cache/retry or remove a replacement request`,async()=>{
  const {c}=fixture(),old=deferred(),fresh=deferred();let calls=0;
  c.loadEventCloudRead=()=>++calls===1?old.promise:fresh.promise;
  c.eventCloudCache.set(path,{value:{updatedAt:999,entries:[]},until:0});
  const retired=c.eventCloudRead(path,'events','test',true),rejected=assert.rejects(retired,/generation changed/);
  c.invalidateEventSnapshotCaches();const next=c.eventCloudRead(path,'events','test'),owned=c.eventCloudRequests.get(path);
  if(outcome==='resolve')old.resolve({updatedAt:999,entries:[]});else old.reject(Error('old failure'));
  await rejected;await turn();
  assert.equal(c.eventCloudRequests.get(path),owned);assert.equal(c.eventCloudCache.size,0);assert.equal(c.eventCloudRetryAt.size,0);
  fresh.resolve({updatedAt:1,entries:[]});await next;await turn();
  assert.equal(c.eventCloudCache.get(path).value.updatedAt,1);assert.equal(c.eventCloudRequests.size,0);assert.equal(calls,2);
});

for(const outcome of ['429','reject'])test(`retired live ${outcome} cannot write cooldown into new generation`,async()=>{
  const {c}=fixture(),gate=deferred();c.snapshotOnlyForNewAccount=()=>false;c.rankedFetch=()=>gate.promise;
  const pending=c.loadEventCloudRead(path,'events','test',true),rejected=assert.rejects(pending,/generation changed/);
  await turn();c.invalidateEventSnapshotCaches();
  c.eventCloudRetryAt.set('/new',123);
  if(outcome==='429')gate.resolve({status:429,headers:{get:()=> '900'}});else gate.reject(Error('offline'));
  await rejected;assert.equal(c.eventCloudRetryAt.size,1);assert.equal(c.eventCloudRetryAt.get('/new'),123);
});

for(const outcome of ['resolve','reject'])test(`old totals ${outcome} cannot overwrite persistence, state or replacement request`,async()=>{
  const h=fixture(),{c}=h,old=deferred(),fresh=deferred();let calls=0;
  c.readPublicSnapshotBackup=()=>++calls===1?old.promise:fresh.promise;
  const retired=c.fetchEventTotals();await turn();c.invalidateEventSnapshotCaches();
  const next=c.fetchEventTotals(),owned=c.eventTotalsRequest;await turn();const renders=h.renders();
  if(outcome==='resolve')old.resolve({updatedAt:999,entries:[]});else old.reject(Error('old totals failed'));
  assert.equal((await retired).length,0);assert.equal(c.eventTotalsRequest,owned);assert.equal(c.eventTotalsState.status,'loading');assert.equal(h.renders(),renders);
  assert.deepEqual(h.writes,[['totals',null]]);
  fresh.resolve({updatedAt:1,entries:[]});await next;
  assert.equal(c.eventTotalsSnapshot.updatedAt,1);assert.equal(h.storage.get('totals').updatedAt,1);assert.equal(c.eventTotalsRequest,null);
});

test('invalidated totals never rehydrate the old storage value even when persistence is unavailable',()=>{
  const h=fixture(),{c}=h;h.storage.set('totals',{updatedAt:999,entries:[]});c.writeJsonStorage=()=>false;
  assert.equal(c.savedEventTotals().updatedAt,999);c.invalidateEventSnapshotCaches();assert.equal(c.savedEventTotals(),null);
});

for(const outcome of ['resolve','reject'])test(`old catalog ${outcome} cannot reset the new catalog promise`,async()=>{
  const {c}=fixture(),old=deferred(),fresh=deferred();let calls=0;
  c.fetch=()=>++calls<=2?old.promise:fresh.promise;
  const retired=c.localEventCatalog(),rejected=assert.rejects(retired);c.invalidateEventSnapshotCaches();
  const next=c.localEventCatalog(),owned=c.localEventSchedulePromise;
  if(outcome==='resolve')old.resolve({ok:true,json:async()=>({periods:[{id:'old'}]})});else old.reject(Error('old catalog failed'));
  await rejected;assert.equal(c.localEventSchedulePromise,owned);
  fresh.resolve({ok:true,json:async()=>({periods:[{id:'new'}]})});assert.equal((await next).periods[0].id,'new');
});

test('old weekly feed completion and queued enrichment cannot mutate the new catalog',async()=>{
  const h=fixture(),{c}=h,old=deferred();c.kodubAdapter.loadKodubWeekly=()=>old.promise;
  const retired=c.warmLocalWeeklyCatalog();c.invalidateEventSnapshotCaches();
  c.localWeeklyCatalogUntil=123;c.nativeWeeklySelection={trackId:'new'};
  old.resolve({current:{trackId:'old',endTime:new Date(Date.now()+86400000).toISOString()}});await retired;
  assert.equal(c.nativeWeeklySelection.trackId,'new');assert.equal(c.localWeeklyCatalogUntil,123);
  c.localWeeklyCatalogUntil=0;c.localEventSchedulePromise=Promise.resolve();
  const current={trackId:'new',endTime:new Date(Date.now()+86400000).toISOString()};c.kodubAdapter.loadKodubWeekly=async()=>({current});
  await c.warmLocalWeeklyCatalog();assert.equal(h.timers.length,1);
  c.invalidateEventSnapshotCaches();c.nativeWeeklySelection=current;c.eventCloudCache.set('/v1/events/catalog',{value:'new'});
  h.timers[0]();await turn();assert.equal(c.eventCloudCache.get('/v1/events/catalog').value,'new');assert.equal(h.ui(),2);
});

test('optional UI invalidation may be absent or fail without interrupting data invalidation',async()=>{
  const {c}=fixture();c.eventUi={};c.invalidateEventSnapshotCaches();c.console={warn:()=>{}};
  for(const invalidateSnapshot of [()=>{throw Error('UI unavailable');},()=>Promise.reject(Error('UI unavailable'))]){
    c.eventUi={invalidateSnapshot};c.eventCloudCache.set(path,{});c.invalidateEventSnapshotCaches();assert.equal(c.eventCloudCache.size,0);
  }
  await turn();
});
