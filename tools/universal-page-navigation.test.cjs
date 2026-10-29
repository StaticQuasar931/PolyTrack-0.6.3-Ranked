const fs=require('node:fs'),vm=require('node:vm'),test=require('node:test'),assert=require('node:assert/strict');
const source=fs.readFileSync(require('node:path').join(__dirname,'../polytrack_062_patch.js'),'utf8');
const a=source.indexOf('  function shortcutDigit('),b=source.indexOf('  function handleOverallLeaderboardShortcut(',a);
assert.ok(a>0&&b>a);
const input=(code,extra={})=>({key:'',code,shiftKey:true,...extra});
function fixture(){const c=vm.createContext({});vm.runInContext(source.slice(a,b),c);return c;}
test('one page-chord implementation serves every pagination scope',()=>{
  const c=fixture();
  for(const name of ['Overall','track','event','archive']){
    const scope={name};assert.equal(c.readPageNavigation(input('Digit3'),scope,5,20).page,3);
    assert.equal(c.readPageNavigation(input('Equal'),scope,5,20).prefix,true);
    assert.equal(c.readPageNavigation(input('Digit3'),scope,5,20).page,8);
    c.readPageNavigation(input('Minus'),scope,8,20);assert.equal(c.readPageNavigation(input('Numpad2'),scope,8,20).page,6);
    c.handleOverallLeaderboardModifierRelease({key:'Shift'});assert.equal(c.readPageNavigation(input('Digit3'),scope,6,20).page,3);
  }
});
test('relative mode never leaks to another menu, non-Shift controls or blur reset',()=>{
  const c=fixture(),first={},second={};c.readPageNavigation(input('Equal'),first,8,30);
  assert.equal(c.readPageNavigation(input('Digit2'),second,8,30).page,2);
  c.readPageNavigation(input('Equal'),second,8,30);assert.equal(c.readPageNavigation(input('KeyA',{shiftKey:false}),second,8,30),null);
  assert.equal(c.readPageNavigation(input('Digit2'),second,8,30).page,2);
  c.readPageNavigation(input('Equal'),second,8,30);c.resetOverallPageOffset();assert.equal(c.readPageNavigation(input('Digit2'),second,8,30).page,2);
});
test('zero means ten, relative boundaries clamp, and browser-modifier chords are not consumed',()=>{
  const c=fixture(),scope={};assert.equal(c.readPageNavigation(input('Digit0'),scope,1,30).page,10);
  c.readPageNavigation(input('Equal'),scope,29,30);assert.equal(c.readPageNavigation(input('Digit9'),scope,29,30).page,30);
  c.readPageNavigation(input('Minus'),scope,2,30);assert.equal(c.readPageNavigation(input('Digit9'),scope,2,30).page,1);
  for(const modifier of ['ctrlKey','altKey','metaKey'])assert.equal(c.readPageNavigation(input('Digit2',{[modifier]:true}),scope,1,30),null);
});
test('native, event and archive handlers actually call the shared implementation',()=>{
  for(const name of ['handleTrackLeaderboardShortcut','handleOverallLeaderboardShortcut','handleArchivePageShortcut']){
    const i=source.indexOf('  function '+name+'('),j=source.indexOf('\n  }',i);assert.match(source.slice(i,j),/readPageNavigation\(event,/);
  }
  const event=fs.readFileSync(require('node:path').join(__dirname,'../events/client.mjs'),'utf8');assert.match(event,/bridge\.pageNavigation\?\.\(event,board,/);
  assert.match(source,/pageNavigation:readPageNavigation/);
});
