import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {deflateSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {preparePublishedEventGhost} from './public-replay.mjs';
import {installPlaybackWorkerCapture,createPlaybackWorkerBridge} from '../tools/playback-worker-bridge.mjs';
import {PLAYBACK_ENGINE_PIN as pin} from '../tools/playback-engine-pin.mjs';

const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
const start=source.indexOf('  async function playEvent(){'),end=source.indexOf('  const ownReceipts=',start);
assert.ok(start>=0&&end>start);
const code=source.slice(start,end);
const mainBytes=fs.readFileSync(new URL('../main.bundle.js',import.meta.url));
const workerBytes=fs.readFileSync(new URL('../simulation_worker.bundle.js',import.meta.url));
const main=mainBytes.toString(),native=vm.createContext({TextEncoder,TextDecoder,Uint8Array,Uint16Array,Int32Array,ArrayBuffer,DataView,atob,btoa,setTimeout,clearTimeout});
const factories=vm.runInContext('('+main.slice(main.indexOf('t={')+2,main.lastIndexOf('},n={};function i(e)')+1)+')',native),modules={};
function require(id){if(modules[id])return modules[id].exports;const module=modules[id]={exports:{}};factories[id](module,module.exports,require);return module.exports;}
require.d=(exports,names)=>{for(const key in names)Object.defineProperty(exports,key,{get:names[key]});};
require.o=(object,key)=>Object.hasOwn(object,key);require.r=exports=>Object.defineProperty(exports,'__esModule',{value:true});require.g=native;
const bytes=Buffer.alloc(15+5*50*3);let offset=0;
for(let channel=0;channel<5;channel++){bytes.writeUIntLE(50,offset,3);offset+=3;for(let i=0;i<50;i++){bytes.writeUIntLE(i?1000:channel,offset,3);offset+=3;}}
const replay=deflateSync(bytes).toString('base64url'),replayHash=createHash('sha256').update(replay).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};

async function fixture({indexed=true,gate,failed=false,missingBridge=false,cleanupAfterClick=false}={}){
  const period={id:'kodub-play-fixture',trackId:'b'.repeat(64)},session={periodId:period.id,trackId:period.trackId,accountId:'a'.repeat(64),endsAt:10000};
  const entry={accountId:'c'.repeat(64),runId:'d'.repeat(64),timeMs:270425,replayHash,name:'Pending racer',pending:true};
  const payload={...entry,periodId:period.id,trackId:period.trackId,frames:entry.timeMs,replay,carStyle:require(8724).A.default().serialize(),verified:false,eventRpEligible:false};
  const requests=[],messages=[],launches=[];let currentWorker,handshakes=0,clicks=0,account=session.accountId,active=session,refreshes=0;
  class Worker extends EventTarget{
    constructor(){super();this.sent=[];}
    postMessage(message){
      if(message.messageType==='polytrack-playback-capability-v1'){
        handshakes++;queueMicrotask(()=>this.dispatchEvent(new MessageEvent('message',{data:{...message,lookupVersion:pin.lookupVersion,lookupDigest:pin.lookupDigest}})));
      }
      this.sent.push(message);
    }
    terminate(){}
  }
  const scope={Worker,location:{origin:'https://offline.invalid'},document:{baseURI:'https://offline.invalid/',scripts:[{src:'https://offline.invalid/main.bundle.js?v=197'}]}};
  installPlaybackWorkerCapture(scope);
  const workerBridge=createPlaybackWorkerBridge({scope,timeoutMs:1000,serializeNative:value=>require(1754).A.deserialize(value).serialize(),fetchImpl:async url=>{
    assert.ok(url==='https://offline.invalid/main.bundle.js?v=197'||url==='https://offline.invalid/simulation_worker.bundle.js?v=197','only pinned engine assets may be read');
    requests.push(url);return new Response(url.includes('main.bundle')?mainBytes:workerBytes);
  }});
  currentWorker=new scope.Worker('simulation_worker.bundle.js');
  const engine=await workerBridge.prepareEventRecording(payload.replay,payload.frames);
  const cached=await preparePublishedEventGhost({require,row:payload,period,entry,viewer:session.accountId,playbackEngine:engine});
  assert.ok(cached.requiredPlaybackEngine);
  const ghost=indexed?cached:{...cached,requiredPlaybackEngine:undefined};
  currentWorker.terminate();currentWorker=new scope.Worker('simulation_worker.bundle.js');
  const selection={periodId:period.id,accountId:session.accountId,targetAccountId:entry.accountId,targetTimeMs:entry.timeMs,targetRunId:entry.runId,targetPending:true,targetReplayHash:entry.replayHash,ghost};
  const selectedGhosts=new Map([[entry.accountId,selection]]);
  let observed;const play={disabled:false,addEventListener:(_type,fn)=>{observed=fn;},removeEventListener:()=>{observed=null;},click(){clicks++;observed?.();if(indexed)currentWorker.postMessage({messageType:3,carRecording:ghost.recording.serialize()});if(cleanupAfterClick){root.isConnected=false;selectedGhosts.clear();context.replayRequest++;}}};
  const root={isConnected:true,__pt062EventWatch:{version:1,trackId:period.trackId},querySelector:()=>play};
  const view={root,period,page:0,onlyVerified:false};
  const context=vm.createContext({nativeView:view,sessions:{current:()=>active},now:()=>0,launching:false,nativePlayPermit:false,
    replayRequest:0,pendingGhosts:new Map(),selectedGhosts,knownPeriods:new Map([[period.id,period]]),eventDisplayRows:()=>({rows:[entry]}),
    document:{querySelector:()=>root},getOwnReplay:()=>null,raceGhosts:()=>({ownGhost:null,opponents:[ghost]}),
    getPlaybackWorkerBridge:()=>missingBridge?null:{prepareEventRecording:async(...args)=>{refreshes++;await gate?.promise;if(failed)throw Error('engine unavailable');return workerBridge.prepareEventRecording(...args);}},
    bridge:{accountId:()=>account,startEventRace:(_context,invoke,current)=>{assert.equal(current(),true);invoke();assert.equal(current(),true,'committed handoff survives native selection cleanup');launches.push(_context);},readReplay:()=>assert.fail('no replay read'),require:()=>require},
    message:value=>messages.push(value),fetch:()=>assert.fail('no cloud reads'),setTimeout,clearTimeout});
  const run=vm.runInContext(`(()=>{${code};return playEvent;})()`,context);
  return {run,context,root,entry,payload,selectedGhosts,requests,launches,messages,refreshes:()=>refreshes,handshakes:()=>handshakes,clicks:()=>clicks,
    change(kind){if(kind==='account')account='e'.repeat(64);if(kind==='session')active={...session};if(kind==='navigation')root.isConnected=false;if(kind==='selection'){selectedGhosts.clear();context.replayRequest++;}if(kind==='standings')entry.replayHash='0'.repeat(64);},
    close(){workerBridge.dispose();currentWorker.terminate();}};
}

test('cached indexed Play reattests a replacement worker before native dispatch without replay or Firebase reads',async()=>{
  const f=await fixture();try{await f.run();assert.equal(f.launches.length,1);assert.equal(f.refreshes(),1);assert.equal(f.handshakes(),2);assert.equal(f.requests.length,2);assert.equal(f.selectedGhosts.size,1);assert.equal(f.payload.pending,true);assert.equal(f.payload.verified,false);assert.equal(f.payload.eventRpEligible,false);}finally{f.close();}
});

for(const kind of ['account','session','navigation','selection','standings'])test(`${kind} change during indexed Play preparation cancels before native click`,async()=>{
  const gate=deferred(),f=await fixture({gate});try{
    const pending=f.run();while(!f.refreshes())await new Promise(resolve=>setImmediate(resolve));
    f.change(kind);gate.resolve();await pending;
    assert.equal(f.launches.length,0);assert.equal(f.clicks(),0);assert.equal(f.context.launching,false);
    assert.equal(f.payload.verified,false);assert.equal(f.payload.eventRpEligible,false);
  }finally{gate.resolve();f.close();}
});

for(const option of ['failed','missingBridge'])test(`${option} indexed preparation leaves selections intact and never dispatches`,async()=>{
  const f=await fixture({[option]:true});try{
    const original=f.selectedGhosts.values().next().value;await f.run();
    assert.equal(f.launches.length,0);assert.equal(f.clicks(),0);assert.equal(f.selectedGhosts.values().next().value,original);
    assert.equal(f.context.launching,false);assert.match(f.messages.at(-1),/could not start safely/);
  }finally{f.close();}
});

test('legacy-bounded cached Play does not reattest or add asset reads',async()=>{
  const f=await fixture({indexed:false});try{
    const requests=f.requests.length,handshakes=f.handshakes();await f.run();
    assert.equal(f.launches.length,1);assert.equal(f.refreshes(),0);assert.equal(f.requests.length,requests);assert.equal(f.handshakes(),handshakes);
  }finally{f.close();}
});

test('repeated Play clicks during preparation share one handoff and warm assets',async()=>{
  const gate=deferred(),f=await fixture({gate});try{
    const pending=f.run();while(!f.refreshes())await new Promise(resolve=>setImmediate(resolve));
    await f.run();assert.equal(f.refreshes(),1);gate.resolve();await pending;
    assert.equal(f.launches.length,1);assert.equal(f.clicks(),1);assert.equal(f.requests.length,2);
    await f.run();assert.equal(f.launches.length,2);assert.equal(f.requests.length,2);assert.equal(f.handshakes(),2);
  }finally{gate.resolve();f.close();}
});

test('committed indexed Play survives native panel and selection cleanup after dispatch',async()=>{
  const f=await fixture({cleanupAfterClick:true});try{await f.run();assert.equal(f.clicks(),1);assert.equal(f.launches.length,1);assert.equal(f.refreshes(),1);assert.equal(f.selectedGhosts.size,0);}finally{f.close();}
});
