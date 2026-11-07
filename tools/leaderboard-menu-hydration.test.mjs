import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
const start=source.indexOf('  const topTrackDetails=new Map();');
const helpers=source.slice(start,source.indexOf('  function renderTrackRankingRow(',start));
function harness(read=async()=>null){
 const c=vm.createContext({snapshotTrackStatistics:{},overallCategory:'topTracks',readTrackSnapshotCache:()=>null,
  readPublicSnapshotBackup:read,panelVisible:true,paints:0,document:{getElementById:()=>null}});
 c.isElementVisible=()=>c.panelVisible;c.renderEntries=()=>c.paints++;
 vm.runInContext(helpers,c);return c;
}
const row=n=>({trackId:String(n).padStart(64,'a'),fieldSize:2,updatedAt:100});
const board=(extra={})=>({complete:true,totalEntries:2,entries:[{name:'Leader',timeMs:1000},{name:'Second',timeMs:2000}],updatedAt:100,...extra});
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('Top Tracks only requests static visible boards with three global in-flight requests',async()=>{
 const pending=[],calls=[];const c=harness((kind,id)=>new Promise(resolve=>{calls.push([kind,id]);pending.push(resolve);}));
 c.hydrateVisibleTopTracks([1,2,3,4,5].map(row));assert.equal(calls.length,3);
 c.hydrateVisibleTopTracks([1,2,3,4,5].map(row));assert.equal(calls.length,3,'coalesce duplicate renders');
 pending.shift()(board());await tick();assert.equal(calls.length,4);
 c.hydrateVisibleTopTracks([row(6)]);pending.shift()(board());await tick();
 assert.equal(calls.at(-1)[1],row(6).trackId,'discard queued work for old page');
 assert.ok(calls.every(([kind])=>kind==='track'));
 for(const resolve of pending.splice(0))resolve(board());await tick();
 assert.ok(c.topTrackDetailBoard(row(1)));assert.equal(c.topTrackDetailBoard(row(5)),null);
 assert.doesNotMatch(helpers,/fetchRankedSnapshot|loadTrackEntries|readDirectPublicSnapshot|rankedFetch|\.getDoc/);
});
test('partial, stale, mismatched and superseded generation boards cannot supply exact leader details',async()=>{
 for(const change of [{complete:false},{sourceComplete:false},{ranksExact:false},{totalEntriesExact:false},{totalEntries:3},{updatedAt:99}]){
  const c=harness(async()=>board(change));c.hydrateVisibleTopTracks([row(1)]);await tick();assert.equal(c.topTrackDetailBoard(row(1)),null,JSON.stringify(change));
 }
 let resolve;const c=harness(()=>new Promise(r=>resolve=r));c.hydrateVisibleTopTracks([row(1)]);c.snapshotTrackStatistics={};resolve(board());await tick();assert.equal(c.topTrackDetailBoard(row(1)),null);
});
test('unavailable static details settle without looping or making cloud fallback requests',async()=>{
 let calls=0;const c=harness(async()=>{calls++;return null;});c.hydrateVisibleTopTracks([row(1)]);await tick();c.hydrateVisibleTopTracks([row(1)]);await tick();assert.equal(calls,1);
});
test('identical rows keep their DOM and animation; changed background data skips only entry animation',()=>{
 const c=harness();let paints=0,finished=0;const list={__overallRowsMarkup:null,querySelector:()=>paints>0?{}:null,
  querySelectorAll:()=>[{getAnimations:()=>[{animationName:'overallEntryIn',finish:()=>finished++},{animationName:'findMe',finish:()=>assert.fail('do not finish highlight')}]}],
  set innerHTML(value){paints++;}};
 assert.equal(c.paintLeaderboardRows(list,'one'),true);assert.equal(c.paintLeaderboardRows(list,'one'),false);assert.equal(paints,1);assert.equal(finished,0);
 assert.equal(c.paintLeaderboardRows(list,'two',true),true);assert.equal(paints,2);assert.equal(finished,1);
});
test('category styling is set before either special leaderboard returns; event repaint uses stable rows',()=>{
 const render=source.slice(source.indexOf('  function renderEntries('),source.indexOf('  function rankedFreshnessText('));
 assert.ok(render.indexOf("setAttribute('data-category',overallCategory)")<render.indexOf("if(overallCategory==='events')"));
 assert.match(source,/paintLeaderboardRows\(listEl,rows\.slice/);
 assert.match(render,/hydrateVisibleTopTracks\(visible\)/);
});

test('rejected details repaint unavailable text and closing the panel pauses queued static work',async()=>{
 const failed=harness(async()=>{throw Error('offline');});failed.hydrateVisibleTopTracks([row(1)]);await tick();assert.equal(failed.paints,1);assert.equal(failed.topTrackDetailBoard(row(1)),null);
 const pending=[],calls=[];const c=harness((kind,id)=>new Promise(resolve=>{calls.push(id);pending.push(resolve);}));
 const rows=[1,2,3,4,5].map(row);c.hydrateVisibleTopTracks(rows);assert.equal(calls.length,3);
 c.panelVisible=false;pending.shift()(board());await tick();assert.equal(calls.length,3,'no new request while closed');assert.equal(c.paints,0);
 c.panelVisible=true;c.hydrateVisibleTopTracks(rows);assert.equal(calls.length,4,'reopening resumes the same queue within concurrency cap');
 for(const resolve of pending.splice(0))resolve(board());await tick();for(const resolve of pending.splice(0))resolve(board());await tick();
});

test('Top Tracks retries unavailable static details only after cooldown and stops after three attempts',async()=>{
 let now=0,calls=0;const c=harness(async()=>{calls++;return null;});c.Date={now:()=>now};
 c.hydrateVisibleTopTracks([row(1)]);await tick();
 for(let i=0;i<10;i++)c.hydrateVisibleTopTracks([row(1)]);assert.equal(calls,1);
 now=30000;c.hydrateVisibleTopTracks([row(1)]);await tick();assert.equal(calls,2);
 now=150000;c.hydrateVisibleTopTracks([row(1)]);await tick();assert.equal(calls,3);
 now=999999;c.hydrateVisibleTopTracks([row(1)]);await tick();assert.equal(calls,3);
});


test('complete compact metadata supplies a leader even when an equal-age summary already exists',()=>{
 const a=source.indexOf('  function hydratePlannerTrackSummaries('),b=source.indexOf('\n  function ',a+20);assert.ok(a>0&&b>a);
 const id='a'.repeat(64),leader={accountId:'b'.repeat(64),name:'Saved leader',timeMs:12345};
 const c=vm.createContext({snapshotTrackStatistics:{},trackInfo:()=>({type:'official'})});vm.runInContext(source.slice(a,b),c);
 const rows=c.hydratePlannerTrackSummaries([{trackId:id,fieldSize:20,weight:4,updatedAt:100}],{[id]:{complete:true,players:20,count:20,totalEntries:20,weight:4,updatedAt:100,leader}});
 assert.equal(rows[0].leader.name,'Saved leader');assert.equal(rows[0].recordMs,12345);
});

test('incomplete overall samples never promote a fifth-place racer into the track record',()=>{
 const a=source.indexOf('  function loadedTrackRankingRows('),b=source.indexOf('\n  function ',a+20);assert.ok(a>0&&b>a);
 const id='a'.repeat(64),entries=[{userId:'b'.repeat(64),name:'Fifth',finishes:[{trackId:id,rank:5,fieldSize:20,timeMs:14000}]}];
 const c=vm.createContext({overallTrackSummariesCache:[],overallEntriesCache:entries,overallLoadState:{},annotateCategoryRanks:x=>x,trackInfo:()=>({name:'Summer 1',type:'official'}),readTrackSnapshotCache:()=>null,readOverallSnapshotCache:()=>null,snapshotCaptureTimestamp:()=>0,normalizedFinishSamples:e=>e.finishes,knownFinishWeight:()=>4,canonicalRaceTimeMs:r=>r.timeMs});vm.runInContext(source.slice(a,b),c);
 assert.equal(c.loadedTrackRankingRows()[0].leader,null);
 entries.push({userId:'c'.repeat(64),name:'First',finishes:[{trackId:id,rank:1,fieldSize:20,timeMs:12000}]});assert.equal(c.loadedTrackRankingRows()[0].leader.name,'First');
});
