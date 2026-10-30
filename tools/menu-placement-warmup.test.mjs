import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as placement from './record-placement.mjs';

const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=source.indexOf('  const recordPlacementModuleUrl='),end=source.indexOf('  let lastPlacementUpdateAt=',start);
const code=source.slice(start,end).replace('import(recordPlacementModuleUrl)','Promise.resolve(placementModule)');
const id='a'.repeat(64),otherId='b'.repeat(64);
const flush=()=>new Promise(done=>setImmediate(done));
function fixture(){
  let options,readerResolve;const reads=[],metadataReads=[],timers=[];const store={};let visible=true;
  const ctx=vm.createContext({URL,Map,Set,Promise,Date,Number,String,Math,Array,Object,
    eventsModuleUrl:'https://game.test/events/client.mjs',RANK_MODEL:'model',TRACK_CACHE_SCHEMA:6,
    trackCacheGeneration:0,localRaceGeneration:0,placementRenderTimer:0,snapshotTrackStatistics:{},overallCacheGeneration:0,
    trackSnapshotStore:()=>store,readOverallSnapshotCache:()=>null,
    readTrackSnapshotCache:trackId=>store[trackId],TRACK_CATALOG:new Map([[id,{id,name:'Summer 1'}]]),
    activeRankedAccountId:()=> 'me',localStorage:{getItem:()=>null},personalFilterRuntime:null,
    cleanUserId:value=>String(value||''),canonicalRaceTimeMs:row=>Number(row?.timeMs)||0,
    localBestRowsForAccount:()=>[{trackId:id,accountId:'me',timeMs:950}],
    readPublicSnapshotBackup:(kind,trackId)=>{if(kind==='track-statistics'){metadataReads.push(kind);return Promise.resolve({tracks:{}});}assert.equal(kind,'track');reads.push([kind,trackId]);return new Promise(done=>{readerResolve=done;});},
    document:{hidden:false,querySelector:()=>({}),addEventListener(){}},window:{innerWidth:1280,innerHeight:720},
    isElementVisible:()=>visible,setTimeout:fn=>{timers.push(fn);return timers.length;},log(){},
    placementModule:{...placement,installRecordPlacement(value){options=value;return {update(){}};}}
  });
  vm.runInContext(code,ctx);
  const title={closest:()=>({getBoundingClientRect:()=>({left:0,top:10,right:200,bottom:300})})};
  return {ctx,reads,metadataReads,store,timers,title,get options(){return options;},resolve:value=>readerResolve(value),hide:()=>{visible=false;}};
}
const board=(revision=2)=>({trackId:id,complete:true,totalEntries:3,revision,algorithmVersion:'model',schemaVersion:6,updatedAt:200,entries:[
  {accountId:'first',timeMs:900,runVerified:true,replay:'must not retain',profileCosmetics:{large:true}},
  {accountId:'me',timeMs:1000,runVerified:true},{accountId:'last',timeMs:1100,runVerified:false}]});

test('visible cards warm static snapshots once, keep only placement fields, and project local PBs',async()=>{
  const f=fixture();await f.ctx.ensureRecordPlacementUi();
  f.options.requestSnapshot(id,f.title);f.options.requestSnapshot(id,f.title);await flush();
  assert.deepEqual(f.reads,[['track',id]],'no cloud API participates in menu warming');
  assert.deepEqual(f.metadataReads,['track-statistics'],'the compact static index warms once');
  f.resolve(board());await flush();await flush();
  const saved=f.options.readSnapshots()[id];
  assert.equal(saved.complete,true);assert.equal(saved.checkedAt,0);
  assert.equal(saved.entries[0].replay,undefined);assert.equal(saved.entries[0].profileCosmetics,undefined);
  assert.equal(f.options.estimatePlacement(id,950,'me').label,'~2/3');
  assert.equal(placement.computeRecordPlacement({snapshot:f.options.prepareSnapshot(saved),trackId:id,accountId:'me'}).label,'2/3');
  assert.equal(f.ctx.trackCacheGeneration,1);assert.equal(f.timers.length,1,'one coalesced redraw after warming');
  f.options.requestSnapshot(id,f.title);await flush();assert.equal(f.reads.length,1);
  f.hide();f.options.requestSnapshot(otherId,f.title);await flush();assert.equal(f.reads.length,1);
});

test('a late packaged snapshot cannot displace the live board loaded during the request',async()=>{
  const f=fixture();await f.ctx.ensureRecordPlacementUi();
  f.options.requestSnapshot(id,f.title);await flush();
  f.store[id]={...board(3),source:'edge',serverUpdatedAt:300,fetchedAt:300,checkedAt:300};
  f.resolve(board(2));await flush();await flush();
  assert.equal(f.options.readSnapshots()[id].revision,3);
  assert.equal(f.ctx.trackCacheGeneration,0);
});

test('offscreen cards and malformed partial files do not start a cloud fallback or invent a placement',async()=>{
  const f=fixture();await f.ctx.ensureRecordPlacementUi();
  f.options.requestSnapshot(id,{closest:()=>({getBoundingClientRect:()=>({left:0,top:2000,right:200,bottom:2200})})});
  await flush();assert.equal(f.reads.length,0);
  f.options.requestSnapshot(id,f.title);await flush();f.resolve({...board(),totalEntries:200});
  await flush();await flush();assert.equal(f.options.readSnapshots()[id],undefined);assert.equal(f.timers.length,0);
});

test('active group filters never mislabel a global-only warmed placement',async()=>{
  const f=fixture();await f.ctx.ensureRecordPlacementUi();
  f.ctx.personalFilterRuntime={active:()=>true,getFilter:()=>({scope:'all'})};
  const place={accountId:'me',rank:2,fieldSize:3,timeMs:1000};
  assert.equal(f.options.mapPlacement(place,id),null);
  f.ctx.personalFilterRuntime={active:()=>false,getFilter:()=>({scope:'all'})};
  assert.equal(f.options.mapPlacement(place,id),place);
});

test('Kodub card binds its normal PB placement to exact native identity, not a duplicate name',async()=>{
  const f=fixture(),card={dataset:{kodubIdentity:otherId+'@2026-11-01T12:00:00Z'},querySelector:()=>({textContent:'Summer 1'})};
  f.ctx.document.querySelector=()=>card;
  await f.ctx.ensureRecordPlacementUi();
  const tracks=f.options.tracks();
  assert.equal(tracks.get(otherId).id,otherId);
  assert.equal(f.ctx.TRACK_CATALOG.has(otherId),false,'do not mutate the registry');
  const timerLine={},container={querySelector:selector=>selector==='.personal-best>div'?timerLine:null};
  const title={textContent:'Summer 1',closest:selector=>selector==='.sq-kodub-weekly'?card:container};
  assert.equal(f.options.resolveTrackId(title,[...tracks.values()]),otherId);
  assert.equal(f.options.findRecordElement(title),timerLine,'keep the native trophy row intact');
  card.dataset.kodubIdentity='bad@date';
  assert.equal(f.options.resolveTrackId(title,[...tracks.values()]),'');
  assert.equal(f.options.tracks(),f.ctx.TRACK_CATALOG);
});

test('ordinary track cards retain name lookup and the original PB element',async()=>{
  const f=fixture();f.ctx.document.querySelector=()=>null;await f.ctx.ensureRecordPlacementUi();
  const record={},button={querySelector:()=>record},title={textContent:' Summer 1 ',closest:selector=>selector==='.sq-kodub-weekly'?null:button};
  assert.equal(f.options.resolveTrackId(title,[...f.options.tracks().values()]),id);
  assert.equal(f.options.findRecordElement(title),record);
});

test('unplayed count installation consumes only already-loaded metadata and never starts a count-only read',async()=>{
  const f=fixture(),statistics={[id]:{complete:true,players:7,count:7,totalEntries:7,revision:4}};
  f.ctx.snapshotTrackStatistics=statistics;
  await f.ctx.ensureRecordPlacementUi();
  assert.equal(f.options.readTrackStatistics(),statistics);
  f.options.readTrackStatistics();f.options.readTrackStatistics();
  assert.deepEqual(f.reads,[]);assert.deepEqual(f.metadataReads,['track-statistics'],'existing startup read only');
  const replacement={[id]:{...statistics[id],players:8,count:8,totalEntries:8,revision:5}};
  f.ctx.snapshotTrackStatistics=replacement;
  assert.equal(f.options.readTrackStatistics(),replacement,'no stale captured statistics reference');
});

test('ordinary duplicate names fail closed while exact Kodub identity stays independent',async()=>{
  const f=fixture();await f.ctx.ensureRecordPlacementUi();
  const title={textContent:'Summer 1',closest:()=>null};
  assert.equal(f.options.resolveTrackId(title,[{id,name:'Summer 1'},{id:otherId,name:'Summer 1'}]),'');
});

test('personal-group placement never labels a different displayed PB time',async()=>{
  const f=fixture();await f.ctx.ensureRecordPlacementUi();
  f.store[id]=board();f.ctx.personalFilterRuntime={active:()=>true,getFilter:()=>({scope:'all'})};
  f.ctx.applyPersonalFilters=()=>({groupGrading:true,rows:[{accountId:'me',timeMs:1000,groupRank:1}]});
  const place={accountId:'me',timeMs:950,rank:1,fieldSize:3};
  assert.equal(f.options.mapPlacement(place,id),null,'old group rank is not a local PB estimate');
  const mapped=f.options.mapPlacement({...place,timeMs:1000},id);
  assert.equal(mapped.label,'1/1');assert.equal(mapped.personalFilter,true);
});

test('count toggle and newly loaded statistics repaint immediately without additional snapshot warming',async()=>{
  const f=fixture(),values=new Map(),classes=new Set();let updates=0;
  const menu={};f.ctx.document.querySelector=()=>menu;
  f.ctx.localStorage={getItem:key=>values.get(key)??null};
  f.ctx.document.documentElement={classList:{contains:key=>classes.has(key),toggle:(key,on)=>{if(on)classes.add(key);else classes.delete(key);}},style:{setProperty(){}}};
  f.ctx.placementModule.installRecordPlacement=value=>({update(){updates++;}});
  await f.ctx.ensureRecordPlacementUi();
  const a=source.indexOf('  let lastPlacementUpdateAt='),b=source.indexOf('  let settingsPreferenceTransaction=',a);
  vm.runInContext(source.slice(a,b),f.ctx);
  f.ctx.applyUiPreferences();assert.equal(updates,1);
  f.ctx.applyUiPreferences();assert.equal(updates,1);
  values.set(placement.RECORD_PLACEMENT_SETTINGS.showPlayerCounts,'1');
  f.ctx.applyUiPreferences();assert.equal(updates,2);
  f.ctx.snapshotTrackStatistics={[id]:{complete:true,players:7,count:7,totalEntries:7,revision:4}};
  f.ctx.applyUiPreferences();assert.equal(updates,3);
  assert.deepEqual(f.reads,[]);assert.deepEqual(f.metadataReads,['track-statistics']);
  assert.match(source,/settingsToggle\('Player counts on unplayed tracks','polytrack-0\.6\.3-unplayed-player-counts',false\)/);
  const keys=source.slice(source.indexOf('  const settingsPreferenceKeys='),source.indexOf('  function beginSettingsPreferenceTransaction('));
  assert.ok(keys.includes(placement.RECORD_PLACEMENT_SETTINGS.showPlayerCounts),'Apply/Cancel transaction owns the toggle');
});
