import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function section(name,next){const start=source.indexOf('  function '+name+'(');assert.ok(start>=0);const end=source.indexOf(next,start+1);assert.ok(end>start);return source.slice(start,end);}

test('saved profile design replaces stale aggregate defaults without cloud reads',()=>{
  const design={theme:'crimson',emblem2:'flag',nameFont:'racing'};
  const context=vm.createContext({snapshotCosmeticEntries:{me:{value:design}},cleanUserId:x=>x,
    activeRankedAccountId:()=> 'other',readCosmeticDirectory:()=>({entries:{}}),sanitizeProfileCosmetics:x=>x,
    enforceCosmeticUnlocks:x=>x});
  vm.runInContext(section('savedCosmeticDesign','  function hasExplicitProfileCosmetics(')+section('resolveCosmeticsForEntry','  function cosmeticUnlocked('),context);
  assert.equal(context.resolveCosmeticsForEntry({userId:'me',profileCosmetics:{theme:'classic'}}),design);
});

test('explicit local customization still wins over snapshot design',()=>{
  const local={theme:'cyan'};
  const context=vm.createContext({snapshotCosmeticEntries:{me:{value:{theme:'crimson'}}},cleanUserId:x=>x,
    activeRankedAccountId:()=> 'me',readJsonStorage:()=>local,PROFILE_COSMETICS_KEY:'design',
    sanitizeProfileCosmetics:x=>x,enforceCosmeticUnlocks:x=>x});
  vm.runInContext(section('resolveCosmeticsForEntry','  function cosmeticUnlocked('),context);
  assert.equal(context.resolveCosmeticsForEntry({userId:'me'}),local);
});

test('track identity retains saved achievement proofs and cosmetic statistics',()=>{
  const overall={userId:'me',rank:8,cosmeticUnlocks:['nameColor:gold'],extraCount:3,totalPlaytimeMs:10000,trackWins:2};
  const context=vm.createContext({rankedIdentityIndex:null,rankedIdentityIndexSource:null,cleanUserId:x=>x,rankedIdentityRows:()=>[overall],snapshotRacerDirectoryIdentity:()=>null,rowIdentityFreshness:()=>0});
  vm.runInContext(section('rankedIdentityForRacer','  function decorateNativeLeaderboardIdentity('),context);
  const identity=context.rankedIdentityForRacer({accountId:'me',rank:1,timeMs:100});
  assert.equal(identity.rank,8);assert.deepEqual(identity.cosmeticUnlocks,overall.cosmeticUnlocks);
  assert.equal(identity.extraCount,3);assert.equal(identity.totalPlaytimeMs,10000);
});

test('snapshot/local row gets native self highlight without changing selection',()=>{
  const classes=new Set(['selected']),button={classList:{toggle:(key,on)=>on?classes.add(key):classes.delete(key)}};
  const context=vm.createContext({cleanUserId:x=>x,Boolean});
  vm.runInContext(section('syncNativeSelfHighlight','  function decorateNativeLeaderboardCosmetics('),context);
  context.syncNativeSelfHighlight(button,{accountId:'me',localPending:true},'me');assert.ok(classes.has('self'));assert.ok(classes.has('selected'));
  context.syncNativeSelfHighlight(button,{accountId:'other'},'me');assert.ok(!classes.has('self'));assert.ok(classes.has('selected'));
});


test('Extra Track profile previews use the catalog thumbnail, not a community path',()=>{
  const context=vm.createContext({trackInfo:()=>({type:'extra',name:'Extra Circuit',thumbnail:'extra-tracks/thumbnails/circuit.png'}),document:{querySelectorAll:()=>[]},escapeHtml:x=>x});
  vm.runInContext(section('trackThumbnailMarkup','  async function openKodubWeeklyFromEvents('),context);
  const markup=context.trackThumbnailMarkup('track');
  assert.ok(markup.includes('extra-tracks/thumbnails/circuit.png'));
  assert.ok(!markup.includes('tracks/community/'));
});

test('Extra Track profile links call the native importer on the selected Custom tab',async()=>{
  const trackId='a'.repeat(64),entry={trackId};let imported=null,importOptions=null,left=0,closed=0;
  const listeners=new Map(),errors=[];
  const tab={classList:{contains:()=>true},click:()=>{throw Error('Already selected tab should not be clicked');}};
  const context=vm.createContext({rankedTrackNavigationEpoch:0,eventTrackReturnContext:{},eventTrackReturnEpoch:0,activeRankedAccountId:()=> 'account',localInsights:null,warmPracticeTrack:()=>{},eventUi:{leave:()=>left++},trackInfo:()=>({type:'extra'}),kodubTrackHistory:new Map(),nativeWeeklySelection:null,loadExtraTracksCatalog:async()=>[entry],document:{getElementById:()=>({}),querySelectorAll:()=>[],querySelector:()=>tab,addEventListener:(type,handler,capture)=>{assert.equal(capture,true);listeners.set(type,handler);},removeEventListener:(type,handler,capture)=>{assert.equal(capture,true);assert.equal(listeners.get(type),handler);listeners.delete(type);}},closeOverallPanel:()=>closed++,importExtraTrack:async(row,options)=>{imported=row;importOptions=options;assert.equal(options.isCurrent(),true);},isElementVisible:()=>true,log:()=>{},showRankedTrackNavigationError:message=>errors.push(message)});
  const start=source.indexOf('  async function focusTrackFromRanked('),end=source.indexOf('  function trackSummaryLine(',start);
  let replayInvalidations=0;context.invalidateNativePartialReplay=()=>{replayInvalidations++;};
  assert.ok(start>=0&&end>start,'complete production navigation function exists');
  vm.runInContext(source.slice(start,end),context);
  assert.equal(await context.focusTrackFromRanked(trackId),true);
  assert.equal(imported,entry);assert.equal(left,1);assert.equal(closed,1);
  assert.equal(replayInvalidations,1);
  assert.equal(context.eventTrackReturnContext,null);assert.equal(context.eventTrackReturnEpoch,1);
  assert.equal(context.rankedTrackNavigationEpoch,1);assert.equal(listeners.size,0);assert.deepEqual(errors,[]);
  context.activeRankedAccountId=()=> 'another-account';assert.equal(importOptions.isCurrent(),false,'import cancellation remains bound to the initiating account');
});
