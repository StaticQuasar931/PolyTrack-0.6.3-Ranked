import test from 'node:test';
import assert from 'node:assert/strict';
import {verifiedTargetMs,bootstrapSlots,pendingSlot,verificationKey,VERIFIER_ENGINE_DIGEST,
  VERIFIER_VERSION,VERIFICATION_BOOTSTRAP_ID,verifiedVerdict,PRE_REPLAY_UI_PROOF_ENGINE} from '../src/verification.js';
import {reviewedWatchUiBaseline} from '../../../tools/verifier/watch-ui-review.mjs';
import {PRE_EVENT_LAUNCH_ENGINE} from '../src/event-engine-compatibility.js';

async function reviewedOpponentFiles(manifest) {
 const fs=await import('node:fs'),{createHash}=await import('node:crypto');
 const sha=value=>createHash('sha256').update(value).digest('hex');
 const root=new URL('../../../',import.meta.url);
 const baseline=reviewedWatchUiBaseline(manifest);
 manifest={...manifest,files:baseline.files};
 const indexed=JSON.parse(fs.readFileSync(new URL('tools/verifier/indexed-playback-review.json',root),'utf8'));
 assert.equal(indexed.currentEngine,baseline.review.previousEngine);
 assert.equal(indexed.currentEngine,'3cb2e59839b5ad85ea34d892e1f10ca7dc04f9d8cec17770fbd843673614a3a0');
 assert.equal(indexed.previousEngine,'7cd54f05e02b66c67133fd856f025c829c21d600d8ef6a9071df62b4fb5905c4');
 assert.equal(indexed.previousReview,'docs/events/opponent-shortcut-ui-engine-review.json');
 assert.equal(sha(fs.readFileSync(new URL(indexed.previousReview,root),'utf8').replace(/\r\n?/g,'\n')),indexed.previousReviewSha256);
 assert.deepEqual(indexed.changedAssets,['simulation_worker.bundle.js']);
 assert.deepEqual(Object.keys(indexed.previousAssets),indexed.changedAssets);assert.deepEqual(Object.keys(indexed.currentAssets),indexed.changedAssets);
 for(const [asset,hash]of Object.entries({...indexed.unchangedAssets,...indexed.currentAssets}))assert.equal(manifest.files[asset],hash);
 assert.equal(sha(JSON.stringify(manifest.files)),indexed.currentEngine);
 const restored={...manifest.files,...indexed.previousAssets};
 assert.equal(sha(JSON.stringify(restored)),indexed.previousEngine,'restore exact prior Worker and require full historical engine hash');
 assert.equal(indexed.historicalBootstrapUnchanged,true);assert.equal(indexed.bootstrapId,VERIFICATION_BOOTSTRAP_ID);
 return {files:restored,indexed};
}

const row={accountId:'racer',trackId:'a'.repeat(64),timeMs:19997,frames:19997,
  replayHash:'b'.repeat(64),uploadId:1,integrityVerified:true,runVerified:true};
const current={...pendingSlot(row),status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST};
const oldKey=JSON.parse(verificationKey(row));oldKey[1]=PRE_EVENT_LAUNCH_ENGINE;
const old={...current,key:JSON.stringify(oldKey),engineDigest:PRE_EVENT_LAUNCH_ENGINE};
test('UI repin retains historical bootstrap and requeues only unreviewed exact bindings',()=>{
  assert.notEqual(VERIFIER_ENGINE_DIGEST,PRE_EVENT_LAUNCH_ENGINE);
  assert.ok(VERIFICATION_BOOTSTRAP_ID.endsWith('46aba6e247567f5954d412e0988e3d2cd04e9ec154c294bdf3fcaa830d9d12f3'));
  assert.ok(!VERIFICATION_BOOTSTRAP_ID.endsWith(VERIFIER_ENGINE_DIGEST));
  assert.equal(verifiedVerdict(row,old),false);
  const before=structuredClone(row),slots=bootstrapSlots(row.trackId,[row],{racer:old});
  assert.equal(slots.racer.status,'waiting');assert.equal(slots.racer.key,verificationKey(row));
  assert.deepEqual(row,before);assert.equal(old.status,'verified');
  assert.equal(bootstrapSlots(row.trackId,[row],{racer:current}).racer,current);
});
test('weekly target requires exact accepted engine and PB proof',()=>{
  assert.equal(verifiedTargetMs([row],{}),null);
  assert.equal(verifiedTargetMs([row],{racer:old}),null);
  assert.equal(verifiedTargetMs([row],{racer:{...current,status:'waiting'}}),null);
  assert.equal(verifiedTargetMs([{...row,timeMs:19996}],{racer:current}),null);
  assert.equal(verifiedTargetMs([{...row,integrityVerified:false}],{racer:current}),null);
  assert.equal(verifiedTargetMs([row],{racer:{...current,verifierVersion:'other'}}),null);
  assert.equal(verifiedTargetMs([row],{racer:{...current,verifierVersion:VERIFIER_VERSION}}),19997);
});

test('manifest, opponent review chain and reviewed Worker compatibility use the same pin',async()=>{
  const fs=await import('node:fs');
  const {MIGRATION_063_ENGINE,EVENT_REPLAY_UI_ENGINE,EVENT_NATIVE_ROW_UI_ENGINE,EVENT_OPPONENT_SHORTCUT_UI_ENGINE}=await import('../src/event-engine-compatibility.js');
  const manifest=JSON.parse(fs.readFileSync(new URL('../../../tools/verifier/engine-manifest.json',import.meta.url),'utf8'));
  const geometry=JSON.parse(fs.readFileSync(new URL('../../../tools/verifier/track-geometry.json',import.meta.url),'utf8'));
  const review=JSON.parse(fs.readFileSync(new URL('../../../docs/events/opponent-shortcut-ui-engine-review.json',import.meta.url),'utf8'));
  const nativeReview=JSON.parse(fs.readFileSync(new URL('../../../docs/events/native-row-ui-engine-review.json',import.meta.url),'utf8'));
  const priorReview=JSON.parse(fs.readFileSync(new URL('../../../docs/events/replay-ui-engine-review.json',import.meta.url),'utf8'));
  const historical=JSON.parse(fs.readFileSync(new URL('../../../docs/migration/engine-review.json',import.meta.url),'utf8'));
  assert.equal(manifest.engineDigest,VERIFIER_ENGINE_DIGEST);
  assert.equal(geometry.engineDigest,VERIFIER_ENGINE_DIGEST);
  assert.equal(review.currentEngine,(await reviewedOpponentFiles(manifest)).indexed.previousEngine);
  assert.equal(review.previousEngine,nativeReview.currentEngine);
  assert.equal(nativeReview.previousEngine,priorReview.currentEngine);
  assert.equal(priorReview.currentEngine,'46aba6e247567f5954d412e0988e3d2cd04e9ec154c294bdf3fcaa830d9d12f3');
  assert.equal(historical.engineDigest,priorReview.previousEngine);
  assert.equal(MIGRATION_063_ENGINE,historical.engineDigest);
  assert.equal(EVENT_REPLAY_UI_ENGINE,priorReview.currentEngine);
  assert.equal(EVENT_NATIVE_ROW_UI_ENGINE,nativeReview.currentEngine);
  assert.equal(EVENT_OPPONENT_SHORTCUT_UI_ENGINE,review.currentEngine);
  assert.deepEqual(review.changedAssets,['main.bundle.js']);
  assert.equal(review.trackPinsUnchanged,true);assert.equal(review.geometryPinsReusedBecausePhysicsAndTracksUnchanged,true);
  assert.deepEqual(review.unchangedPhysicsAssets,historical.unchangedPhysicsAssets);
});

import {PRE_GHOST_PROOF_ENGINE,hasAcceptedVerifiedProof} from '../src/verification.js';
import {compatibleEventEngine,EVENT_LAUNCH_ENGINE,EVENT_REPLAY_UI_ENGINE,EVENT_NATIVE_ROW_UI_ENGINE,EVENT_OPPONENT_SHORTCUT_UI_ENGINE,EVENT_INDEXED_PLAYBACK_ENGINE} from '../src/event-engine-compatibility.js';
const previousKey=JSON.parse(verificationKey(row));previousKey[1]=PRE_GHOST_PROOF_ENGINE;
const previous={...current,key:JSON.stringify(previousKey),engineDigest:PRE_GHOST_PROOF_ENGINE};
const reviewedGhostEngine='32bfe32b8680597d9f1322dbcbb19242be38bee9ab243a379f5e449c3f4030fd';
const proofFor=digest=>{const key=JSON.parse(verificationKey(row));key[1]=digest;return {...current,key:JSON.stringify(key),engineDigest:digest};};
const previousNative=proofFor(EVENT_NATIVE_ROW_UI_ENGINE),previousOpponent=proofFor(EVENT_OPPONENT_SHORTCUT_UI_ENGINE),previousIndexed=proofFor(EVENT_INDEXED_PLAYBACK_ENGINE);
const oldCurrent=proofFor(PRE_REPLAY_UI_PROOF_ENGINE),reviewedGhost=proofFor(reviewedGhostEngine),previousUi=proofFor(EVENT_REPLAY_UI_ENGINE);
test('reviewed previous exact physics proof survives bootstrap and supplies verified target',()=>{
 for(const proof of [oldCurrent,reviewedGhost,previous,previousUi,previousNative,previousOpponent,previousIndexed]) {
  assert.equal(verifiedVerdict(row,proof),true);
  assert.equal(bootstrapSlots(row.trackId,[row],{racer:proof}).racer,proof);
  assert.equal(verifiedTargetMs([row],{racer:proof}),19997);
  assert.equal(verifiedVerdict({...row,integrityVerified:false},proof),false);
  for(const status of ['waiting','unavailable','mismatch']) assert.equal(bootstrapSlots(row.trackId,[row],{racer:{...proof,status}}).racer.key,verificationKey(row));
 }
});
test('prior proof requires every exact run field and trusted verdict, never a client label',()=>{
 for(const proof of [oldCurrent,reviewedGhost,previous,previousUi,previousNative,previousOpponent,previousIndexed]) for(const change of [{accountId:'other'},{trackId:'c'.repeat(64)},{timeMs:19996},{frames:19996},{raceTimeFrames:19998},{uploadId:2},{replayHash:'d'.repeat(64)}]){
  const changed={...row,...change};assert.equal(verifiedVerdict(changed,proof),false,proof.engineDigest+JSON.stringify(change));
  if(changed.trackId===row.trackId) assert.equal(bootstrapSlots(row.trackId,[changed],{racer:proof})[changed.accountId].status,'waiting');
 }
 for(const proof of [oldCurrent,reviewedGhost,previous,previousUi,previousNative,previousOpponent,previousIndexed]) for(const change of [{status:'waiting'},{verifierVersion:'future'},{engineDigest:'f'.repeat(64)},{key:'untrusted'}])assert.equal(verifiedVerdict(row,{...proof,...change}),false);
 assert.equal(verifiedVerdict(row,{runVerified:true,verified:true}),false);
 assert.equal(verifiedVerdict(row,current),true);
});
async function importTransformedSource(source, sourceUrl) {
 // A data URL has no relative base. Real file URLs retain recursive helper imports.
 const linked=source.replace(/(\bfrom\s*)(['"])(\.[^'"]+)\2/g,
   (_match,prefix,_quote,specifier)=>prefix+JSON.stringify(new URL(specifier,sourceUrl).href));
 return import('data:text/javascript;base64,'+Buffer.from(linked).toString('base64'));
}

test('future repin cannot implicitly inherit proof or immutable-period compatibility',async()=>{
 const fs=await import('node:fs');const future='e'.repeat(64);
 const source=fs.readFileSync(new URL('../src/verification.js',import.meta.url),'utf8')
   .replace("import { EXTRA_TRACK_IDS } from './extra-track-ids.js';",'const EXTRA_TRACK_IDS = new Set();')
   .replace("export const VERIFIER_ENGINE_DIGEST = '"+VERIFIER_ENGINE_DIGEST+"'","export const VERIFIER_ENGINE_DIGEST = '"+future+"'");
 const module=await importTransformedSource(source,new URL('../src/verification.js',import.meta.url));
 for(const proof of [oldCurrent,reviewedGhost,previous,previousUi,previousNative,previousOpponent,previousIndexed,current])assert.equal(module.verifiedVerdict(row,proof),false);
 assert.equal(module.VERIFICATION_BOOTSTRAP_ID,'verification_snapshot_v3_'+VERIFIER_VERSION+'_'+future);
 const held={...pendingSlot(row),status:'unavailable',reason:'similar_replay_pending_manual_review',retryAt:Number.MAX_SAFE_INTEGER};
 assert.equal(module.bootstrapSlots(row.trackId,[row],{racer:held}).racer,held,'future repin loads the real hold guard');
 const compat=fs.readFileSync(new URL('../src/event-engine-compatibility.js',import.meta.url),'utf8').replace("import { VERIFIER_ENGINE_DIGEST } from './verification.js';","const VERIFIER_ENGINE_DIGEST = '"+future+"';");
 const next=await importTransformedSource(compat,new URL('../src/event-engine-compatibility.js',import.meta.url));
 for(const digest of [PRE_EVENT_LAUNCH_ENGINE,EVENT_LAUNCH_ENGINE,EVENT_REPLAY_UI_ENGINE,EVENT_NATIVE_ROW_UI_ENGINE,EVENT_OPPONENT_SHORTCUT_UI_ENGINE,EVENT_INDEXED_PLAYBACK_ENGINE,VERIFIER_ENGINE_DIGEST])assert.equal(next.compatibleEventEngine(digest),false);
 for(const digest of [PRE_EVENT_LAUNCH_ENGINE,EVENT_LAUNCH_ENGINE,EVENT_REPLAY_UI_ENGINE,EVENT_NATIVE_ROW_UI_ENGINE,EVENT_OPPONENT_SHORTCUT_UI_ENGINE,EVENT_INDEXED_PLAYBACK_ENGINE,VERIFIER_ENGINE_DIGEST])assert.equal(compatibleEventEngine(digest),true);
});
test('preserved previous approval is not permission for a new obsolete completion',async()=>{
 const {completedSlot}=await import('../../../tools/verifier/queue.mjs');
 for(const engineDigest of [PRE_REPLAY_UI_PROOF_ENGINE,reviewedGhostEngine,PRE_GHOST_PROOF_ENGINE,EVENT_REPLAY_UI_ENGINE,EVENT_NATIVE_ROW_UI_ENGINE,EVENT_OPPONENT_SHORTCUT_UI_ENGINE,EVENT_INDEXED_PLAYBACK_ENGINE])
  assert.throws(()=>completedSlot(pendingSlot(row),{status:'verified',engineDigest}),/engine pin mismatch/);
 assert.equal(completedSlot(pendingSlot(row),{status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST}).engineDigest,VERIFIER_ENGINE_DIGEST);
});

test('0.6.3 release gate binds all served assets and reviewed geometry',async()=>{
 const fs=await import('node:fs'),{snapshot}=await import('../../../tools/verifier/assets.cjs'),{fileURLToPath}=await import('node:url');
 const root=new URL('../../../',import.meta.url), actual=snapshot(fileURLToPath(root));
 const manifest=JSON.parse(fs.readFileSync(new URL('tools/verifier/engine-manifest.json',root),'utf8'));
 assert.equal(actual.engineFingerprint,VERIFIER_ENGINE_DIGEST);assert.deepEqual(actual.manifest,manifest.files);assert.deepEqual(actual.tracks,manifest.tracks);
 const review=JSON.parse(fs.readFileSync(new URL('docs/events/opponent-shortcut-ui-engine-review.json',root),'utf8'));
 const nativeReview=JSON.parse(fs.readFileSync(new URL('docs/events/native-row-ui-engine-review.json',root),'utf8'));
 const priorReview=JSON.parse(fs.readFileSync(new URL('docs/events/replay-ui-engine-review.json',root),'utf8'));
 const historical=JSON.parse(fs.readFileSync(new URL('docs/migration/engine-review.json',root),'utf8'));
 assert.equal(review.currentEngine,(await reviewedOpponentFiles(manifest)).indexed.previousEngine);assert.equal(review.previousEngine,nativeReview.currentEngine);
  assert.equal(nativeReview.previousEngine,priorReview.currentEngine);
 assert.equal(priorReview.previousEngine,historical.engineDigest);
 assert.deepEqual(review.unchangedPhysicsAssets,historical.unchangedPhysicsAssets);
 for(const [file,hash] of Object.entries(historical.unchangedPhysicsAssets))assert.equal(actual.manifest[file],hash);
});


test('opponent review proves two UI insertions are the entire bundle change and bootstrap alias is exact', async () => {
 const fs=await import('node:fs'),{createHash}=await import('node:crypto');
 const root=new URL('../../../',import.meta.url);
 const review=JSON.parse(fs.readFileSync(new URL('docs/events/opponent-shortcut-ui-engine-review.json',root),'utf8'));
 const sha=value=>createHash('sha256').update(value).digest('hex');
 let bundle=reviewedWatchUiBaseline(JSON.parse(fs.readFileSync(new URL('tools/verifier/engine-manifest.json',root),'utf8'))).bundle;
 const manifest=JSON.parse(fs.readFileSync(new URL('tools/verifier/engine-manifest.json',root),'utf8'));
 const geometry=JSON.parse(fs.readFileSync(new URL('tools/verifier/track-geometry.json',root),'utf8'));
 const opponentFiles=(await reviewedOpponentFiles(manifest)).files;
 const previousFiles={...opponentFiles,'main.bundle.js':review.previousMainBundleSha256};
 assert.equal(sha(JSON.stringify(previousFiles)),review.previousEngine,'all other engine file pins are unchanged');
 assert.equal(sha(fs.readFileSync(new URL(review.previousReview,root),'utf8').replace(/\r\n?/g,'\n')),review.previousReviewSha256,'prior review is immutable');
 assert.equal(sha(JSON.stringify(Object.entries(manifest.tracks).sort(([a],[b])=>a<b?-1:a>b?1:0))),review.trackPinsSha256);
 const geometryReview=JSON.parse(fs.readFileSync(new URL('docs/events/spite-geometry-review.json',root),'utf8'));
 const added=new Set(geometryReview.addedTracks.map(row=>row.id));
 assert.equal(sha(JSON.stringify(geometry.tracks.filter(row=>!added.has(row.id)))),review.geometryRowsSha256,'historical UI review geometry is unchanged');
 for(const [name,digest] of Object.entries(review.unchangedSimulationAssets))assert.equal(opponentFiles[name],digest);
 assert.equal(sha(bundle),review.currentMainBundleSha256);
 assert.equal(review.normalizedUiInsertions.length,2);
 assert.equal(review.previousEngine,EVENT_NATIVE_ROW_UI_ENGINE);
 assert.equal(review.previousReview,'docs/events/native-row-ui-engine-review.json');
 assert.equal(review.historicalBootstrapUnchanged,true);
 assert.match(review.normalizedUiInsertions[0],/^d\.dataset\.sqRecordingId=String\(l\),$/);
 assert.match(review.normalizedUiInsertions[1],/\.__pt062OpponentSelection=\{version:1,/);
 for(const insertion of review.normalizedUiInsertions){assert.equal(bundle.split(insertion).length,2);bundle=bundle.replace(insertion,'');}
 assert.equal(sha(bundle),review.previousMainBundleSha256);
 assert.equal(VERIFICATION_BOOTSTRAP_ID,'verification_snapshot_v3_'+VERIFIER_VERSION+'_46aba6e247567f5954d412e0988e3d2cd04e9ec154c294bdf3fcaa830d9d12f3');
});

test('later Spite geometry review adds exactly one bound exception without rewriting historical engine proof',async()=>{
 const fs=await import('node:fs'),{createHash}=await import('node:crypto');
 const root=new URL('../../../',import.meta.url),sha=value=>createHash('sha256').update(value).digest('hex');
 const proof=JSON.parse(fs.readFileSync(new URL('docs/events/spite-geometry-review.json',root),'utf8'));
 const geometry=JSON.parse(fs.readFileSync(new URL('tools/verifier/track-geometry.json',root),'utf8'));
 const priorText=fs.readFileSync(new URL('docs/events/opponent-shortcut-ui-engine-review.json',root),'utf8').replace(/\r\n?/g,'\n');
 assert.equal(proof.schemaVersion,1);
 const pin=JSON.parse(fs.readFileSync(new URL('tools/verifier/engine-manifest.json',root),'utf8'));
 assert.equal(proof.engineDigest,(await reviewedOpponentFiles(pin)).indexed.previousEngine);
 assert.equal(proof.previousReview,'docs/events/opponent-shortcut-ui-engine-review.json');assert.equal(sha(priorText),proof.previousReviewSha256);
 assert.equal(proof.previousGeometryRowsSha256,JSON.parse(priorText).geometryRowsSha256);
 const id='60e247f90d43ecaa8b56a4677307094ab0259f36151af23e09fdc824741d3e48';
 assert.deepEqual(proof.addedTracks,[{id,name:'trusted/'+id+'.track',hash:'a6ccd78cc443cd848a41da11d94904d2fffb7647d0ecafca64562eb53480ea2b',parts:28470,spanX:656,spanZ:516,displayName:'Spite'}]);
 assert.deepEqual(geometry.tracks.filter(row=>row.id===id),proof.addedTracks);
 assert.equal(sha(JSON.stringify(geometry.tracks.filter(row=>row.id!==id))),proof.previousGeometryRowsSha256);
 assert.equal(sha(JSON.stringify(geometry.tracks)),proof.currentGeometryRowsSha256);
 assert.equal(sha(fs.readFileSync(new URL('tools/verifier/geometry.cjs',root),'utf8').replace(/\r\n?/g,'\n')),proof.geometryValidatorSha256);
});


test('native-row event periods stay usable while fresh completions require the new opponent UI pin', async () => {
 const {createEventService,EVENT_COLLECTIONS:C}=await import('../src/events.js');
 const {createHash}=await import('node:crypto'),{deflateSync}=await import('node:zlib');
 const data=new Map();
 const store={transaction:async fn=>{
   const copy=structuredClone(data);
   const result=await fn({get:async key=>structuredClone(copy.get(key)||null),
     create:(key,value)=>{assert.ok(!copy.has(key));copy.set(key,structuredClone(value));},
     set:(key,value)=>copy.set(key,structuredClone(value)),
     patch:(key,value)=>copy.set(key,structuredClone({...copy.get(key),...value})),delete:key=>copy.delete(key)});
   data.clear();for(const [key,value] of copy)data.set(key,value);return result;
 }};
 const account='b'.repeat(64),track='a'.repeat(64);let now=0,nonce=0;
 data.set(C.profiles+'/'+account,{accountId:account,ownerUid:'owner',name:'Racer'});
 const service=createEventService({store,now:()=>now,hash:value=>createHash('sha256').update(value).digest('hex'),randomId:()=> 'lease_'+nonce++});
 await service.bindOwner('owner',account);
 await service.createPeriod({id:'day1',enabled:true,trackId:track,startsAt:1000,endsAt:86401000,graceMs:3600000,targetMs:10000,maxRp:1000,
   eligibility:'best-submitted-during-period',capacity:{policyVersion:'test-reviewed-v1',entrants:200,admissionsPerPeriod:512,replayBytesPerPeriod:8388608,minIntervalMs:1000,verificationsPerDay:128}});
 data.get(C.periods+'/day1').engineDigest=EVENT_NATIVE_ROW_UI_ENGINE;
 const periodBefore=structuredClone(data.get(C.periods+'/day1'));now=1000;
 await service.snapshot('day1');
 const submitted=await service.submit('day1','owner',{accountId:account,trackId:track,attemptId:'first',timeMs:20402,frames:20402,replay:deflateSync(Buffer.alloc(15)).toString('base64url'),carStyle:''});
 const [job]=await service.leaseJobs('day1');assert.ok(job);
 const verdict=digest=>({status:'verified',resultId:job.resultId,trackId:job.trackId,timeMs:job.timeMs,replayHash:job.replayHash,engineDigest:digest,
   binding:{resultId:job.resultId,trackId:job.trackId,nativeTrackId:job.trackId,timeMs:job.timeMs,replayHash:job.replayHash,actualReplayHash:job.replayHash,engineDigest:digest,verifierVersion:VERIFIER_VERSION}});
 for(const digest of [EVENT_INDEXED_PLAYBACK_ENGINE,EVENT_OPPONENT_SHORTCUT_UI_ENGINE,EVENT_NATIVE_ROW_UI_ENGINE,EVENT_REPLAY_UI_ENGINE,PRE_REPLAY_UI_PROOF_ENGINE]){
   const before=JSON.stringify([...data]);
   await assert.rejects(service.completeJob('day1',job,verdict(digest)),/verifier_proof_mismatch/);
   assert.equal(JSON.stringify([...data]),before,'an obsolete completion cannot publish any state');
 }
 await service.completeJob('day1',job,verdict(VERIFIER_ENGINE_DIGEST));
 assert.equal(data.get(C.runs+'/'+submitted.runId).status,'verified');
 assert.deepEqual(data.get(C.periods+'/day1'),periodBefore,'immutable old period binding is retained');
});

test('indexed review chain rejects changed assets and fabricated prior restoration',async()=>{const fs=await import('node:fs');const manifest=JSON.parse(fs.readFileSync(new URL('../../../tools/verifier/engine-manifest.json',import.meta.url),'utf8'));for(const [name,value]of [['simulation_worker.bundle.js','f'.repeat(64)],['main.bundle.js','f'.repeat(64)],['polytrack_physics.wasm','f'.repeat(64)]])await assert.rejects(reviewedOpponentFiles({...manifest,files:{...manifest.files,[name]:value}}));});

test('Watch review binds the exact guard edit, current playback pin and immutable indexed baseline', async () => {
 const fs=await import('node:fs'),{PLAYBACK_ENGINE_PIN}=await import('../../../tools/playback-engine-pin.mjs');
 const root=new URL('../../../',import.meta.url);
 const manifest=JSON.parse(fs.readFileSync(new URL('tools/verifier/engine-manifest.json',root),'utf8'));
 const baseline=reviewedWatchUiBaseline(manifest);
 assert.equal(baseline.review.currentEngine,VERIFIER_ENGINE_DIGEST);
 assert.equal(baseline.review.previousEngine,EVENT_INDEXED_PLAYBACK_ENGINE);
 assert.equal(baseline.review.bootstrapId,VERIFICATION_BOOTSTRAP_ID);
 assert.equal(PLAYBACK_ENGINE_PIN.engineDigest,VERIFIER_ENGINE_DIGEST);
 assert.equal(PLAYBACK_ENGINE_PIN.mainSha256,manifest.files['main.bundle.js']);
 assert.equal(PLAYBACK_ENGINE_PIN.workerSha256,manifest.files['simulation_worker.bundle.js']);
 assert.deepEqual(Object.keys(manifest.files).filter(file=>manifest.files[file]!==baseline.files[file]),['main.bundle.js']);
});

test('Watch review rejects extra edits, altered evidence, geometry and track pins', async () => {
 const fs=await import('node:fs'),root=new URL('../../../',import.meta.url);
 const read=file=>fs.readFileSync(new URL(file,root),'utf8').replace(/\r\n?/g,'\n');
 const manifest=JSON.parse(read('tools/verifier/engine-manifest.json'));
 const review=JSON.parse(read('docs/events/watch-limit-ui-engine-review.json'));
 const geometry=JSON.parse(read('tools/verifier/track-geometry.json'));
 for(const options of [
   {bundle:read('main.bundle.js')+' '},
   {bundle:read('main.bundle.js')+review.normalizedUiReplacement.after},
   {previousReviewText:read(review.previousReview)+' '},
   {review:{...review,previousAssets:{'main.bundle.js':'f'.repeat(64)}}},
   {review:{...review,normalizedUiReplacement:{...review.normalizedUiReplacement,before:'unreviewed'}}},
   {geometry:{...geometry,tracks:geometry.tracks.slice(1)}},
   {geometry:{...geometry,engineDigest:review.previousEngine}}
 ])assert.throws(()=>reviewedWatchUiBaseline(manifest,options));
 assert.throws(()=>reviewedWatchUiBaseline({...manifest,tracks:{...manifest.tracks,unreviewed:'f'.repeat(64)}}));
 assert.throws(()=>reviewedWatchUiBaseline({...manifest,engineDigest:review.previousEngine}));
});

test('actual native Event Watch bridge accepts one through ten ghosts and preserves context guards', async () => {
 const fs=await import('node:fs'),vm=await import('node:vm');
 const bundle=fs.readFileSync(new URL('../../../main.bundle.js',import.meta.url),'utf8');
 const matches=[...bundle.matchAll(/__pt062EventWatch=\{version:1,trackId:u,(open:ghosts=>\{if\([\s\S]*?;y\(ghosts\)\})\}/g)];
 assert.equal(matches.length,1,'exactly one actual native Watch bridge');
 assert.match(matches[0][1],/!ghosts\.length\|\|ghosts\.length>10\)throw Error/);
 const state={closed:false,isConnected:true};let opened;
 const bridge=vm.runInNewContext('({'+matches[0][1]+'})',{
   R:{gn:(_owner,key)=>key==='closed'?state.closed:state},Sl:'closed',gl:'root',y:ghosts=>{opened=ghosts;}
 });
 for(let count=1;count<=10;count++){
   const ghosts=Array.from({length:count},(_,i)=>({recordingId:i+1}));
   opened=null;bridge.open(ghosts);assert.equal(opened,ghosts);
 }
 for(const ghosts of [[],Array(11).fill({}),null,{},'ghosts']){
   opened=null;assert.throws(()=>bridge.open(ghosts),/Event replay context changed/);assert.equal(opened,null);
 }
 for(const change of [{closed:true},{isConnected:false}]){
   Object.assign(state,{closed:false,isConnected:true},change);
   opened=null;assert.throws(()=>bridge.open([{}]),/Event replay context changed/);assert.equal(opened,null);
 }
});
