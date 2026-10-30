import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {Socket} from 'node:net';
import {eventPublishedPbCoversReceipt,eventRowVerified,eventSnapshotRows,eventStandingsLabel} from './client.mjs';

globalThis.fetch=()=>{throw Error('No network in published receipt tests');};
Socket.prototype.connect=globalThis.fetch;
const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
const section=(start,end)=>{const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a);return source.slice(a,b);};
const receiptSource=section('  function receiptText(', '  function rows(');
const receiptText=vm.runInNewContext('('+receiptSource+')',{eventPublishedPbCoversReceipt});
const accountId='a'.repeat(64),period={id:'weekly_fixture',kind:'weekly',trackId:'b'.repeat(64),startsAt:Date.now()-10000,endsAt:Date.now()+3600000};
const verified={accountId,timeMs:1000,rank:1,rp:50,physicsVerified:true,replayIntegrityVerified:true};
const board=()=>({period:{...period},entries:[{...verified}],updatedAt:Date.now(),_publicBackup:true});
const waiting=()=>({accountId,periodId:period.id,timeMs:1100,attemptId:'old',status:'waiting'});

test('current verified snapshot suppresses stale waiting, cloud-status and expired notes without rewriting receipts',()=>{
  for(const status of ['waiting','expired','verified']){
    const receipt={...waiting(),status},local={accountId,timeMs:1100,attemptId:'other'},before=structuredClone({receipt,local});
    assert.equal(receiptText(receipt,local,period,{board:board(),accountId}),'');
    assert.deepEqual({receipt,local},before);
  }
  assert.equal(receiptText(null,{accountId,timeMs:1000},period,{board:board(),accountId}),'');
  const closed={...period,endsAt:Date.now()-1000},saved={...board(),period:closed};
  assert.equal(receiptText(waiting(),null,closed,{board:saved,accountId}),'');
});

test('a faster unpublished local or remote attempt never inherits the slower published PB verification',()=>{
  const receipt=waiting(),local={accountId,timeMs:900,attemptId:'new'},queue=[local],before=JSON.stringify({receipt,queue});
  assert.match(receiptText(receipt,local,period,{board:board(),accountId}),/Waiting/);
  assert.match(receiptText({...receipt,timeMs:900},null,period,{board:board(),accountId}),/Waiting/);
  assert.equal(JSON.stringify({receipt,queue}),before);
  assert.equal(eventPublishedPbCoversReceipt(receipt,local,period,{board:board(),accountId}),false);
});

test('rejections, mismatches, unavailable outcomes and explicit review holds retain their original receipt note',()=>{
  for(const change of [{status:'rejected',reason:'event_entrant_capacity'},{status:'mismatch'},{status:'unavailable_final'},
    {status:'held'},{status:'review_hold'},{reason:'similar_replay_pending_manual_review'},{needsReview:true},{reviewHold:true}]){
    const receipt={...waiting(),...change};
    const original=receiptText(receipt,null,period);
    assert.ok(original);assert.equal(receiptText(receipt,null,period,{board:board(),accountId}),original);
  }
});

test('foreign, held, pending or missing published bindings cannot suppress a waiting note',()=>{
  const cases=[null,{...board(),period:{...period,id:'other'}},{...board(),period:{...period,trackId:'c'.repeat(64)}},
    {...board(),period:{...period,kind:'daily'}},{...board(),entries:[{...verified,accountId:'c'.repeat(64)}]},
    {...board(),entries:[{...verified,pending:true}]},{...board(),entries:[{...verified,physicsVerified:false}]},
    {...board(),entries:[{...verified,reviewHold:true}]},{...board(),entries:[{...verified,timeMs:1200}]},
    {...board(),entries:[{...verified,periodId:'other'}]}];
  for(const saved of cases)assert.match(receiptText(waiting(),null,period,{board:saved,accountId}),/Waiting/);
  for(const change of [{accountId:'c'.repeat(64)},{periodId:'other'},{trackId:'c'.repeat(64)},{timeMs:NaN}])
    assert.match(receiptText({...waiting(),...change},null,period,{board:board(),accountId}),/Waiting/);
  for(const local of [{timeMs:NaN},{timeMs:1000,unscored:true},{timeMs:1000,reviewHold:true}])
    assert.equal(eventPublishedPbCoversReceipt(waiting(),local,period,{board:board(),accountId}),false);
});

function cachedReceiptFixture(receipt){
  let reads=0;const ownReceipts=new Map([[period.id+'_'+accountId,receipt]]);
  const context={ownReceipts,ownReceiptAt:new Map(),ownReceiptRequests:new Map(),now:()=>Date.now(),
    bridge:{snapshotOnly:()=>true,readOwnStatus:()=>{reads++;throw Error('Snapshot receipt must not poll');}}};
  const readReceipt=vm.runInNewContext('('+section('  async function readReceipt(', '  function clearNativeView(')+')',context);
  return {ownReceipts,readReceipt,reads:()=>reads};
}

test('actual native PB status expression prefers published authority over cached waiting without extra OwnStatus reads',async()=>{
  const receipt=waiting(),fixture=cachedReceiptFixture(receipt),saved=board(),local={accountId,timeMs:1100,attemptId:'new'};
  const context={...fixture,period,accountId,board:saved,localBest:()=>local,receiptText,statusText:'Waiting for upload'};
  const start=source.indexOf("    const receipt=ownReceipts.get(period.id+'_'+accountId)",source.indexOf('  function syncNativeBoard('));
  const end=source.indexOf('    // Selection changes',start);assert.ok(start>=0&&end>start);
  assert.equal(await fixture.readReceipt(period.id,accountId),receipt);
  const presentation='(()=>{'+source.slice(start,end)+';return statusDescription;})()';
  assert.equal(vm.runInNewContext(presentation,context),'');
  local.timeMs=900;
  assert.match(vm.runInNewContext(presentation,context),/Waiting/);
  await fixture.readReceipt(period.id,accountId,true);
  assert.equal(fixture.reads(),0);assert.equal(receipt.status,'waiting');assert.equal(local.timeMs,900);
});

test('actual event dialog uses the same published-source override and preserves a faster unsaved PB',async()=>{
  const receipt=waiting(),fixture=cachedReceiptFixture(receipt),saved=board();let local={accountId,timeMs:1100,attemptId:'new'},html='';
  const context={dialog:{querySelector:()=>({})},requestId:0,selected:null,shell(){},selectView(){},
    bridge:{accountId:()=>accountId,thumbnail:()=>''},snapshot:async()=>saved,readReceipt:fixture.readReceipt,
    localBest:()=>local,receiptText,eventRowVerified,eventSnapshotRows,eventStandingsLabel,
    now:()=>Date.now(),body:value=>{html=value;},snapshotAttempts:new Map(),escape:value=>String(value),
    periodName:()=> 'Fixture',reset:()=>'',time:value=>String(value??'---'),rows:entries=>entries.map(row=>row.timeMs).join(','),
    message(){},updateEventRefreshControl(){}};
  const open=vm.runInNewContext(section('  async function openPeriod(', '  async function practice(')+';openPeriod;',context);
  await open(period);assert.doesNotMatch(html,/Waiting|closed before the run|sq-event-receipt/);assert.match(html,/\(published\)/);
  local={accountId,timeMs:900,attemptId:'unsaved-faster'};
  await open(period);assert.match(html,/Waiting/);assert.match(html,/saved on this device/);
  assert.equal(fixture.reads(),0);assert.equal(fixture.ownReceipts.get(period.id+'_'+accountId),receipt);
  assert.equal(receipt.status,'waiting');assert.equal(local.attemptId,'unsaved-faster');
});

test('native quick-render cache invalidates when a cached hold or exclusion changes without a new attempt or time',()=>{
  const start=source.indexOf('      const quickSignature=JSON.stringify('),end=source.indexOf('      if(quickBoard===',start);
  assert.ok(start>=0&&end>start);
  const context={bridge:{},quickBoard:board(),quickLocal:{attemptId:'same',timeMs:1100},quickReceipt:waiting(),
    view:{page:0,onlyVerified:false},now:()=>1000,selection:[],pendingSelection:[]};
  const expression='(()=>{'+source.slice(start,end)+';return quickSignature;})()';
  const before=vm.runInNewContext(expression,context);
  context.quickReceipt.excluded=true;
  assert.notEqual(vm.runInNewContext(expression,context),before);
  delete context.quickReceipt.excluded;context.quickLocal.unscored=true;
  assert.notEqual(vm.runInNewContext(expression,context),before);
});
