import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {createLedgerEntry,ledgerBinding,ledgerKey,writeLedger,readLedger,nativePolicyFingerprint} from './native-verification-ledger.mjs';
import {APPROVED_COMPLETED_NATIVE_PACKAGING as approved,validateCompletedNativePackagingEvidence,assertCompletedPackagingCohort,recoverApprovedCompletedNativePackaging,withCompletedPackagingTransportFence} from './completed-native-packaging-recovery.mjs';

const sha=value=>createHash('sha256').update(value).digest('hex');
const encode=value=>Buffer.from(JSON.stringify(value)+'\n');
const root=fileURLToPath(new URL('..',import.meta.url));
let project=path.resolve(root);while(path.basename(project).toLowerCase()!=='ranked-0.6.3'){const next=path.dirname(project);assert.notEqual(next,project);project=next;}
const testParent=path.join(project,'local-reports','completed-packaging-tests');
async function temporary(t){
  await fs.mkdir(testParent,{recursive:true});const directory=await fs.mkdtemp(path.join(testParent,'synthetic-'));
  t.after(async()=>{assert.equal(path.dirname(directory),testParent);await fs.rm(directory,{recursive:true,force:true});});return directory;
}
const track=sha('synthetic-track'),engine=sha('synthetic-engine'),fingerprint=sha('synthetic-verifier'),content=sha('synthetic-content');
const geometry={parts:1,spanX:10,spanZ:20};
const policy={engineDigest:engine,compatibleEngines:[],verifierVersion:'synthetic-bounded-v1',verifierFingerprint:fingerprint,
  resourceProfiles:['standard'],reviewPolicyVersions:['synthetic-review-v1'],trackContentHashes:{[track]:content},
  trackGeometries:{[track]:{geometryPolicy:'default',trackGeometry:geometry}}};
function proof(number){
  const replay='synthetic-not-physics-'+number,accountId=sha('account-'+number);
  const job={lane:'normal',accountId,trackId:track,timeMs:1000+number,frames:1000+number,uploadId:number,replayHash:sha(replay),replay,resultId:accountId+'_'+track};
  const binding={verifierVersion:policy.verifierVersion,verifierFingerprint:fingerprint,resourceProfile:'standard',resultId:job.resultId,
    trackId:track,timeMs:job.timeMs,replayHash:job.replayHash,actualReplayHash:sha(replay),nativeTrackId:track,trackContentHash:content,engineDigest:engine};
  const result={resultId:job.resultId,trackId:track,timeMs:job.timeMs,replayHash:job.replayHash,status:'verified',reason:'native_exact_finish',
    deterministic:true,engineDigest:engine,trackContentHash:content,geometryPolicy:'default',trackGeometry:geometry,binding,boundInputFingerprint:sha(JSON.stringify(binding))};
  return {job,entry:createLedgerEntry({job,result,nativeResult:result,review:{complete:true,disposition:'approved',bindingKey:ledgerKey(ledgerBinding(job)),
    policyVersion:policy.reviewPolicyVersions[0],attestationHash:sha('synthetic-review-'+number)},verifiedAt:Date.now()-10000,policy})};
}
async function fixture(t){
  const directory=await temporary(t),previous=proof(1),fresh=proof(2),deferred=proof(3);
  const oldLedger=writeLedger({root:path.join(directory,'old'),entries:[previous.entry],expectedManifestHash:null});
  const completedLedger=writeLedger({root:path.join(directory,'completed'),entries:[previous.entry,fresh.entry],expectedManifestHash:null});
  const sourceBinding={sourceCommit:'a'.repeat(40),captureSha256:sha('synthetic-capture')};
  const scoringPreflight={sourceSha256:sha('synthetic-scoring'),additionalFirestoreReads:0,additionalFirestoreWrites:0,sourceTracks:1,sourceRows:3};
  const counts={known:3,verified:2,held:0,excluded:0,mismatch:0,unavailable:0,unprocessed:1,reusedPhysics:1,nativeDispatched:1,nativeBatches:1};
  const decisions=[previous,fresh,deferred].map(({job},index)=>({key:ledgerKey(ledgerBinding(job)),binding:ledgerBinding(job),
    status:index===2?'unprocessed':'verified',reason:index===2?'native_budget':'native_exact_finish'}));
  const baseline={generation:76,indexSha256:sha('synthetic-public-index'),ledgerManifestHash:oldLedger.manifestHash,ledgerEntries:1};
  const common={sourceBinding,ledgerManifestHash:completedLedger.manifestHash,previousLedgerManifestHash:oldLedger.manifestHash,counts,decisions,
    engineDigest:engine,verifierFingerprint:fingerprint,policySha256:nativePolicyFingerprint(policy),scoringPreflight,
    sourceCoverage:{scope:'current-captured-board-bindings',knownBindings:3,availableBindings:3,missingBindings:0,complete:true,gaps:[]}};
  const evidence={schemaVersion:1,offlineOnly:true,...structuredClone(common),complete:false,
    eligibleKeys:decisions.filter(d=>d.status==='verified').map(d=>d.key),authority:false,kind:'private-native-phase-evidence',timings:{verificationMs:1}};
  const checkpoint={schemaVersion:1,kind:'private-native-proof-checkpoint',authority:false,sourceBinding:{...sourceBinding},
    ledgerManifestHash:completedLedger.manifestHash,previousLedgerManifestHash:oldLedger.manifestHash,evidenceFile:'verification.json',evidenceSha256:sha(encode(evidence))};
  const receipt={schemaVersion:1,authority:false,kind:'completed-in-process-native-verification',...structuredClone(common),verificationComplete:false,
    privateProofCheckpoint:{directory:path.join(directory,'completed-checkpoint'),...structuredClone(checkpoint)}};
  const prepared={schemaVersion:1,kind:'prepared-public-offline-verification',authority:false,sourceCommit:sourceBinding.sourceCommit,
    publishedBaseline:baseline,maxJobs:16,maxRuntimeMs:480000,backendReads:0,backendWrites:0,
    preflight:{authority:'stored-proof-overlay',backendReads:0,backendWrites:0,ledgerManifestHash:oldLedger.manifestHash,sourceBinding:{...sourceBinding},
      scoringPreflight:structuredClone(scoringPreflight),counts:{nativeDispatched:0,newProofs:0,storedProofs:1}}};
  const terminal={status:1,signal:null,timedOut:false};
  const pins={receiptSha256:sha(encode(receipt)),terminalResultSha256:sha(encode(terminal)),sourceBinding,ledgerManifestHash:completedLedger.manifestHash,completedLedgerEntries:2,
    publishedBaseline:structuredClone(baseline),scoringSha256:scoringPreflight.sourceSha256,maxJobs:16,maxRuntimeMs:480000,counts:structuredClone(counts)};
  const input=()=>({verifiedBytes:encode(receipt),preparedBytes:encode(prepared),checkpointBytes:encode(checkpoint),evidenceBytes:encode(evidence),terminalBytes:encode(terminal),
    oldLedger,completedLedger,currentPolicy:structuredClone(policy)});
  const relink=()=>{checkpoint.evidenceSha256=sha(encode(evidence));Object.assign(receipt.privateProofCheckpoint,checkpoint);pins.receiptSha256=sha(encode(receipt));};
  return {directory,receipt,prepared,checkpoint,evidence,terminal,pins,input,relink,oldLedger,completedLedger,previous,fresh};
}

test('synthetic completed bounded result with deferred jobs validates without physics or new authority',async t=>{
  const f=await fixture(t),result=validateCompletedNativePackagingEvidence(f.input(),f.pins);
  assert.equal(result.authority,false);assert.equal(result.receipt.verificationComplete,false);
  assert.equal(result.receipt.counts.nativeDispatched,1);assert.equal(result.receipt.counts.unprocessed,1);
  assert.equal(readLedger({root:path.join(f.directory,'old'),expectedManifestHash:f.oldLedger.manifestHash}).entries.length,1);
});
test('fixed recovery approval is immutable and pins the exact actual completed result',()=>{
  assert.equal(approved.receiptSha256,'8bd167277b1e4bc294839e39c6b80fec3c293d8b4c2bc1e279db271c6ebfa1d4');
  assert.equal(approved.publishedBaseline.ledgerEntries,4358);assert.equal(approved.completedLedgerEntries,5569);
  assert.equal(approved.counts.nativeDispatched,1211);assert.equal(approved.counts.reusedPhysics,3884);assert.equal(approved.counts.unprocessed,8236);
  assert.throws(()=>{approved.sourceBinding.sourceCommit='b'.repeat(40);},TypeError);
});
test('terminal supervisor receipt rejects altered bytes, signals and timeout even with a relinked synthetic pin',async t=>{
  const f=await fixture(t);f.terminal.timedOut=true;assert.throws(()=>validateCompletedNativePackagingEvidence(f.input(),f.pins),/terminal supervisor/);
  for(const terminal of [{status:0,signal:null,timedOut:false},{status:null,signal:'SIGKILL',timedOut:false},{status:1,signal:null,timedOut:true}]){
    const input=f.input();input.terminalBytes=encode(terminal);const pins={...f.pins,terminalResultSha256:sha(input.terminalBytes)};
    assert.throws(()=>validateCompletedNativePackagingEvidence(input,pins),/not confirmed terminal/);
  }
});
for(const [name,change]of [
  ['source commit',f=>{f.receipt.sourceBinding.sourceCommit='b'.repeat(40);}],
  ['capture binding',f=>{f.receipt.sourceBinding.captureSha256=sha('other');}],
  ['new ledger hash',f=>{f.receipt.ledgerManifestHash=sha('other');}],
  ['old ledger hash',f=>{f.receipt.previousLedgerManifestHash=sha('other');}],
  ['native counts',f=>{f.receipt.counts.nativeDispatched++;}],
  ['interrupted receipt kind',f=>{f.receipt.kind='verification-interrupted';}],
  ['interrupted receipt phase',f=>{f.receipt.phase='verification-interrupted';}],
  ['authority claim',f=>{f.receipt.authority=true;}],
  ['missing completion marker',f=>{delete f.receipt.verificationComplete;}]
])test('rejects changed approved receipt '+name,async t=>{
  const f=await fixture(t);change(f);f.relink();assert.throws(()=>validateCompletedNativePackagingEvidence(f.input(),f.pins));
});
for(const [name,change]of [
  ['baseline',f=>{f.prepared.publishedBaseline.indexSha256=sha('other');}],
  ['prepared source',f=>{f.prepared.sourceCommit='b'.repeat(40);}],
  ['prepared reads',f=>{f.prepared.backendReads=1;}],
  ['prepared writes',f=>{f.prepared.backendWrites=1;}],
  ['preflight physics',f=>{f.prepared.preflight.counts.nativeDispatched=1;}],
  ['preflight new proof',f=>{f.prepared.preflight.counts.newProofs=1;}],
  ['preflight ledger count',f=>{f.prepared.preflight.counts.storedProofs=2;}],
  ['budget',f=>{f.prepared.maxRuntimeMs++;}],
  ['scoring capture',f=>{f.prepared.preflight.scoringPreflight.sourceSha256=sha('other');}],
  ['checkpoint receipt',f=>{f.checkpoint.ledgerManifestHash=sha('other');}],
  ['checkpoint evidence bytes',f=>{f.evidence.timings.verificationMs++;}]
])test('rejects independently altered '+name,async t=>{
  const f=await fixture(t);change(f);assert.throws(()=>validateCompletedNativePackagingEvidence(f.input(),f.pins));
});
for(const [name,change]of [
  ['interrupted evidence',f=>{f.evidence.phase='verification-interrupted';}],
  ['failed evidence kind',f=>{f.evidence.kind='verification-interrupted';}],
  ['nonoffline evidence',f=>{f.evidence.offlineOnly=false;}],
  ['evidence authority',f=>{f.evidence.authority=true;}],
  ['evidence source',f=>{f.evidence.sourceBinding.captureSha256=sha('other');}],
  ['evidence counts',f=>{f.evidence.counts.verified++;}],
  ['truncated decisions',f=>{f.evidence.decisions.pop();}],
  ['missing eligible proof',f=>{f.evidence.eligibleKeys.pop();}],
  ['duplicate eligible proof',f=>{f.evidence.eligibleKeys.push(f.evidence.eligibleKeys[0]);}],
  ['policy claim',f=>{f.evidence.policySha256=sha('other');}],
  ['completion conflict',f=>{f.evidence.complete=true;}]
])test('rejects relinked but inconsistent '+name,async t=>{
  const f=await fixture(t);change(f);f.relink();assert.throws(()=>validateCompletedNativePackagingEvidence(f.input(),f.pins));
});
test('rejects a changed current policy without forging engine compatibility',async t=>{
  const f=await fixture(t);
  for(const change of [p=>{p.engineDigest=sha('new engine');},p=>{p.verifierFingerprint=sha('new verifier');},
    p=>{p.compatibleEngines.push(sha('old engine'));},p=>{p.trackContentHashes[track]=sha('other track');},p=>{p.reviewPolicyVersions=['other-review'];}]){
    const input=f.input();change(input.currentPolicy);assert.throws(()=>validateCompletedNativePackagingEvidence(input,f.pins),/current compiler policy/);
  }
});
test('rejects missing old proofs and unauthorized new proof keys',async t=>{
  const f=await fixture(t),input=f.input();input.completedLedger=structuredClone(f.completedLedger);
  input.completedLedger.entries=input.completedLedger.entries.filter(e=>e.key!==f.previous.entry.key);input.completedLedger.entries.push(proof(4).entry);
  assert.throws(()=>validateCompletedNativePackagingEvidence(input,f.pins),/lost or altered public proofs/);
  const second=f.input();second.completedLedger=structuredClone(f.completedLedger);second.completedLedger.entries.push(proof(4).entry);
  assert.throws(()=>validateCompletedNativePackagingEvidence(second,{...f.pins,completedLedgerEntries:3}),/unapproved proof/);
});
test('rejects missing/duplicate completed decisions even if receipt and checkpoint are relinked',async t=>{
  const f=await fixture(t);f.receipt.decisions[1]=structuredClone(f.receipt.decisions[0]);f.evidence.decisions=structuredClone(f.receipt.decisions);f.relink();
  assert.throws(()=>validateCompletedNativePackagingEvidence(f.input(),f.pins),/decision binding/);
});
test('ledger transport remains hash-checked by the existing branded reader',async t=>{
  const f=await fixture(t),directory=path.join(f.directory,'completed'),manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json')));
  const shard=path.join(directory,'shards',manifest.shards[0].hash+'.json');await fs.appendFile(shard,' ');
  assert.throws(()=>readLedger({root:directory,expectedManifestHash:f.completedLedger.manifestHash}),/shard hash/);
});

function cohort(pins){return {authority:'stored-proof-overlay',backendReads:0,backendWrites:0,ledgerManifestHash:pins.ledgerManifestHash,
  sourceBinding:{...pins.sourceBinding},scoringPreflight:{sourceSha256:pins.scoringSha256,additionalFirestoreReads:0,additionalFirestoreWrites:0},
  counts:{nativeDispatched:0,newProofs:0,storedProofs:pins.completedLedgerEntries},complete:false};}
test('packaging cohort accepts bounded incompleteness but no new physics or DB usage',()=>{
  assert.equal(assertCompletedPackagingCohort(cohort(approved)),true);
  for(const change of [r=>{r.backendReads=1;},r=>{r.backendWrites=1;},r=>{r.counts.nativeDispatched=1;},r=>{r.counts.newProofs=1;},r=>{r.counts.storedProofs--;},
    r=>{r.scoringPreflight.additionalFirestoreReads=1;},r=>{r.normal={additionalFirestoreWrites:1};},r=>{r.authority='snapshot-native';},
    r=>{r.sourceBinding.captureSha256=sha('changed');},r=>{r.ledgerManifestHash=sha('changed');}]){
    const value=cohort(approved);change(value);assert.throws(()=>assertCompletedPackagingCohort(value));
  }
});

function options(directory){return {root,completedRunDirectory:directory,recoveryDirectory:path.join(directory+'-recovery'),
  sourceCommit:approved.sourceBinding.sourceCommit,compilerSourceCommit:'b'.repeat(40),receiptSha256:approved.receiptSha256,
  terminalResultSha256:approved.terminalResultSha256,
  publishedBaseline:structuredClone(approved.publishedBaseline)};}
for(const name of ['verify','captureContext','ledgerRoot','buildPolicy','capture','hydrate','proofCheckpoint','publicationRoot','nativeResult','expectedReceiptOverride'])
test('recovery entry rejects callback or alternate authority option '+name,async t=>{
  const directory=await temporary(t);await assert.rejects(recoverApprovedCompletedNativePackaging({...options(directory),[name]:()=>assert.fail('not invoked')}),/unknown or missing/);
});
test('recovery entry rejects capabilities argument and arbitrary receipt approvals',async t=>{
  const directory=await temporary(t),input=options(directory);
  await assert.rejects(recoverApprovedCompletedNativePackaging(input,{}),/one plain/);
  await assert.rejects(recoverApprovedCompletedNativePackaging({...input,receiptSha256:sha('arbitrary checkpoint')}),/exact receipt/);
  await assert.rejects(recoverApprovedCompletedNativePackaging({...input,sourceCommit:'b'.repeat(40)}),/exact receipt/);
  await assert.rejects(recoverApprovedCompletedNativePackaging({...input,publishedBaseline:{...input.publishedBaseline,indexSha256:sha('other')}}),/public baseline/);
});
test('existing recovery directory is rejected before reading evidence or launching source verification',async t=>{
  const directory=await temporary(t),input=options(directory);input.recoveryDirectory=path.join(directory,'existing');await fs.mkdir(input.recoveryDirectory);
  // Disjointness itself is also mandatory: an existing child of the run is never a destination.
  await assert.rejects(recoverApprovedCompletedNativePackaging(input),/overlapping/);
  input.completedRunDirectory=path.join(directory,'original');input.recoveryDirectory=path.join(directory,'existing');await fs.mkdir(input.completedRunDirectory);
  await assert.rejects(recoverApprovedCompletedNativePackaging(input),/already exists/);
});
test('synthetic or changed receipt bytes cannot start the exact real recovery',async t=>{
  const directory=await temporary(t),run=path.join(directory,'original');await fs.mkdir(run);await fs.writeFile(path.join(run,'verified.json'),'{}\n');
  const input=options(run);input.recoveryDirectory=path.join(directory,'not-created');
  await assert.rejects(recoverApprovedCompletedNativePackaging(input),/receipt SHA/);
  await assert.rejects(fs.lstat(input.recoveryDirectory),{code:'ENOENT'});
});
test('source enforces old-context-first, exact ledger substitution, original pins and explicit no-native callbacks',async()=>{
  const source=await fs.readFile(new URL('./completed-native-packaging-recovery.mjs',import.meta.url),'utf8');
  assert(source.indexOf('const context=await prepareNativeSnapshotCapture')<source.indexOf("path.join(recovery,'approved-completed-ledger')"));
  assert.match(source,/captureContext:\{\.\.\.context,ledger,ledgerRoot\}/);
  assert.match(source,/reuseOnly:true/);assert.match(source,/expectedCaptureSha256:pins\.sourceBinding\.captureSha256/);
  assert.match(source,/expectedScoringSha256:pins\.scoringSha256/);
  assert.match(source,/verify:forbiddenNative,validateEngine:forbiddenNative,reviewFactory:forbiddenNative,proofCheckpoint:forbiddenNative/);
  assert.match(source,/compilerSourceCommit:options\.compilerSourceCommit/);assert.match(source,/assertBoundedLocalSource/);
  assert.match(source,/await fs\.mkdir\(recovery,\{mode:0o700\}\)/);assert.doesNotMatch(source,/execFile|publishLocalCaptureCommit|hydrateStaging|verifyNativeSnapshotPhase/);
  const enter=source.indexOf('const cohort=await withCompletedPackagingTransportFence('),leave=source.indexOf('},usage);',enter);
  assert(source.indexOf('await checkCompiler();')<enter);
  assert(source.lastIndexOf('await checkCompiler();')>leave);
  assert.doesNotMatch(source.slice(enter,leave),/checkCompiler\(|assertBoundedLocalSource/);
});

for(const fails of [false,true])test('transport fence restores all APIs after '+(fails?'failure':'success'),async()=>{
  const targets=[[globalThis,'fetch'],[http,'request'],[http,'get'],[https,'request'],[https,'get'],[net,'connect'],[net,'createConnection'],[tls,'connect'],[net.Socket.prototype,'connect']];
  const previous=targets.map(([object,key])=>object[key]),usage={networkAttempts:0};
  const action=withCompletedPackagingTransportFence(async()=>{
    await Promise.resolve();
    for(const [object,key]of targets)assert.throws(()=>object[key](),/forbids transport/);
    if(fails)throw Error('synthetic packaging failed');return 'packaged';
  },usage);
  if(fails)await assert.rejects(action,/synthetic packaging failed/);else assert.equal(await action,'packaged');
  assert.equal(usage.networkAttempts,targets.length);
  targets.forEach(([object,key],index)=>assert.equal(object[key],previous[index]));
});
test('captured helper connection alias is blocked only inside fence, without any real pipe connection',async t=>{
  let localConnections=0;
  // The supervisor captures createConnection at import. Its Socket.connect call
  // still sees the fence. This mock guarantees no actual IPC or OS probe.
  t.mock.method(net.Socket.prototype,'connect',function(){localConnections++;return this;});
  const capturedCreateConnection=net.createConnection,usage={networkAttempts:0};
  await withCompletedPackagingTransportFence(async()=>{
    assert.throws(()=>capturedCreateConnection({path:'synthetic-private-control-pipe'}),/forbids transport/);
    assert.equal(localConnections,0);
  },usage);
  const socket=capturedCreateConnection({path:'synthetic-private-control-pipe'});socket.destroy();
  assert.equal(localConnections,1);assert.equal(usage.networkAttempts,1);
});
