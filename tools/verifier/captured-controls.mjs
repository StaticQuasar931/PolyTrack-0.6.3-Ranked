import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {setImmediate as yieldNow} from 'node:timers/promises';
import {compareControls} from './similarity.mjs';
import {compareInputSegment} from './segment-similarity.mjs';
import {inputRateEvidence} from './input-rate.mjs';
import {decodeAnalysisReplay} from './analysis-replay-decoder.mjs';
import {strongNearCloneEvidence,COMPETITIVE_REVIEW_REASON} from '../../workers/ranked/src/competitive-review.js';
import {ledgerBinding,ledgerKey,ledgerDisposition,applyLedgerToBoard} from '../native-verification-ledger.mjs';

const {decodeReplay}=createRequire(import.meta.url)('./replay.cjs');
const hash=value=>createHash('sha256').update(value).digest('hex');
const HASH=/^[a-f0-9]{64}$/;
export const CAPTURED_CONTROL_POLICY_VERSION='snapshot-controls-v1';
export const CAPTURED_CONTROL_LIMITS=Object.freeze({maxInputBytes:64*1024*1024,maxJobs:20000,
  maxPairs:2000000,maxRuntimeMs:120000,maxEvents:2000000,maxPostings:2000000,maxPairWork:8000000,maxFindings:10000});
const SOURCES=['captured-controls.mjs','similarity.mjs','segment-similarity.mjs','input-rate.mjs','replay.cjs','analysis-replay-decoder.mjs',
  '../../workers/ranked/src/competitive-review.js'];
const comparisonFingerprint=()=>hash(Buffer.concat(SOURCES.flatMap(name=>[Buffer.from(name+'\0'),readFileSync(new URL(name,import.meta.url))])));
const fail=reason=>{throw Error(reason);};
function sourceKey(value){
 if(!value||Object.keys(value).sort().join(',')!=='captureSha256,sourceCommit'||
  !/^[a-f0-9]{40}$/.test(value.sourceCommit||'')||!HASH.test(value.captureSha256||''))fail('captured_controls_source_binding');
 return JSON.stringify([value.sourceCommit,value.captureSha256]);
}
function ingested(value){
 if(value instanceof Date)return ingested(value.getTime());
 if(value&&typeof value==='object'&&Object.keys(value).join(',')==='__firestoreTimestamp')return ingested(value.__firestoreTimestamp);
 if(Number.isSafeInteger(value)&&value>0&&value<=8640000000000000)return value;
 if(typeof value!=='string')return null;
 const m=/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.\d{1,9})?Z$/.exec(value),t=m&&Date.parse(value);
 return Number.isSafeInteger(t)&&t>0&&new Date(t).toISOString().slice(0,19)===m[1]?t:null;
}
function held(row){
 return row?.needsReview===true||row?.reviewHold===true||row?.excluded===true||row?.unscored===true||
  ['status','verificationStatus','validationState','verifiedState','reason'].some(k=>typeof row?.[k]==='string'&&
   /held|hold|review|excluded|rejected|mismatch|unavailable_final/.test(row[k]));
}
function identity(job){
 const lane=job?.lane??(job?.kind==='normal'?'normal':job?.kind==='event'||job?.kind==='event-pending'?'event':null);
 if(!['normal','event'].includes(lane)||!HASH.test(job.accountId||'')||!HASH.test(job.trackId||'')||
  !HASH.test(job.replayHash||'')||typeof job.resultId!=='string'||job.resultId.length>256||
  !Number.isSafeInteger(job.timeMs)||job.timeMs<1||job.timeMs>36000000||
  job.source!==undefined&&(typeof job.source!=='string'||job.source.length>4096)||
  job.resourceProfile!==undefined&&!['standard','extended-local'].includes(job.resourceProfile)||
  ['frames','raceTimeFrames'].some(k=>job[k]!==undefined&&(!Number.isSafeInteger(job[k])||job[k]<1||job[k]>36000000))||
  job.uploadId!==undefined&&job.uploadId!==null&&(!Number.isSafeInteger(job.uploadId)||job.uploadId<0)||
  lane==='event'&&(!/^[A-Za-z0-9_.:-]{1,128}$/.test(job.periodId||'')||!HASH.test(job.runId||''))||
  lane==='normal'&&(job.periodId!==undefined||job.runId!==undefined))fail('captured_controls_job_identity');
 return {lane,kind:job.kind??null,resultId:job.resultId,accountId:job.accountId,trackId:job.trackId,
  timeMs:job.timeMs,frames:job.frames??null,raceTimeFrames:job.raceTimeFrames??null,uploadId:job.uploadId??null,
  periodId:job.periodId??null,runId:job.runId??null,replayHash:job.replayHash,source:job.source??null,
  resourceProfile:job.resourceProfile??null,
  ingestedAt:job.ingestedAtSource==='firestore-server-timestamp'?ingested(job.ingestedAt):null,
  sourceHold:held(job),correctionCandidate:job.correctionCandidate===true};
}
const captureKey=job=>hash(JSON.stringify(identity(job)));
const nativeKey=row=>JSON.stringify([row?.resultId,row?.trackId,row?.timeMs,row?.replayHash]);

// A qualifying >=20-change segment necessarily shares a contiguous 19-token window.
// Hash collisions only add pairs; the real policy comparison decides all evidence.
function windows(controls){
 const events=['right','down','left','reset'].flatMap((name,i)=>controls.lists[name].map(tick=>({channel:i+1,tick})))
  .sort((a,b)=>a.tick-b.tick||a.channel-b.channel);
 const tokens=[];for(let i=1;i<events.length;i++)tokens.push((events[i-1].channel*5+events[i].channel)*6000000+events[i].tick-events[i-1].tick);
 const bases=[1315423911,2654435761],powers=bases.map(b=>{let n=1;for(let i=0;i<18;i++)n=Math.imul(n,b);return n;}),h=[0,0],out=new Set();
 for(let i=0;i<tokens.length;i++){
  for(let k=0;k<2;k++){if(i>=19)h[k]=(h[k]-Math.imul(tokens[i-19],powers[k]))|0;h[k]=(Math.imul(h[k],bases[k])+tokens[i])|0;}
  if(i>=18)out.add((h[0]>>>0)+':'+(h[1]>>>0));
 }
 return out;
}
function pairEvidence(a,b){
 const sameTime=a.meta.timeMs===b.meta.timeMs,near=Math.abs(a.meta.timeMs-b.meta.timeMs)<=10;
 const whole=near?compareControls(a.controls,b.controls,a.meta.timeMs,b.meta.timeMs):null;
 const segment=compareInputSegment(a.controls,b.controls,a.meta.timeMs,b.meta.timeMs);
 if(!whole&&!segment)return null;
 const exact=sameTime&&a.signature===b.signature;
 const evidence={kind:exact?'identical_replay':'similar_top_inputs',version:1,exactInput:exact,whole,segment,
  finishGapMs:Math.abs(a.meta.timeMs-b.meta.timeMs),reviewOnly:true};
 return evidence;
}
function recommendation(own,ref,e){
 if(own.meta.correctionCandidate)return null;
 const ownOrder=e.exactInput?own.exactOrder:own.meta.ingestedAt,refOrder=e.exactInput?ref.exactOrder:ref.meta.ingestedAt;
 const known=ownOrder!==null&&refOrder!==null;
 const chronology=known?(refOrder<ownOrder?'earlier_reference':refOrder>ownOrder?'later_reference':'unknown'):'unknown';
 if(e.exactInput)return chronology==='later_reference'?null:{reason:'identical_replay_pending_manual_review',chronology};
 const whole=e.whole??(e.segment?compareControls(own.controls,ref.controls,own.meta.timeMs,ref.meta.timeMs):null);
 const segment=e.segment;
 if(!whole||!segment)return null;
 const strong={kind:'similar_top_inputs',...whole,strongNearClone:true,policyVersion:'strong-near-clone-v1',
  segmentInputSimilarity:segment.inputSimilarity,segmentDurationMs:segment.endTickA-segment.startTickA,
  comparedDurationMs:Math.min(own.meta.timeMs,ref.meta.timeMs),matchedChanges:segment.matchedChanges,
  distinctSteeringChannels:segment.distinctSteeringChannels,offsetTicks:segment.offsetTicks,chronology};
 return strongNearCloneEvidence(strong)&&chronology!=='later_reference'?{reason:COMPETITIVE_REVIEW_REASON,chronology}:null;
}

/** Trusted caller pins a complete capture. No service reads or physics dispatch.
 * previouslyAccepted is an array of {binding,sourceBinding,accepted:true} records
 * derived by the caller from independently validated retained source provenance.
 * Public flags/wasVerified alone are intentionally not acceptance capabilities.
 * The returned function implements local-snapshot-verification's review contract.
 * Incomplete review returns complete:false plus incompleteKeys. Only unaffected
 * bindings receive complete attestations; callers must defer keys, not abort the
 * capture or treat absent attestations as approval. Long analysis-only controls
 * supply comparisons, never native proof. Runtime checks are cooperative.
 */
export function createCapturedControlReview({allJobs,sourceBinding,previouslyAccepted=[],policy,
 policyVersion=CAPTURED_CONTROL_POLICY_VERSION,limits={},clock=()=>performance.now()}={}){
 const pinnedSource=sourceKey(sourceBinding),pinnedBinding=structuredClone(sourceBinding);
 if(!Array.isArray(allJobs)||!Array.isArray(previouslyAccepted)||typeof clock!=='function'||
  policyVersion!==CAPTURED_CONTROL_POLICY_VERSION)fail('captured_controls_options');
 const budget={...CAPTURED_CONTROL_LIMITS,maxPairs:100000,maxRuntimeMs:30000,...limits};
 for(const [key,value]of Object.entries(budget))if(!Object.hasOwn(CAPTURED_CONTROL_LIMITS,key)||
  !Number.isSafeInteger(value)||value<1||value>CAPTURED_CONTROL_LIMITS[key])fail('captured_controls_limits');
 if(allJobs.length>budget.maxJobs||previouslyAccepted.length>budget.maxJobs)fail('captured_controls_input_limit');
 const started=clock(),check=()=>{const at=clock();if(!Number.isFinite(at)||at<started||at-started>budget.maxRuntimeMs)fail('captured_controls_runtime_limit');};
 if(!Number.isFinite(started))fail('captured_controls_clock');
 const serialized=[],rows=[],byKey=new Map();let bytes=0;
 for(const job of allJobs){
  check();const text=JSON.stringify(job);bytes+=Buffer.byteLength(text);if(bytes>budget.maxInputBytes)fail('captured_controls_input_limit');
  const meta=identity(job),key=hash(JSON.stringify(meta));if(byKey.has(key))fail('captured_controls_duplicate_binding');
  if(typeof job.replay!=='string'||job.replay.length>65536||hash(job.replay)!==meta.replayHash)fail('captured_controls_replay_binding');
  const row={key,id:'captured-control-'+hash(pinnedSource+key),meta,replay:job.replay,findings:[],advisory:null};
  rows.push(row);byKey.set(key,row);serialized.push(hash(text));
 }
 const inventoryHash=hash(JSON.stringify(serialized)),fingerprint=comparisonFingerprint();
 const accepted=new Set();
 for(const record of previouslyAccepted){
  if(record?.accepted!==true||sourceKey(record.sourceBinding)!==pinnedSource)fail('captured_controls_acceptance_binding');
  accepted.add(ledgerKey(ledgerBinding(record.binding)));
 }
 const preparationMs=clock()-started;
 if(!Number.isFinite(preparationMs)||preparationMs>budget.maxRuntimeMs)fail('captured_controls_runtime_limit');
 const summary={policyVersion,comparisonFingerprint:fingerprint,inventoryHash,inputBytes:bytes,records:rows.length,
  scope:'exact-input/near-tie-whole/shared-19-token-segment candidates; not exhaustive TAS detection',
  indexBuilds:0,decodableRecords:0,analysisOnlyRecords:0,invalid:[],tracks:[],candidatePairs:0,comparedPairs:0,findings:0,
  events:0,postings:0,pairWork:0,complete:false,stop:null};
 let built;
 async function build(){
  summary.indexBuilds++;const start=clock(),checkWork=()=>{const at=clock();if(!Number.isFinite(at)||at<start||at-start+preparationMs>budget.maxRuntimeMs)fail('captured_controls_runtime_limit');};
  const tracks=new Map();
  try{
   for(let i=0;i<rows.length;i++){
    checkWork();const row=rows[i];
    if(!tracks.has(row.meta.trackId))tracks.set(row.meta.trackId,[]);tracks.get(row.meta.trackId).push(row);
    try{try{row.controls=decodeReplay(row.replay,row.meta.timeMs);}catch{
      try{row.controls=decodeReplay(row.replay,row.meta.timeMs,'extended-local');}catch{
       row.controls=decodeAnalysisReplay(row.replay,row.meta.timeMs);row.analysisOnly=true;summary.analysisOnlyRecords++;
      }
     }
     row.signature=hash(JSON.stringify(row.controls.lists));
     summary.events+=Object.values(row.controls.lists).reduce((n,list)=>n+list.length,0);
     if(summary.events>budget.maxEvents)fail('captured_controls_event_limit');
     row.advisory=inputRateEvidence(row.controls,row.meta.timeMs);summary.decodableRecords++;
    }catch(error){if(error.message==='captured_controls_event_limit')throw error;row.invalid=String(error.reason||error.message).slice(0,128);summary.invalid.push({id:row.id,trackId:row.meta.trackId,reason:row.invalid});}
    if((i&63)===0)await yieldNow();
   }
   for(const [trackId,all]of [...tracks].sort(([a],[b])=>a.localeCompare(b))){
    checkWork();const current=all.filter(r=>!r.invalid),n=current.length,pairs=new Set(),signatures=new Map(),postings=new Map();
    const track={trackId,records:all.length,decodableRecords:n,candidatePairs:0,comparedPairs:0,complete:false};summary.tracks.push(track);
    const add=(a,b)=>{
     if(++summary.pairWork>budget.maxPairWork)fail('captured_controls_pair_work_limit');
     if((summary.pairWork&1023)===0)checkWork();
     if(current[a].meta.accountId===current[b].meta.accountId)return;
     const key=Math.min(a,b)*n+Math.max(a,b);if(pairs.has(key))return;
     if(summary.candidatePairs>=budget.maxPairs)fail('captured_controls_pair_limit');
     pairs.add(key);summary.candidatePairs++;
    };
    for(let i=0;i<n;i++){
     checkWork();const row=current[i],key=row.meta.timeMs+':'+row.signature;
     if(!signatures.has(key))signatures.set(key,[]);signatures.get(key).push(i);
     for(const token of windows(row.controls)){
      if(++summary.postings>budget.maxPostings)fail('captured_controls_posting_limit');
      if(!postings.has(token))postings.set(token,[]);postings.get(token).push(i);
     }
    }
    // Exact-input ownership follows the earliest reliable submission per account,
    // not a later same-account event copy or result-ID ordering.
    for(const group of signatures.values()){
     const earliest=new Map();
     for(const i of group){const row=current[i],at=row.meta.ingestedAt;
      if(at!==null)earliest.set(row.meta.accountId,Math.min(earliest.get(row.meta.accountId)??Infinity,at));}
     for(const i of group)current[i].exactOrder=earliest.get(current[i].meta.accountId)??null;
    }
    const groups=new Set();
    for(const group of [...signatures.values(),...postings.values()]){
     if(group.length<2)continue;const key=group.join(',');if(groups.has(key))continue;groups.add(key);
     for(let a=0;a<group.length;a++)for(let b=a+1;b<group.length;b++)add(group[a],group[b]);
    }
    const order=current.map((_,i)=>i).sort((a,b)=>current[a].meta.timeMs-current[b].meta.timeMs);
    for(let a=0;a<n;a++)for(let b=a+1;b<n&&current[order[b]].meta.timeMs-current[order[a]].meta.timeMs<=10;b++)add(order[a],order[b]);
    track.candidatePairs=pairs.size;
    for(const code of [...pairs].sort((a,b)=>a-b)){
     checkWork();const a=current[Math.floor(code/n)],b=current[code%n],e=pairEvidence(a,b);
     summary.comparedPairs++;track.comparedPairs++;
     if(e){
      if(summary.findings>=budget.maxFindings)fail('captured_controls_finding_limit');
      summary.findings++;
      a.findings.push({referenceId:b.id,referenceKey:b.key,evidence:e,recommendation:recommendation(a,b,e)});
      const reverse={...e,segment:e.segment?{...e.segment,startTickA:e.segment.startTickB,endTickA:e.segment.endTickB,
       startTickB:e.segment.startTickA,endTickB:e.segment.endTickA,offsetTicks:-e.segment.offsetTicks}:null};
      b.findings.push({referenceId:a.id,referenceKey:a.key,evidence:reverse,recommendation:recommendation(b,a,reverse)});
     }
     if((summary.comparedPairs&127)===0)await yieldNow();
    }
    track.complete=all.length===n;for(const row of all)row.trackComplete=track.complete;
    await yieldNow();
   }
   summary.complete=summary.invalid.length===0;
  }catch(error){summary.stop=String(error.message).slice(0,128);}
  // Drop decoded controls and replay bytes after the single complete candidate pass.
  for(const row of rows){delete row.controls;delete row.replay;}
 }
 const ensure=()=>built??=(build());
 const requestedKey=job=>{try{return ledgerKey(ledgerBinding(job,identity(job).lane));}catch{return hash(nativeKey(job));}};
 function deferredResult(job,raw,reason){
  if(!raw||nativeKey(raw)!==nativeKey(job))return {resultId:job.resultId,trackId:job.trackId,timeMs:job.timeMs,
   replayHash:job.replayHash,status:'unavailable',reason};
  const result=structuredClone(raw);if(result.status==='verified'){result.status='unavailable';result.reason=reason;}return result;
 }
 function incomplete(reason,jobs=[],nativeResults=[]){
  const pending=jobs.map(job=>({bindingKey:requestedKey(job),resultId:job.resultId,trackId:job.trackId,reason}));
  return {complete:false,reason,incompleteKeys:pending.map(r=>r.bindingKey),incomplete:pending,
   results:jobs.map(job=>deferredResult(job,nativeResults.find(r=>nativeKey(r)===nativeKey(job)),reason)),reviews:[]};
 }
 async function review({jobs,allJobs:providedJobs,nativeResults,ledger,sourceBinding:providedBinding,policy:currentPolicy=policy}={}){
  try{
   const began=clock(),checkReview=()=>{const at=clock();if(!Number.isFinite(at)||at<began||at-began>budget.maxRuntimeMs)fail('captured_controls_runtime_limit');};
   if(!Number.isFinite(began))fail('captured_controls_clock');
   if(sourceKey(providedBinding)!==pinnedSource)fail('captured_controls_source_changed');
   if(!currentPolicy?.reviewPolicyVersions?.includes(policyVersion))fail('captured_controls_policy_missing');
   if(!Array.isArray(jobs)||jobs.length>256||!Array.isArray(nativeResults)||jobs.length!==nativeResults.length)fail('captured_controls_batch_binding');
   if(providedJobs!==undefined){
    if(!Array.isArray(providedJobs)||providedJobs.length!==rows.length)fail('captured_controls_inventory_changed');
    let size=0;const values=providedJobs.map(j=>{checkReview();const text=JSON.stringify(j);size+=Buffer.byteLength(text);if(size>budget.maxInputBytes)fail('captured_controls_input_limit');return hash(text);});
    if(hash(JSON.stringify(values))!==inventoryHash)fail('captured_controls_inventory_changed');
   }
   await ensure();
   if(summary.stop)fail(summary.stop);
   // This checks the existing ledger's private brand and full policy, without I/O.
   applyLedgerToBoard({board:{entries:[]},ledger,canonicalRows:[],recordings:[],policy:currentPolicy});
   const existing=new Map(ledger.entries.map(entry=>[entry.key,entry]));
   const results=[],reviews=[],evidence=[],pending=[],seen=new Set(),nativeByKey=new Map();
   for(const result of nativeResults){const key=nativeKey(result);if(nativeByKey.has(key))fail('captured_controls_ambiguous_native');nativeByKey.set(key,result);}
   const unknownTracks=new Set(jobs.filter(job=>!byKey.has(captureKey(job))).map(job=>job.trackId));
   for(const job of jobs){
    checkReview();
    const raw=nativeByKey.get(nativeKey(job));
    try{
    const key=captureKey(job),row=byKey.get(key),binding=ledgerBinding(job,identity(job).lane),bindingKey=ledgerKey(binding);
    if(!row||unknownTracks.has(job.trackId)||seen.has(key)||typeof job.replay!=='string'||hash(job.replay)!==binding.replayHash||!row.trackComplete)fail('captured_controls_coverage_incomplete');
    seen.add(key);
    if(!raw||!['verified','unavailable','mismatch'].includes(raw.status))fail('captured_controls_native_binding');
    const prior=existing.get(bindingKey),sticky=prior?ledgerDisposition(prior):null;
    const protectedOriginal=accepted.has(bindingKey)||sticky==='verified';
    const finding=row.findings.find(f=>f.recommendation);
    let disposition='approved',reason=null;
    if(sticky==='excluded'||job.excluded===true){disposition='excluded';reason='captured_controls_sticky_exclusion';}
    else if(sticky==='held'||held(job)||held(raw)||row.meta.correctionCandidate){disposition='held';reason='captured_controls_sticky_review';}
    else if(finding&&!protectedOriginal){disposition='held';reason=finding.recommendation.reason;}
    if(raw.status!=='verified'&&disposition==='approved'){disposition='held';reason='captured_controls_native_not_positive';}
    const detail={bindingKey,sourceBinding:pinnedBinding,inventoryHash,comparisonFingerprint:fingerprint,policyVersion,
     ledgerManifestHash:ledger.manifestHash,disposition,reason,acceptedOriginalProtected:protectedOriginal,
     id:row.id,findings:row.findings,advisory:row.advisory,reviewOnly:true};
    const attestationHash=hash(JSON.stringify(detail));
    reviews.push({complete:true,disposition,bindingKey,policyVersion,attestationHash});
    evidence.push({...structuredClone(detail),attestationHash});
    const result=structuredClone(raw);
    if(raw.status==='verified'&&disposition!=='approved'){result.status='unavailable';result.reason=reason;}
    results.push(result);
    }catch(error){
     const reason=String(error.message).slice(0,128),bindingKey=requestedKey(job);
     // If a duplicate identity is found, withdraw any earlier attestation too.
     if(reviews.some(r=>r.bindingKey===bindingKey))return incomplete('captured_controls_duplicate_batch',jobs,nativeResults);
     pending.push({bindingKey,resultId:job.resultId,trackId:job.trackId,reason});
     results.push(deferredResult(job,raw,reason));
    }
   }
   return {complete:pending.length===0,results,reviews,evidence,incompleteKeys:pending.map(r=>r.bindingKey),incomplete:pending,coverage:structuredClone(summary)};
  }catch(error){return incomplete(String(error.message).slice(0,128),Array.isArray(jobs)?jobs:[],Array.isArray(nativeResults)?nativeResults:[]);}
 }
 review.inspect=async()=>{await ensure();return structuredClone(summary);};
 review.artifact=async()=>{await ensure();return {artifactVersion:1,sourceBinding:structuredClone(pinnedBinding),coverage:structuredClone(summary),
  rows:rows.map(row=>({id:row.id,captureBindingKey:row.key,binding:structuredClone(row.meta),
   complete:summary.stop===null&&row.trackComplete===true,
   incompleteReason:summary.stop??(row.trackComplete===true?null:row.invalid||'captured_controls_coverage_incomplete'),analysisOnly:row.analysisOnly===true,
   findings:structuredClone(row.findings),advisory:structuredClone(row.advisory)}))};};
 return review;
}
