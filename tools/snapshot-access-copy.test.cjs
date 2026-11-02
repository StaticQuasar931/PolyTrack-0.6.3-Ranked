const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(process.env.POLYTRACK_AUDIT_REPO||path.join(__dirname,'..'),'polytrack_062_patch.js'),'utf8');
const start=source.indexOf('  function snapshotAccessNotice(){');
const end=source.indexOf('  let snapshotCountdownWasLocked=',start);
function notice(state){const context=vm.createContext({snapshotRefreshState:()=>state});vm.runInContext(source.slice(start,end),context);return context.snapshotAccessNotice();}
test('snapshot help describes saved standings and normal submissions without obsolete unlock requirements',()=>{
  for(const remainingMs of [0,1000])for(const needsFinish of [false,true]){
    const copy=notice({remainingMs,needsFinish});
    assert.match(copy,/Standings use saved snapshots/);
    assert.match(copy,/race and submit runs normally/);
    assert.doesNotMatch(copy,/timer|first saved finish|unlock|live refresh/i);
  }
});
test('compact Ranked notice retains coverage warning in its text and tooltip',()=>{
  assert.ok(source.includes('Missing racers are not ranked in this snapshot.'));
  assert.match(source,/notice\.title=coverage/);
  assert.match(source,/notice\.textContent=[\s\S]*?:coverage;/);
});
