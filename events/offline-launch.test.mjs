import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createEventSession, keepEventBest, matchingEventRuns} from './session.mjs';

const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
function section(start,end){
  const offset=source.indexOf(start),limit=source.indexOf(end,offset);
  assert(offset>=0&&limit>offset);
  return source.slice(offset,limit);
}
const launch=section('  async function race(period,','  async function openEvent(');
const upload=section('  async function flush(){','  function captured(run)');
const finish=section('  function captured(run){','  function ensureCapture(){');
const account='a'.repeat(64),other='b'.repeat(64),track='c'.repeat(64);
const start=Date.UTC(2026,9,27);
const period={id:'offline-daily',kind:'daily',trackId:track,startsAt:start-1000,endsAt:start+3600000};
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
function fixture({online=false,ready=async()=>{throw Error('Firebase unavailable');}}={}){
  const storage=new Map(),messages=[],opens=[],refreshes=[],writes=[],submitted=[];
  let cloudReady=false;
  const ctx={Promise,Error,Array,Map,JSON,crypto,at:start,account,entryRequest:0,requestId:0,
    archiveIntent:null,eventIntent:null,nativeOpenPermit:false,dialog:null,selected:null,
    captureCalls:0,readyCalls:0,hasPending:false,flushing:false,retryAt:0,
    latestFinish:null,bestRecords:{},catalog:{periods:[period]},knownPeriods:new Map(),
    QUEUE:'queue',BEST:'best',REPLAYS:'replays',cache:new Map(),navigator:{onLine:online},
    keepEventBest,matchingEventRuns,
    now:()=>ctx.at,
    read:(key,fallback)=>storage.has(key)?structuredClone(storage.get(key)):fallback,
    write:(key,value)=>{writes.push(key);storage.set(key,structuredClone(value));},
    cacheWrite:(key,value)=>{writes.push(key);storage.set(key,structuredClone(value));},
    message:text=>messages.push(text),body:()=>{},shell:()=>{ctx.dialog={};},
    close:()=>{ctx.entryRequest++;ctx.dialog=null;ctx.selected=null;},
    tick:()=>{},invalidateReceipt:()=>{},ensureCapture:()=>{ctx.captureCalls++;},
    refreshNativeEventData:async(p,s)=>{refreshes.push({period:p,session:s});},
    bridge:{accountId:()=>ctx.account,
      ready:()=>{ctx.readyCalls++;return ready();},
      openTrack:id=>{opens.push(id);return true;},
      submit:async run=>{
        if(!cloudReady)throw Error('Firebase unavailable');
        assert.equal(run.accountId,ctx.account,'queued runs must retain account ownership');
        submitted.push(run);
      }}
  };
  ctx.sessions=createEventSession({now:()=>ctx.at});
  vm.createContext(ctx);vm.runInContext(upload+finish+launch,ctx);
  return {ctx,storage,messages,opens,refreshes,writes,submitted,
    launch:p=>ctx.race(p||period,{direct:true}),
    cancel:()=>{ctx.entryRequest++;ctx.sessions.leave();ctx.eventIntent=null;ctx.dialog=null;},
    cloudReady:()=>{cloudReady=true;ctx.navigator.onLine=true;},
    finish:()=>{
      const context={trackId:track,accountId:account,raceId:'local-race'};
      assert.equal(ctx.sessions.bind(context),true);
      ctx.captured({...context,timeMs:12345,replay:'local-recording',frames:12345});
    }};
}

for(const readiness of ['reject','pending'])test(`offline local launch does not await ${readiness} Firebase readiness`,async()=>{
  const f=fixture({ready:readiness==='reject'?async()=>{throw Error('Firebase unavailable');}:()=>new Promise(()=>{})});
  assert.equal(await f.launch(),true);
  assert.deepEqual(f.opens,[track]);
  assert.equal(f.ctx.readyCalls,0);
  assert.equal(f.ctx.sessions.current().accountId,account);
  assert.equal(f.ctx.nativeOpenPermit,false);
});

test('local finish stays durable offline and submits later after cloud recovery',async()=>{
  const f=fixture();
  assert.equal(await f.launch(),true);f.finish();
  const queued=f.storage.get('queue');
  assert.equal(queued.length,1);
  assert.equal(queued[0].accountId,account);
  assert.equal(queued[0].periodId,period.id);
  assert.deepEqual(f.writes.slice(0,3),['queue','best','replays'],'finish persistence stays synchronous');
  await f.ctx.flush();assert.equal(f.submitted.length,0);
  f.ctx.navigator.onLine=true;await f.ctx.flush();
  assert.equal(f.storage.get('queue').length,1,'Firebase failure must retain the run');
  f.cloudReady();f.ctx.at+=60000;await f.ctx.flush();
  assert.equal(f.submitted.length,1);
  assert.equal(f.storage.get('queue').length,0);
});

test('account switch during local preparation cancels before capture or track opening',async()=>{
  const f=fixture(),pending=f.launch();f.ctx.account=other;
  assert.equal(await pending,false);
  assert.equal(f.ctx.captureCalls,0);assert.equal(f.opens.length,0);
  assert.equal(f.ctx.sessions.current(),null);
});

test('closing preparation cancels without Firebase, capture, or late launch',async()=>{
  const f=fixture(),pending=f.launch();f.cancel();
  assert.equal(await pending,false);
  assert.equal(f.ctx.captureCalls,0);assert.equal(f.opens.length,0);
  assert.equal(f.ctx.readyCalls,0);assert.equal(f.ctx.sessions.current(),null);
});

test('account change caused by capture initialization cannot enter the new account',async()=>{
  const f=fixture();f.ctx.ensureCapture=()=>{f.ctx.account=other;};
  assert.equal(await f.launch(),false);assert.equal(f.opens.length,0);
  assert.equal(f.ctx.sessions.current(),null);
});

for(const change of ['cancel','account'])test(`${change} while native opening is pending cannot revive event intent`,async()=>{
  const f=fixture(),gate=deferred(),opening=deferred();f.ctx.bridge.openTrack=()=>{opening.resolve();return gate.promise;};
  const pending=f.launch();await opening.promise;
  if(change==='cancel')f.cancel();else f.ctx.account=other;
  gate.resolve(true);
  assert.equal(await pending,false);assert.equal(f.ctx.sessions.current(),null);
  assert.equal(f.ctx.eventIntent,null);assert.equal(f.ctx.nativeOpenPermit,false);
  assert.equal(f.refreshes.length,0);
});

for(const outcome of ['reject','false'])test(`native opening ${outcome} clears its own intent without changing saved records`,async()=>{
  const f=fixture();f.storage.set('queue',[{attemptId:'retained'}]);
  f.ctx.bridge.openTrack=outcome==='false'?()=>false:async()=>{throw Error('Native opening failed');};
  assert.equal(await f.launch(),false);
  assert.equal(f.ctx.sessions.current(),null);assert.equal(f.ctx.eventIntent,null);
  assert.equal(f.ctx.nativeOpenPermit,false);
  assert.deepEqual(f.storage.get('queue'),[{attemptId:'retained'}]);
});

for(const outcome of ['resolve','reject'])test(`stale native ${outcome} cannot clear a newer same-period session`,async()=>{
  const f=fixture(),gate=deferred(),opening=deferred();f.ctx.bridge.openTrack=()=>{opening.resolve();return gate.promise;};
  const old=f.launch();await opening.promise;
  f.ctx.bridge.openTrack=()=>true;
  assert.equal(await f.launch(),true);
  const current=f.ctx.sessions.current();
  if(outcome==='resolve')gate.resolve(true);else gate.reject(Error('Stale failure'));
  assert.equal(await old,false);assert.equal(f.ctx.sessions.current(),current);
  assert.equal(f.ctx.eventIntent,current);
});

for(const override of [{startsAt:start+1},{endsAt:start},{trackId:'invalid'}])
test(`offline launch retains session eligibility checks: ${JSON.stringify(override)}`,async()=>{
  const f=fixture();assert.equal(await f.launch({...period,...override}),false);
  assert.equal(f.opens.length,0);assert.equal(f.ctx.sessions.current(),null);
});

test('invalid local account cannot launch, and switched accounts cannot upload queued runs',async()=>{
  const f=fixture();f.ctx.account='';assert.equal(await f.launch(),false);assert.equal(f.opens.length,0);
  f.ctx.account=account;assert.equal(await f.launch(),true);f.finish();
  f.cloudReady();f.ctx.account=other;await f.ctx.flush();
  assert.equal(f.submitted.length,0);assert.equal(f.storage.get('queue').length,1);
});
