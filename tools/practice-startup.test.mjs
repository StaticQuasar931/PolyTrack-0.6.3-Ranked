import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';

const fragment=new URL('../initializer.fragment.js',import.meta.url);
let source;
if(fs.existsSync(fragment))source=fs.readFileSync(fragment,'utf8');
else{
  const patch=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
  const declaration=patch.match(/^  let practiceInitPromise=.*$/m)?.[0];
  const imports=patch.match(/^  const practiceStartupImports=.*$/m)?.[0];
  const start=patch.indexOf('  function importPracticeStartupModule('),end=patch.indexOf('  let playtimeVisibleAt=',start);
  assert.ok(declaration&&imports&&start>=0&&end>start,'integrated startup anchors');
  source=declaration+'\n'+imports+'\n'+patch.slice(start,end);
}
function fixture({fail='',available=true,marker=false,installError='',hold=false}={}){
  let now=100000,requires=0,installs=0,stores=0,insights=0,controls=0,delays=[],logs=[],release;
  const listeners=[],history={observeCoverage(){},flush(){},marker:'preserve live data'};
  const Physics={prototype:{}};Physics.prototype[Symbol.for('polytrack-native-local-binding')]=marker;
  const req=()=>({A:Physics});
  const options={fail,available,installError};
  const importer=async url=>{
    if(hold){hold=false;await new Promise(resolve=>{release=resolve;});}
    if(options.fail&&url.includes(options.fail))throw Error('offline import');
    if(url.includes('practice-history'))return {createPracticeHistory(){stores++;return history;},practiceAdvice(){}};
    if(url.includes('local-insights'))return {createLocalInsights(){insights++;return {action(){},flush(){},leave(){}};}};
    if(url.includes('control-usage'))return {installControlUsage(){controls++;}};
    if(url.includes('practice-profile'))return {};
    if(url.includes('practice-native'))return {installPracticeObserver(){installs++;if(options.installError)throw Error(options.installError);return {sample(){}};}};
    throw Error('unexpected module');
  };
  const target={addEventListener(type,fn){listeners.push({type,fn});},visibilityState:'visible',hasFocus:()=>true};
  const sandbox={Date:{now:()=>now},Promise,Symbol,Math,Number,Error,window:{...target,localStorage:{}},document:target,
    practiceHistory:null,localInsights:null,practiceObserver:null,practiceAdviceFor:null,renderPracticeProfile:null,installPracticeProfileControls:null,capturePracticeProfileView:null,restorePracticeProfileView:null,
    schedulePracticeProfileRefresh(){},activeRankedAccountId:()=> 'a'.repeat(64),overallEntriesCache:[],cleanUserId:x=>x,currentPlaytimeMs:()=>0,
    __pt062WebpackRequire(){requires++;return options.available?req:null;},
    readTrackSnapshotCache(){},localPersonalBestMs:()=>0,canonicalRaceTimeMs:()=>0,warmPlayedTrack(){},practiceWarmTrack:'',practiceFullWarmTimer:0,
    clearTimeout(){},setTimeout(fn,ms){delays.push(ms);now+=ms;fn();},log(...args){logs.push(args);},__import:importer};
  const body=source.replaceAll('import(', '__import(');
  const api=vm.runInNewContext(body+'\n({initializePracticeHistory,getState:()=>({practiceRetryAfter,practiceRetryDelay,practiceBindingBlocked,practiceInitPromise})})',sandbox);
  return {...api,options,sandbox,history,Physics,listeners,logs,advance:ms=>{now+=ms;},release:()=>release(),stats:()=>({requires,installs,stores,insights,controls,delays})};
}

for(const failed of ['practice-history','local-insights','practice-profile','practice-native']){
  test('future readiness retries failed '+failed+' import without replacing existing stores or listeners',async()=>{
    const f=fixture({fail:failed});await f.initializePracticeHistory();
    assert.equal(f.getState().practiceInitPromise,null);
    const old=f.sandbox.practiceHistory;f.options.fail='';f.advance(1000);await f.initializePracticeHistory();
    assert.equal(f.stats().installs,1);assert.equal(f.stats().stores,1);assert.equal(f.stats().insights,1);assert.equal(f.stats().controls,1);
    if(old)assert.equal(f.sandbox.practiceHistory,old);
    assert.equal(f.listeners.filter(x=>x.type==='pagehide').length,2);
    await f.initializePracticeHistory();assert.equal(f.stats().installs,1);
  });
}
test('webpack becoming available after the initial five-second window is retried on later readiness',async()=>{
  const f=fixture({available:false});await f.initializePracticeHistory();
  assert.equal(f.stats().delays.length,10);assert.equal(f.stats().installs,0);
  f.options.available=true;await f.initializePracticeHistory();assert.equal(f.stats().installs,0,'backoff is respected');
  f.advance(1000);await f.initializePracticeHistory();assert.equal(f.stats().installs,1);assert.equal(f.stats().stores,1);
});
test('concurrent callers share one import and installation',async()=>{
  const f=fixture({hold:true}),first=f.initializePracticeHistory(),second=f.initializePracticeHistory();
  assert.equal(first,second);f.release();await first;assert.equal(f.stats().installs,1);
});
test('backoff is bounded and schedules no autonomous retry',async()=>{
  const f=fixture({fail:'practice-history'});
  for(const delay of [1000,2000,4000,8000,16000,30000,30000]){
    await f.initializePracticeHistory();
    assert.equal(f.stats().delays.length,0);
    assert.equal(f.getState().practiceRetryDelay,Math.min(30000,delay*2));
    f.advance(delay);
  }
});
test('active protected binding prevents calling the installer, permanently for this page',async()=>{
  const f=fixture({marker:true});await f.initializePracticeHistory();assert.equal(f.stats().installs,0);
  assert.equal(f.getState().practiceBindingBlocked,true);
  f.Physics.prototype[Symbol.for('polytrack-native-local-binding')]=false;f.advance(60000);await f.initializePracticeHistory();
  assert.equal(f.stats().installs,0);
});
test('protected binding activated during an awaited import still prevents installation',async()=>{
  const f=fixture({hold:true}),pending=f.initializePracticeHistory();
  f.Physics.prototype[Symbol.for('polytrack-native-local-binding')]=true;f.release();await pending;
  assert.equal(f.stats().installs,0);
});
test('native guard rejection is terminal, while other install failures can retry',async()=>{
  for(const error of ['practice_binding_already_active','practice_native_contract']){
    const f=fixture({installError:error});await f.initializePracticeHistory();const before=f.stats().installs;
    f.options.installError='';f.advance(60000);await f.initializePracticeHistory();
    assert.equal(f.stats().installs,before+(error==='practice_binding_already_active'?0:1));
  }
});
test('readiness completes before caller creates a car and installs proof binding',async()=>{
  const f=fixture();await f.initializePracticeHistory();
  assert.equal(f.stats().installs,1);
  f.Physics.prototype[Symbol.for('polytrack-native-local-binding')]=true;
  await f.initializePracticeHistory();assert.equal(f.stats().installs,1);
  assert.equal(f.logs.length,0,'working observation must not produce a blocked warning');
});

for(const path of ['marker','native guard']){
  test('terminal '+path+' path warns exactly once across concurrent and future readiness calls',async()=>{
    const f=fixture(path==='marker'?{marker:true}:{installError:'practice_binding_already_active'});
    await Promise.all([f.initializePracticeHistory(),f.initializePracticeHistory()]);
    const installs=f.stats().installs;
    for(let i=0;i<4;i++){f.advance(60000);await f.initializePracticeHistory();}
    assert.equal(f.getState().practiceBindingBlocked,true);
    assert.equal(f.stats().installs,installs,'no installation retry after terminal block');
    assert.deepEqual(f.logs,[['warn','[PRACTICE403] Local driving tracking unavailable until reload']]);
    assert.equal(installs,path==='marker'?0:1);
  });
}

test('browser failed import gets a fresh URL while a successful module stays a singleton',async t=>{
  const root=process.env.PRACTICE_STARTUP_REPO;
  const require=createRequire(root?pathToFileURL(root+'/tools/verifier/package.json'):new URL('./verifier/package.json',import.meta.url));
  const {chromium}=require('playwright');
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage();const requests=[];
  await page.route('**/*',route=>{
    const url=new URL(route.request().url());
    if(url.pathname.endsWith('.mjs')){
      requests.push(url.pathname+url.search);
      return route.fulfill({status:requests.length===1?503:200,contentType:'text/javascript',body:requests.length===1?'unavailable':'export const singleton={};'});
    }
    return route.fulfill({contentType:'text/html',body:'<!doctype html><title>Offline startup import fixture</title>'});
  });
  await page.goto('http://practice.test/');
  const helper=source.slice(source.indexOf('  const practiceStartupImports'),source.indexOf('  function initializePracticeResources'));
  const result=await page.evaluate(async helper=>{
    const load=new Function(helper+';return importPracticeStartupModule;')();
    let rejected=false;try{await load('./tools/practice-native.mjs?v=183');}catch{rejected=true;}
    const first=await load('./tools/practice-native.mjs?v=183'),second=await load('./tools/practice-native.mjs?v=183');
    return {rejected,same:first===second&&first.singleton===second.singleton};
  },helper);
  assert.deepEqual(result,{rejected:true,same:true});
  assert.deepEqual(requests,['/tools/practice-native.mjs?v=183','/tools/practice-native.mjs?v=183&practiceRetry=1']);
});
