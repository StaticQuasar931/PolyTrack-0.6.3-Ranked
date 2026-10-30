import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {ledgerBinding, ledgerKey, createLedgerEntry, readLedger, writeLedger,
  applyLedgerToBoard, ledgerDisposition} from '../native-verification-ledger.mjs';
import {buildNativeVerificationPolicy} from '../native-verification-policy.mjs';

const require = createRequire(import.meta.url);
const {checkJob,resourceLimits} = require('./replay.cjs');
const HASH = /^[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const demand = (value,message) => {if (!value) throw Error('Local snapshot verification: '+message);};
const positive = value => Number.isSafeInteger(value) && value > 0;
const freeze = value => {if(value && typeof value === 'object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;};
let active = false;

export function verificationAuthority(value) {
  const mode = value === undefined || value === '' ? 'firestore' : value;
  demand(['firestore','snapshot-native'].includes(mode),'invalid authority mode');
  return mode;
}

/** Checked-in activation is parent-owned. An absent GitHub variable inherits it;
 * a missing legacy-fixture config is not permission to downgrade a native site.
 */
export async function readRepositoryVerificationAuthority(root, override) {
  demand(typeof root === 'string' && path.isAbsolute(root),'absolute authority root required');
  if (override !== undefined && override !== '') return verificationAuthority(override);
  const file=path.join(root,'tools/verification-authority.json');
  let value;
  try {
    const stat=await fs.lstat(file);
    demand(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 2048,'invalid authority config file');
    value=JSON.parse(await fs.readFile(file,'utf8'));
  } catch(error) {
    if (error.code !== 'ENOENT') throw error;
    const nativeMarker=await fs.lstat(path.join(root,'verification-ledger-current.json')).then(()=>true,error=>{
      if(error.code === 'ENOENT')return false;throw error;
    });
    demand(!nativeMarker,'native ledger exists without explicit repository authority config');
    return 'firestore';
  }
  demand(value && !Array.isArray(value) && Object.keys(value).sort().join('|') === 'mode|schemaVersion' &&
    value.schemaVersion === 1 && ['firestore','snapshot-native'].includes(value.mode),'invalid authority config schema');
  return value.mode;
}

/** Exact Git publication set. Never glob a writer's private/temporary files. */
export async function nativeLedgerPublicationFiles(root) {
  demand(typeof root==='string'&&path.isAbsolute(root),'absolute publication root required');
  const pointerFile=path.join(root,'verification-ledger-current.json'),stat=await fs.lstat(pointerFile);
  demand(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=2048,'invalid ledger pointer file');
  const pointer=JSON.parse(await fs.readFile(pointerFile,'utf8'));
  demand(pointer&&Object.keys(pointer).sort().join('|')==='directory|manifestHash|schemaVersion'&&
    pointer.schemaVersion===1&&pointer.directory==='verification-ledger'&&HASH.test(pointer.manifestHash||''),'invalid ledger pointer schema');
  const ledgerRoot=path.join(root,pointer.directory);
  const locked=await fs.lstat(path.join(ledgerRoot,'.writer.lock')).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
  demand(!locked,'ledger writer still active');
  readLedger({root:ledgerRoot,expectedManifestHash:pointer.manifestHash});
  const bytes=await fs.readFile(path.join(ledgerRoot,'manifest.json'));
  demand(digest(bytes)===pointer.manifestHash,'ledger changed while preparing publication');
  const manifest=JSON.parse(bytes);
  return ['verification-ledger-current.json','verification-ledger/manifest.json',
    ...manifest.shards.map(value=>'verification-ledger/shards/'+value.hash+'.json')];
}

/** Capture must finish first. Credentials are deliberately NOT restored after
 * this phase. A parent process must not capture concurrently with this guard.
 * Native browser children use verify.cjs's own scrubbed environment/local assets.
 */
export async function withOfflineVerification(task, {env=process.env}={}) {
  demand(!active,'offline verification already active');
  demand(typeof task === 'function','offline task required');
  active = true;
  const originalFetch = globalThis.fetch;
  try {
    for (const scope of new Set([process.env,env])) for (const key of Object.keys(scope)) {
      if (/^(?:FIREBASE_|GOOGLE_APPLICATION_CREDENTIALS$|GOOGLE_(?:ACCESS_TOKEN|OAUTH_ACCESS_TOKEN)$)/i.test(key)) delete scope[key];
    }
    globalThis.fetch = () => {throw Error('Offline native verification forbids fetch');};
    return await task();
  } finally {globalThis.fetch=originalFetch;active=false;}
}

function exactResults(jobs, results) {
  demand(Array.isArray(results) && results.length === jobs.length,'incomplete native/review result set');
  const wanted = new Map(jobs.map(job=>[job.resultId,job])), found = new Map();
  for (const result of results) {
    const job = wanted.get(result?.resultId);
    demand(job && !found.has(result.resultId) && result.trackId === job.trackId &&
      result.timeMs === job.timeMs && result.replayHash === job.replayHash,'native/review result binding');
    found.set(result.resultId,result);
  }
  return found;
}

function restoredPhysics(entry, job, policy) {
  if (!entry) return null;
  // This only chooses a reuse candidate. Kepler validates the full native and
  // current review witness again before it can become authority or be applied.
  const witness = entry.witnesses.find(w=>w.engineDigest === policy.engineDigest &&
    w.verifierVersion === policy.verifierVersion && w.verifierFingerprint === policy.verifierFingerprint &&
    w.resourceProfile === (job.resourceProfile || 'standard') &&
    policy.resourceProfiles.includes(w.resourceProfile) && policy.trackContentHashes[job.trackId] === w.trackContentHash &&
    isDeepStrictEqual(policy.trackGeometries[job.trackId],{geometryPolicy:w.geometryPolicy,trackGeometry:w.trackGeometry}));
  if (!witness) return null;
  const binding = {verifierVersion:witness.verifierVersion,verifierFingerprint:witness.verifierFingerprint,
    resourceProfile:witness.resourceProfile,resultId:job.resultId,trackId:job.trackId,timeMs:job.timeMs,
    replayHash:job.replayHash,actualReplayHash:digest(job.replay),nativeTrackId:job.trackId,
    trackContentHash:witness.trackContentHash,engineDigest:witness.engineDigest};
  return {resultId:job.resultId,trackId:job.trackId,timeMs:job.timeMs,replayHash:job.replayHash,
    status:'verified',reason:'native_exact_finish',deterministic:true,engineDigest:witness.engineDigest,
    trackContentHash:witness.trackContentHash,geometryPolicy:witness.geometryPolicy,
    trackGeometry:structuredClone(witness.trackGeometry),binding,boundInputFingerprint:digest(JSON.stringify(binding))};
}

async function defaultEngine({root,policy}) {
  const {VERIFIER_ENGINE_DIGEST,VERIFIER_VERSION}=await import('../../workers/ranked/src/verification.js');
  const {sameHashMap}=require('./engine-pin.cjs');
  const manifest=JSON.parse(await fs.readFile(path.join(root,'tools/verifier/engine-manifest.json'),'utf8'));
  const engine=require('./assets.cjs').snapshot(root);
  demand(engine.engineFingerprint === VERIFIER_ENGINE_DIGEST && manifest.engineDigest === VERIFIER_ENGINE_DIGEST &&
    sameHashMap(engine.tracks,manifest.tracks) && policy.engineDigest === VERIFIER_ENGINE_DIGEST &&
    policy.verifierVersion === VERIFIER_VERSION && policy.verifierFingerprint === require('./verify.cjs').verifierFingerprint,
    'current pinned engine/policy mismatch');
}
function nativeGroups(jobs) {
  const groups=[];
  for (const job of jobs) {
    const profile=job.resourceProfile || 'standard',last=groups.at(-1);
    if (profile === 'standard' && last?.profile === profile && last.jobs.length < 16) last.jobs.push(job);
    else groups.push({profile,jobs:[job]});
  }
  return groups;
}
export async function verifyLocalNativeBatch(root,jobs,tracks,{deadline=Infinity,verifyBatch}={}) {
  const verify=verifyBatch || require('./verify.cjs').verifyBatch,output=new Map();
  for (const group of nativeGroups(jobs)) {
    const results=await verify(root,group.jobs,tracks,{profile:group.profile,deadline});
    demand(Array.isArray(results) && results.length === group.jobs.length,'incomplete native adapter result set');
    const mapped=new Map(results.map(value=>[value?.resultId,value]));
    for (const [index,job] of group.jobs.entries()) {
      const result=mapped.get(job.resultId) || results[index];
      // An unavailable native asset may have no usable track/result metadata.
      // Normalize only the negative decision, never a positive proof witness.
      output.set(job.resultId,result?.status === 'unavailable'
        ? {...result,resultId:job.resultId,trackId:job.trackId,timeMs:job.timeMs,replayHash:job.replayHash}
        : result);
    }
  }
  return jobs.map(job=>output.get(job.resultId));
}

/** Node-only orchestration AFTER replay export, BEFORE final ranking/package.
 * jobs are the parent's independently hydrated exact current source bindings;
 * sourceBinding pins that frozen capture, not the mutable staged output.
 * policy/review are mandatory trusted caller capabilities. The review adapter
 * must compare against the whole captured field, including cross-batch peers.
 * It receives current batch jobs, allJobs, immutable native results and ledger,
 * and returns {complete:true,results:[...],reviews:[Kepler review attestations]}.
 * No board is changed here. Parent applies ledger/decisions and rebuilds once.
 */
export async function verifyLocalSnapshot({root, jobs, allJobs, sourceBinding, ledgerRoot, expectedManifestHash,
  policy:providedPolicy, buildPolicy=buildNativeVerificationPolicy, review, verify=verifyLocalNativeBatch, validateEngine=defaultEngine, trustedTracks=[],
  maxJobs=512, batchSize=16, maxRuntimeMs=480000, packReserveMs=60000, now=Date.now, env=process.env,
  onProgress=()=>{}}={}) {
  return withOfflineVerification(async()=>{
    demand(typeof root === 'string' && path.isAbsolute(root),'absolute repository root required');
    demand(typeof ledgerRoot === 'string' && path.isAbsolute(ledgerRoot),'absolute ledger root required');
    demand(sourceBinding && SHA.test(sourceBinding.sourceCommit || '') && HASH.test(sourceBinding.captureSha256 || ''),'pinned capture/source binding required');
    demand(Object.keys(sourceBinding).every(key=>['sourceCommit','captureSha256'].includes(key)),'unexpected source binding fields');
    demand(expectedManifestHash === null || HASH.test(expectedManifestHash || ''),'explicit ledger manifest trust anchor required');
    demand(Array.isArray(jobs) && jobs.length <= 100000,'bounded source jobs required');
    demand(typeof review === 'function','completed clone/review adapter required');
    demand(positive(maxJobs) && maxJobs <= 100000 && positive(batchSize) && batchSize <= 16 &&
      positive(maxRuntimeMs) && maxRuntimeMs <= 1500000 && Number.isSafeInteger(packReserveMs) &&
      packReserveMs >= 0 && packReserveMs < maxRuntimeMs,'invalid native budget');
    const startedAt=now(); demand(positive(startedAt),'invalid clock');
    const current = freeze(structuredClone(jobs)), keys=new Set(), ids=new Set(),inputUnavailable=new Map();
    const field=allJobs===undefined?current:freeze(structuredClone(allJobs));
    demand(Array.isArray(field)&&field.length<=100000,'bounded complete review inventory required');
    const fieldBindings=new Map();
    for(const job of field) {
      const key=ledgerKey(ledgerBinding(job));
      demand(!fieldBindings.has(key)&&typeof job.replay==='string'&&digest(job.replay)===job.replayHash,'complete review inventory binding');
      fieldBindings.set(key,job);
    }
    let replayBytes=0;
    for (const job of current) {
      const binding=ledgerBinding(job),key=ledgerKey(binding);
      demand(!keys.has(key) && !ids.has(job.resultId),'duplicate source identity');
      demand(job.resultId === (binding.lane === 'normal' ? binding.accountId+'_'+binding.trackId : binding.runId),'source result identity');
      demand(typeof job.replay === 'string' && digest(job.replay) === binding.replayHash,'source replay bytes/hash');
      demand(isDeepStrictEqual(fieldBindings.get(key),job),'target is not an exact member of full review inventory');
      replayBytes+=Buffer.byteLength(job.replay);
      demand(replayBytes <= 64*1024*1024,'source replay byte budget');
      try {checkJob(job,job.resourceProfile || 'standard');}
      catch(error) {inputUnavailable.set(job.resultId,String(error.reason || 'unsupported_resource_profile').slice(0,128));}
      keys.add(key);ids.add(job.resultId);
    }
    let ledger=expectedManifestHash === null ? null : readLedger({root:ledgerRoot,expectedManifestHash});
    let policy=providedPolicy ?? await buildPolicy({root,jobs:current,entries:ledger?.entries || []});
    // Pin checks happen before proof use or any native dispatch.
    await validateEngine({root,policy});
    ledger ||= writeLedger({root:ledgerRoot,entries:[],expectedManifestHash:null});
    // Use the ledger's policy validator rather than inventing a second one.
    applyLedgerToBoard({board:{entries:[]},ledger,canonicalRows:[],recordings:[],policy});
    const originalLedgerHash=ledger.manifestHash;
    const decisions=[],counts={known:current.length,verified:0,held:0,excluded:0,mismatch:0,unavailable:0,
      unprocessed:0,reusedPhysics:0,nativeDispatched:0,nativeBatches:0};
    const entries=new Map(ledger.entries.map(entry=>[entry.key,entry]));
    const observed=[];
    let cursor=0;
    while (cursor < current.length && now()-startedAt < maxRuntimeMs-packReserveMs) {
      const selected=current.slice(cursor,cursor+batchSize), native=[],raw=new Map();
      for (const job of selected) {
        if (Array.isArray(policy.knownTrackIds) && !policy.knownTrackIds.includes(job.trackId)) {
          raw.set(job.resultId,{resultId:job.resultId,trackId:job.trackId,timeMs:job.timeMs,replayHash:job.replayHash,
            status:'unavailable',reason:'missing_trusted_track'});
          continue;
        }
        if (inputUnavailable.has(job.resultId)) {
          raw.set(job.resultId,{resultId:job.resultId,trackId:job.trackId,timeMs:job.timeMs,replayHash:job.replayHash,
            status:'unavailable',reason:inputUnavailable.get(job.resultId)});
          continue;
        }
        const reused=restoredPhysics(entries.get(ledgerKey(ledgerBinding(job))),job,policy);
        if (reused) {raw.set(job.resultId,reused);counts.reusedPhysics++;}
        else if (counts.nativeDispatched+native.length < maxJobs &&
          maxRuntimeMs-(now()-startedAt) >= resourceLimits(job.resourceProfile || 'standard').wallMs+10000+packReserveMs) native.push(job);
      }
      for (const group of nativeGroups(native)) {
        const allowance=resourceLimits(group.profile).wallMs+10000+packReserveMs;
        if (maxRuntimeMs-(now()-startedAt) < allowance) continue;
        let results;
        try {results=await verify(root,structuredClone(group.jobs),structuredClone(trustedTracks),
          {profile:group.profile,deadline:performance.now()+maxRuntimeMs-(now()-startedAt)-packReserveMs});}
        catch {
          results=group.jobs.map(job=>({resultId:job.resultId,trackId:job.trackId,timeMs:job.timeMs,
            replayHash:job.replayHash,status:'unavailable',reason:'native_adapter_unavailable'}));
        }
        for (const [id,result] of exactResults(group.jobs,results)) raw.set(id,result);
        observed.push(...results);
        counts.nativeDispatched+=group.jobs.length;counts.nativeBatches++;
      }
      if (!providedPolicy && native.length) {
        policy=await buildPolicy({root,jobs:current,results:observed,entries:ledger.entries});
        await validateEngine({root,policy});
      }
      let ready=selected.filter(job=>raw.has(job.resultId));
      const nativeResults=ready.map(job=>structuredClone(raw.get(job.resultId)));
      let reviewed=await review({jobs:structuredClone(ready),allJobs:field,
        nativeResults:structuredClone(nativeResults),ledger,sourceBinding:structuredClone(sourceBinding),policy});
      if (reviewed?.complete === false) {
        const bounded=value=>typeof value==='string'&&/^(?:captured_controls_(?:coverage_incomplete|runtime_limit|pair_limit|event_limit|posting_limit|pair_work_limit|finding_limit|input_limit)|clone_review_incomplete)/.test(value);
        const partial=Array.isArray(reviewed.incomplete)&&reviewed.incomplete.length>0&&reviewed.incomplete.every(value=>bounded(value.reason));
        demand(bounded(reviewed.reason)||partial,'catastrophic clone/review failure');
        let incomplete=null;
        if(Array.isArray(reviewed.incompleteKeys)) {
          demand(reviewed.incompleteKeys.every(key=>HASH.test(key)&&fieldBindings.has(key)),'unknown incomplete review binding');
          incomplete=new Set(reviewed.incompleteKeys);
        }
        for (const job of ready.filter(job=>!incomplete||incomplete.has(ledgerKey(ledgerBinding(job))))) {
          counts.unavailable++;
          decisions.push({key:ledgerKey(ledgerBinding(job)),binding:ledgerBinding(job),status:'unavailable',
            reason:String(reviewed.reason || reviewed.incomplete?.find(value=>value.bindingKey===ledgerKey(ledgerBinding(job)))?.reason || 'clone_review_incomplete').slice(0,128)});
        }
        if(incomplete) {
          ready=ready.filter(job=>!incomplete.has(ledgerKey(ledgerBinding(job))));
          const readyIds=new Set(ready.map(job=>job.resultId)),readyKeys=new Set(ready.map(job=>ledgerKey(ledgerBinding(job))));
          reviewed={...reviewed,complete:true,results:(reviewed.results||[]).filter(value=>readyIds.has(value.resultId)),
            reviews:(reviewed.reviews||[]).filter(value=>readyKeys.has(value.bindingKey))};
        } else {
          for (const job of selected.filter(job=>!raw.has(job.resultId))) {
            counts.unprocessed++;decisions.push({key:ledgerKey(ledgerBinding(job)),binding:ledgerBinding(job),status:'unprocessed',reason:'native_budget'});
          }
          cursor+=selected.length;
          await onProgress({processed:cursor,total:current.length,nativeDispatched:counts.nativeDispatched,ledgerManifestHash:ledger.manifestHash});
          continue;
        }
      }
      demand(reviewed?.complete === true && Array.isArray(reviewed.reviews) && reviewed.reviews.length === ready.length,'incomplete clone/review attestation');
      const checked=exactResults(ready,reviewed.results), reviews=new Map();
      for (const value of reviewed.reviews) {
        demand(value && HASH.test(value.bindingKey || '') && !reviews.has(value.bindingKey),'duplicate/invalid review identity');
        reviews.set(value.bindingKey,value);
      }
      const additions=[];
      for (const job of ready) {
        const binding=ledgerBinding(job),key=ledgerKey(binding),result=checked.get(job.resultId),nativeResult=raw.get(job.resultId),attestation=reviews.get(key);
        demand(attestation?.complete === true && HASH.test(attestation.attestationHash || '') &&
          policy.reviewPolicyVersions.includes(attestation.policyVersion) &&
          ['approved','held','excluded'].includes(attestation.disposition),'missing current review attestation');
        let status;
        if (nativeResult.status === 'verified') {
          const entry=createLedgerEntry({job,result,nativeResult,review:attestation,verifiedAt:now(),policy});
          // Re-review every hit, but do not append identical-outcome witnesses
          // forever just because the capture/review timestamp changed.
          const next=entry.witnesses[0], physics=({review,verifiedAt,...value})=>value;
          if (!entries.get(key)?.witnesses.some(w=>w.review.policyVersion === next.review.policyVersion &&
            w.review.disposition === next.review.disposition && isDeepStrictEqual(physics(w),physics(next)))) additions.push(entry);
          status=attestation.disposition === 'approved' ? 'verified' : attestation.disposition;
          const previous=entries.get(key);
          if (previous && ledgerDisposition(previous) !== 'verified') status=ledgerDisposition(previous);
        } else {
          demand(['mismatch','unavailable'].includes(nativeResult.status),'unknown native status');
          // No positive witness can be manufactured from failure or a timeout.
          status=nativeResult.status;
          if (entries.has(key) && ledgerDisposition(entries.get(key)) !== 'verified') status=ledgerDisposition(entries.get(key));
        }
        counts[status]++;
        decisions.push({key,binding,status,reason:String(result.reason || nativeResult.reason || '').slice(0,128)});
      }
      if (additions.length) {
        ledger=writeLedger({root:ledgerRoot,entries:additions,expectedManifestHash:ledger.manifestHash});
        for (const entry of ledger.entries) entries.set(entry.key,entry);
      }
      // If a partial batch used the last budget slot, no source row disappears.
      for (const job of selected.filter(job=>!raw.has(job.resultId))) {
        counts.unprocessed++;
        decisions.push({key:ledgerKey(ledgerBinding(job)),binding:ledgerBinding(job),status:'unprocessed',reason:'native_budget'});
      }
      cursor+=selected.length;
      await onProgress({processed:cursor,total:current.length,nativeDispatched:counts.nativeDispatched,
        ledgerManifestHash:ledger.manifestHash});
    }
    for (const job of current.slice(cursor)) {
      counts.unprocessed++;
      decisions.push({key:ledgerKey(ledgerBinding(job)),binding:ledgerBinding(job),status:'unprocessed',reason:'native_budget'});
    }
    const result={schemaVersion:1,authority:'snapshot-native',offlineOnly:true,sourceBinding:structuredClone(sourceBinding),
      engineDigest:policy.engineDigest,verifierFingerprint:policy.verifierFingerprint,
      previousLedgerManifestHash:originalLedgerHash,ledgerManifestHash:ledger.manifestHash,
      complete:counts.unprocessed === 0 && counts.unavailable === 0,counts,decisions,
      eligibleKeys:decisions.filter(value=>value.status === 'verified').map(value=>value.key),ledger};
    demand(decisions.length === current.length,'source decision coverage');
    return result;
  },{env});
}

/** Private decision receipts never contain raw replay bytes or native diagnostics. */
export async function writeLocalVerificationReceipt(file, result) {
  demand(typeof file === 'string' && path.isAbsolute(file),'absolute receipt path required');
  const {ledger,...receipt}=result;
  const temporary=file+'.'+randomUUID()+'.tmp';
  await fs.writeFile(temporary,JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600});
  try {await fs.rename(temporary,file);} catch(error) {await fs.rm(temporary,{force:true});throw error;}
  return {path:file,sha256:digest(JSON.stringify(receipt)+'\n')};
}

// Only authority parsing is a standalone CLI. Actual verification is a parent
// capture-hook capability, never arbitrary command-line jobs or live URLs.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length === 3 && process.argv[2] === '--resolve-authority') {
    console.log(await readRepositoryVerificationAuthority(process.cwd(),process.env.POLYTRACK_VERIFICATION_AUTHORITY));
  } else {
    if (process.argv.length !== 4 || process.argv[2] !== '--authority') throw Error('Usage: local-snapshot-verification.mjs --resolve-authority | --authority <firestore|snapshot-native>');
    console.log(verificationAuthority(process.argv[3]));
  }
}
