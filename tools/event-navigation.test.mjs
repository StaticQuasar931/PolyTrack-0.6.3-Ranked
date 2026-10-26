import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const patch=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const extract=name=>{const start=patch.indexOf('  function '+name+'(');assert.ok(start>=0);return patch.slice(start,patch.indexOf('\n  }',start)+4);};
function fixture(){
  const frames=[];let selected=1,clicks=0,visible=true,now=0;const scroll={scrollTop:240};
  const tabs=[0,1,2].map(index=>({classList:{contains:()=>selected===index},click(){selected=index;clicks++;}}));
  const menu={querySelectorAll:()=>tabs,querySelector:()=>scroll};
  const document={querySelector:()=>menu};
  const c=vm.createContext({document,Date:{now:()=>now},requestAnimationFrame:fn=>frames.push(fn),isElementVisible:()=>visible});
  vm.runInContext('let eventTrackReturnContext=null,eventTrackReturnEpoch=0;'+extract('rememberEventTrackSelection')+extract('restoreEventTrackSelection'),c);
  return {c,frames,scroll,advance:ms=>now+=ms,select:value=>selected=value,selected:()=>selected,clicks:()=>clicks,show:()=>visible=true,hide:()=>visible=false};
}
test('official weekly track Back restores the originating community tab and scroll once',()=>{
  const f=fixture();f.c.rememberEventTrackSelection();f.select(0);f.scroll.scrollTop=0;
  f.c.restoreEventTrackSelection();f.c.restoreEventTrackSelection();assert.equal(f.frames.length,1);f.frames.shift()();
  assert.equal(f.selected(),1);assert.equal(f.scroll.scrollTop,240);assert.equal(f.clicks(),1);
});
test('a newer navigation or closed selection cannot be overwritten by an old return frame',()=>{
  const f=fixture();f.c.rememberEventTrackSelection();f.c.restoreEventTrackSelection();f.select(2);f.c.rememberEventTrackSelection();
  f.frames.shift()();assert.equal(f.selected(),2);assert.equal(f.clicks(),0);
  f.c.restoreEventTrackSelection();f.hide();f.frames.shift()();assert.equal(f.clicks(),0);
});
test('event scaffold only fills the missing native board and clears as soon as it is visible',()=>{
  let active=true,board=null,visible=false,placeholder=false;
  const menu={querySelector:()=>board,classList:{toggle:(_,value)=>placeholder=value}};
  const c=vm.createContext({document:{querySelector:()=>menu,body:{classList:{contains:()=>active}}},isElementVisible:()=>visible,getComputedStyle:()=>({display:visible?'flex':'none'})});
  vm.runInContext(extract('syncEventLoadingScaffold'),c);
  c.syncEventLoadingScaffold();assert.equal(placeholder,true);
  board={isConnected:true,getClientRects:()=>[{}]};visible=true;c.syncEventLoadingScaffold();assert.equal(placeholder,false);
  active=false;visible=false;c.syncEventLoadingScaffold();assert.equal(placeholder,false);
});
test('settings are enhanced in the mutation callback before its general throttled reconciliation',()=>{
  const start=patch.indexOf('const observer = new MutationObserver((records) => {',patch.indexOf('const RECONCILE_MIN_GAP_MS'));
  const observer=patch.slice(start,patch.indexOf('function boot()',start));
  assert.ok(observer.indexOf('withoutUiFeedback(ensureSettingsEnhancements)')<observer.indexOf('setTimeout('));
});


test('event Back waits for native selection layout instead of losing the return tab',()=>{
 const f=fixture();f.c.rememberEventTrackSelection();f.select(0);f.hide();
 f.c.restoreEventTrackSelection();f.c.restoreEventTrackSelection();
 for(let i=0;i<8;i++){assert.equal(f.frames.length,1);f.frames.shift()();}
 assert.equal(f.selected(),0);f.show();f.frames.shift()();
 assert.equal(f.selected(),1);assert.equal(f.clicks(),1);assert.equal(f.frames.length,0);
});
test('hidden event return retries are bounded and newer navigation cancels them',()=>{
 const f=fixture();f.c.rememberEventTrackSelection();f.hide();f.c.restoreEventTrackSelection();
 let count=0;while(f.frames.length){f.frames.shift()();assert.ok(++count<=1024);}
 assert.equal(count,1024);assert.equal(f.clicks(),0);
 f.show();f.c.restoreEventTrackSelection();assert.equal(f.frames.length,0);
});

test('event Back survives high-refresh animation frames but expires after three real seconds',()=>{
 const f=fixture();f.c.rememberEventTrackSelection();f.select(0);f.hide();f.c.restoreEventTrackSelection();
 for(let i=0;i<240;i++){f.advance(1000/240);f.frames.shift()();}
 f.show();f.frames.shift()();assert.equal(f.selected(),1);
 const g=fixture();g.c.rememberEventTrackSelection();g.hide();g.c.restoreEventTrackSelection();g.advance(3001);g.frames.shift()();assert.equal(g.frames.length,0);
});


test('an event opened outside track selection returns to Community rather than a hidden Official tab',()=>{
 const f=fixture();f.select(0);f.hide();f.c.rememberEventTrackSelection();
 f.show();f.c.restoreEventTrackSelection();f.frames.shift()();assert.equal(f.selected(),1);
});
