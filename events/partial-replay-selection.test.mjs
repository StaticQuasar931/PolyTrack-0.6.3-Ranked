import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {harness,racer,deferred,until,clientSource as source} from './event-replay-test-fixture.mjs';

for(const mode of ['play','watch'])for(const accepted of [true,false,'yes'])
 test(mode+' mixed group requires literal consent '+String(accepted)+' after explicit action, never selection',async()=>{
  const gate=deferred(),h=harness({read:row=>row.accountId==='second'?null:{...row},confirm:()=>gate.promise});
  await h.selectTopEventRows(3);const before=h.selected();assert.equal(h.reads.length,0);assert.equal(h.offers.length,0);
  const work=h.action(mode);await until(()=>h.offers.length===1);
  assert.equal(h.reads.length,3);assert.equal(h.offers[0].failed.length,1);assert.equal(h.selected().length,3);
  gate.resolve(accepted);await work;
  const passed=accepted===true;assert.equal(mode==='play'?h.launches.length:h.watches.length,passed?1:0);
  assert.equal(h.selected().length,passed?2:3);
  if(!passed)assert(h.selected().every((r,i)=>r===before[i]));
 });

for(const mode of ['play','watch'])test(mode+' all missing retains selections and never asks permission to launch nothing',async()=>{
 const h=harness({read:()=>null});await h.selectTopEventRows(3);await h.action(mode);await h.action(mode);
 assert.equal(h.selected().length,3);assert.equal(h.offers.length,0);assert.equal(h.reads.length,3);
 assert.equal(h.launches.length,0);assert.equal(h.watches.length,0);
 h.clock(61001);await h.action(mode);assert.equal(h.reads.length,6);
});

for(const mode of ['play','watch'])for(const change of ['account','session','track','page','filter','standings','hold','navigation','selection'])
 test(mode+' rejects stale partial consent after '+change,async()=>{
  const gate=deferred(),h=harness({read:row=>row.accountId==='second'?null:{...row},confirm:()=>gate.promise});
  await h.selectTopEventRows(3);const work=h.action(mode);await until(()=>h.offers.length===1);
  h.change(change);assert.equal(h.offers[0].isCurrent(),false);gate.resolve(true);await work;
  assert.equal(h.launches.length,0);assert.equal(h.watches.length,0);
 });

for(const mode of ['play','watch'])test(mode+' caches successful preparation after Cancel, without hiding failed bindings',async()=>{
 const h=harness({read:row=>row.accountId==='second'?null:{...row},confirm:()=>false});
 await h.selectTopEventRows(3);await h.action(mode);await h.action(mode);
 assert.equal(h.selected().length,3);assert.equal(h.reads.length,3);assert.equal(h.prepares(),2);assert.equal(h.offers.length,2);
 assert.equal(h.offers[1].ready.length,2);assert.equal(h.offers[1].failed.length,1);
});

for(const mode of ['play','watch'])test(mode+' never treats invalid payload hash as a ready replay',async()=>{
 const h=harness({read:row=>({...row,...(row.accountId==='second'?{replayHash:'wrong'}:{})}),confirm:()=>false});
 await h.selectTopEventRows(3);await h.action(mode);await h.action(mode);
 assert.equal(h.selected().length,3);assert.equal(h.offers.length,2);assert.equal(h.offers[0].failed.length,1);
 assert.equal(h.launches.length,0);assert.equal(h.watches.length,0);assert.equal(h.reads.length,3);assert.equal(h.prepares(),3);
});

test('archive partial failures cannot use live fallback',async()=>{
 const h=harness({read:row=>row.accountId==='second'?null:{...row},confirm:()=>false});h.archive();
 h.bridge.readReplay=()=>assert.fail('No live archive fallback');await h.selectTopEventRows(3);assert.equal(h.reads.length,0);
 await h.action('watch');assert(h.reads.every(r=>r.archive));assert.equal(h.offers.length,1);assert.equal(h.selected().length,3);
});

test('failed native handoff keeps failed and ready selections intact',async()=>{
 const h=harness({read:row=>row.accountId==='second'?null:{...row},handoff:()=>{throw Error('Synthetic native rejection');}});
 await h.selectTopEventRows(3);await h.action('play');assert.equal(h.launches.length,0);assert.equal(h.selected().length,3);
});

test('snapshot-only receipt reads remain zero across repeated event opens with existing bestRecords', async () => {
  const fn = source.slice(source.indexOf('  async function readReceipt('), source.indexOf('  function clearNativeView('));
  let calls = 0, clock = 1000;
  const ownReceipts = new Map(), ownReceiptAt = new Map(), ownReceiptRequests = new Map();
  const bestRecords = {period_self: {timeMs: 20000, attemptId: 'saved-attempt'}};
  const read = vm.runInNewContext('(' + fn + ')', {ownReceipts, ownReceiptAt, ownReceiptRequests, bestRecords, now: () => clock,
    bridge: {snapshotOnly: () => true, readOwnStatus: () => { calls++; throw Error('Unexpected live receipt read'); }}});
  for (let i = 0; i < 20; i++) { clock += 120000; assert.equal(await read('period', 'self'), null); }
  const cached = {status: 'verified', attemptId: 'saved-attempt'}; ownReceipts.set('period_self', cached);
  for (let i = 0; i < 20; i++) { clock += 120000; assert.equal(await read('period', 'self'), cached); }
  assert.equal(calls, 0); assert.equal(ownReceiptAt.size, 0); assert.equal(ownReceiptRequests.size, 0);
});
test('snapshot-only refresh control never advertises a countdown or cloud refresh', () => {
  const fn = source.slice(source.indexOf('  function updateEventRefreshControl('), source.indexOf('  function message('));
  const button = {disabled: false, textContent: 'Refresh in 60s', title: 'cloud requests'};
  const update = vm.runInNewContext('(' + fn + ')', {dialog: {querySelector: () => button}, selected: {id: 'period'},
    bridge: {snapshotOnly: () => true}, now: () => { throw Error('Countdown must not be evaluated'); }});
  for (let i = 0; i < 20; i++) update();
  assert.equal(button.disabled, true); assert.equal(button.textContent, 'Snapshot standings'); assert.equal(button.title, 'Standings update with the published snapshot.');
});
