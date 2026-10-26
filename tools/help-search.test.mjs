import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const patch=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=patch.indexOf('  function filterRankedHelp('),source=patch.slice(start,patch.indexOf('\n  function rankedHelpMarkup',start));
function fixture(){
 const section=(title,open,labels)=>({title,open,hidden:false,dataset:{},rows:labels.map(textContent=>({textContent,hidden:false})),
  querySelector(){return {textContent:title};},querySelectorAll(){return this.rows;}});
 const groups=[section('Driving',true,['W / Up Accelerate','P / Space Pause']),section('Rankings',false,['A / D Previous / next page'])],empty={hidden:true};
 const root={querySelectorAll:()=>groups,querySelector:()=>empty};
 const context=vm.createContext({String,Boolean});vm.runInContext(source,context);
 return {groups,empty,filter:query=>context.filterRankedHelp(root,query)};
}
test('help filters actions and keys without losing the previous disclosure state',()=>{
 const f=fixture();f.filter('pause');assert.equal(f.groups[0].rows[0].hidden,true);assert.equal(f.groups[0].rows[1].hidden,false);assert.equal(f.groups[1].hidden,true);
 f.filter('rankings');assert.equal(f.groups[1].open,true);assert.equal(f.groups[1].rows[0].hidden,false);
 f.filter('');assert.equal(f.groups[0].open,true);assert.equal(f.groups[1].open,false);assert.ok(f.groups.every(g=>g.rows.every(r=>!r.hidden)));
});
test('unmatched input has a clear empty state and is never interpreted as markup',()=>{
 const f=fixture();f.filter('<script>');assert.ok(f.groups.every(g=>g.hidden));assert.equal(f.empty.hidden,false);
 f.filter('UP');assert.equal(f.empty.hidden,true);assert.equal(f.groups[0].rows[0].hidden,false);
});
test('all original control groups and configurable ghost shortcut remain present',()=>{
 const markup=patch.slice(patch.indexOf('  function rankedHelpMarkup('),patch.indexOf('  function buildOverallPanel('));
 for(const label of ['Main menu','Rankings and pages','Track selection','Track boards and ghosts','Driving: default keys','Replay and spectator: default keys','Track editor: default keys','Menus and accessibility','opponentShortcutLabel'])assert.ok(markup.includes(label),label);
 assert.ok(markup.includes('rankedHelpSearch'));
});
