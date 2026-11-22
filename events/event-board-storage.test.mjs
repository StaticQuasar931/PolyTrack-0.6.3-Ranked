import test from 'node:test';
import assert from 'node:assert/strict';
import {saveEventBoardCache,writeEventRecord} from './client.mjs';

const prefix='polytrack-062-events-v1', queue=prefix+'-queue',best=prefix+'-best';
function makeStorage(capacity,entries=[]){
  const rows=new Map(entries);
  return {rows,get length(){return rows.size;},key(i){return [...rows.keys()][i];},getItem(k){return rows.get(k)??null;},
    removeItem(k){rows.delete(k);},setItem(k,v){const next=new Map(rows);next.set(k,v);if([...next.values()].reduce((n,s)=>n+s.length,0)>capacity)throw Object.assign(Error('full'),{name:'QuotaExceededError'});rows.set(k,v);}};
}
test('a full browser evicts only uploaded board caches and preserves queued PBs and replays',()=>{
  const local=makeStorage(100,[[prefix+'-d_20261120','x'.repeat(72)],[prefix+'-replays','own replay'],[best,'old best'],['native-profile','my car']]);
  const adapter={setItem:(...args)=>local.setItem(...args)};
  writeEventRecord(adapter,local,queue,[{attemptId:'new-run'}]);
  assert.deepEqual(JSON.parse(local.getItem(queue)),[{attemptId:'new-run'}]);
  assert.equal(local.getItem(best),'old best');assert.equal(local.getItem(prefix+'-replays'),'own replay');assert.equal(local.getItem('native-profile'),'my car');
  assert.equal(local.getItem(prefix+'-d_20261120'),null);
});
test('unrelated storage errors do not evict caches or trigger repeated writes',()=>{
  const key=prefix+'-permanent',local=makeStorage(99,[[key,'keep']]);
  let writes=0; const failure=Error('disabled'),adapter={setItem(){writes++;throw failure;}};
  assert.throws(()=>writeEventRecord(adapter,local,best,{}),error=>error===failure);
  assert.equal(writes,1);assert.equal(local.getItem(key),'keep');
});
test('board caches retain bounded recent entries and reject oversized payloads',()=>{
  const local=makeStorage(Infinity,[[queue,'pending'],[prefix+'-kodub_1764000000000','old board']]);
  const adapter={...local,cacheKeys:()=>[...local.rows.keys()]};
  for(let day=10;day<22;day++)assert.equal(saveEventBoardCache(adapter,prefix+'-d_202611'+day,{id:day}),true);
  assert.equal([...local.rows.keys()].filter(k=>k!==queue).length,8);
  assert.equal(local.getItem(prefix+'-d_20261110'),null);
  assert.equal(saveEventBoardCache(adapter,prefix+'-permanent',{entries:'x'.repeat(300000)}),false);
  assert.equal(local.getItem(queue),'pending');
});
