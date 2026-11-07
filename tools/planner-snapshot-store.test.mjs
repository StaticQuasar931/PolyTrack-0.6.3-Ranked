import test from 'node:test';
import assert from 'node:assert/strict';
import {buildPlannerStoreFromSnapshots as build} from './planner-snapshot-store.mjs';
const board={complete:true,totalEntries:2,entries:[{accountId:'b',timeMs:2000},{accountId:'a',timeMs:1000}]};
test('fixed package IDs are deduplicated, sorted and read once, independent of completion order',async()=>{
  const calls=[];
  const a=await build({trackIds:['z','a','z'],read:async id=>{calls.push(id);return board;}});
  const b=await build({trackIds:['a','z'],read:async()=>({...board,entries:[...board.entries].reverse()})});
  assert.deepEqual(a,b);assert.deepEqual(calls,['a','z']);
  assert.equal(board.entries[0].accountId,'b','source board is unchanged');
});
test('partial, mismatched, duplicate, pending and inexact boards do not create ease evidence',async()=>{
  for(const patch of [{complete:false},{totalEntries:3},{ranksExact:false},{sourceComplete:false},
    {totalEntriesExact:false},{trackId:'wrong'},{entries:[board.entries[0],board.entries[0]]},
    {entries:[{...board.entries[0],timeMs:1.5},board.entries[1]]},
    {entries:[{...board.entries[0],localPending:true},board.entries[1]]}]){
    assert.deepEqual(await build({trackIds:['a'],read:async()=>({...board,...patch})}),{});
  }
});
test('generation or account cancellation discards an in-flight result and does not schedule more fields',async()=>{
  let current=true,finish,calls=0;
  const pending=build({trackIds:['a','b'],concurrency:1,isCurrent:()=>current,read:()=>{calls++;return new Promise(resolve=>finish=resolve);}});
  current=false;finish(board);assert.equal(await pending,null);assert.equal(calls,1);
});
test('read failures remain unknown, never trigger an alternate/live source',async()=>{
  assert.deepEqual(await build({trackIds:['a'],read:async()=>{throw Error('missing package field');}}),{});
  assert.deepEqual(await build(),{});
});
