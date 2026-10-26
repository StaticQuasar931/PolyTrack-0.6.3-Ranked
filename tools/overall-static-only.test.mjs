import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
function fn(name){const start=source.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));assert.ok(start>=0,name);return source.slice(start,source.indexOf('\n  }',start)+4);}

for(const refresh of [false,true])for(const saved of [null,{entries:[]}])test(`Overall is static-only with refresh=${refresh} and package=${Boolean(saved)}`,async()=>{
  let reads=0;
  const context=vm.createContext({readPublicSnapshotBackup:async(kind,id,account,options)=>{reads++;assert.equal(kind,'overall');assert.equal(options.refresh,refresh);return saved;},
    snapshotOnlyForNewAccount:()=>false,rankedBrokerUrl:()=>assert.fail('Worker resolved'),fetch:()=>assert.fail('Live request')});
  vm.runInContext(fn('fetchRankedSnapshot'),context);
  assert.equal(await context.fetchRankedSnapshot('overall','',{refresh}),saved);assert.equal(reads,1);
});

function loaderFixture({cached=null,packageValue=null,detail=null}={}){
  const calls=[],writes=[];
  const context=vm.createContext({Date,Error,Number,String,Array,Map,Boolean,Math,console:{warn(){}},
    TOTAL_TRACKS:500,MIN_RANKED_TRACKS:3,cleanUserId:id=>String(id||''),OVERALL_REFRESH_CHECK_MS:600000,AVERAGE_PLACEMENT_VERSION:2,AVERAGE_FINISH_VERSION:2,
    TRACK_CACHE_SCHEMA:6,RANK_MODEL:'test-model',overallCloudCheckedAt:0,overallCloudRetryAt:0,overallTrackSummariesCache:[],
    readOverallSnapshotCache:()=>cached,annotateOverallMovement:rows=>rows,normalizeEntries:rows=>rows,
    fetchRankedSnapshot:async(...args)=>{calls.push(args);return packageValue;},
    readPublicSnapshotBackup:async kind=>{calls.push([kind]);return detail;},
    expandRankedResults:async data=>data.entries,writeOverallSnapshotCache:(...args)=>writes.push(args),
    readDirectPublicSnapshot:()=>assert.fail('Firestore read'),fetch:()=>assert.fail('API request'),
    noteFirebaseQuota:()=>{},log:()=>{}});
  vm.runInContext(fn('publishedOverallRanksExact')+fn('loadOverallEntries'),context);
  return {context,calls,writes};
}
test('missing Overall package preserves saved standings without cloud fallback',async()=>{
  const rows=[{userId:'saved'}];const f=loaderFixture({cached:{entries:rows,fetchedAt:1,signature:'old',sourceRevision:5}});
  assert.equal(await f.context.loadOverallEntries(),rows);assert.equal(f.context.overallLoadState.status,'stale');assert.equal(f.writes.length,0);
});
test('missing Overall package with no cache gives an explicit error without cloud fallback',async()=>{
  const f=loaderFixture();assert.equal((await f.context.loadOverallEntries()).length,0);assert.equal(f.context.overallLoadState.status,'error');assert.equal(f.writes.length,0);
});
test('manual static refresh bypasses a recent cache and accepts a correctly bound planner sidecar',async()=>{
  const packageValue={entries:[{userId:'new',rank:1,rankModel:'test-model',averageFinishVersion:2,averagePlacementVersion:2}],trackSummaries:[],
    algorithmVersion:'test-model',schemaVersion:6,revision:2,builtRevision:2,sourceRevision:2,updatedAt:2,complete:true,
    totalEntries:1,totalEntriesExact:true,publishedEntries:1,_publicBackup:true,resultBundleLocation:'main_results'};
  const f=loaderFixture({cached:{entries:[{userId:'old'}],fetchedAt:Date.now(),sourceRevision:1},packageValue,
    detail:{algorithmVersion:'test-model',builtRevision:2,sourceRevision:2,updatedAt:2,resultBundle:'packed',resultBundleVersion:1}});
  let expanded;f.context.expandRankedResults=async data=>{expanded=data;return data.entries;};
  assert.equal((await f.context.loadOverallEntries(true))[0].userId,'new');assert.equal(expanded.resultBundle,'packed');
  assert.equal(f.context.overallLoadState.status,'snapshot');assert.equal(f.writes[0][1].source,'public-backup');
});
test('different-generation planner sidecar cannot attach to an Overall snapshot',async()=>{
  const f=loaderFixture({packageValue:{entries:[],trackSummaries:[],algorithmVersion:'test-model',schemaVersion:6,
    sourceRevision:2,builtRevision:2,updatedAt:2,resultBundleLocation:'main_results',_publicBackup:true},
    detail:{algorithmVersion:'test-model',sourceRevision:1,builtRevision:1,updatedAt:1,resultBundle:'stale'}});
  f.context.expandRankedResults=async data=>{assert.equal(data.resultBundle,undefined);return data.entries;};
  await f.context.loadOverallEntries(true);
});


test('pointer refresh failure still reads the retained package without a separate Overall cache',async()=>{
  const value={entries:[],_publicBackup:true};let reads=0;
  const reader=async()=>{reads++;return value;};reader.refresh=async()=>{throw Error('network failed');};
  const context=vm.createContext({publicSnapshotReaderPromise:Promise.resolve(reader),metadataRecovery:{retryMissing:()=>{}},});
  vm.runInContext(fn('readPublicSnapshotBackup'),context);
  const result=await context.readPublicSnapshotBackup('overall','','',{refresh:true});
  assert.equal(reads,1);assert.equal(result.entries,value.entries);assert.equal(result._snapshotRefreshFailed,true);
  assert.equal(value._snapshotRefreshFailed,undefined,'do not mutate the shared immutable package');
});

test('usable package after failed pointer check is displayed with an honest stale state',async()=>{
  const f=loaderFixture({packageValue:{entries:[],trackSummaries:[],algorithmVersion:'test-model',schemaVersion:6,
    sourceRevision:2,builtRevision:2,updatedAt:2,_publicBackup:true,_snapshotRefreshFailed:true}});
  await f.context.loadOverallEntries(true);assert.equal(f.context.overallLoadState.status,'stale');
  assert.equal(f.writes.length,1);assert.equal(f.writes[0][1].source,'public-backup');
});
