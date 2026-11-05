import test from 'node:test';import assert from 'node:assert/strict';import {createLocalInsights} from './local-insights.mjs';
const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64);
test('prediction needs repeated strong transitions, resets do not inflate visits',()=>{const h=createLocalInsights();h.play(a);h.play(a);assert.equal(h.report().tracks[a].plays,1);assert.equal(h.predict(a),null);for(let n=0;n<5;n++){h.play(b);h.play(a);}assert.equal(h.predict(a).trackId,b);assert.equal(h.predict(a).confidence,1);});
test('intent expires and source names are whitelisted',()=>{let time=1;const h=createLocalInsights({now:()=>time});h.navigate(a,'planner');time+=120001;h.play(a);assert.equal(h.report().tracks[a].sources.selection,1);h.navigate(b,'planner');h.play(b);assert.equal(h.report().tracks[b].sources.planner,1);});
test('latency summaries include true slow percentages and survive reload',()=>{let value;const storage={getItem:()=>value,setItem:(_,v)=>value=v};const h=createLocalInsights({storage,revision:156});h.measure('BOARD',1000);h.measure('BOARD',6000);h.measure('BOARD',NaN);h.flush(true);const r=createLocalInsights({storage,revision:157}).report();assert.equal(r.metrics.BOARD.averageMs,3500);assert.equal(r.metrics.BOARD.over5sPercent,50);assert.deepEqual(r.revisions.map(r=>r.revision),[156,157]);});
test('untrusted stored fields cannot export credentials',()=>{const h=createLocalInsights({storage:{getItem:()=>JSON.stringify({version:1,token:'secret',tracks:{[a]:{plays:2,token:'secret'}},actions:{'https://private':4}})}});assert.doesNotMatch(JSON.stringify(h.report()),/secret|private/);});

test('leaving and re-entering the same track counts a visit, not a transition to itself',()=>{const h=createLocalInsights();h.play(a);h.leave();h.play(a);assert.equal(h.report().tracks[a].plays,2);assert.equal(Object.keys(h.report().transitions).length,0);});
test('visible time is attributed to the observed release without inventing older history',()=>{const h=createLocalInsights({revision:156});h.observeVisible(1000);assert.equal(h.report().revisions[0].visibleMs,1000);assert.equal(h.report().revisions.length,1);});

test('current timestamps survive storage reload without counter clamping',()=>{const at=1792280000000;let value;const storage={getItem:()=>value,setItem:(_,v)=>value=v};const first=createLocalInsights({storage,revision:156,now:()=>at});first.play(a);first.flush(true);const saved=createLocalInsights({storage,revision:156,now:()=>at+1000}).report();assert.equal(saved.startedAt,at);assert.equal(saved.revisions[0].firstAt,at);assert.equal(saved.tracks[a].lastAt,at);});

test('failed storage writes stay throttled without deleting game data',()=>{let writes=0;const h=createLocalInsights({now:()=>100000,storage:{getItem:()=>null,setItem(){writes++;throw Error('quota');}}});for(let n=0;n<100;n++)h.action('planner-open');assert.equal(writes,1);assert.equal(h.report().actions['planner-open'],100);});
test('extreme latency outliers are counted but capped in the average and maximum',()=>{
 let value;const storage={getItem:()=>value,setItem:(_,next)=>value=next};
 const h=createLocalInsights({storage});h.measure('TRACK',100);h.measure('TRACK',3600000);h.flush(true);
 const metric=createLocalInsights({storage}).report().metrics.TRACK;
 assert.equal(createLocalInsights({storage}).report().latencyCapMs,30000);
 assert.equal(metric.count,2);assert.equal(metric.totalMs,30100);assert.equal(metric.averageMs,15050);
 assert.equal(metric.maxMs,30000);assert.equal(metric.over5s,1);assert.equal(metric.over30s,1);
 assert.equal(metric.over5sPercent,50);assert.equal(metric.over30sPercent,50);
});


test('one malformed stored row cannot erase unrelated valid local history on recovery',()=>{
  const saved={version:1,startedAt:1,revisions:[null,{revision:239,firstAt:1,lastAt:2,visits:4,visibleMs:10}],
    tracks:{[a]:null,[b]:{plays:7,lastAt:2,sources:{profile:3}}},
    metrics:{BROKEN:null,BOARD:{count:2,totalMs:40,maxMs:30}},actions:{'open-profile':5}};
  let raw=JSON.stringify(saved);
  const storage={getItem:()=>raw,setItem:(_key,value)=>{raw=value;}};
  const h=createLocalInsights({storage,revision:240,now:()=>100});
  assert.equal(h.report().tracks[b]?.plays,7);
  assert.equal(h.report().metrics.BOARD?.count,2);
  assert.equal(h.report().actions['open-profile'],5);
  assert.equal(h.report().revisions.find(row=>row.revision===239)?.visits,4);
  assert.equal(h.report().tracks[a],undefined);
  h.flush(true);
  assert.equal(createLocalInsights({storage,revision:240,now:()=>101}).report().tracks[b]?.plays,7);
});

test('malformed revision container does not discard valid track and action history',()=>{
  const saved={version:1,revisions:{},tracks:{[a]:{plays:3,lastAt:2}},actions:{'open-profile':2}};
  const h=createLocalInsights({storage:{getItem:()=>JSON.stringify(saved)},revision:240,now:()=>100});
  assert.equal(h.report().tracks[a]?.plays,3);
  assert.equal(h.report().actions['open-profile'],2);
});
