import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {buildPlannerScoringSource} from './planner-scoring-source.mjs';
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
