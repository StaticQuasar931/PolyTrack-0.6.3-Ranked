import test from 'node:test';
import assert from 'node:assert/strict';
import {verifiedTargetMs,bootstrapSlots,pendingSlot,verificationKey,VERIFIER_ENGINE_DIGEST,
  VERIFIER_VERSION,VERIFICATION_BOOTSTRAP_ID,verifiedVerdict,PRE_REPLAY_UI_PROOF_ENGINE} from '../src/verification.js';
import {PRE_EVENT_LAUNCH_ENGINE} from '../src/event-engine-compatibility.js';
const row={accountId:'racer',trackId:'a'.repeat(64),timeMs:19997,frames:19997,
  replayHash:'b'.repeat(64),uploadId:1,integrityVerified:true,runVerified:true};
const current={...pendingSlot(row),status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST};
const oldKey=JSON.parse(verificationKey(row));oldKey[1]=PRE_EVENT_LAUNCH_ENGINE;
const old={...current,key:JSON.stringify(oldKey),engineDigest:PRE_EVENT_LAUNCH_ENGINE};
test('repin has a fresh bootstrap key and requeues previous exact verified bindings without changing PBs',()=>{
  assert.notEqual(VERIFIER_ENGINE_DIGEST,PRE_EVENT_LAUNCH_ENGINE);
  assert.ok(VERIFICATION_BOOTSTRAP_ID.endsWith(VERIFIER_ENGINE_DIGEST));
  assert.equal(verifiedVerdict(row,old),false);
  const before=structuredClone(row),slots=bootstrapSlots(row.trackId,[row],{racer:old});
  assert.equal(slots.racer.status,'waiting');assert.equal(slots.racer.key,verificationKey(row));
  assert.deepEqual(row,before);assert.equal(old.status,'verified');
  assert.equal(bootstrapSlots(row.trackId,[row],{racer:current}).racer,current);
});
test('weekly target rejects cached verified label without exact current engine and PB proof',()=>{
  assert.equal(verifiedTargetMs([row],{}),null);
  assert.equal(verifiedTargetMs([row],{racer:old}),null);
  assert.equal(verifiedTargetMs([row],{racer:{...current,status:'waiting'}}),null);
  assert.equal(verifiedTargetMs([{...row,timeMs:19996}],{racer:current}),null);
  assert.equal(verifiedTargetMs([{...row,integrityVerified:false}],{racer:current}),null);
  assert.equal(verifiedTargetMs([row],{racer:{...current,verifierVersion:'other'}}),null);
  assert.equal(verifiedTargetMs([row],{racer:{...current,verifierVersion:VERIFIER_VERSION}}),19997);
});

test('manifest, geometry review and reviewed Worker compatibility use the same pin',async()=>{
  const fs=await import('node:fs');
  const {MIGRATION_063_ENGINE,EVENT_REPLAY_UI_ENGINE}=await import('../src/event-engine-compatibility.js');
  const manifest=JSON.parse(fs.readFileSync(new URL('../../../tools/verifier/engine-manifest.json',import.meta.url),'utf8'));
  const geometry=JSON.parse(fs.readFileSync(new URL('../../../tools/verifier/track-geometry.json',import.meta.url),'utf8'));
  const review=JSON.parse(fs.readFileSync(new URL('../../../docs/events/replay-ui-engine-review.json',import.meta.url),'utf8'));
  const historical=JSON.parse(fs.readFileSync(new URL('../../../docs/migration/engine-review.json',import.meta.url),'utf8'));
  assert.equal(manifest.engineDigest,VERIFIER_ENGINE_DIGEST);
  assert.equal(geometry.engineDigest,VERIFIER_ENGINE_DIGEST);
  assert.equal(review.currentEngine,VERIFIER_ENGINE_DIGEST);
  assert.equal(review.previousEngine,PRE_REPLAY_UI_PROOF_ENGINE);
  assert.equal(historical.engineDigest,review.previousEngine);
  assert.equal(MIGRATION_063_ENGINE,historical.engineDigest);
  assert.equal(EVENT_REPLAY_UI_ENGINE,review.currentEngine);
  assert.deepEqual(review.changedAssets,['main.bundle.js']);
  assert.equal(review.trackPinsUnchanged,true);assert.equal(review.geometryPinsReusedBecausePhysicsAndTracksUnchanged,true);
});

import {PRE_GHOST_PROOF_ENGINE,hasAcceptedVerifiedProof} from '../src/verification.js';
import {compatibleEventEngine,EVENT_LAUNCH_ENGINE} from '../src/event-engine-compatibility.js';
const previousKey=JSON.parse(verificationKey(row));previousKey[1]=PRE_GHOST_PROOF_ENGINE;
const previous={...current,key:JSON.stringify(previousKey),engineDigest:PRE_GHOST_PROOF_ENGINE};
const reviewedGhostEngine='32bfe32b8680597d9f1322dbcbb19242be38bee9ab243a379f5e449c3f4030fd';
const proofFor=digest=>{const key=JSON.parse(verificationKey(row));key[1]=digest;return {...current,key:JSON.stringify(key),engineDigest:digest};};
const oldCurrent=proofFor(PRE_REPLAY_UI_PROOF_ENGINE),reviewedGhost=proofFor(reviewedGhostEngine);
test('reviewed previous exact physics proof survives bootstrap and supplies verified target',()=>{
 for(const proof of [oldCurrent,reviewedGhost,previous]) {
  assert.equal(verifiedVerdict(row,proof),true);
  assert.equal(bootstrapSlots(row.trackId,[row],{racer:proof}).racer,proof);
  assert.equal(verifiedTargetMs([row],{racer:proof}),19997);
  assert.equal(verifiedVerdict({...row,integrityVerified:false},proof),false);
  for(const status of ['waiting','unavailable','mismatch']) assert.equal(bootstrapSlots(row.trackId,[row],{racer:{...proof,status}}).racer.key,verificationKey(row));
 }
});
test('prior proof requires every exact run field and trusted verdict, never a client label',()=>{
 for(const proof of [oldCurrent,reviewedGhost,previous]) for(const change of [{accountId:'other'},{trackId:'c'.repeat(64)},{timeMs:19996},{frames:19996},{raceTimeFrames:19998},{uploadId:2},{replayHash:'d'.repeat(64)}]){
  const changed={...row,...change};assert.equal(verifiedVerdict(changed,proof),false,proof.engineDigest+JSON.stringify(change));
  if(changed.trackId===row.trackId) assert.equal(bootstrapSlots(row.trackId,[changed],{racer:proof})[changed.accountId].status,'waiting');
 }
 for(const proof of [oldCurrent,reviewedGhost,previous]) for(const change of [{status:'waiting'},{verifierVersion:'future'},{engineDigest:'f'.repeat(64)},{key:'untrusted'}])assert.equal(verifiedVerdict(row,{...proof,...change}),false);
 assert.equal(verifiedVerdict(row,{runVerified:true,verified:true}),false);
 assert.equal(verifiedVerdict(row,current),true);
});
test('future repin cannot implicitly inherit proof or immutable-period compatibility',async()=>{
 const fs=await import('node:fs');const future='e'.repeat(64);
 const source=fs.readFileSync(new URL('../src/verification.js',import.meta.url),'utf8').replace("export const VERIFIER_ENGINE_DIGEST = '"+VERIFIER_ENGINE_DIGEST+"'","export const VERIFIER_ENGINE_DIGEST = '"+future+"'");
 const module=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 for(const proof of [oldCurrent,reviewedGhost,previous,current])assert.equal(module.verifiedVerdict(row,proof),false);
 const compat=fs.readFileSync(new URL('../src/event-engine-compatibility.js',import.meta.url),'utf8').replace("import { VERIFIER_ENGINE_DIGEST } from './verification.js';","const VERIFIER_ENGINE_DIGEST = '"+future+"';");
 const next=await import('data:text/javascript;base64,'+Buffer.from(compat).toString('base64'));
 for(const digest of [PRE_EVENT_LAUNCH_ENGINE,EVENT_LAUNCH_ENGINE,VERIFIER_ENGINE_DIGEST])assert.equal(next.compatibleEventEngine(digest),false);
 for(const digest of [PRE_EVENT_LAUNCH_ENGINE,EVENT_LAUNCH_ENGINE,VERIFIER_ENGINE_DIGEST])assert.equal(compatibleEventEngine(digest),true);
});
test('preserved previous approval is not permission for a new obsolete completion',async()=>{
 const {completedSlot}=await import('../../../tools/verifier/queue.mjs');
 for(const engineDigest of [PRE_REPLAY_UI_PROOF_ENGINE,reviewedGhostEngine,PRE_GHOST_PROOF_ENGINE])
  assert.throws(()=>completedSlot(pendingSlot(row),{status:'verified',engineDigest}),/engine pin mismatch/);
});

test('0.6.3 release gate binds all served assets and reviewed geometry',async()=>{
 const fs=await import('node:fs'),{snapshot}=await import('../../../tools/verifier/assets.cjs'),{fileURLToPath}=await import('node:url');
 const root=new URL('../../../',import.meta.url), actual=snapshot(fileURLToPath(root));
 const manifest=JSON.parse(fs.readFileSync(new URL('tools/verifier/engine-manifest.json',root),'utf8'));
 assert.equal(actual.engineFingerprint,VERIFIER_ENGINE_DIGEST);assert.deepEqual(actual.manifest,manifest.files);assert.deepEqual(actual.tracks,manifest.tracks);
 const review=JSON.parse(fs.readFileSync(new URL('docs/events/replay-ui-engine-review.json',root),'utf8'));
 const historical=JSON.parse(fs.readFileSync(new URL('docs/migration/engine-review.json',root),'utf8'));
 assert.equal(review.currentEngine,VERIFIER_ENGINE_DIGEST);assert.equal(review.previousEngine,historical.engineDigest);
 for(const [file,hash] of Object.entries(historical.unchangedPhysicsAssets))assert.equal(actual.manifest[file],hash);
});
