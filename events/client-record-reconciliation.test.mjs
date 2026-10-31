import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash} from 'node:crypto';
import {Socket} from 'node:net';
import {eventVerifiedPendingMatch,eventLocalReplayBinding,eventPublishedPbCoversReceipt,eventSnapshotFields,
  eventSnapshotRows,eventOwnPlacementPresentation} from './client.mjs';

globalThis.fetch=()=>{throw Error('No network in event record reconciliation tests');};
Socket.prototype.connect=globalThis.fetch;
const hash=n=>n.toString(16).padStart(64,'0');
const period={id:'weekly-fixture',kind:'weekly',trackId:hash(9999),entrantLimit:200};
const row=n=>({accountId:hash(n),timeMs:20000+n*100,rank:n,replayHash:hash(10000+n),runId:hash(20000+n),
  name:'Racer '+n,rp:10,physicsVerified:true,replayIntegrityVerified:true});
const board=(count=200)=>({id:period.id,period,entries:Array.from({length:count},(_,i)=>row(i+1)),
  updatedAt:100,complete:true,sourceComplete:true,totalEntries:count,_publicBackup:true});
const waiting=entry=>({...entry,pending:true,verified:false,eventRpEligible:false,verificationStatus:'waiting',
  source:'pending-event-playback'});
const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
function section(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);}
function render(saved,{local=null,receipt=null,policy='all',enabled=true,filterRows}={}){
  const accountId=hash(4),context={cache:new Map([[period.id,saved]]),localBest:()=>local,
    ownReceipts:new Map(receipt?[[period.id+'_'+accountId,receipt]]:[]),
    bridge:{accountId:()=>accountId,snapshotOnly:()=>true,filterRows},
    eventSnapshotFields,eventOwnPlacementPresentation,readEventPlacementSettings:()=>({enabled,policy}),
    validEventTimestamp:()=>false,now:()=>Date.now(),displayName:r=>r.name||'You',time:String};
  return vm.runInNewContext(section('  function eventDisplayRows(', '  function syncNativeArchiveBoard(')+
    section('  function displayedRecordPlacement(', '  function cardStandings(')+
    ';({rows:()=>eventDisplayRows(period),markup:()=>recordMarkup(period)});',{...context,period});
}

test('weekly card reconciles the exact verified snapshot PB and displays native 4/200 box, never Pending',()=>{
  const saved=board(),own=saved.entries[3],local={...own,periodId:period.id,trackId:period.trackId,attemptId:'local'},
    receipt={...local,status:'waiting'},before=structuredClone({saved,local,receipt}),ui=render(saved,{local,receipt});
  assert.match(ui.markup(),/>4\/200</);assert.doesNotMatch(ui.markup(),/Pending|provisional/);
  assert.equal(ui.rows().rows.find(r=>r.accountId===own.accountId).pending,false);
  assert.equal(eventVerifiedPendingMatch(saved,waiting(local)),own);
  assert.equal(eventPublishedPbCoversReceipt(receipt,local,period,{board:saved,accountId:own.accountId}),true);
  assert.deepEqual({saved,local,receipt},before,'presentation never rewrites raw receipts, proof flags or local PB');
});

test('same-time different replay remains locally pending; verified-only keeps the authoritative published PB',()=>{
  const saved=board(),own=saved.entries[3],local={...own,replayHash:hash(55555),pending:true,verified:false};
  const ui=render(saved,{local});
  assert.equal(eventVerifiedPendingMatch(saved,local),null);
  assert.equal(ui.rows().rows.find(r=>r.accountId===own.accountId).pending,true);
  assert.match(ui.markup(),/>4\/200\*</);
  assert.equal(eventPublishedPbCoversReceipt(null,local,period,{board:saved,accountId:own.accountId}),false);
  assert.equal(eventSnapshotFields(saved,{local}).verified.rows.find(r=>r.accountId===own.accountId).replayHash,own.replayHash);
});

test('a genuinely faster local PB stays pending without borrowing slower snapshot proof or points',()=>{
  const saved=board(),own=saved.entries[3],local={...own,timeMs:own.timeMs-1,replayHash:hash(33333),pending:true,verified:false,rp:0};
  assert.equal(eventVerifiedPendingMatch(saved,local),null);
  const visible=render(saved,{local}).rows().rows.find(r=>r.accountId===own.accountId);
  assert.equal(visible.timeMs,local.timeMs);assert.equal(visible.pending,true);assert.equal(visible.rp,0);
  assert.equal(eventPublishedPbCoversReceipt(null,local,period,{board:saved,accountId:own.accountId}),false);
});

test('period, track, account, run identity and explicit holds cannot reconcile from time alone',()=>{
  const saved=board(),own=saved.entries[3];
  for(const extra of [{trackId:hash(12345)},{periodId:'another'},{accountId:hash(44444)},{runId:hash(44444)},
    {replayHash:undefined},{replayHash:hash(44444)},{needsReview:true},{reviewHold:true}])
    assert.equal(eventVerifiedPendingMatch(saved,{...own,...extra}),null,JSON.stringify(extra));
  for(const extra of [{trackId:hash(12345)},{periodId:'another'},{accountId:hash(44444)}]){
    const visible=render(saved,{local:{...own,...extra,timeMs:1}}).rows().rows;
    assert.equal(visible.find(r=>r.accountId===own.accountId).timeMs,own.timeMs);
  }
  const blocked=structuredClone(saved);blocked.entries[3].physicsVerified=false;
  assert.equal(eventVerifiedPendingMatch(blocked,own),null);
});

test('cards and sidebar presentation count the actual loaded union above 200, not intake limits or metadata',()=>{
  const saved=board(205);saved.complete=false;saved.totalEntries=999;
  saved.pendingPlaybacks=Array.from({length:36},(_,i)=>waiting(row(i+206)));
  assert.match(render(saved).markup(),/>4\/241\*</);
  assert.match(render(saved,{policy:'verified'}).markup(),/>4\/205</);
  assert.equal(eventSnapshotRows(saved).rows.length,241);
  assert.equal(eventOwnPlacementPresentation({rank:4,knownFieldSize:241,provisional:true}).text,'4/241*');
  assert.match(render(saved,{filterRows:rows=>({active:true,rows:rows.filter(r=>Number.parseInt(r.accountId,16)<=10)})}).markup(),/>4\/10</);
  assert.doesNotMatch(render(saved,{enabled:false}).markup(),/4th|\/ 241/);
});

test('legacy retained local bytes produce only an exact bounded identity hash, not a verification verdict',async()=>{
  const accountId=hash(4),local={timeMs:20400,attemptId:'old-local'},raw={...local,accountId,trackId:period.trackId,
    periodId:period.id,frames:20400,replay:'fixture_replay'},before=structuredClone(raw);
  const binding=await eventLocalReplayBinding(local,period,accountId,[raw]);
  assert.equal(binding.replayHash,createHash('sha256').update(raw.replay).digest('hex'));
  assert.equal(binding.trackId,period.trackId);assert.equal(binding.accountId,accountId);
  assert.equal(binding.verified,undefined);assert.deepEqual(raw,before);
  for(const change of [{accountId:hash(5)},{trackId:hash(1)},{periodId:'wrong'},{timeMs:1},{attemptId:'other'},{frames:1}])
    assert.equal(await eventLocalReplayBinding(local,period,accountId,[{...raw,...change}]),null);
  assert.equal(await eventLocalReplayBinding(local,period,accountId,Array(9).fill(raw)),null);
  assert.equal(await eventLocalReplayBinding(local,period,accountId,[{...raw,replay:'x'.repeat(65537)}]),null);
});
