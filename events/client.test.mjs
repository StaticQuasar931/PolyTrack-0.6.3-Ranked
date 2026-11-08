import test from 'node:test';
import assert from 'node:assert/strict';
import {createNormalKodubErpDecorator} from './client.mjs';

const hash=n=>n.toString(16).padStart(64,'0'),accountId=hash(1),trackId=hash(2),replayHash=hash(3);
const period={id:'snapshot77_shape',kind:'kodub',trackId,startsAt:1000,endsAt:10000};
const row=()=>({accountId,trackId,timeMs:51459,replayHash,verified:true,runVerified:true});
const award=(extra={})=>({accountId,runId:hash(4),timeMs:51459,replayHash,rp:489,verified:true,runVerified:true,
  eventRpEligible:true,pending:false,verificationStatus:'verified',submittedAt:2000,...extra});
const board=(entries=[],extra={})=>({id:period.id,period,entries,complete:true,totalEntries:entries.length,...extra});
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{snapshot=board(),deferred=false,eventHost=false}={}){
  t.mock.method(Date,'now',()=>4000);
  const document={createElement:()=>({dataset:{},style:{},attributes:{},textContent:'',hidden:false,parent:null,
    get isConnected(){return !!this.parent?.isConnected;},setAttribute(key,value){this.attributes[key]=value;},
    remove(){if(this.parent)this.parent.children=this.parent.children.filter(value=>value!==this);this.parent=null;}})};
  const originalIcon={nativeIcon:true},state={isConnected:true,children:[originalIcon],prepend(node){node.parent=this;this.children.unshift(node);}};
  const name={textContent:'Racer'},time={textContent:'time-51459'},host={classList:{contains:()=>eventHost}};
  const normal=row(),button={ownerDocument:document,isConnected:true,dataset:{sqRacerAccountId:accountId,sqRacerReplayHash:replayHash},
    closest:()=>host,querySelector:selector=>selector==='.verified-state'?state:selector==='.name'?name:time};
  let staticReads=0,liveReads=0,epoch=77;const resolves=[];
  const bridge={normalEventSnapshotEpoch:()=>epoch,normalKodubPeriod:()=>period,currentTrackId:()=>trackId,
    accountId:()=>hash(99),formatTime:value=>'time-'+value,
    readStaticEventSnapshot:()=>{staticReads++;return deferred?new Promise(resolve=>resolves.push(resolve)):snapshot;},
    readSnapshot:()=>{liveReads++;assert.fail('ERP presentation must not fetch live event data');}};
  const decorator=createNormalKodubErpDecorator(bridge);
  return {button,normal,state,originalIcon,resolves,decorator,decorate:()=>decorator.decorate(button,normal,trackId),
    label:()=>state.children.find(value=>value!==originalIcon),counts:()=>({staticReads,liveReads}),nextEpoch:()=>{epoch++;}};
}

test('normal decorator shows known no-award distinctly without rewriting normal verification',async t=>{
  const f=fixture(t),before=structuredClone(f.normal);f.decorate();await settle();
  assert.equal(f.label().textContent,'No event result');assert.equal(f.label().hidden,false);
  assert.equal(f.label().dataset.status,'none');assert.equal(f.label().dataset.verified,'false');
  assert.equal(f.label().style.backgroundImage,undefined);assert(f.state.children.includes(f.originalIcon));
  assert.deepEqual(f.normal,before);f.decorate();await settle();assert.deepEqual(f.counts(),{staticReads:1,liveReads:0});
});

test('normal decorator displays the waiting Event PB time, not the ordinary PB time',async t=>{
  const pending={accountId,runId:hash(5),replayHash:hash(6),timeMs:51000,submittedAt:2100,pending:true,verified:false,
    eventRpEligible:false,verificationStatus:'waiting',source:'pending-event-playback'};
  const f=fixture(t,{snapshot:board([],{pendingPlaybacks:[pending]})});f.decorate();await settle();
  assert.equal(f.label().textContent,'Event PB \u00b7 ERP pending');assert.equal(f.label().dataset.verified,'false');
  assert.match(f.label().title,/time-51000/);assert.equal(f.label().style.backgroundImage,undefined);assert.equal(f.normal.timeMs,51459);
});

test('published separate ERP is compact and leaves the native verification icon alone',async t=>{
  const f=fixture(t,{snapshot:board([award({timeMs:52423,replayHash:hash(8),rp:465})])}),before=structuredClone(f.normal);
  f.decorate();await settle();assert.equal(f.label().textContent,'Event PB \u00b7 465 ERP');assert.match(f.label().title,/time-52423/);
  assert.equal(f.label().dataset.separate,'true');assert.equal(f.label().dataset.verified,'true');
  assert.equal(f.label().style.backgroundImage,undefined);assert.equal(f.state.children.length,2);
  assert.equal(f.state.children[1],f.originalIcon);assert.match(f.label().attributes['aria-label'],/^Verified published event award:/);
  assert.deepEqual(f.normal,before);assert.deepEqual(f.counts(),{staticReads:1,liveReads:0});
});

test('published zero is displayed, but malformed, incomplete or unavailable data stays unknown',async t=>{
  const zero=fixture(t,{snapshot:board([award({rp:0})])});zero.decorate();await settle();assert.equal(zero.label().textContent,'0 ERP');
  for(const snapshot of [null,board([],{complete:false}),board([],{totalEntries:undefined}),board([award({rp:undefined})]),board([award(),award()])]){
    const f=fixture(t,{snapshot});f.decorate();await settle();assert.equal(f.label().hidden,true);assert.equal(f.label().textContent,'');
    assert.equal(f.label().dataset.status,'unavailable');assert.deepEqual(f.counts(),{staticReads:1,liveReads:0});
  }
});

test('normal decorator captures row binding before asynchronous static read',async t=>{
  const f=fixture(t,{deferred:true});f.decorate();await settle();f.normal.replayHash=hash(9);
  f.resolves[0](board([award()]));await settle();assert.equal(f.label().textContent,'489 ERP');
  assert.equal(f.label().dataset.separate,'false');
});

test('snapshot replacement cannot paint a late award onto an old row binding',async t=>{
  const f=fixture(t,{deferred:true});f.decorate();await settle();const old=f.label();
  f.nextEpoch();f.decorator.invalidate();f.decorate();await settle();
  f.resolves[0](board([award()]));await settle();assert.equal(old.isConnected,false);assert.equal(f.label().hidden,true);
  f.resolves[1](board([]));await settle();assert.equal(f.label().textContent,'No event result');assert.deepEqual(f.counts(),{staticReads:2,liveReads:0});
});

test('normal decorator does not decorate event-owned leaderboard rows',async t=>{
  const f=fixture(t,{eventHost:true});f.decorate();await settle();assert.equal(f.label(),undefined);
  assert.deepEqual(f.counts(),{staticReads:0,liveReads:0});
});
