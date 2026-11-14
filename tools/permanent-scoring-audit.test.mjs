import test from 'node:test';import assert from 'node:assert/strict';import {validPermanentBoard} from './verifier/snapshot-audit.mjs';import {permanentRollingHillsRp} from '../workers/ranked/src/permanent-rolling-hills.js';
import {nativeEventSourceHash} from './native-event-snapshot.mjs';
const track='fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
const row=(n,timeMs,rank)=>({accountId:n.toString(16).padStart(64,'0'),trackId:track,timeMs,frames:timeMs,replayHash:'a'.repeat(64),physicsVerified:true,replayIntegrityVerified:true,normalRpEligible:true,rank,rp:permanentRollingHillsRp(rank,18000,timeMs),eventRpContribution:permanentRollingHillsRp(rank,18000,timeMs)});
const board=()=>({id:'permanent-rolling-hills',kind:'permanent',trackId:track,complete:true,sourceComplete:true,totalEntries:3,sourceTotalEntries:3,updatedAt:1,sourceRevision:1,scoreVersion:'rolling-hills-pace-placement-v2',targetPolicy:'live-fastest-physics-verified',maxRp:10101,targetMs:18000,sourceCompleteness:'explicit-snapshot-metadata',contributions:{normalRp:true,eventRp:true},entries:[row(1,18000,1),row(2,18000,1),row(3,19000,3)]});
test('hybrid audit accepts exact canonical awards and competition ties',()=>{assert.equal(validPermanentBoard(board()),true);const b=board();b.entries.reverse();assert.equal(validPermanentBoard(b),true);});
test('hybrid audit rejects invented points, rank, holds, unknown policy and cap',()=>{for(const change of [b=>b.entries[2].rp++,b=>b.entries[1].rank=2,b=>b.entries[2].reviewHold=true,b=>b.entries[2].pending=true,b=>b.maxRp=1001,b=>b.scoreVersion='rolling-hills-rank-reciprocal-v2']){const b=board();change(b);assert.equal(validPermanentBoard(b),false);}});
test('legacy audit remains available without pretending its points use the hybrid curve',()=>{const b=board();b.scoreVersion='rolling-hills-live-verified-v1';b.maxRp=1001;for(const r of b.entries){r.rp=500;r.eventRpContribution=500;}assert.equal(validPermanentBoard(b),true);});

function capturedFixture(){
 const b=board(),normalSource={trackId:track,algorithmVersion:'participation-v8-s1',schemaVersion:6,
  complete:true,totalEntries:3,revision:1,sourceRevision:1,updatedAt:1,builtAt:1,
  entries:b.entries.map(r=>({accountId:r.accountId,trackId:track,timeMs:r.timeMs,frames:r.frames,
   replayHash:r.replayHash,runVerified:true,integrityVerified:true}))};
 b.sourceCompleteness='captured-native-complete';
 b.capturedNativeSource={kind:'captured-native-content-v1',sourceHash:nativeEventSourceHash(normalSource),
  sourceHashMode:'canonical-json',sourceUpdatedAt:1,sourceBuiltAt:1};
 return {b,normalSource};
}

test('captured-native audit accepts only the supplied matching canonical normal source',()=>{
 const {b,normalSource}=capturedFixture();
 assert.equal(validPermanentBoard(b,{normalSource}),true);
 const reordered=Object.fromEntries(Object.entries(normalSource).reverse());
 reordered.entries=normalSource.entries.map(r=>Object.fromEntries(Object.entries(r).reverse()));
 assert.equal(validPermanentBoard(b,{normalSource:reordered}),true,'object key order is not source identity');
 assert.equal(validPermanentBoard(b),false,'captured completeness alone is not source authority');
});

test('captured-native audit rejects mismatched source, hash, track, mode and missing capture metadata',()=>{
 const {b,normalSource}=capturedFixture();
 for(const change of [s=>s.entries[0].timeMs++,s=>s.revision++,s=>s.updatedAt++,s=>s.entries.reverse()]){
  const changed=structuredClone(normalSource);change(changed);
  assert.equal(validPermanentBoard(b,{normalSource:changed}),false);
 }
 const otherTrack={...normalSource,trackId:'b'.repeat(64)},otherBoard=structuredClone(b);
 otherBoard.capturedNativeSource.sourceHash=nativeEventSourceHash(otherTrack);
 assert.equal(validPermanentBoard(otherBoard,{normalSource:otherTrack}),false);
 for(const change of [s=>s.sourceHash='0'.repeat(64),s=>s.sourceHashMode='file-bytes',
  s=>s.sourceUpdatedAt=0,s=>delete s.sourceBuiltAt,s=>s.kind='untrusted']){
  const changed=structuredClone(b);change(changed.capturedNativeSource);
  assert.equal(validPermanentBoard(changed,{normalSource}),false);
 }
});
