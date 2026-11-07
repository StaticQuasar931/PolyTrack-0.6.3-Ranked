import test from 'node:test';
import assert from 'node:assert/strict';
import {prioritizeNativeTargets} from './native-verification-priority.mjs';
import {ledgerBinding,ledgerKey} from '../native-verification-ledger.mjs';
const id=n=>n.toString(16).padStart(64,'0'),track=id(99);
const normal=(n,ingestedAt)=>({lane:'normal',kind:'normal',accountId:id(n),trackId:track,uploadId:n,
  timeMs:900,frames:900,replayHash:id(77),resultId:id(n)+'_'+track,ingestedAt});
const event=(n,periodId)=>({...normal(n,0),lane:'event',kind:'event-pending',periodId,runId:id(n+100),resultId:id(n+100),uploadId:null});
const board=(id,archived=false)=>({id,archived,state:archived?'archived':'open',period:{id,startsAt:100,endsAt:2000}});

test('live waiting event goes first even after thousands of normal inputs; recent normal follows deterministically',()=>{
  const normals=Array.from({length:2000},(_,i)=>normal(i+1,100+i)),live=event(3000,'weekly'),old=event(3001,'old');
  const jobs=[...normals,old,live],before=jobs.slice();
  const result=prioritizeNativeTargets({jobs,eventBoards:[board('weekly'),board('old',true)],policy:{knownTrackIds:[track]},now:1000});
  assert.equal(result.jobs[0],live);assert.equal(result.jobs[1],normals.at(-1));
  assert.equal(result.jobs.at(-1),old);assert.equal(result.jobs.length,jobs.length);
  assert.deepEqual(jobs,before,'complete review inventory must not be reordered in-place');
  assert.deepEqual(prioritizeNativeTargets({jobs:jobs.toReversed(),eventBoards:[board('weekly'),board('old',true)],policy:{knownTrackIds:[track]},now:1000}).jobs,result.jobs);
});

test('public proof hits, unknown media and holds remain in inventory without gaining authority',()=>{
  const hit=normal(1,500),unknown={...normal(2,999),trackId:id(88)},held={...normal(3,600),needsReview:true},pending=event(4,'daily');
  const jobs=[hit,unknown,held,pending],key=ledgerKey(ledgerBinding(hit));
  const result=prioritizeNativeTargets({jobs,eventBoards:[board('daily')],entries:[{key}],policy:{knownTrackIds:[track]},now:1000});
  assert.deepEqual(result.jobs,[pending,held,hit,unknown]);assert.equal(result.jobs[1].needsReview,true);
  assert.equal(result.counts.exactPublicBinding,1);assert.equal(result.counts.other,1);
  assert.equal(new Set(result.jobs).size,4);assert.equal(hit.verified,undefined);
});
