const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../polytrack_062_patch.js'), 'utf8');

test('PB reconciliation tracks concurrent work and debounce timers by account', () => {
  assert.ok(source.includes('const localPbReconcilePromises = new Map();'));
  assert.ok(source.includes('const localPbReconcileTimers = new Map();'));
  assert.ok(source.includes('localPbReconcilePromises.get(safeId)'));
  assert.ok(source.includes('localPbReconcilePromises.set(safeId,reconcilePromise)'));
  assert.ok(source.includes('localPbReconcileTimers.set(safeId,setTimeout'));
  assert.ok(source.includes('localPbReconcilePromises.get(safeId)===reconcilePromise'));
  assert.ok(!source.includes('let localPbReconcilePromise = null'));
  assert.ok(!source.includes('let localPbReconcileTimer = 0'));
});

function batchHarness(){
  const start=source.indexOf('  const LOCAL_PB_RECONCILE_BATCH_SIZE=16;');
  const end=source.indexOf('  async function reconcileLocalPersonalBestsToCloud',start);
  assert.ok(start>=0&&end>start,'production PB batch helpers are present');
  const context={
    cleanUserId:value=>String(value||''),
    activeRankedAccountId:()=>context.activeAccount,
    canonicalRaceTimeMs:row=>Number(row.timeMs||0),
    localPbSyncSignature:row=>JSON.stringify([row.trackId,Number(row.timeMs||0),String(row.replayHash||'')]),
    window:{firebase:{auth:()=>({currentUser:{uid:'uid-a'}})}},
    activeAccount:'account-a'
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start,end),context);
  return context;
}

test('PB reconciliation processes at most 16 rows and continues without premature fingerprint', async () => {
  const h=batchHarness();
  const rows=Array.from({length:41},(_,index)=>({trackId:`track-${index}`,timeMs:10000+index,replayHash:`hash-${index}`}));
  const state={confirmed:{}};
  let failFirst=true;
  const first=await h.runLocalPbReconcileBatch(rows,'account-a',h.isCurrentLocalPbReconcileIdentity,async row=>{
    if(row.trackId==='track-4'&&failFirst)return {confirmed:false};
    state.confirmed[row.trackId]=h.localPbSyncSignature(row);
    return {confirmed:true};
  });
  assert.equal(first.checked,16);
  assert.equal(first.failed,1);
  assert.equal(first.remaining,26,'the failed row remains part of the unresolved work count');
  assert.equal(h.localPbReconcileFingerprintIfConfirmed(rows,state),null);
  assert.ok(h.localPbReconcileContinuationDelay(true,0,1000)>=60000);
  assert.equal(h.localPbReconcileContinuationDelay(false,0,1000),null);

  failFirst=false;
  let retryRows=rows.filter(row=>state.confirmed[row.trackId]!==h.localPbSyncSignature(row));
  assert.ok(retryRows.some(row=>row.trackId==='track-4'),'failed row remains unconfirmed and retryable');
  let totalChecked=first.checked;
  while(retryRows.length){
    const pass=await h.runLocalPbReconcileBatch(retryRows,'account-a',h.isCurrentLocalPbReconcileIdentity,async row=>{
      state.confirmed[row.trackId]=h.localPbSyncSignature(row);
      return {confirmed:true};
    });
    totalChecked+=pass.checked;
    retryRows=rows.filter(row=>state.confirmed[row.trackId]!==h.localPbSyncSignature(row));
  }
  assert.equal(totalChecked,42,'one failed row is attempted again on a later bounded pass');
  assert.notEqual(h.localPbReconcileFingerprintIfConfirmed(rows,state),null);
});

test('PB reconciliation cancels between rows after an account switch', async () => {
  const h=batchHarness();
  const rows=Array.from({length:20},(_,index)=>({trackId:`track-${index}`,timeMs:10000+index}));
  let processed=0;
  const pass=await h.runLocalPbReconcileBatch(rows,'account-a',h.isCurrentLocalPbReconcileIdentity,async()=>{
    processed++;
    h.activeAccount='account-b';
    return {confirmed:true};
  });
  assert.equal(processed,1);
  assert.equal(pass.cancelled,true);
  assert.equal(pass.checked,0,'switched identity is not recorded as confirmed by the canceled pass');
  assert.equal(h.localPbReconcileContinuationDelay(false),null);
  assert.ok(source.includes('if(!safeId||!isCurrentLocalPbReconcileIdentity(safeId))return;'));
  assert.ok(source.includes("{accountId:safeId,ownerUid:uid}"));
});
