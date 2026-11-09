import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createCapturedControlReview,CAPTURED_CONTROL_LIMITS} from './captured-controls.mjs';
import {ledgerBinding,ledgerKey,writeLedger,createLedgerEntry} from '../native-verification-ledger.mjs';
import {verifyLocalSnapshot} from './local-snapshot-verification.mjs';

const sha=x=>createHash('sha256').update(x).digest('hex');
const sourceBinding={sourceCommit:'a'.repeat(40),captureSha256:'b'.repeat(64)},track='c'.repeat(64);
const policy={engineDigest:'d'.repeat(64),compatibleEngines:[],verifierVersion:'polytrack-native-bounded-v1',
 verifierFingerprint:'e'.repeat(64),resourceProfiles:['standard','extended-local'],reviewPolicyVersions:['snapshot-controls-v1'],
 trackContentHashes:{[track]:'f'.repeat(64)},trackGeometries:{[track]:{geometryPolicy:'default',trackGeometry:{parts:20,spanX:100,spanZ:120}}}};
function encode(lists){
 const chunks=[];for(const list of Object.values(lists)){const bytes=Buffer.alloc(3+list.length*3);bytes.writeUIntLE(list.length,0,3);
  let last=0;list.forEach((tick,i)=>{bytes.writeUIntLE(tick-last,3+i*3,3);last=tick;});chunks.push(bytes);}
 return deflateSync(Buffer.concat(chunks)).toString('base64url');
}
function job(number=1,{shift=0,timeMs=20000,...extra}={}){
 const lists={up:[0],right:Array.from({length:50},(_,i)=>i*400+shift),down:[],left:Array.from({length:50},(_,i)=>i*400+200+shift),reset:[]};
 const replay=encode(lists),accountId=number.toString(16).padStart(64,'0');
 return {lane:'normal',accountId,trackId:track,timeMs,frames:timeMs,uploadId:number,replay,replayHash:sha(replay),
  resultId:accountId+'_'+track,...extra};
}
function native(j){
 const binding={verifierVersion:policy.verifierVersion,verifierFingerprint:policy.verifierFingerprint,resourceProfile:'standard',
  resultId:j.resultId,trackId:j.trackId,timeMs:j.timeMs,replayHash:j.replayHash,actualReplayHash:sha(j.replay),
  nativeTrackId:j.trackId,trackContentHash:policy.trackContentHashes[j.trackId],engineDigest:policy.engineDigest};
 return {resultId:j.resultId,trackId:j.trackId,timeMs:j.timeMs,replayHash:j.replayHash,status:'verified',reason:'native_exact_finish',
  deterministic:true,engineDigest:policy.engineDigest,trackContentHash:binding.trackContentHash,
  ...structuredClone(policy.trackGeometries[j.trackId]),binding,boundInputFingerprint:sha(JSON.stringify(binding))};
}
async function emptyLedger(t,entries=[]){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'captured-control-test-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));return writeLedger({root,entries,expectedManifestHash:null});
}
const accepted=j=>({accepted:true,binding:ledgerBinding(j),sourceBinding});
const factory=(allJobs,extra={})=>createCapturedControlReview({allJobs,sourceBinding,policy,...extra});
const invoke=(review,jobs,ledger,extra={})=>review({jobs,nativeResults:jobs.map(native),ledger,sourceBinding,policy,...extra});

test('full capture finds an exact cross-batch reference beyond ten peers and builds once',async t=>{
 const jobs=[job(1),...Array.from({length:11},(_,i)=>job(i+2,{shift:i+1,timeMs:30000})),job(20)];
 const review=factory(jobs),ledger=await emptyLedger(t);
 const first=await invoke(review,[jobs[0]],ledger),last=await invoke(review,[jobs.at(-1)],ledger);
 assert.equal(first.complete,true);assert.equal(first.reviews[0].disposition,'held');
 assert.equal(last.reviews[0].disposition,'held');assert.ok(first.evidence[0].findings.some(f=>f.evidence.exactInput));
 assert.equal((await review.inspect()).indexBuilds,1);
});

test('only ingestedAt establishes chronology, never PB/client/received/account dates',async t=>{
 const ledger=await emptyLedger(t),a=job(1,{pbAt:1,receivedAt:1,accountCreatedAt:1}),b=job(2,{pbAt:999999,receivedAt:999999});
 const unknown=await invoke(factory([a,b]),[a,b],ledger);
 assert.deepEqual(unknown.reviews.map(r=>r.disposition),['held','held']);
 const earlier={...a,ingestedAt:'2026-10-30T08:00:00Z',ingestedAtSource:'firestore-server-timestamp'},
  later={...b,ingestedAt:'2026-10-30T08:01:00Z',ingestedAtSource:'firestore-server-timestamp'};
 const known=await invoke(factory([earlier,later]),[earlier,later],ledger);
 assert.deepEqual(known.reviews.map(r=>r.disposition),['approved','held']);
});

test('accepted-original protection requires exact source evidence, not wasVerified or client flags',async t=>{
 const a=job(1,{wasVerified:true,previouslyAccepted:true}),b=job(2),ledger=await emptyLedger(t);
 const untrusted=await invoke(factory([a,b]),[a],ledger);assert.equal(untrusted.reviews[0].disposition,'held');
 const trusted=await invoke(factory([a,b],{previouslyAccepted:[accepted(a)]}),[a],ledger);
 assert.equal(trusted.reviews[0].disposition,'approved');assert.equal(trusted.evidence[0].acceptedOriginalProtected,true);
 const wrong=accepted({...a,uploadId:99});
 assert.equal((await invoke(factory([a,b],{previouslyAccepted:[wrong]}),[a],ledger)).reviews[0].disposition,'held');
 assert.throws(()=>factory([a],{previouslyAccepted:[{...accepted(a),sourceBinding:{...sourceBinding,captureSha256:'0'.repeat(64)}}]}),/acceptance_binding/);
});

test('immutable physics objects stay native positives while cloned decisions hold',async t=>{
 const jobs=[job(1),job(2)],before=structuredClone(jobs),raw=jobs.map(native),original=structuredClone(raw);
 for(const r of raw){Object.freeze(r.binding);Object.freeze(r);}Object.freeze(raw);
 const result=await invoke(factory(jobs),jobs,await emptyLedger(t),{nativeResults:raw});
 assert.equal(result.results[0].status,'unavailable');assert.deepEqual(raw,original);assert.deepEqual(jobs,before);
 assert.notEqual(result.results[0],raw[0]);assert.deepEqual(result.results[0].binding,raw[0].binding);
});

test('returned artifacts/evidence cannot mutate cached findings or source pins',async t=>{
 const jobs=[job(1),job(2)],review=factory(jobs),ledger=await emptyLedger(t);
 const first=await invoke(review,[jobs[0]],ledger);first.evidence[0].findings.length=0;
 first.evidence[0].sourceBinding.captureSha256='0'.repeat(64);
 const artifact=await review.artifact();artifact.rows[0].findings.length=0;
 const next=await invoke(review,[jobs[0]],ledger);
 assert.equal(next.complete,true);assert.equal(next.reviews[0].disposition,'held');assert.ok(next.evidence[0].findings.length);
});

test('branded exact ledger approvals protect originals; held/excluded history remains sticky',async t=>{
 for(const disposition of ['approved','held','excluded']){
  const a=job(1),b=job(2),raw=native(a),key=ledgerKey(ledgerBinding(a));
  const entry=createLedgerEntry({job:a,nativeResult:raw,result:disposition==='approved'?raw:{...raw,status:'unavailable',reason:'manual_review'},
   review:{complete:true,disposition,bindingKey:key,policyVersion:'snapshot-controls-v1',attestationHash:'1'.repeat(64)},verifiedAt:Date.now()-1000,policy});
  const ledger=await emptyLedger(t,[entry]);
  const result=await invoke(factory([a,b],{previouslyAccepted:[accepted(a)]}),[a],ledger);
  assert.equal(result.complete,true);assert.equal(result.reviews[0].disposition,disposition);
 }
});

test('slower-finish segments remain candidates; advisory similarities do not become cheating verdicts',async t=>{
 const a=job(1),b=job(2,{timeMs:40000}),review=factory([a,b]);
 const result=await invoke(review,[b],await emptyLedger(t));
 assert.equal(result.complete,true);assert.equal(result.reviews[0].disposition,'approved');
 assert.ok(result.evidence[0].findings[0].evidence.segment);assert.equal((await review.inspect()).candidatePairs,1);
});

test('rapid-input policy remains advisory and never manufactures a native failure',async t=>{
 const a=job(1),replay=encode({up:Array.from({length:24},(_,i)=>i*20),right:[],down:[],left:[],reset:[]});
 Object.assign(a,{replay,replayHash:sha(replay)});
 const result=await invoke(factory([a]),[a],await emptyLedger(t));
 assert.equal(result.reviews[0].disposition,'approved');assert.equal(result.results[0].status,'verified');
 assert.equal(result.evidence[0].advisory.kind,'rapid_input');
});

test('pair/work/event/posting limits produce incomplete coverage and no approval attestations',async t=>{
 const jobs=[job(1),job(2),job(3)],ledger=await emptyLedger(t);
 for(const limits of [{maxPairs:1},{maxPairWork:1},{maxEvents:1},{maxPostings:1},{maxFindings:1}]){
  const review=factory(jobs,{limits}),result=await invoke(review,[jobs[0]],ledger);
  assert.equal(result.complete,false,JSON.stringify(limits));assert.deepEqual(result.reviews,[]);
  assert.equal(result.results[0].status,'unavailable');assert.ok((await review.inspect()).stop);
 }
});

test('input and runtime caps fail closed without native execution',async t=>{
 assert.throws(()=>factory([job()],{limits:{maxInputBytes:10}}),/input_limit/);
 assert.throws(()=>factory([job()],{limits:{maxInputBytes:CAPTURED_CONTROL_LIMITS.maxInputBytes+1}}),/limits/);
 const ledger=await emptyLedger(t);
 let tick=0;const review=factory([job()],{clock:()=>tick,limits:{maxRuntimeMs:1}});
 setImmediate(()=>{tick=100;});
 const result=await invoke(review,[job()],ledger);
 assert.equal(result.complete,false);assert.match(result.reason,/runtime_limit/);
});

test('an undecodable retained peer prevents same-track approval, without hiding its exclusion',async t=>{
 const a=job(1),replay=encode({up:[0,20001],right:[],down:[],left:[],reset:[]});
 const bad=job(2,{replay,replayHash:sha(replay)}),review=factory([a,bad]);
 const result=await invoke(review,[a],await emptyLedger(t));
 assert.equal(result.complete,false);assert.equal(result.reviews.length,0);
 const s=await review.inspect();assert.equal(s.invalid.length,1);assert.equal(s.invalid[0].reason,'transition_after_claim');
});

test('changed source, changed complete inventory, missing policy or unbranded ledger never approve',async t=>{
 const a=job(),ledger=await emptyLedger(t),review=factory([a]);
 for(const extra of [{sourceBinding:{...sourceBinding,captureSha256:'0'.repeat(64)}},{allJobs:[{...a,pbAt:1}]},
  {policy:{...policy,reviewPolicyVersions:[]}},{ledger:{entries:[],manifestHash:'0'.repeat(64)}}]){
  const result=await invoke(review,[a],ledger,extra);assert.equal(result.complete,false);assert.equal(result.reviews.length,0);
 }
});

test('normal/event/period result-ID collisions have unique internal identities, ambiguous batches defer',async t=>{
 const id='9'.repeat(64),a=job(1,{lane:'event',periodId:'week_a',runId:id,resultId:id,uploadId:null});
 const b=job(2,{lane:'event',periodId:'week_b',runId:id,resultId:id,uploadId:null});
 const review=factory([a,b]),artifact=await review.artifact();
 assert.notEqual(artifact.rows[0].id,artifact.rows[1].id);
 const result=await invoke(review,[a,b],await emptyLedger(t));assert.equal(result.complete,false);assert.match(result.reason,/ambiguous_native/);
 assert.equal((await invoke(review,[a],await emptyLedger(t))).reviews[0].disposition,'held');
});

test('source review flags and correction guards cannot be cleared by acceptance records',async t=>{
 for(const patch of [{needsReview:true},{reviewHold:true},{correctionCandidate:true},{excluded:true}]){
  const a=job(1,patch),result=await invoke(factory([a],{previouslyAccepted:[accepted(a)]}),[a],await emptyLedger(t));
  assert.equal(result.complete,true);assert.equal(result.reviews[0].disposition,patch.excluded?'excluded':'held');
 }
});

test('nonpositive native outcomes are never upgraded and mismatched batch bindings defer',async t=>{
 const a=job(),review=factory([a]),ledger=await emptyLedger(t),raw={...native(a),status:'unavailable',reason:'native_timeout'};
 const result=await invoke(review,[a],ledger,{nativeResults:[raw]});assert.equal(result.results[0].status,'unavailable');
 assert.equal(result.results[0].reason,'native_timeout');assert.equal(result.reviews[0].disposition,'held');
 const changed=await invoke(review,[a],ledger,{nativeResults:[{...native(a),replayHash:'0'.repeat(64)}]});
 assert.equal(changed.complete,false);assert.equal(changed.reviews.length,0);
});

test('adapter outputs are accepted by the existing native-ledger constructor without changing raw proofs',async t=>{
 for(const withPeer of [false,true]){
  const a=job(1),jobs=withPeer?[a,job(2)]:[a],raw=native(a),review=await invoke(factory(jobs),[a],await emptyLedger(t),{nativeResults:[raw]});
  assert.equal(review.complete,true);
  const entry=createLedgerEntry({job:a,nativeResult:raw,result:review.results[0],review:review.reviews[0],verifiedAt:Date.now()-1,policy});
  assert.equal(entry.witnesses[0].review.disposition,withPeer?'held':'approved');
  assert.equal(raw.status,'verified');assert.equal(raw.reason,'native_exact_finish');
 }
});

test('typed server ingestion timestamps are reliable, malformed calendars remain unknown',async t=>{
 const a=job(1,{ingestedAt:{__firestoreTimestamp:'2026-10-30T08:00:00Z'},ingestedAtSource:'firestore-server-timestamp'}),
  b=job(2,{ingestedAt:new Date('2026-10-30T08:01:00Z'),ingestedAtSource:'firestore-server-timestamp'});
 const ledger=await emptyLedger(t),known=await invoke(factory([a,b]),[a,b],ledger);
 assert.deepEqual(known.reviews.map(r=>r.disposition),['approved','held']);
 const bad={...a,ingestedAt:'2026-02-30T08:00:00Z'};
 const unknown=await invoke(factory([bad,b]),[bad,b],ledger);
 assert.deepEqual(unknown.reviews.map(r=>r.disposition),['held','held']);
});

test('unmarked or client-labelled numeric ingestion dates never establish clone chronology',async t=>{
 const ledger=await emptyLedger(t);
 for(const ingestedAtSource of [undefined,'client','diagnostic']){
  const a=job(1,{ingestedAt:100,ingestedAtSource}),b=job(2,{ingestedAt:200,ingestedAtSource});
  const result=await invoke(factory([a,b]),[a,b],ledger);
  assert.deepEqual(result.reviews.map(r=>r.disposition),['held','held']);
 }
});

test('strong near-tie policy holds new candidates while preserving an exact trusted original',async t=>{
 const a=job(1),b=job(2,{timeMs:20001}),ledger=await emptyLedger(t);
 const result=await invoke(factory([a,b],{previouslyAccepted:[accepted(a)]}),[a,b],ledger);
 assert.equal(result.complete,true);assert.deepEqual(result.reviews.map(r=>r.disposition),['approved','held']);
 assert.equal(result.results[1].reason,'similar_replay_pending_manual_review');
 assert.equal(result.evidence[1].findings[0].recommendation.chronology,'unknown');
});

test('same-account retained results are not cross-account clone references',async t=>{
 const a=job(1),old={...a,uploadId:999},review=factory([a,old]);
 const result=await invoke(review,[a],await emptyLedger(t));
 assert.equal(result.complete,true);assert.equal(result.reviews[0].disposition,'approved');
 assert.equal((await review.inspect()).candidatePairs,0);
});

test('an unavailable other-track reference does not starve fully reviewed tracks',async t=>{
 const a=job(1),replay=encode({up:[0,20001],right:[],down:[],left:[],reset:[]});
 const bad=job(2,{trackId:'7'.repeat(64),replay,replayHash:sha(replay)});
 bad.resultId=bad.accountId+'_'+bad.trackId;
 const result=await invoke(factory([a,bad]),[a],await emptyLedger(t));
 assert.equal(result.complete,true);assert.equal(result.reviews[0].disposition,'approved');
 assert.equal(result.coverage.complete,false);assert.equal(result.coverage.invalid.length,1);
});

test('partial batches attest unaffected tracks and return exact incompleteKeys without approving affected rows',async t=>{
 const a=job(1),otherTrack='7'.repeat(64),b=job(2,{trackId:otherTrack});b.resultId=b.accountId+'_'+otherTrack;
 const replay=encode({up:[0,20001],right:[],down:[],left:[],reset:[]});
 const bad=job(3,{trackId:otherTrack,replay,replayHash:sha(replay)});bad.resultId=bad.accountId+'_'+otherTrack;
 const review=factory([a,b,bad]),raw=[native(a),native(b)],before=structuredClone(raw);
 const result=await invoke(review,[a,b],await emptyLedger(t),{nativeResults:raw});
 assert.equal(result.complete,false);assert.deepEqual(result.incompleteKeys,[ledgerKey(ledgerBinding(b))]);
 assert.equal(result.reviews.length,1);assert.equal(result.reviews[0].bindingKey,ledgerKey(ledgerBinding(a)));
 assert.equal(result.reviews[0].disposition,'approved');assert.equal(result.results[0].status,'verified');
 assert.equal(result.results[1].status,'unavailable');assert.deepEqual(raw,before);
});

test('bounded analysis decoder handles long controls without granting native physics authority',async t=>{
 const a=job(1),replay=encode({up:[0,3800000],right:[],down:[],left:[],reset:[]});
 const long=job(2,{timeMs:3803964,replay,replayHash:sha(replay)}),review=factory([a,long]);
 const raw={...native(long),status:'unavailable',reason:'time_limit'},before=structuredClone(raw);
 const result=await invoke(review,[a,long],await emptyLedger(t),{nativeResults:[native(a),raw]});
 assert.equal(result.complete,true);assert.equal(result.coverage.analysisOnlyRecords,1);
 assert.equal(result.results[1].status,'unavailable');assert.equal(result.results[1].reason,'time_limit');
 assert.equal(result.reviews[1].disposition,'held');assert.deepEqual(raw,before);
});

test('exact ownership uses earliest trusted same-account capture chronology, not a later copy',async t=>{
 const original=job(1,{ingestedAt:100,ingestedAtSource:'firestore-server-timestamp'});
 const copy={...original,uploadId:999,ingestedAt:1000};
 const peer=job(2,{ingestedAt:500,ingestedAtSource:'firestore-server-timestamp'});
 const result=await invoke(factory([original,copy,peer]),[copy,peer],await emptyLedger(t));
 assert.equal(result.complete,true);assert.deepEqual(result.reviews.map(r=>r.disposition),['approved','held']);
});

test('artifact explicitly marks incomplete bindings and contains no replay payloads',async()=>{
 const a=job(1),replay=encode({up:[0,20001],right:[],down:[],left:[],reset:[]});
 const bad=job(2,{replay,replayHash:sha(replay)}),artifact=await factory([a,bad]).artifact();
 assert.equal(artifact.artifactVersion,1);assert.equal(artifact.rows.length,2);
 for(const row of artifact.rows){assert.equal(row.complete,false);assert.match(row.captureBindingKey,/^[a-f0-9]{64}$/);assert.ok(row.incompleteReason);}
 assert.equal(JSON.stringify(artifact).includes(a.replay),false);assert.equal(JSON.stringify(artifact).includes(bad.replay),false);
});

test('real adapter/orchestrator integration defers one affected track and completes healthy batches',async t=>{
 const healthyTrack='7'.repeat(64),healthy=job(1,{trackId:healthyTrack});healthy.resultId=healthy.accountId+'_'+healthyTrack;
 const affected=job(2),replay=encode({up:[0,20001],right:[],down:[],left:[],reset:[]});
 const bad=job(3,{replay,replayHash:sha(replay)}),allJobs=[healthy,affected,bad];
 const currentPolicy={...policy,trackContentHashes:{...policy.trackContentHashes,[healthyTrack]:policy.trackContentHashes[track]},
  trackGeometries:{...policy.trackGeometries,[healthyTrack]:policy.trackGeometries[track]}};
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'captured-control-integration-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
 let calls=0;
 const result=await verifyLocalSnapshot({root,ledgerRoot:path.join(root,'ledger'),expectedManifestHash:null,
  jobs:[healthy,affected],allJobs,sourceBinding,policy:currentPolicy,review:factory(allJobs,{policy:currentPolicy}),
  validateEngine:async()=>{},verify:async(_root,jobs)=>{calls++;return jobs.map(j=>{
   const r=native(j);r.trackContentHash=currentPolicy.trackContentHashes[j.trackId];
   Object.assign(r,currentPolicy.trackGeometries[j.trackId]);r.binding.trackContentHash=r.trackContentHash;
   r.boundInputFingerprint=sha(JSON.stringify(r.binding));return r;
  });},batchSize:1,maxJobs:2,maxRuntimeMs:300000,packReserveMs:1000,env:{}});
 assert.equal(calls,2);assert.equal(result.counts.verified,1);assert.equal(result.counts.unavailable,1);
 assert.equal(result.counts.unprocessed,0);assert.equal(result.ledger.entries.length,1);
 assert.equal(result.ledger.entries[0].binding.accountId,healthy.accountId);
 assert.equal(result.decisions.find(r=>r.binding.accountId===affected.accountId).reason,'captured_controls_coverage_incomplete');
});

// Differential reference: pre-streaming build, with the same current comparison
// fingerprint and review code. Used only on bounded fixtures fitting the old cap.
const legacyBuild=`
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
`;
async function legacyFactory(allJobs,extra={}) {
 const moduleUrl=new URL('./captured-controls.mjs',import.meta.url);
 let source=await fs.readFile(moduleUrl,'utf8');
 const start=source.indexOf(' async function build(){'),end=source.indexOf(' const ensure=',start);
 source=source.slice(0,start)+legacyBuild+source.slice(end);
 source=source.replace(/import\.meta\.url/g,JSON.stringify(moduleUrl.href));
 source=source.replace(/from '([^']+)'/g,(match,name)=>name.startsWith('.')?'from '+JSON.stringify(new URL(name,moduleUrl).href):match);
 const module=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
 return module.createCapturedControlReview({allJobs,sourceBinding,policy,...extra});
}


function onTrack(value,trackId){return {...value,trackId,resultId:value.lane==='event'?value.resultId:value.accountId+'_'+trackId};}
function denseJobs(count,{sameTrack=false}={}){
 const replay=encode({up:Array.from({length:20000},(_,i)=>i),right:Array.from({length:20000},(_,i)=>i),down:[],left:[],reset:[]});
 return Array.from({length:count},(_,i)=>onTrack(job(i+1,{replay,replayHash:sha(replay)}),sameTrack?track:(i+1).toString(16).padStart(64,'0')));
}

test('track streaming exceeds two million aggregate events while retaining only one track controls inventory',async t=>{
 const jobs=denseJobs(51),review=factory(jobs),summary=await review.inspect();
 assert.equal(CAPTURED_CONTROL_LIMITS.maxEvents,2000000);
 assert.equal(summary.stop,null);assert.equal(summary.complete,true);
 assert.equal(summary.events,2040000);assert.equal(summary.peakEvents,40000);assert.equal(summary.retainedEvents,0);
 assert.equal(summary.decodableRecords,51);assert.equal(summary.analysisOnlyRecords,51);
 assert.equal(summary.tracks.length,51);assert(summary.tracks.every(value=>value.complete));
 const result=await invoke(review,[jobs[0],jobs.at(-1)],await emptyLedger(t));
 assert.equal(result.complete,true);assert.equal(result.reviews.length,2);
 assert(result.reviews.every(value=>value.disposition==='approved'));
 const artifact=await review.artifact();assert.deepEqual(artifact.rows.map(value=>value.binding.trackId),jobs.map(value=>value.trackId));
 assert.equal(artifact.coverage.indexBuilds,1);assert.equal(artifact.coverage.retainedEvents,0);
 assert(!JSON.stringify(artifact).includes(jobs[0].replay));
});

test('one track exceeding the unchanged two-million-event cap fails closed and releases controls',async t=>{
 const jobs=denseJobs(51,{sameTrack:true}),review=factory(jobs),result=await invoke(review,[jobs[0]],await emptyLedger(t));
 assert.equal(result.complete,false);assert.equal(result.reason,'captured_controls_event_limit');assert.deepEqual(result.reviews,[]);
 assert.equal(result.results[0].status,'unavailable');const summary=await review.inspect();
 assert.equal(summary.retainedEvents,0);assert.equal(summary.stop,'captured_controls_event_limit');
 assert((await review.artifact()).rows.every(value=>!value.complete));
});

test('streamed findings, chronology, advisories, membership and attestation hashes exactly match pre-streaming review',async t=>{
 const other='7'.repeat(64),badTrack1='9'.repeat(64),badTrack2='8'.repeat(64);
 const a=job(1,{ingestedAt:100,ingestedAtSource:'firestore-server-timestamp'}),copy={...a,uploadId:999,ingestedAt:1000},
  peer=job(2,{ingestedAt:500,ingestedAtSource:'firestore-server-timestamp'}),b=onTrack(job(3),other),c=onTrack(job(4,{timeMs:20001}),other);
 const replay=encode({up:Array.from({length:24},(_,i)=>i*20),right:[],down:[],left:[],reset:[]}),rapid=job(5,{replay,replayHash:sha(replay)});
 const badReplay=encode({up:[0,20001],right:[],down:[],left:[],reset:[]});
 const bad1=onTrack(job(6,{replay:badReplay,replayHash:sha(badReplay)}),badTrack1),bad2=onTrack(job(7,{replay:badReplay,replayHash:sha(badReplay)}),badTrack2);
 const jobs=[b,a,rapid,copy,bad1,peer,bad2,c],ledger=await emptyLedger(t),extra={previouslyAccepted:[accepted(a)]};
 const streaming=factory(jobs,{...extra,limits:{maxEvents:400}}),baseline=await legacyFactory(jobs,{...extra,limits:{maxEvents:2000000}});
 const targets=[copy,peer,b,c,rapid,bad1,bad2],input={allJobs:jobs};
 const actual=await invoke(streaming,targets,ledger,input),expected=await invoke(baseline,targets,ledger,input);
 assert.deepEqual(actual.reviews,expected.reviews);assert.deepEqual(actual.results,expected.results);
 assert.deepEqual(actual.evidence,expected.evidence);assert.deepEqual(actual.incomplete,expected.incomplete);
 const strip=({peakEvents,retainedEvents,...summary})=>summary;
 assert.deepEqual(strip(actual.coverage),strip(expected.coverage));
 const artifact=await streaming.artifact(),original=await baseline.artifact();
 assert.deepEqual(artifact.rows,original.rows);assert.deepEqual(strip(artifact.coverage),strip(original.coverage));
 assert.equal(actual.evidence.find(value=>value.id===artifact.rows[2].id).advisory.kind,'rapid_input');
 assert.deepEqual(actual.coverage.invalid.map(value=>value.trackId),[badTrack1,badTrack2]);
 assert.equal(actual.coverage.retainedEvents,0);assert(actual.coverage.events>actual.coverage.peakEvents);
});

test('posting, pair, work and finding budgets remain global across streamed tracks',async t=>{
 const jobs=[job(1),job(2),onTrack(job(3),'7'.repeat(64)),onTrack(job(4),'7'.repeat(64))],ledger=await emptyLedger(t);
 const firstTrack=await factory(jobs.slice(0,2)).inspect(),postingCount=firstTrack.postings;
 for(const [limits,reason]of [[{maxPostings:postingCount},'posting'],[{maxPairs:1},'pair'],[{maxPairWork:firstTrack.pairWork},'pair_work'],[{maxFindings:1},'finding']]){
  const review=factory(jobs,{limits}),result=await invoke(review,jobs,ledger);
  assert.equal(result.complete,false);assert.equal(result.reason,'captured_controls_'+reason+'_limit');
  assert.deepEqual(result.reviews,[]);const summary=await review.inspect();
  assert.equal(summary.retainedEvents,0);assert(summary.tracks.some(value=>value.complete));
  assert((await review.artifact()).rows.every(value=>!value.complete));
 }
});


test('runtime budget is not renewed between tracks and failed work releases decoded controls',async t=>{
 const jobs=[onTrack(job(1),'1'.repeat(64)),onTrack(job(2),'2'.repeat(64))],ledger=await emptyLedger(t);
 let tick=0;const review=factory(jobs,{clock:()=>tick,limits:{maxRuntimeMs:1}});
 setImmediate(()=>setImmediate(()=>{tick=100;}));
 const result=await invoke(review,jobs,ledger),summary=await review.inspect();
 assert.equal(result.complete,false);assert.equal(result.reason,'captured_controls_runtime_limit');
 assert.deepEqual(result.reviews,[]);assert.equal(summary.retainedEvents,0);
 assert.equal(summary.tracks.length,1);assert.equal(summary.tracks[0].complete,true);
});
