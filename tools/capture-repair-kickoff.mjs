import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {CAPTURE_REPAIR as R,assertCaptureRepair} from './capture-repair-plan.mjs';

const base='https://api.github.com/repos/StaticQuasar931/PolyTrack-0.6.3-Ranked';
const passive=new Set(['Publish CDN release','pages build and deployment']);
export async function kickoffCaptureRepair({receipt,now=Date.now(),token,fetchImpl=fetch,acquireGuard,record}={}){
 if(receipt?.ready!==true||receipt.replacementAuthorized!==true||receipt.targetDate!==R.date||
   !/^[a-f0-9]{40}$/.test(receipt.testedCommit||'')||!Number.isSafeInteger(receipt.preflightRunId)||receipt.preflightRunId<1||
   !Array.isArray(receipt.evidence)||!receipt.evidence.length||typeof token!=='string'||!token||typeof acquireGuard!=='function'||typeof record!=='function')throw Error('Tested replacement readiness required');
 assertCaptureRepair({eventName:'workflow_dispatch',now,runAttempt:1});
 const request=(url,options={})=>fetchImpl(base+url,{...options,redirect:'error',signal:AbortSignal.timeout(15000),headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','Content-Type':'application/json'}});
 const get=async url=>{const r=await request(url);if(r.status!==200)throw Error('Required replacement metadata unavailable');return r.json();};
 if((await get('/git/ref/heads/main'))?.object?.sha!==receipt.testedCommit)return {status:'blocked',reason:'source-changed'};
 const preflight=await get('/actions/runs/'+receipt.preflightRunId);
 if(preflight.name!=='Check private snapshot access'||preflight.status!=='completed'||preflight.conclusion!=='success'||preflight.head_sha!==receipt.testedCommit||preflight.run_attempt!==1)throw Error('Successful exact-source private authentication check required');
 const prior=await get('/actions/runs/'+R.priorFailureRunId);
 if(prior.status!=='completed'||prior.conclusion!=='failure'||prior.head_sha!==R.priorSource||prior.run_attempt!==1)throw Error('Original failure binding changed');
 const original=await get('/git/ref/tags/polytrack-oneoff-2026-11-05');
 if(original.object?.sha!==R.priorSource)throw Error('Original admission marker changed');
 const claim=await request('/git/ref/'+R.claimRef.slice(5));
 if(claim.status===200)return {status:'already-claimed'};
 if(claim.status!==404)throw Error('Replacement claim cannot be inspected');
 for(const status of ['in_progress','queued','waiting','pending','requested']){
  const runs=await get('/actions/runs?status='+status+'&per_page=100');
  if(!Array.isArray(runs.workflow_runs)||runs.workflow_runs.length>=100)return {status:'blocked',reason:'incomplete-job-inventory'};
  const active=runs.workflow_runs.filter(run=>!passive.has(run.name));
  if(active.length)return {status:'waiting',runIds:active.map(run=>run.id)};
 }
 if(!await acquireGuard())return {status:'blocked',reason:'existing-local-guard'};
 await record({status:'dispatch-requested',sourceCommit:receipt.testedCommit,requestedAt:now});
 let response;
 try{response=await request('/actions/workflows/repair-snapshot.yml/dispatches',{method:'POST',body:JSON.stringify({ref:'main',inputs:{expected_source_commit:receipt.testedCommit}})});}
 catch{await record({status:'dispatch-outcome-unknown',sourceCommit:receipt.testedCommit});throw Error('Ambiguous dispatch; inspect GitHub, never repeat automatically');}
 const result={status:response.status===204?'dispatched':'dispatch-failed',httpStatus:response.status,sourceCommit:receipt.testedCommit,requestedAt:now};
 await record(result);if(response.status!==204)throw Error('Dispatch failed; preserve guard');return result;
}

async function main(){
 const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--receipt'||!path.isAbsolute(args[1]))throw Error('Use --receipt ABSOLUTE_READY_JSON');
 const receipt=JSON.parse(await fs.readFile(args[1],'utf8')),directory=path.dirname(args[1]),owner=randomUUID();
 const prior=JSON.parse(await fs.readFile(receipt.priorFailureReceipt,'utf8'));
 if(prior.runId!==R.priorFailureRunId||prior.status!=='terminal-failed'||prior.productionFirestoreDocumentRequests!==0)throw Error('Original zero-database failure receipt required');
 for(const item of receipt.evidence||[]){const info=await fs.stat(path.resolve(directory,item));if(!info.isFile()||!info.size)throw Error('Missing tested evidence');}
 const credential=spawnSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'}});
 const token=credential.status===0?credential.stdout.split(/\r?\n/).find(line=>line.startsWith('password='))?.slice(9):null;
 if(!token)throw Error('Existing GitHub credential unavailable');
 const result=await kickoffCaptureRepair({receipt,token,acquireGuard:async()=>{
  for(const name of ['dispatch.json','complete.json','failed.json'])if(await fs.stat(path.join(directory,name)).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))return false;
  let file;try{file=await fs.open(path.join(directory,'running.json'),'wx',0o600);}catch(e){if(e.code==='EEXIST')return false;throw e;}
  try{await file.writeFile(JSON.stringify({owner,testedCommit:receipt.testedCommit,startedAt:new Date().toISOString(),claimRef:R.claimRef,productionFirestoreRequests:0})+'\n');}finally{await file.close();}return true;
 },record:async value=>{
  const guard=JSON.parse(await fs.readFile(path.join(directory,'running.json'),'utf8'));if(guard.owner!==owner)throw Error('Guard owner changed');
  await fs.writeFile(path.join(directory,'dispatch.json'),JSON.stringify({...value,owner,productionFirestoreRequests:0})+'\n',{mode:0o600});
 }});console.log(JSON.stringify({captureRepairKickoff:result,productionFirestoreRequests:0}));
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(()=>{console.error('Replacement kickoff stopped. Inspect metadata and guards before further action.');process.exitCode=1;});
