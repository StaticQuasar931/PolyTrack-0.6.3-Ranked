import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {gzipSync} from 'node:zlib';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=source.indexOf('  async function expandRankedResults('),end=source.indexOf('  let overallCloudRetryAt=',start);
assert.ok(start>=0&&end>start);
const context=vm.createContext({Uint8Array,atob,Blob,DecompressionStream,TextDecoder,Number,Array,Map,Set,JSON,Math,Error});
vm.runInContext(source.slice(start,end),context);
const track='a'.repeat(64);
function fixture(size){
 const entries=Array.from({length:size},(_,i)=>({userId:'racer'+i}));
 const result={entries:entries.map(row=>({...row,resultData:JSON.stringify([[0,1,2,1,1,10000,100]])})),resultTracks:[track]};
 return {entries,resultBundleVersion:1,resultBundleEncoding:'gzip-base64-json-v1',resultBundle:gzipSync(JSON.stringify(result)).toString('base64')};
}
test('planner result details hydrate populations beyond the old 200-racer ceiling',async()=>{
 for(const size of [201,1452]){
  const data=fixture(size),result=await context.expandRankedResults(data);
  assert.equal(result.length,size);
  assert.ok(result.every(row=>row.resultSamples?.length===1));
  assert.equal(result.at(-1).resultSamples[0].trackId,track);
  assert.equal(data.entries[0].resultSamples,undefined,'published input remains untouched');
 }
});
test('result bundles cannot exceed or duplicate the published population',async()=>{
 const oversized=fixture(201);oversized.entries=oversized.entries.slice(0,200);
 const first=await context.expandRankedResults(oversized);assert.ok(first.every(row=>!row.resultSamples));
 const duplicate=fixture(2);
 duplicate.resultBundle=gzipSync(JSON.stringify({entries:[{userId:'racer0'},{userId:'racer0'}],resultTracks:[track]})).toString('base64');
 assert.ok((await context.expandRankedResults(duplicate)).every(row=>!row.resultSamples));
});
