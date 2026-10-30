import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {eventPagination,renderEventPagination,eventSnapshotFields,eventFieldSummary,eventRowVerified,decorateEventRowPresentation,eventDisplayRunAt} from './client.mjs';

const hash=n=>n.toString(16).padStart(64,'0');
const row=n=>({accountId:hash(n),name:'Racer '+n,timeMs:1000+n,rank:n,rp:1,
  physicsVerified:true,replayIntegrityVerified:true});
const waiting=n=>({...row(n),runId:hash(n+10000),pending:true,verified:false,
  eventRpEligible:false,verificationStatus:'waiting',source:'pending-event-playback'});
const board=(verified=205,pending=36)=>({period:{id:'weekly-fixture',kind:'weekly',trackId:hash(9999)},
  entries:Array.from({length:verified},(_,i)=>row(i+1)),
  pendingPlaybacks:Array.from({length:pending},(_,i)=>waiting(i+verified+1)),
  complete:true,totalEntries:verified,sourceComplete:true});

function pagerFixture(size,page=0){
  const document={createElement:()=>({dataset:{},attributes:{},setAttribute(k,v){this.attributes[k]=v;}})};
  const pages={ownerDocument:document,children:[],setAttribute(){},replaceChildren(){this.children=[];},append(node){this.children.push(node);}};
  const view={page,onlyVerified:false,filter:'friends',board:{querySelector:()=>pages}};
  let draws=0;
  const render=()=>{draws++;renderEventPagination(view,size,render);};render();
  return {view,pages,draws:()=>draws};
}

test('loaded event fields over 200 retain every racer and reach their exact last page',()=>{
  for(const archived of [false,true]){
    const saved={...board(),archived},before=structuredClone(saved),fields=eventSnapshotFields(saved);
    assert.deepEqual(fields.counts,{all:241,verified:205,pending:36,verifiedInAll:205});
    assert.equal(eventPagination(fields.all.rows.length).pageCount,13);
    assert.equal(eventPagination(fields.verified.rows.length).pageCount,11);
    assert.deepEqual(Array.from({length:13},(_,page)=>fields.all.rows.slice(page*20,page*20+20).length),[20,20,20,20,20,20,20,20,20,20,20,20,1]);
    assert.equal(fields.all.rows[200].rank,201);assert.equal(fields.all.rows.at(-1).rank,241);
    assert.deepEqual(saved,before);
  }
});

test('pagination clamps empty, invalid, negative and out-of-range pages at exact boundaries',()=>{
  for(const [size,count,lastSize] of [[0,1,0],[1,1,1],[20,1,20],[21,2,1],[199,10,19],[200,10,20],[201,11,1],[240,12,20],[241,13,1]]){
    const last=eventPagination(size,99999);
    assert.equal(last.page,count-1);assert.equal(last.pageCount,count);
    assert.equal(Math.max(0,size-last.offset),lastSize);
    assert.equal(eventPagination(size,-10).page,0);
    for(const invalid of [NaN,Infinity,null,'4',1.5])assert.equal(eventPagination(size,invalid).page,0);
  }
});

test('numbered window matches normal arrows, stays bounded and reaches beyond page ten without reads',()=>{
  const f=pagerFixture(461);
  assert.equal(f.pages.children.length,9);
  assert.equal(f.pages.children[0].disabled,true);
  for(let page=1;page<24;page++){
    f.pages.children.at(-1).onclick();
    assert.equal(f.view.page,page);assert.equal(f.view.pageCount,24);
    assert.equal(f.pages.children.find(node=>node.attributes['aria-current']==='page').dataset.eventPage,String(page+1));
    assert.ok(f.pages.children.length<=9);
  }
  assert.equal(f.pages.children.at(-1).disabled,true);
  f.pages.children[0].onclick();assert.equal(f.view.page,22);
  const number=f.pages.children.find(node=>node.dataset.eventPage==='21');number.onclick();assert.equal(f.view.page,20);
  assert.equal(f.view.filter,'friends');assert.equal(f.view.onlyVerified,false);
  const draws=f.draws();f.view.changePage(20);assert.equal(f.draws(),draws);
  assert.equal(pagerFixture(0).pages.children.at(-1).disabled,true);
});

test('changing verification or personal filters clamps pages to that field and retains tie ranks',()=>{
  const saved=board(),all=eventSnapshotFields(saved);
  const last=eventPagination(all.all.rows.length,12);
  assert.equal(eventPagination(all.verified.rows.length,last.page).page,10);
  saved.entries[1].timeMs=saved.entries[0].timeMs;
  const filtered=eventSnapshotFields(saved,{filterRows:rows=>({active:true,rows:rows.filter(r=>r.timeMs<1004)})});
  assert.deepEqual(filtered.verified.rows.map(r=>r.rank),[1,1,3]);
  assert.equal(eventPagination(filtered.verified.rows.length,last.page).page,0);
  assert.deepEqual(filtered.counts,{all:3,verified:3,pending:0,verifiedInAll:3});
});

test('counts distinguish a faster pending PB from the older verified PB for the same racer',()=>{
  const saved=board(2,0);saved.pendingPlaybacks=[{...waiting(1),timeMs:500}];
  const {counts}=eventSnapshotFields(saved);
  assert.deepEqual(counts,{all:2,verified:2,pending:1,verifiedInAll:1});
  assert.equal(eventFieldSummary(saved,counts),'2 players · 1 verified');
  assert.equal(eventFieldSummary(saved,counts,true),'2 verified players');
});

test('partial source totals never create fictional pages, racers, proof or awards',()=>{
  const saved={...board(45,155),complete:false,sourceComplete:false,totalEntries:300,racerCount:400,
    pagination:{hasMore:true,pageCount:3,totalEntries:300}};
  const {counts,all}=eventSnapshotFields(saved),before=structuredClone(saved);
  assert.equal(all.rows.length,200);assert.equal(eventPagination(all.rows.length,10).page,9);
  assert.equal(eventPagination(all.rows.length).pageCount,10);
  assert.equal(eventFieldSummary(saved,counts),'Loaded: 200 players · 45 verified');
  assert.equal(eventFieldSummary(saved,counts,true),'Loaded: 45 verified players');
  assert.equal(all.rows.filter(eventRowVerified).length,45);
  assert.ok(all.rows.filter(r=>r.pending).every(r=>r.rp===0));
  assert.deepEqual(saved,before);
});

test('event keyboard uses actual page state, not the bounded window button count',()=>{
  const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
  const start=source.indexOf("  document.addEventListener('keydown',event=>{\n    if(event.defaultPrevented||event.repeat||event.ctrlKey||event.altKey||event.metaKey||!nativeView?.board?");
  const end=source.indexOf("  document.addEventListener('keyup',event=>{",start);
  assert.ok(start>=0&&end>start);
  const f=pagerFixture(461,10),seen=[];let handler;
  f.view.board.getClientRects=()=>[{}];f.view.board.querySelectorAll=()=>[];
  const context={nativeView:f.view,dialog:null,eventDigitBoard:null,eventDigitsHeld:new Map(),eventDigitsConsumed:new Set(),
    eventTopPrefixUntil:0,eventTopHeld:false,topSelectionToken:0,
    document:{addEventListener:(_,fn)=>{handler=fn;},querySelector:()=>null},
    bridge:{pageNavigation:(_event,_scope,current,total)=>{seen.push([current,total]);return context.navigation;}}};
  vm.runInNewContext(source.slice(start,end),context);
  const key=(key,extra={})=>{let consumed=false;handler({key,target:{},preventDefault(){consumed=true;},stopImmediatePropagation(){},...extra});return consumed;};
  assert.equal(key('ArrowRight'),true);assert.equal(f.view.page,11);assert.deepEqual(seen.at(-1),[11,24]);
  context.navigation={page:24};key('9',{shiftKey:true});assert.equal(f.view.page,23);
  context.navigation=null;key('ArrowRight');assert.equal(f.view.page,23);
  key('ArrowLeft');assert.equal(f.view.page,22);
  key('0',{shiftKey:true});assert.equal(f.view.page,9);
  key('ArrowRight',{target:{tagName:'INPUT'}});assert.equal(f.view.page,9);
  key('ArrowRight',{ctrlKey:true});assert.equal(f.view.page,9);
});

test('actual active board renders page 13 offline, then clamps and counts its verified-only field',()=>{
  const saved=board(),before=structuredClone(saved),source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
  const document={createElement:()=>element(),createTextNode:textContent=>({nodeType:3,textContent})};
  function element(){
    const classes=new Set();
    return {ownerDocument:document,childNodes:[],dataset:{},attributes:{},
      classList:{add:name=>classes.add(name),contains:name=>classes.has(name),toggle:(name,on)=>on?classes.add(name):classes.delete(name)},
      append(...nodes){this.childNodes.push(...nodes);},prepend(...nodes){this.childNodes.unshift(...nodes);},
      replaceChildren(...nodes){this.childNodes=nodes;},setAttribute(k,v){this.attributes[k]=v;},getAttribute(k){return this.attributes[k];},
      get textContent(){return this.childNodes.map(node=>node.textContent).join('');},
      set textContent(value){this.childNodes=[document.createTextNode(String(value))];}};
  }
  const nodes=Object.fromEntries(['h3','.total-players','.container','.pages','.sq-event-inline-status'].map(key=>[key,element()]));
  const nativeBoard={querySelector:selector=>nodes[selector],querySelectorAll:()=>nodes['.container'].childNodes.filter(node=>node.dataset?.eventAccountId),
    __pt062EventRows:{version:1,render(container,value){
      const position=element(),state=element(),icon={classList:{add(){}}},time=element();
      state.querySelector=()=>icon;
      const button={...element(),value,querySelector:selector=>selector==='.left .position'?position:selector==='.verified-state'?state:time};
      container.append(button);return button;
    }}};
  const root={},period=saved.period,accountId=hash(99999),session={period,periodId:period.id,accountId};
  document.querySelector=()=>root;
  const view={root,period,periodId:period.id,accountId,board:nativeBoard,page:12,onlyVerified:false,
    signature:'',pb:element(),opponentsNote:element(),deferredCarRows:new Set(),carStyles:new WeakMap()};
  let filterActive=false;
  const context={document,nativeView:view,cache:new Map([[period.id,saved]]),localBest:()=>null,ownReceipts:new Map(),
    eventSnapshotFields,eventPagination,renderEventPagination,eventFieldSummary,eventRowVerified,decorateEventRowPresentation,eventDisplayRunAt,
    bridge:{accountId:()=>accountId,snapshotOnly:()=>true,filterRevision:()=>Number(filterActive),
      filterRows:rows=>({active:filterActive,rows:filterActive?rows.filter(row=>row.timeMs<1004):rows})},
    displayName:r=>r.name,eventName:()=> 'Weekly',periodName:()=> 'Fixture',now:()=>Date.now(),
    selectedGhosts:new Map(),pendingGhosts:new Map(),snapshotAttempts:new Map(),
    getOwnReplay:()=>null,displayedRecordPlacement:()=>null,eventOwnPlacementPresentation:()=>null,
    cachedCarStyle:()=>null,renderCachedCar(){},statusText:'Saved standings',clearNativeView(){throw Error('Unexpected reset');}};
  const display=source.slice(source.indexOf('  function eventDisplayRows('),source.indexOf('  function syncNativeArchiveBoard('));
  const adapter=source.slice(source.indexOf('function nativeEventRow('),source.indexOf('export function handleEventCarIntersections('));
  const sync=source.slice(source.indexOf('  function syncNativeBoard('),source.indexOf('  function syncFinishPlace('));
  const render=vm.runInNewContext(display+adapter+sync+';syncNativeBoard;',context);
  render(session);
  assert.equal(view.pageCount,13);assert.equal(nodes['.container'].childNodes[0].value.rank,241);
  assert.match(nodes['.total-players'].textContent,/^241 players · 205 verified.*Page 13 of 13/);
  assert.match(nodes['.total-players'].title,/241 players, 205 verified, 36 pending.*Verified-only field: 205 players/);
  assert.match(nodes['.total-players'].getAttribute('aria-label'),/36 pending/);
  assert.doesNotMatch(nodes['.total-players'].textContent,/all PBs|verified-only|pending|Loaded/);
  view.onlyVerified=true;view.signature='';render(session);
  assert.equal(view.page,10);assert.equal(view.pageCount,11);
  assert.equal(nodes['.container'].childNodes.filter(node=>node.value).length,5);
  assert.match(nodes['.total-players'].textContent,/^205 verified players.*Page 11 of 11/);
  filterActive=true;view.signature='';render(session);
  assert.equal(view.page,0);assert.equal(view.onlyVerified,true);
  assert.match(nodes['.total-players'].textContent,/^3 verified players.*personal filters.*Page 1 of 1/);
  assert.deepEqual(saved,before);
});
