import test from 'node:test';
import assert from 'node:assert/strict';
import {installUsageAnalytics} from './usage-analytics.mjs';
import {createLocalInsights} from './local-insights.mjs';

function fixture({allowed=true,deployment='github',initial=true}={}){
  let at=1000000,interval,delay,cleared=0;
  const events=[],docHandlers=new Map(),winHandlers=new Map();
  const insights=createLocalInsights({now:()=>at});
  if(initial)insights.observeUsage({source:'firestore',reads:20,writes:10});
  const document={visibilityState:'visible',addEventListener:(n,f)=>docHandlers.set(n,f),removeEventListener:n=>docHandlers.delete(n)};
  const window={__polytrackAnalyticsAllowed:allowed,__polytrackAnalyticsDeployment:deployment,
    gtag:(...args)=>events.push(args),addEventListener:(n,f)=>winHandlers.set(n,f),removeEventListener:n=>winHandlers.delete(n)};
  const options={document,window,revision:239,readUsage:()=>insights.usageSnapshot(),now:()=>at,
    setInterval:(fn,ms)=>{interval=fn;delay=ms;return 1;},clearInterval:()=>cleared++};
  return {options,document,window,events,insights,advance:ms=>at+=ms,flush:()=>interval?.(),hide:()=>{document.visibilityState='hidden';docHandlers.get('visibilitychange')?.();},
    end:()=>winHandlers.get('pagehide')?.(),get delay(){return delay;},get cleared(){return cleared;},get listeners(){return docHandlers.size+winHandlers.size;}};
}

test('opt-in owned deployments emit bounded count deltas, not historical usage or private data',()=>{
  for(const deployment of ['github','google_embed']){
    const f=fixture({deployment});installUsageAnalytics(f.options);
    assert.equal(f.delay,900000);assert.equal(f.events.length,0);
    f.insights.observeUsage({source:'firestore',reads:2,writes:1});f.insights.observeUsage({source:'worker'});
    f.insights.observeUsage({source:'snapshot'});f.insights.observeUsage({source:'cache'});
    f.insights.play('a'.repeat(64));f.insights.navigate('b'.repeat(64));f.advance(120000);f.flush();
    assert.equal(f.events.length,1);
    assert.deepEqual(f.events[0],['event','polytrack_client_usage',{send_to:'G-QXB7CHLEDT',event_schema:1,usage_scope:'client_observed',client_revision:239,
      deployment_group:deployment,interval_seconds:120,fs_reads_est:2,fs_writes_est:1,fs_unknown_reads:0,fs_unknown_writes:0,worker_ops:1,snapshot_ops:1,cache_ops:1}]);
    f.flush();f.hide();f.end();assert.equal(f.events.length,1,'same delta is not reported twice');
  }
});

test('first session without stored counters still reports its new observed usage',()=>{
  const f=fixture({initial:false});installUsageAnalytics(f.options);f.advance(1000);
  f.insights.observeUsage({source:'firestore',writes:1});f.advance(5000);f.end();
  assert.equal(f.events.length,1);assert.equal(f.events[0][2].fs_unknown_reads,1);assert.equal(f.events[0][2].fs_reads_est,0);
});

test('not allowed, unknown deployment or malformed revision installs nothing',()=>{
  for(const patch of [{allowed:false},{deployment:'fork'}]){
    const f=fixture(patch);installUsageAnalytics(f.options);assert.equal(f.listeners,0);assert.equal(f.delay,undefined);
  }
  const f=fixture();installUsageAnalytics({...f.options,revision:'239'});assert.equal(f.listeners,0);
});

test('missing/blocked analytics and thrown observers never interfere with gameplay',()=>{
  const f=fixture();delete f.window.gtag;installUsageAnalytics(f.options);
  f.insights.observeUsage({source:'firestore',reads:3,writes:0});f.advance(900000);assert.doesNotThrow(f.flush);assert.equal(f.events.length,0);
  f.window.gtag=()=>{throw Error('blocked');};assert.doesNotThrow(f.end);
  f.window.gtag=(...args)=>f.events.push(args);f.flush();assert.equal(f.events[0][2].fs_reads_est,3);
  const g=fixture();installUsageAnalytics({...g.options,readUsage:()=>{throw Error('unavailable');}});assert.doesNotThrow(g.flush);
});

test('coarse minimum interval, idle suppression, event cap and disposal bound overhead',()=>{
  const f=fixture();const dispose=installUsageAnalytics(f.options);assert.equal(installUsageAnalytics(f.options),dispose);
  for(let i=0;i<140;i++){
    f.insights.observeUsage({source:'cache'});f.advance(60000);f.flush();
    f.insights.observeUsage({source:'cache'});f.hide();
  }
  assert.equal(f.events.length,128);
  dispose();dispose();assert.equal(f.cleared,1);assert.equal(f.listeners,0);
  f.advance(900000);f.flush();assert.equal(f.events.length,128);
});

test('invalid counters never become negative or fabricated known reads',()=>{
  const f=fixture();let usage=f.insights.usageSnapshot();installUsageAnalytics({...f.options,readUsage:()=>usage});
  for(const value of [-1,NaN,Infinity,1.5,'20']){usage=structuredClone(usage);usage.buckets.firestore.knownReadEstimate=value;f.advance(900000);f.flush();}
  assert.equal(f.events.length,0);
});

test('observer snapshot is detached and does not expose track history',()=>{
  const f=fixture();f.insights.play('a'.repeat(64));const before=f.insights.usageSnapshot();
  assert.deepEqual(Object.keys(before).sort(),['buckets','startedAt','version']);before.buckets.firestore.knownReadEstimate=900;
  assert.equal(f.insights.usageSnapshot().buckets.firestore.knownReadEstimate,20);
});
