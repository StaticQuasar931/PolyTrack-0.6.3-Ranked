import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {eventStandingsLabel} from './client.mjs';
const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
const fn=source.slice(source.indexOf('  async function readReceipt('),source.indexOf('  function clearNativeView('));
function fixture(readOwnStatus,{snapshotOnly,bestRecords={}}={}){
 let at=1000000;const ownReceipts=new Map(),ownReceiptAt=new Map(),ownReceiptRequests=new Map();
 return {ownReceipts,ownReceiptAt,ownReceiptRequests,advance:ms=>{at+=ms;},read:vm.runInNewContext('('+fn+')',{ownReceipts,ownReceiptAt,ownReceiptRequests,bestRecords,now:()=>at,bridge:{readOwnStatus,snapshotOnly}})};
}
test('parallel receipt reads and repeated force requests are bounded',async()=>{
 let calls=0,resolve;const f=fixture(()=>{calls++;return new Promise(r=>{resolve=r;});});
 const a=f.read('period','self',true),b=f.read('period','self',true);assert.equal(calls,1);
 resolve({status:'verified'});await Promise.all([a,b]);await f.read('period','self',true);assert.equal(calls,1);
 f.advance(60000);const c=f.read('period','self');assert.equal(calls,2);resolve(null);await c;
});
test('receipt failure retains a known verdict and respects cooldown',async()=>{
 let calls=0;const f=fixture(async()=>{calls++;throw Error('offline');});f.ownReceipts.set('period_self',{status:'verified'});
 assert.equal((await f.read('period','self')).status,'verified');assert.equal((await f.read('period','self')).status,'verified');assert.equal(calls,1);
});
test('an invalidated in-flight receipt cannot overwrite a new submission',async()=>{
 let resolve;const f=fixture(()=>new Promise(r=>{resolve=r;}));const pending=f.read('period','self');
 f.ownReceiptAt.delete('period_self');f.ownReceipts.delete('period_self');f.ownReceiptRequests.delete('period_self');resolve({status:'verified'});await pending;
 assert.equal(f.ownReceipts.has('period_self'),false);
});
test('event freshness does not call an old published update a fresh snapshot capture',()=>{
 const at=36000000;
 assert.equal(eventStandingsLabel({_publicBackup:true,updatedAt:at-7200000},at),'Snapshot package · age unknown · Standings changed 2h ago');
 assert.equal(eventStandingsLabel({_publicBackup:true,_snapshotCapturedAt:at-3600000,updatedAt:1},at),'Snapshot package · age unknown · Standings changed 9h ago');
 assert.equal(eventStandingsLabel({saved:true,updatedAt:at-60000},at,true),'Refresh failed. Cached standings · updated 1m ago');
});


test('a new PB detaches the old receipt request and keeps the replacement result',async()=>{
 let calls=0;const pending=[];const f=fixture(()=>{calls++;return new Promise(resolve=>pending.push(resolve));});
 const old=f.read('period','self');f.ownReceiptAt.delete('period_self');f.ownReceipts.delete('period_self');f.ownReceiptRequests.delete('period_self');
 const next=f.read('period','self');assert.equal(calls,2);
 pending[1]({attemptId:'new',status:'waiting'});await next;pending[0]({attemptId:'old',status:'verified'});await old;
 assert.equal(f.ownReceipts.get('period_self').attemptId,'new');
 assert.match(source,/function invalidateReceipt\(key\)\{\s*ownReceiptAt.delete\(key\);ownReceipts.delete\(key\);ownReceiptRequests.delete\(key\);/);
});


test('snapshot-only visitors do not read nonexistent event receipts until they submit a run',async()=>{
 let calls=0;const bestRecords={},f=fixture(async()=>{calls++;return {status:'waiting'};},{snapshotOnly:()=>true,bestRecords});
 assert.equal(await f.read('period','self'),null);assert.equal(calls,0);
 bestRecords.period_self={timeMs:20000};assert.equal((await f.read('period','self')).status,'waiting');assert.equal(calls,1);
});


test('public events use the common package age rather than their individual check date',()=>{
 const at=36000000,base={_publicBackup:true,_snapshotPackageAt:at-60000,updatedAt:at-7200000};
 assert.equal(eventStandingsLabel({...base,_snapshotCapturedAt:1},at),'Snapshot package · 1m old · Standings changed 2h ago');
 assert.equal(eventStandingsLabel({...base,_snapshotCapturedAt:at},at),eventStandingsLabel(base,at));
});
