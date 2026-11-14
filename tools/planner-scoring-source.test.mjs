import fs from 'node:fs';
import vm from 'node:vm';
import {gunzipSync} from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {buildPlannerScoringSource,buildPlannerScoringSourceFromManifest} from './planner-scoring-source.mjs';
function fixture(){
  const overall={complete:true,sourceComplete:true,ranksExact:true,algorithmVersion:'test',schemaVersion:6,sourceRevision:78,builtRevision:78,updatedAt:1000,
    entries:[{userId:'a',raceCount:1},{userId:'b',raceCount:1},{userId:'c',raceCount:0}]};
  const rows=[{userId:'a',resultData:JSON.stringify([[0,1,2,3,1,10000,100]])},{userId:'b',resultData:JSON.stringify([[0,2,2,3,1,11000,200]])}];
  const pack=()=>({...overall,entries:undefined,resultBundleVersion:1,resultBundleComplete:true,resultBundleEncoding:'gzip-base64-json-v1',
    resultBundle:gzipSync(JSON.stringify({resultTracks:['track'],entries:rows})).toString('base64')});
  return {overall,rows,pack};
}
test('complete scoring lanes exclude raw normal-board counts and include empty profiles',async()=>{
  const {overall,pack}=fixture(),index=await buildPlannerScoringSource(overall,pack());
  assert.equal(index.profiles.size,3);assert.equal(index.profiles.get('c').length,0);
  assert.deepEqual(index.profiles.get('a').map(f=>[f.rank,f.fieldSize]),[[1,2]]);
  assert.equal(index.boards.get('track').entries.length,2);assert.equal(index.fields[0].weight,3);
});
test('mixed publications, incomplete fields and result counts fail closed',async()=>{
  const {overall,rows,pack}=fixture();
  await assert.rejects(buildPlannerScoringSource(overall,{...pack(),sourceRevision:79}),/mixed/);
  rows.pop();await assert.rejects(buildPlannerScoringSource(overall,pack()),/Missing/);
});
test('input ordering cannot change the scored field',async()=>{
  const {overall,rows,pack}=fixture(),a=await buildPlannerScoringSource(overall,pack());
  overall.entries.reverse();rows.reverse();const b=await buildPlannerScoringSource(overall,pack());
  assert.deepEqual(a.boards,b.boards);
});

function manifestFor(overall){return {kind:'overall-manifest',complete:true,sourceComplete:true,ranksExact:true,totalEntriesExact:true,
 totalEntries:overall.entries.length,...Object.fromEntries(['algorithmVersion','schemaVersion','sourceRevision','updatedAt'].map(k=>[k,overall[k]])),
 boardMetadata:{...overall,entries:undefined,totalEntries:overall.entries.length}};}
test('compact manifest input is identical to every full scoring page, including zero-track racers',async()=>{
 const {overall,rows,pack}=fixture();rows.push({userId:'c',resultData:'[]'});
 const full=await buildPlannerScoringSource(overall,pack()),compact=await buildPlannerScoringSourceFromManifest(manifestFor(overall),pack());
 assert.deepEqual(compact,full);
});
test('compact manifest rejects mixed bindings, missing profiles and incomplete fields',async()=>{
 const {overall,rows,pack}=fixture();rows.push({userId:'c',resultData:'[]'});const manifest=manifestFor(overall);
 for(const change of [{complete:false},{sourceComplete:false},{ranksExact:false},{totalEntriesExact:false},{totalEntries:4},{sourceRevision:79}])
  await assert.rejects(buildPlannerScoringSourceFromManifest({...manifest,...change},pack()));
 await assert.rejects(buildPlannerScoringSourceFromManifest(manifest,{...pack(),builtRevision:79}),/mixed/);
 rows[1].resultData='[]';await assert.rejects(buildPlannerScoringSourceFromManifest(manifest,pack()),/Incomplete scoring field/);
});

test('shipped package compact source matches all Overall pages offline',async()=>{
 const root=new URL('../',import.meta.url),html=fs.readFileSync(new URL('index.html',root),'utf8');
 const folder=/<meta name="polytrack-snapshot" content="([^"]+)"/.exec(html)[1],dir=new URL(folder,root);
 const index=JSON.parse(fs.readFileSync(new URL('index.json',dir)));
 const read=key=>{const bytes=fs.readFileSync(new URL(index.files[key].path,dir));for(let i=0;i<bytes.length;i++)bytes[i]^=0xa7;return JSON.parse(gunzipSync(bytes));};
 const manifest=read('overall-manifest.json'),packed=read('overall-results.json');
 const entries=Array.from({length:manifest.pageCount},(_,i)=>read('overall-pages/'+(i+1)+'.json').entries).flat();
 const full=await buildPlannerScoringSource({...manifest.boardMetadata,entries},packed);
 assert.deepEqual(await buildPlannerScoringSourceFromManifest(manifest,packed),full);
 assert.equal(full.profiles.size,manifest.totalEntries);
 const accountId='0aee36260699a9d9adc8ddedd367e7000eb6bfe573c57ac8b09b694c5b005b6e';
 const finishes=full.profiles.get(accountId);assert.ok(finishes?.length,'requested profile is in the cached snapshot');
 const {buildPlannerSnapshotInput}=await import('./planner-snapshot-input.mjs');
 const {plannerEaseEstimate,orderPlannerRoutes}=await import('./planner-route-model.mjs');
 const {buildFieldRpPlanner}=await import('./field-rp-planner.mjs');
 const input={snapshotResults:finishes,snapshotComplete:true,expectedCount:finishes.length,trackSummaries:full.fields};
 const cold=buildPlannerSnapshotInput(input);
 const warm=buildPlannerSnapshotInput({...input,cachedResults:finishes.map(row=>({...row,rank:1,complete:true,cachedAt:9999999999999}))});
 assert.deepEqual(warm,cold,'browsing every track cannot change this profile input');
 const plan=buildFieldRpPlanner(cold.finishes,{complete:cold.complete,expectedCount:finishes.length,
   fields:full.fields,fieldsComplete:true,expectedFieldCount:full.fields.length});
 assert.equal(plan.known,true);assert.ok(plan.routes.length);
 const routes=plan.routes.map(row=>({...row,ease:plannerEaseEstimate(row,full.boards.get(row.trackId),accountId)}));
 for(const sort of ['impact','practice','ease','training','benefit-ease']){
   const options={benefitReference:plan.benefitReference};
   const a=orderPlannerRoutes([],routes,8,sort,options);
   const b=orderPlannerRoutes([],[...routes].reverse(),8,sort,options);
   assert.deepEqual(a,b,'route order does not depend on track load order: '+sort);
 }
 const finish=finishes.find(row=>row.timeMs>1);
 const local=buildPlannerSnapshotInput({...input,localResults:[{trackId:finish.trackId,timeMs:finish.timeMs-1,pbAt:123}]});
 assert.deepEqual(local.finishes,cold.finishes,'a local PB must not award a published rank');
 assert.equal(local.localPBs.find(row=>row.trackId===finish.trackId).timeMs,finish.timeMs-1);

});
test('production cold loader requests only manifest and compact results, then reuses the index',async()=>{
 const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
 const start=source.indexOf('  function loadPlannerScoringIndex('),end=source.indexOf('  function loadProfileSnapshotResults(',start);
 const loader=source.slice(start,end).replace(/import\('\.\/tools\/planner-scoring-source.mjs[^']*'\)/,'Promise.resolve(module)');
 const {overall,rows,pack}=fixture();rows.push({userId:'c',resultData:'[]'});const requests=[];
 const c=vm.createContext({profileSnapshotEpoch:0,plannerScoringIndex:null,plannerScoringRequest:null,plannerScoringRetryAt:0,Date,Promise,
 module:{buildPlannerScoringSourceFromManifest},readPublicSnapshotBackup:async kind=>{requests.push(kind);return kind==='overall-manifest'?manifestFor(overall):pack();}});
 vm.runInContext(loader,c);const first=await c.loadPlannerScoringIndex();assert.equal(first.profiles.size,3);
 assert.deepEqual(requests,['overall-manifest','overall-results']);assert.equal(await c.loadPlannerScoringIndex(),first);assert.equal(requests.length,2);
});

test('contradictory metadata, timing and rank order cannot masquerade as a complete field',async()=>{
  for(const change of [{weight:4},{competition:2},{timeMs:9000},{timeMs:11000.5}]){
    const {overall,rows,pack}=fixture(),tuple=JSON.parse(rows[1].resultData)[0];
    for(const [key,value] of Object.entries(change))tuple[{weight:3,competition:4,timeMs:5}[key]]=value;
    rows[1].resultData=JSON.stringify([tuple]);
    await assert.rejects(buildPlannerScoringSource(overall,pack()));
  }
  const {overall,pack}=fixture();
  await assert.rejects(buildPlannerScoringSource({...overall,totalEntriesExact:false},pack()));
});
