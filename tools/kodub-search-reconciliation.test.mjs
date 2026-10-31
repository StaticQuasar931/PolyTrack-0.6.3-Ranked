import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {combineKodubCard} from '../events/kodub-weekly.mjs';

const patch=fs.readFileSync(process.env.POLYTRACK_PATCH_PATH||new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=patch.indexOf('  function reconcileKodubWeeklyCard('),end=patch.indexOf('  function extraTrackIds(',start);
assert.ok(start>=0&&end>start);
const code=patch.slice(start,end);

// Minimal native-card DOM surface. No browser, physics, filesystem writes or I/O.
class Node {
  constructor(tag='div',classes=''){
    this.tagName=tag;this.children=[];this.parentElement=null;this.hidden=false;this.dataset={};this.attributes=new Map();this.textContent='';
    this.tokens=new Set(classes.split(/\s+/).filter(Boolean));
    this.classList={contains:value=>this.tokens.has(value),add:value=>this.tokens.add(value)};
    this.style={display:'',removeProperty(name){this[name]='';}};
  }
  set className(value){this.tokens=new Set(value.split(/\s+/).filter(Boolean));}
  get className(){return [...this.tokens].join(' ');}
  get isConnected(){return this.documentRoot===true||this.parentElement?.isConnected===true;}
  matches(selector){
    const not=/:not\(([^)]+)\)/.exec(selector);if(not&&this.matches(not[1]))return false;
    selector=selector.replace(/:not\([^)]+\)/g,'');
    if(selector.startsWith('.'))return selector.slice(1).split('.').every(value=>this.tokens.has(value));
    return selector===this.tagName;
  }
  querySelectorAll(selector){
    if(selector.startsWith(':scope > '))return this.children.filter(node=>node.matches(selector.slice(9)));
    return this.children.flatMap(node=>[...(node.matches(selector)?[node]:[]),...node.querySelectorAll(selector)]);
  }
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  closest(selector){return this.matches(selector)?this:this.parentElement?.closest(selector)||null;}
  remove(){if(this.parentElement){this.parentElement.children=this.parentElement.children.filter(node=>node!==this);this.parentElement=null;}}
  append(node){node.remove();node.parentElement=this;this.children.push(node);}
  prepend(node){node.remove();node.parentElement=this;this.children.unshift(node);}
  after(node){const parent=this.parentElement;node.remove();node.parentElement=parent;parent.children.splice(parent.children.indexOf(this)+1,0,node);}
  getAttribute(key){return this.attributes.get(key)??null;}
  setAttribute(key,value){this.attributes.set(key,String(value));}
  removeAttribute(key){this.attributes.delete(key);}
}

function fixture(){
  const root=new Node('main','track-selection-ui');root.documentRoot=true;
  const source=new Node('section'),heading=new Node('div','group-title'),card=new Node('div','track track-of-the-week');
  const button=new Node('button'),timer=new Node('div','time-remaining');timer.textContent='5d 4h 3m 2s';
  card.append(button);button.append(timer);source.append(heading);source.append(card);root.append(source);
  const group=new Node('section','sq-featured-events');group.append(new Node('h2','sq-featured-heading'));root.append(group);
  const ordinary=new Node('div','track');ordinary.style.display='none';root.append(ordinary);
  let clicks=0;button.click=()=>clicks++;
  const frames=new Map();let frameId=0;
  const selection={trackId:'a'.repeat(64),endTime:new Date(Date.now()+86400000).toISOString()};
  const context=vm.createContext({document:{createElement:tag=>new Node(tag)},kodubAdapter:{combineKodubCard},nativeWeeklySelection:selection,
    requestAnimationFrame:callback=>{frames.set(++frameId,callback);return frameId;},
    fetch(){assert.fail('network forbidden');},setTimeout(){assert.fail('timer rebuild forbidden');},setInterval(){assert.fail('timer rebuild forbidden');}});
  vm.runInContext(code,context);
  const reconcile=(menu=root,target=group)=>context.reconcileKodubWeeklyCard(menu,target);
  const drain=()=>{let turns=0;while(frames.size){assert.ok(++turns<=4,'frame repair must be bounded');const batch=[...frames.values()];frames.clear();for(const callback of batch)callback();}};
  return {root,group,card,button,timer,ordinary,context,selection,frames,reconcile,drain,get clicks(){return clicks;}};
}

test('search/click/exit restores original weekly card and hidden featured group, not unrelated results',()=>{
  const f=fixture();f.reconcile();f.drain();
  f.card.style.display='none';f.card.hidden=true;f.card.setAttribute('aria-hidden','true');f.group.style.display='none';
  f.root.hidden=true;f.reconcile();assert.equal(f.root.hidden,true,'do not reopen a hidden native menu');
  f.root.hidden=false;f.reconcile();f.drain();
  assert.equal(f.card.parentElement,f.group);assert.equal(f.card.style.display,'');assert.equal(f.card.hidden,false);
  assert.equal(f.card.getAttribute('aria-hidden'),null);assert.equal(f.group.style.display,'');assert.equal(f.ordinary.style.display,'none');
  f.button.click();assert.equal(f.clicks,1);assert.equal(f.card.querySelector('.time-remaining'),f.timer);assert.equal(f.timer.textContent,'5d 4h 3m 2s');
});

test('same-menu native wrapper replacement reattaches the original callback and countdown nodes',()=>{
  const f=fixture();f.reconcile();f.drain();f.group.remove();
  const replacement=new Node('section','sq-featured-events');f.root.append(replacement);
  f.reconcile(f.root,replacement);f.drain();
  assert.equal(replacement.querySelector('.sq-kodub-weekly'),f.card);assert.equal(f.card.querySelector('.time-remaining'),f.timer);
  f.button.click();assert.equal(f.clicks,1);
});

test('later search-enhancer filtering is repaired in one coalesced frame without native reconstruction',()=>{
  const f=fixture();for(let i=0;i<20;i++)f.reconcile();assert.equal(f.frames.size,1);
  f.card.style.display='none';f.group.style.display='none';f.drain();
  assert.equal(f.card.style.display,'');assert.equal(f.group.style.display,'');assert.equal(f.frames.size,0);
  assert.equal(f.root.querySelectorAll('.sq-kodub-weekly').length,1);assert.equal(f.card.querySelectorAll('.sq-kodub-label').length,1);
});

test('pending repair from a detached wrapper must not suppress repair for its replacement',()=>{
  const f=fixture();f.reconcile(); // Keep the first wrapper's repair frame pending.
  f.group.remove();const replacement=new Node('section','sq-featured-events');f.root.append(replacement);
  f.reconcile(f.root,replacement);
  f.card.style.display='none';replacement.style.display='none';f.drain();
  assert.equal(f.card.style.display,'');assert.equal(replacement.style.display,'');
});

test('a fresh native card wins over retained content and is not duplicated',()=>{
  const f=fixture();f.reconcile();f.drain();f.group.remove();
  const replacement=new Node('section','sq-featured-events'),native=new Node('div','track track-of-the-week');native.append(new Node('button'));
  f.root.append(replacement);f.root.append(native);f.reconcile(f.root,replacement);f.drain();
  assert.equal(replacement.querySelector('.sq-kodub-weekly'),native);assert.equal(f.card.isConnected,false);assert.equal(f.root.querySelectorAll('.sq-kodub-weekly').length,1);
});

test('expired or changed weekly identity is never resurrected after native wrapper removal',()=>{
  for(const changed of [false,true]){
    const f=fixture();f.reconcile();f.drain();f.group.remove();const replacement=new Node('section','sq-featured-events');f.root.append(replacement);
    f.context.nativeWeeklySelection=changed?{...f.selection,trackId:'b'.repeat(64)}:{...f.selection,endTime:new Date(Date.now()-1).toISOString()};
    f.reconcile(f.root,replacement);f.drain();assert.equal(replacement.querySelector('.sq-kodub-weekly'),null);
  }
});

test('separate native menus never borrow callbacks bound to a retired menu',()=>{
  const f=fixture();f.reconcile();f.drain();f.group.remove();
  const menu=new Node('main','track-selection-ui');menu.documentRoot=true;const group=new Node('section','sq-featured-events');menu.append(group);
  f.reconcile(menu,group);f.drain();assert.equal(group.querySelector('.sq-kodub-weekly'),null);
});

test('input repair and selection reconciliation both call the same bounded helper',()=>{
  assert.match(patch,/if\(group\)reconcileKodubWeeklyCard\(selection,group\)/);
  const input=patch.slice(patch.indexOf("document.addEventListener('input',event=>{",patch.indexOf('  function boot(){')));
  assert.match(input.slice(0,650),/restorePermanentRollingTrack\(\)[\s\S]*reconcileKodubWeeklyCard\(selection,group\)/);
  assert.doesNotMatch(code,/setInterval\(|setTimeout\(|fetch\(|firebase|loadKodubWeekly\(/i);
});
