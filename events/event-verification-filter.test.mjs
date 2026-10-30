import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {eventSnapshotRows,eventSnapshotFields,eventRowVerified,eventDisplayRunAt,eventVerificationLabel,eventRecordPlacement,retainEventSnapshotDates,decorateEventRowPresentation} from './client.mjs';

const hash=n=>n.toString(16).padStart(64,'0');
const period={id:'weekly-fixture',trackId:hash(999),kind:'weekly'};
const row=(n,timeMs=1000+n)=>({accountId:hash(n),timeMs,rank:n,rp:100});
const waiting=(n,timeMs=1000+n)=>({...row(n,timeMs),runId:hash(n+1000),pending:true,verified:false,eventRpEligible:false,verificationStatus:'waiting',source:'pending-event-playback'});
const board=(entries,pendingPlaybacks=[])=>({period,updatedAt:Date.now(),entries,pendingPlaybacks,_publicBackup:true});

test('72 public racers and 50 verified racers produce coherent full-field counts and page slices',()=>{
  const saved=board(Array.from({length:50},(_,i)=>row(i+1,2000+i)),Array.from({length:22},(_,i)=>waiting(i+51,1000+i)));
  const before=structuredClone(saved),all=eventSnapshotRows(saved).rows,verified=eventSnapshotRows(saved,{onlyVerified:true}).rows;
  assert.equal(all.length,72);assert.equal(verified.length,50);
  assert.equal(Math.ceil(all.length/20),4);assert.equal(Math.ceil(verified.length/20),3);
  assert.deepEqual([0,20,40,60].map(start=>all.slice(start,start+20).length),[20,20,20,12]);
  assert.deepEqual([0,20,40].map(start=>verified.slice(start,start+20).length),[20,20,10]);
  assert.deepEqual(verified.map(r=>r.rank),Array.from({length:50},(_,i)=>i+1));
  assert.deepEqual(saved,before);
});

test('verified-only filtering happens before account PB merging and preserves saved rank provenance',()=>{
  const saved=board([row(1,2000),row(2,3000)],[waiting(1,1000),waiting(3,1500)]);
  assert.deepEqual(eventSnapshotRows(saved).rows.map(r=>[r.accountId,r.pending,r.rank]),[[hash(1),true,1],[hash(3),true,2],[hash(2),false,3]]);
  const visible=eventSnapshotRows(saved,{onlyVerified:true}).rows;
  assert.deepEqual(visible.map(r=>[r.timeMs,r.pending,r.rank,r.originalRank]),[[2000,false,1,1],[3000,false,2,2]]);
});

test('subset ranks preserve legitimate competition ties and remove only exclusion gaps',()=>{
  const saved=board([row(1,1000),row(2,1000),row(4,3000)],[waiting(3,2000)]);
  const {rows}=eventSnapshotRows(saved,{onlyVerified:true});
  assert.deepEqual(rows.map(r=>r.rank),[1,1,3]);
  assert.deepEqual(rows.map(r=>r.originalRank),[1,2,4]);
});

test('negative proof/status flags never become verified; private holds never enter either visible field',()=>{
  const flags=[{pending:true},{verified:false},{runVerified:false},{physicsVerified:false},{replayIntegrityVerified:false},{integrityVerified:false},{eventRpEligible:false},{status:'waiting'},{verificationStatus:'pending'}];
  for(const flag of flags){
    const entry={...row(1),...flag};assert.equal(eventRowVerified(entry),false);
    assert.equal(eventSnapshotRows(board([entry]),{onlyVerified:true}).rows.length,0);
    assert.equal(eventSnapshotRows(board([entry])).rows[0].pending,true);
  }
  for(const flag of [{needsReview:true},{reviewHold:true},{status:'rejected'},{verificationStatus:'unavailable_final'},{verificationStatus:'review_hold'}])
    for(const onlyVerified of [false,true])assert.equal(eventSnapshotRows(board([{...row(1),...flag}]),{onlyVerified}).rows.length,0);
});

test('finite event physics proof maps to native verified UI without legacy flags or proof mutations',()=>{
  const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
  const nativeRow=vm.runInNewContext(source.slice(source.indexOf('function nativeEventRow('),source.indexOf('export function handleEventCarIntersections('))+';nativeEventRow;',{eventRowVerified});
  const proof={...row(1),physicsVerified:true,replayIntegrityVerified:true,verifiedState:0,submittedAt:Date.now()-1000};
  const before=structuredClone(proof),saved=board([proof]);
  const visible=eventSnapshotFields(saved).verified.rows;
  assert.equal(visible.length,1);assert.equal(visible[0].pending,false);
  const native=nativeRow(visible[0],hash(1),proof.submittedAt);
  assert.equal(native.verifiedState,1);assert.equal(native.runVerified,true);assert.equal(native.pending,false);
  assert.deepEqual(proof,before,'native client flags are never written back into snapshot authority');
  for(const change of [{pending:true},{verificationStatus:'waiting'},{verified:false},{runVerified:false},
    {eventRpEligible:false},{physicsVerified:false},{replayIntegrityVerified:false},{needsReview:true},{reviewHold:true}]){
    const pending=nativeRow({...proof,...change},hash(1),proof.submittedAt);
    assert.equal(pending.verifiedState,0);assert.equal(pending.runVerified,false);assert.equal(pending.pending,true);
  }
});

test('event status decoration maps authoritative proof to icon, class and shared status dataset',()=>{
  const classes=new Set(),icon={},state={dataset:{},childNodes:[],
    classList:{toggle:(name,on)=>on?classes.add(name):classes.delete(name)},querySelector:()=>icon,setAttribute() {}};
  const button={querySelector:selector=>selector==='.verified-state'?state:null};
  const proof={...row(1),physicsVerified:true,replayIntegrityVerified:true};
  decorateEventRowPresentation(button,proof);
  assert.equal(state.dataset.sqRunStatus,'verified');assert.equal(classes.has('verified'),true);
  assert.equal(icon.src,'images/state_verified.svg');assert.match(state.title,/Verified$/);
  decorateEventRowPresentation(button,{...proof,pending:true,verificationStatus:'waiting'});
  assert.equal(state.dataset.sqRunStatus,'unchecked');assert.equal(classes.has('verified'),false);
  assert.equal(classes.has('pending'),true);assert.equal(icon.src,'images/state_pending.svg');assert.match(state.title,/Pending$/);
});
test('record placement never approves an explicitly unverified entry and matches its all-row field',()=>{
  const saved=board([{...row(1,1000),physicsVerified:false},row(2,2000)]);
  assert.equal(eventRecordPlacement({board:saved,period,accountId:hash(1),timeMs:1000,policy:'verified'}),null);
  assert.equal(eventRecordPlacement({board:saved,period,accountId:hash(2),timeMs:2000,policy:'verified'}).rank,1);
  const all=eventRecordPlacement({board:saved,period,accountId:hash(2),timeMs:2000});
  assert.equal(all.rank,2);assert.equal(all.provisional,true);
});

test('personal filters and verified filters share one ranked field without mutating source rows',()=>{
  for(const archived of [false,true]){
    const saved={...board([row(1,1000),row(2,2000),row(3,2000),row(4,3000)],[waiting(5,500)]),archived};
    const result=eventSnapshotRows(saved,{onlyVerified:true,filterRows:rows=>({active:true,rows:rows.filter(r=>r.timeMs>=2000)})});
    assert.deepEqual(result.rows.map(r=>[r.rank,r.groupRank,r.originalRank]),[[1,1,2],[1,1,3],[3,3,4]]);
    assert.equal(result.filterResult.rows,result.rows);assert.equal(result.filterResult.filteredCount,3);
    assert.equal(saved.entries[1].rank,2);
  }
});

test('a local waiting PB uses its existing timestamp without becoming verified',()=>{
  const at=Date.now()-1000,local={...row(1,500),pending:true,runAt:at};
  const saved=board([row(1,2000)]);
  const all=eventSnapshotRows(saved,{local}).rows[0];
  assert.equal(all.pending,true);assert.equal(eventDisplayRunAt(all),at);
  assert.equal(eventSnapshotRows(saved,{local,onlyVerified:true}).rows[0].timeMs,2000);
});

test('proof status changes retain existing dates only for exact bound saved runs',()=>{
  const at=Date.now()-3600000,pending={...waiting(1),submittedAt:at,runCreatedAt:at-1000};
  const old=board([],[pending]),fresh=board([{...row(1),runId:pending.runId,verifiedAt:at+1000}]);
  const retained=retainEventSnapshotDates(fresh,old);
  assert.equal(retained.entries[0].submittedAt,at);assert.equal(retained.entries[0].runCreatedAt,at-1000);
  assert.equal(retained.entries[0].verifiedAt,at+1000);assert.equal(eventDisplayRunAt(retained.entries[0]),at-1000);
  assert.equal(fresh.entries[0].submittedAt,undefined);
  for(const change of [{runId:hash(9999)},{timeMs:2000},{replayHash:hash(99),runId:hash(22)}])
    assert.equal(retainEventSnapshotDates(board([{...fresh.entries[0],...change}]),old).entries[0].submittedAt,undefined);
  assert.equal(retainEventSnapshotDates({...fresh,period:{...period,trackId:hash(7)}},old).entries[0].submittedAt,undefined);
  assert.equal(retainEventSnapshotDates(board([row(1)]),board([{...row(1),submittedAt:at}])).entries[0].submittedAt,undefined,'same time alone is not exact replay identity');
});

test('verification-only dates remain explicit and missing dates are never synthesized',()=>{
  const verifiedAt=Date.now()-1000;
  assert.match(eventVerificationLabel({verifiedAt}),/^Verification date .* - Verified$/);
  assert.equal(eventDisplayRunAt({verifiedAt}),null);
  assert.equal(eventVerificationLabel({updatedAt:verifiedAt,checkedAt:verifiedAt}),'Date unavailable - Verified');
  assert.equal(retainEventSnapshotDates(board([row(1)]),board([row(1)])).entries[0].submittedAt,undefined);
});

test('snapshot-only client ignores previous-package browser boards and never invokes a live fallback',async()=>{
  const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
  const code=source.slice(source.indexOf('  async function snapshot('),source.indexOf('  function updateEventRefreshControl('));
  let reads=0;const stale=board([row(1)]),current=board([row(2)]),cache=new Map();
  const context={cache,snapshotFetching:new Map(),snapshotAttempts:new Map(),STORE:'test',read:()=>stale,
    cacheWrite(){},now:()=>Date.now(),catalog:{periods:[]},retainEventSnapshotDates,
    bridge:{snapshotOnly:()=>true,readSnapshot:async()=>{reads++;return current;},readArchivedSnapshot:()=>{throw Error('Live archive fallback forbidden');}}};
  const snapshot=vm.runInNewContext(`${code};snapshot;`,context);
  assert.equal((await snapshot(period)).entries[0].accountId,hash(2));assert.equal(reads,1);
  await snapshot(period);assert.equal(reads,1,'filters/pages reuse this client package');
  const emptyContext={...context,cache:new Map(),snapshotFetching:new Map(),snapshotAttempts:new Map(),bridge:{...context.bridge,readSnapshot:async()=>{throw Error('Current package unavailable');}}};
  const unavailable=vm.runInNewContext(`${code};snapshot;`,emptyContext);
  await assert.rejects(unavailable(period),/Current package unavailable/);assert.equal(emptyContext.cache.size,0);
});
