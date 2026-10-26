import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
const source=await fs.readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const css=await fs.readFile(new URL('../responsive-ui.css',import.meta.url),'utf8');
const start=source.indexOf('  function renderEntries('),render=source.slice(start,source.indexOf('\n  }\n',start)+4);
function harness(){
  let markup='',nodes=[],writes=0,finished=0;
  const list={scrollTop:0,querySelector:()=>nodes[0]||null,querySelectorAll:()=>nodes};
  Object.defineProperty(list,'innerHTML',{get:()=>markup,set:value=>{writes++;markup=value;nodes=[...value.matchAll(/data-userid="([^"]+)"/g)].map(m=>({id:m[1],getAnimations:()=>[
    {animationName:'overallEntryIn',finish(){finished++;}},
    {animationName:'cosmeticPulse',finish(){assert.fail('unrelated animation altered');}}
  ]}));}});
  const context=vm.createContext({Array,Boolean,Number,Object,Math,overallCategory:'overall',overallPage:0,OVERALL_PAGE_SIZE:15,
    overallEntriesCache:[],overallLoadState:{},FILTERABLE_RANKED_CATEGORIES:new Set(['overall']),
    document:{getElementById:id=>id==='overallLeaderboardList'?list:id==='overallLeaderboardPanel'?{setAttribute(){}}:null,querySelectorAll:()=>[]},
    overlaySnapshotRacerDirectory:rows=>rows,setRankedFilterSnapshotMeta:()=>{},updateOverallPager:()=>{},hydrateOverallCarModels:()=>{},
    sortedOverallEntries:()=>context.overallEntriesCache.map(r=>({...r,categoryRank:r.rank})),
    syncRankedFilterRowsSafely:rows=>({available:true,rows,filter:{category:'overall'}}),
    renderEntryRow:r=>`<div class="overall-entry" data-userid="${r.userId}">${r.score}</div>`});
  vm.runInContext(render,context);
  const rows=[{userId:'synthetic-a',rank:1,score:10},{userId:'synthetic-b',rank:2,score:11}];
  return {context,rows,list,state:()=>({markup,nodes,writes,finished})};
}
test('initial preview skips only its entrance animation before the first paint',()=>{
  const h=harness();h.context.renderEntries(h.rows,{complete:false},{quietRows:true});
  assert.equal(h.state().writes,1);assert.equal(h.state().finished,2);assert.equal(h.state().nodes.length,2);
});
test('unchanged preview-to-full commit retains the exact visible row nodes',()=>{
  const h=harness();h.context.renderEntries(h.rows,{complete:false},{quietRows:true});const previous=h.state();
  h.context.renderEntries([...h.rows],{complete:true},{preservePage:true,quietRows:true});
  assert.equal(h.state().writes,1);assert.equal(h.state().nodes,previous.nodes);assert.equal(h.state().finished,2);
});
test('changed background rows are prepared before replacing visible rows and stay opaque',()=>{
  const h=harness();h.context.renderEntries(h.rows,{complete:false},{quietRows:true});const prior=h.state();
  const renderer=h.context.renderEntryRow;h.context.renderEntryRow=()=>{throw Error('not ready');};
  assert.throws(()=>h.context.renderEntries(h.rows,{complete:true},{quietRows:true}),/not ready/);
  assert.equal(h.state().nodes,prior.nodes);assert.equal(h.state().markup,prior.markup);
  h.context.renderEntryRow=renderer;h.context.renderEntries(h.rows.map(r=>({...r,score:r.score+1})),{complete:true},{quietRows:true});
  assert.equal(h.state().writes,2);assert.equal(h.state().finished,4);
});
test('normal page transitions retain their original entry animation',()=>{
  const h=harness();h.context.renderEntries(h.rows,{complete:false},{quietRows:true});
  h.context.renderEntries(h.rows,{complete:true},{preservePage:true});
  assert.equal(h.state().writes,2);assert.equal(h.state().finished,2);
});
test('quiet rendering is opt-in at preview/commit calls; production notice and compact favorites exist',()=>{
  assert.match(render,/quietRows=false/);assert.match(source,/renderEntries\(preview.entries,preview.meta,\{quietRows:true\}\)/);
  assert.match(source,/quietRows:Boolean\(firstPreview\)/);
  assert.match(source,/<div id="overallDataNotice"[^>]*role="status"/);
  assert.match(css,/\.overall-mobile-drawer \.leaderboard-arcade\s*\{\s*display:\s*block\s*!important/);
});
