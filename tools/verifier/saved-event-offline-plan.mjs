import fs from 'node:fs/promises';
import {nativeTargetTrackIds} from '../native-target-filter.mjs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {decodeSnapshot} from '../snapshot-package.mjs';
import {readLedger,ledgerBinding,ledgerKey,ledgerDisposition} from '../native-verification-ledger.mjs';
import {buildNativeVerificationPolicy} from '../native-verification-policy.mjs';

const require=createRequire(import.meta.url),{checkJob,resourceLimits}=require('./replay.cjs');
const sha=b=>createHash('sha256').update(b).digest('hex');
const demand=(ok,message)=>{if(!ok)throw Error('Saved event plan: '+message);};
const HASH=/^[a-f0-9]{64}$/;
const adverse=row=>row?.needsReview===true||row?.reviewHold===true||row?.excluded===true||
  /held|review|rejected|mismatch|excluded/.test(String(row?.verificationStatus||row?.status||''));
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);

export function savedEventDispatchPlan({sourceCommit,generation,indexSha256,ledgerManifestHash,ledgerEntries,maxJobs=64,runAttempt=1,targetTrackIds,targetScope='events'}={}){
 demand(/^[a-f0-9]{40}$/.test(sourceCommit||'')&&Number.isSafeInteger(generation)&&generation>0&&HASH.test(indexSha256||'')&&
  HASH.test(ledgerManifestHash||'')&&Number.isSafeInteger(ledgerEntries)&&ledgerEntries>=0,'independent public source pins required');
 demand([1,16,64,128,256,512].includes(maxJobs)&&runAttempt===1,'bounded first attempt only; reruns cannot reset native budgets');
 demand(targetScope==='events'||targetScope==='all'&&targetTrackIds!==undefined,'explicit targets required for combined saved pass');
 const targets=nativeTargetTrackIds(targetScope,targetTrackIds);
 return {workflow:'verify-saved-events.yml',ref:'main',sourceCommit,publishedBaseline:{generation,indexSha256,ledgerManifestHash,ledgerEntries},
  targetScope,...(targets?{targetTrackIds:targets}:{}),maxJobs,maxRuntimeMs:480000,batchSize:16,standard:resourceLimits('standard'),extended:resourceLimits('extended-local'),
  checkpointPolicy:'artifact-only; receipts are not resumable proof authority; no automatic retry',
  backendReads:0,backendWrites:0,capture:false,compile:true,publish:false};
}

export async function inspectSavedEventPackage({root,pins,now=Date.now()}={}){
 demand(path.isAbsolute(root||''),'absolute root required');
 const plan=savedEventDispatchPlan(pins),pointerBytes=await fs.readFile(path.join(root,'snapshot-current.json'));
 const pointer=JSON.parse(pointerBytes);demand(pointer.currentdir==='public-snapshots'+pins.generation,'generation changed');
 const directory=path.join(root,pointer.currentdir),indexBytes=await fs.readFile(path.join(directory,'index.json'));
 demand(sha(indexBytes)===pins.indexSha256,'index pin mismatch');const index=JSON.parse(indexBytes);
 demand(index.generation===pins.generation&&index.encoding==='gzip-xor-a7-v1','package schema');
 const pointerLedger=JSON.parse(await fs.readFile(path.join(root,'verification-ledger-current.json')));
 demand(pointerLedger.manifestHash===pins.ledgerManifestHash,'ledger pointer changed');
 const ledger=readLedger({root:path.join(root,'verification-ledger'),expectedManifestHash:pins.ledgerManifestHash});
 demand(ledger.entries.length===pins.ledgerEntries,'ledger count mismatch');
 const policy=buildNativeVerificationPolicy({root,entries:ledger.entries}),proofs=new Map(ledger.entries.map(e=>[e.key,e]));
 let encodedReads=0,encodedBytes=0;
 const read=async logical=>{
  const r=index.files[logical];if(!r)return null;
  demand(HASH.test(r.sha256||'')&&r.path===r.sha256+'.bin'&&Number.isSafeInteger(r.decodedBytes)&&r.decodedBytes<=2*1024*1024,'unsafe package record');
  const filename=path.join(directory,r.path),s=await fs.lstat(filename);
  demand(s.isFile()&&!s.isSymbolicLink()&&s.size<=20*1024*1024,'unsafe payload');
  const b=await fs.readFile(filename);demand(sha(b)===r.sha256,'payload hash mismatch');
  const decoded=Buffer.from(await decodeSnapshot(b));demand(decoded.length===r.decodedBytes,'decoded size mismatch');encodedReads++;encodedBytes+=b.length;
  return JSON.parse(decoded);
 };
 const periods=[],jobs=[],issues=[],referenced=new Set();
 for(const logical of Object.keys(index.files).filter(k=>/^events\/[A-Za-z0-9_-]+\.json$/.test(k)).sort()){
  const board=await read(logical);if(board.id==='permanent-rolling-hills')continue;
  demand(board.period?.id===board.id&&logical==='events/'+board.id+'.json'&&HASH.test(board.period.trackId),'event board binding');
  const p=board.period,live=board.archived!==true&&p.startsAt<=now&&now<p.endsAt+(p.graceMs||0);
  const row={periodId:board.id,kind:p.kind,trackId:p.trackId,name:p.trackName||p.label||board.id,maxRp:p.maxRp,
   archived:board.archived===true,liveAtAudit:live,startsAt:p.startsAt,endsAt:p.endsAt,complete:board.complete===true,
   visible:board.entries.length,pending:board.pendingPlaybacks?.length||0,available:0,missing:0,invalid:0,held:0,
   exactPriorApproved:0,compatiblePhysicsCandidate:0,stalePhysics:0,noProof:0,unsupportedInput:0,replayBytes:0};
  for(const [rows,pending]of [[board.entries,false],[board.pendingPlaybacks||[],true]])for(const source of rows){
   const key=pending?'event-playbacks/'+board.id+'/'+source.runId+'.json':'event-replays/'+board.id+'/'+source.accountId+'.json';
   referenced.add(key);const raw=await read(key);if(!raw){row.missing++;continue;}
   const job={lane:'event',kind:pending?'event-pending':'event',periodId:board.id,accountId:source.accountId,trackId:p.trackId,
    runId:raw.runId,timeMs:source.timeMs,frames:raw.frames,uploadId:raw.uploadId??null,replayHash:raw.replayHash,replay:raw.replay,resultId:raw.runId};
   try{
    demand(raw.periodId===board.id&&raw.trackId===p.trackId&&raw.accountId===source.accountId&&raw.timeMs===source.timeMs&&raw.frames===source.timeMs&&
     (source.runId===undefined||source.runId===raw.runId)&&(source.replayHash===undefined||source.replayHash===raw.replayHash)&&
     typeof raw.replay==='string'&&sha(raw.replay)===raw.replayHash&&(!pending||source.pending===true&&source.verified===false&&source.eventRpEligible===false&&raw.pending===true&&raw.verified===false&&raw.eventRpEligible===false&&raw.submittedAt===source.submittedAt),'retained replay binding');
    ledgerBinding(job);
   }catch{row.invalid++;issues.push({periodId:board.id,path:key,reason:'binding-mismatch'});continue;}
   row.available++;row.replayBytes+=Buffer.byteLength(raw.replay);
   try{checkJob(job);}catch{try{checkJob(job,'extended-local');job.resourceProfile='extended-local';}catch{row.unsupportedInput++;}}
   const proof=proofs.get(ledgerKey(ledgerBinding(job))),held=adverse(source)||adverse(raw)||proof&&ledgerDisposition(proof)!=='verified';
   if(held)row.held++;
   if(!proof)row.noProof++;
   else{
    if(ledgerDisposition(proof)==='verified')row.exactPriorApproved++;
    const match=proof.witnesses.some(w=>w.engineDigest===policy.engineDigest&&w.verifierVersion===policy.verifierVersion&&
     w.verifierFingerprint===policy.verifierFingerprint&&w.resourceProfile===(job.resourceProfile||'standard')&&
     policy.resourceProfiles.includes(w.resourceProfile)&&policy.trackContentHashes[job.trackId]===w.trackContentHash&&
     same(policy.trackGeometries[job.trackId],{geometryPolicy:w.geometryPolicy,trackGeometry:w.trackGeometry}));
    if(match&&!held)row.compatiblePhysicsCandidate++;else row.stalePhysics++;
   }
   jobs.push({periodId:board.id,source:key,lane:job.lane,kind:job.kind,key:ledgerKey(ledgerBinding(job)),held,
    resourceProfile:job.resourceProfile||'standard',replayBytes:Buffer.byteLength(raw.replay)});
  }
  periods.push(row);
 }
 periods.sort((a,b)=>Number(b.kind==='kodub'&&b.liveAtAudit)-Number(a.kind==='kodub'&&a.liveAtAudit)||Number(b.liveAtAudit)-Number(a.liveAtAudit)||b.maxRp-a.maxRp||b.endsAt-a.endsAt||a.periodId.localeCompare(b.periodId));
 const profileFields=['name','nickname','countryCode','profileCosmetics','accountCreatedAt','totalPlaytimeMs','pbCount','latestPbAt','updatedAt','carStyle','carColors'];
 const profileCoverage=Object.fromEntries(profileFields.map(k=>[k,{present:0,missing:0}]));let profiles=0,positivePlaytime=0;
 for(const logical of Object.keys(index.files).filter(k=>/^profiles\/[a-f0-9]{64}\.json$/.test(k))){
  const profile=await read(logical);profiles++;for(const field of profileFields)profileCoverage[field][Object.hasOwn(profile,field)?'present':'missing']++;
  if(Number.isFinite(profile.totalPlaytimeMs)&&profile.totalPlaytimeMs>0)positivePlaytime++;
 }
 const coverage=await read('coverage.json'),summary=await read('public-export-summary.json');
 demand((await fs.readFile(path.join(root,'snapshot-current.json'))).equals(pointerBytes)&&sha(await fs.readFile(path.join(directory,'index.json')))===pins.indexSha256,'source changed during audit');
 return {schemaVersion:1,kind:'saved-event-offline-inventory',authority:false,sourceCommit:pins.sourceCommit,source:plan.publishedBaseline,
  auditAt:now,dispatchPlan:plan,periods,jobs,issues,totals:{periods:periods.length,...Object.fromEntries(['visible','pending','available','missing','invalid','held','compatiblePhysicsCandidate','stalePhysics','noProof','unsupportedInput','replayBytes'].map(k=>[k,periods.reduce((sum,p)=>sum+p[k],0)]))},
  profileAudit:{profiles,positivePlaytime,fields:profileCoverage,sourceFieldName:'totalPlaytimeMs',freshCapturePerformed:false,
   note:'Missing fields remain missing; retained profile counts may exceed the last partial export; no active-time value is invented.'},
  sourceCoverage:{complete:coverage?.complete===true,lastExportComplete:summary?.complete===true,lastExportCounts:summary?.counts,lastProfilesCapturedAt:summary?.profilesCapturedAt},
  unreferencedEventPayloads:Object.keys(index.files).filter(k=>/^(event-replays|event-playbacks)\//.test(k)&&!referenced.has(k)).length,
  localReads:{encodedPayloads:encodedReads,encodedBytes},backendReads:0,backendWrites:0,nativeDispatched:0};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const [root,pinFile,output]=process.argv.slice(2);demand(root&&pinFile&&output,'usage ROOT PIN_JSON NEW_REPORT_JSON');
 const pins=JSON.parse(await fs.readFile(pinFile));const report=await inspectSavedEventPackage({root:path.resolve(root),pins});
 await fs.writeFile(output,JSON.stringify(report,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output,totals:report.totals,first:report.periods[0],profiles:report.profileAudit.profiles}));
}
