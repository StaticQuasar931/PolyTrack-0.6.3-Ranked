import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('  async function snapshot('),source.indexOf('  function updateEventRefreshControl('));
function fixture(readSnapshot,readArchivedSnapshot,snapshotOnly=false){
 const cache=new Map(),snapshotFetching=new Map(),snapshotAttempts=new Map(),saved=new Map();let at=1000000;
 const context={cache,snapshotFetching,snapshotAttempts,catalog:{periods:[]},read:(k,v)=>saved.get(k)??v,cacheWrite:(k,v)=>saved.set(k,v),STORE:'test',now:()=>at,bridge:{readSnapshot,readArchivedSnapshot,snapshotOnly:()=>snapshotOnly}};
 return {cache,snapshotFetching,snapshotAttempts,saved,advance:ms=>{at+=ms;},run:vm.runInNewContext('('+fn+')',context)};
}
const period={id:'p',trackId:'a'.repeat(64)};
const board=at=>({period,entries:[{accountId:'b'.repeat(64),timeMs:20000,rank:1,rp:100}],updatedAt:at});
test('complete event snapshot replaces atomically without merging entries',async()=>{const f=fixture(async()=>board(20));f.cache.set('p',{...board(10),entries:[{old:true}],fetchedAt:1});const out=await f.run(period,true);assert.equal(out.updatedAt,20);assert.equal(out.entries.length,1);assert.equal(out.entries[0].old,undefined);});
test('concurrent forced and ordinary reads share one cloud request',async()=>{
 let calls=0,release;const f=fixture(()=>{calls++;return new Promise(resolve=>{release=()=>resolve(board(20));});});
 const first=f.run(period,true),second=f.run(period,false);await Promise.resolve();assert.equal(calls,1);
 release();const [a,b]=await Promise.all([first,second]);assert.equal(a,b);assert.equal(f.cache.get('p'),a);assert.equal(f.snapshotFetching.size,0);
});
test('older delayed event response cannot replace a newer cached board',async()=>{const f=fixture(async()=>board(10));const newer={...board(20),fetchedAt:1};f.cache.set('p',newer);assert.equal(await f.run(period,true),newer);assert.equal(f.cache.get('p'),newer);});
test('offline event read preserves a complete saved board',async()=>{const f=fixture(async()=>{throw Error('offline');});f.saved.set('test-p',{...board(20),fetchedAt:1});const result=await f.run(period,true);assert.equal(result.saved,true);assert.equal(result.updatedAt,20);});
test('another track or malformed partial response cannot replace saved data',async()=>{for(const value of [{period,updatedAt:30},{...board(30),period:{...period,trackId:'c'.repeat(64)}}]){const f=fixture(async()=>value);f.cache.set('p',{...board(20),fetchedAt:1});assert.equal((await f.run(period,true)).updatedAt,20);assert.equal(f.cache.get('p').updatedAt,20);}});
test('wrong-period cache on the same track is rejected on fresh and offline paths',async()=>{
 for(const force of [false,true])for(const wrong of [{...period,id:'weekly-other'},{...period,kind:'weekly'}]){
  const f=fixture(async()=>{throw Error('offline');});f.cache.set('p',{...board(20),period:wrong,fetchedAt:1000000});
  await assert.rejects(f.run(period,force),/offline/);
 }
});

const receiptSource=source.slice(source.indexOf('  function receiptText('),source.indexOf('  function rows('));
const receiptText=vm.runInNewContext('('+receiptSource+')');
test('an older verified receipt cannot approve the newer local event attempt',()=>{assert.match(receiptText({attemptId:'old',timeMs:22000,status:'verified'},{attemptId:'new',timeMs:21000}),/Waiting/);});
test('mismatch and incomplete verification have explicit non-award explanations',()=>{assert.match(receiptText({status:'mismatch'},null),/No points/);assert.match(receiptText({status:'unavailable_final'},null),/No points/);});
test('verification does not claim points were awarded',()=>{assert.equal(receiptText({status:'verified',eventImproved:false},null),'Run verified. Event points unchanged.');assert.equal(receiptText({status:'verified',eventImproved:true},null),'Run verified. Event PB saved.');assert.equal(receiptText({status:'verified'},null),'Run verified.');});
test('rejected owner receipt explains the server capacity reason',()=>{assert.match(receiptText({status:'rejected',reason:'event_entrant_capacity'},null),/event is full/);assert.match(receiptText({status:'rejected',reason:'event_admission_capacity'},null),/submission limit/);assert.match(receiptText({status:'rejected',reason:'unrecognized'},null),/could not be scored/);});


test('repeated forced event refreshes share a one-minute cooldown',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return board(20);});
 await f.run(period,true);await f.run(period,true);f.advance(59999);await f.run(period,true);assert.equal(calls,1);
 f.advance(1);await f.run(period,true);assert.equal(calls,2);
});

test('failed event refreshes retain their data without retrying on every reopen',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;throw Error('offline');});f.saved.set('test-p',{...board(20),fetchedAt:1});
 await f.run(period,true);await f.run(period,true);await f.run(period);assert.equal(calls,1);
 f.advance(120000);await f.run(period,true);assert.equal(calls,2);
});

test('failed event requests without saved data also back off',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;throw Error('offline');});
 await assert.rejects(f.run(period,true),/offline/);await assert.rejects(f.run(period,true),/offline/);assert.equal(calls,1);
});

test('older successful event responses cannot cause an immediate refetch loop',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return board(10);});f.cache.set('p',{...board(20),fetchedAt:1});
 await f.run(period,true);await f.run(period,true);assert.equal(calls,1);assert.equal(f.cache.get('p').updatedAt,20);
});



test('a flagged fallback preserves failure state even when the newer cached board wins',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;return {...board(10),_publicBackup:true,_eventRefreshFailed:true};});f.cache.set('p',{...board(20),fetchedAt:1});
 const result=await f.run(period,true);assert.equal(result.updatedAt,20);assert.ok(f.snapshotAttempts.get('p').error);
 f.advance(60000);await f.run(period,true);assert.equal(calls,1);
 f.advance(60000);await f.run(period,true);assert.equal(calls,2);
});

test('finalized archive reads only the saved static snapshot and reuses it permanently',async()=>{
 let live=0,staticReads=0;
 const f=fixture(async()=>{live++;throw Error('Live service must not be called');},async()=>{staticReads++;return {...board(20),archived:true};});
 const archived={...period,archived:true};
 const [first,second]=await Promise.all([f.run(archived),f.run(archived)]);
 assert.equal(first,second);assert.equal(first.archived,true);
 f.advance(86400000);assert.equal(await f.run(archived,true),first);
 assert.equal(staticReads,1);assert.equal(live,0);
});

test('missing or malformed static archive never falls through to live reads',async()=>{
 for(const staticRead of [undefined,async()=>null,async()=>({period,updatedAt:20}),
  async()=>({...board(20),period:{...period,id:'wrong-event'}}),
  async()=>({...board(20),period:{...period,trackId:'c'.repeat(64)}}),
  async()=>({...board(20),period:{...period,kind:'weekly'}})]){
  let live=0;const f=fixture(async()=>{live++;return board(30);},staticRead);
  await assert.rejects(f.run({...period,archived:true}),/archive/i);
  assert.equal(live,0);
 }
});

test('bound static non-final and partial archives preserve uncertainty without borrowing live data or finality',async()=>{
 for(const source of [board(20),{...board(20),archived:false},
  {...board(20),archived:true,complete:false,totalEntries:2},
  {...board(20),archived:true,sourceComplete:false}]){
  let staticReads=0;
  const f=fixture(()=>assert.fail('No live request'),async()=>{staticReads++;return source;},true);
  const result=await f.run({...period,archived:true});
  assert.equal(staticReads,1);
  for(const key of ['archived','complete','sourceComplete','totalEntries']){
   assert.equal(result[key],source[key],key);
   assert.equal(Object.hasOwn(result,key),Object.hasOwn(source,key),key+' must not be invented');
  }
  assert.equal(result.entries,source.entries);
  assert.equal(f.cache.get(period.id),result);
 }
});

test('cached finalized archive does not refresh through the live service',async()=>{
 let live=0;const f=fixture(async()=>{live++;return board(30);});
 const saved={...board(20),archived:true,fetchedAt:1};f.cache.set(period.id,saved);
 assert.equal(await f.run(period,true),saved);assert.equal(live,0);
});


test('snapshot-only reopening replaces persisted live data once then reuses this package',async()=>{
 let reads=0;const f=fixture(async()=>{reads++;return {...board(10),_dataSource:'snapshot',_snapshotPackageAt:50};},undefined,true);
 f.saved.set('test-p',{...board(999),fetchedAt:1000000,_eventLiveCheckedAt:1000000});
 const first=await f.run(period);assert.equal(first.updatedAt,10);assert.equal(first._snapshotPackageAt,50);
 for(let i=0;i<5;i++)assert.equal(await f.run(period),first);assert.equal(reads,1);
});
test('persisted archives are rebound to this snapshot once without using live endpoints',async()=>{
 let reads=0;const f=fixture(()=>assert.fail('No live request'),async()=>{reads++;return {...board(10),archived:true,_snapshotPackageAt:50};},true);
 f.saved.set('test-p',{...board(999),archived:true,fetchedAt:1000000});
 const first=await f.run({...period,archived:true});assert.equal(first.updatedAt,10);assert.equal(first._snapshotPackageAt,50);
 assert.equal(await f.run({...period,archived:true},true),first);assert.equal(reads,1);
});
test('a missing current archive does not silently claim an old stored board is current',async()=>{
 const f=fixture(()=>assert.fail('No live request'),async()=>null,true);f.saved.set('test-p',{...board(999),archived:true});
 await assert.rejects(f.run({...period,archived:true}),/Invalid saved archive/);
 assert.equal(f.cache.has(period.id),false,'missing current package must not rebind the old stored board');
 assert.equal(f.saved.get('test-p').updatedAt,999,'failed read does not overwrite stored evidence');
});

test('production archive bridge keeps bound ended captures nonfinal and rejects wrong identities',async()=>{
 const patch=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
 const start=patch.indexOf('readArchivedSnapshot:async id=>{'),end=patch.indexOf('        readArchivedReplay:',start);
 assert.ok(start>0&&end>start);
 const body=patch.slice(start+'readArchivedSnapshot:'.length,end).trim().replace(/,$/,'');
 let value;const reads=[];
 const read=vm.runInNewContext('('+body+')',{Date:{now:()=>1000},Number,Array,readPublicSnapshotBackup:async(...args)=>{reads.push(args);return value;}});
 const saved={id:'old',period:{id:'old',trackId:'a'.repeat(64),endsAt:999},entries:[],archived:false,complete:false};
 value=saved;assert.equal(await read('old'),saved);assert.equal(saved.archived,false);assert.equal(saved.complete,false);
 for(const invalid of [{...saved,id:'different'},{...saved,period:{...saved.period,id:'different'}},{...saved,period:{...saved.period,trackId:'bad'}},{...saved,entries:null},{...saved,period:{...saved.period,endsAt:1001}}]){value=invalid;assert.equal(await read('old'),null);}
 const before=reads.length;assert.equal(await read('../wrong'),null);assert.equal(reads.length,before);
 assert.ok(reads.every(([kind,id])=>kind==='event'&&id==='old'));
});
