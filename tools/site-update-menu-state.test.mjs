import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {canUpdateFromGameMenu,readSiteUpdateMenuState} from './site-update-menu-state.mjs';

class Element {
  constructor(document, tagName = 'div') {
    Object.assign(this,{ownerDocument:document,tagName:tagName.toUpperCase(),children:[],parentElement:null,
      className:'',id:'',hidden:false,style:{display:'block',visibility:'visible',opacity:'1'},rects:[{width:100,height:100}]});
    this.classList = {contains:name=>this.className.split(/\s+/).includes(name),
      add:name=>{this.className+=' '+name;},remove:name=>{this.className=this.className.split(/\s+/).filter(part=>part!==name).join(' ');}};
  }
  get isConnected(){return this===this.ownerDocument.documentElement||!!this.parentElement?.isConnected;}
  appendChild(node){node.remove();this.children.push(node);node.parentElement=this;return node;}
  removeChild(node){this.children.splice(this.children.indexOf(node),1);node.parentElement=null;return node;}
  remove(){if(this.parentElement)this.parentElement.removeChild(this);}
  matches(selector){return selector[0]==='.'?this.classList.contains(selector.slice(1)):
    selector[0]==='#'?this.id===selector.slice(1):selector==='[role="textbox"]'&&this.role==='textbox';}
  closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
  querySelectorAll(selectors){const list=selectors.split(',');return this.children.flatMap(child=>[
    ...(list.some(selector=>child.matches(selector))?[child]:[]),...child.querySelectorAll(selectors)]);}
  getClientRects(){return this.rects;}
}
function fixture(menu = '.menu-ui') {
  const document={visibilityState:'visible',defaultView:{getComputedStyle:node=>node.style},activeElement:null};
  document.createElement=tag=>new Element(document,tag);
  document.documentElement=document.createElement('html');
  document.body=document.documentElement.appendChild(document.createElement('body'));
  document.querySelectorAll=selector=>document.documentElement.querySelectorAll(selector);
  document.getElementById=id=>document.documentElement.querySelectorAll('#'+id)[0]||null;
  const add=(selector,parent=document.body,tag='div')=>{const node=document.createElement(tag);
    if(selector.startsWith('#'))node.id=selector.slice(1);else node.className=selector.slice(1);
    return parent.appendChild(node);};
  const ui=add('#ui');
  const root=menu?add(menu,menu.startsWith('#')||menu.startsWith('.sq-')?document.body:ui):null;
  return {document,ui,root,add,state:()=>readSiteUpdateMenuState(document),safe:()=>canUpdateFromGameMenu(document)};
}

for(const menu of ['.menu-ui','.settings-menu-ui','.track-info-ui','.track-selection-ui',
  '#overallLeaderboardPanel','#overallProfilePopup','#overallHelpPopup','.sq-events-overlay','.sq-extra-overlay']) {
  test('allows the real menu root '+menu,()=>{const f=fixture(menu);assert.deepEqual(f.state(),{canUpdate:true,reason:'menu'});});
}

for(const modal of ['profile-dialog','event-dialog','settings-dialog','site-compatibility']) {
  test('a '+modal+' modal over a menu does not veto an update',()=>{
    const f=fixture();const dialog=f.add('.'+modal,f.document.body,'dialog');dialog.open=true;
    dialog.dataset=modal==='site-compatibility'?{siteCompatibility:'unsupported'}:{};
    f.root.inert=true;f.root.ariaHidden='true';f.document.activeElement=f.document.createElement('button');
    assert.equal(f.safe(),true);
  });
}

for(const root of ['.game-ui','.pause-screen-ui','.session-end-ui']) {
  for(const hidden of [false,true])test(root+' vetoes a foreground menu/modal even when hidden='+hidden,()=>{
    const f=fixture('#overallProfilePopup'),track=f.add(root,f.ui);
    f.add('.site-compatibility',f.document.body,'dialog').open=true;
    if(hidden){track.hidden=true;track.classList.add('hidden');track.style.display='none';track.style.opacity='0';track.rects=[];}
    assert.deepEqual(f.state(),{canUpdate:false,reason:'track-active'});
  });
}

test('paused replay/track under settings remains unsafe until native root disposal',()=>{
  const f=fixture('.settings-menu-ui'),track=f.add('.game-ui',f.ui);track.classList.add('hidden');
  f.add('.pause-screen-ui',track);assert.equal(f.safe(),false);
  track.remove();assert.equal(f.safe(),true);
});

for(const marker of ['.editor-ui','.editor-side-toolbar-ui','.editor-height-selector-ui']) {
  test('hidden native editor marker '+marker+' vetoes a load/save menu',()=>{
    const f=fixture('.track-selection-ui'),editor=f.add('.hidden',f.ui);
    editor.style.display='none';f.add(marker,editor);
    assert.deepEqual(f.state(),{canUpdate:false,reason:'editor-active'});
    editor.remove();assert.equal(f.safe(),true);
  });
}

for(const loading of ['.loading-screen-ui','.loading-ui'])test('blocks connected loading lifetime '+loading,()=>{
  const f=fixture();f.add(loading).hidden=true;assert.equal(f.state().reason,'loading');
});

for(const type of ['text','search','email','number','url','tel','password','date'])test('blocks focused input type '+type,()=>{
  const f=fixture(),input=f.add('.field',f.root,'input');input.type=type;f.document.activeElement=input;
  assert.equal(f.state().reason,'text-entry');
});
for(const type of ['checkbox','radio','range','button','color'])test('non-text setting input '+type+' is still a menu',()=>{
  const f=fixture('.settings-menu-ui'),input=f.add('.field',f.root,'input');input.type=type;f.document.activeElement=input;
  assert.equal(f.safe(),true);
});
for(const tag of ['textarea','select','iframe'])test('blocks focused '+tag,()=>{
  const f=fixture();f.document.activeElement=f.add('.field',f.root,tag);assert.equal(f.state().reason,'text-entry');
});
test('blocks inherited contenteditable, textbox descendants and shadow-root text entry',()=>{
  const f=fixture();f.document.activeElement=f.add('.editable',f.root);f.document.activeElement.isContentEditable=true;
  assert.equal(f.safe(),false);
  const textbox=f.add('.textbox',f.root);textbox.role='textbox';f.document.activeElement=f.add('.child',textbox);
  assert.equal(f.safe(),false);
  const host=f.add('.host',f.root),input=f.document.createElement('input');
  host.shadowRoot={activeElement:input};f.document.activeElement=host;assert.equal(f.safe(),false);
});

for(const [field,value] of [['display','none'],['visibility','hidden'],['visibility','collapse'],['opacity','0']]) {
  test('checks '+field+' on menu ancestors, not only the menu rectangle',()=>{
    const f=fixture();f.ui.style[field]=value;assert.equal(f.state().reason,'menu-unavailable');
  });
}
test('hidden attr, native hidden class and zero-size menus cannot establish readiness',()=>{
  const f=fixture();f.ui.hidden=true;assert.equal(f.safe(),false);f.ui.hidden=false;
  f.ui.classList.add('hidden');assert.equal(f.safe(),false);f.ui.classList.remove('hidden');
  f.root.rects=[{width:0,height:0}];assert.equal(f.safe(),false);
});
test('visible custom profile/events can establish a menu when native menu is hidden',()=>{
  const f=fixture();f.root.style.display='none';const profile=f.add('#overallProfilePopup');
  assert.equal(f.safe(),true);profile.remove();f.add('.sq-events-overlay');assert.equal(f.safe(),true);
  f.add('.game-ui',f.ui).hidden=true;assert.equal(f.safe(),false);
});
test('a generic/updater dialog alone is not proof that the native game is in a menu',()=>{
  const f=fixture(null);f.add('.site-compatibility',f.document.body,'dialog').open=true;
  assert.equal(f.state().reason,'menu-unavailable');
});
test('hidden tab, missing native root and unavailable style APIs fail closed',()=>{
  const f=fixture();f.document.visibilityState='hidden';assert.equal(f.state().reason,'page-hidden');
  f.document.visibilityState='visible';f.ui.remove();assert.equal(f.state().reason,'native-ui-unavailable');
  const g=fixture();g.document.defaultView=null;assert.equal(g.state().reason,'visibility-unavailable');
  assert.equal(readSiteUpdateMenuState(null).canUpdate,false);
});
test('DOM/style failures fail closed; decisions are immutable and recomputed',()=>{
  const f=fixture(),before=f.state();assert.ok(Object.isFrozen(before));
  const track=f.add('.game-ui',f.ui);assert.equal(f.safe(),false);track.remove();assert.equal(f.safe(),true);
  f.document.defaultView.getComputedStyle=()=>{throw Error('detached view');};assert.equal(f.state().reason,'state-unavailable');
});

const native=readFileSync(new URL('../main.bundle.js',import.meta.url),'utf8');
const editor=readFileSync(new URL('../112.bundle.js',import.meta.url),'utf8');
test('actual shipped driving/replay HUD lifecycle remains unsafe when native isVisible=false',()=>{
  const start=native.indexOf('const Fr=class{constructor()'),end=native.indexOf(';var Wr=',start);
  assert.ok(start>=0&&end>start,'native game UI class must be re-audited if its contract changes');
  assert.equal((native.match(/new Fr(?:,|\b)/g)||[]).length,2,'both driving and replay own this UI');
  const f=fixture(),R={GG:(object,map,value)=>map.set(object,value),gn:(object,map)=>map.get(object)};
  const NativeUI=vm.runInNewContext('(()=>{let Dr=new WeakMap,Br=new WeakMap,Gr=new WeakMap;'+native.slice(start,end)+';return Fr;})()',
    {document:f.document,R});
  const hud=new NativeUI();assert.equal(f.safe(),false);hud.isVisible=false;
  assert.equal(hud.element.classList.contains('hidden'),true);assert.equal(f.safe(),false);
  hud.dispose();assert.equal(f.safe(),true);
});
test('shipped editor hides its root class but retains structural ownership markers until disposal',()=>{
  assert.ok(editor.includes('(0,i.gn)(this,re,"f").className="hidden"'));
  for(const marker of ['editor-side-toolbar-ui','editor-height-selector-ui'])assert.ok(editor.includes('className="'+marker+'"'));
  assert.ok(editor.includes('t.removeChild((0,i.gn)(this,re,"f"))'));
  assert.ok(native.includes('.className="menu-ui"'));
  assert.ok(native.includes('removeChild((0,R.gn)(this,Eh,"f"))'),'native menu is controller-owned too');
});

test('actual native loading-screen root is removed, not hidden and pooled, on disposal',()=>{
  const module=native.indexOf('4962:(e,t,n)=>'),start=native.indexOf('const b=class{constructor(e)',module);
  const end=native.indexOf('},4996:',start);
  assert.ok(module>=0&&start>module&&end>start,'re-audit the native loading-screen module if its contract changes');
  const f=fixture(),i={GG:(object,map,value)=>map.set(object,value),gn:(object,map)=>map.get(object)};
  const LoadingScreen=vm.runInNewContext('(()=>{let A=new WeakMap,y=new WeakMap;'+native.slice(start,end)+';return b;})()',
    {document:f.document,i});
  const loading=new LoadingScreen(true),root=f.ui.querySelectorAll('.loading-screen-ui')[0];
  assert.ok(root?.isConnected);assert.equal(f.state().reason,'loading');
  assert.equal(typeof loading.hide,'undefined','no hidden static loading-screen pool API');
  root.hidden=true;root.style.opacity='0';assert.equal(f.safe(),false,'a still-active hidden loader remains a veto');
  loading.dispose();assert.equal(root.isConnected,false);assert.equal(f.safe(),true);
  for(const field of ['Wa','Wc','oh','Lh'])assert.ok(native.includes('(0,R.gn)(this,'+field+',"f")?.dispose()'),
    'native loading-screen owner '+field+' must dispose its transient root');
  assert.ok(editor.includes('.finally((()=>{(0,i.gn)(this,be,"f")?.dispose()'),
    'editor load completion disposes its loading screen on success or failure');
});

test('actual startup loading UI blocks during fade and is detached by the completion callback',()=>{
  const start=native.indexOf('const Fs=class{constructor(e,t,n)'),end=native.indexOf(';var Ws=',start);
  assert.ok(start>=0&&end>start,'re-audit the native startup loader if its contract changes');
  const f=fixture(),R={GG:(object,map,value)=>map.set(object,value),gn:(object,map)=>map.get(object)};
  let finishFade=null,delay=null,progress=null;
  const LoadingUI=vm.runInNewContext('(()=>{let Bs=new WeakMap,Gs=new WeakMap;'+native.slice(start,end)+';return Fs;})()',
    {document:f.document,R,setTimeout:(callback,ms)=>{finishFade=callback;delay=ms;}});
  const loading=new LoadingUI(f.root,{get:key=>key},{addProgressListener:callback=>{progress=callback;}});
  const root=f.ui.querySelectorAll('.loading-ui')[0];assert.ok(root?.isConnected);
  progress(1);assert.equal(f.state().reason,'loading','progress completion alone is not disposal');
  loading.fadeOut(()=>loading.dispose());assert.equal(delay,250);
  assert.equal(root.classList.contains('fade-out'),true);root.style.opacity='0';
  assert.equal(f.safe(),false,'fade-out root remains active until its completion callback');
  finishFade();assert.equal(root.isConnected,false);assert.equal(f.safe(),true);
  assert.equal(f.ui.querySelectorAll('.loading-ui').length,0,'no hidden startup loading root survives');
  const caller=native.indexOf('new Fs(');assert.ok(caller>=0);
  assert.ok(native.slice(caller-250,caller).includes('i.hasLoaded()?'),'already-loaded startup skips creating this loader');
  const completion=native.slice(caller,caller+700);
  assert.ok(completion.includes('i.addCompleteListener('));
  assert.ok(completion.includes('n?.fadeOut((()=>{n.dispose();'),'actual startup completion must dispose, not just fade');
});
