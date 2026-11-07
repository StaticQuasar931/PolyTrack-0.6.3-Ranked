import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
const start=source.indexOf('    let place=displayedRecordPlacement(period,mine,board);');
const code=source.slice(start,source.indexOf('    const placement=eventSidebarPlacementPresentation(place);',start));
function place({pending=false,enabled=true,policy='all',onlyVerified=false,base=null,filtered=false}={}){
 return vm.runInNewContext(code+';place;',{period:{},board:{},mine:{pending,rank:4,originalRank:7},rows:Array.from({length:9},()=>({pending})),
  displayedRecordPlacement:()=>base,readEventPlacementSettings:()=>({enabled,policy}),view:{onlyVerified},filterResult:{active:filtered}});
}
test('pending event fallback respects disabled and verified-only placement preferences',()=>{
 assert.equal(place({pending:true,enabled:false}),null);
 assert.equal(place({pending:true,policy:'verified'}),null);
 assert.equal(place({pending:true,onlyVerified:true}),null);
 const estimate=place({pending:true});assert.equal(estimate.rank,4);assert.equal(estimate.provisional,true);assert.equal(estimate.fieldSize,null);
});
test('personal filters do not replace the selected placement policy or promote a waiting PB',()=>{
 const verified={rank:2,fieldSize:3,policy:'verified',provisional:false};
 assert.equal(place({base:verified,filtered:true,policy:'verified'}),verified);
 assert.equal(place({pending:true,filtered:true,policy:'verified'}),null);
 assert.equal(place({enabled:false,filtered:true}),null);
 const visible=place({onlyVerified:true,policy:'all'});assert.equal(visible.fieldSize,9);assert.equal(visible.policy,'verified');assert.equal(visible.provisional,false);
});
