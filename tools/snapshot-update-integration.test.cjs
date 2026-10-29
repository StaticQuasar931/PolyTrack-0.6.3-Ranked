const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../polytrack_062_patch.js'),'utf8');
const a=source.indexOf('  let snapshotUpdateChecking='),b=source.indexOf('  function requestRankedRefresh(',a);
assert.ok(a>0&&b>a);
const code=source.slice(a,b).replace(/await import\('\.\/tools\/snapshot-update-check\.mjs\?v=\d+'\)/,'await loadModule()');
assert.notEqual(code,source.slice(a,b));
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({moduleGate,failModule=false}={}){
  const requests=[],shown=[],statuses=[];let disposed=0;
  const origin={isConnected:true,disabled:false,after:node=>statuses.push(node)},panel={visible:true},modal={visible:false};
  const context={AbortController,Number,log(){},setTimeout:()=>1,clearTimeout(){},
    document:{getElementById:id=>id==='overallFreshness'?origin:id==='overallLeaderboardPanel'?panel:modal,
      querySelector:()=>({content:'./public-snapshots69/'}),createElement:()=>({setAttribute(){},remove(){this.removed=true;}})},
    isElementVisible:node=>!!node?.visible,
    loadModule:async()=>{if(failModule)throw Error('module offline');if(moduleGate)await moduleGate.promise;return module;},
    updateRankedFreshness:()=>{origin.disabled=context.checking();}};
  const module={createSnapshotUpdateCheck:()=>({check:(generation,options)=>{const gate=deferred();requests.push({...gate,generation,...options});return gate.promise;}}),
    showSnapshotUpdateResult:(result,options)=>{shown.push({result,options,disabled:origin.disabled});return {dispose:()=>disposed++};}};
  vm.createContext(context);vm.runInContext(code+'\nfunction checking(){return snapshotUpdateChecking;}',context);
  return {context,requests,shown,statuses,origin,panel,modal,disposed:()=>disposed,run:context.checkPublishedSnapshotUpdate,cancel:context.cancelPublishedSnapshotUpdate};
}
test('restores enabled state before inline or new-snapshot feedback',async()=>{
  const f=fixture(),pending=f.run();await turn();assert.equal(f.origin.disabled,true);
  f.requests[0].resolve({status:'current'});await pending;
  assert.equal(f.shown.length,1);assert.equal(f.shown[0].disabled,false);assert.equal(f.shown[0].options.origin,f.origin);
  assert.equal(f.shown[0].options.signal.aborted,false);f.cancel();assert.equal(f.disposed(),1);
});
test('close/reopen aborts stale results and old finally cannot unlock a new check',async()=>{
  const f=fixture(),first=f.run();await turn();f.cancel();
  assert.equal(f.requests[0].signal.aborted,true);
  const second=f.run();await turn();f.requests[0].resolve({status:'newer',generation:70});await first;
  assert.equal(f.context.checking(),true);assert.equal(f.shown.length,0);
  f.requests[1].resolve({status:'current'});await second;assert.equal(f.shown.length,1);assert.equal(f.context.checking(),false);
});
test('leaving before the helper loads performs no static check or stale feedback',async()=>{
  const moduleGate=deferred(),f=fixture({moduleGate}),pending=f.run();f.cancel();moduleGate.resolve();await pending;
  assert.equal(f.requests.length,0);assert.equal(f.shown.length,0);
});
test('hidden views or an opened profile never receive late feedback',async()=>{
  for(const change of [f=>f.panel.visible=false,f=>f.modal.visible=true]){
    const f=fixture(),pending=f.run();await turn();change(f);f.requests[0].resolve({status:'newer',generation:70});await pending;
    assert.equal(f.shown.length,0);assert.equal(f.context.checking(),false);
  }
});
test('transport errors show unavailable, not a false no-update success',async()=>{
  const f=fixture(),pending=f.run();await turn();f.requests[0].reject(Error('offline'));await pending;
  assert.equal(f.shown[0].result.status,'unavailable');assert.equal(f.shown[0].disabled,false);
});
test('module-load errors remain visible inline and are cleaned up on close',async()=>{
  const f=fixture({failModule:true});await f.run();assert.equal(f.statuses.length,1);
  assert.match(f.statuses[0].textContent,/unavailable/);f.cancel();assert.equal(f.statuses[0].removed,true);
});
test('real panel dismissal cancels its pending snapshot check',()=>{
  const i=source.indexOf('  function closeOverallPanel('),j=source.indexOf('\n  }',i);
  assert.match(source.slice(i,j),/cancelPublishedSnapshotUpdate\(\)/);
});
