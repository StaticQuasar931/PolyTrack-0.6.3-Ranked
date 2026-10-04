const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(path.join(__dirname,'..','polytrack_062_patch.js'),'utf8');
function extract(name){
  const start=source.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));
  assert.ok(start>=0,name);const body=source.indexOf('{',start);let depth=0;
  for(let i=body;i<source.length;i++){if(source[i]==='{')depth++;else if(source[i]==='}'&&--depth===0)return source.slice(start,i+1);}
  throw Error('Unclosed function '+name);
}
test('normal and forced track refreshes cannot bulk-query canonical races',()=>{
  const body=extract('loadTrackEntries');assert.doesNotMatch(body,/fetchCanonicalTrackEntries|COLLECTIONS\.raceResults/);
  assert.match(body,/if\(derivedSnapshot\)/);assert.doesNotMatch(body,/derivedSnapshot&&!forceCloud/);
  assert.match(body,/refreshThrottled/);assert.doesNotMatch(body,/!forceCloud&&Date\.now\(\)<Number\(trackCloudRetryAt/);
});
test('simultaneous track requests share one load and preserve caller limits',async()=>{
  let loads=0,finish;const ctx={trackEntryRequests:new Map(),loadTrackEntries:()=>{loads++;return new Promise(resolve=>{finish=resolve;});}};
  vm.createContext(ctx);vm.runInContext(extract('getTrackEntries'),ctx);
  const a=ctx.getTrackEntries('track',1),b=ctx.getTrackEntries('track',2,true);assert.equal(loads,1);
  finish([1,2,3]);assert.deepEqual(Array.from(await a),[1]);assert.deepEqual(Array.from(await b),[1,2]);
  await Promise.resolve();assert.equal(ctx.trackEntryRequests.size,0);
});
test('track fallbacks share a local race index and store writes invalidate it',()=>{
  let reads=0;const rows=[{trackId:'a',timeMs:100},{trackId:'b',timeMs:200}];
  const ctx={localRaceGeneration:0,localRaceTrackIndex:null,localRaceTrackIndexGeneration:-1,
    readLocalRaceRows:()=>{reads++;return rows;}};
  vm.createContext(ctx);vm.runInContext(extract('localRaceRowsForTrack'),ctx);vm.runInContext(extract('writeLocalRaceRows'),ctx);
  assert.deepEqual(Array.from(ctx.localRaceRowsForTrack('a')),[rows[0]]);
  assert.deepEqual(Array.from(ctx.localRaceRowsForTrack('b')),[rows[1]]);
  assert.equal(reads,1);
  rows.push({trackId:'a',timeMs:90});ctx.localRaceGeneration++;
  assert.equal(ctx.localRaceRowsForTrack('a').length,2);assert.equal(reads,2);
  assert.match(source,/LOCAL_RACE_STORE_KEY\)localRaceGeneration\+\+/);
  assert.match(extract('writeLocalRaceRows'),/if\(writeJsonStorage\(LOCAL_RACE_STORE_KEY,canonical\.slice\(0,5000\)\)\)localRaceGeneration\+\+/);
  assert.equal((extract('writeLocalRaceRows').match(/localRaceGeneration\+\+/g)||[]).length,1);
  assert.match(extract('loadTrackEntries'),/localRaceRowsForTrack\(trackId\)/);
  assert.match(extract('reconcileTrackEntriesWithLocal'),/localRaceRowsForTrack\(id\)/);
});

test('simultaneous Overall refreshes share the pending result instead of returning stale data',async()=>{
  let calls=0,finish;const ctx={overallEntryRequest:null,loadOverallEntries:()=>{calls++;return new Promise(resolve=>{finish=resolve;});}};
  vm.createContext(ctx);vm.runInContext(extract('fetchOverallEntries'),ctx);
  const a=ctx.fetchOverallEntries(true),b=ctx.fetchOverallEntries(true);assert.equal(calls,1);
  finish(['current']);assert.deepEqual(Array.from(await a),['current']);assert.deepEqual(Array.from(await b),['current']);
});
test('quota cooldown persists across callers and does not perpetually extend itself',()=>{
  let time=10000,expiry=0;const ctx={Date:{now:()=>time},FIREBASE_QUOTA_PAUSE_KEY:'quota',readJsonStorage:()=>expiry,writeJsonStorage:(_k,v)=>{expiry=v;}};
  vm.createContext(ctx);vm.runInContext(extract('firebaseQuotaPaused')+'\n'+extract('noteFirebaseQuota'),ctx);
  ctx.noteFirebaseQuota({code:'resource-exhausted'});assert.equal(ctx.firebaseQuotaPaused(),true);const first=expiry;
  time+=1000;ctx.noteFirebaseQuota({code:'local-quota-cooldown',message:'quota cooldown'});assert.equal(expiry,first);
  time=first+1;assert.equal(ctx.firebaseQuotaPaused(),false);
});
test('PB transaction attempts are bounded and failed PBs are not confirmed',()=>{
  assert.match(extract('mirrorRaceResult'),/maxAttempts:1/);
  assert.match(extract('reconcileLocalPersonalBestsToCloud'),/retryAt:Date\.now\(\)\+5\*60\*1000/);
});
test('opening Ranked and entering a locally loaded event do not crawl profiles or require Firebase',()=>{
  assert.doesNotMatch(extract('openPanel'),/syncCosmeticDirectory\(/);
  assert.match(source,/require:__pt062WebpackRequire,ready:async\(\)=>\{\},openTrack/);
});
test('public event requests share one fetch and reuse their bounded cache',async()=>{
  let loads=0;const ctx={Map,Date,eventCloudCache:new Map(),eventCloudRequests:new Map(),eventCloudRetryAt:new Map(),noteFirebaseQuota:()=>{},loadEventCloudRead:async()=>{loads++;return {updatedAt:1,entries:[]};}};
  vm.createContext(ctx);vm.runInContext(extract('eventCloudRead'),ctx);
  const [a,b]=await Promise.all([ctx.eventCloudRead('/snapshot','public','id'),ctx.eventCloudRead('/snapshot','public','id')]);
  assert.equal(loads,1);assert.equal(a,b);await ctx.eventCloudRead('/snapshot','public','id');assert.equal(loads,1);
});

test('assignment cache expires at the actual event reset and local assignment is tried before live services',async()=>{
  const at=Date.now(),cache=new Map();
  const ctx={Map,Date,eventCloudCache:cache,eventCloudRequests:new Map(),eventCloudRetryAt:new Map(),noteFirebaseQuota:()=>{},
    loadEventCloudRead:async()=>({periods:[{endsAt:at+20000},{endsAt:at+100000}]})};
  vm.createContext(ctx);vm.runInContext(extract('eventCloudRead'),ctx);
  await ctx.eventCloudRead('/v1/events/catalog','public','catalog');
  assert.ok(Math.abs(cache.get('/v1/events/catalog').until-(at+20000))<10);
  const body=extract('loadEventCloudRead');assert.ok(body.indexOf('localEventCatalog()')<body.indexOf('rankedEdgeAvailable()'));
});
test('best result fallback excludes fields with fewer than five racers',()=>{
  const ctx={normalizedFinishSamples:()=>[],knownFinishWeight:()=>1,rankedPlacementCost:()=>0};
  vm.createContext(ctx);vm.runInContext(extract('bestTrackMarkup'),ctx);
  const result=ctx.bestTrackMarkup({bestTracks:[{trackId:'solo',rank:1,fieldSize:2}],bestTrackId:'solo',bestTrackRank:1,bestTrackField:2});
  assert.match(result,/at least 5/);assert.doesNotMatch(result,/#1/);
});
