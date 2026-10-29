const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../polytrack_062_patch.js'),'utf8');
const start=source.indexOf('  function handleLobbyShortcut('),end=source.indexOf('  let nativeTopSelectToken=',start);
assert.ok(start>0&&end>start);
function fixture(){let clicks=0,prevented=0;const action={click:()=>clicks++};
  const c={HTMLInputElement:class{},HTMLTextAreaElement:class{},HTMLSelectElement:class{},isStartMenuHotkeyContext:()=>true,
    findLobbyAction:()=>action,lobbyShortcutButtons:()=>[action],document:{getElementById:()=>action},isElementVisible:()=>true};
  vm.createContext(c);vm.runInContext(source.slice(start,end),c);
  return {run:(key,interactive=false)=>c.handleLobbyShortcut({key,target:{closest:()=>interactive?{}:null},preventDefault:()=>prevented++,stopPropagation(){}}),clicks:()=>clicks,prevented:()=>prevented};
}
test('Space retains native activation of the focused interactive control',()=>{
  const f=fixture();assert.equal(f.run(' ',true),false);assert.equal(f.run('spacebar',true),false);
  assert.equal(f.clicks(),0);assert.equal(f.prevented(),0);
});
test('Space on the menu background and explicit Play shortcut still work',()=>{
  const f=fixture();assert.equal(f.run(' '),true);assert.equal(f.run('p',true),true);assert.equal(f.clicks(),2);assert.equal(f.prevented(),2);
});
