import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=source.indexOf('  function compactKodubPersonalBestPlacement(){');
const end=source.indexOf('  function decoratePersonalBestPodiums(){',start);
assert.ok(start>0&&end>start);
const code=source.slice(start,end);
const trackId='a'.repeat(64),otherId='b'.repeat(64);

function fixture({ordinal='4th',percentage=' (13.793%)',current=trackId,weekly=trackId,archived=false,event=false,trophy=true}={}){
  let writes=0,text=percentage;
  const faded={get textContent(){return text;},set textContent(value){writes++;text=value;}};
  const image={src:'images/trophy.svg'},rank={nodeType:3,textContent:ordinal};
  const row={childNodes:[image,rank,faded],querySelector:selector=>selector==='img[src="images/trophy.svg"]'?(trophy?image:null):selector==='span.faded'?faded:null};
  const timer={textContent:'00:16.027',querySelector:()=>null};
  const record={children:[timer,row]};
  const panel={__pt062EventWatch:{trackId:current},querySelector:selector=>selector==='.sq-event-board'?(event?{}:null):selector==='.side-panel .personal-best'?record:null};
  const context=vm.createContext({
    document:{querySelector:selector=>selector==='.track-info-ui'?panel:null},
    nativeWeeklySelection:weekly?{trackId:weekly}:null,
    kodubTrackHistory:new Map(archived?[[current,{}]]:[])
  });
  vm.runInContext(code,context);
  return {context,row,rank,image,timer,record,faded,get writes(){return writes;},render:()=>context.compactKodubPersonalBestPlacement()};
}

test('Kodub native PB keeps its trophy, ordinal and time with compact percentage, not a badge',()=>{
  const f=fixture(),children=[...f.row.childNodes];f.render();
  assert.equal(f.faded.textContent,' (13.8%)');
  assert.equal(f.rank.textContent,'4th');assert.equal(f.timer.textContent,'00:16.027');
  assert.deepEqual(f.row.childNodes,children);assert.equal(f.record.children.length,2);
});

test('precision is bounded, trailing zeroes disappear and tiny placements do not claim zero percent',()=>{
  for(const [before,after] of [[' (3.4483%)',' (3.4%)'],[' (10.000%)',' (10%)'],[' (100.00%)',' (100%)'],[' (0.1000%)',' (0.1%)'],[' (0.0001%)',' (<0.1%)']]){
    const f=fixture({percentage:before});f.render();assert.equal(f.faded.textContent,after);
    f.render();assert.equal(f.writes,1,'repeat decoration must not churn native DOM');
  }
});

test('native tie ordinals and teen suffixes are retained, never recalculated',()=>{
  for(const ordinal of ['1st','2nd','3rd','4th','11th','12th','13th','21st','101st']){
    const f=fixture({ordinal});f.render();assert.equal(f.rank.textContent,ordinal);assert.equal(f.faded.textContent,' (13.8%)');
  }
});

test('an archived Kodub native board gets the same presentation without an active weekly selection',()=>{
  const f=fixture({weekly:null,archived:true});f.render();assert.equal(f.faded.textContent,' (13.8%)');
});

test('ordinary tracks, unknown native bindings and event-only boards remain untouched',()=>{
  for(const options of [{current:otherId},{current:''},{current:'Hydropower'},{event:true}]){
    const f=fixture(options);f.render();assert.equal(f.writes,0);assert.equal(f.faded.textContent,' (13.793%)');
  }
});

test('missing, malformed or out-of-range placement is never invented or repaired',()=>{
  for(const options of [{ordinal:'---'},{ordinal:'0th'},{ordinal:''},{percentage:'---'},{percentage:' (NaN%)'},{percentage:' (-3%)'},{percentage:' (101%)'},{percentage:' (0%)'},{trophy:false}]){
    const f=fixture(options);f.render();assert.equal(f.writes,0);
  }
});

test('native rerender gets fresh formatting without caching old placement or mutating verification',()=>{
  const f=fixture();f.row.runVerified=false;f.render();
  f.rank.textContent='3rd';f.faded.textContent=' (10.345%)';f.render();
  assert.equal(f.rank.textContent,'3rd');assert.equal(f.faded.textContent,' (10.3%)');assert.equal(f.row.runVerified,false);
});

test('missing PB panel is a safe no-op and decorator runs before asynchronous card-module loading',()=>{
  const context=vm.createContext({document:{querySelector:()=>null},nativeWeeklySelection:null,kodubTrackHistory:new Map()});
  vm.runInContext(code,context);context.compactKodubPersonalBestPlacement();
  assert.match(source.slice(end,end+180),/decoratePersonalBestPodiums\(\)\{\s*compactKodubPersonalBestPlacement\(\);\s*void ensureRecordPlacementUi/);
});
