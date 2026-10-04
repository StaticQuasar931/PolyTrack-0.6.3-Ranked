import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const patch=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=patch.indexOf('  async function openKodubWeeklyFromEvents(');
const end=patch.indexOf('  function focusTrackFromRanked(',start);
const source=patch.slice(start,end).trim();
function fixture({available=true,visible=false}={}){
  let clicks=0,waits=0,closed=0;
  const weekly={click(){clicks++;},visible};
  const community={textContent:'Community tracks',visible:true,classList:{contains:()=>false},click(){if(available)weekly.visible=true;}};
  const document={getElementById:()=>null,querySelector:()=>weekly.visible?weekly:null,querySelectorAll:selector=>selector.includes('main-buttons')?[]:[community]};
  const launch=new Function('document','nativeWeeklySelection','closeOverallPanel','isElementVisible','setTimeout',source+';return openKodubWeeklyFromEvents;')(document,{trackId:'a'},()=>closed++,node=>node.visible,resolve=>{waits++;resolve();});
  return {launch,stats:()=>({clicks,waits,closed})};
}
test('weekly event uses the existing native track button without an import',async()=>{
  const f=fixture({visible:true});await f.launch();assert.deepEqual(f.stats(),{clicks:1,waits:0,closed:1});
});
test('weekly event opens Community before selecting its native card',async()=>{
  const f=fixture();await f.launch();assert.deepEqual(f.stats(),{clicks:1,waits:1,closed:1});
});
test('missing weekly card fails after a bounded wait instead of polling forever',async()=>{
  const f=fixture({available:false});await assert.rejects(f.launch(),/could not load/);assert.equal(f.stats().waits,40);assert.equal(f.stats().clicks,0);
});
test('leaving during weekly navigation prevents a delayed native selection',async()=>{
  const f=fixture();let checks=0;await assert.rejects(f.launch(()=>++checks===1),/cancelled/);assert.equal(f.stats().clicks,0);
});
