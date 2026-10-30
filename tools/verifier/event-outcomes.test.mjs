import test from 'node:test';
import assert from 'node:assert/strict';
import {observeEventStore} from './event-outcomes.mjs';
import {EVENT_COLLECTIONS as C} from '../../workers/ranked/src/events.js';
test('event outcomes observe only committed transactions with no extra gets, including a prefix before conflict',async()=>{
  const reports=[];let reads=0,fail=false;
  const row={runId:'a'.repeat(64),accountId:'b'.repeat(64),trackId:'c'.repeat(64),periodId:'daily'};
  const store=observeEventStore({transaction:async callback=>{
    const value=await callback({get:async()=>{reads++;return row;},patch:async()=>{}});
    if(fail)throw Object.assign(Error('conflict'),{status:409});return value;
  }},(...args)=>reports.push(args));
  const work=()=>store.transaction(async tx=>{const name=C.runs+'/'+row.runId;await tx.get(name);await tx.patch(name,{status:'verified',proof:{reason:'native_exact_finish'}});return 'done';});
  assert.equal(await work(),'done');fail=true;await assert.rejects(work(),/conflict/);
  assert.equal(reads,2);assert.equal(reports.length,1);assert.equal(reports[0][2].completed,true);
});
