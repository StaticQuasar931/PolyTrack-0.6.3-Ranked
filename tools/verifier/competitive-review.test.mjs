import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createSimilarityReviewer, similarityEvidence, compareControls} from './similarity.mjs';
import {compareInputSegment} from './segment-similarity.mjs';
import {inputRateEvidence} from './input-rate.mjs';
import {decodeAnalysisReplay} from './analysis-replay-decoder.mjs';
import {encodeSnapshot} from '../snapshot-package.mjs';
import {publishResults} from './runner.mjs';
import {completedSlot} from './queue.mjs';
import {runEventCoordinator} from './events.mjs';
import {createEventService, EVENT_COLLECTIONS as C} from '../../workers/ranked/src/events.js';
import {verificationKey, pendingSlot, bootstrapSlots, verifiedVerdict, verifiedTargetMs,
  VERIFICATION_COLLECTION, VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION} from '../../workers/ranked/src/verification.js';

globalThis.fetch=()=>{throw Error('SYNTHETIC_TEST_OFFLINE_ONLY');};
const HOLD='similar_replay_pending_manual_review';
const track='a'.repeat(64),referenceAccount='b'.repeat(64),candidateAccount='c'.repeat(64),duration=24000;
const digest=value=>createHash('sha256').update(value).digest('hex');
const baseLists={up:[0],right:Array.from({length:120},(_,i)=>100+i*185),
  down:Array.from({length:32},(_,i)=>170+i*690),left:Array.from({length:26},(_,i)=>330+i*870),reset:[]};
const original={...baseLists,right:[...baseLists.right,23700,23720]};
const edited={...baseLists,right:[...baseLists.right,23701,23721,23800,23810]};
function pack(lists){return deflateSync(Buffer.concat(['up','right','down','left','reset'].map(name=>{
  const ticks=lists[name],bytes=Buffer.alloc(3+3*ticks.length);bytes.writeUIntLE(ticks.length,0,3);
  ticks.forEach((tick,i)=>bytes.writeUIntLE(tick-(i?ticks[i-1]:0),3+3*i,3));return bytes;
}))).toString('base64url');}
function row(lists=edited,extra={}){const replay=pack(lists);return {accountId:candidateAccount,trackId:track,timeMs:duration,
  frames:duration,raceTimeFrames:duration,timingVersion:2,uploadId:2,replay,replayHash:digest(replay),integrityVerified:true,...extra};}
function job(value=row()){return {...value,resultId:value.accountId+'_'+track,queueCollection:VERIFICATION_COLLECTION,queueKey:verificationKey(value)};}
// This is a synthetic native-result boundary fixture, not a native physics run or human-clearance claim.
function native(j){return {resultId:j.resultId,status:'verified',reason:'native_exact_finish',trackId:j.trackId,
  timeMs:j.timeMs,replayHash:j.replayHash,engineDigest:VERIFIER_ENGINE_DIGEST,trackContentHash:null,deterministic:true,
  binding:{resultId:j.resultId,trackId:j.trackId,nativeTrackId:j.trackId,timeMs:j.timeMs,replayHash:j.replayHash,
    actualReplayHash:j.replayHash,engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,trackContentHash:null}};}
async function fixture(t,{referenceTime=1000,referenceOwner=referenceAccount,lists=original}={}){
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'polytrack-review-synthetic-'));
  t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());assert(path.basename(root).startsWith('polytrack-review-synthetic-'));await fs.rm(root,{recursive:true,force:true});});
  const dir=path.join(root,'public-snapshots1');await fs.mkdir(dir);const files={};const replay=pack(lists),replayHash=digest(replay);
  const values={[`tracks/${track}.json`]:{updatedAt:5000,entries:[{id:1,accountId:referenceOwner,rank:1,timeMs:duration,
    replayHash,runVerified:true,integrityVerified:true,...(referenceTime===null?{}:{receivedAt:referenceTime})}]},
    'recordings/1.json':{trackId:track,accountId:referenceOwner,replayHash,recording:replay}};
  for(const [logical,value] of Object.entries(values)){const bytes=await encodeSnapshot(value),sha256=digest(bytes);files[logical]={path:sha256+'.bin',sha256};await fs.writeFile(path.join(dir,sha256+'.bin'),bytes);}
  await fs.writeFile(path.join(dir,'index.json'),JSON.stringify({files}));await fs.writeFile(path.join(root,'snapshot-current.json'),JSON.stringify({currentdir:'public-snapshots1'}));
  return {root,review:createSimilarityReviewer(root)};
}
async function reviewed(f,extra={},lists=edited){const j=job(row(lists,extra)),result=native(j);await f.review([j],[result]);return {j,result};}

function database(j){const docs=new Map(),writes=[],reads=[];let serial=0,fail=null,conflict=null;
  const key=(c,id)=>c+'/'+id;
  docs.set(key(VERIFICATION_COLLECTION,track),{data:{trackId:track,slots:{[j.accountId]:pendingSlot(j)}},updateTime:'initial'});
  docs.set(key('0.6.2_race_results',j.resultId),{data:{...j},updateTime:'canonical'});
  return {docs,writes,reads,setFail:f=>fail=f,setConflict:f=>conflict=f,
    get:async(c,id)=>{reads.push(key(c,id));return structuredClone(docs.get(key(c,id))||null);},
    write:(collection,id,data,prior)=>({collection,id,data:structuredClone(data),prior}),
    call:async(p,{writes:batch})=>{assert.equal(p,':commit');if(conflict){const f=conflict;conflict=null;f(docs);throw Object.assign(Error('synthetic contention'),{code:'ABORTED'});}
      const next=structuredClone(docs);for(const w of batch){if(fail?.(w))throw Error('synthetic persistence failure');const old=docs.get(key(w.collection,w.id));
        assert.equal(old?.updateTime,w.prior?.updateTime,'CAS preimage must be fresh');next.set(key(w.collection,w.id),{data:structuredClone(w.data),updateTime:'v'+(++serial)});}
      docs.clear();for(const entry of next)docs.set(...entry);writes.push(batch);return {writeResults:batch.map(w=>({updateTime:docs.get(key(w.collection,w.id)).updateTime}))};}};
}
function saved(db,collection){return [...db.docs.entries()].filter(([k])=>k.startsWith(collection+'/')).map(([,v])=>v.data);}

test('generic long match plus late edits is a competitive hold, not native clearance',async t=>{
  const f=await fixture(t),{j,result}=await reviewed(f,{receivedAt:2000});
  assert.notEqual(j.replayHash,digest(pack(original)));assert.equal(inputRateEvidence({lists:edited},duration),null);
  assert(compareControls({lists:edited},{lists:original},duration,duration));assert(compareInputSegment({lists:edited},{lists:original},duration,duration));
  assert.equal(result.status,'unavailable');assert.equal(result.reason,HOLD);assert.equal(similarityEvidence(result).strongNearClone,true);
  assert.equal(similarityEvidence(result).chronology,'earlier_reference');assert.equal(result.cheating,undefined);
});
test('reliable earlier receipt is not held against a newer reference',async t=>{
  const f=await fixture(t,{referenceTime:3000}),{result}=await reviewed(f,{receivedAt:2000});
  assert.equal(result.status,'verified');assert.equal(similarityEvidence(result).chronology,'later_reference');
});
test('unknown chronology defers a new candidate but preserves an accepted original',async t=>{
  const f=await fixture(t,{referenceTime:null});const fresh=await reviewed(f),accepted=await reviewed(f,{previouslyAccepted:true});
  assert.equal(fresh.result.reason,HOLD);assert.equal(accepted.result.status,'verified');assert.equal(similarityEvidence(accepted.result).chronology,'unknown');
});
test('same account and independent timing ties do not trigger a competitive hold',async t=>{
  const same=await fixture(t,{referenceOwner:candidateAccount});assert.equal(similarityEvidence((await reviewed(same)).result),undefined);
  const f=await fixture(t);const independent=Object.fromEntries(Object.entries(edited).map(([name,ticks],channel)=>[name,ticks.map((tick,i)=>tick+7+((i*17+channel*11)%83))]));
  assert(decodeAnalysisReplay(pack(independent),duration));
  const {result}=await reviewed(f,{receivedAt:2000},independent);assert.equal(result.status,'verified');assert.equal(similarityEvidence(result),undefined);
});
test('short copied segments remain advisory and mismatched native bindings produce no evidence',async t=>{
  const f=await fixture(t),short={up:[0],right:baseLists.right.slice(0,25),down:baseLists.down.slice(0,7),left:[],reset:[]};
  const g=await fixture(t,{lists:short});const changed={...short,right:[...short.right,23000,23010]};
  const {result}=await reviewed(g,{receivedAt:2000},changed);assert.equal(result.status,'verified');
  const j=job(row()),bad={...native(j),replayHash:'d'.repeat(64)};await f.review([j],[bad]);assert.equal(similarityEvidence(bad),undefined);
});
test('unknown same-batch ownership never picks a verified winner by iteration order',async()=>{
  for(const reversed of [false,true]){
    const jobs=[job(row(original,{accountId:referenceAccount})),job(row(edited))];if(reversed)jobs.reverse();
    const results=jobs.map(native);await createSimilarityReviewer('/missing-synthetic-snapshot')(jobs,results);
    assert(results.every(result=>result.status==='unavailable'&&result.reason===HOLD));
  }
});
test('known same-batch receipt order preserves the original in either iteration order',async()=>{
  for(const reversed of [false,true]){
    const jobs=[job(row(original,{accountId:referenceAccount,receivedAt:1000})),job(row(edited,{receivedAt:2000}))];if(reversed)jobs.reverse();
    const results=jobs.map(native);await createSimilarityReviewer('/missing-synthetic-snapshot')(jobs,results);
    assert.equal(results.find(r=>r.resultId.startsWith(referenceAccount)).status,'verified');
    assert.equal(results.find(r=>r.resultId.startsWith(candidateAccount)).reason,HOLD);
  }
});
test('normal hold and needsReview alert are atomic; accepted proof cannot bypass a new hold',async t=>{
  const f=await fixture(t),{j,result}=await reviewed(f,{receivedAt:2000}),db=database(j);
  db.docs.get(VERIFICATION_COLLECTION+'/'+track).data.slots[j.accountId]={...pendingSlot(j),status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION};
  const totals=await publishResults(db,[j],[result]);assert.equal(totals.verified,0);assert.equal(totals.unavailable,1);
  const slot=saved(db,VERIFICATION_COLLECTION)[0].slots[j.accountId];assert.equal(slot.reason,HOLD);assert.equal(slot.retryAt,Number.MAX_SAFE_INTEGER);
  assert.equal(slot.controlProof,undefined);assert.equal(verifiedVerdict(j,slot),false);assert.equal(verifiedTargetMs([j],{[j.accountId]:slot}),null);
  assert.equal(saved(db,'0.6.2_s1_verification_audit')[0].needsReview,true);assert.equal(saved(db,'0.6.2_s1_review_inbox').length,1);
  assert.equal(db.writes[0].length,4,'queue, reconcile, audit and finding commit together');
});
test('normal finding failure rolls back publication completely',async t=>{
  const f=await fixture(t),{j,result}=await reviewed(f,{receivedAt:2000}),db=database(j),before=structuredClone(db.docs);
  db.setFail(w=>w.collection==='0.6.2_s1_review_inbox');await assert.rejects(publishResults(db,[j],[result]),/persistence failure/);
  assert.deepEqual(db.docs,before);assert.equal(db.writes.length,0);
});
test('stale canonical binding cannot receive a hold or an alert',async t=>{
  const f=await fixture(t),{j,result}=await reviewed(f,{receivedAt:2000}),db=database(j);
  db.docs.get('0.6.2_race_results/'+j.resultId).data.timeMs++;
  const totals=await publishResults(db,[j],[result]);assert.equal(totals.superseded,1);assert.equal(db.writes.length,0);
});
test('a claimed normal hold without server-derived evidence is rejected',async()=>{
  const j=job(row()),db=database(j);await assert.rejects(publishResults(db,[j],[{...native(j),status:'unavailable',reason:HOLD}]),/Invalid competitive review hold binding/);
  assert.equal(db.writes.length,0);
});
test('held normal receipt cannot be cleared by a later native-only recheck or inbox resolution',async t=>{
  const f=await fixture(t),{j,result}=await reviewed(f,{receivedAt:2000}),db=database(j);await publishResults(db,[j],[result]);
  const inbox=[...db.docs].find(([k])=>k.startsWith('0.6.2_s1_review_inbox/'));inbox[1].data.status='resolved';inbox[1].data.reviewNote='manual note, not an approval command';
  await publishResults(db,[j],[native(j)]);const slot=saved(db,VERIFICATION_COLLECTION)[0].slots[j.accountId];
  assert.equal(slot.status,'unavailable');assert.equal(slot.reason,HOLD);assert.equal(saved(db,'0.6.2_s1_verification_audit')[0].needsReview,true);
  assert.equal(saved(db,'0.6.2_s1_review_inbox').length,1);assert.equal(inbox[1].data.status,'resolved');assert.equal(verifiedVerdict(j,slot),false);
});
test('advisory audit evidence survives an unflagged retry without reopening dismissed finding',async t=>{
  const f=await fixture(t,{referenceTime:null}),{j,result}=await reviewed(f,{previouslyAccepted:true}),db=database(j);await publishResults(db,[j],[result]);
  const entry=[...db.docs].find(([k])=>k.startsWith('0.6.2_s1_review_inbox/'));entry[1].data.status='dismissed';
  await publishResults(db,[j],[native(j)]);assert.equal(saved(db,'0.6.2_s1_verification_audit')[0].needsReview,true);
  assert.equal(saved(db,'0.6.2_s1_review_inbox')[0].status,'dismissed');assert.equal(saved(db,'0.6.2_s1_review_inbox').length,1);
});
test('normal CAS retry preserves a concurrent reviewer decision and adds no duplicate finding',async t=>{
  const f=await fixture(t),{j,result}=await reviewed(f,{receivedAt:2000}),db=database(j);const id=digest(j.queueKey);
  db.setConflict(docs=>docs.set('0.6.2_s1_review_inbox/'+id,{data:{status:'resolved',reviewNote:'concurrent reviewer'},updateTime:'reviewed'}));
  await publishResults(db,[j],[result]);assert.equal(saved(db,'0.6.2_s1_review_inbox')[0].reviewNote,'concurrent reviewer');
  assert.equal(saved(db,'0.6.2_s1_verification_audit')[0].needsReview,true);assert.equal(db.writes.length,1);
});
test('hold survives engine-key bootstrap but a genuinely different submission gets its own state',()=>{
  const j=job(row()),held={...pendingSlot(j),status:'unavailable',reason:HOLD,retryAt:Number.MAX_SAFE_INTEGER};
  const old=JSON.parse(held.key);old[1]='f'.repeat(64);held.key=JSON.stringify(old);
  assert.equal(bootstrapSlots(track,[j],{[j.accountId]:held})[j.accountId].reason,HOLD);
  const newer={...j,uploadId:3,replayHash:'e'.repeat(64)};assert.equal(bootstrapSlots(track,[newer],{[j.accountId]:held})[j.accountId].status,'waiting');
  assert.equal(completedSlot(pendingSlot(j),{...native(j),status:'unavailable',reason:HOLD}).retryAt,Number.MAX_SAFE_INTEGER);
});

function memoryStore(){const data=new Map();let failPath=null;return {data,counts:[],fail:p=>failPath=p,async transaction(fn){const copy=structuredClone(data),reads=new Set();let writing=false,writes=0;
  const write=(k,v,mode)=>{if(k===failPath)throw Error('synthetic event finding failure');writing=true;assert(++writes<=16);if(mode!=='create')assert(reads.has(k));if(mode==='create')assert(!copy.has(k));if(mode==='delete')copy.delete(k);else copy.set(k,structuredClone(mode==='patch'?{...copy.get(k),...v}:v));};
  const result=await fn({get:async k=>{assert(!writing,'all reads before writes');reads.add(k);assert(reads.size<=16);return structuredClone(copy.get(k)||null);},
    create:(k,v)=>write(k,v,'create'),set:(k,v)=>write(k,v,'set'),patch:(k,v)=>write(k,v,'patch'),delete:k=>write(k,null,'delete')});
  this.counts.push({reads:reads.size,writes});data.clear();for(const x of copy)data.set(...x);return result;}};}
async function eventFixture(t){const f=await fixture(t),store=memoryStore();let time=0,nonce=0;
  store.data.set(C.profiles+'/'+candidateAccount,{accountId:candidateAccount,ownerUid:'synthetic-owner',name:'Synthetic Racer'});
  const service=createEventService({store,now:()=>time,hash:digest,randomId:()=>`synthetic_lease_${nonce++}`});
  await service.bindOwner('synthetic-owner',candidateAccount);
  await service.createPeriod({id:'synthetic_period',enabled:true,trackId:track,startsAt:1000,endsAt:86401000,graceMs:3600000,targetMs:duration,maxRp:1000,
    eligibility:'best-submitted-during-period',capacity:{policyVersion:'synthetic-reviewed-v1',entrants:200,admissionsPerPeriod:512,replayBytesPerPeriod:8388608,minIntervalMs:1000,verificationsPerDay:128}});
  time=2000;
  const submitted=await service.submit('synthetic_period','synthetic-owner',{accountId:candidateAccount,trackId:track,attemptId:'synthetic_attempt',timeMs:duration,frames:duration,replay:pack(edited),carStyle:''});
  const jobs=await service.leaseJobs('synthetic_period',1),leased=jobs[0];assert(leased);
  const j={...leased,accountId:candidateAccount,receivedAt:2000},result=native(j);await f.review([j],[result]);
  const evidence=similarityEvidence(result);if(evidence){result.needsReview=true;result.reviewEvidence=evidence;}
  return {...f,store,service,submitted,leased,result};
}
test('event hold commits one durable private alert and awards no event or normal RP',async t=>{
  const f=await eventFixture(t);const outcome=await f.service.completeJob('synthetic_period',f.leased,f.result);
  assert.equal(outcome.status,'unavailable_final');assert.equal(outcome.eventImproved,false);assert.equal(outcome.canonicalImproved,false);assert.equal(outcome.reviewFindingAdded,true);
  const run=f.store.data.get(C.runs+'/'+f.submitted.runId);assert.equal(run.needsReview,true);assert.equal(run.proof.reason,HOLD);assert.equal(run.proof.status,'unavailable');
  assert.equal(f.store.data.get(C.canonical+'/'+candidateAccount+'_'+track),undefined);assert.equal(f.store.data.get(C.pbs+'/synthetic_period_'+candidateAccount),undefined);
  assert.equal(f.store.data.get(C.totals+'/'+candidateAccount),undefined);assert.equal(f.store.data.get(C.queues+'/synthetic_period').slots.length,0);
  const playback=f.store.data.get(C.replays+'/synthetic_period_run_'+f.submitted.runId);assert.equal(playback.verified,false);assert.equal(playback.eventRpEligible,false);
  const finding=[...f.store.data].find(([k])=>k.startsWith('0.6.2_s1_review_inbox/'));assert.equal(finding[1].status,'open');
  finding[1].status='dismissed';await f.service.completeJob('synthetic_period',f.leased,native(f.leased));
  assert.equal(f.store.data.get(C.runs+'/'+f.submitted.runId).proof.reason,HOLD);assert.equal(finding[1].status,'dismissed');
  assert.equal([...f.store.data.keys()].filter(k=>k.startsWith('0.6.2_s1_review_inbox/')).length,1);
});
test('event finding failure rolls back hold publication and retry remains safe',async t=>{
  const f=await eventFixture(t),id=digest(JSON.stringify(['event-review-v1','synthetic_period',f.submitted.runId,track,duration,digest(pack(edited))]));
  f.store.fail('0.6.2_s1_review_inbox/'+id);const before=structuredClone(f.store.data);
  await assert.rejects(f.service.completeJob('synthetic_period',f.leased,f.result),/finding failure/);assert.deepEqual(f.store.data,before);
  f.store.fail(null);assert.equal((await f.service.completeJob('synthetic_period',f.leased,f.result)).status,'unavailable_final');
});
test('event backend rejects an unbound claimed review hold',async t=>{
  const f=await eventFixture(t);const forged={...f.result,status:'unavailable',reason:HOLD,binding:null};
  await assert.rejects(f.service.completeJob('synthetic_period',f.leased,forged),/verifier_proof_mismatch|invalid_review_hold/);
});
test('event coordinator transports the hold and counts the atomic durable alert',async t=>{
  const f=await eventFixture(t),queue=f.store.data.get(C.queues+'/synthetic_period');
  queue.slots[0].lease=null;queue.slots[0].leaseUntil=0;
  const summary=await runEventCoordinator({service:f.service},f.root,{limit:1,consumeInbox:async()=>({consumed:0}),
    readWork:async()=>({periodIds:['synthetic_period'],archiveId:null}),verifyBatch:async(_root,jobs)=>jobs.map(native),
    reviewSimilarity:async(jobs,results)=>f.review(jobs.map(j=>({...j,accountId:candidateAccount,receivedAt:2000})),results),
    writeFinding:async()=>assert.fail('held finding is already atomic')});
  assert.equal(summary.checked,1);assert.equal(summary.results[0].status,'unavailable_final');assert.equal(summary.eventFindingsAdded,1);
  assert.equal(summary.eventFindingWriteFailed,0);assert.equal(f.store.data.get(C.totals+'/'+candidateAccount),undefined);
});
test('previously awarded event correction is explicit, never a silent duplicate success',async t=>{
  const f=await eventFixture(t);await f.service.completeJob('synthetic_period',f.leased,native(f.leased));
  const before=structuredClone(f.store.data);
  await assert.rejects(f.service.completeJob('synthetic_period',f.leased,f.result),/reviewed_event_correction_required/);
  assert.deepEqual(f.store.data,before,'historical award reversal requires a separate reviewed correction');
});
