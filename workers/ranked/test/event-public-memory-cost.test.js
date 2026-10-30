import test from 'node:test';
import assert from 'node:assert/strict';
import {eventWorkerHandler} from '../src/events-worker.js';
import {createPublicReadMemory} from '../src/public-read-memory.js';
import {eventEncode} from '../src/events-store.js';

const origin='https://polytrack.test';
function fixture(){
  let at=Date.parse('2026-10-21T00:00:00Z'),reads=0,version=1;
  let begins=0,rollbacks=0,commits=0,active=false;
  const env={EVENTS_ENABLED:'true',EVENT_RATE_LIMITER:{limit:async()=>({success:true})}};
  const handler=eventWorkerHandler(env,{origins:new Set([origin]),now:()=>at,authenticate:async()=>null,
    request:async(path,init)=>{
      if(path===':beginTransaction'){
        assert.equal(active,false,'previous read-only transaction must be closed');
        assert.deepEqual(JSON.parse(init.body),{options:{readWrite:{}}});
        active=true;begins++;return {transaction:'test'};
      }
      if(path===':rollback'){
        assert.equal(active,true);assert.deepEqual(JSON.parse(init.body),{transaction:'test'});
        active=false;rollbacks++;return {};
      }
      if(path===':commit'){commits++;assert.fail('read-only public totals must never send a commit');}
      assert.equal(active,true,'source reads must remain inside the transaction');
      assert.ok(path.startsWith('/0.6.2_event_public/totals_full?transaction='));reads++;
      return {fields:eventEncode({entries:[],version,totalEntries:0,complete:true,dynamicComponents:{permanentRollingHills:{status:'current'}}}).mapValue.fields};
    }});
  return {reads:()=>reads,version:v=>{version=v;},setTime:v=>{at=v;},advance:ms=>{at+=ms;},
    cleanup:()=>({begins,rollbacks,commits,active}),
    get:()=>handler(new Request('https://worker.test/v1/events/totals',{headers:{Origin:origin,'CF-Connecting-IP':'127.0.0.1'}}))};
}

test('24h event fallback workload: absent edge cache, 30s refreshes cost 720 instead of 2880 document reads',async()=>{
  const f=fixture();
  for(let i=0;i<2880;i++){const r=await f.get();assert.equal(r.status,200);f.advance(30000);}
  assert.equal(f.reads(),720);
  assert.deepEqual(f.cleanup(),{begins:720,rollbacks:720,commits:0,active:false});
});

test('event memory retains exact original 120s expiry and refreshes changed totals; no cached-hit TTL renewal',async()=>{
  const f=fixture();assert.equal((await (await f.get()).json()).version,1);
  f.version(2);f.advance(119999);assert.equal((await (await f.get()).json()).version,1);
  f.advance(1);assert.equal((await (await f.get()).json()).version,2);assert.equal(f.reads(),2);
  assert.deepEqual(f.cleanup(),{begins:2,rollbacks:2,commits:0,active:false});
});

test('event cache match/put faults are optional, not reasons to reread source or fail successful totals',async t=>{
  const original=Object.getOwnPropertyDescriptor(globalThis,'caches');
  Object.defineProperty(globalThis,'caches',{configurable:true,value:{default:{match:async()=>{throw Error('cache offline');},put:async()=>{throw Error('cache offline');}}}});
  t.after(()=>{if(original)Object.defineProperty(globalThis,'caches',original);else delete globalThis.caches;});
  const f=fixture();for(let i=0;i<10;i++)assert.equal((await f.get()).status,200);
  assert.equal(f.reads(),1);
  assert.deepEqual(f.cleanup(),{begins:1,rollbacks:1,commits:0,active:false});
});

test('public memory bounds bytes/count, scopes keys, and rejects clock reversal/expired data',()=>{
  const m=createPublicReadMemory({maxEntries:2,maxBytes:8});
  assert.equal(m.put('a','aaaa',60,100),true);m.put('b','bbbb',60,100);m.put('c','cccc',60,100);
  assert.equal(m.get('a',100),undefined);assert.equal(m.get('b',100),'bbbb');
  m.put('d','123456789',60,100);assert.equal(m.get('c',100),'cccc');
  assert.equal(m.get('b',99),undefined);assert.equal(m.get('c',60100),undefined);
  assert.equal(m.get('another-project',100),undefined);
});
