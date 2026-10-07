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
  const context=vm.createContext({rankedIdentityIndex:null,rankedIdentityIndexSource:null,cleanUserId:x=>x,rankedIdentityRows:()=>[overall]});
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
  const entry={trackId:'extra'};let imported=null,left=0,closed=0;
  const tab={classList:{contains:()=>true},click:()=>{throw Error('Already selected tab should not be clicked');}};
  const context=vm.createContext({eventUi:{leave:()=>left++},trackInfo:()=>({type:'extra'}),loadExtraTracksCatalog:async()=>[entry],document:{getElementById:()=>({}),querySelectorAll:()=>[],querySelector:()=>tab},closeOverallPanel:()=>closed++,importExtraTrack:async row=>{imported=row;},isElementVisible:()=>true});
  const start=source.indexOf('  async function focusTrackFromRanked('),end=source.indexOf('    const tabIndex=',start);
  vm.runInContext(source.slice(start,end)+'  }',context);
  await context.focusTrackFromRanked('extra');
  assert.equal(imported,entry);assert.equal(left,1);assert.equal(closed,1);
});
