import test from 'node:test';
import assert from 'node:assert/strict';
import {eventPeriod, publicEventPeriod, eventRp, eventLeaderboard, capturedEventRp, capturedEventLeaderboard} from '../src/events.js';

const period = scoringVersion => eventPeriod({id:'scoring-fixture',kind:'custom',enabled:true,trackId:'a'.repeat(64),
  startsAt:1000,endsAt:86401000,graceMs:86400000,maxRp:700,targetMs:35000,scoringVersion,
  eligibility:'best-submitted-during-period',capacity:{policyVersion:'reviewed-fixture',entrants:200,
    admissionsPerPeriod:512,replayBytesPerPeriod:1048576,minIntervalMs:5000,verificationsPerDay:128}});

test('captured scoring exactly matches server scoring for both immutable event algorithms',()=>{
  for(const version of ['time-ratio-v1','time-gap-v2']){
    const full=period(version),captured=publicEventPeriod(full);
    for(let time=1;time<=300000;time+=113)assert.equal(capturedEventRp(captured,time),eventRp(full,time));
    for(const time of [34999,35000,35001,300000])assert.equal(capturedEventRp(captured,time),eventRp(full,time));
  }
});

test('captured rank, ties, dates and scores use the same row projector as the server',()=>{
  const full=period('time-gap-v2'),rows=[
    {accountId:'c'.repeat(64),timeMs:37000,name:'C',submittedAt:2000,verifiedAt:5000},
    {accountId:'b'.repeat(64),timeMs:35000,name:'B',submittedAt:3000,verifiedAt:6000},
    {accountId:'d'.repeat(64),timeMs:35000,name:'D',submittedAt:4000,verifiedAt:7000}];
  const captured=capturedEventLeaderboard(publicEventPeriod(full),rows);
  assert.deepEqual(captured,eventLeaderboard(full,rows));
  assert.deepEqual(captured.map(row=>row.rank),[1,1,3]);
});

test('missing legacy algorithm means the original ratio policy, never a guessed modern policy',()=>{
  const original=publicEventPeriod(period('time-ratio-v1')),legacy={...original};delete legacy.scoringVersion;
  assert.equal(capturedEventRp(legacy,45000),capturedEventRp(original,45000));
  assert.notEqual(capturedEventRp(legacy,45000),capturedEventRp({...original,scoringVersion:'time-gap-v2'},45000));
});

test('public scoring inputs cannot bypass full server admission or proof policy',()=>{
  const captured=publicEventPeriod(period('time-ratio-v1'));
  assert.throws(()=>eventRp(captured,35000),/reviewed_capacity_required/);
  assert.throws(()=>capturedEventRp({...captured,targetMs:undefined},35000),/invalid_scoring/);
  assert.throws(()=>capturedEventRp({...captured,scoringVersion:'unknown'},35000),/invalid_scoring_version/);
  assert.throws(()=>capturedEventLeaderboard({...captured,entrantLimit:undefined},[]),/leaderboard_capacity/);
  assert.throws(()=>capturedEventLeaderboard({...captured,targetMs:undefined},[]),/invalid_scoring/);
});
