import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {pathToFileURL} from 'node:url';

// The override supports a private staged test without copying or editing repo files.
const root=process.env.PRACTICE_REVIEW_SOURCE_ROOT
  ? pathToFileURL(process.env.PRACTICE_REVIEW_SOURCE_ROOT.replace(/\\/g,'/')+'/')
  : new URL('../',import.meta.url);
const patch=fs.readFileSync(new URL('polytrack_062_patch.js',root),'utf8');
const {renderPracticeProfile,capturePracticeProfileView,restorePracticeProfileView}=await import(new URL('./practice-profile.mjs',import.meta.url));

function functionSource(name,next){
  const start=patch.indexOf(`  function ${name}(`),end=patch.indexOf(`  function ${next}(`,start);
  assert.ok(start>=0&&end>start,`${name} source boundaries`);
  return patch.slice(start,end).trim();
}

function plannerFixture({inside=false,deferred=false}={}){
  const search={getAttribute:()=>null,matches:()=>false};
  const document={activeElement:search};
  let focusCalls=0,resolveMarkup;
  const markup=deferred?new Promise(resolve=>{resolveMarkup=resolve;}):'<details></details>';
  const control={getBoundingClientRect:()=>({top:10}),focus(){focusCalls++;document.activeElement=this;}};
  const next={open:false,querySelector:()=>control};
  const previous={open:true,contains:element=>inside&&element===search,setAttribute(){},querySelectorAll:()=>[],
    querySelector:selector=>selector==='.profile-guide-status'?{textContent:''}:control};
  let current=previous;
  Object.defineProperty(previous,'outerHTML',{set(){current=next;}});
  const content={querySelector:selector=>selector==='.profile-guide-pending'?null:current};
  const profileCard={scrollTop:83};
  const context={entry:{userId:'account'},self:{},isSelf:true,cachedFinishes:[],snapshotFinishes:[],selfSnapshotFinishes:[],
    popup:{dataset:{profileUser:'account'}},profileCard,scroll:83,open:true,focus:'[data-planner-filter="official"]'};
  const sandbox={document,plannerMetric:'rp',plannerSort:'practice',plannerCurrentTracksOnly:false,plannerOfficialOnly:false,
    cleanUserId:value=>value,isElementVisible:()=>true,cachedProfileGuideMarkup:()=>markup,setTimeout:callback=>callback()};
  const refresh=vm.runInNewContext('('+functionSource('refreshProfilePlanner','refreshOpenProfilePlanner')+')',sandbox);
  return {document,search,control,profileCard,focusCalls:()=>focusCalls,resolveMarkup:()=>resolveMarkup?.('<details></details>'),
    refresh:()=>refresh(content,context)};
}

test('automatic planner refresh does not steal practice-search focus using stale planner context',async()=>{
  const fixture=plannerFixture();
  await fixture.refresh();
  assert.equal(fixture.document.activeElement,fixture.search);
  assert.equal(fixture.focusCalls(),0);
  assert.equal(fixture.profileCard.scrollTop,83);
});

test('planner context fallback still restores focus when the old focus was inside the planner',async()=>{
  const fixture=plannerFixture({inside:true});
  await fixture.refresh();
  assert.equal(fixture.document.activeElement,fixture.control);
  assert.equal(fixture.focusCalls(),1);
});

test('async planner completion respects a newer user focus target',async()=>{
  const fixture=plannerFixture({inside:true,deferred:true}),pending=fixture.refresh();
  const newer={};fixture.document.activeElement=newer;fixture.resolveMarkup();
  await pending;
  assert.equal(fixture.document.activeElement,newer);
  assert.equal(fixture.focusCalls(),0);
});

const A='a'.repeat(64),B='b'.repeat(64);
const practiceRow=trackId=>({trackId,activeMs:1000,attempts:1,finishes:0,observationVersion:1,focusedMs:1000,lastPlayedAt:Date.UTC(2026,9,24)});
function profileFixture(ids=[A,B]){
  const html=renderPracticeProfile({rows:ids.map(practiceRow),trackName:id=>id===A?'Alpine':'Bay'});
  const keys=[...html.matchAll(/<details[^>]*data-pp-details-key="([^"]+)"/g)].map(match=>match[1]);
  const document={activeElement:{},defaultView:{Event:class Event{constructor(type){this.type=type;}}}};
  const details=keys.map(key=>{
    const node={dataset:{ppDetailsKey:key},open:false};
    const summary={closest:selector=>selector==='[data-pp-details-key]'?node:null,matches:()=>false,
      focus(){document.activeElement=this;}};
    node.querySelector=selector=>selector===':scope > summary'?summary:null;
    return node;
  });
  const session={open:false};
  const root={open:false,ownerDocument:document,
    querySelector:selector=>selector==='.pp-session-details'?session:null,
    querySelectorAll:selector=>selector==='[data-pp-details-key]'?details:[],
    contains:element=>details.some(node=>node.querySelector(':scope > summary')===element)};
  const get=key=>details.find(node=>node.dataset.ppDetailsKey===key);
  return {html,keys,document,root,session,get};
}

test('Session details renders stable, separate per-track keys',()=>{
  const fixture=profileFixture();
  assert.ok(fixture.keys.includes('session:'+A));
  assert.ok(fixture.keys.includes('session:'+B));
  assert.ok(fixture.keys.includes('track:'+A));
  assert.equal(new Set(fixture.keys).size,fixture.keys.length);
});

test('auto-refresh preserves expanded Session rows and summary focus after track reordering',()=>{
  const before=profileFixture();before.root.open=true;before.session.open=true;
  before.get('session:'+A).open=true;before.get('track:'+A).open=true;
  before.document.activeElement=before.get('session:'+A).querySelector(':scope > summary');
  const state=capturePracticeProfileView(before.root);
  assert.equal(state.detailFocus,'session:'+A);
  const after=profileFixture([B,A]);restorePracticeProfileView(after.root,state);
  assert.equal(after.root.open,true);assert.equal(after.session.open,true);
  assert.equal(after.get('session:'+A).open,true);assert.equal(after.get('session:'+B).open,false);
  assert.equal(after.get('track:'+A).open,true);
  assert.equal(after.document.activeElement,after.get('session:'+A).querySelector(':scope > summary'));
});

test('removing a previously focused session row does not focus an unrelated row or throw',()=>{
  const before=profileFixture();before.get('session:'+A).open=true;
  before.document.activeElement=before.get('session:'+A).querySelector(':scope > summary');
  const state=capturePracticeProfileView(before.root),after=profileFixture([B]),initial=after.document.activeElement;
  assert.doesNotThrow(()=>restorePracticeProfileView(after.root,state));
  assert.equal(after.document.activeElement,initial);
  assert.equal(after.get('session:'+B).open,false);
});

function refreshFixture({otherRacer=false}={}){
  const oldFinishes=[{trackId:A,timeMs:2000}],freshFinishes=[{trackId:A,timeMs:1000}],events=[];
  const context={entry:{userId:'account'},cachedFinishes:oldFinishes};
  const card={scrollTop:123},next={};
  const old={__ppDispose(){events.push('dispose');}};
  let current=old;
  Object.defineProperty(old,'outerHTML',{set(){current=next;card.scrollTop=0;events.push('replace');}});
  const content={__plannerContext:context,querySelector:()=>current};
  const popup={dataset:{profileUser:otherRacer?'other':'account'},querySelector:()=>card};
  let plannerFinishes;
  const sandbox={document:{visibilityState:'visible',getElementById:id=>id==='overallProfilePopup'?popup:content},
    activeRankedAccountId:()=> 'account',isElementVisible:()=>true,
    renderPracticeProfile:()=>'<details></details>',capturePracticeProfileView:()=>({saved:true}),
    cachedProfileFinishes:()=>freshFinishes,practiceProfileOptions:(_id,finishes)=>({finishes}),
    installPracticeProfileControls(){events.push('install');return ()=>{};},
    restorePracticeProfileView(){events.push('restore');},
    refreshOpenProfilePlanner(){plannerFinishes=context.cachedFinishes;events.push('planner');}};
  const refresh=vm.runInNewContext('('+functionSource('refreshOpenPracticeProfile','importPracticeStartupModule')+')',sandbox);
  return {refresh,events,context,card,next,freshFinishes,plannerFinishes:()=>plannerFinishes};
}

test('practice refresh updates planner finishes before recalculation and preserves scroll/disposal',()=>{
  const fixture=refreshFixture();fixture.refresh();
  assert.equal(fixture.context.cachedFinishes,fixture.freshFinishes);
  assert.equal(fixture.plannerFinishes(),fixture.freshFinishes);
  assert.equal(fixture.card.scrollTop,123);
  assert.equal(typeof fixture.next.__ppDispose,'function');
  assert.deepEqual(fixture.events,['dispose','replace','install','restore','planner']);
});

test('a queued practice refresh cannot replace another racer profile',()=>{
  const fixture=refreshFixture({otherRacer:true});fixture.refresh();
  assert.deepEqual(fixture.events,[]);assert.equal(fixture.plannerFinishes(),undefined);
});
