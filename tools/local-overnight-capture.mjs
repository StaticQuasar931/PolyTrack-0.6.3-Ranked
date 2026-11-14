import {validateFrozenCaptureContext} from './frozen-capture-context.mjs';
import {fullSnapshotPolicy} from './full-snapshot-policy.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {localOvernightCapturePlan,OVERNIGHT_SNAPSHOT as N} from './overnight-snapshot-plan.mjs';
import {acquireOvernightCaptureClaim} from './overnight-capture-claim.mjs';
import {snapshotPublicationFiles} from './local-capture-publication.mjs';
import {publicationAddArgvBatches} from './local-publication-argv.mjs';
import {runBoundedCaptureProcess} from './local-capture-process.mjs';
import {createLocalCaptureGit,assertBoundedLocalSource,publishLocalCaptureCommit,reconcileLocalPublication} from './local-capture-git.mjs';
import {prepareLocalArchiveReplayRepair} from './local-archive-replay-repair.mjs';
import {preflightLocalCaptureCheckpoints} from './local-capture-checkpoint.mjs';
const REPO='StaticQuasar931/PolyTrack-0.6.3-Ranked',BASE='https://api.github.com/repos/'+REPO;
const PASSIVE=new Set(['Publish CDN release','pages build and deployment']);

export function assertClaimedLocalAdmission(admission,sourceCommit){
 const code=!/^[a-f0-9]{40}$/.test(sourceCommit||'')?'LOCAL_ADMISSION_SOURCE_INVALID':
  admission?.head!==sourceCommit?'LOCAL_ADMISSION_SOURCE_CHANGED':
  admission?.complete!==true?'LOCAL_ADMISSION_INVENTORY_INCOMPLETE':
  admission?.claimed!==true?'LOCAL_ADMISSION_CLAIM_NOT_VISIBLE':
  admission?.claimSource!==sourceCommit?'LOCAL_ADMISSION_CLAIM_CHANGED':
  admission?.active!==false?'LOCAL_ADMISSION_EXISTING_JOB':null;
 if(code)throw Object.assign(Error('Admission changed after claim; preserve guards without database capture'),{code});
}

export async function confirmClaimedLocalAdmission({inspect,sourceCommit,deadline,now=Date.now,sleep=ms=>new Promise(r=>setTimeout(r,ms)),observe=async()=>{}}={}){
 if(typeof inspect!=='function'||!Number.isFinite(deadline))throw Error('Bounded admission confirmation required');
 const expired=()=>Object.assign(Error('Admission confirmation deadline'),{code:'LOCAL_ADMISSION_WAIT_EXPIRED'});
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.max(1,deadline-now()));
 const bounded=work=>new Promise((resolve,reject)=>{
  const abort=()=>reject(expired());if(controller.signal.aborted){abort();return;}
  controller.signal.addEventListener('abort',abort,{once:true});
  Promise.resolve().then(work).then(resolve,reject).finally(()=>controller.signal.removeEventListener('abort',abort));
 });
 const checkTime=()=>{if(controller.signal.aborted||now()>=deadline)throw expired();};
 try{for(let check=1;check<=12;check++){
  checkTime();const admission=await bounded(()=>inspect({signal:controller.signal,deadline}));checkTime();
  const publicSha=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value)?value:null;
  await bounded(()=>observe({check,head:publicSha(admission?.head),claimed:admission?.claimed===true,claimSource:publicSha(admission?.claimSource),active:typeof admission?.active==='boolean'?admission.active:null,complete:admission?.complete===true}));checkTime();
  try{assertClaimedLocalAdmission(admission,sourceCommit);return admission;}
  catch(error){
   if(!['LOCAL_ADMISSION_CLAIM_NOT_VISIBLE','LOCAL_ADMISSION_EXISTING_JOB'].includes(error.code)||check===12)throw error;
   const delay=Math.min(2000,deadline-now());if(delay<=0)throw error;await bounded(()=>sleep(delay));
  }
 }}finally{clearTimeout(timer);controller.abort();}
}

export async function runLocalOvernightCapture({receipt,now=Date.now,inspect,preflight,acquireGuard,claim,authenticate,capture,publish,record,reconcilePublication,revalidateAdmission}={}){
  localOvernightCapturePlan({now:now(),receipt});
  for(const fn of [inspect,preflight,acquireGuard,claim,authenticate,capture,publish,record])if(typeof fn!=='function')throw Error('Local capture capability missing');
  if(reconcilePublication!==undefined&&typeof reconcilePublication!=='function')throw Error('Invalid read-only reconciliation capability');
  if(revalidateAdmission!==undefined&&typeof revalidateAdmission!=='function')throw Error('Invalid admission revalidation capability');
  const admission=await inspect();
  if(admission.head!==receipt.testedCommit)return {status:'blocked',reason:'tested-source-changed'};
  if(admission.claimed)return {status:'already-claimed'};
  if(admission.active||!admission.complete)return {status:'waiting',reason:'active-or-incomplete-job-inventory'};
  try{await preflight();}catch(error){
    if(error&&typeof error==='object')error.captureFailure=localCaptureFailure(error,{phase:'checkpoint-preflight'});
    throw error;
  }
  if(!await acquireGuard())return {status:'blocked',reason:'existing-local-guard'};
  let phase='admission-receipt',publication={},generation,snapshotDirectory;
  try{
    await record({status:'admission-started',sourceCommit:receipt.testedCommit});
    phase='claim';
    if(!await claim()){await record({status:'already-claimed'});return {status:'already-claimed'};}
    phase='admission-revalidation';
    localOvernightCapturePlan({now:now(),receipt});
    if(revalidateAdmission){await revalidateAdmission();localOvernightCapturePlan({now:now(),receipt});}
    phase='authentication';
    await authenticate();
    phase='capture-start-receipt';
    await record({status:'capturing',sourceCommit:receipt.testedCommit});
    phase='capture';
    const result=await capture();
    phase='capture-postvalidation';
    if(!result||result.deferred||result.published!==true||result.nativeVerification?.backendReads!==0||result.nativeVerification?.backendWrites!==0)
      throw Error('Capture deferred or offline proof assertion failed; retain recovery, do not publish');
    if(receipt.captureOnly===true&&(result.nativeVerification?.reuseOnly!==true||
      result.nativeVerification?.counts?.nativeDispatched!==0||result.nativeVerification?.counts?.newProofs!==0))
      throw Error('Capture-only publication requires stored-proof reuse with zero native dispatch/new proofs');
    if(now()>=N.deadline)throw Error('Publication deadline reached; preserve candidate');
    generation=result.generation;snapshotDirectory=result.directory;phase='publication-validation';
    const published=await publish(result,value=>{publication={...publication,...value};phase=value.phase||phase;});
    publication={...publication,...published};
    if(typeof publication.publicationCommit!=='string'||!/^[a-f0-9]{40}$/.test(publication.publicationCommit))throw Error('Publication did not return a real commit');
    if(publication.candidateCommit!==undefined&&publication.candidateCommit!==publication.publicationCommit)throw Error('Publication commit does not match the candidate');
    phase='completion-receipt';
    await record({status:'complete',sourceCommit:receipt.testedCommit,generation:result.generation,...publication});
    return {status:'complete',generation:result.generation,...publication};
  }catch(error){
    const details=localCaptureFailure(error,{...publication,phase,generation});
    if(reconcilePublication&&typeof publication.candidateCommit==='string'&&/^[a-f0-9]{40}$/.test(publication.candidateCommit)&&
      Number.isSafeInteger(generation)&&generation>0&&snapshotDirectory==='public-snapshots'+generation&&
      ['unknown','push-acknowledged'].includes(publication.publicationState)&&now()<N.deadline){
      const candidateCommit=publication.candidateCommit;
      try{
        const observed=await reconcilePublication({candidateCommit,sourceCommit:receipt.testedCommit,generation,snapshotDirectory});
        if(observed?.candidateCommit===candidateCommit&&observed.publicationState==='remote-main-matches'&&now()<N.deadline){
          details.publicationState='remote-main-matches';details.publicationCommit=candidateCommit;
          const complete={status:'complete',sourceCommit:receipt.testedCommit,generation,snapshotDirectory,candidateCommit,
            publicationCommit:candidateCommit,publicationState:'remote-main-matches',reconciled:true,automaticRetry:false,
            reconciledFailure:{...details}};
          try{await record(complete);return complete;}
          catch(receiptError){details.reconciliationReceiptError=localCaptureFailure(receiptError).errorCode;}
        }else{details.publicationState='unknown';details.reconciliationError='LOCAL_RECONCILIATION_UNCONFIRMED';}
      }catch{details.publicationState='unknown';details.reconciliationError='LOCAL_RECONCILIATION_FAILED';}
    }
    try{await record({status:'failed',sourceCommit:receipt.testedCommit,reason:'local-capture-or-publication-failed',automaticRetry:false,...details});}
    catch(recordError){details.failureReceiptError=localCaptureFailure(recordError).errorCode;}
    if(error&&typeof error==='object')error.captureFailure=details;
    throw error;
  }
}

export function localCaptureFailure(error,context={}){
  const state={...context,...error?.captureFailure};
  const phases=new Set(['preflight','checkpoint-preflight','admission-receipt','claim','admission-revalidation','authentication','capture-start-receipt','capture',
    'capture-postvalidation','publication-validation','publication-commit','publication-parent-validation','publication-candidate-receipt',
    'publication-pre-push','publication-push','publication-acknowledgement-receipt','completion-receipt','source-validation','credential','git','reconciliation-receipt']);
  const details={phase:phases.has(state.phase)?state.phase:'preflight',errorCode:'LOCAL_CAPTURE_FAILED'};
  const code=error?.code;
  if(/^(?:LOCAL_[A-Z_]{1,64}|EACCES|EPERM|ENOENT|ENOSPC|EIO|EEXIST|ETIMEDOUT|SNAPSHOT_REPLAYS_INCOMPLETE)$/.test(code||''))details.errorCode=code;
  for(const key of ['candidateCommit','publicationCommit'])if(typeof state[key]==='string'&&/^[a-f0-9]{40}$/.test(state[key]))details[key]=state[key];
  if(['not-attempted','unknown','push-acknowledged','remote-main-matches'].includes(state.publicationState))details.publicationState=state.publicationState;
  if(Number.isSafeInteger(state.generation)&&state.generation>0)details.generation=state.generation;
  if(/^(?:LOCAL_[A-Z_]{1,64}|EACCES|EPERM|ENOENT|ENOSPC|EIO|EEXIST|ETIMEDOUT)$/.test(state.failureReceiptError||''))details.failureReceiptError=state.failureReceiptError;
  for(const key of ['reconciliationReceiptError','reconciliationError'])if(/^(?:LOCAL_[A-Z_]{1,64}|EACCES|EPERM|ENOENT|ENOSPC|EIO|EEXIST|ETIMEDOUT)$/.test(state[key]||''))details[key]=state[key];
  return details;
}

export async function writeLocalCaptureReceipt({directory,owner,value}){
  const current=JSON.parse(await fs.readFile(path.join(directory,'running.json'),'utf8'));
  if(current.owner!==owner)throw Error('Local guard ownership changed');
  const names={'complete':'complete.json','failed':'failed.json','publication-candidate':'publication-candidate.json',
    'publication-attempt':'publication-attempt.json','publication-acknowledged':'publication-acknowledged.json','reconciled-complete':'reconciled-complete.json'};
  const file=path.join(directory,names[value.status]||'state.json'),temporary=file+'.'+randomUUID()+'.tmp';
  try{
    const handle=await fs.open(temporary,'wx',0o600);
    try{await handle.writeFile(JSON.stringify({...value,owner,at:new Date().toISOString()})+'\n');await handle.sync();}
    finally{await handle.close();}
    if(value.status==='reconciled-complete'){await fs.link(temporary,file);await fs.unlink(temporary);}
    else await fs.rename(temporary,file);
  }catch(error){await fs.rm(temporary,{force:true}).catch(()=>{});throw error;}
}

export async function validatePriorLocalCapture(receipt,{plan=N}={}){
  const completed=plan.priorOutcome==='complete',prior=completed?receipt.priorCompletion:receipt.priorFailure;
  if(!prior||!path.isAbsolute(prior.file||'')||!/^[a-f0-9]{64}$/.test(prior.sha256||''))throw Error('Preserved prior attempt evidence required');
  const stat=await fs.lstat(prior.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1024*1024)throw Error('Unsafe prior attempt evidence');
  const bytes=await fs.readFile(prior.file),value=JSON.parse(bytes);
  if(createHash('sha256').update(bytes).digest('hex')!==prior.sha256)throw Error('Prior attempt evidence changed');
  if(completed){if(!Number.isSafeInteger(value.generation)||value.generation<1||value.status!=='complete'||value.publicationCommit!==plan.priorPublicationCommit||value.binding?.reusable!==true||value.binding.directory!=='public-snapshots'+value.generation)throw Error('Prior completed publication is not exact-bound');}
  else if(value.status!=='failed'||value.sourceCommit!==plan.priorSource)throw Error('Prior attempt is not terminal and exact-bound');
  return {status:value.status,publicationCommit:value.publicationCommit||null};
}

export async function validateLocalEvidence(receipt){
  if(!Array.isArray(receipt.tests)||receipt.tests.length<3)throw Error('Test evidence required');
  const seen=new Set();
  for(const entry of receipt.tests){
    if(!path.isAbsolute(entry.file||'')||!entry.file.endsWith('.tap')||! /^[a-f0-9]{64}$/.test(entry.sha256||'')||!(entry.passed>0))throw Error('Invalid test evidence');
    if(seen.has(path.resolve(entry.file)))throw Error('Duplicate test evidence');seen.add(path.resolve(entry.file));
    const info=await fs.lstat(entry.file);
    if(!info.isFile()||info.isSymbolicLink()||info.size>200*1024*1024)throw Error('Unsafe test evidence');
    const bytes=await fs.readFile(entry.file),text=bytes.toString('utf8');
    if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256||
      ! /^(?:#|\u2139) fail 0\r?$/m.test(text)||Number(/^(?:#|\u2139) pass (\d+)\r?$/m.exec(text)?.[1])!==entry.passed)
      throw Error('Test evidence changed');
  }
  if(receipt.localSignerAccepted!==true||receipt.publicationRequiresCompleteReplays!==true)throw Error('Capture signer or strict replay gate not ready');
}


/** Offline receipt/namespace/accounting check before any admission or credential access. */
export async function validateReplacementContext(receipt,{directory,plan=N}={}){
  if(plan.frozenContinuation)return validateFrozenCaptureContext(receipt,{directory});
  const N=plan;
  const normalized=value=>path.resolve(value).replace(/\\/g,'/');
  if(!path.isAbsolute(directory||'')||!normalized(directory).endsWith('/'+N.privateDirectorySuffix)||
    receipt.replacementDirectory!==normalized(directory))throw Error('Replacement requires its distinct private guard directory');
  const prior=receipt.priorFailure,usage=receipt.priorAccounting?.evidence;
  if(!prior||!path.isAbsolute(prior.file||'')||!normalized(prior.file).endsWith('/2026-11-14/replacement-local/failed.json')||
    !usage||!path.isAbsolute(usage.file||'')||!normalized(usage.file).endsWith('/2026-11-13/overnight-local/capture.log')||
    !/^[a-f0-9]{64}$/.test(usage.sha256||''))throw Error('Exact failed-attempt receipt and accounting log required');
  await validatePriorLocalCapture(receipt,{plan:N});
  const failure=JSON.parse(await fs.readFile(prior.file,'utf8'));
  if(failure.phase!=='admission-revalidation')throw Error('Repair requires a pre-capture admission failure');
  for(const name of ['capture-admitted.json','capture.log','capture-result.json','native-complete.receipt.json']){
    try{await fs.lstat(path.join(path.dirname(prior.file),name));}catch(error){if(error.code==='ENOENT')continue;throw error;}
    throw Error('Previous replacement may have acquired source; no admission repair allowed');
  }
  const stat=await fs.lstat(usage.file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16*1024*1024)throw Error('Unsafe prior accounting log');
  const bytes=await fs.readFile(usage.file);
  if(createHash('sha256').update(bytes).digest('hex')!==usage.sha256)throw Error('Prior accounting log changed');
  const rows=bytes.toString('utf8').split(/\r?\n/).filter(line=>line.startsWith('{')).flatMap(line=>{try{const v=JSON.parse(line);return v.fullSnapshotOperations?[v.fullSnapshotOperations]:[];}catch{return [];}});
  if(rows.length!==1||rows[0].directDocumentReadReservations!==N.priorDirectReservations||rows[0].workerRequests!==N.priorWorkerRequests||
    rows[0].maxDirectReservations!==40000||rows[0].maxWorkerRequests!==1024||rows[0].documentWrites!==0)
    throw Error('Replacement must carry exact 37/88 usage within unchanged total budgets');
  return {priorDirectReservations:N.priorDirectReservations,priorWorkerRequests:N.priorWorkerRequests};
}

async function main(){
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--receipt'||!path.isAbsolute(args[1]))throw Error('Usage: node tools/local-overnight-capture.mjs --receipt ABSOLUTE_READY_JSON');
  const receipt=JSON.parse(await fs.readFile(args[1],'utf8')),directory=path.dirname(args[1]),owner=randomUUID();
  localOvernightCapturePlan({receipt});fullSnapshotPolicy(receipt);await validateLocalEvidence(receipt);
  await validateReplacementContext(receipt,{directory});
  const workspace=receipt.workspace;
  if(!path.isAbsolute(workspace||'')||!path.isAbsolute(receipt.credentialFile||'')||!path.isAbsolute(receipt.recoveryPublicKeyFile||'')||
    !path.isAbsolute(receipt.verifierNodeModules||''))throw Error('Explicit private workspace, dependencies and credential paths required');
  const git=createLocalCaptureGit({workspace,deadline:N.deadline});
  await assertBoundedLocalSource({workspace,sourceCommit:receipt.testedCommit,runnerFile:fileURLToPath(import.meta.url),deadline:N.deadline});
  const require=createRequire(import.meta.url),modulePath=path.join(receipt.verifierNodeModules,'playwright');
  const installed=JSON.parse(await fs.readFile(path.join(modulePath,'package.json'),'utf8'));
  const declared=JSON.parse(await fs.readFile(path.join(workspace,'tools/verifier/package.json'),'utf8'));
  if(installed.version!==declared.dependencies.playwright)throw Error('Pinned local verifier dependency changed');
  await fs.stat(require(modulePath).chromium.executablePath());
  const credential=await git(['credential','fill'],{input:'protocol=https\nhost=github.com\n\n'});
  const token=credential.split(/\r?\n/).find(v=>v.startsWith('password='))?.slice(9);
  if(!token)throw Error('Existing GitHub authorization unavailable');
  const read=async(route,{signal,deadline=N.deadline}={})=>{
    const remaining=Math.min(N.deadline,deadline)-Date.now();if(remaining<=0)throw Error('Publication metadata deadline reached');
    const r=await fetch(BASE+route,{headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','Cache-Control':'no-cache'},redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(Math.min(20000,remaining))]):AbortSignal.timeout(Math.min(20000,remaining))});
    if(r.status===404)return null;if(!r.ok)throw Error('GitHub admission metadata unavailable');return r.json();
  };
  const record=value=>writeLocalCaptureReceipt({directory,owner,value});
  const inspectAdmission=async(options={})=>{
      const head=await read('/git/ref/heads/main',options),claimed=await read('/git/ref/tags/'+(N.claimTag||'polytrack-oneoff-'+N.date),options);
      const previous=await read('/git/ref/tags/'+N.priorClaimTag,options);
      if(previous?.object?.sha!==N.priorSource)throw Error('Original claim changed; preserve and inspect');
      for(const status of ['in_progress','queued','waiting','pending','requested']){
        const rows=await read('/actions/runs?status='+status+'&per_page=100',options);
        if(!Array.isArray(rows?.workflow_runs)||rows.workflow_runs.length>=100)return {complete:false};
        if(rows.workflow_runs.some(r=>!PASSIVE.has(r.name)))return {head:head?.object?.sha,claimed:!!claimed,claimSource:claimed?.object?.sha,complete:true,active:true};
      }
      return {head:head?.object?.sha,claimed:!!claimed,claimSource:claimed?.object?.sha,complete:true,active:false};
  };
  const result=await runLocalOvernightCapture({receipt,
    preflight:async()=>{await preflightLocalCaptureCheckpoints({workspace,directory,recoveryPublicKeyFile:receipt.recoveryPublicKeyFile});
      if(receipt.archiveReplayRepair)await prepareLocalArchiveReplayRepair({directory:path.join(workspace,'local-reports/snapshot-staging'),
        planFile:receipt.archiveReplayRepair.file,planSha256:receipt.archiveReplayRepair.sha256,maxDocuments:receipt.archiveReplayRepair.maxDocuments});},
    reconcilePublication:({candidateCommit})=>reconcileLocalPublication({candidateCommit,readMain:async()=>(await read('/git/ref/heads/main'))?.object?.sha}),
    inspect:inspectAdmission,
    revalidateAdmission:async()=>{
      await confirmClaimedLocalAdmission({inspect:inspectAdmission,sourceCommit:receipt.testedCommit,
        deadline:Math.min(Date.now()+60000,N.latestCaptureStart),
        observe:diagnostic=>record({status:'admission-observed',sourceCommit:receipt.testedCommit,diagnostic})});
    },
    acquireGuard:async()=>{
      for(const name of ['complete.json','failed.json','running.json','dispatch.json'])if(await fs.lstat(path.join(directory,name)).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))return false;
      try{await fs.writeFile(path.join(directory,'running.json'),JSON.stringify({owner,testedCommit:receipt.testedCommit,startedAt:new Date().toISOString()})+'\n',{flag:'wx',mode:0o600});return true;}
      catch(e){if(e.code==='EEXIST')return false;throw e;}
    },
    claim:async()=>(await acquireOvernightCaptureClaim({repository:REPO,sourceCommit:receipt.testedCommit,token})).acquired,
    authenticate:async()=>{
      const {checkWorkerCaptureAccess}=await import('./check-worker-capture-access.mjs');
      const {createWorkerCaptureFetch}=await import('./worker-capture-fetch.mjs');
      await checkWorkerCaptureAccess({fetchImpl:createWorkerCaptureFetch({serviceAccount:await fs.readFile(receipt.credentialFile,'utf8')})});
    },
    capture:async()=>{
      const log=await fs.open(path.join(directory,'capture.log'),'wx',0o600);
      let child;try{child=await runBoundedCaptureProcess({file:process.execPath,
        args:['--use-system-ca',path.join(workspace,'tools/local-capture-worker.mjs'),args[1],owner],timeoutMs:N.jobTimeoutMinutes*60000,
        options:{cwd:workspace,stdio:['ignore',log.fd,log.fd,'ipc'],env:{...process.env,NODE_OPTIONS:'--use-system-ca',
          NODE_PATH:receipt.verifierNodeModules,VERIFIER_PLAYWRIGHT_MODULE:path.join(receipt.verifierNodeModules,'playwright')}},
        recoverAfterTimeout:async()=>{
          const staging=path.join(workspace,'local-reports/snapshot-staging');
          if(!await fs.lstat(staging).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))return;
          const {encryptCaptureRecovery}=await import('./capture-recovery.mjs');
          await encryptCaptureRecovery({directory:staging,sourceCommit:receipt.testedCommit,
            outputFile:path.join(directory,'timeout.ptenc'),recipientPublicKey:await fs.readFile(receipt.recoveryPublicKeyFile,'utf8'),
            attempt:'overnight-capture',phase:'failure-state'});
        }});
      }finally{await log.close();}
      if(child.timedOut||child.status!==0)throw Error('Local bounded capture failed; inspect private capture.log, do not repeat');
      return JSON.parse(await fs.readFile(path.join(directory,'capture-result.json'),'utf8'));
    },
    publish:async(result,onState)=>{
      const {captureBinding}=await import('./workflow-capture-coordination.mjs');
      if((await captureBinding(workspace)).reusable!==true)throw Error('Candidate capture is not a consistent cohort');
      const {nativeLedgerPublicationFiles}=await import('./verifier/local-snapshot-verification.mjs');
      const files=['events/public-catalog.json','tools/workflow-capture-state.json','index.html','snapshot-current.json',
        ...await nativeLedgerPublicationFiles(workspace),...await snapshotPublicationFiles({root:workspace,directory:result.directory})];
      const stagingArgv=publicationAddArgvBatches(files);
      const allowed=new Set(files);
      if((await git(['diff','--name-only','HEAD','--diff-filter=ACMRTUXB'])).trim().split('\n').filter(Boolean).some(file=>!allowed.has(file))||
        (await git(['ls-files','--others','--exclude-standard','-z'])).split('\0').filter(Boolean).some(file=>!allowed.has(file)&&!file.startsWith('local-reports/')))
        throw Error('Unexpected source or untracked change during capture');
      // Bounded argv batches fit Windows; never stage arbitrary neighboring files.
      for(const args of stagingArgv)await git(args);
      await git(['add','-u','--',':(glob)public-snapshots[0-9]*/**']);
      const staged=(await git(['diff','--cached','--name-only','--diff-filter=ACMRTUXB'])).trim().split('\n').filter(Boolean);
      if(staged.some(file=>!allowed.has(file)))throw Error('Unexpected capture publication file');
      return publishLocalCaptureCommit({git,sourceCommit:receipt.testedCommit,directory:result.directory,record,onState,deadline:N.deadline,
        auditCandidate:async({candidateCommit,sourceCommit})=>{
          const changed=(await git(['diff','--name-only',sourceCommit,candidateCommit,'--diff-filter=ACMRTUXB'])).trim().split('\n').filter(Boolean);
          const deleted=(await git(['diff','--name-only',sourceCommit,candidateCommit,'--diff-filter=D'])).trim().split('\n').filter(Boolean);
          return !changed.some(file=>!allowed.has(file))&&!deleted.some(file=>!/^public-snapshots[1-9]\d*\//.test(file))&&(await captureBinding(workspace)).reusable===true;
        }});
    },record});
  console.log(JSON.stringify(result));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  main().catch(error=>{console.error(JSON.stringify({...localCaptureFailure(error),automaticRetry:false}));process.exitCode=1;});
