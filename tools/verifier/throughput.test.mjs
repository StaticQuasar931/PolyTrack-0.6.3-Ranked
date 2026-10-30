import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {budgetDatabase,drainVerification,DRAIN_LIMITS,CATCH_UP_LIMITS,VerificationBudgetError,VerificationEventConflictError,firestoreDeferralReason} from './throughput.mjs';
import {runVerifier} from './run.mjs';
import {encode,createFirestoreCaller,FirestoreDocumentBudgetError} from './firestore.mjs';

const round=(overrides={})=>({processed:16,verified:16,canonicalAttempts:16,selectionConflicts:0,
  events:{checked:0,consumed:0},...overrides});
const quiet=()=>{};

test('drain retains event reasons and publication statuses separately from normal totals',async()=>{
  let calls=0;
  const result=await drainVerification({now:()=>0,requests:()=>0,log:quiet,runRound:async()=>{
    calls++;return round({processed:0,verified:0,events:{checked:2,consumed:0,reported:2,countsComplete:true,
      statuses:{waiting:1,verified:1},reasons:{trusted_track_part_limit:1,native_exact_finish:1}}});
  }});
  assert.equal(calls,4);assert.equal(result.eventChecked,8);assert.equal(result.eventReported,8);
  assert.deepEqual(result.eventStatuses,{waiting:4,verified:4});
  assert.deepEqual(result.eventReasons,{trusted_track_part_limit:4,native_exact_finish:4});
  assert.equal(result.eventCountsComplete,true);assert.equal(result.verified,0);assert.deepEqual(result.reasons,{});
});

test('interrupted event rounds cannot claim complete event outcomes',async()=>{
  let calls=0;
  const result=await drainVerification({now:()=>0,requests:()=>0,log:quiet,runRound:async()=>{
    if(calls++)throw new VerificationBudgetError();
    return round({events:{checked:1,consumed:0,reported:1,countsComplete:true,statuses:{waiting:1},reasons:{scan_work_limit:1}}});
  }});
  assert.equal(result.eventChecked,1);assert.equal(result.eventReported,1);
  assert.equal(result.eventCountsComplete,false);assert.deepEqual(result.eventReasons,{scan_work_limit:1});
});

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
      unavailable:3,verified:13,verifiedByTrack:{summer:6,desert:7}});}});
  assert.equal(result.rounds,4);
  assert.equal(result.stop,'round_limit');
  assert.deepEqual(result.reasons,{missing_trusted_track:8,scan_work_limit:4});
  assert.deepEqual(result.verifiedByTrack,{summer:24,desert:28});
  assert.equal(result.unavailable,12);
});

test('slow rounds stop before predicted time plus finish reserve exceeds admission window',async()=>{
  let clock=0,calls=0;
  const result=await drainVerification({now:()=>clock,requests:()=>10,log:quiet,
    runRound:async()=>{calls++;clock+=250000;return round();}});
  assert.equal(calls,1);assert.equal(result.stop,'time_reserve');
});

test('request reserve avoids starting another round near quota',async()=>{
  let used=0,calls=0;
  const result=await drainVerification({now:()=>0,requests:()=>used,log:quiet,
    runRound:async()=>{calls++;used=351;return round();}});
  assert.equal(calls,1);
  assert.equal(result.rounds,1);assert.equal(result.stop,'request_reserve');
});

test('adaptive final round uses a smaller bounded request remainder without exceeding the cap',async()=>{
  let used=0,calls=0;
  const result=await drainVerification({now:()=>0,requests:()=>used,log:quiet,runRound:async()=>{
    calls++;
    used=calls===1?310:370;
    return round({processed:1,verified:1});
  }});
  assert.equal(calls,2);
  assert.equal(result.rounds,2);
  assert.equal(result.processed,2);
  assert.equal(result.requests,370);
  assert.ok(result.requests<=DRAIN_LIMITS.requests);
  assert.equal(result.stop,'request_reserve');
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

test('tagged event conflicts preserve completed rounds and stop without replaying the interrupted round',async()=>{
  for(const limits of [DRAIN_LIMITS,CATCH_UP_LIMITS]) {
    let calls=0;const logs=[];
    const cause=Object.assign(Error('conflict'),{status:409,code:'ABORTED'});
    const result=await drainVerification({limits,now:()=>0,requests:()=>20,log:line=>logs.push(JSON.parse(line)),runRound:async()=>{
      if(calls++===0)return round({processed:4,verified:2,unavailable:2,events:{checked:3,consumed:1},
        reasons:{native_exact_finish:2,missing_trusted_track:2},verifiedByTrack:{summer:2}});
      throw new VerificationEventConflictError(cause);
    }});
    assert.equal(calls,2);
    assert.equal(result.rounds,1);
    assert.equal(result.processed,4);
    assert.equal(result.verified,2);
    assert.equal(result.unavailable,2);
    assert.equal(result.eventChecked,3);
    assert.deepEqual(result.reasons,{native_exact_finish:2,missing_trusted_track:2});
    assert.deepEqual(result.verifiedByTrack,{summer:2});
    assert.equal(result.stop,'event_conflict');
    assert.equal(result.interruptedRound,true);
    assert.equal(result.countsComplete,false);
    assert.deepEqual(logs,[{drain:result}]);
  }
});

test('drain never treats untagged conflicts, lookalike tags or denied writes as event deferrals',async()=>{
  const aborted=Object.assign(Error('conflict'),{status:409,code:'ABORTED'});
  const denied=Object.assign(Error('denied'),{status:403,code:'PERMISSION_DENIED'});
  for(const failure of [aborted,denied,
    Object.assign(Error('lookalike'),{code:'VERIFICATION_EVENT_CONFLICT',deferred:true,cause:aborted}),
    new VerificationEventConflictError(denied),new VerificationEventConflictError(Error('timeout'))]) {
    let calls=0;
    await assert.rejects(drainVerification({now:()=>0,requests:()=>1,log:quiet,
      runRound:async()=>{calls++;throw failure;}}),error=>error===failure);
    assert.equal(calls,1);
  }
});

test('drain summary aggregates returned queue documents and idle-slot counts',async()=>{
  const result=await drainVerification({now:()=>0,requests:()=>10,log:quiet,runRound:async()=>round({
    normalQueueReturnedDocuments:5,unusedEventReservedSlots:2,normalIdleSlots:3,idleNativeSlots:4,
  })});
  assert.equal(result.normalQueueReturnedDocuments,20);
  assert.equal(result.unusedEventReservedSlots,8);
  assert.equal(result.normalIdleSlots,12);
  assert.equal(result.idleNativeSlots,16);
});

test('deferred Firestore throttles stop drain without inventing publication counts',async()=>{
  const failure=Object.assign(Error('throttled'),{code:'FIRESTORE_COMMIT_THROTTLED',deferred:true,status:429});
  const result=await drainVerification({now:()=>0,requests:()=>7,log:quiet,runRound:async()=>{throw failure;}});
  assert.equal(result.rounds,0);
  assert.equal(result.stop,'firestore_throttled');
  assert.equal(result.interruptedRound,true);
  assert.equal(result.countsComplete,false);
  assert.equal(result.processed,0);
  assert.equal(result.verified,0);
});

test('shared Firestore deferral classification distinguishes local budgets from throttles and unrelated errors',()=>{
  assert.equal(firestoreDeferralReason(new FirestoreDocumentBudgetError('read_limit')),'firestore_document_budget');
  for(const code of ['FIRESTORE_READ_THROTTLED','FIRESTORE_COMMIT_THROTTLED']) {
    assert.equal(firestoreDeferralReason({code,deferred:true}),'firestore_throttled');
  }
  for(const failure of [null,undefined,Error('unrelated'),{deferred:true,status:429},
    {code:'FIRESTORE_DOCUMENT_BUDGET'}, {code:'FIRESTORE_DOCUMENT_BUDGET',deferred:'true'},
    {code:'FIRESTORE_READ_THROTTLED',deferred:false},{code:'FIRESTORE_DOCUMENT_BUDGET_EXTRA',deferred:true},
    {code:'PERMISSION_DENIED',deferred:true},new VerificationBudgetError()]) {
    assert.equal(firestoreDeferralReason(failure),null);
  }
});

test('document-budget interruptions preserve completed verdicts and event outcomes without replaying partial rounds',async()=>{
  for(const limits of [DRAIN_LIMITS,CATCH_UP_LIMITS]) for(const reason of ['read_limit','write_limit','unbounded_operation','invalid_response','response_exceeded_reservation']) {
    let calls=0,publications=0;
    const logs=[];
    const result=await drainVerification({limits,now:()=>0,requests:()=>10,log:line=>logs.push(JSON.parse(line)),runRound:async()=>{
      calls++;
      if(calls===1) {
        publications++;
        return round({processed:4,verified:2,mismatch:1,unavailable:1,deferred:0,
          reasons:{native_exact_finish:2,native_mismatch:1,missing_trusted_track:1},verifiedByTrack:{summer:2},
          events:{checked:2,consumed:1,reported:2,countsComplete:true,
            statuses:{verified:1,waiting:1},reasons:{native_exact_finish:1,scan_work_limit:1}}});
      }
      publications++; // The interrupted round may have committed a prefix.
      throw new FirestoreDocumentBudgetError(reason);
    }});
    assert.equal(calls,2);
    assert.equal(publications,2,'interrupted writes must never be replayed');
    assert.equal(result.stop,'firestore_document_budget');
    assert.equal(result.interruptedRound,true);
    assert.equal(result.countsComplete,false);
    assert.equal(result.eventCountsComplete,false);
    assert.equal(result.rounds,1);
    assert.equal(result.processed,4);
    assert.equal(result.verified,2);
    assert.equal(result.mismatch,1);
    assert.equal(result.unavailable,1);
    assert.equal(result.deferred,0,'job deferral count is not replaced with a boolean');
    assert.equal(result.eventChecked,2);
    assert.equal(result.eventReported,2);
    assert.deepEqual(result.reasons,{native_exact_finish:2,native_mismatch:1,missing_trusted_track:1});
    assert.deepEqual(result.verifiedByTrack,{summer:2});
    assert.deepEqual(result.eventStatuses,{verified:1,waiting:1});
    assert.deepEqual(result.eventReasons,{native_exact_finish:1,scan_work_limit:1});
    assert.deepEqual(logs,[{drain:result}]);
    assert.doesNotMatch(JSON.stringify(result),/read_limit|write_limit|invalid_response/);
  }
});

test('first-round document-budget stop returns unknown completeness, not successful zero-work completion',async()=>{
  for(const limits of [DRAIN_LIMITS,CATCH_UP_LIMITS]) {
    let calls=0;
    const result=await drainVerification({limits,now:()=>0,requests:()=>0,log:quiet,runRound:async()=>{
      calls++;
      throw new FirestoreDocumentBudgetError('write_limit');
    }});
    assert.equal(calls,1);
    assert.equal(result.rounds,0);
    assert.equal(result.processed,0);
    assert.equal(result.verified,0);
    assert.equal(result.eventChecked,0);
    assert.equal(result.countsComplete,false);
    assert.equal(result.eventCountsComplete,false);
    assert.equal(result.interruptedRound,true);
    assert.equal(result.stop,'firestore_document_budget');
  }
});

test('untagged document-budget lookalikes remain failures, not successful workflow deferrals',async()=>{
  for(const failure of [Object.assign(Error('bad config'),{code:'FIRESTORE_DOCUMENT_BUDGET'}),
    Object.assign(Error('bad config'),{code:'FIRESTORE_DOCUMENT_BUDGET',deferred:false}),
    Object.assign(Error('denied'),{code:'PERMISSION_DENIED',status:403,deferred:true})]) {
    await assert.rejects(drainVerification({now:()=>0,requests:()=>0,log:quiet,runRound:async()=>{throw failure;}}),error=>error===failure);
  }
});

test('real read/write document budgets stop the real drain without additional HTTP or stale publication',async()=>{
  for(const kind of ['read','write']) {
    let transports=0,commits=0,roundCalls=0;
    const raw=createFirestoreCaller({base:'https://offline.invalid/documents',access:'PRIVATE_TOKEN',
      documentReadLimit:1,documentWriteLimit:1,fetchImpl:async(url,options)=>{
        transports++;
        if(url.endsWith(':commit')) {
          commits++;
          return new Response(JSON.stringify({writeResults:JSON.parse(options.body).writes.map(()=>({}))}),{status:200});
        }
        return new Response(JSON.stringify({name:'queue/one'}),{status:200});
      }});
    const db=budgetDatabase(raw);
    const result=await drainVerification({now:()=>0,requests:db.requests,log:quiet,runRound:async()=>{
      roundCalls++;
      if(roundCalls===1) {
        await db.call('/queue/one');
        await db.call(':commit',{writes:[{}]});
        return round({processed:1,verified:1,events:{checked:0,consumed:0,countsComplete:true}});
      }
      if(kind==='read')await db.call('/queue/two');
      else await db.call(':commit',{writes:[{}]});
      assert.fail('Budget stop must interrupt publication');
    }});
    assert.equal(result.stop,'firestore_document_budget');
    assert.equal(result.countsComplete,false);
    assert.equal(result.eventCountsComplete,false);
    assert.equal(result.interruptedRound,true);
    assert.equal(result.verified,1);
    assert.equal(result.processed,1);
    assert.equal(roundCalls,2);
    assert.equal(transports,2);
    assert.equal(commits,1,'earlier confirmed mutation is neither reverted nor replayed');
    await assert.rejects(db.call(':commit',{writes:[{proof:'MUST_NOT_PUBLISH_STALE'}]}),FirestoreDocumentBudgetError);
    assert.equal(transports,2);
    assert.equal(db.estimatedDocumentWrites(),1);
    assert.equal(db.documentBudget().stopped,true);
    assert.doesNotMatch(JSON.stringify(result),/PRIVATE_TOKEN|MUST_NOT_PUBLISH_STALE/);
  }
});

test('runVerifier drain and Catch-Up expose document-budget interruption as deferred accounting',async()=>{
  for(const catchUp of [false,true]) {
    let roundCalls=0;
    const logs=[];
    const result=await runVerifier({drain:true,catchUp,clock:()=>0,
      env:{GITHUB_EVENT_NAME:'workflow_dispatch',FIREBASE_VERIFIER_SERVICE_ACCOUNT:'SYNTHETIC_ONLY'},
      validateEngine:async()=>{},connectDatabase:async()=>({call:()=>assert.fail('No extra database work')}),
      log:line=>logs.push(line),eventRun:async()=>{roundCalls++;throw new FirestoreDocumentBudgetError('read_limit');},
      selectNormal:()=>assert.fail('No selection after stop'),verifyNormal:()=>assert.fail('No simulation after stop'),
      publishNormal:()=>assert.fail('No publication after stop')});
    assert.equal(result.stop,'firestore_document_budget');
    assert.equal(result.countsComplete,false);
    assert.equal(result.interruptedRound,true);
    assert.equal(result.rounds,0);
    assert.equal(roundCalls,1);
    assert.equal(JSON.parse(logs.at(-1)).firestoreUsage.outcome,'deferred');
  }
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
        if(body.structuredQuery.limit===8)order.push('query');else assert.ok([1,2].includes(body.structuredQuery.limit));
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
  assert.deepEqual(f.order,Array.from({length:4},()=>['events','query','query','normal:16','publish']).flat());
  assert.equal('FIREBASE_VERIFIER_SERVICE_ACCOUNT'in f.options.env,false);
});

test('manual catch-up is wired through the real runner with one setup and preserved event quota',async()=>{
  const f=integration(4);
  f.options.catchUp=true;
  f.options.env.GITHUB_EVENT_NAME='workflow_dispatch';
  const result=await runVerifier(f.options);
  assert.equal(result.mode,'catch-up');assert.equal(result.rounds,12);
  assert.equal(result.processed,144);assert.equal(result.eventChecked,48);
  assert.equal(f.connections,1);assert.equal(f.pins,1);
  assert.deepEqual(f.order,Array.from({length:12},()=>['events','query','query','normal:12','publish']).flat());
});

test('real Catch-Up runner shares period selection state only within its invocation', async () => {
  let prior;
  for (let invocation = 0; invocation < 2; invocation++) {
    const f = integration(4);
    const base = f.options.eventRun;
    let calls = 0, state;
    f.options.catchUp = true;
    f.options.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
    f.options.eventRun = async (db, root, options) => {
      if (!state) {
        state = options.selectionState;
        assert.notEqual(state, prior);
        assert.deepEqual(state, {});
      }
      assert.equal(options.selectionState, state);
      assert.equal(state.lastPeriodId, calls ? String(calls) : undefined);
      state.lastPeriodId = String(++calls);
      return base(db, root, options);
    };
    await runVerifier(f.options);
    assert.equal(calls, 12);
    prior = state;
  }
});

test('sustained events get first chance and four reserved simulations on every round',async()=>{
  const f=integration(4);const result=await runVerifier(f.options);
  assert.equal(result.processed,48);assert.equal(result.eventChecked,16);
  assert.deepEqual(f.order,Array.from({length:4},()=>['events','query','query','normal:12','publish']).flat());
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
  assert.match(step,/inputs.catch_up && 15 \|\| 10/);assert.match(step,/run.mjs --drain/);
  assert.match(step,/if: steps.queue.outputs.has_work == 'true'/);
  assert.match(workflow,/actions\/cache@[0-9a-f]{40}/);
  assert.match(workflow,/playwright-\$\{\{ hashFiles\('tools\/verifier\/package-lock\.json'\) \}\}/);
  assert.match(workflow,/npx playwright install --with-deps chromium/);
  assert.match(workflow,/chromiumSandbox:true/);
  assert.match(workflow,/inputs.catch_up && 25 \|\| 15/);assert.match(workflow,/contents: read/);
  assert.match(workflow,/group: polytrack-run-verifier/);
  assert.match(workflow,/cancel-in-progress: false/);
  assert.match(workflow,/catch_up:[\s\S]*type: boolean[\s\S]*default: false/);
  assert.match(step,/github.event_name == 'workflow_dispatch' && inputs.catch_up/);
  assert.match(workflow,/cache: npm/);assert.match(workflow,/cache-dependency-path: tools\/verifier\/package-lock\.json/);
  assert.equal(DRAIN_LIMITS.rounds*16,64);assert.equal(DRAIN_LIMITS.requests,400);
  assert.doesNotMatch(workflow,/--no-sandbox/);
});

test('catch-up keeps explicit round and request ceilings without changing normal limits',async()=>{
  let calls=0;
  const result=await drainVerification({limits:CATCH_UP_LIMITS,now:()=>0,requests:()=>calls*70,log:quiet,
    runRound:async()=>{calls++;return round();}});
  assert.equal(calls,12);assert.equal(result.processed,192);assert.equal(result.stop,'round_limit');
  assert.equal(DRAIN_LIMITS.requests,400);assert.equal(DRAIN_LIMITS.rounds,4);
  const db=budgetDatabase({call:async()=>[]},1200,CATCH_UP_LIMITS);
  for(let i=0;i<1200;i++)await db.call(':runQuery',{});
  await assert.rejects(db.call(':runQuery',{}),VerificationBudgetError);
  assert.equal(db.requests(),1200);
  assert.throws(()=>budgetDatabase({},1201,CATCH_UP_LIMITS),/budget/);
  assert.throws(()=>budgetDatabase({},1200,{...CATCH_UP_LIMITS}),/limits/);
});

test('catch-up stops on empty work, throttle, infrastructure failures and time reserve',async()=>{
  for(const [report,stop] of [[round({processed:0,canonicalAttempts:0}),'no_progress'],
    [round({infrastructureFailure:true}),'infrastructure_failure']]){
    let calls=0;
    const result=await drainVerification({limits:CATCH_UP_LIMITS,now:()=>0,requests:()=>0,log:quiet,
      runRound:async()=>{calls++;return report;}});
    assert.equal(calls,1);assert.equal(result.stop,stop);
  }
  const error=Object.assign(Error('throttle'),{deferred:true,code:'FIRESTORE_READ_THROTTLED'});
  const throttled=await drainVerification({limits:CATCH_UP_LIMITS,requests:()=>1,log:quiet,runRound:async()=>{throw error;}});
  assert.equal(throttled.stop,'firestore_throttled');assert.equal(throttled.countsComplete,false);
  let time=0;
  const timed=await drainVerification({limits:CATCH_UP_LIMITS,now:()=>time,requests:()=>1,log:quiet,
    runRound:async()=>{time+=400000;return round();}});
  assert.equal(timed.rounds,1);assert.equal(timed.stop,'time_reserve');
});

test('catch-up rejects scheduled or ambiguous invocation before database access',async()=>{
  for(const options of [{catchUp:true},{catchUp:true,drain:true,check:true},
    {catchUp:'true',drain:true},{catchUp:true,drain:true,env:{}},
    {catchUp:true,drain:true,env:{GITHUB_EVENT_NAME:'schedule'}}]){
    await assert.rejects(runVerifier({...options,connectDatabase:()=>assert.fail('Must not connect'),
      validateEngine:()=>assert.fail('Must reject before loading engine')}),/Catch-Up/);
  }
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
      assert.ok(Number.isInteger(q.limit)&&q.limit>=1&&q.limit<=8);
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
  assert.ok(result.processed>43);assert.equal(result.processed,result.verified);assert.equal(nativeCalls,4);
  assert.equal(result.stop,'round_limit');assert.ok(result.requests<=DRAIN_LIMITS.requests);
  const slots=[...docs].filter(([key])=>key.startsWith(VERIFICATION_COLLECTION+'/')).flatMap(([,doc])=>Object.values(doc.data.slots));
  assert.equal(slots.filter(s=>s.status==='verified').length,result.processed);
  assert.equal(slots.filter(s=>s.status==='waiting').length,64-result.processed);
  assert.equal(JSON.stringify([...docs].filter(([key])=>key.startsWith('0.6.2_race_results/'))),canonicalBefore);
  t.diagnostic(JSON.stringify({processed:result.processed,requests:result.requests,stop:result.stop,remainingWaiting:64-result.processed}));
});

test('normal simulation starts only for jobs whose worst-case publication fits remaining quota',async()=>{
  const f=integration(0);
  f.options.eventRun=async db=>{
    for(let i=0;i<365;i++)await db.call(':runQuery',{structuredQuery:{limit:2}});
    return {checked:0,consumed:0,rejected:false,archived:null,results:[]};
  };
  const result=await runVerifier(f.options);
  assert.equal(result.processed,1);assert.equal(result.verified,1);
  assert.equal(result.stop,'request_reserve');assert.equal(result.rounds,1);
  assert.ok(f.order.includes('normal:1'));assert.ok(!f.order.includes('normal:16'));
});
