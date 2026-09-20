const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

const source=fs.readFileSync(require('node:path').join(__dirname,'..','polytrack_062_patch.js'),'utf8');
const start=source.indexOf('  const nativeFilterInitialized=');
const end=source.indexOf('  function syncIntegrityStateLabels',start);
const context={WeakSet,queueMicrotask(){throw Error('test must inject defer');},requestAnimationFrame(){throw Error('test must inject reconcile');},reconcileUI(){}};
vm.createContext(context);vm.runInContext(source.slice(start,end)+'\nthis.ensureNativeAllRunsDefault=ensureNativeAllRunsDefault;',context);

function fixture({eventBoard=false,disabled=false,alreadyAll=false}={}){
  const listeners=[];let clicks=0,reconciles=0;const pending=[];
  const host={classList:{contains:name=>eventBoard&&name==='sq-event-board'},querySelector:()=>filter};
  const filter={dataset:{},disabled,isConnected:true,classList:{contains:name=>alreadyAll&&name==='disabled'},closest:selector=>selector==='.leaderboard-ui'?host:null,
    addEventListener:(type,listener,capture)=>{assert.equal(type,'click');assert.equal(capture,true);listeners.push(listener);},
    click(){clicks++;for(const listener of listeners)listener({isTrusted:false});}};
  const run=()=>context.ensureNativeAllRunsDefault(host,filter,callback=>pending.push(callback),()=>{reconciles++;});
  return {filter,listeners,pending,run,get clicks(){return clicks;},get reconciles(){return reconciles;}};
}

test('native filter defaults to all runs exactly once',()=>{
  const f=fixture();assert.equal(f.run(),true);assert.equal(f.run(),false);assert.equal(f.pending.length,1);
  f.pending.shift()();assert.equal(f.clicks,1);assert.equal(f.reconciles,1);assert.equal(f.filter.dataset.sqNativeFilterDefault,'all');assert.equal(f.run(),false);
});

test('trusted user choice wins before deferred default',()=>{
  const f=fixture();assert.equal(f.run(),true);f.listeners[0]({isTrusted:true});f.pending.shift()();
  assert.equal(f.clicks,0);assert.equal(f.reconciles,0);assert.equal(f.filter.dataset.sqNativeFilterDefault,'user');assert.equal(f.run(),false);
});

test('already-All native controls, including custom native constructor defaults, never flip on',()=>{
  const f=fixture({alreadyAll:true});assert.equal(f.run(),true);f.pending.shift()();
  assert.equal(f.clicks,0);assert.equal(f.reconciles,0);assert.equal(f.filter.dataset.sqNativeFilterDefault,'all');assert.equal(f.run(),false);
});

test('event custom leaderboard is never initialized',()=>{
  const f=fixture({eventBoard:true});assert.equal(f.run(),false);assert.equal(f.pending.length,0);assert.equal(f.listeners.length,0);assert.equal(f.clicks,0);
});
