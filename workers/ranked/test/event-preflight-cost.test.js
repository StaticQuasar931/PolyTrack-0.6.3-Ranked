import test from 'node:test';
import assert from 'node:assert/strict';
import {eventWork} from '../src/events-runtime.js';
import {eventEncode} from '../src/events-store.js';
import {EVENT_COLLECTIONS as C} from '../src/events.js';
import {checkEventWork} from '../../../tools/verifier/events.mjs';

const dueSlot = {notBefore:0, leaseUntil:0, attempts:0};
const wire = value => ({fields:eventEncode(value).mapValue.fields});
function fixture({count=16, due=[], receipt=false, retry=false, closing=false, slot=dueSlot}={}) {
  const calls=[];
  const periods=Array.from({length:count}, (_,i)=>({id:'p'+i, enabled:true, startsAt:0,
    endsAt:closing?1000:10000, graceMs:100, archived:false}));
  const request=async (route, init={})=>{
    calls.push(route);
    if(route===`/${C.catalog}/main`)return wire({periods});
    if(route.startsWith(`/${C.queues}/`))return wire({slots:due.includes(route.split('/').at(-1))?[slot]:[]});
    if(route===`/${C.cursors}/scan`)return null;
    assert.equal(route,':runQuery','preflight must not read canonical replays, authenticate, or write');
    const query=JSON.parse(init.body).structuredQuery;
    assert.equal(query.limit,1);
    const collection=query.from[0].collectionId;
    assert.ok([C.inbox,C.retries].includes(collection));
    return (collection===C.inbox?receipt:retry)?[{document:wire({})}]:[];
  };
  const runtime={now:()=>2000, request};
  const db={call:(route,body)=>request(route,body?{body:JSON.stringify(body)}:{})};
  return {calls, periods, runtime, gate:()=>checkEventWork(db,{now:2000})};
}

test('real verifier preflight stops after first due event: 2 rather than 20 reads',async()=>{
  const f=fixture({due:['p0','p1']});
  assert.deepEqual(await f.gate(),{hasWork:true,periodIds:['p0'],inbox:false,archiveId:null});
  assert.deepEqual(f.calls,[`/${C.catalog}/main`,`/${C.queues}/p0`]);
  f.calls.length=0;
  assert.deepEqual((await eventWork(f.runtime)).periodIds,['p0','p1']);
  assert.equal(f.calls.length,20,'default discovery still gathers all queues and checks intake');
});

test('24h maximum-window due-event preflight saves 1728 document reads at 96 wakes',async()=>{
  const f=fixture({due:['p0']});
  for(let i=0;i<96;i++)assert.equal((await f.gate()).hasWork,true);
  assert.equal(f.calls.length,192);
  f.calls.length=0;
  for(let i=0;i<96;i++)await eventWork(f.runtime);
  assert.equal(f.calls.length,1920);
});

test('closing event wakes preflight from catalog alone; processor retains queues and archive',async()=>{
  const f=fixture({due:['p0','p1'],closing:true});
  assert.deepEqual(await f.gate(),{hasWork:true,periodIds:[],inbox:false,archiveId:'p0'});
  assert.deepEqual(f.calls,[`/${C.catalog}/main`]);
  f.calls.length=0;
  assert.deepEqual(await eventWork(f.runtime,{inspectInbox:false}),
    {hasWork:true,periodIds:['p0','p1'],inbox:false,archiveId:'p0'});
  assert.equal(f.calls.length,17);
});

test('existence preflight still discovers work in the final bounded queue',async()=>{
  const f=fixture({due:['p15']});
  assert.deepEqual((await f.gate()).periodIds,['p15']);
  assert.equal(f.calls.length,17);
});

for(const source of ['empty','receipt','retry'])test(`preflight retains ${source} intake discovery when no event queue is due`,async()=>{
  const f=fixture({receipt:source==='receipt',retry:source==='retry'});
  const result=await f.gate();
  assert.equal(result.hasWork,source!=='empty');
  assert.equal(result.inbox,source!=='empty');
  assert.equal(f.calls.length,source==='receipt'?19:20);
});

test('future retries and active leases do not wake preflight; exhausted leases still do',async()=>{
  for(const slot of [{...dueSlot,notBefore:2001},{...dueSlot,leaseUntil:2001},
    {...dueSlot,attempts:3,leaseUntil:2001}]) {
    const f=fixture({count:1,due:['p0'],slot});
    assert.equal((await f.gate()).hasWork,false);
    assert.equal(f.calls.length,5);
  }
  const exhausted=fixture({count:1,due:['p0'],slot:{...dueSlot,attempts:3,notBefore:99999}});
  assert.equal((await exhausted.gate()).hasWork,true);
  assert.equal(exhausted.calls.length,2);
});

test('disabled, cleaned, future and expired queue windows remain excluded',async()=>{
  const f=fixture({count:4,due:['p0','p1','p2','p3']});
  f.periods[0].enabled=false;
  f.periods[1].cleaned=true;
  f.periods[2].startsAt=2001;
  Object.assign(f.periods[3],{archived:true,endsAt:-8*86400000});
  assert.equal((await f.gate()).hasWork,false);
  assert.equal(f.calls.length,4);
});

test('empty catalog costs four discovery reads and errors never mean no work',async()=>{
  const f=fixture({count:0});
  assert.equal((await f.gate()).hasWork,false);
  assert.equal(f.calls.length,4);
  const error=Object.assign(Error('quota'),{status:429});
  await assert.rejects(checkEventWork({call:async()=>{throw error;}},{now:2000}),value=>value===error);
  await assert.rejects(checkEventWork({call:async route=>route===':runQuery'?null:null},{now:2000}),/Unexpected event inbox/);
});
