import test from 'node:test';import assert from 'node:assert/strict';
import {createEventSession,keepEventBest,matchingEventRuns} from './session.mjs';
const accountId='a'.repeat(64),trackId='b'.repeat(64),period={id:'daily',trackId,startsAt:1,endsAt:100};
const context={accountId,trackId,raceId:'car1'};
test('ordinary play never creates an event run',()=>{const s=createEventSession({now:()=>10});assert.equal(s.bind(context),false);assert.equal(s.finish({...context,timeMs:10}),null);});
test('only explicit matching event context submits',()=>{const s=createEventSession({now:()=>10});s.enter(period,accountId);assert.equal(s.bind(context),true);assert.equal(s.bind({...context,accountId:'c'.repeat(64)}),false);const run=s.finish({...context,timeMs:10});assert.equal(run.periodId,'daily');assert.equal(run.trackId,trackId);});
test('retries on the same native car have distinct attempt identities',()=>{const s=createEventSession({now:()=>10});s.enter(period,accountId);s.bind(context);const a=s.finish({...context,timeMs:20}),b=s.finish({...context,timeMs:15});assert.notEqual(a.attemptId,b.attemptId);});
test('leaving and event expiry invalidate bound cars',()=>{let time=10;const s=createEventSession({now:()=>time});s.enter(period,accountId);s.bind(context);time=100;assert.equal(s.finish(context),null);time=10;s.enter(period,accountId);s.bind(context);s.leave();assert.equal(s.finish(context),null);});
test('offline queue preserves faster event PB and isolates accounts/periods',()=>{const a={periodId:'p',accountId,timeMs:20};assert.deepEqual(keepEventBest([a],{...a,timeMs:25}),[a]);assert.equal(keepEventBest([a],{...a,timeMs:15})[0].timeMs,15);assert.equal(keepEventBest([a],{...a,periodId:'q'}).length,2);});

test('full pending queue never silently evicts another racer PB',()=>{const queue=Array.from({length:64},(_,i)=>({periodId:'p'+i,accountId,timeMs:20}));assert.throws(()=>keepEventBest(queue,{periodId:'new',accountId,timeMs:10}),/storage is full/);assert.equal(keepEventBest(queue,{...queue[0],timeMs:10}).length,64);assert.equal(queue[0].timeMs,20);});

test('a real matching finish credits all active periods without an event launch',()=>{
 const run={...context,timeMs:20};
 const matches=matchingEventRuns(run,[period,{...period,id:'weekly'},{...period,id:'other',trackId:'c'.repeat(64)},period],accountId,10);
 assert.deepEqual(matches.map(row=>row.periodId),['daily','weekly']);
 assert.equal(matches[0].finishedAt,10);assert.notEqual(matches[0].attemptId,matches[1].attemptId);
});
test('finish time controls admission, including exact start and exclusive end',()=>{
 const run={...context,timeMs:20};
 assert.equal(matchingEventRuns(run,[period],accountId,0).length,0);
 assert.equal(matchingEventRuns(run,[period],accountId,1).length,1);
 assert.equal(matchingEventRuns(run,[period],accountId,100).length,0);
 assert.equal(matchingEventRuns(run,[{...period,archived:true},{...period,enabled:false}],accountId,10).length,0);
 assert.equal(matchingEventRuns(run,[period],'c'.repeat(64),10).length,0);
 assert.equal(matchingEventRuns({...run,raceId:null},[period],accountId,10).length,0);
});
