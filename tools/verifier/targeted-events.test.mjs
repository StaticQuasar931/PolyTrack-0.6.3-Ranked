import test from 'node:test';
import assert from 'node:assert/strict';
import {targetedEventPlan,guardedEventFetch,runTargetedEvents,eventBatchReadReserve,selectCompatibilityProbe} from './targeted-events.mjs';
test('default mode plans exact event-only work without accessing credentials or Firebase',async()=>{
  const result=await runTargetedEvents({periodIds:['kodub_1792958400000','w_20261019','d_20261024'],
    credentialFile:'never-read',fetchImpl:()=>assert.fail('network')});
  assert.equal(result.mode,'plan');assert.equal(result.maxJobs,12);assert.equal(result.maxHttpRequests,409);
  assert.equal(result.maxDocumentReadAttempts,252);assert.equal(result.normalQueue,false);
  await assert.rejects(runTargetedEvents({execute:true,periodIds:['daily']}),/approval/);
});
test('plans reject broad, duplicate, malformed and unbounded selections',()=>{
  for(const ids of [[],['a','a'],['../x'],['a','b','c','d'],[undefined],[123]])assert.throws(()=>targetedEventPlan(ids));
  for(const max of [0,13,Infinity,1.5])assert.throws(()=>targetedEventPlan(['a'],max));
  assert.equal(targetedEventPlan(['a'],4).maxHttpRequests,209);
});
test('transport counts OAuth and every document attempt, including retries; rejects scans and unknown hosts',async()=>{
  let calls=0;
  const base='https://firestore.googleapis.com/v1/projects/polytrack-052/databases/(default)/documents';
  const guard=guardedEventFetch(async()=>{calls++;return Response.json({});},{maxHttpRequests:3,maxDocumentReadAttempts:1});
  for(const url of [base+':runQuery',base+':batchGet','https://example.com/',base+'/collection'])
    await assert.rejects(guard.fetch(url,{method:'POST'}),/rejects/);
  await guard.fetch('https://oauth2.googleapis.com/token',{method:'POST'});
  await guard.fetch(base+'/0.6.2_event_queues/daily?transaction=x');
  await assert.rejects(guard.fetch(base+'/0.6.2_event_queues/daily?transaction=x'),/budget/);
  await guard.fetch(base+':rollback',{method:'POST'});
  await assert.rejects(guard.fetch(base+':commit',{method:'POST'}),/budget/);
  assert.equal(calls,3);assert.deepEqual(guard.stats(),{httpRequests:3,documentReadAttempts:1,halted:false});
});
test('quota errors latch immediately and prevent read retry, rollback and later publication',async()=>{
  let calls=0;
  const guard=guardedEventFetch(async()=>{calls++;return Response.json({error:{status:'RESOURCE_EXHAUSTED'}},{status:429});},
    targetedEventPlan(['daily'],4));
  await assert.rejects(guard.fetch('https://oauth2.googleapis.com/token',{method:'POST'}),e=>e.code==='EVENT_QUOTA_STOP');
  await assert.rejects(guard.fetch('https://oauth2.googleapis.com/token',{method:'POST'}),/halted/);
  assert.equal(calls,1);assert.equal(guard.stats().halted,true);
});
test('compatibility probe permits exactly one selected run and reserves its two document reads',async()=>{
  let calls=0;
  const guard=guardedEventFetch(async()=>{calls++;return Response.json({});},targetedEventPlan(['daily'],4));
  const url=guard.allowCompatibilityRead('daily','a'.repeat(64));
  await assert.rejects(guard.fetch(url.replace('a'.repeat(64),'b'.repeat(64))),/rejects/);
  assert.throws(()=>guard.allowCompatibilityRead('daily','b'.repeat(64)));
  await guard.fetch(url);assert.equal(calls,1);assert.equal(guard.stats().documentReadAttempts,2);
});
test('last single job reserves only its bounded work without raising the 252-read ceiling',()=>{
  assert.deepEqual([1,2,3,4].map(eventBatchReadReserve),[35,53,71,89]);
  assert.throws(()=>eventBatchReadReserve(0));assert.throws(()=>eventBatchReadReserve(5));
  const guard=guardedEventFetch(()=>assert.fail('no network'),{maxHttpRequests:183,maxDocumentReadAttempts:60});
  assert.equal(guard.canSpend(136,4),false);assert.equal(guard.canSpend(136,1),true);
  const small=guardedEventFetch(()=>assert.fail('no network'),{maxHttpRequests:183,maxDocumentReadAttempts:34});
  assert.equal(small.canSpend(136,1),false);
  assert.equal(targetedEventPlan(['daily'],12).maxDocumentReadAttempts,252);
  assert.equal(targetedEventPlan(['daily'],4).maxDocumentReadAttempts,89);
});


test('deployed compatibility probe prefers current metadata but accepts only explicitly compatible immutable periods',async()=>{
 const {VERIFIER_ENGINE_DIGEST,VERIFIER_VERSION}=await import('../../workers/ranked/src/verification.js');
 const {EVENT_OPPONENT_SHORTCUT_UI_ENGINE}=await import('../../workers/ranked/src/event-engine-compatibility.js');
 const periods=new Map([['legacy',{engineDigest:EVENT_OPPONENT_SHORTCUT_UI_ENGINE,verifierVersion:VERIFIER_VERSION}],['current',{engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION}],['unknown',{engineDigest:'f'.repeat(64),verifierVersion:VERIFIER_VERSION}]]);
 const pending=[{periodId:'legacy'},{periodId:'current'},{periodId:'unknown'}];
 assert.equal(selectCompatibilityProbe(['legacy','current'],periods,pending),'current');
 assert.equal(selectCompatibilityProbe(['legacy'],periods,pending),'legacy');
 assert.equal(selectCompatibilityProbe(['legacy'],periods,[]),null);
 assert.equal(selectCompatibilityProbe(['unknown'],periods,pending),null);
 periods.get('legacy').verifierVersion='unapproved';assert.equal(selectCompatibilityProbe(['legacy'],periods,pending),null);
});
