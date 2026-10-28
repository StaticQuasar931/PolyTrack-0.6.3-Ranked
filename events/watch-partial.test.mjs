import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {preparePublishedEventGhost} from './public-replay.mjs';
import {prepareOwnEventGhost} from './native-replay.mjs';

const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
const code=source.slice(source.indexOf('  function watchEvent(){'),source.indexOf('  async function playEvent('));
const main=fs.readFileSync(new URL('../main.bundle.js',import.meta.url),'utf8');
const nativeContext=vm.createContext({TextEncoder,TextDecoder,Uint8Array,Uint16Array,Int32Array,ArrayBuffer,DataView,atob,btoa,setTimeout,clearTimeout});
const factories=vm.runInContext('('+main.slice(main.indexOf('t={')+2,main.lastIndexOf('},n={};function i(e)')+1)+')',nativeContext),modules={};
function require(id){if(modules[id])return modules[id].exports;const module=modules[id]={exports:{}};factories[id](module,module.exports,require);return module.exports;}
require.d=(exports,names)=>{for(const key in names)Object.defineProperty(exports,key,{get:names[key]});};
require.o=(object,key)=>Object.hasOwn(object,key);require.r=exports=>Object.defineProperty(exports,'__esModule',{value:true});require.g=nativeContext;
const recording=new (require(1754).A)();recording.recordFrame(0,{up:true,right:false,down:false,left:false,reset:false});
const replay=recording.serialize(),replayHash=createHash('sha256').update(replay).digest('hex'),carStyle=require(8724).A.default().serialize();
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture(options={}){
  const period={id:'daily-watch',trackId:'b'.repeat(64)},session={periodId:period.id,trackId:period.trackId,accountId:'a'.repeat(64),...(options.archive?{archive:true}:{})};
  let account=session.accountId,active=session,own=null,reads=0,prepares=0;
  const rows=Array.from({length:options.count??3},(_,i)=>({accountId:String(i+1).repeat(64),timeMs:1000+i,runId:String(i+1).repeat(64),replayHash,name:'Racer '+(i+1)}));
  const payloads=rows.map(row=>({...row,periodId:period.id,trackId:period.trackId,frames:row.timeMs,replay,carStyle}));
  options.edit?.(payloads);
  const selectedGhosts=new Map(rows.map(row=>[row.accountId,{periodId:period.id,accountId:session.accountId,targetAccountId:row.accountId,targetTimeMs:row.timeMs,targetRunId:row.runId,targetPending:false,targetReplayHash:row.replayHash,ghost:{nickname:'Old parsed ghost',poison:true}}]));
  const opened=[],messages=[],prompts=[],bestRecords={};
  const root={isConnected:true,querySelector:()=>({}),__pt062EventWatch:{version:1,trackId:period.trackId,open:ghosts=>{if(options.nativeError)throw Error('native unavailable');opened.push(ghosts);}}};
  const view={root,period,periodId:period.id,page:0,onlyVerified:false};
  const read=async(_period,id)=>{reads++;await options.readGate?.promise;return payloads.find(row=>row?.accountId===id)||null;};
  if(options.own){own={...session,attemptId:'local',timeMs:1100,frames:1100,replay:options.badOwn?'AAAA':replay,carStyle,source:'local-event-recording'};bestRecords[period.id+'_'+session.accountId]={attemptId:'local',timeMs:1100};}
  const context=vm.createContext({nativeView:view,knownPeriods:new Map([[period.id,period]]),replayRequest:0,selectedGhosts,selectedGhost:null,pendingGhosts:new Map(),replayCache:new Map(),bestRecords,
    document:{querySelector:()=>root},sessions:{current:()=>options.archive?null:active},archiveIntent:options.archive?session:null,
    bridge:{accountId:()=>account,require:()=>require,supportsEventGhost:()=>true,readReplay:options.archive?()=>{throw Error('No live archive fallback');}:read,readArchivedReplay:read,watchEvent:(_session,ghosts)=>{if(options.archive)throw Error('No live archive Watch');root.__pt062EventWatch.open(ghosts);}},
    eventDisplayRows:()=>({rows}),archivePeriodCounts:()=>({verifiedEntries:rows}),getOwnReplay:()=>own,
    replayContextActive:value=>value===active&&account===session.accountId,
    prepareOwnEventGhost,preparePublishedEventGhost:async input=>{prepares++;if(options.engineFailed?.())throw Error('Playback engine unavailable');return preparePublishedEventGhost(input);},
    confirmPartialReplaySelection:async data=>{prompts.push(data);return options.confirm?options.confirm(data):true;},message:text=>messages.push(text)
  });
  const watch=vm.runInContext(`(()=>{${code};return watchEvent;})()`,context);
  return {watch,rows,payloads,selectedGhosts,opened,messages,prompts,root,view,bestRecords,context,reads:()=>reads,prepares:()=>prepares,change:kind=>{
    if(kind==='account')account='c'.repeat(64);else if(kind==='session')active={...session};else if(kind==='navigation')root.isConnected=false;else if(kind==='standings')rows[0].replayHash='0'.repeat(64);else if(kind==='selection')context.replayRequest++;else if(kind==='page')view.page++;else if(kind==='filter')view.onlyVerified=true;else if(kind==='own')own={...own,attemptId:'new'};
  }};
}

for(const archive of [false,true])test(`${archive?'archived':'live'} Watch validates native bytes and skips only after explicit consent`,async()=>{
  const answer=deferred(),f=fixture({archive,edit:rows=>{rows[1].carStyle='AAAA';},confirm:()=>answer.promise});
  const pending=f.watch();while(!f.prompts.length)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.selectedGhosts.size,3);assert.equal(f.opened.length,0);assert.equal(f.prompts[0].mode,'watch');
  assert.equal(f.prompts[0].failed[0].row.accountId,'2'.repeat(64));
  answer.resolve(true);await pending;
  assert.deepEqual([...f.selectedGhosts.keys()],['1'.repeat(64),'3'.repeat(64)]);assert.equal(f.opened.length,1);
  assert.deepEqual(Array.from(f.opened[0],ghost=>[ghost.nickname,ghost.time.numberOfFrames,ghost.isSelf]),[['Racer 1',1000,false],['Racer 3',1002,false]]);
  assert.ok(f.opened[0].every(ghost=>ghost.recording instanceof require(1754).A));assert.equal(f.prepares(),5);assert.equal(f.reads(),3);
});

for(const consent of [false,undefined,'yes'])test(`Watch cancellation (${String(consent)}) does not mutate selection`,async()=>{
  const f=fixture({edit:rows=>{rows[1].replay='AAAA';},confirm:()=>consent});await f.watch();assert.equal(f.selectedGhosts.size,3);assert.equal(f.opened.length,0);
});
test('Watch does not truncate more than two valid replays or offer an all-failed launch',async()=>{
  for(const allFailed of [false,true]){
    const f=fixture({edit:rows=>{if(allFailed)for(const row of rows)row.carStyle='AAAA';}});await f.watch();
    assert.equal(f.opened.length,0);assert.equal(f.selectedGhosts.size,3);assert.equal(f.prompts.length,0);
    assert.match(f.messages.at(-1),allFailed?/No selected replay/:/Watch supports 2/);
  }
});
test('Watch never plays a mismatched identity, run, time, track, hash or stale selection binding',async()=>{
  for(const edit of [{accountId:'c'.repeat(64)},{runId:'c'.repeat(64)},{timeMs:999},{trackId:'c'.repeat(64)},{replayHash:'0'.repeat(64)}]){
    const f=fixture({count:2,edit:rows=>Object.assign(rows[1],edit)});await f.watch();
    assert.equal(f.prompts.length,1);assert.equal(f.opened[0].length,1);assert.equal(f.opened[0][0].nickname,'Racer 1');
  }
  const f=fixture({count:2});f.rows[1].timeMs=9;await f.watch();assert.equal(f.opened[0].length,1);assert.equal(f.selectedGhosts.size,1);
});
for(const stage of ['read','consent'])for(const kind of ['account','session','navigation','standings','selection','page','filter'])test(`${kind} change during Watch ${stage} cancels without changing selection`,async()=>{
  const gate=deferred(),f=fixture({readGate:stage==='read'?gate:null,edit:rows=>{rows[1].carStyle='AAAA';},confirm:()=>gate.promise});
  const pending=f.watch();while(stage==='read'?!f.reads():!f.prompts.length)await new Promise(resolve=>setImmediate(resolve));
  f.change(kind);gate.resolve(true);await pending;assert.equal(f.opened.length,0);assert.equal(f.selectedGhosts.size,3);
});
test('engine failure after consent and failed native handoff preserve the original selection',async()=>{
  let failed=false;
  const f=fixture({edit:rows=>{rows[1].carStyle='AAAA';},engineFailed:()=>failed,confirm:()=>{failed=true;return true;}});
  await f.watch();assert.equal(f.opened.length,0);assert.equal(f.selectedGhosts.size,3);
  const native=fixture({nativeError:true,edit:rows=>{rows[1].carStyle='AAAA';}});await native.watch();assert.equal(native.selectedGhosts.size,3);
});
test('local own PB failure requires consent without deleting the PB or receipts',async()=>{
  const f=fixture({count:1,own:true,badOwn:true});const before=JSON.stringify(f.bestRecords);await f.watch();
  assert.equal(f.prompts.length,1);assert.equal(f.opened[0].length,1);assert.equal(JSON.stringify(f.bestRecords),before);assert.equal(f.selectedGhosts.size,1);
});
test('repeated Watch clicks share one validation and one native handoff',async()=>{
  const gate=deferred(),f=fixture({count:2,readGate:gate});const first=f.watch(),second=f.watch();assert.equal(first,second);
  gate.resolve();await first;assert.equal(f.reads(),2);assert.equal(f.opened.length,1);assert.equal(f.selectedGhosts.size,2);assert.equal(f.prompts.length,0);
});
