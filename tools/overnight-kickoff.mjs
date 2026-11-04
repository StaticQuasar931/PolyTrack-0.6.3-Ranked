import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {OVERNIGHT_SNAPSHOT as N,overnightSnapshotPlan} from './overnight-snapshot-plan.mjs';

const REPOSITORY='StaticQuasar931/PolyTrack-0.6.3-Ranked';
const BASE='https://api.github.com/repos/'+REPOSITORY;
const PASSIVE=new Set(['Publish CDN release','pages build and deployment']);

export async function kickoffOvernightSnapshot({receipt,now=Date.now(),token,fetchImpl=fetch,acquireGuard,record}={}){
  if(receipt?.ready!==true||receipt.targetDate!==N.date||receipt.oneOffAuthority!=='snapshot-native'||
    !/^[a-f0-9]{40}$/.test(receipt.testedCommit||'')||!Array.isArray(receipt.evidence)||!receipt.evidence.length)
    throw Error('A tested, ready one-time receipt is required');
  const plan=overnightSnapshotPlan({eventName:'workflow_dispatch',manualOvernight:true,configuredMode:'firestore',now});
  if(!plan.overnight||plan.skip)throw Error('One-time kickoff is outside its authorized fresh-capture window');
  if(typeof token!=='string'||!token.trim()||typeof acquireGuard!=='function'||typeof record!=='function')throw Error('Kickoff capabilities missing');
  const request=async(relative,options={})=>{
    const response=await fetchImpl(BASE+relative,{...options,redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','Content-Type':'application/json'}});
    return response;
  };
  const head=await request('/git/ref/heads/main');
  if(head.status!==200)throw Error('Cannot inspect canonical main');
  if((await head.json())?.object?.sha!==receipt.testedCommit)return {status:'blocked',reason:'canonical-source-changed'};
  const claim=await request('/git/ref/tags/polytrack-oneoff-'+N.date);
  if(claim.status===200){
    const value=await claim.json();
    if(value?.ref!=='refs/tags/polytrack-oneoff-'+N.date||!/^[a-f0-9]{40}$/.test(value?.object?.sha||''))throw Error('Invalid existing one-time claim');
    return {status:'already-claimed',reason:'inspect-existing-run-no-repeat'};
  }
  if(claim.status!==404)throw Error('Cannot inspect one-time claim');
  for(const status of ['in_progress','queued','waiting','pending','requested']){
    const response=await request('/actions/runs?status='+status+'&per_page=100');
    if(response.status!==200)throw Error('Cannot inspect active GitHub jobs');
    const data=await response.json();
    if(!Array.isArray(data.workflow_runs)||data.workflow_runs.length>=100)return {status:'blocked',reason:'active-job-inventory-incomplete'};
    const active=data.workflow_runs.filter(run=>!PASSIVE.has(run.name));
    if(active.length)return {status:'waiting',reason:'another-workflow-is-active',runIds:active.map(run=>run.id)};
  }
  // The local guard protects dispatch; the shared GitHub tag protects actual capture.
  if(!await acquireGuard())return {status:'blocked',reason:'local-running-or-completion-guard-exists'};
  await record({status:'dispatch-requested',sourceCommit:receipt.testedCommit,requestedAt:now});
  let response;
  try{
    response=await request('/actions/workflows/verify-runs.yml/dispatches',{method:'POST',body:JSON.stringify({ref:'main',
      inputs:{overnight_capture:true,expected_source_commit:receipt.testedCommit,catch_up:false}})});
  }catch{
    await record({status:'dispatch-outcome-unknown',sourceCommit:receipt.testedCommit,requestedAt:now});
    throw Error('Dispatch outcome unknown; inspect GitHub before any retry');
  }
  const result={status:response.status===204?'dispatched':'dispatch-failed',httpStatus:response.status,sourceCommit:receipt.testedCommit,requestedAt:now};
  await record(result);
  if(response.status!==204)throw Error('Dispatch failed; keep guard and inspect HTTP '+response.status);
  return result;
}

async function main(){
  const args=process.argv.slice(2);
  if(args.length!==2||args[0]!=='--receipt')throw Error('Usage: node tools/overnight-kickoff.mjs --receipt ABSOLUTE_READY_JSON');
  if(!path.isAbsolute(args[1]))throw Error('Use an absolute readiness receipt path');
  const receipt=JSON.parse(await fs.readFile(args[1],'utf8')),directory=path.dirname(args[1]),owner=randomUUID();
  if(receipt.ready!==true)throw Error('Receipt is not ready; no dispatch');
  const plan=overnightSnapshotPlan({eventName:'workflow_dispatch',manualOvernight:true,configuredMode:'firestore',now:Date.now()});
  if(!plan.overnight||plan.skip)throw Error('Not within the one-time kickoff window');
  const credential=spawnSync('git',['credential','fill'],{input:'protocol=https\nhost=github.com\n\n',encoding:'utf8',
    env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'Never'}});
  const token=credential.status===0?credential.stdout.split(/\r?\n/).find(row=>row.startsWith('password='))?.slice(9):null;
  if(!token)throw Error('Existing GitHub authorization unavailable; no interactive login attempted');
  const result=await kickoffOvernightSnapshot({receipt,token,acquireGuard:async()=>{
    for(const name of ['complete.json','failed.json','dispatch.json'])if(await fs.stat(path.join(directory,name)).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;}))return false;
    let file;
    try{file=await fs.open(path.join(directory,'running.json'),'wx',0o600);}catch(error){if(error.code==='EEXIST')return false;throw error;}
    try{await file.writeFile(JSON.stringify({schemaVersion:1,owner,startedAt:new Date().toISOString(),testedCommit:receipt.testedCommit,productionFirestoreRequests:0})+'\n');}finally{await file.close();}
    return true;
  },record:async value=>{
    const guard=JSON.parse(await fs.readFile(path.join(directory,'running.json'),'utf8'));
    if(guard.owner!==owner)throw Error('Local guard ownership changed');
    await fs.writeFile(path.join(directory,'dispatch.json'),JSON.stringify({...value,owner,productionFirestoreRequests:0})+'\n',{mode:0o600});
  }});
  console.log(JSON.stringify({overnightKickoff:result,productionFirestoreRequests:0}));
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))main().catch(error=>{console.error(error.message);process.exitCode=1;});
