import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {Socket} from 'node:net';
import {eventRunErpPresentation,decorateEventErpBadge,eventPeriodDisplayName,eventRpFilterRows,sourceBoundEventPlacement,eventRowVerified,preferPermanentRollingSource,permanentRollingPolicy} from './client.mjs';
import {capturedEventRp} from '../workers/ranked/src/events.js';
globalThis.fetch=()=>assert.fail('Zero network in ERP UI tests');Socket.prototype.connect=globalThis.fetch;
const hash=n=>n.toString(16).padStart(64,'0');
const period=(kind='weekly',extra={})=>({id:kind+'-fixture',kind,trackId:hash(9),startsAt:1000,endsAt:10000,targetMs:10000,maxRp:kind==='daily'?100:kind==='kodub'?700:500,scoringVersion:'time-gap-v2',trackName:'Exact Track',...extra});
const row=(id=1,extra={})=>({accountId:hash(id),timeMs:12000,rp:123,rank:2,physicsVerified:true,replayIntegrityVerified:true,...extra});
const waiting=(extra={})=>row(1,{pending:true,verified:false,eventRpEligible:false,verificationStatus:'waiting',source:'pending-event-playback',...extra});
const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
function fn(name,end){const a=source.indexOf('  function '+name+'('),b=source.indexOf(end,a);assert(a>=0&&b>a);return source.slice(a,b);}
for(const kind of ['daily','weekly','kodub'])for(const scoringVersion of ['time-ratio-v1','time-gap-v2'])test(kind+' provisional hover matches its EXISTING '+scoringVersion+' formula and cap without awarding points',()=>{
 const p=period(kind,{scoringVersion}),pending=waiting({rp:999999,periodId:p.id,trackId:p.trackId}),before=structuredClone(pending);
 const result=eventRunErpPresentation(pending,{period:p},p,5000);
 assert.equal(result.estimated,true);assert.match(result.text,new RegExp('Estimated '+capturedEventRp(p,pending.timeMs)+' ERP if verified'));
 assert.match(result.title,/No ERP is awarded yet/);assert.deepEqual(pending,before);
});
test('unscored, held, wrong-period, inactive, unknown and schedule-only previews never imply awards or eligibility',()=>{
 const p=period(),board={period:p};
 for(const [r,b,value,at] of [[waiting(),board,p,999],[waiting(),board,p,10000],[waiting(),board,{...p,id:'other'},5000],
  [waiting({unscored:true}),board,p,5000],[waiting({reviewHold:true}),board,p,5000],
  [waiting(),{period:{...p,scoringVersion:'future'}},{...p,scoringVersion:'future'},5000],
  [waiting(),{period:{...p,scheduleOnly:true}},{...p,scheduleOnly:true},5000]]){
  const shown=eventRunErpPresentation(r,b,value,at);assert.equal(shown.estimated,false);assert.doesNotMatch(shown.text,/123|999999|if verified/);
 }
});
test('actual per-run ERP uses the saved award, not a formula, lifetime total or cap',()=>{
 const p=period();const r=row(1,{rp:4321}),before=structuredClone(r);
 assert.equal(eventRunErpPresentation(r,{period:p},p,5000).text,'4,321 ERP');assert.deepEqual(r,before);
});
test('badge ERP text is supplemental and cannot change verification classes or proof',()=>{
 const attrs={},icon={},points=[],state={dataset:{},title:'date',querySelector:()=>icon,setAttribute:(k,v)=>attrs[k]=v,prepend:node=>points.push(node)};
 const button={querySelector:()=>state,ownerDocument:{createElement:()=>({})}};
 const p=period(),r=waiting(),before=structuredClone(r);decorateEventErpBadge(button,r,{period:p},p,5000);
 assert.equal(state.dataset.sqEventErpStatus,'estimated');assert.match(icon.title,/Would earn approximately/);assert.match(points[0].textContent,/Estimated/);assert.deepEqual(r,before);
});
test('Weekly labels use track names, never reset dates as names',()=>{
 assert.equal(eventPeriodDisplayName(period()),'Weekly - Exact Track');
 assert.equal(eventPeriodDisplayName(period('weekly',{trackName:undefined,label:'Weekly 2026-11-14'}),()=>({name:'Catalog Track'})),'Weekly - Catalog Track');
});
const totals={complete:true,entries:[row(1,{rp:1100,finiteEventRp:600,permanentRollingHillsRp:500,rollingHillsEventRpContribution:500,rollingHillsTimeMs:12000,events:3}),row(2,{rp:200,finiteEventRp:200,permanentRollingHillsRp:0,events:2})]};
test('All counts Rolling Hills exactly once and Seasonal excludes only its published component',()=>{
 const before=structuredClone(totals),all=eventRpFilterRows(totals),seasonal=eventRpFilterRows(totals,'seasonal'),rolling=eventRpFilterRows(totals,'rolling');
 assert.deepEqual(all.entries.map(r=>[r.rp,r.events]),[[1100,4],[200,2]]);
 assert.deepEqual(seasonal.entries.map(r=>[r.rp,r.events]),[[600,3],[200,2]]);
 assert.deepEqual(rolling.entries.map(r=>[r.rp,r.events]),[[500,1]]);assert.deepEqual(totals,before);
 assert.equal(eventRpFilterRows(totals).entries[0].events,4,'repeated filtering does not stack counts');
});
test('missing or contradictory components are unavailable, not invented zero awards',()=>{
 const partial={entries:[row(1,{rp:1000,events:5}),row(2,{rp:1000,finiteEventRp:600,permanentRollingHillsRp:300})]};
 assert.equal(eventRpFilterRows(partial,'seasonal').entries.length,0);assert.equal(eventRpFilterRows(partial,'seasonal').unavailable,2);
 assert.equal(eventRpFilterRows(partial).entries[1].events,null);
});
for(const kind of ['daily','weekly','kodub'])test(kind+' view sums saved published rows once per period and labels partial lifetime coverage',()=>{
 const p=period(kind),b={period:p,entries:[row(1,{rp:100}),row(2,{rp:20}),waiting({accountId:hash(3),rp:999})]};
 const clean={...b,entries:b.entries.slice(0,2)};
 const view=eventRpFilterRows(totals,kind,[clean,clean]);assert.equal(view.entries[0].rp,100);assert.equal(view.entries[0].events,1);
 assert.equal(view.boardCount,1);assert.match(view.title,/not lifetime totals/);assert.equal(view.scope,'saved-event-boards');
 assert.equal(eventRpFilterRows(totals,kind,[b]).entries.length,0,'mixed unverified board is not scored locally');
});
const placementBoard=(timeMs,updatedAt=2000)=>({period:period(),complete:true,totalEntries:2,updatedAt,sourceRevision:updatedAt,_eventSnapshotEpoch:1,
 entries:timeMs<150?[row(1,{timeMs,rank:1}),row(2,{timeMs:150,rank:2})]:[row(2,{timeMs:150,rank:1}),row(1,{timeMs,rank:2})]});
test('historical movement requires two exact complete published placements, not a field-size guess',()=>{
 const p=period(),old=sourceBoundEventPlacement(placementBoard(200,1000),p,hash(1),200,1);
 const c={sessions:{current:()=>({periodId:p.id})},eventIntent:null,latestFinish:{periodId:p.id,trackId:p.trackId,accountId:hash(1),timeMs:100,previousPlacement:old},
  knownPeriods:new Map([[p.id,p]]),cache:new Map([[p.id,placementBoard(100)]]),bridge:{normalEventSnapshotEpoch:()=>1},sourceBoundEventPlacement};
 vm.createContext(c);vm.runInContext(fn('finishPositions','  async function prepareCapture('),c);
 assert.deepEqual(JSON.parse(JSON.stringify(c.finishPositions(p.trackId,hash(1),100))),{newPosition:1,previousPosition:2});
 c.latestFinish.previousPlacement=null;assert.equal(c.finishPositions(p.trackId,hash(1),100),null);
 c.latestFinish.previousPlacement=old;c.cache.set(p.id,{...placementBoard(100),complete:false});assert.equal(c.finishPositions(p.trackId,hash(1),100),null);
 c.cache.set(p.id,{...placementBoard(100),_eventSnapshotEpoch:2});assert.equal(c.finishPositions(p.trackId,hash(1),100),null);
});
test('source-bound placement rejects contradictory row identity and held proof',()=>{
 const p=period(),b=placementBoard(100);
 for(const change of [{reviewHold:true},{periodId:'other'},{trackId:hash(8)},{rank:2},{pending:true}])
 assert.equal(sourceBoundEventPlacement({...b,entries:[{...b.entries[0],...change},b.entries[1]]},p,hash(1),100,1),null);
});

function totalsHarness({delay=false}={}){
 let account=hash(1),epoch=1,resolve;const output=[],requests=[],disk=new Map(),p=period('daily'),gate=delay?new Promise(done=>resolve=done):null;
 const context={totalsMemo:null,totalsBoardRequests:new Map(),permanentAcceptedSource:null,dialog:{},requestId:0,selected:null,
  catalog:{periods:[p]},now:()=>5000,shell(){},selectView(){},body:html=>output.push(html),
  bridge:{accountId:()=>account,normalEventSnapshotEpoch:()=>epoch,readTotals:async()=>totals,
   readStaticArchiveCatalog:async()=>({archives:[]}),readStaticEventSnapshot:async id=>{requests.push(id);await gate;return {period:p,entries:[row(1,{rp:100})]};},
   readSnapshot:()=>assert.fail('No live event fetch'),readReplay:()=>assert.fail('No replay prefetch'),
   openRankedEvents:()=>assert.fail('Do not route filter UI into the parent monolith')},
  preferPermanentRollingSource,permanentRollingPolicy,eventRpFilterRows,EVENT_RECORD_HASH:/^[a-f0-9]{64}$/,STORE:'events',
  read:(key,fallback)=>disk.get(key)||fallback,cacheWrite:(key,value)=>disk.set(key,value),escape:String,displayName:r=>r.name||'Racer'};
 vm.createContext(context);const start=source.indexOf('  async function totals('),end=source.indexOf('  async function archives(',start);
 vm.runInContext(source.slice(start,end),context);
 return {run:filter=>context.totals(filter),output,requests,resolve:()=>resolve?.(),change:kind=>{if(kind==='account')account=hash(2);else epoch++;}};
}
test('real totals filter controller uses fixed static catalog boards only and exposes RHR per-racer ERP',async()=>{
 const h=totalsHarness();await h.run('all');assert.ok(h.output.at(-1).includes('Seasonal (no RHR)'));assert.match(h.output.at(-1),/Per-racer Rolling Hills ERP/);
 assert.match(h.output.at(-1),/4 events/);await h.run('daily');assert.deepEqual(h.requests,['daily-fixture']);
 assert.match(h.output.at(-1),/not lifetime totals/);await h.run('daily');assert.equal(h.requests.length,1,'static reads reused, no replay reads');
});
for(const change of ['account','epoch'])test('ERP filter publication discards delayed static results after '+change+' changes',async()=>{
 const h=totalsHarness({delay:true}),work=h.run('daily');
 for(let i=0;i<30&&!h.requests.length;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(h.requests.length,1);
 h.change(change);h.resolve();await work;assert.equal(h.output.filter(html=>html.includes('sq-event-totals-results')).length,0);
});
