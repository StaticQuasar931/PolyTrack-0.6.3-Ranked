import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {prepareOverallFirstPreview} from './overall-first-preview.mjs';
const source=await fs.readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const candidate=source;
const fn=(text,name)=>{const a=text.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));assert.ok(a>=0,name);return text.slice(a,text.indexOf('\n  }\n',a)+4);};
const fragment=id=>{
  if(id==='preview-helpers'){
    const start=source.indexOf('function prepareOverallFirstPreview('),end=source.indexOf('  async function openPanel(',start);
    assert.ok(start>=0&&end>start,'integrated preview helpers');
    return source.slice(start,end)+'  async function openPanel(forceRefresh=false){';
  }
  return fn(source,id==='preview-keeps-published-overall-scores'?'sortedOverallEntries':id);
};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const row=i=>({userId:'racer'+i,rank:i,globalRank:i,score:10+i/100,raceCount:10,rankModel:'test',averageFinishVersion:2,averagePlacementVersion:2});
const entries=Array.from({length:200},(_,i)=>row(i+1));
const preview=()=>({kind:'overall-preview',previewSize:15,count:15,offset:0,entries:entries.slice(0,15),updatedAt:100,algorithmVersion:'test',
  sourceRevision:1,schemaVersion:6,publishedEntries:200,totalEntries:200,totalEntriesExact:true,ranksExact:true,complete:false});
const limits={model:'test',schema:6,averageFinish:2,averagePlacement:2};

function harness({saved=null,previewValue=preview(),full=deferred(),history=deferred(),timeoutFull=false,timeoutPreview=false}={}){
  const calls=[],timers=[],button={textContent:'Find me',isConnected:true},panel={style:{display:'none'},querySelector:()=>null};
  const list={children:[],innerHTML:''};
  const context=vm.createContext({console,Date,Number,String,Array,Object,Map,Set,Promise,Error,Math,
    RANK_MODEL:'test',TRACK_CACHE_SCHEMA:6,AVERAGE_FINISH_VERSION:2,AVERAGE_PLACEMENT_VERSION:2,
    overallCategory:'overall',overallLoadGeneration:0,overallCloudRetryAt:0,overallLoadState:{},overallEntriesCache:[],overallPage:0,
    rankedFreshnessTimer:0,OVERALL_PB_DIRTY_KEY:'dirty',OVERALL_REFRESH_CHECK_MS:60000,OVERALL_PAGE_SIZE:15,rankedFilterResult:null,
    document:{getElementById:id=>id==='overallLeaderboardPanel'?panel:id==='overallLeaderboardList'?list:id==='overallFindMeBtn'?button:null,
      querySelector:()=>null,documentElement:{classList:{contains:()=>true}}},CSS:{escape:String},
    readOverallSnapshotCache:()=>saved,readJsonStorage:()=>null,writeJsonStorage:()=>assert.fail('unexpected storage write'),
    isElementVisible:()=>false,syncCategorySelect:()=>{},syncOverallTrackScope:()=>{},tr:()=>'',
    annotateOverallMovement:rows=>rows,updateWeightedTrackInsights:rows=>calls.push(['insights',rows.length]),
    updateRankDurationLabels:()=>{},updateRankedFreshness:()=>calls.push(['freshness']),normalizeEntries:rows=>rows,
    readPublicSnapshotBackup:async(kind,_id,_account,options)=>{calls.push(['preview',kind,options]);if(previewValue instanceof Error)throw previewValue;return previewValue;},
    fetchOverallEntries:refresh=>{calls.push(['full',refresh]);context.overallLoadState={status:'loading'};
      return full.promise.then(rows=>{context.overallLoadState={status:rows.length?'snapshot':'error',complete:rows.length===200,totalEntries:200,totalEntriesExact:true,publishedEntries:200,ranksExact:true};return rows;});},
    loadKodubTrackHistory:()=>{calls.push(['history']);return history.promise;},
    renderEntries:(rows,meta,options)=>{if(rows){context.overallEntriesCache=rows;list.children=rows;}
      if(rows&&!options?.preservePage)context.overallPage=0;calls.push(['render',rows?.length,meta,options]);},
    setTimeout:(cb,ms)=>{timers.push([cb,ms]);if(ms===0)queueMicrotask(cb);return timers.length;},clearTimeout:()=>{},setInterval:()=>1,
    requestAnimationFrame:cb=>{calls.push(['raf']);queueMicrotask(cb);},
    withTimeout:(p,ms)=>timeoutFull&&ms===12000||timeoutPreview&&ms===1200?Promise.reject(Error('timeout')):Promise.resolve(p),
    log:()=>{},activeRankedAccountId:()=> 'racer180',sortedOverallEntries:()=>context.overallEntriesCache,
    cleanUserId:String,localPlannerProfileEntry:()=>null,openRankedProfile:()=>assert.fail('false not-ranked fallback'),
    fetch:()=>assert.fail('Network'),rankedFetch:()=>assert.fail('Worker'),db:()=>assert.fail('Firestore')});
  const helpers=fragment('preview-helpers').replace(/  async function openPanel\(forceRefresh=false\)\{$/,'');
  vm.runInContext(helpers+'\n'+fragment('openPanel')+'\n'+fragment('focusCurrentRacer'),context);
  return {context,calls,timers,button,panel,list,full,history,opening:()=>context.openPanel(false),
    state:()=>vm.runInContext('overallFirstPreview',context)};
}
test('integrated preview is parseable, transport-only, and leaves full Overall loading static-only',()=>{
  new vm.Script(source);
  assert.doesNotMatch(fragment('preview-helpers'),/\b(?:fetch|rankedFetch|eventCloudRead|readDirectPublicSnapshot)\s*\(/);
  assert.match(fn(source,'fetchRankedSnapshot'),/if\(kind==='overall'\)return readPublicSnapshotBackup/);
  assert.match(fn(source,'showOverallFirstPreview'),/1200/);
});
test('preview preserves published full scores and ranks without claiming complete coverage',()=>{
  const original=preview(),value=prepareOverallFirstPreview(original,x=>x,limits);
  assert.deepEqual(value.entries,original.entries);assert.equal(value.meta.complete,false);assert.equal(value.meta.totalEntries,200);
  assert.equal(value.meta.ranksExact,true);assert.equal(value.entries[0].score,entries[0].score);
});
test('preview rejects foreign models, fabricated scores, missing versions, duplicate IDs and normalized changes',()=>{
  for(const change of [p=>p.algorithmVersion='other',p=>p.ranksExact=false,p=>p.entries[0].score=NaN,
    p=>delete p.entries[0].averageFinishVersion,p=>p.entries[1].userId=p.entries[0].userId,p=>p.entries.push(row(16))]){
    const p=structuredClone(preview());change(p);assert.equal(prepareOverallFirstPreview(p,x=>x,limits),null);
  }
  assert.equal(prepareOverallFirstPreview(preview(),rs=>rs.map(r=>({...r,score:r.score+1})),limits),null);
});
test('cold open paints 15 first, then starts remaining load; stalled history never gates either render',async()=>{
  const h=harness(),opening=h.opening();await tick();
  const render=h.calls.findIndex(c=>c[0]==='render'),full=h.calls.findIndex(c=>c[0]==='full'),raf=h.calls.findIndex(c=>c[0]==='raf');
  assert.ok(render>=0&&render<raf&&raf<full);assert.equal(h.calls[render][1],15);assert.equal(h.context.overallEntriesCache.length,15);
  assert.equal(h.state().meta.complete,false);assert.equal(h.calls.filter(c=>c[0]==='full').length,1);
  h.context.overallPage=2;h.full.resolve(entries);await opening;
  assert.equal(h.context.overallEntriesCache.length,200);assert.equal(h.context.overallPage,2);assert.equal(h.state(),null);
  assert.deepEqual(h.context.overallEntriesCache,entries);
});
test('Find Me waits for a racer outside preview and uses its final page, not No ranked run',async()=>{
  const h=harness(),opening=h.opening();await tick();let done=false;
  const finding=h.context.focusCurrentRacer().then(()=>done=true);await tick();assert.equal(done,false);
  assert.equal(h.button.textContent,'Find me');h.full.resolve(entries);await Promise.all([opening,finding]);
  assert.equal(h.context.overallPage,11);assert.equal(h.button.textContent,'Find me');
});
test('full-load failure retains preview and Find Me reports incomplete loading',async()=>{
  const h=harness(),opening=h.opening();await tick();h.full.resolve([]);await opening;
  assert.equal(h.context.overallEntriesCache.length,15);assert.equal(h.context.overallLoadState.complete,false);
  assert.equal(h.context.overallLoadState.status,'stale');await h.context.focusCurrentRacer();assert.equal(h.button.textContent,'Racers still loading');
});
test('full timeout retains preview, then late valid completion replaces it without page reset',async()=>{
  const h=harness({timeoutFull:true}),opening=h.opening();await opening;
  assert.equal(h.context.overallEntriesCache.length,15);assert.equal(h.state().meta.complete,false);
  h.context.overallPage=1;h.full.resolve(entries);await tick();
  assert.equal(h.context.overallEntriesCache.length,200);assert.equal(h.context.overallPage,1);assert.equal(h.state(),null);
});
test('missing or invalid preview falls back to unchanged full loading',async()=>{
  for(const previewValue of [null,Error('missing'),{...preview(),algorithmVersion:'foreign'}]){
    const h=harness({previewValue}),opening=h.opening();await tick();assert.equal(h.calls.some(c=>c[0]==='render'),false);
    h.full.resolve(entries);await opening;assert.equal(h.context.overallEntriesCache.length,200);
  }
});
test('slow preview is bounded and cannot later overwrite a completed full board',async()=>{
  const gate=deferred(),h=harness({timeoutPreview:true});h.context.readPublicSnapshotBackup=()=>gate.promise;
  const opening=h.opening();await tick();assert.equal(h.calls.some(c=>c[0]==='full'),true);
  h.full.resolve(entries);await opening;gate.resolve(preview());await tick();
  assert.equal(h.context.overallEntriesCache.length,200);assert.equal(h.state(),null);
});
test('warm full cache skips preview and survives full refresh failure',async()=>{
  const saved={entries,complete:true,totalEntries:200,publishedEntries:200,totalEntriesExact:true,ranksExact:true};
  const h=harness({saved}),opening=h.opening();await tick();assert.equal(h.calls.some(c=>c[0]==='preview'),false);
  assert.equal(h.context.overallEntriesCache.length,200);h.full.resolve(entries);await opening;
});
test('obsolete preview request cannot paint into a newer selection or begin the deferred full load',async()=>{
  const gate=deferred(),h=harness();h.context.readPublicSnapshotBackup=()=>gate.promise;
  const opening=h.opening();await tick();h.context.overallLoadGeneration++;gate.resolve(preview());await opening;
  assert.equal(h.calls.some(c=>c[0]==='render'),false);assert.equal(h.calls.some(c=>c[0]==='full'),false);
});
test('partial observations never persist inferred category movements',()=>{
  const c=vm.createContext({overallFirstPreview:{},writeJsonStorage:()=>assert.fail('partial rank history write')});
  vm.runInContext(fn(candidate,'annotateCategoryRanks'),c);
  const rows=c.annotateCategoryRanks([row(8),row(20)],'overall');assert.equal(rows[0].categoryRank,8);assert.equal(rows[1].categoryMovement,0);
});
test('partial notice is visible and populated; published-score projection fence is explicit',()=>{
  const notice={hidden:true},summary={textContent:'',setAttribute(){}};
  const c=vm.createContext({Math,Number,String,overallCategory:'overall',overallPage:0,OVERALL_PAGE_SIZE:15,
    currentLeaderboardCount:()=>15,LEADERBOARD_LABELS:{overall:'Overall RP'},rankedFilterResult:null,
    overallFirstPreview:{},overallEntriesCache:entries.slice(0,15),rankedFilterSnapshotMeta:{complete:false,totalEntries:200,totalEntriesExact:true},
    FILTERABLE_RANKED_CATEGORIES:new Set(['overall']),syncCategorySelect:()=>{},
    document:{getElementById:id=>id==='overallDataNotice'?notice:id==='overallFieldSummary'?summary:id==='overallLeaderboardPanel'?{style:{display:'flex'}}:null}});
  vm.runInContext(fragment('updateOverallPager'),c);c.updateOverallPager();assert.equal(notice.hidden,false);
  assert.match(notice.textContent,/First 15 Overall racers loaded/);assert.match(notice.textContent,/loaded racers only/);
  assert.match(fragment('preview-keeps-published-overall-scores'),/overallFirstPreview/);
});
test('existing snapshot reader really decodes a bounded preview before any full page',async()=>{
  const {buildOverallSnapshotPaging}=await import(new URL('./track-snapshot-paging.mjs',import.meta.url));
  const {createPublicSnapshotReader}=await import(new URL('./public-snapshot-client.mjs',import.meta.url));
  const p=buildOverallSnapshotPaging({entries,complete:true,totalEntries:200,updatedAt:100,algorithmVersion:'test',schemaVersion:6,sourceRevision:1}).preview;
  const calls=[];const read=createPublicSnapshotReader({baseUrl:'https://offline.invalid/',fetchImpl:async url=>{
    calls.push(String(url));assert.ok(String(url).endsWith('/overall-preview.json'));return Response.json(p);
  }});
  const result=await read('overall-preview');assert.equal(result.entries.length,15);assert.equal(result.complete,false);assert.equal(calls.length,1);
});
