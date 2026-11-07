import {spawn,execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {runBoundedCaptureProcess} from './local-capture-process.mjs';

const SHA=/^[a-f0-9]{40}$/;
const GIT_TIMEOUT_MS=30000;
const OUTPUT_LIMIT=16*1024*1024;
const WORKER_ERRORS=new Set(['LOCAL_GIT_FAILED','LOCAL_GIT_OUTPUT_LIMIT','LOCAL_GIT_SPAWN_FAILED']);
function failure(code,phase,publication={}) {
  const error=new Error(code.replaceAll('_',' '));
  error.code=code;error.captureFailure={phase,errorCode:code,...publication};return error;
}

export function createLocalCaptureGit({workspace,deadline,now=Date.now,runProcess=runBoundedCaptureProcess,spawnWorker=spawn}={}) {
  if(typeof workspace!=='string'||!Number.isSafeInteger(deadline)||typeof now!=='function'||typeof runProcess!=='function'||typeof spawnWorker!=='function')throw TypeError('Invalid local Git configuration');
  return async (args,{input}={})=>{
    const phase=args[0]==='credential'?'credential':args[0]==='push'?'publication-push':'git';
    // Reserve owned-tree termination and close confirmation inside the publication deadline.
    const remaining=deadline-now()-15000;
    if(remaining<=0)throw failure('LOCAL_GIT_DEADLINE',phase);
    let result,reply,protocolError=false;
    try {
      result=await runProcess({file:process.execPath,args:[fileURLToPath(import.meta.url),'--owned-git'],
        options:{cwd:workspace,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'}},
        timeoutMs:Math.min(GIT_TIMEOUT_MS,remaining),graceMs:0,
        spawnImpl:(file,argv,options)=>{
          const child=spawnWorker(file,argv,options);
          child.on('message',value=>{
            if(reply||!value||(value.type!=='git-result'&&value.type!=='git-error')){protocolError=true;return;}
            if(value.type==='git-result'&&(typeof value.stdout!=='string'||Buffer.byteLength(value.stdout)>OUTPUT_LIMIT)||
              value.type==='git-error'&&!WORKER_ERRORS.has(value.code)){protocolError=true;return;}
            reply=value;
          });
          child.once('spawn',()=>{try{child.send({type:'git-job',args,input},error=>{if(error)protocolError=true;});}catch{protocolError=true;}});
          return child;
        }});
    }catch {throw failure('LOCAL_GIT_TREE_UNCONFIRMED',phase);}
    if(reply?.type==='git-error')throw failure(reply.code,phase);
    if(result.timedOut)throw failure('LOCAL_GIT_TIMEOUT',phase);
    if(result.status!==0||result.signal||protocolError||reply?.type!=='git-result')throw failure('LOCAL_GIT_FAILED',phase);
    return reply.stdout;
  };
}

// Keep the existing source policy intact, but bound its synchronous Git calls as an owned tree.
export async function assertBoundedLocalSource({workspace,sourceCommit,runnerFile,deadline,now=Date.now,runProcess=runBoundedCaptureProcess}={}) {
  const remaining=deadline-now()-15000;
  if(remaining<=0)throw failure('LOCAL_GIT_DEADLINE','source-validation');
  const module=new URL('./local-capture-publication.mjs',import.meta.url).href;
  // Retain a live tree root when synchronous Git fails with descendants still running.
  const code=`import {assertLocalSource} from ${JSON.stringify(module)}; const hold=setInterval(()=>{},1000); try { await assertLocalSource(${JSON.stringify({workspace,sourceCommit,runnerFile})}); clearInterval(hold); process.disconnect(); } catch { /* Only the supervisor may terminate a failed source-check tree. */ }`;
  let result;
  try {result=await runProcess({file:process.execPath,args:['--input-type=module','-e',code],
    options:{cwd:workspace,stdio:['ignore','ignore','ignore','ipc'],env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'}},
    timeoutMs:Math.min(GIT_TIMEOUT_MS,remaining),graceMs:0});}
  catch {throw failure('LOCAL_SOURCE_CHECK_FAILED','source-validation');}
  if(result.timedOut||result.status!==0||result.signal)throw failure(result.timedOut?'LOCAL_GIT_TIMEOUT':'LOCAL_SOURCE_CHECK_FAILED','source-validation');
}

export async function publishLocalCaptureCommit({git,sourceCommit,directory,record,onState=()=>{},deadline,now=Date.now,auditCandidate}={}) {
  let state={phase:'publication-commit',publicationState:'not-attempted'};
  const update=value=>{state={...state,...value};onState({...state});};
  try {
    update({});
    let candidateCommit;
    try {
      await git(['-c','gc.auto=0','-c','maintenance.auto=false','-c','user.name=github-actions[bot]','-c','user.email=41898282+github-actions[bot]@users.noreply.github.com','commit','--quiet','-m','Sync public ranked snapshots']);
      candidateCommit=(await git(['rev-parse','HEAD'])).trim();
    }catch(error){
      if(error?.code!=='LOCAL_GIT_TIMEOUT'||typeof auditCandidate!=='function')throw error;
      candidateCommit=(await git(['rev-parse','HEAD'])).trim();
      if(!SHA.test(candidateCommit)||candidateCommit===sourceCommit||(await git(['rev-parse','HEAD^'])).trim()!==sourceCommit||
        (await git(['diff','--name-only','HEAD'])).trim()||(await git(['diff','--cached','--name-only'])).trim()||
        await auditCandidate({candidateCommit,sourceCommit})!==true)throw error;
      update({recoveredLocalCommitTimeout:true});
    }
    if(!SHA.test(candidateCommit))throw failure('LOCAL_PUBLICATION_COMMIT_INVALID','publication-commit');
    update({candidateCommit,phase:'publication-parent-validation'});
    if((await git(['rev-parse','HEAD^'])).trim()!==sourceCommit)throw failure('LOCAL_PUBLICATION_PARENT_CHANGED',state.phase);
    update({phase:'publication-candidate-receipt'});
    await record({status:'publication-candidate',...state,snapshotDirectory:directory,automaticRetry:false});
    update({phase:'publication-pre-push'});
    if(now()>=deadline)throw failure('LOCAL_GIT_DEADLINE',state.phase);
    // Persist uncertainty before the network operation, including process death or lost acknowledgement.
    update({phase:'publication-push',publicationState:'unknown'});
    await record({status:'publication-attempt',...state,snapshotDirectory:directory,automaticRetry:false});
    if(now()>=deadline)throw failure('LOCAL_GIT_DEADLINE',state.phase);
    await git(['push','origin',candidateCommit+':refs/heads/main']);
    update({phase:'publication-acknowledgement-receipt',publicationState:'push-acknowledged',publicationCommit:candidateCommit});
    await record({status:'publication-acknowledged',...state,snapshotDirectory:directory,automaticRetry:false});
    return {candidateCommit,publicationCommit:candidateCommit,publicationState:state.publicationState,snapshotDirectory:directory};
  }catch(error) {
    const safeCode=/^(?:LOCAL_[A-Z_]+|EACCES|EPERM|ENOENT|ENOSPC|EIO|EEXIST|ETIMEDOUT)$/.test(error?.code||'')?error.code:'LOCAL_PUBLICATION_FAILED';
    throw failure(safeCode,state.phase,state);
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)&&process.argv[2]==='--owned-git'){
  // On any Git error keep this root alive: only the owning supervisor may terminate its tree.
  const hold=setInterval(()=>{},1000);
  process.once('message',job=>{
    if(job?.type!=='git-job'||!Array.isArray(job.args)||job.args.some(arg=>typeof arg!=='string')||
      job.input!==undefined&&typeof job.input!=='string')return;
    try{
      const stdout=execFileSync('git',job.args,{encoding:'utf8',input:job.input,stdio:'pipe',shell:false,windowsHide:true,maxBuffer:OUTPUT_LIMIT,
        env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'}});
      process.send({type:'git-result',stdout},error=>{
        if(error)return;
        clearInterval(hold);process.disconnect();
      });
    }catch(error){
      const code=error?.code==='ENOBUFS'?'LOCAL_GIT_OUTPUT_LIMIT':error?.code==='ENOENT'?'LOCAL_GIT_SPAWN_FAILED':'LOCAL_GIT_FAILED';
      try{process.send({type:'git-error',code},()=>{});}catch{}
    }
  });
}

export async function reconcileLocalPublication({candidateCommit,readMain}={}) {
  if(typeof candidateCommit!=='string'||!SHA.test(candidateCommit)||typeof readMain!=='function')throw TypeError('Candidate commit and read-only main reader required');
  let main;
  try {main=await readMain();}catch {return {candidateCommit,publicationState:'unknown',reason:'main-read-failed',automaticRetry:false};}
  return {candidateCommit,publicationState:main===candidateCommit?'remote-main-matches':'unknown',
    reason:main===candidateCommit?'candidate-is-main':'main-does-not-confirm-candidate',automaticRetry:false};
}

export async function completeReconciledLocalPublication({candidateCommit,sourceCommit,generation,snapshotDirectory,readMain,auditCandidate,record}={}){
  if(typeof candidateCommit!=='string'||!SHA.test(candidateCommit)||typeof sourceCommit!=='string'||!SHA.test(sourceCommit)||
    !Number.isSafeInteger(generation)||generation<1||snapshotDirectory!=='public-snapshots'+generation||
    typeof readMain!=='function'||typeof auditCandidate!=='function'||typeof record!=='function')throw TypeError('Explicit candidate identity, read-only audits and separate receipt writer required');
  const identity={candidateCommit,sourceCommit,generation,snapshotDirectory};
  const blocked=reason=>({...identity,status:'reconciliation-blocked',publicationState:'unknown',reason,automaticRetry:false});
  const observed=await reconcileLocalPublication({candidateCommit,readMain});
  if(observed.publicationState!=='remote-main-matches')return blocked(observed.reason);
  let audit;
  try{audit=await auditCandidate({...identity});}catch{return blocked('local-audit-failed');}
  if(!audit||Object.entries(identity).some(([key,value])=>audit[key]!==value)||audit.captureReusable!==true||audit.packageLedgerValid!==true||
    typeof audit.ledgerManifestHash!=='string'||!/^[a-f0-9]{64}$/.test(audit.ledgerManifestHash))return blocked('local-audit-does-not-confirm-candidate');
  // Recheck after local auditing; a nonmatch never proves the earlier push did not happen.
  const confirmed=await reconcileLocalPublication({candidateCommit,readMain});
  if(confirmed.publicationState!=='remote-main-matches')return blocked(confirmed.reason);
  const result={...identity,status:'reconciled-complete',publicationCommit:candidateCommit,publicationState:'remote-main-matches',
    ledgerManifestHash:audit.ledgerManifestHash,captureReusable:true,packageLedgerValid:true,automaticRetry:false};
  try{await record(result);}catch{throw failure('LOCAL_RECONCILIATION_RECEIPT_FAILED','reconciliation-receipt',{
    candidateCommit,publicationCommit:candidateCommit,publicationState:'remote-main-matches'});}
  return result;
}
