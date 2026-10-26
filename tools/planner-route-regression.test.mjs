import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {savedEventPlannerRoutes} from './event-planner-model.mjs';
const source=await fs.readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const candidate=source;
const fragment=id=>{
  const name=id==='event-cache-boundary'?'cachedProfileGuideMarkup':id;
  const start=source.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));
  assert.ok(start>=0,'missing '+name);
  const rest=source.slice(start);
  const end=rest.search(/\n(?:  (?:async )?function |const plannerPositive=)/);
  assert.ok(end>0,'missing end of '+name);
  return rest.slice(0,end);
};
const order=new Function(fragment('orderedPlannerRoutes')+';return orderedPlannerRoutes;')();
const route=(trackId,value,effortScore,extra={})=>({trackId,value,weight:1,currentRank:5,targetRank:1,kind:'improve',ease:{effortScore},...extra});
const percentage=(value,max)=>!Number.isFinite(value)||!Number.isFinite(max)||value<=0||max<=0?0:Math.max(1,Math.min(100,Math.round(100*value/max)));

// Entirely synthetic assignment metadata and standings; no live fixture needed.
const periods=['daily','weekly','kodub'].map((kind,i)=>({id:'test_'+kind,kind,trackId:String(i+1).repeat(64),
  startsAt:100,endsAt:10000,maxRp:[100,500,700][i],scoringVersion:'time-gap-v2',targetMs:10000+i*1000}));
const at=Math.min(...periods.map(p=>p.endsAt))-1;
const score=(p,t)=>p.scoringVersion==='time-gap-v2'?Math.max(1,Math.min(p.maxRp,Math.round(p.maxRp/(1+Math.exp(8*(t/p.targetMs-1)-Math.log(4)))))):Math.min(p.maxRp,Math.floor(p.maxRp*p.targetMs/t));
const boards=()=>Object.fromEntries(periods.map(p=>[p.id,{period:p,updatedAt:at-100,complete:true,totalEntries:1,
  entries:[{accountId:'me',timeMs:p.targetMs*2,rp:score(p,p.targetMs*2)}]}]));
const permanent=()=>({id:'permanent-rolling-hills',kind:'permanent',trackId:'fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778',
  scoreVersion:'rolling-hills-live-verified-v1',maxRp:1001,targetMs:10000,updatedAt:at-100,sourceRevision:1,complete:true,totalEntries:2,
  entries:[{accountId:'fast',timeMs:10000,rp:1001},{accountId:'me',timeMs:20000,rp:500}]});
const run=(b=boards(),p=permanent(),c={periods},best={})=>savedEventPlannerRoutes(c,b,p,best,'me','rival',at);

test('integrated patch parses and preview event routes remain storage-only',()=>{
  new vm.Script(source);
  assert.doesNotMatch(fragment('eventPlannerRoutes'),/\b(?:fetch|rankedFetch|eventCloudRead|readDirectPublicSnapshot)\s*\(/);
});
test('Summer1 percent, chosen target and reference remain stable across five sorts and subsets',()=>{
  const rows=[route('Summer1',80,.1),route('best',100,9),route('small',11,.01)];
  for(const sort of ['practice','impact','ease','training','benefit-ease']){
    const all=order([],rows,99,sort),summer=all.find(r=>r.trackId==='Summer1');
    assert.equal(percentage(summer.value,summer.benefitReference),80);
    const subset=all.filter(r=>r.trackId==='Summer1').slice(0,1);
    assert.equal(percentage(subset[0].value,subset[0].benefitReference),80);
    assert.equal(summer.targetRank,1);
    assert.equal(order([],rows,1,sort)[0].benefitReference,100);
  }
  assert.equal(order([],rows,99,'impact')[0].trackId,'best');
  assert.equal(order([],rows,99,'ease')[0].trackId,'small');
});
test('duplicate track targets are chosen before ordering, including rival context',()=>{
  const rivals=[route('Summer1',80,8,{kind:'rival',targetRank:2})],personal=[route('Summer1',11,.1,{targetRank:4})];
  for(const sort of ['practice','impact','ease','training','benefit-ease']){
    const [r]=order(rivals,personal,8,sort);assert.equal(r.value,80);assert.equal(r.targetRank,2);
  }
});
test('recommendation target is independent of selected sort using actual patched function',()=>{
  const get=new Function('plannerSort',`const projectedOverallScore=()=>100;
    const recommendationSimulator=()=>rank=>rank===1?20:rank===2?40:90;
    const knownFinishWeight=()=>1,projectedFinish=x=>x,rankedTrackWeight=()=>1;
    ${fragment('recommendationAction')} return recommendationAction;`);
  for(const sort of ['practice','impact','ease','training','benefit-ease']){
    const r=get(sort)({trackId:'Summer1',rank:4,fieldSize:5},'improve',{raceCount:1},[{trackId:'Summer1',rank:4,fieldSize:5}]);
    assert.equal(r.targetRank,1);assert.equal(r.value,80);
  }
});
test('all four event kinds from local assignment metadata are eligible, no eight-card truncation',()=>{
  const rows=run();assert.equal(rows.length,4);assert.deepEqual(new Set(rows.map(r=>r.period.kind)),new Set(['daily','weekly','kodub','permanent']));
  assert.equal(rows.missing.length,0);assert.equal(rows.dataAvailable,true);
  for(const r of rows)assert.equal(r.benefitReference,Math.max(...rows.map(r=>r.gain)));
});
test('v2 displayed target earns 80 percent, not a fabricated full cap',()=>{
  for(const r of run().filter(r=>r.period.kind!=='permanent')){
    assert.equal(r.targetRp,Math.round(.8*r.period.maxRp));assert.equal(r.gain,r.targetRp-r.currentRp);
    assert.ok(score(r.period,r.minimumTime)>r.currentRp);
    if(r.minimumTime<300000)assert.ok(score(r.period,r.minimumTime+1)<=r.currentRp);
  }
});
test('v2 next target above frozen target uses exact rounded cap threshold',()=>{
  const b=boards();for(const p of periods)b[p.id].entries=[{accountId:'me',timeMs:p.targetMs,rp:score(p,p.targetMs)}];
  for(const r of run(b).filter(r=>r.period.kind!=='permanent')){
    assert.equal(r.targetRp,r.period.maxRp);assert.ok(r.targetTime<r.period.targetMs);
    assert.equal(score(r.period,r.targetTime),r.period.maxRp);assert.ok(score(r.period,r.targetTime+1)<r.period.maxRp);
  }
});
test('ratio and curve numerics match actual Worker eventRp implementation offline',async()=>{
  const worker=await fs.readFile(new URL('../workers/ranked/src/events.js',import.meta.url),'utf8');
  const text=worker.slice(worker.indexOf('export function eventRp('),worker.indexOf('export function exhaustedEventLease(')).replace('export ','');
  const canonical=new Function('periodBinding','demand','L','int','EVENT_SCORING_V2',text+';return eventRp;')(()=>{},()=>{},{timeMs:300000},
    (n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max,'time-gap-v2');
  for(const version of ['time-ratio-v1','time-gap-v2'])for(const t of [1,2000,10000,10001,50000,300000]){
    const p={...periods[0],scoringVersion:version,targetMs:10000};assert.equal(score(p,t),canonical(p,t));
    const b={[p.id]:{period:p,updatedAt:at,complete:true,entries:[{accountId:'me',timeMs:t,rp:canonical(p,t)}]}};
    const r=run(b,null,{periods:[p]});assert.equal(r.dataAvailable,true);
    if(r.length)assert.equal(r[0].currentRp,canonical(p,t));
  }
});
test('missing, partial, expired, disabled, schedule-only and mismatched events fail closed',()=>{
  for(const mutate of [b=>delete b[periods[0].id],b=>{b[periods[0].id].period={...periods[0],trackId:'f'.repeat(64)};},
    b=>{b[periods[0].id].period={...periods[0],targetMs:1};},b=>{b[periods[0].id].entries[0].rp=9999;},
    b=>{b[periods[0].id].entries=[];b[periods[0].id].complete=false;},b=>{b[periods[0].id].period={...periods[0],scheduleOnly:true};}]){
    const b=boards();mutate(b);const r=run(b);assert.equal(r.length,3);assert.ok(r.missing.includes(periods[0].id));
  }
  assert.equal(run({},null).length,0);assert.equal(run({},null).dataAvailable,false);
  assert.equal(run(boards(),null,{periods:periods.map(p=>({...p,enabled:false}))}).length,0);
  assert.equal(savedEventPlannerRoutes({periods},boards(),null,{},'me',null,Math.max(...periods.map(p=>p.endsAt))).length,0);
});
test('withheld target uses observed published pair, never reverse engineers a target',()=>{
  const p={...periods[2]};delete p.targetMs;
  const b={[p.id]:{period:p,updatedAt:at,complete:true,entries:[{accountId:'me',timeMs:20000,rp:10},{accountId:'rival',timeMs:10000,rp:100}]}};
  const [r]=run(b,null,{periods:[p]});assert.equal(r.gain,90);assert.equal(r.targetTime,10000);assert.equal(r.targetRp,100);
  assert.equal(r.minimumTime,null);assert.equal(r.observedTarget,true);
  b[p.id].entries.pop();assert.equal(run(b,null,{periods:[p]}).length,0);
});
test('local attempts never award points, pending/duplicate rows do not become verified',()=>{
  const base=run(),best=Object.fromEntries(periods.map(p=>[p.id+'_me',{timeMs:1}]));
  const local=run(boards(),permanent(),{periods},best);assert.deepEqual(local.map(r=>r.currentRp),base.map(r=>r.currentRp));
  for(const mutate of [b=>{b[periods[0].id].entries[0].pending=true;},b=>{b[periods[0].id].entries.push(b[periods[0].id].entries[0]);}]){
    const b=boards();mutate(b);assert.equal(run(b).length,3);
  }
});
test('permanent board binding, source cap and missing target remain bounded',()=>{
  assert.equal(run().find(r=>r.period.kind==='permanent').gain,501);
  for(const patch of [{targetMs:null},{maxRp:1000},{complete:false},{trackId:'a'.repeat(64)},{scoreVersion:'future'}])
    assert.equal(run(boards(),{...permanent(),...patch}).length,3);
});
test('event wrapper only reads local storage; all four cards keep existing event navigation attributes',()=>{
  const saved={'polytrack-062-events-v1':{periods},'polytrack-062-events-v1-permanent':permanent()};
  for(const [id,b] of Object.entries(boards()))saved['polytrack-062-events-v1-'+id]=b;
  const readJsonStorage=(key,fallback)=>saved[key]||fallback;
  const fn=new Function('readJsonStorage',fragment('eventPlannerRoutes')+';return eventPlannerRoutes;')(readJsonStorage);
  const rows=fn('me','rival',at);assert.equal(rows.length,4);
  const markup=new Function('deps',`const {escapeHtml,safeDisplayName,trackThumbnailMarkup,trackInfo,formatRaceTime,routeBenefitPercent,plannerFilterMarkup,PLANNER_METRICS}=deps;
    ${fragment('eventPlannerMarkup')}; return eventPlannerMarkup;`)({escapeHtml:String,safeDisplayName:x=>x,trackThumbnailMarkup:()=>'',trackInfo:id=>({name:id}),
      formatRaceTime:String,routeBenefitPercent:percentage,plannerFilterMarkup:()=>'',PLANNER_METRICS:{events:'Event RP'}});
  const html=markup({name:'Me'},null,true,rows,{events:true});
  for(const kind of ['daily','weekly','kodub','permanent'])assert.ok(html.includes('data-event-kind="'+kind+'"'));
  assert.match(html,/at this target/);assert.doesNotMatch(html,/strongest shown/);
  const one=Object.assign(rows.filter(r=>r.period.kind==='daily'),{dataAvailable:true});
  const filtered=markup({name:'Me'},null,true,one,{events:true});
  assert.ok(filtered.includes('<b>'+percentage(one[0].gain,one[0].benefitReference)+'%</b>'));
});
test('integration selects after normalization, preserves practice inputs and avoids event cache boundary reuse',()=>{
  const p=fragment('profileGuideMarkup');
  assert.match(p,/Number.MAX_SAFE_INTEGER,plannerSort\)\.filter\(action=>plannerTrackAllowed/);
  assert.ok(!p.includes('action&&plannerTrackAllowed(action.trackId,played)&&TRACK_CATALOG'));
  assert.match(p,/benefitReference:Math.max\(0,\.\.\.allCarrying/);
  assert.match(p,/Same target|All sorts retain the same target/);
  assert.match(fragment('event-cache-boundary'),/if\(plannerMetric==='events'\)return profileGuideMarkup/);
});
test('card percentage ignores shown maximum and explicitly distinguishes benefit from ease',()=>{
  const render=new Function('deps',`const {trackInfo,routeBenefitPercent,helpfulThresholdText,ageLabel,rankedWeightTitle,escapeHtml,trackThumbnailMarkup}=deps;
    ${fragment('guideTrackCard')};return guideTrackCard;`)({trackInfo:()=>({name:'Summer1'}),routeBenefitPercent:percentage,helpfulThresholdText:()=>'',
      ageLabel:()=>'',rankedWeightTitle:()=>'',escapeHtml:String,trackThumbnailMarkup:()=>''});
  const r={...route('Summer1',80,.1),benefitReference:100};
  assert.equal(render(r,80),render(r,1000));assert.match(render(r,80),/<b>80%<\/b>/);
  assert.match(render(r,80),/Ease and practice affect order only/);
  assert.match(render({...r,kind:'carry'},1),/Not improvement benefit/);
});
test('actual async profile path retains reference across sorts and current/official filters',async()=>{
  const original=await fs.readFile(new URL('./planner-filters.test.mjs',import.meta.url),'utf8');
  const harnessText=original.slice(original.indexOf('function harness('),original.indexOf('const finishes='));
  const harness=new Function('source','vm','rhr',harnessText+';return harness;')(candidate,vm,permanent().trackId);
  const finishes=['official','community',permanent().trackId].map(trackId=>({trackId,rank:5,fieldSize:20,timeMs:20000,weight:3}));
  for(const sort of ['practice','impact','ease','training','benefit-ease'])for(const current of [true,false])for(const official of [true,false]){
    const h=harness(current,official),captured=[];h.context.plannerSort=sort;
    vm.runInContext(fragment('orderedPlannerRoutes'),h.context);
    const previous=h.context.recommendationAction;
    h.context.recommendationAction=(...args)=>({...previous(...args),value:args[0].trackId==='official'?80:args[0].trackId===permanent().trackId?100:11});
    h.context.guideTrackCard=action=>{captured.push(action);return '<button>route</button>';};
    await h.context.profileGuideMarkup({userId:'self',name:'Me',raceCount:3},null,true,finishes,finishes,[]);
    const summer=captured.find(r=>r.trackId==='official');
    assert.equal(summer.benefitReference,100);assert.equal(percentage(summer.value,summer.benefitReference),80);
  }
});
test('event input is bounded to 120 periods, not limited to eight visible routes',()=>{
  // Synthetic period identities only for exercising input bounds.
  const ps=Array.from({length:125},(_,i)=>({...periods[0],id:'test_'+i}));
  const b=Object.fromEntries(ps.map(p=>[p.id,{period:p,complete:true,updatedAt:at,entries:[]} ]));
  const rows=run(b,null,{periods:ps});assert.equal(rows.length,120);
  assert.equal(savedEventPlannerRoutes({periods:ps},b,null,{},null,null,at).length,0);
  assert.equal(savedEventPlannerRoutes({periods:ps},b,null,{},'me',null,NaN).length,0);
});
