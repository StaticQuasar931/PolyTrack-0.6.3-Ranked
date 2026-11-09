const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const source=fs.readFileSync(require('node:path').join(__dirname,'../polytrack_062_patch.js'),'utf8');
function fixture(){
  let now=1000,reads=0;
  const data=new Map([['tracks',JSON.stringify({entries:[1]})]]);
  const context={Map,Set,JSON,Date:{now:()=>now},TRACK_CACHE_KEY:'tracks',OVERALL_CACHE_KEY:'overall',TRACK_LEGACY_CACHE_KEY:'legacy-tracks',OVERALL_BETA_CACHE_KEY:'beta',OVERALL_LEGACY_CACHE_KEY:'legacy-overall',localStorage:{getItem:key=>{reads++;return data.get(key)??null;},setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)}};
  vm.createContext(context);
  const start=source.indexOf('  const jsonStorageCache=new Map();');
  const end=source.indexOf('  function readOverallSnapshotCache(){',start);
  assert(start>=0&&end>start);
  vm.runInContext(source.slice(start,end),context);
  return {context,data,reads:()=>reads,advance:ms=>now+=ms};
}
test('a card-render batch reads the large snapshot string once',()=>{
  const f=fixture(),first=f.context.readJsonStorage('tracks');
  for(let i=0;i<224;i++)assert.equal(f.context.readJsonStorage('tracks'),first);
  assert.equal(f.reads(),1);
});
test('external same-tab changes and removals are detected after the bounded 50ms window',()=>{
  const f=fixture();f.context.readJsonStorage('tracks');
  f.data.set('tracks','{"entries":[2]}');f.advance(50);
  assert.equal(f.context.readJsonStorage('tracks').entries[0],2);
  f.data.delete('tracks');f.advance(50);
  assert.equal(f.context.readJsonStorage('tracks',null),null);
});
test('snapshot writes update memory immediately without another storage read',()=>{
  const f=fixture();f.context.readJsonStorage('tracks');
  const next={entries:[3]};assert.equal(f.context.writeJsonStorage('tracks',next),true);
  assert.equal(f.context.readJsonStorage('tracks'),next);assert.equal(f.reads(),1);
});
test('storage-event invalidation bypasses the read window',()=>{
  const f=fixture();f.context.readJsonStorage('tracks');f.data.set('tracks','{"entries":[4]}');
  vm.runInContext("jsonStorageCache.delete('tracks')",f.context);
  assert.equal(f.context.readJsonStorage('tracks').entries[0],4);
  assert.match(source,/if\(event\.key===null\)\{jsonStorageCache\.clear\(\);volatileLeaderboardCache\.clear\(\);\}else\{jsonStorageCache\.delete\(event\.key\);volatileLeaderboardCache\.delete\(event\.key\);\}/);
});
test('non-snapshot settings still see direct writes immediately',()=>{
  const f=fixture();f.data.set('settings','{"on":false}');f.context.readJsonStorage('settings');
  f.data.set('settings','{"on":true}');assert.equal(f.context.readJsonStorage('settings').on,true);
});

test('a backwards clock change cannot prolong the short cache window',()=>{
  const f=fixture();f.context.readJsonStorage('tracks');f.data.set('tracks','{"entries":[5]}');f.advance(-100);
  assert.equal(f.context.readJsonStorage('tracks').entries[0],5);
});

test('oversized derived boards stay available in memory without consuming track storage',()=>{
 const f=fixture(),next={entries:[],padding:'x'.repeat(262145)};
 assert.equal(f.context.writeJsonStorage('tracks',next),true);assert.equal(f.data.has('tracks'),true);assert.equal(JSON.parse(f.data.get('tracks')).entries[0],1);
 assert.equal(f.context.readJsonStorage('tracks'),next);
 const small={entries:[6]};assert.equal(f.context.writeJsonStorage('tracks',small),true);assert.equal(f.context.readJsonStorage('tracks'),small);
});
test('a quota-failed cache write keeps the newer board rather than an older persisted copy',()=>{
 const f=fixture(),next={entries:[9]};f.context.localStorage.setItem=()=>{throw Object.assign(Error('full'),{name:'QuotaExceededError'});};
 assert.equal(f.context.writeJsonStorage('tracks',next),true);assert.equal(f.context.readJsonStorage('tracks'),next);
 assert.equal(f.context.writeJsonStorage('settings',{on:true}),false);
});

test('the IndexedDB facade supplies moved caches without using localStorage capacity',()=>{
 const f=fixture(),idb=new Map([['tracks',JSON.stringify({entries:[7]})]]);
 f.context.window={__ptRankedDataStorage:{getItem:key=>idb.get(key)??null,setItem:(key,value)=>idb.set(key,value)}};
 assert.equal(f.context.readJsonStorage('tracks').entries[0],7);
 const next={entries:[8],padding:'x'.repeat(300000)};
 assert.equal(f.context.writeJsonStorage('tracks',next),true);
 assert.equal(JSON.parse(idb.get('tracks')).entries[0],8);
 assert.equal(JSON.parse(f.data.get('tracks')).entries[0],1);
 assert.equal(f.context.readJsonStorage('tracks'),next);
});

test('pending PB and replay stores are never included in the cache migration integration',()=>{
 assert.match(source,/storage=typeof window==='object'&&window\.__ptRankedDataStorage\|\|localStorage/);
 const recording=source.slice(source.indexOf('  function writeRecordingStore('),source.indexOf('  function readRecordingStore('));
 assert.match(recording,/localStorage\.setItem\(RECORDING_STORE_KEY/);
});
test('unchanged racer names reuse the parsed cache and do not rewrite the large name directory',()=>{
 const f=fixture(),key='polytrack-0.6.2-profile-last-names-v1';f.data.set(key,JSON.stringify({racer:'Known Racer'}));
 let writes=0;f.context.safeDisplayName=x=>x;f.context.localStorage.setItem=(k,v)=>{writes++;f.data.set(k,v);};
 for(const name of ['getLastKnownName','setLastKnownName']){
  const begin=source.indexOf('  function '+name+'('),end=source.indexOf('\n  }',begin)+4;
  vm.runInContext(source.slice(begin,end),f.context);
 }
 for(let i=0;i<1000;i++){assert.equal(f.context.getLastKnownName('racer'),'Known Racer');f.context.setLastKnownName('racer','Known Racer');}
 assert.equal(writes,0);f.context.setLastKnownName('racer','New Name');assert.equal(writes,1);
 assert.equal(f.context.getLastKnownName('racer'),'New Name');
});