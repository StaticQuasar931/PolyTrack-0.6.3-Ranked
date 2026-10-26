import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync} from 'node:zlib';
import {createOverallProjectionBundle,decodeOverallProjectionBundle,decodeProjectionResults} from './overall-projection-bundle.mjs';
import {projectLocalOverall} from './overall-local-projection.mjs';
import {computeOverall,trackWeightParts} from '../workers/ranked/src/index.js';
const ids=['5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038','7eac4fee1111152cfba4d3737410264ca0f22c7f5a2211e79f0099589b8b48c0','148826aa16ffaa23dbc453b32cff05e025ddbce1773fc7733cc13d218926515a'];
function data(){
 const meta={algorithmVersion:'participation-v8-s1',schemaVersion:6,sourceRevision:10,builtRevision:10,updatedAt:1000};
 const tracks=ids.map(trackId=>({...meta,trackId,complete:true,totalEntries:2,entries:[['a',10000],['b',12000]].map(([accountId,timeMs])=>({accountId,trackId,timeMs,pbAt:100,weight:Number(trackWeightParts(trackId,2,1).finalWeight.toFixed(3)),runVerified:true,integrityVerified:true,ownerUid:'MUST_NOT_APPEAR',carStyle:'PRIVATE_SOURCE_FIELD'}))}));
 const entries=computeOverall(tracks,[],new Set(),{includePlannerResults:true});
 const overall={...meta,complete:true,totalEntries:entries.length,entries,trackCatalog:tracks.map(b=>({trackId:b.trackId,updatedAt:b.updatedAt}))};
 const results={...meta,resultBundleVersion:1,resultBundleEncoding:'gzip-base64-json-v1',resultBundleComplete:true,resultBoardCount:3,resultBoardLimitReached:false,resultBundle:gzipSync(JSON.stringify({entries:entries.map(row=>({userId:row.userId,resultSamples:row.resultSamples})),resultTracks:ids})).toString('base64')};
 return {overall,results,tracks};
}
test('compact public source reproduces published baseline and applies an accepted PB without fresh-board reads',async()=>{
 const d=data(),bundle=await createOverallProjectionBundle(d),generation=60;
 assert.doesNotMatch(JSON.stringify(bundle),/ownerUid|PRIVATE_SOURCE_FIELD|MUST_NOT_APPEAR/);
 const tracks=decodeOverallProjectionBundle(bundle,{overall:d.overall,generation});
 const result=projectLocalOverall({accountId:'b',generation,overall:{...d.overall,generation},results:{...await decodeProjectionResults(d.results),generation},tracks,
  acceptedPbs:[{accountId:'b',trackId:ids[0],timeMs:9000,accepted:true,acceptedAt:2000,generation}]});
 assert.equal(result.status,'projected');assert.equal(result.calculationExact,true);assert.ok(result.changedTracks.includes(ids[0]));
 assert.equal(d.tracks[0].entries[1].timeMs,12000,'presentation must never mutate source boards');
});
test('source revision, catalog, row shape and private-field mutations fail closed',async()=>{
 const d=data(),bundle=await createOverallProjectionBundle(d);
 for(const mutate of [b=>b.sourceRevision++,b=>b.boards[0][2]++,b=>b.boards.push(b.boards[0]),b=>b.boards[0][4][0].push('extra'),b=>b.ownerUid='private']){
  const candidate=structuredClone(bundle);mutate(candidate);assert.throws(()=>decodeOverallProjectionBundle(candidate,{overall:d.overall,generation:60}));
 }
});
test('builder cannot bless a mismatched score baseline or truncated source',async()=>{
 const d=data();d.overall.entries[0].score+=1;await assert.rejects(createOverallProjectionBundle(d),/baseline mismatch/);
 const e=data();e.tracks[0].entries.pop();await assert.rejects(createOverallProjectionBundle(e),/Incomplete/);
});

test('real snapshot-reader metadata is accepted without relaxing unknown-field validation',async()=>{
 const d=data(),bundle=await createOverallProjectionBundle(d),options={overall:d.overall,generation:60};
 const expected=decodeOverallProjectionBundle(bundle,options);
 for(const source of ['snapshot','cached'])assert.deepEqual(decodeOverallProjectionBundle({...bundle,_publicBackup:true,_dataSource:source,_snapshotCapturedAt:2000},options),expected);
 for(const extra of [{_publicBackup:false},{_dataSource:'live'},{_snapshotCapturedAt:-1},{ownerUid:'private'},{_arbitrary:'ignored'}])assert.throws(()=>decodeOverallProjectionBundle({...bundle,...extra},options));
});
