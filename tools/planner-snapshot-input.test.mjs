import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPlannerSnapshotInput as build} from './planner-snapshot-input.mjs';
const a={trackId:'a',rank:4,fieldSize:10,weight:2,timeMs:12000,cachedAt:100};
const b={...a,trackId:'b',rank:3};
const summary={trackId:'new',fieldSize:9,weight:3,updatedAt:100};
test('full snapshot is independent of result order and partial/stale browsed cache overlays',()=>{
  const input={snapshotResults:[a,b],snapshotComplete:true,snapshotUpdatedAt:100,expectedCount:2,trackSummaries:[summary]};
  const first=build(input);
  for(const cachedResults of [[],[{...a,rank:1,cachedAt:99,complete:true}],
    [{...a,rank:1,cachedAt:999,complete:false}], [{...a,rank:1,cachedAt:999,complete:true}]]){
    assert.deepEqual(build({...input,snapshotResults:[b,a],cachedResults}),first);
  }
  assert.equal(first.complete,true);
  assert.equal(build({...input,expectedCount:3}).complete,false);
  assert.equal(build({...input,snapshotComplete:false}).complete,false);
});
test('partial input rejects partial, stale, inexact and rejected overlays',()=>{
  const base={snapshotUpdatedAt:100,expectedCount:1};
  for(const row of [{...a,complete:false},{...a,complete:true,cachedAt:99},
    {...a,complete:true,ranksExact:false},{...a,complete:true,status:'rejected'}])
    assert.deepEqual(build({...base,cachedResults:[row]}).finishes,[]);
  assert.deepEqual(build({...base,cachedResults:[{...a,complete:true}]}).finishes,[{...a,complete:true}]);
});
test('canonical duplicate resolution and field union ignore enumeration order',()=>{
  const newer={...a,cachedAt:200,rank:5},conflict={...newer,rank:6};
  const stats={z:{complete:true,players:20,count:20,totalEntries:20,weight:4,updatedAt:100}};
  const input={snapshotResults:[a,newer,conflict,b],snapshotComplete:true,trackSummaries:[summary,{...summary,updatedAt:50}],statistics:stats};
  assert.deepEqual(build(input),build({...input,snapshotResults:[b,conflict,newer,a],trackSummaries:[...input.trackSummaries].reverse()}));
  assert.equal(build(input).fields.length,2);
});
test('better local PB keeps its run date, never borrows placement or cache recency',()=>{
  const local={trackId:'a',timeMs:11000,pbAt:90,cachedAt:999,checkedAt:1000,rank:1,fieldSize:10};
  const input={snapshotResults:[a],snapshotComplete:true,expectedCount:1,localResults:[local,{...local,pbAt:80}]};
  const result=build(input);
  assert.equal(result.finishes[0].rank,4);
  assert.deepEqual(result.localPBs,[{trackId:'a',timeMs:11000,pbAt:90,rank:null,fieldSize:null,weight:null,local:true,localPending:true}]);
  assert.deepEqual(build({...input,localResults:[...input.localResults].reverse()}),result);
  assert.equal(build({...input,localResults:[{...local,pbAt:undefined}]}).localPBs[0].pbAt,0);
});
test('new track fields are from all published summaries/statistics, not an opened page',()=>{
  const stats={complete:true,count:12,players:12,totalEntries:12,weight:4,updatedAt:100};
  const result=build({trackSummaries:[summary],statistics:{unopened:stats,bad:{...stats,complete:false}}});
  assert.deepEqual(result.fields.map(row=>row.trackId),['new','unopened']);
  assert.deepEqual(build(),{finishes:[],localPBs:[],played:[],fields:[],complete:false});
});

test('equal timestamp duplicate records with reordered object keys stay deterministic',()=>{
  const first={...a,extra:{one:1,two:2}};
  const second={...a,extra:{two:3,one:1}};
  assert.deepEqual(build({snapshotResults:[first,second],snapshotComplete:true}),
    build({snapshotResults:[second,first],snapshotComplete:true}));
});
test('local, rejected and explicitly inexact rows cannot become authoritative placements',()=>{
  for(const change of [{local:true},{localPending:true},{pending:true},{ranksExact:false},{status:'rejected'}]){
    assert.deepEqual(build({snapshotResults:[{...a,...change}],snapshotComplete:true,expectedCount:1}).finishes,[]);
    assert.equal(build({snapshotResults:[{...a,...change}],snapshotComplete:true,expectedCount:1}).complete,false);
  }
});

test('reference package profiles remain stable with reversed input and stale cache overlays',
  {skip:!process.env.PT_PLANNER_REFERENCE_DIRECTORY}, async()=>{
  const fs=await import('node:fs/promises'),path=await import('node:path'),{gunzipSync}=await import('node:zlib');
  const directory=path.join(process.env.PT_PLANNER_REFERENCE_DIRECTORY,'public-snapshots76');
  const index=JSON.parse(await fs.readFile(path.join(directory,'index.json'),'utf8'));
  const profiles=Object.entries(index.files).filter(([key])=>key.startsWith('profile-results/')).slice(0,8);
  assert.ok(profiles.length);
  let checked=0;
  for(const [,record] of profiles){
    const bytes=await fs.readFile(path.join(directory,record.path));
    for(let i=0;i<bytes.length;i++)bytes[i]^=0xa7;
    const profile=JSON.parse(gunzipSync(bytes));
    assert.ok(Array.isArray(profile.results));
    const snapshotResults=profile.results;
    const input={snapshotResults,snapshotComplete:true,expectedCount:snapshotResults.length};
    const before=build(input);
    assert.deepEqual(build({...input,snapshotResults:[...snapshotResults].reverse(),
      cachedResults:snapshotResults.map(row=>({...row,rank:1,cachedAt:1,complete:false}))}),before);
    checked++;
  }
  assert.equal(checked,profiles.length);
});

test('invalid local times and explicitly untrusted field summaries are excluded',()=>{
  for(const timeMs of [1.5,NaN,Infinity,-1,'11000'])
    assert.deepEqual(build({localResults:[{trackId:'a',timeMs}]}).localPBs,[]);
  for(const change of [{ranksExact:false},{sourceComplete:false},{totalEntriesExact:false},
    {local:true},{localPending:true},{pending:true}])
    assert.deepEqual(build({trackSummaries:[{...summary,...change}]}).fields,[]);
});
test('cold and warm track output stays identical while real local PB changes are observed',()=>{
  const input={snapshotResults:[a,b],snapshotComplete:true,expectedCount:2,trackSummaries:[summary]};
  const cold=build(input);
  assert.deepEqual(build({...input,cachedResults:[{...a,rank:1,complete:true,cachedAt:999}]}),cold);
  const improved=build({...input,localResults:[{trackId:'a',timeMs:11000,pbAt:200}]});
  assert.deepEqual(improved.finishes,cold.finishes);
  assert.equal(improved.localPBs[0].timeMs,11000);
  assert.notDeepEqual(improved,cold);
  assert.deepEqual(build({...input,localResults:[{trackId:'a',timeMs:13000,pbAt:300}]}),cold);
});
