import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {budgetDatabase,drainVerification,DRAIN_LIMITS,VerificationBudgetError} from './throughput.mjs';
import {runVerifier} from './run.mjs';
import {encode} from './firestore.mjs';

const round=(overrides={})=>({processed:16,verified:16,canonicalAttempts:16,selectionConflicts:0,
  events:{checked:0,consumed:0},...overrides});
const quiet=()=>{};

test('fast backlog drains at most four rounds and sixty-four normal attempts',async()=>{
  let calls=0;
  const result=await drainVerification({now:()=>0,requests:()=>calls*70,log:quiet,
    runRound:async()=>{calls++;return round();}});
  assert.equal(calls,4);assert.equal(result.processed,64);assert.equal(result.verified,64);
  assert.equal(result.stop,'round_limit');assert.equal(result.countsComplete,true);
});

test('drain summary aggregates waiting reasons and distinguishes cap from workflow run number',async()=>{
  let calls=0;
  const result=await drainVerification({now:()=>0,requests:()=>calls*20,log:quiet,
    runRound:async()=>{calls++;return round({reasons:{missing_trusted_track:2,scan_work_limit:1},
      unavailable:3,verified:13});}});
  assert.equal(result.rounds,4);
  assert.equal(result.stop,'round_limit');
  assert.deepEqual(result.reasons,{missing_trusted_track:8,scan_work_limit:4});
  assert.equal(result.unavailable,12);
});

test('slow rounds stop before predicted time plus finish reserve exceeds admission window',async()=>{
  let clock=0,calls=0;
  const result=await drainVerification({now:()=>clock,requests:()=>10,log:quiet,
    runRound:async()=>{calls++;clock+=250000;return round();}});
  assert.equal(calls,1);assert.equal(result.stop,'time_reserve');
});

test('request reserve avoids starting another round near quota',async()=>{
  let used=0;
  const result=await drainVerification({now:()=>0,requests:()=>used,log:quiet,
    runRound:async()=>{used=300;return round();}});
  assert.equal(result.rounds,1);assert.equal(result.stop,'request_reserve');
});

test('request guard covers reads, queries and commits without automatic retries or extra calls',async()=>{
  const calls=[];
  const db=budgetDatabase({call:async(...args)=>{
    calls.push(args);return args[0].startsWith('/')?{fields:encode({timeMs:123}).mapValue.fields,updateTime:'v1'}:[];
  },write:(...args)=>args},3);
  assert.equal((await db.get('canonical','user/track')).data.timeMs,123);
  assert.equal(calls[0][0],'/canonical/user%2Ftrack');
  await db.call(':runQuery',{});await db.call(':commit',{writes:[]});
  assert.deepEqual(db.write('collection','id'),['collection','id']);
  await assert.rejects(db.get('canonical','id'),VerificationBudgetError);
  await assert.rejects(db.call(':commit',{}),VerificationBudgetError);
  assert.equal(calls.length,3);assert.equal(db.requests(),3);
  for(const limit of [0,401,1.2])assert.throws(()=>budgetDatabase({},limit),/budget/);
});

test('failed HTTP requests consume budget and their original errors propagate',async()=>{
  const failure=Object.assign(Error('backend failure'),{status:503});
  const db=budgetDatabase({call:async()=>{throw failure;}},1);
  await assert.rejects(db.call(':commit',{}),e=>e===failure);
  assert.equal(db.requests(),1);await assert.rejects(db.call(':commit',{}),VerificationBudgetError);
});

test('interrupted publication reports incomplete counts, never fabricated approvals',async()=>{
  let calls=0;
  const result=await drainVerification({now:()=>0,requests:()=>100,log:quiet,runRound:async()=>{
    if(calls++===0)return round({processed:4,verified:2});
    throw new VerificationBudgetError();
  }});
  assert.equal(result.rounds,1);assert.equal(result.verified,2);assert.equal(result.processed,4);
  assert.equal(result.interruptedRound,true);assert.equal(result.countsComplete,false);
  assert.equal(result.stop,'request_budget');
});

test('empty, conflict-only and superseded-only work cannot repeatedly drain the same jobs',async()=>{
  for(const report of [round({processed:0,verified:0,canonicalAttempts:0}),
    round({deferred:16,verified:0}),round({superseded:16,verified:0}),
    round({processed:0,verified:0,selectionConflicts:2})]){
    let calls=0;
    const result=await drainVerification({now:()=>0,requests:()=>0,log:quiet,runRound:async()=>{calls++;return report;}});
    assert.equal(calls,1);assert.equal(result.stop,'no_progress');
  }
});

test('budget-deferred event work gets an explicit safe stop', async () => {
  const result = await drainVerification({now:()=>0, requests:()=>0, log:quiet,
    runRound:async()=>round({processed:0, verified:0, canonicalAttempts:0,
      events:{checked:0, consumed:0, budgetDeferred:true}})});
  assert.equal(result.rounds, 1);
  assert.equal(result.stop, 'budget_deferred');
});

test('bounded pruning and event intake count as progress without claiming verification',async()=>{
  for(const report of [round({processed:0,verified:0,canonicalAttempts:16}),
    round({processed:0,verified:0,canonicalAttempts:0,events:{checked:0,consumed:1}})]){
    const result=await drainVerification({now:()=>0,requests:()=>0,log:quiet,runRound:async()=>report});
    assert.equal(result.rounds,4);assert.equal(result.verified,0);
  }
});

test('infrastructure failures stop further rounds and non-budget failures fail closed',async()=>{
  let calls=0;
  const result=await drainVerification({now:()=>0,requests:()=>0,log:quiet,
    runRound:async()=>{calls++;return round({verified:0,infrastructureFailure:true});}});
  assert.equal(calls,1);assert.equal(result.stop,'infrastructure_failure');
  await assert.rejects(drainVerification({now:()=>0,requests:()=>0,log:quiet,
    runRound:async()=>{throw Error('unrelated failure');}}),/unrelated failure/);
});

function integration(eventChecks,normalCount=16) {
  const order=[];let selected=0,connections=0,pins=0;
  return {order,get connections(){return connections;},get pins(){return pins;},options:{
    env:{FIREBASE_VERIFIER_SERVICE_ACCOUNT:'synthetic-secret-never-logged'},drain:true,clock:()=>0,log:quiet,
    validateEngine:async()=>{pins++;},connectDatabase:async()=>{connections++;return {
      call:async(path,body)=>{assert.equal(path,':runQuery');
        if(body.structuredQuery.limit===8)order.push('query');else assert.equal(body.structuredQuery.limit,2);
        return [];}};},
    selectNormal:async()=>({jobs:Array.from({length:normalCount},(_,i)=>({resultId:`round-${selected++}-job-${i}`})),
      canonicalAttempts:normalCount,selectionConflicts:0}),
    eventRun:async(_,__,options)=>{order.push('events');assert.ok(options.limit>=4);assert.equal(options.intakeLimit,16);
      return {checked:eventChecks,consumed:0,rejected:false,archived:null,results:[]};},
    verifyNormal:async(_,jobs)=>{order.push('normal:'+jobs.length);return jobs.map(j=>({...j,status:'verified'}));},
    publishNormal:async(_,jobs,results)=>{order.push('publish');assert.equal(jobs.length,results.length);
      return {verified:results.length,unavailable:0,deferred:0,superseded:0,reasons:{native_exact_finish:results.length}};}
  }};
}

test('drain reuses one authenticated pinned connection, rereads queue, and borrows idle event slots',async()=>{
  const f=integration(0);const result=await runVerifier(f.options);
  assert.equal(f.pins,1);assert.equal(f.connections,1);assert.equal(result.processed,64);
  assert.deepEqual(f.order,Array.from({length:4},()=>['events','query','normal:16','publish']).flat());
  assert.equal('FIREBASE_VERIFIER_SERVICE_ACCOUNT'in f.options.env,false);
});

test('sustained events get first chance and four reserved simulations on every round',async()=>{
  const f=integration(4);const result=await runVerifier(f.options);
  assert.equal(result.processed,48);assert.equal(result.eventChecked,16);
  assert.deepEqual(f.order,Array.from({length:4},()=>['events','query','normal:12','publish']).flat());
  assert.equal(result.processed+result.eventChecked,64);
});

test('partial event capacity and event-only workloads share unchanged sixteen-job round bound',async()=>{
  for(const [events,normal,expected]of [[2,16,56],[4,8,32],[4,0,0]]){
    const f=integration(events,normal);const result=await runVerifier(f.options);
    assert.equal(result.processed,expected);assert.equal(result.eventChecked,events*4);
    assert.ok(result.processed+result.eventChecked<=64);
  }
});

test('invalid event counts and incomplete native result sets cannot trigger normal publication',async()=>{
  for(const invalid of [-1,5,0.5,undefined]) {
    const f=integration(invalid);await assert.rejects(runVerifier(f.options),/event native count/);
    assert.ok(!f.order.includes('publish'));
  }
  const f=integration(0);f.options.verifyNormal=async()=>[];
  await assert.rejects(runVerifier(f.options),/Incomplete verifier result set/);
  assert.ok(!f.order.includes('publish'));
});

test('workflow bounds drain wall time while preserving gates, permissions and native limits',()=>{
  const workflow=fs.readFileSync(new URL('../../.github/workflows/verify-runs.yml',import.meta.url),'utf8');
  const step=workflow.split('- name: Verify queued runs')[1];
  assert.match(step,/timeout-minutes: 10/);assert.match(step,/run.mjs --drain/);
  assert.match(step,/if: steps.queue.outputs.has_work == 'true'/);
  assert.match(workflow,/timeout-minutes: 15/);assert.match(workflow,/contents: read/);
  assert.match(workflow,/cache: npm/);assert.match(workflow,/cache-dependency-path: tools\/verifier\/package-lock\.json/);
  assert.equal(DRAIN_LIMITS.rounds*16,64);assert.equal(DRAIN_LIMITS.requests,400);
  assert.doesNotMatch(workflow,/--no-sandbox/);
});

import {pendingSlot,VERIFIER_ENGINE_DIGEST,VERIFICATION_COLLECTION} from '../../workers/ranked/src/verification.js';

test('real selection and atomic publisher drain fresh tracks within actual request budget',async t=>{
  const docs=new Map();let revision=0,nativeCalls=0;
  const set=(collection,id,data)=>docs.set(collection+'/'+id,{name:'documents/'+collection+'/'+id,
    fields:encode(data).mapValue.fields,data:structuredClone(data),updateTime:'v'+(++revision)});
  for(let track=0;track<8;track++) {
    const trackId=String(track).padStart(64,'0'),slots={};
    for(let player=0;player<8;player++) {
      const row={accountId:'racer'+player,trackId,timeMs:20000,frames:20000,uploadId:1,replayHash:'a'.repeat(64)};
      slots[row.accountId]=pendingSlot(row);
      set('0.6.2_race_results',row.accountId+'_'+trackId,row);
    }
    set(VERIFICATION_COLLECTION,trackId,{trackId,slots,pending:true,notBefore:0});
  }
  const canonicalBefore=JSON.stringify([...docs].filter(([key])=>key.startsWith('0.6.2_race_results/')));
  const db={call:async(path,body)=>{
    if(path===':runQuery') {
      const q=body.structuredQuery;
      if(q.from[0].collectionId!==VERIFICATION_COLLECTION)return [];
      assert.equal(q.limit,8);
      const due=Number(q.where.fieldFilter.value.integerValue);
      return [...docs].filter(([key,doc])=>key.startsWith(VERIFICATION_COLLECTION+'/')&&doc.data.notBefore<=due)
        .sort((a,b)=>a[1].data.notBefore-b[1].data.notBefore||a[0].localeCompare(b[0]))
        .slice(0,q.limit).map(([,document])=>({document}));
    }
    if(path===':commit') {
      for(const w of body.writes)assert.equal(docs.get(w.collection+'/'+w.id)?.updateTime,w.prior?.updateTime);
      for(const w of body.writes)set(w.collection,w.id,w.data);
      return {};
    }
    return docs.get(decodeURIComponent(path.slice(1)))||null;
  },write:(collection,id,data,prior)=>({collection,id,data,prior})};
  const result=await runVerifier({drain:true,clock:()=>0,env:{FIREBASE_VERIFIER_SERVICE_ACCOUNT:'synthetic'},
    validateEngine:async()=>{},connectDatabase:async()=>db,log:quiet,
    verifyNormal:async(_,jobs)=>{nativeCalls++;return jobs.map(job=>({...job,status:'verified',
      reason:'native_exact_finish',engineDigest:VERIFIER_ENGINE_DIGEST}));}});
  assert.equal(result.processed,43);assert.equal(result.verified,43);assert.equal(nativeCalls,3);
  assert.equal(result.stop,'request_reserve');assert.ok(result.requests<=DRAIN_LIMITS.requests);
  const slots=[...docs].filter(([key])=>key.startsWith(VERIFICATION_COLLECTION+'/')).flatMap(([,doc])=>Object.values(doc.data.slots));
  assert.equal(slots.filter(s=>s.status==='verified').length,43);
  assert.equal(slots.filter(s=>s.status==='waiting').length,21);
  assert.equal(JSON.stringify([...docs].filter(([key])=>key.startsWith('0.6.2_race_results/'))),canonicalBefore);
  t.diagnostic(JSON.stringify({processed:result.processed,requests:result.requests,stop:result.stop,remainingWaiting:21}));
});

test('normal simulation starts only for jobs whose worst-case publication fits remaining quota',async()=>{
  const f=integration(0);
  f.options.eventRun=async db=>{
    for(let i=0;i<365;i++)await db.call(':runQuery',{structuredQuery:{limit:2}});
    return {checked:0,consumed:0,rejected:false,archived:null,results:[]};
  };
  const result=await runVerifier(f.options);
  assert.equal(result.processed,2);assert.equal(result.verified,2);
  assert.equal(result.stop,'request_reserve');assert.equal(result.rounds,1);
  assert.ok(f.order.includes('normal:2'));assert.ok(!f.order.includes('normal:16'));
});
