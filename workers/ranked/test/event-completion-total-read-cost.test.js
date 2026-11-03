import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {eventRuntime,consumeEventInbox} from '../src/events-runtime.js';
import {EVENT_COLLECTIONS as C,eventRp} from '../src/events.js';
import {eventEncode,eventDecode} from '../src/events-store.js';
import {createFirestoreAudit,recordFirestoreReads} from '../src/firestore-read-cost.js';
import {publishEventCapacity} from '../src/event-publication.js';
import {VERIFIER_ENGINE_DIGEST as engine,VERIFIER_VERSION as version} from '../src/verification.js';
import {COMPETITIVE_REVIEW_REASON} from '../src/competitive-review.js';
import {REVIEW_COLLECTION} from '../src/review-inbox.js';

const accountId='b'.repeat(64),trackId='a'.repeat(64),periodId='cost_day';
const base='projects/test-project/databases/(default)/documents/';
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture() {
  const data=new Map(),snapshots=new Map(),writing=new Set();let nonce=0,now=2000;
  let audit=createFirestoreAudit();const reads=[];
  const wire=(key,source=data)=>({name:base+key,updateTime:'v1',fields:eventEncode(source.get(key)).mapValue.fields});
  const request=async(route,init={})=>{
    const body=init.body?JSON.parse(init.body):null;let result;
    if(route===':beginTransaction') {
      const transaction='tx-'+ ++nonce;snapshots.set(transaction,structuredClone(data));result={transaction};
    } else if(route===':rollback') {snapshots.delete(body.transaction);result={};}
    else if(route===':commit') {
      if(body.transaction)assert.ok(snapshots.has(body.transaction));
      for(const w of body.writes) {
        const key=(w.update?.name||w.delete).slice(base.length);
        assert.ok(w.currentDocument,'retain write preconditions');
        if(w.currentDocument.exists===false)assert.equal(data.has(key),false);
        if(w.currentDocument.updateTime)assert.equal(w.currentDocument.updateTime,'v1');
      }
      writing.add(body.transaction);
      for(const w of body.writes) {
        const key=(w.update?.name||w.delete).slice(base.length);
        if(w.delete)data.delete(key);
        else {
          const value=eventDecode({mapValue:{fields:w.update.fields}});
          data.set(key,w.updateMask?{...data.get(key),...value}:value);
        }
      }
      snapshots.delete(body.transaction);result={};
    } else if(route===':runQuery') {
      const q=body.structuredQuery;assert.equal(q.from[0].collectionId,C.inbox);
      result=[...data].filter(([key])=>key.startsWith(C.inbox+'/')).slice(0,1).map(([key])=>({document:wire(key)}));
    } else {
      const [path,query]=route.split('?'),key=decodeURIComponent(path.slice(1));
      const tx=new URLSearchParams(query).get('transaction');
      if(tx)assert.equal(writing.has(tx),false,'all reads precede transaction writes');
      const source=tx?snapshots.get(tx):data;assert.ok(source);
      reads.push(key);result=source.has(key)?wire(key,source):null;
    }
    recordFirestoreReads(audit,route,init,result);return result;
  };
  const runtime=eventRuntime(request,{projectId:'test-project',now:()=>now});
  return {data,reads,runtime,time:value=>{now=value;},reset:()=>{audit=createFirestoreAudit();reads.length=0;},
    cost:()=>({reads:audit.documentReadEstimate,writes:audit.writeEstimate,deletes:audit.deleteEstimate})};
}
const verdict=(job,status)=>({resultId:job.resultId,trackId:job.trackId,timeMs:job.timeMs,replayHash:job.replayHash,
  status,engineDigest:engine,binding:{resultId:job.resultId,trackId:job.trackId,nativeTrackId:job.trackId,
    timeMs:job.timeMs,replayHash:job.replayHash,actualReplayHash:job.replayHash,engineDigest:engine,verifierVersion:version}});

for(const scenario of ['mismatch','unavailable','review-hold','verified-slower','verified-closed','verified-archived','verified-improvement'])
test('whole receipt intake, verification and publication total-read cost: '+scenario,async()=>{
  const f=fixture();f.time(0);
  await f.runtime.service.createPeriod({id:periodId,trackId,enabled:true,kind:'daily',startsAt:1000,endsAt:10000,
    graceMs:1000,targetMs:10000,maxRp:100,eligibility:'best-submitted-during-period',capacity:{policyVersion:'cost-test',
      entrants:200,admissionsPerPeriod:512,replayBytesPerPeriod:8388608,minIntervalMs:1000,verificationsPerDay:128}});
  f.time(2000);
  f.data.set(C.profiles+'/'+accountId,{accountId,ownerUid:'owner',name:'Racer'});
  const total={accountId,name:'Racer',rp:100,events:1};
  f.data.set(C.totals+'/'+accountId,total);
  f.data.set(C.public+'/totals',{entries:[total],revision:1,publicationPending:false});
  if(scenario==='verified-improvement')f.data.set(C.pbs+'/'+periodId+'_'+accountId,
    {periodId,accountId,ownerUid:'owner',timeMs:30000,rp:eventRp(f.data.get(C.periods+'/'+periodId),20000)});
  f.data.set(C.inbox+'/'+periodId+'_'+accountId,{periodId,trackId,accountId,ownerUid:'owner',attemptId:'attempt',
    timeMs:20000,frames:20000,replay:'abcd',carStyle:'style',receivedAt:{__firestoreTimestamp:new Date(2000).toISOString()}});
  f.reset();
  assert.equal((await consumeEventInbox(f.runtime)).status,'waiting');
  // A competing, already accepted faster PB can arrive after admission.
  if(scenario==='verified-slower')f.data.set(C.pbs+'/'+periodId+'_'+accountId,
    {periodId,accountId,ownerUid:'owner',timeMs:15000,rp:50});
  if(scenario==='verified-closed')f.time(11000);
  if(scenario==='verified-archived')f.data.set(C.archives+'/'+periodId,{archivedAt:2000,cleaned:false});
  const status=scenario.startsWith('verified')?'verified':scenario==='review-hold'?'unavailable':scenario;
  const completionStart=f.reads.length;
  const result=await f.runtime.service.processBatch(periodId,async jobs=>jobs.map(job=>({
    ...verdict(job,status),...(scenario==='review-hold'?{reason:COMPETITIVE_REVIEW_REASON,needsReview:true,
      reviewEvidence:{kind:'similar_top_inputs',strongNearClone:true,policyVersion:'strong-near-clone-v1',
        inputSimilarity:1,transitionSimilarity:1,segmentInputSimilarity:1,comparedDurationMs:20000,
        segmentDurationMs:20000,matchedChanges:80,distinctSteeringChannels:2,offsetTicks:0,
        chronology:'earlier_reference',referenceAccountId:'c'.repeat(64)}}:{})})));
  assert.equal(result.length,1);
  assert.equal(result[0].eventImproved,scenario==='verified-improvement');
  const completionReads=f.reads.slice(completionStart);
  assert.ok(completionReads.includes(C.owners+'/'+accountId),'fresh completion ownership check');
  assert.ok(completionReads.includes(C.canonical+'/'+accountId+'_'+trackId),'fresh canonical check');
  assert.equal(completionReads.filter(key=>key===C.public+'/totals').length,scenario==='verified-improvement'?1:0);
  if(scenario==='review-hold') {
    assert.equal(result[0].status,'unavailable_final');
    assert.equal(f.data.get(C.queues+'/'+periodId).slots.length,0);
    const finding=[...f.data].find(([key])=>key.startsWith(REVIEW_COLLECTION+'/'))?.[1];
    assert.equal(finding.status,'open');assert.equal(finding.reason,COMPETITIVE_REVIEW_REASON);
  }
  assert.deepEqual(await publishEventCapacity(f.runtime),{idle:true});
  if(scenario!=='verified-improvement') {
    assert.deepEqual(f.data.get(C.totals+'/'+accountId),total);
    assert.equal(f.data.get(C.public+'/totals').revision,1);
  }
  const completionTotals=f.reads.filter(key=>key===C.totals+'/'+accountId).length;
  console.log('EVENT_COMPLETION_COST '+JSON.stringify({scenario,...f.cost(),completionTotals,
    stateHash:hash(JSON.stringify([...f.data].sort(([a],[b])=>a.localeCompare(b)),(key,value)=>key==='addedAt'?0:value))}));
  assert.equal(completionTotals,scenario==='verified-improvement'?1:0);
  const expected={mismatch:[35,16],unavailable:[35,16],'review-hold':[36,17],'verified-slower':[36,18],
    'verified-closed':[36,17],'verified-archived':[36,17],'verified-improvement':[38,20]}[scenario];
  assert.deepEqual(f.cost(),{reads:expected[0],writes:expected[1],deletes:0});
});
