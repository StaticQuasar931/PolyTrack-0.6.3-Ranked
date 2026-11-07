import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {createEventSubmissionRetry,sameEventSubmission} from './client.mjs';

const source=readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
const start=source.indexOf('  async function flush(){'),end=source.indexOf('  function captured(',start);
assert.ok(start>=0&&end>start);
const clone=value=>value==null?value:JSON.parse(JSON.stringify(value));
const run=(extra={})=>({accountId:'self',periodId:'weekly',attemptId:'one',timeMs:20000,frames:20000,replay:'saved-replay',endsAt:1e12,...extra});
function fixture({disk=new Map(),clock={at:1000000},queue,submit=async()=>{throw Error('network unavailable');},random=()=>0,locks}={}){
  if(queue!==undefined)disk.set('queue',clone(queue));
  let calls=0,ledgerWrites=0,accountId='self',failSave=false;
  const context={hasPending:!!disk.get('queue')?.length,flushing:false,now:()=>clock.at,QUEUE:'queue',STORE:'events',
    read:(key,fallback)=>clone(disk.has(key)?disk.get(key):fallback),write:(key,value)=>disk.set(key,clone(value)),
    message:()=>{},cache:new Map(),invalidateReceipt:()=>{},sameEventSubmission,
    navigator:{onLine:true,...(locks?{locks}:{})},bridge:{accountId:()=>accountId,submit:async value=>{calls++;return submit(value);}}};
  context.submissionRetry=createEventSubmissionRetry({now:()=>clock.at,random,load:()=>clone(disk.get('retry')),
    save:value=>{ledgerWrites++;if(failSave)throw Error('storage full');disk.set('retry',clone(value));return true;}});
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);
  return {context,disk,clock,flush:()=>context.flush(),advance:ms=>{clock.at+=ms;},get calls(){return calls;},get ledgerWrites(){return ledgerWrites;},
    get queue(){return clone(disk.get('queue'));},ledger:()=>clone(disk.get('retry')),
    setQueue:value=>{disk.set('queue',clone(value));context.hasPending=!!value.length;},setAccount:value=>{accountId=value;},failSave:value=>{failSave=value;}};
}

test('unchanged pending upload costs four attempts in its first hour, not sixty',async()=>{
  const f=fixture({queue:[run()]});
  for(let i=0;i<240;i++){await f.flush();f.advance(15000);}
  assert.equal(f.calls,4);assert.equal(f.queue.length,1);
  assert.equal(f.ledger().accounts.self.failures,4);
});
test('reloading and online/storage/menu flushes cannot reset persisted cooldown',async()=>{
  const disk=new Map(),clock={at:1000000};let calls=0;
  for(let i=0;i<240;i++){
    const f=fixture({disk,clock,...(i===0?{queue:[run()]}:{})});await f.flush();calls+=f.calls;clock.at+=15000;
  }
  assert.equal(calls,4);assert.equal(disk.get('queue')[0].replay,'saved-replay');
});
test('quota and auth errors defer repeated flushes without dropping the PB',async()=>{
  for(const [code,floor] of [['resource-exhausted',3600000],['local-quota-cooldown',3600000],['unauthenticated',900000],['auth/user-token-expired',900000],['permission-denied',900000]]){
    const f=fixture({queue:[run()],submit:async()=>{throw Object.assign(Error(code),{code});}});
    await f.flush();assert.equal(f.ledger().accounts.self.nextAt,f.clock.at+floor);
    for(let i=0;i<50;i++)await f.flush();f.advance(floor-1);await f.flush();assert.equal(f.calls,1,code);
    assert.deepEqual(f.queue,[run()]);
  }
});
test('quota gate covers account changes while auth cooldown remains per account',async()=>{
  for(const code of ['resource-exhausted','unauthenticated']){
    const f=fixture({queue:[run()],submit:async()=>{throw Object.assign(Error(code),{code});}});await f.flush();
    f.setAccount('other');f.setQueue([run({accountId:'other',attemptId:'other'})]);await f.flush();
    assert.equal(f.calls,code==='resource-exhausted'?1:2);
  }
});
test('offline events do not attempt network or mutate retry history; reconnect coalesces',async()=>{
  const f=fixture({queue:[run()]});f.context.navigator.onLine=false;
  for(let i=0;i<100;i++)await f.flush();assert.equal(f.calls,0);assert.equal(f.ledgerWrites,0);
  f.context.navigator.onLine=true;await Promise.all(Array.from({length:50},()=>f.flush()));assert.equal(f.calls,1);
});
test('new faster PB retains exact bytes and inherits outage cooldown, not the old attempt',async()=>{
  const f=fixture({queue:[run()]});await f.flush();
  const faster=run({attemptId:'faster',timeMs:19000,frames:19000,replay:'new-exact-bytes'});f.setQueue([faster]);
  for(let i=0;i<20;i++)await f.flush();assert.equal(f.calls,1);assert.deepEqual(f.queue,[faster]);
  f.advance(60000);await f.flush();assert.equal(f.calls,2);
  assert.equal(f.ledger().accounts.self.failures,2);assert.equal(f.ledger().accounts.self.nextAt,f.clock.at+300000);
  assert.equal(Object.keys(f.ledger().attempts).length,1,'superseded attempt retry state is pruned');
});
test('older in-flight acknowledgement removes only itself and retains a newer faster PB',async()=>{
  let resolve;const f=fixture({queue:[run()],submit:()=>new Promise(done=>{resolve=done;})});
  const pending=f.flush();await Promise.resolve();
  const faster=run({attemptId:'faster',timeMs:19000,frames:19000,replay:'faster-bytes'});f.setQueue([faster]);
  resolve({status:'waiting'});await pending;assert.deepEqual(f.queue,[faster]);
  assert.equal(f.context.hasPending,true);assert.equal(f.ledger().accounts.self,undefined);
});
test('failure of an older in-flight attempt defers but never overwrites a newer PB',async()=>{
  let reject;const f=fixture({queue:[run()],submit:()=>new Promise((_,fail)=>{reject=fail;})});
  const pending=f.flush();await Promise.resolve();const faster=run({attemptId:'faster',timeMs:19000,replay:'new'});f.setQueue([faster]);
  reject(Error('offline'));await pending;await f.flush();assert.equal(f.calls,1);assert.deepEqual(f.queue,[faster]);
});
test('successful acknowledgement removes queue normally and never retries verification',async()=>{
  const f=fixture({queue:[run()],submit:async()=>({status:'waiting'})});await f.flush();
  assert.deepEqual(f.queue,[]);assert.equal(f.context.hasPending,false);
  const writes=f.ledgerWrites;for(let i=0;i<100;i++){f.advance(3600000);await f.flush();}
  assert.equal(f.calls,1);assert.equal(f.ledgerWrites,writes);
});
test('foreign-account entries do not block own uploads, and stale snapshot entries are skipped',async()=>{
  const other=run({accountId:'other'}),second=run({periodId:'daily',attemptId:'second'});
  const f=fixture({queue:[other,run(),second],submit:async value=>{
    if(value.attemptId==='one')f.setQueue([other,run({periodId:'daily',attemptId:'faster',timeMs:18000})]);return {status:'waiting'};
  }});await f.flush();assert.equal(f.calls,1);assert.deepEqual(f.queue.map(row=>row.attemptId),['one','faster']);
});
test('account change during an upload stops subsequent old-session work',async()=>{
  const f=fixture({queue:[run(),run({periodId:'daily',attemptId:'second'})],submit:async()=>{f.setAccount('other');return {status:'waiting'};}});
  await f.flush();assert.equal(f.calls,1);assert.equal(f.queue[0].attemptId,'second');
});
test('expired pending run is removed without network even during account backoff',async()=>{
  const f=fixture({queue:[run({endsAt:1060000})]});await f.flush();f.advance(60000);await f.flush();
  assert.equal(f.calls,1);assert.deepEqual(f.queue,[]);
});
test('unavailable durable retry storage fails closed before network',async()=>{
  const f=fixture({queue:[run()]});f.failSave(true);for(let i=0;i<20;i++)await f.flush();
  assert.equal(f.calls,0);assert.deepEqual(f.queue,[run()]);f.failSave(false);await f.flush();assert.equal(f.calls,1);
});
test('preflight lease survives reload during an unacknowledged in-flight request',async()=>{
  const disk=new Map(),clock={at:1000000};let resolve;
  const first=fixture({disk,clock,queue:[run()],submit:()=>new Promise(done=>{resolve=done;})});const pending=first.flush();
  await Promise.resolve();const next=fixture({disk,clock});await next.flush();assert.equal(next.calls,0);
  resolve({status:'waiting'});await pending;assert.deepEqual(first.queue,[]);
});
test('a busy cross-tab Web Lock does not perform I/O; a free lock drains normally',async()=>{
  let available=false;const locks={request:async(_name,options,callback)=>{assert.equal(options.ifAvailable,true);return callback(available?{}:null);}};
  const f=fixture({queue:[run()],locks,submit:async()=>({status:'waiting'})});await f.flush();assert.equal(f.calls,0);
  available=true;await f.flush();assert.equal(f.calls,1);assert.deepEqual(f.queue,[]);
});
test('retry delay jitter is bounded and backoff state does not hold replay data',async()=>{
  const f=fixture({queue:[run()],random:()=>1});await f.flush();assert.equal(f.ledger().accounts.self.nextAt,f.clock.at+72000);
  assert.doesNotMatch(JSON.stringify(f.ledger()),/saved-replay/);
});

test('one day of long-pending unacknowledged weekly work is bounded to 27 attempts without jitter',async()=>{
  const f=fixture({queue:[run()]});
  for(let i=0;i<24*240;i++){await f.flush();f.advance(15000);}
  assert.equal(f.calls,27);assert.equal(f.queue.length,1);
});
test('old acknowledgement cannot clear a newer attempt cooldown in a concurrent fallback tab',async()=>{
  const disk=new Map(),clock={at:1000000};let resolve;
  const old=fixture({disk,clock,queue:[run()],submit:()=>new Promise(done=>{resolve=done;})});const pending=old.flush();
  await Promise.resolve();clock.at+=60000;
  const faster=run({attemptId:'newer',timeMs:19000,replay:'newer-bytes'});
  const newer=fixture({disk,clock,queue:[faster]});await newer.flush();const cooldown=newer.ledger().accounts.self.nextAt;
  resolve({status:'waiting'});await pending;
  assert.deepEqual(old.queue,[faster]);assert.equal(old.ledger().accounts.self.nextAt,cooldown);
  await newer.flush();assert.equal(newer.calls,1);
});
test('failed retry-ledger cleanup after durable acknowledgement never reuploads the accepted attempt',async()=>{
  const f=fixture({queue:[run()],submit:async()=>{f.failSave(true);return {status:'waiting'};}});
  await f.flush();assert.deepEqual(f.queue,[]);f.advance(86400000);await f.flush();assert.equal(f.calls,1);
});
