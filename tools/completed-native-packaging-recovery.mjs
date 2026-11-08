import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import {cloneBounded} from './bounded-clone.mjs';
import {readLedger,ledgerBinding,ledgerKey,ledgerDisposition,nativePolicyFingerprint} from './native-verification-ledger.mjs';
import {buildNativeVerificationPolicy} from './native-verification-policy.mjs';
import {prepareNativeSnapshotCapture,runNativeSnapshotPhase} from './native-snapshot-phase.mjs';
import {nativeLedgerPublicationFiles,withOfflineVerification} from './verifier/local-snapshot-verification.mjs';
import {loadTrustedPublishedEventTotalsBaseline} from './published-event-totals-baseline.mjs';
import {assertBoundedLocalSource} from './local-capture-git.mjs';
import {PUBLIC_76_VERIFICATION_BASELINE} from './public-offline-verification.mjs';

const HASH=/^[a-f0-9]{64}$/,COMMIT=/^[a-f0-9]{40}$/;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const demand=(ok,message)=>{if(!ok)throw Error('Completed packaging recovery: '+message);};
const freeze=value=>{if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
export const APPROVED_COMPLETED_NATIVE_PACKAGING=freeze({
  receiptSha256:'8bd167277b1e4bc294839e39c6b80fec3c293d8b4c2bc1e279db271c6ebfa1d4',
  terminalResultSha256:'7ee617cbb86b9efb8d17572f5cbfe6b03156c877c63f4c8060c82a82168acfa5',
  sourceBinding:{sourceCommit:'aacaea1d036a0a18c299f0ccb7b88830d49184f8',captureSha256:'af4dc37433726d86943d66e778038ce7ef4757eddd3e6bb9ab61bf84312050b0'},
  ledgerManifestHash:'a6ec5883724a60fc266eaffb6c2ead5e49d2b48952df41ee7d8d61b8fa921df6',
  completedLedgerEntries:5569,publishedBaseline:{...PUBLIC_76_VERIFICATION_BASELINE},
  scoringSha256:'ba152cb9b89112ad673a71304617d978e3a1b67ce4bf77131f6bb76139934bec',
  maxJobs:10000,maxRuntimeMs:1500000,
  counts:{known:13471,verified:5095,held:0,excluded:0,mismatch:0,unavailable:140,unprocessed:8236,
    reusedPhysics:3884,nativeDispatched:1211,nativeBatches:99}
});
const equal=(actual,expected,message)=>demand(isDeepStrictEqual(actual,expected),message);
const parse=bytes=>{try{return JSON.parse(bytes);}catch{throw Error('Completed packaging recovery: invalid JSON evidence');}};
const validCount=value=>Number.isSafeInteger(value)&&value>=0;

/** Pure consistency check, not an admission capability. Synthetic pins are useful
 * for tests; the recovery entry point below accepts ONLY the fixed approval. */
export function validateCompletedNativePackagingEvidence({verifiedBytes,preparedBytes,checkpointBytes,evidenceBytes,terminalBytes,
  oldLedger,completedLedger,currentPolicy},pins){
  demand(pins&&HASH.test(pins.receiptSha256||'')&&sha(verifiedBytes)===pins.receiptSha256,'completed receipt SHA mismatch');
  demand(HASH.test(pins.terminalResultSha256||'')&&sha(terminalBytes)===pins.terminalResultSha256,'terminal supervisor result SHA mismatch');
  equal(parse(terminalBytes),{status:1,signal:null,timedOut:false},'original supervised run is not confirmed terminal after compilation failure');
  const receipt=parse(verifiedBytes),prepared=parse(preparedBytes),checkpoint=parse(checkpointBytes),evidence=parse(evidenceBytes);
  demand(receipt.schemaVersion===1&&receipt.kind==='completed-in-process-native-verification'&&receipt.authority===false&&
    !Object.hasOwn(receipt,'phase')&&typeof receipt.verificationComplete==='boolean','normal completed bounded receipt required');
  equal(receipt.sourceBinding,pins.sourceBinding,'completed source binding mismatch');
  demand(receipt.ledgerManifestHash===pins.ledgerManifestHash&&receipt.previousLedgerManifestHash===pins.publishedBaseline.ledgerManifestHash,'completed ledger chain mismatch');
  equal(receipt.counts,pins.counts,'approved native counts changed');
  const counts=receipt.counts;
  demand(Object.values(counts).every(validCount)&&counts.known<=100000&&counts.nativeDispatched<=pins.maxJobs&&
    counts.known===counts.verified+counts.held+counts.excluded+counts.mismatch+counts.unavailable+counts.unprocessed&&
    counts.reusedPhysics<=counts.verified&&counts.nativeBatches<=counts.nativeDispatched,'invalid bounded native counts');
  demand(prepared.schemaVersion===1&&prepared.kind==='prepared-public-offline-verification'&&prepared.authority===false&&
    prepared.sourceCommit===pins.sourceBinding.sourceCommit&&prepared.maxJobs===pins.maxJobs&&prepared.maxRuntimeMs===pins.maxRuntimeMs&&
    prepared.backendReads===0&&prepared.backendWrites===0,'prepared source or usage mismatch');
  equal(prepared.publishedBaseline,pins.publishedBaseline,'prepared public baseline mismatch');
  equal(prepared.preflight?.sourceBinding,pins.sourceBinding,'prepared capture mismatch');
  demand(prepared.preflight?.authority==='stored-proof-overlay'&&prepared.preflight.backendReads===0&&prepared.preflight.backendWrites===0&&
    prepared.preflight.ledgerManifestHash===pins.publishedBaseline.ledgerManifestHash&&
    prepared.preflight.counts?.nativeDispatched===0&&prepared.preflight.counts.newProofs===0&&
    prepared.preflight.counts.storedProofs===pins.publishedBaseline.ledgerEntries,'public preflight authority or usage mismatch');
  equal(receipt.scoringPreflight,prepared.preflight.scoringPreflight,'prepared scoring evidence mismatch');
  demand(receipt.scoringPreflight?.sourceSha256===pins.scoringSha256&&receipt.scoringPreflight.additionalFirestoreReads===0&&
    receipt.scoringPreflight.additionalFirestoreWrites===0,'scoring source or usage mismatch');
  const linked=receipt.privateProofCheckpoint;
  demand(linked&&typeof linked.directory==='string','linked completed checkpoint required');
  const {directory,...linkedReceipt}=linked;
  equal(checkpoint,linkedReceipt,'linked checkpoint receipt mismatch');
  demand(checkpoint.schemaVersion===1&&checkpoint.kind==='private-native-proof-checkpoint'&&checkpoint.authority===false&&
    checkpoint.evidenceFile==='verification.json'&&HASH.test(checkpoint.evidenceSha256||'')&&sha(evidenceBytes)===checkpoint.evidenceSha256,
    'checkpoint evidence hash or kind mismatch');
  equal(checkpoint.sourceBinding,pins.sourceBinding,'checkpoint source mismatch');
  demand(checkpoint.ledgerManifestHash===pins.ledgerManifestHash&&checkpoint.previousLedgerManifestHash===pins.publishedBaseline.ledgerManifestHash,'checkpoint ledger chain mismatch');
  demand(evidence.schemaVersion===1&&evidence.kind==='private-native-phase-evidence'&&evidence.authority===false&&evidence.offlineOnly===true&&
    !Object.hasOwn(evidence,'phase')&&evidence.complete===receipt.verificationComplete,'interrupted or incomplete evidence transport');
  for(const key of ['sourceBinding','ledgerManifestHash','previousLedgerManifestHash','counts','decisions','engineDigest','verifierFingerprint','policySha256','scoringPreflight','sourceCoverage'])
    equal(evidence[key],receipt[key],'completed checkpoint evidence differs: '+key);
  demand(HASH.test(receipt.engineDigest||'')&&HASH.test(receipt.verifierFingerprint||'')&&HASH.test(receipt.policySha256||'')&&
    currentPolicy.engineDigest===receipt.engineDigest&&currentPolicy.verifierFingerprint===receipt.verifierFingerprint&&
    nativePolicyFingerprint(currentPolicy)===receipt.policySha256,'current compiler policy differs from completed proofs');
  demand(oldLedger.manifestHash===pins.publishedBaseline.ledgerManifestHash&&oldLedger.entries.length===pins.publishedBaseline.ledgerEntries&&
    completedLedger.manifestHash===pins.ledgerManifestHash&&completedLedger.entries.length===pins.completedLedgerEntries,'pinned ledger hash or entry count mismatch');
  const entries=new Map(completedLedger.entries.map(entry=>[entry.key,entry])),old=new Map(oldLedger.entries.map(entry=>[entry.key,entry]));
  for(const entry of old.values()){
    const next=entries.get(entry.key);demand(next&&isDeepStrictEqual(next.binding,entry.binding)&&
      entry.witnesses.every(witness=>next.witnesses.some(value=>isDeepStrictEqual(value,witness))),'completed ledger lost or altered public proofs');
  }
  demand(Array.isArray(receipt.decisions)&&receipt.decisions.length===counts.known,'incomplete completed decision evidence');
  const seen=new Set(),eligible=new Set(),tally={verified:0,held:0,excluded:0,mismatch:0,unavailable:0,unprocessed:0};
  for(const decision of receipt.decisions){
    demand(HASH.test(decision?.key||'')&&!seen.has(decision.key)&&Object.hasOwn(tally,decision.status)&&
      decision.key===ledgerKey(ledgerBinding(decision.binding))&&typeof decision.reason==='string'&&decision.reason.length<=128,'invalid completed decision binding');
    seen.add(decision.key);tally[decision.status]++;
    if(decision.status==='verified'){
      const entry=entries.get(decision.key);demand(entry&&isDeepStrictEqual(entry.binding,ledgerBinding(decision.binding))&&ledgerDisposition(entry)==='verified','verified decision lacks approved exact proof');
      eligible.add(decision.key);
      demand(entry.witnesses.some(w=>w.review.disposition==='approved'&&[currentPolicy.engineDigest,...currentPolicy.compatibleEngines].includes(w.engineDigest)&&
        w.verifierVersion===currentPolicy.verifierVersion&&w.verifierFingerprint===currentPolicy.verifierFingerprint&&
        currentPolicy.resourceProfiles.includes(w.resourceProfile)&&currentPolicy.reviewPolicyVersions.includes(w.review.policyVersion)&&
        currentPolicy.trackContentHashes[entry.binding.trackId]===w.trackContentHash&&
        isDeepStrictEqual(currentPolicy.trackGeometries[entry.binding.trackId],{geometryPolicy:w.geometryPolicy,trackGeometry:w.trackGeometry})),
      'verified decision lacks current-policy proof');
    }
  }
  for(const [key,value]of Object.entries(tally))demand(value===counts[key],'decision counts mismatch');
  demand(Array.isArray(evidence.eligibleKeys)&&evidence.eligibleKeys.length===eligible.size&&new Set(evidence.eligibleKeys).size===eligible.size&&
    evidence.eligibleKeys.every(key=>eligible.has(key)),'eligible proof set mismatch');
  for(const entry of entries.values())if(!old.has(entry.key)||entry.witnesses.some(w=>!old.get(entry.key).witnesses.some(previous=>isDeepStrictEqual(w,previous))))
    demand(eligible.has(entry.key),'completed ledger adds an unapproved proof');
  return {authority:false,receipt,checkpoint,prepared};
}

export function assertCompletedPackagingCohort(cohort,pins=APPROVED_COMPLETED_NATIVE_PACKAGING){
  demand(cohort?.authority==='stored-proof-overlay'&&cohort.backendReads===0&&cohort.backendWrites===0&&
    cohort.ledgerManifestHash===pins.ledgerManifestHash&&cohort.counts?.nativeDispatched===0&&cohort.counts.newProofs===0&&
    cohort.counts.storedProofs===pins.completedLedgerEntries,
    'recovery attempted new authority, native work or backend usage');
  equal(cohort.sourceBinding,pins.sourceBinding,'recovery capture binding changed');
  demand(cohort.scoringPreflight?.sourceSha256===pins.scoringSha256,'recovery scoring binding changed');
  const visit=value=>{if(!value||typeof value!=='object')return;for(const [key,item]of Object.entries(value)){
    if(['backendReads','backendWrites','additionalFirestoreReads','additionalFirestoreWrites','nativeDispatched','newProofs'].includes(key))demand(item===0,'nonzero recovery usage: '+key);
    else visit(item);
  }};visit(cohort);return true;
}

const inside=(root,file)=>{const relative=path.relative(root,file);return !relative||relative!=='..'&&!relative.startsWith('..'+path.sep)&&!path.isAbsolute(relative);};
async function safeDirectory(directory){
  demand(path.isAbsolute(directory||''),'absolute local directory required');
  const absolute=path.resolve(directory);let cursor=path.parse(absolute).root;
  for(const name of path.relative(cursor,absolute).split(path.sep).filter(Boolean)){
    cursor=path.join(cursor,name);const stat=await fs.lstat(cursor);demand(stat.isDirectory()&&!stat.isSymbolicLink(),'directory link or non-directory');
  }
  equal((await fs.realpath(absolute)).toLowerCase(),absolute.toLowerCase(),'noncanonical directory');return absolute;
}
async function bytes(root,relative,limit=16*1024*1024){
  demand(/^[A-Za-z0-9._/-]+$/.test(relative)&&relative.split('/').every(part=>part&&part!=='.'&&part!=='..'),'unsafe evidence path');
  const file=path.join(root,...relative.split('/'));await safeDirectory(path.dirname(file));
  const stat=await fs.lstat(file,{bigint:true});demand(stat.isFile()&&!stat.isSymbolicLink()&&stat.nlink===1n&&stat.size<=BigInt(limit),'unsafe or oversized evidence file');
  const data=await fs.readFile(file),after=await fs.lstat(file,{bigint:true});
  demand(data.length===Number(stat.size)&&stat.dev===after.dev&&stat.ino===after.ino&&stat.mtimeNs===after.mtimeNs&&stat.ctimeNs===after.ctimeNs,'evidence changed during read');return data;
}
async function copyLedger(source,destination,expected){
  readLedger({root:source,expectedManifestHash:expected});await cloneBounded({source,destination});
  return readLedger({root:destination,expectedManifestHash:expected});
}
async function published(root,pins){
  const pointer=parse(await bytes(root,'snapshot-current.json',2048));
  demand(pointer.currentdir==='public-snapshots'+pins.generation,'public generation changed');
  demand(sha(await bytes(root,pointer.currentdir+'/index.json'))===pins.indexSha256,'public index changed');
  await nativeLedgerPublicationFiles(root);
  const pointerBytes=await bytes(root,'verification-ledger-current.json',2048),ledgerPointer=parse(pointerBytes);
  demand(ledgerPointer.manifestHash===pins.ledgerManifestHash,'public ledger changed');
  const ledger=readLedger({root:path.join(root,'verification-ledger'),expectedManifestHash:pins.ledgerManifestHash});
  demand(ledger.entries.length===pins.ledgerEntries,'public ledger entry count changed');return {ledger,pointerBytes};
}

/** Transport fence only, never a proof or recovery capability. Source-check IPC
 * must finish before entry and resume only after this function has restored it. */
export async function withCompletedPackagingTransportFence(task,usage={networkAttempts:0}){
  demand(typeof task==='function'&&validCount(usage.networkAttempts),'invalid transport-fence task or counter');
  const restores=[];const deny=()=>{usage.networkAttempts++;throw Error('Completed packaging recovery forbids transport');};
  const patch=(object,key)=>{const previous=object[key];object[key]=deny;restores.push(()=>{object[key]=previous;});};
  try{
    patch(globalThis,'fetch');
    for(const [object,names]of [[http,['request','get']],[https,['request','get']],[net,['connect','createConnection']],[tls,['connect']],[net.Socket.prototype,['connect']]])for(const name of names)patch(object,name);
    return await task();
  }finally{for(const restore of restores.reverse())restore();}
}

/** One explicitly approved completed result, not a generic checkpoint importer.
 * No capabilities argument, CLI, capture, verification or publication callback.
 * The only writes are to an exclusive NEW recovery directory. */
export async function recoverApprovedCompletedNativePackaging(options){
  demand(arguments.length===1&&options&&Object.getPrototypeOf(options)===Object.prototype,'one plain recovery options object required');
  const allowed=['root','completedRunDirectory','recoveryDirectory','sourceCommit','compilerSourceCommit','receiptSha256','terminalResultSha256','publishedBaseline'];
  demand(Object.keys(options).length===allowed.length&&Object.keys(options).every(key=>allowed.includes(key)),'unknown or missing recovery option');
  const pins=APPROVED_COMPLETED_NATIVE_PACKAGING;
  demand(options.receiptSha256===pins.receiptSha256&&options.terminalResultSha256===pins.terminalResultSha256&&
    options.sourceCommit===pins.sourceBinding.sourceCommit&&COMMIT.test(options.compilerSourceCommit||''),'independent exact receipt/source pins required');
  equal(options.publishedBaseline,pins.publishedBaseline,'independent approved public baseline pins required');
  const root=await safeDirectory(options.root),completedRun=await safeDirectory(options.completedRunDirectory);
  const moduleRoot=await safeDirectory(fileURLToPath(new URL('..',import.meta.url)));equal(root.toLowerCase(),moduleRoot.toLowerCase(),'compiler must execute from its own pinned source root');
  const parent=await safeDirectory(path.dirname(options.recoveryDirectory||'')),recovery=path.join(parent,path.basename(options.recoveryDirectory));
  demand(path.isAbsolute(options.recoveryDirectory)&&!inside(root,recovery)&&!inside(recovery,root)&&!inside(completedRun,recovery)&&!inside(recovery,completedRun)&&
    !inside(root,completedRun)&&!inside(completedRun,root),'overlapping recovery/source roots');
  let project=root;while(path.basename(project).toLowerCase()!=='ranked-0.6.3'){const next=path.dirname(project);demand(next!==project,'checked project ancestry required');project=next;}
  demand(path.basename(path.dirname(project)).toLowerCase()==='projects'&&path.basename(path.dirname(path.dirname(project))).toLowerCase()==='polytrack'&&
    inside(project,completedRun)&&inside(project,recovery),'recovery material must stay in this PolyTrack project');
  try{await fs.lstat(recovery);throw Error('Completed packaging recovery: exclusive recovery directory already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
  const verifiedBytes=await bytes(completedRun,'verified.json');demand(sha(verifiedBytes)===pins.receiptSha256,'completed receipt SHA mismatch');
  const terminalDirectory=path.dirname(completedRun),terminalBytes=await bytes(terminalDirectory,'offline-supervisor-v3.json',2048);
  const verified=parse(verifiedBytes),checkpoint=verified.privateProofCheckpoint;
  demand(checkpoint&&typeof checkpoint.directory==='string','linked checkpoint required');
  const checkpointParent=path.join(completedRun,'local-reports','native-proof-checkpoints');
  demand(path.dirname(checkpoint.directory).toLowerCase()===checkpointParent.toLowerCase()&&/^completed-[A-Za-z0-9_-]+$/.test(path.basename(checkpoint.directory)),'unapproved checkpoint path');
  const checkpointDirectory=await safeDirectory(checkpoint.directory);
  const preparedBytes=await bytes(completedRun,'prepared.json'),checkpointBytes=await bytes(checkpointDirectory,'receipt.json',8192),evidenceBytes=await bytes(checkpointDirectory,'verification.json');
  const sourceCandidate=await safeDirectory(path.join(completedRun,'candidate'));
  const publicBefore=await published(root,pins.publishedBaseline);
  const approvedSource=path.join(checkpointDirectory,'ledger');
  const approvedLedger=readLedger({root:approvedSource,expectedManifestHash:pins.ledgerManifestHash});
  const currentPolicy=buildNativeVerificationPolicy({root,entries:approvedLedger.entries});
  validateCompletedNativePackagingEvidence({verifiedBytes,preparedBytes,checkpointBytes,evidenceBytes,terminalBytes,oldLedger:publicBefore.ledger,completedLedger:approvedLedger,currentPolicy},pins);
  const checkCompiler=()=>withOfflineVerification(()=>assertBoundedLocalSource({workspace:root,sourceCommit:options.compilerSourceCommit,
    runnerFile:path.join(root,'tools/local-overnight-capture.mjs'),deadline:Date.now()+120000}));
  await checkCompiler();
  // Never remove a failed recovery directory or touch the original run. An
  // operator may inspect it; another attempt needs a different exclusive name.
  await fs.mkdir(recovery,{mode:0o700});
  await copyLedger(path.join(root,'verification-ledger'),path.join(recovery,'verification-ledger'),pins.publishedBaseline.ledgerManifestHash);
  await fs.writeFile(path.join(recovery,'verification-ledger-current.json'),publicBefore.pointerBytes,{flag:'wx',mode:0o600});
  const directory=path.join(recovery,'candidate');await cloneBounded({source:sourceCandidate,destination:directory});
  const usage={networkAttempts:0,nativeAttempts:0};
  const forbiddenNative=()=>{usage.nativeAttempts++;throw Error('Completed packaging recovery forbids all native work and new proof checkpoints');};
  const cohort=await withCompletedPackagingTransportFence(async()=>{
    // Establish the original PUBLIC context first. Its old CAS anchor and
    // retained admissions are never reconstructed from private completed proofs.
    const context=await prepareNativeSnapshotCapture({root,directory});
    demand(context.rootManifestHash===pins.publishedBaseline.ledgerManifestHash&&context.ledger.entries.length===pins.publishedBaseline.ledgerEntries,'original public capture context changed');
    const ledgerRoot=path.join(recovery,'approved-completed-ledger');
    const ledger=await copyLedger(approvedSource,ledgerRoot,pins.ledgerManifestHash);
    const totals=await loadTrustedPublishedEventTotalsBaseline({root,expectedGeneration:pins.publishedBaseline.generation,expectedIndexSha256:pins.publishedBaseline.indexSha256});
    const result=await runNativeSnapshotPhase({root,publicationRoot:recovery,directory,sourceCommit:pins.sourceBinding.sourceCommit,
      captureContext:{...context,ledger,ledgerRoot},publishedEventTotalsBaseline:totals,reuseOnly:true,
      expectedCaptureSha256:pins.sourceBinding.captureSha256,expectedScoringSha256:pins.scoringSha256,
      verify:forbiddenNative,validateEngine:forbiddenNative,reviewFactory:forbiddenNative,proofCheckpoint:forbiddenNative});
    demand(usage.networkAttempts===0&&usage.nativeAttempts===0,'recovery guard was invoked');assertCompletedPackagingCohort(result,pins);return result;
  },usage);
  await checkCompiler();await published(root,pins.publishedBaseline);
  await nativeLedgerPublicationFiles(recovery);
  demand(readLedger({root:path.join(recovery,'verification-ledger'),expectedManifestHash:pins.ledgerManifestHash}).entries.length===pins.completedLedgerEntries,'recovery ledger cohort changed');
  demand(nativePolicyFingerprint(buildNativeVerificationPolicy({root,entries:approvedLedger.entries}))===verified.policySha256,'current compiler policy changed during packaging');
  equal(await bytes(completedRun,'prepared.json'),preparedBytes,'prepared evidence changed during packaging');
  equal(await bytes(checkpointDirectory,'receipt.json',8192),checkpointBytes,'checkpoint receipt changed during packaging');
  demand(sha(await bytes(completedRun,'verified.json'))===pins.receiptSha256&&sha(await bytes(checkpointDirectory,'verification.json'))===checkpoint.evidenceSha256&&
    sha(await bytes(terminalDirectory,'offline-supervisor-v3.json',2048))===pins.terminalResultSha256,'completed inputs changed during packaging');
  const result={schemaVersion:1,kind:'approved-completed-native-packaging-recovery',authority:false,receiptSha256:pins.receiptSha256,
    sourceBinding:{...pins.sourceBinding},compilerSourceCommit:options.compilerSourceCommit,terminalResultSha256:pins.terminalResultSha256,
    originalVerificationComplete:verified.verificationComplete,originalNativeCounts:{...pins.counts},policySha256:verified.policySha256,
    newPhysics:0,backendReads:0,backendWrites:0,usage,directory,publicationRoot:recovery,cohort};
  await fs.writeFile(path.join(recovery,'recovery-receipt.json'),JSON.stringify(result)+'\n',{flag:'wx',mode:0o600,flush:true});
  return result;
}
