import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
// Run from events/: node --test events/client-integration.test.mjs
// External copies: set EVENT_TEST_REPO. Supply PLAYWRIGHT_MODULE and
// PLAYWRIGHT_CHROMIUM_EXECUTABLE if Playwright is not installed normally.
const require=createRequire(import.meta.url);
const {chromium}=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):createRequire(new URL('../tools/verifier/package.json',import.meta.url))('playwright');
const repo=process.env.EVENT_TEST_REPO||path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const patch=fs.readFileSync(path.join(repo,'polytrack_062_patch.js'),'utf8');
const nativeBundle=fs.readFileSync(path.join(repo,'main.bundle.js'),'utf8');
const nativeRowStart=nativeBundle.indexOf('il=function(e,t,n,i,r,a,s,o,l,c,h,z){'),nativeRowEnd=nativeBundle.indexOf(',rl=function e()',nativeRowStart);
assert(nativeRowStart>0&&nativeRowEnd>nativeRowStart,'actual native row renderer is present');
const nativeRow=nativeBundle.slice(nativeRowStart+3,nativeRowEnd);
const timeStart=nativeBundle.indexOf('static formatTimeString('),timeEnd=nativeBundle.indexOf('update(e){',timeStart+7);
assert(timeStart>0&&timeEnd>timeStart,'actual native time formatter is present');
const nativeTimeFormatter=nativeBundle.slice(timeStart+7,timeEnd).trim();
const nativeCss=JSON.parse(nativeBundle.match(/"\.leaderboard-ui \{(?:\\.|[^"\\])*"/)[0]);
function section(start,end){const a=patch.indexOf(start),b=patch.indexOf(end,a+start.length);assert(a>=0&&b>a,'production source boundary exists');return patch.slice(a,b).trim();}
function functionSource(name){
 const start=patch.indexOf(`  function ${name}(`);assert(start>=0,`production function ${name} exists`);
 const open=patch.indexOf('{',start);assert(open>start,`production function ${name} has a body`);
 let depth=0,quote='',escaped=false,lineComment=false,blockComment=false;
 for(let i=open;i<patch.length;i++){
  const c=patch[i],next=patch[i+1];
  if(lineComment){if(c==='\n')lineComment=false;continue;}
  if(blockComment){if(c==='*'&&next==='/'){blockComment=false;i++;}continue;}
  if(quote){if(escaped){escaped=false;continue;}if(c==='\\'){escaped=true;continue;}if(c===quote)quote='';continue;}
  if(c==='/'&&next==='/'){lineComment=true;i++;continue;}
  if(c==='/'&&next==='*'){blockComment=true;i++;continue;}
  if(c==='\''||c==='"'||c==='`'){quote=c;continue;}
  if(c==='{')depth++;
  else if(c==='}'&&--depth===0)return patch.slice(start,i+1).trim();
 }
 assert.fail(`production function ${name} has an unterminated body`);
}
const focus=section('  function focusTrackFromRanked(','  function trackSummaryLine(');
const entry=section('  function ensureEventEntryContents(){','  function extraTrackIds(){');
const QUEUE='polytrack-062-events-v1-queue';
const id='a'.repeat(64);
const run=(attemptId='one',timeMs=20000)=>({accountId:id,trackId:id,periodId:'daily-fixture',attemptId,timeMs,frames:timeMs,replay:'AAAA',carStyle:'',endsAt:Date.now()+3600000});
let browser,server,base;
before(async()=>{
 server=http.createServer((req,res)=>{const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(name==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Isolated event integration</title>');return;}if(!/^\/events\/[a-z-]+\.(mjs|css)$/.test(name)){res.writeHead(404).end();return;}try{res.setHeader('Content-Type',name.endsWith('.mjs')?'text/javascript':'text/css');res.end(fs.readFileSync(path.join(repo,name)));}catch{res.writeHead(404).end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());});
const setup=async ({focus,nativeRow,nativeTimeFormatter,queue,deferReady,receipt,noIntersectionObserver,controlledIntersectionObserver})=>{
  localStorage.clear(); if(queue) localStorage.setItem("polytrack-062-events-v1-queue",JSON.stringify(queue)); const id='a'.repeat(64); window.id=id;window.submits=[];window.reads=0;window.catalogReads=0;
  if(noIntersectionObserver)window.IntersectionObserver=undefined;
  if(controlledIntersectionObserver)window.IntersectionObserver=class{constructor(callback){this.callback=callback;this.targets=new Set();window.eventCarObserver=this;}observe(target){this.targets.add(target);}unobserve(target){this.targets.delete(target);}disconnect(){this.targets.clear();}trigger(entries){this.callback(entries);}};
  const period={id:'daily-fixture',trackId:id,kind:'daily',startsAt:Date.now()-1000,endsAt:Date.now()+3600000,maxRp:100};
  class Profile{get tokenHash(){return id;}}
  class Profiles{getCurrentUserProfile(){return this.p||(this.p=new Profile());}get profileSlot(){return 0;}setProfileSlot(){}createProfile(){}deleteProfileSlot(){}}
  class Track{getId(){return id;}}
  class Physics{createCar(){return {id:Math.random(),carState:{}};}controlCar(){}deleteCar(){}}
  class Car{constructor(state){this.state=state;this.callbacks=[];}getCarState(){return this.state;}addFinishCallback(c){this.callbacks.push(c);}getRecording(){return {serialize:()=> 'AAAA'};}getTime(){return {numberOfFrames:this.ms};}getCarStyle(){return {serialize:()=>''};}finish(ms){this.ms=ms;this.callbacks.forEach(c=>c(this));}}
  const modules={641:Car,5220:Physics,2522:Profiles,5492:Profile,9117:Track};const manager=new Profiles(),physics=new Physics(),track=new Track();
  window.makeCar=()=>{manager.getCurrentUserProfile();const created=physics.createCar(null,null,null,track,null);physics.controlCar(created.id);const car=new Car(created.carState);car.addFinishCallback(()=>{});return car;};
  const trackInfo=()=>({name:'Fixture track'}),isElementVisible=()=>true,closeOverallPanel=panel=>{if(panel)panel.style.display='none';};
  // Execute the real game row function; only its surrounding services are fixtures.
  const {eventRunDate}=await import('/events/client.mjs');
  const Oo=new WeakMap(),$o=new WeakMap(),el=new WeakMap(),zo=new WeakMap(),Do=new WeakMap(),Io=new WeakMap(),Ro={},owner={};
  const R={gn:(object,map,type,key)=>type==='m'?key:map.get(object),GG:(object,map,value)=>map.set(object,value)};
  const Qe=value=>String(value),Je=value=>value%100>=11&&value%100<=13?'th':({1:'st',2:'nd',3:'rd'}[value%10]||'th');
  const He={A:{formatTimeString:eval('(function '+nativeTimeFormatter+')')}},ni={O:()=>[{code:'US',name:'United States'}]},_o={Y:{Pending:0,Verified:1,InvalidDuplicate:3}},sl={u:(_lang,date,now)=>eventRunDate({submittedAt:date.getTime()},now.getTime()).label},kr={F:()=>{throw Error('Native event adapter must not start its own car renders');}};
  Io.set(owner,{get:value=>value});el.set(owner,[]);zo.set(owner,{playUIClick(){}});Do.set(owner,()=>{throw Error('Native recording selection must not leak into event selection');});
  const render=eval('('+nativeRow+')');
  document.querySelector('.leaderboard-ui').__pt062EventRows={version:1,render:(container,row)=>{Oo.set(owner,container);return render.call(owner,row.rank,row.name,row.countryCode||null,row.timeMs,new Date(row.runAt),null,row.pending?0:1,row.isSelf,row.accountId,new Date(),{isCancelled:false},{event:true});}};
  let eventUi; const nativeFocus=eval('('+focus.trim()+')');
  window.ui=eventUi=(await import('/events/client.mjs')).installEvents(window.bridgeFixture={accountId:()=>id,trackInfo,thumbnail:()=>'',formatTime:ms=>String(ms),readCatalog:async()=>{window.catalogReads++;return {periods:[period]};},readSnapshot:async requested=>{window.reads++;const archived=requested==='old-event';return {period:archived?{...period,id:requested,startsAt:Date.now()-172800000,endsAt:Date.now()-86400000,racerCount:1}:period,updatedAt:period.startsAt,entries:archived?[{accountId:'b'.repeat(64),name:'Archived racer',rank:1,timeMs:21000,rp:100}]:[]};},readOwnStatus:async()=>receipt||null,readArchiveMonth:async()=>({periods:[{...period,id:'old-event',racerCount:1,startsAt:Date.now()-172800000,endsAt:Date.now()-86400000}]}),readTotals:async()=>({entries:[]}),submit:async run=>{window.submits.push(run);return {runId:'fixture',status:'waiting'};},ready:()=>deferReady?new Promise(resolve=>window.resolveReady=resolve):Promise.resolve(),require:()=>n=>({A:modules[n]}),openTrack:id=>nativeFocus(id,{event:true})});
  document.querySelector('#native').onclick=()=>{window.car=makeCar();};
  document.querySelector('#ranked').onclick=()=>nativeFocus(id);
  document.querySelector('#open').onclick=()=>ui.open();
 };
async function fixture(t,options={}){
 const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();
 await page.route('**/*',r=>r.request().url().startsWith(base+'/')?r.continue():r.abort());
 await page.goto(base);
 await page.setContent('<button id="open">Events</button><button id="ranked" data-track-id="a">Ranked profile track</button><button id="native"><span class="track-title"><p>Fixture track</p></span></button><div class="track-info-ui"><div class="leaderboard-ui"><h2>Leaderboard</h2><h3>Version 0.6</h3><div class="total-players"></div><div class="container">Normal leaderboard 9999</div><div class="pages"></div><div class="button-wrapper"><button class="button back">Back</button><button class="button icon-button first"><img src="images/pin.svg"></button><button class="button only-verified">Only verified<img src="images/verified.svg"></button></div></div><div class="side-panel"><h2>Fixture track</h2><div class="personal-best-title">Personal best</div><div class="personal-best">9999</div><div class="opponents-container">Normal opponents</div><button class="button watch">Watch</button></div></div>');
 await page.evaluate(setup,{focus,nativeRow,nativeTimeFormatter,...options});return page;
}
async function enter(page){await page.locator('#open').click();await page.locator('[data-event-id]').click();await page.locator('.sq-event-board').waitFor();}
async function boot(page,queue){return page.evaluate(async({entry,queue,QUEUE})=>{
 localStorage.setItem(QUEUE,JSON.stringify(queue));let eventUi=null,eventQueueChecked=false,calls=0,flushes=0,reads=0;
 const prior=Storage.prototype.getItem;Storage.prototype.getItem=function(key){if(key===QUEUE)reads++;return prior.call(this,key);};
 function ensureEventUi(){calls++;return Promise.resolve({flush(){flushes++;},tick(){}});}
 const ensureExtraTracksEntryContents=()=>{},isElementVisible=()=>false;
 const invoke=eval('('+entry+')');for(let i=0;i<100;i++)invoke();await Promise.resolve();Storage.prototype.getItem=prior;return {calls,flushes,reads};
 },{entry,queue,QUEUE});}
test('normal Ranked navigation keeps event eligibility without retaining event display mode',async t=>{
 assert.match(patch,/focusTrackFromRanked\(id,\{event:true\}\)/);
 const p=await fixture(t);await enter(p);await p.waitForFunction(()=>!!window.car);await p.evaluate(()=>car.finish(20000));
 await p.waitForFunction(()=>submits.length===1);await p.evaluate(()=>window.car=null);await p.locator('#ranked').click();await p.waitForFunction(()=>!!window.car);await p.evaluate(()=>car.finish(19000));
 assert.deepEqual(await p.evaluate(()=>({active:document.body.classList.contains('sq-event-active'),times:submits.map(r=>r.timeMs)})),{active:false,times:[20000,19000]});
});
test('pending queue bootstraps once without opening Events',async t=>{const p=await fixture(t);assert.deepEqual(await boot(p,[run()]),{calls:1,flushes:1,reads:1});});
test('empty queue startup checks storage once and never imports event UI',async t=>{const p=await fixture(t);assert.deepEqual(await boot(p,[]),{calls:0,flushes:0,reads:1});});
test('hasPending fast guard performs no queue reads on repeated empty flushes',async t=>{
 const p=await fixture(t);assert.equal(await p.evaluate(async QUEUE=>{let reads=0;const prior=Storage.prototype.getItem;Storage.prototype.getItem=function(key){if(key===QUEUE)reads++;return prior.call(this,key);};try{for(let i=0;i<100;i++)await ui.flush();return reads;}finally{Storage.prototype.getItem=prior;}},QUEUE),0);
});
test('cross-tab queue storage event reactivates hasPending and flushes',async t=>{
 const p=await fixture(t);await p.evaluate(({QUEUE,run})=>{localStorage.setItem(QUEUE,JSON.stringify([run]));window.dispatchEvent(new StorageEvent('storage',{key:QUEUE,newValue:JSON.stringify([run])}));},{QUEUE,run:run()});await p.waitForFunction(()=>submits.length===1);assert.deepEqual(await p.evaluate(QUEUE=>JSON.parse(localStorage.getItem(QUEUE)),QUEUE),[]);
});
test('acknowledging older in-flight attempt preserves a newer queued attempt',async t=>{
 const p=await fixture(t,{queue:[run()]});await p.evaluate(()=>{window.submits=[];});
 // Pause the actual bridge submission at its await boundary without changing production code.
 await p.evaluate(()=>{const prior=submits.push.bind(submits);submits.push=function(value){prior(value);localStorage.setItem('polytrack-062-events-v1-queue',JSON.stringify([{...value,attemptId:'newer',timeMs:19000,frames:19000}]));return submits.length;};});
 await p.evaluate(()=>ui.flush());assert.deepEqual(await p.evaluate(QUEUE=>JSON.parse(localStorage.getItem(QUEUE)).map(r=>r.attemptId),QUEUE),['newer']);
});
test('leaving while Race event waits for readiness cancels the pending entry',async t=>{
 const p=await fixture(t,{deferReady:true});await p.evaluate(()=>ui.open());await p.locator('[data-event-id="daily-fixture"]').click();await p.waitForFunction(()=>!!window.resolveReady);
 await p.locator('#ranked').click();await p.evaluate(()=>resolveReady());await p.waitForTimeout(450);
 assert.equal(await p.evaluate(()=>document.body.classList.contains('sq-event-active')),false,'delayed readiness must not reactivate an explicitly exited event');
});
test('closing the dialog while Race event waits cancels the pending entry',async t=>{
 const p=await fixture(t,{deferReady:true});await p.evaluate(()=>ui.open());await p.locator('[data-event-id="daily-fixture"]').click();await p.waitForFunction(()=>!!window.resolveReady);
 await p.locator('[data-event-close]').click();await p.evaluate(()=>resolveReady());await p.waitForTimeout(450);
 assert.equal(await p.evaluate(()=>document.body.classList.contains('sq-event-active')),false,'closing the dialog must cancel the pending race request');
});

test('archived standings use the native track panel as frozen rows and launch normal practice',async t=>{const p=await fixture(t);await addNativePlay(p);await p.evaluate(()=>window.initialNativeBoard=document.querySelector('.track-info-ui>.leaderboard-ui'));await p.locator('#open').click();await p.locator('[data-event-archives]').click();await p.locator('input[name="archive-month"]').fill('2026-08');await p.getByRole('button',{name:'View month',exact:true}).click();await p.locator('[data-archive-event-id="old-event"] summary').click();await p.getByRole('button',{name:'Track details / practice'}).click();await p.locator('.sq-event-board').waitFor();assert.equal(await p.evaluate(()=>document.querySelector('.sq-event-board')===initialNativeBoard),true);assert.match(await p.locator('.sq-event-board h2').innerText(),/Archived event leaderboard/);assert.match(await p.locator('.sq-event-board .container').innerText(),/Archived racer/);assert.equal(await p.locator('.sq-event-board .sq-event-refresh').count(),0);assert.equal(await p.locator('.sq-event-board [data-event-race],.sq-event-board [data-event-practice]').count(),0);assert.equal(await p.locator('.sq-event-board .container .main[aria-disabled="true"]').count(),1);assert.equal(await p.evaluate(()=>ui.isEntered(id)),false);assert.equal(await p.evaluate(()=>reads),1);await p.locator('.side-panel .play').click();assert.equal(await p.evaluate(()=>normalStarts),1);await p.evaluate(()=>ui.leave());assert.equal(await p.evaluate(()=>initialNativeBoard.isConnected&&!initialNativeBoard.classList.contains('sq-event-board')&&initialNativeBoard.textContent.includes('Normal leaderboard 9999')),true);});
test('zero-racer archive stays disabled instead of exposing practice controls',async t=>{const p=await fixture(t);await p.evaluate(()=>{bridgeFixture.readArchiveMonth=async()=>({periods:[{...{id:'empty-event',trackId:id,kind:'daily',startsAt:Date.now()-172800000,endsAt:Date.now()-86400000,maxRp:100},racerCount:0}]});});await p.locator('#open').click();await p.locator('[data-event-archives]').click();await p.locator('input[name="archive-month"]').fill('2026-08');await p.getByRole('button',{name:'View month',exact:true}).click();const state=await p.locator('[data-archive-event-id="empty-event"]').evaluate(details=>({open:details.open,disabled:details.querySelector('summary').getAttribute('aria-disabled'),tabIndex:details.querySelector('summary').tabIndex,empty:details.classList.contains('sq-archive-event-empty')}));assert.deepEqual(state,{open:false,disabled:'true',tabIndex:-1,empty:true});assert.equal(await p.locator('[data-archive-event-id="empty-event"] .sq-archive-actions button').isVisible(),false);});
test('a pending cloud event PB is visible on a device without its local record',async t=>{const p=await fixture(t,{receipt:{accountId:id,attemptId:'another-device',timeMs:18000,status:'waiting'}});await enter(p);const text=await p.locator('.sq-event-board').innerText();assert.match(text,/00:18\.000/);assert.match(text,/Waiting for replay verification/);});

test('native event template shows a new local finish immediately as pending, never normal PB',async t=>{
 const p=await fixture(t);await enter(p);await p.waitForFunction(()=>!!window.car);await p.evaluate(()=>car.finish(20000));
 const board=p.locator('.sq-event-board');await board.locator('button.main.self').waitFor();
 assert.match(await board.innerText(),/00:20\.000/);assert.doesNotMatch(await board.innerText(),/9999/);
 assert.equal(await board.locator('button.main.self .verified-state.pending').count(),1);assert.equal(await board.locator('button.main.self .verified-state.verified').count(),0);
 assert.match(await p.locator('.sq-event-personal').innerText(),/20000/);await p.evaluate(()=>car.finish(19000));assert.match(await p.locator('.sq-event-personal').innerText(),/19000/);
 await p.evaluate(()=>ui.leave());assert.equal(await p.locator('.sq-event-board').count(),0);assert.equal(await p.locator('.sq-event-personal').count(),0);assert.equal(await p.locator('.side-panel .personal-best').innerText(),'9999');
});
test('Enter and Space activate focused native controls instead of the event Play shortcut',async t=>{
 const p=await fixture(t);await enter(p);await addNativePlay(p);
 await p.evaluate(()=>{
  window.nativeControlClicks={back:0,filters:0,refresh:0};
  const board=document.querySelector('.sq-event-board'),back=board.querySelector('.button.back'),refresh=board.querySelector('.sq-event-refresh'),filters=document.createElement('button');
  back.onclick=()=>nativeControlClicks.back++;refresh.onclick=()=>nativeControlClicks.refresh++;
  filters.type='button';filters.textContent='Filters';filters.onclick=()=>nativeControlClicks.filters++;board.append(filters);
 });
 for(const [selector,key,name] of [['.sq-event-board .button.back','Enter','back'],['.sq-event-board > button:last-child','Space','filters'],['.sq-event-board .sq-event-refresh','Enter','refresh']]){
  await p.locator(selector).focus();await p.keyboard.press(key);assert.equal(await p.evaluate(name=>nativeControlClicks[name],name),1);
 }
 assert.equal(await p.evaluate(()=>normalStarts),0);
 const rail=await fixture(t);await showLiveRail(rail);
 assert.equal(await rail.getByRole('button',{name:'Event standings',exact:true}).count(),1);
 assert.equal(await rail.locator('.sq-events-entry').innerText(),'Event standings');
});
test('visible Static group loads catalog once, hidden group does not load',async t=>{
 const p=await fixture(t);await p.evaluate(()=>{const host=document.createElement('div');host.className='track-selection-ui';host.style.display='none';host.innerHTML='<div class="community-track-versions"><button>Static</button><button>0.6.3</button></div><div class="community-track-group"><img src="tracks/community/thumbnails/rolling_hills_racer.png"></div>';document.body.append(host);ui.tick();});assert.equal(await p.evaluate(()=>catalogReads),0);
 await p.evaluate(()=>{document.querySelector('.track-selection-ui').style.display='block';ui.tick();});await p.waitForFunction(()=>catalogReads===1);await p.evaluate(()=>{for(let i=0;i<100;i++)ui.tick();});assert.equal(await p.evaluate(()=>catalogReads),1);assert.equal(await p.locator('.sq-event-track-group').count(),1);
});
test('pageshow and visible-state restore Daily and Weekly event cards from cache without another catalog read',async t=>{
 const p=await fixture(t);await p.locator('#open').click();await p.locator('[data-event-id="daily-fixture"]').waitFor();
 await p.evaluate(()=>{const mount=()=>{const panel=document.createElement('div');panel.id='overallLeaderboardPanel';panel.innerHTML=['weekly-cup','daily-card'].map(kind=>`<section class="${kind}"><button class="competition-feature-button"><span class="competition-feature-image"></span><span class="competition-kicker"></span><strong class="competition-track-name"></strong><span class="competition-result"></span></button><small></small></section>`).join('');document.body.append(panel);};mount();ui.tick();});
 await p.waitForFunction(()=>document.querySelector('.daily-card .competition-feature-button')?.dataset.eventId==='daily-fixture');assert.equal(await p.evaluate(()=>catalogReads),1);
 await p.evaluate(()=>{const mount=()=>{const panel=document.createElement('div');panel.id='overallLeaderboardPanel';panel.innerHTML=['weekly-cup','daily-card'].map(kind=>`<section class="${kind}"><button class="competition-feature-button"><span class="competition-feature-image"></span><span class="competition-kicker"></span><strong class="competition-track-name"></strong><span class="competition-result"></span></button><small></small></section>`).join('');document.body.append(panel);};document.querySelector('#overallLeaderboardPanel').remove();mount();document.dispatchEvent(new Event('visibilitychange'));});
 await p.waitForFunction(()=>document.querySelector('.daily-card .competition-feature-button')?.dataset.eventId==='daily-fixture');assert.equal(await p.locator('.weekly-cup .competition-kicker').innerText(),'WEEKLY EVENT');assert.equal(await p.locator('.daily-card .competition-kicker').innerText(),'DAILY EVENT');assert.equal(await p.evaluate(()=>catalogReads),1);
});

test('pending replay changes invalidate the quick signature and idle ticks do not rewrite row state',async t=>{
 const p=await fixture(t);
 await p.evaluate(()=>{
  const read=bridgeFixture.readSnapshot;bridgeFixture.readSnapshot=async periodId=>({...await read(periodId),entries:[{accountId:'b'.repeat(64),name:'Replay target',rank:1,timeMs:21000,rp:50,replayHash:'fixture-replay-hash'}]});
  bridgeFixture.readReplay=()=>new Promise(resolve=>window.finishReplay=resolve);
  window.eventRaceStarts=0;window.eventWatchStarts=0;bridgeFixture.startEventRace=async()=>eventRaceStarts++;bridgeFixture.watchEvent=()=>eventWatchStarts++;
 });
 await addNativePlay(p);await enter(p);await p.waitForFunction(()=>!!window.car);await p.evaluate(()=>car.finish(22000));await p.waitForFunction(()=>submits.length===1);
 const row=p.locator('.sq-event-board button.main:not(.self)').first();await row.waitFor();
 await row.evaluate(node=>window.originalReplayRow=node);
 await row.click();await p.waitForFunction(()=>document.querySelector('.sq-event-board button.main:not(.self)')?.getAttribute('aria-busy')==='true');
 assert.equal(await row.evaluate(node=>node===originalReplayRow),true,'pending selection preserves the rendered row');
 await p.locator('.side-panel .play').click();await p.waitForFunction(()=>document.querySelector('.sq-event-inline-status')?.textContent.includes('Wait or unselect them before playing'));
 assert.equal(await p.evaluate(()=>eventRaceStarts),0);assert.equal(await p.evaluate(()=>normalStarts),0);
 await p.locator('.side-panel .watch').click();await p.waitForFunction(()=>document.querySelector('.sq-event-inline-status')?.textContent.includes('Wait or unselect them before watching'));
 assert.equal(await p.evaluate(()=>eventWatchStarts),0);
 await p.evaluate(()=>{
  const button=document.querySelector('.sq-event-board button.main:not(.self)');window.rowMutations=0;window.rowMutationObserver=new MutationObserver(records=>window.rowMutations+=records.length);rowMutationObserver.observe(button,{attributes:true});
  for(let i=0;i<20;i++)ui.tick();
 });
 await p.waitForTimeout(10);assert.equal(await p.evaluate(()=>rowMutations),0);
 await p.locator('.sq-event-board button.main:not(.self)').first().click();
 await p.waitForFunction(()=>document.querySelector('.sq-event-board button.main:not(.self)')?.getAttribute('aria-busy')==='false');
 assert.equal(await p.locator('.sq-event-board button.main:not(.self).pending-selection').count(),0);
 assert.equal(await row.evaluate(node=>node===originalReplayRow),true,'unselection preserves the rendered row');
 await p.evaluate(()=>{rowMutationObserver.disconnect();finishReplay({});});
});
test('Event RP delegates to normal Ranked hook after closing event dialog',async t=>{
 const p=await fixture(t);await p.locator('#open').click();await p.evaluate(()=>{bridgeFixture.openRankedEvents=()=>{window.rankedOpened=!document.querySelector('.sq-events-overlay');};});await p.locator('[data-event-totals]').click();assert.equal(await p.evaluate(()=>rankedOpened),true);
});
test('live Event standings cards enter the native event board with verified checkmarks',async t=>{
 const p=await fixture(t);await p.evaluate(()=>{bridgeFixture.readSnapshot=async()=>({period:{id:'daily-fixture',trackId:id,kind:'daily',startsAt:Date.now()-1000,endsAt:Date.now()+3600000,maxRp:100},updatedAt:Date.now(),entries:[{accountId:'b'.repeat(64),name:'Verified racer',rank:1,timeMs:19000,rp:100}]});});
 await p.locator('#open').click();await p.locator('.sq-events-overlay [data-event-id="daily-fixture"]').click();await p.locator('.sq-event-board button.main').waitFor();
 assert.equal(await p.locator('.sq-events-overlay').count(),0);assert.equal(await p.locator('.sq-event-board .verified-state.verified').count(),1);assert.equal(await p.locator('.sq-event-board img.checkmark[src*="checkmark.svg"]').count(),1);assert.equal(await p.locator('.sq-event-board .verified-state img.sq-event-verification-icon[src*="state_verified.svg"]').count(),1);
});
test('event rows use native names, flags, self labels and verification icons',async t=>{
 const p=await fixture(t);await p.evaluate(()=>{
  bridgeFixture.readSnapshot=async()=>({period:{id:'daily-fixture',trackId:id,kind:'daily'},updatedAt:Date.now(),entries:[{accountId:id,name:'Real Racer Name',countryCode:'US',timeMs:19000,rp:100,submittedAt:Date.now()-3600000}],pendingPlaybacks:[{accountId:'c'.repeat(64),runId:'d'.repeat(64),name:'<b>Not HTML</b>',timeMs:20000,pending:true,verified:false,eventRpEligible:false,verificationStatus:'waiting',source:'pending-event-playback',submittedAt:Date.now()-60000}]});
 });await enter(p);
 const mine=p.locator('.sq-event-board button.main.self'),waiting=p.locator('.sq-event-board button.main:not(.self)');
 assert.equal(await mine.locator('.event-time').innerText(),'00:19.000');assert.equal(await waiting.locator('.event-time').innerText(),'00:20.000');
 assert.equal(await mine.locator('.name').innerText(),'Real Racer Name');assert.equal(await mine.locator('.name-container > .self').innerText(),'(You)');assert.equal(await mine.locator('.country-flag').count(),1);
 assert.equal(await mine.locator('.position > span').innerText(),'st');assert.match(await mine.locator('.verified-state').getAttribute('title'),/Verified/);assert.equal(await mine.locator('.verified-state img[src="images/state_verified.svg"]').count(),1);
 assert.equal(await waiting.locator('.name').innerText(),'<b>Not HTML</b>');assert.equal(await waiting.locator('.name b').count(),0);assert.match(await waiting.locator('.verified-state').getAttribute('title'),/Pending/);assert.equal(await waiting.locator('.verified-state img[src="images/state_pending.svg"]').count(),1);assert.equal(await waiting.locator('.sq-event-earned-rp').count(),0);
 await p.addStyleTag({content:nativeCss});await p.addStyleTag({content:fs.readFileSync(path.join(repo,'events/events.css'),'utf8')});
 assert.equal(await mine.locator('.right').evaluate(node=>getComputedStyle(node).display),'inline-block','event CSS preserves native row layout');
 assert.equal(await mine.locator('.verified-state').evaluate(node=>getComputedStyle(node).position),'absolute','event CSS preserves native status positioning');
});
test('Only verified filters cached event rows without reading another snapshot',async t=>{
 const p=await fixture(t);await p.evaluate(()=>{
  window.snapshotCalls=0;bridgeFixture.readSnapshot=async()=>{snapshotCalls++;return {period:{id:'daily-fixture',trackId:id,kind:'daily'},updatedAt:Date.now(),entries:[{accountId:'b'.repeat(64),name:'Verified racer',timeMs:19000,rp:100}],pendingPlaybacks:[{accountId:'c'.repeat(64),runId:'d'.repeat(64),name:'Waiting racer',timeMs:20000,pending:true,verified:false,eventRpEligible:false,verificationStatus:'waiting',source:'pending-event-playback'}]};};
 });await enter(p);assert.equal(await p.locator('.sq-event-board .container > button.main').count(),2);
 const reads=await p.evaluate(()=>snapshotCalls),toggle=p.locator('.sq-event-board .only-verified');
 await toggle.click();assert.equal(await toggle.getAttribute('aria-pressed'),'true');assert.equal(await p.locator('.sq-event-board .container > button.main').count(),1);
 await toggle.click();assert.equal(await toggle.getAttribute('aria-pressed'),'false');assert.equal(await p.locator('.sq-event-board .container > button.main').count(),2);assert.equal(await p.evaluate(()=>snapshotCalls),reads);
});
test('live event mode reuses the native leaderboard element and restores its contents',async t=>{const p=await fixture(t);await p.evaluate(()=>{window.initialNativeBoard=document.querySelector('.track-info-ui>.leaderboard-ui');bridgeFixture.filterButton=footer=>{const button=document.createElement('button');button.type='button';button.dataset.personalFilterButton='';button.textContent='Filters-Inactive';footer.append(button);};bridgeFixture.readSnapshot=async()=>({period:{id:'daily-fixture',trackId:id,kind:'daily'},updatedAt:Date.now(),entries:[{accountId:'b'.repeat(64),name:'Native row',rank:1,timeMs:19000,rp:100}]});});await enter(p);assert.equal(await p.evaluate(()=>document.querySelector('.sq-event-board')===initialNativeBoard),true);assert.equal(await p.locator('.sq-event-board > .button-wrapper > button').count(),4);assert.equal(await p.locator('.sq-event-board > h2 > .sq-event-refresh').count(),1);assert.equal(await p.locator('.sq-event-board button.main .checkmark').evaluate(node=>node.parentElement.matches('button.main')),true);assert.equal(await p.locator('.sq-event-board button.main .verified-state img.sq-event-verification-icon').count(),1);await p.evaluate(()=>ui.leave());assert.equal(await p.evaluate(()=>initialNativeBoard.isConnected&&!initialNativeBoard.classList.contains('sq-event-board')&&initialNativeBoard.textContent.includes('Normal leaderboard 9999')),true);});
test('native event rows show accepted run age and verified ERP, with cached racer actions',async t=>{
 const p=await fixture(t);await p.evaluate(()=>{
  bridgeFixture.readSnapshot=async()=>({period:{id:'daily-fixture',trackId:id,kind:'daily',startsAt:Date.now()-86400000,endsAt:Date.now()+3600000,maxRp:100},updatedAt:Date.now(),entries:[{accountId:'b'.repeat(64),name:'Dated racer',rank:1,timeMs:19000,rp:84,submittedAt:Date.now()-3600000}]});
  window.racerActions=[];bridgeFixture.racerActions=row=>racerActions.push(row.accountId);bridgeFixture.readReplay=async()=>null;
 });await enter(p);const row=p.locator('.sq-event-board .container > button.main').first();
 assert.match(await row.innerText(),/1 hour ago/);assert.match(await row.innerText(),/84 ERP/);
 await row.click({button:'right'});assert.deepEqual(await p.evaluate(()=>racerActions),['b'.repeat(64)]);
 await row.focus();await p.keyboard.press('Shift+F10');assert.equal(await p.evaluate(()=>racerActions.length),2);
 assert.equal(await p.evaluate(()=>ui.isEntered(id)),true);await p.evaluate(()=>ui.leave());assert.equal(await p.evaluate(()=>ui.isEntered(id)),false);
});
test('event Find me jumps to the loaded result page without fetching another board',async t=>{
 const p=await fixture(t);await p.evaluate(()=>{
  bridgeFixture.readSnapshot=async()=>({period:{id:'daily-fixture',trackId:id,kind:'daily'},updatedAt:Date.now(),entries:Array.from({length:30},(_,i)=>({accountId:i===25?id:(i+1).toString(16).padStart(64,'0'),name:i===25?'You':'Racer '+i,rank:i+1,timeMs:18000+i,rp:90}))});
 });await enter(p);assert.equal(await p.locator('.sq-event-board button.main.self').count(),0);
 await p.getByRole('button',{name:'Find your event result',exact:true}).click();assert.equal(await p.locator('.sq-event-board button.main.self').count(),1);
 assert.equal(await p.locator('.sq-event-board .pages .selected').innerText(),'2');
});
test('schedule-only live event remains playable, preserves its local PB, and accepts only matching snapshot metadata',async t=>{
 const p=await fixture(t);await p.evaluate(()=>{
  const scheduled={id:'scheduled-fixture',trackId:id,kind:'daily',startsAt:Date.now()-1000,endsAt:Date.now()+3600000,maxRp:100,scheduleOnly:true};
  bridgeFixture.readCatalog=async()=>({periods:[scheduled],archives:[]});
  bridgeFixture.readSnapshot=async requested=>({period:{...scheduled,scheduleOnly:false,trackName:'Official fixture track'},updatedAt:Date.now(),entries:[]});
 });
 await p.locator('#open').click();const card=p.locator('.sq-events-overlay [data-event-id="scheduled-fixture"]');await card.waitFor();assert.match(await card.innerText(),/100 Event RP/);assert.match(await card.innerText(),/Awaiting official server assignment/);
 await card.click();await p.waitForFunction(()=>!!window.car);assert.equal(await p.locator('.sq-event-board').count(),1);assert.equal(await p.locator('.sq-events-overlay').count(),0);assert.equal(await p.evaluate(()=>document.body.classList.contains('sq-event-active')),true);
 await p.evaluate(()=>car.finish(21000));await p.waitForFunction(()=>submits.length===1);await p.waitForFunction(()=>JSON.parse(localStorage.getItem('polytrack-062-events-v1')).periods[0].scheduleOnly===false);
 await p.locator('#open').click();const updated=p.locator('.sq-events-overlay [data-event-id="scheduled-fixture"]');await updated.waitFor();assert.match(await updated.innerText(),/21000/);assert.doesNotMatch(await updated.innerText(),/Awaiting official server assignment/);assert.doesNotMatch(await updated.locator('.sq-event-record').innerText(),/verified|\bRP\b.*earned/i);
});
test('event reset labels explicitly use Local',async t=>{const p=await fixture(t);await p.locator('#open').click();assert.match(await p.locator('.sq-events-overlay [data-event-id]').innerText(),/Local/);});
test('event home renders cached live catalog without waiting for permanent standings',async t=>{
 const p=await fixture(t);await p.evaluate(()=>{bridgeFixture.readPermanent=()=>new Promise(()=>{});});await p.locator('#open').click();
 await p.locator('.sq-events-overlay [data-event-id="daily-fixture"]').waitFor({timeout:1500});
 assert.match(await p.locator('.sq-events-overlay [data-event-permanent]').innerText(),/Loading verified record/);
});

async function showLiveRail(p){await p.evaluate(()=>{const host=document.createElement('div');host.className='track-selection-ui';host.innerHTML='<div class="community-track-versions"><button>Static</button><button>0.6.3</button></div><div class="community-track-group"><img src="tracks/community/thumbnails/rolling_hills_racer.png"></div>';document.body.append(host);ui.tick();});await p.waitForFunction(()=>catalogReads>=1);await p.evaluate(()=>ui.tick());}
test('native wrapper rebuild restores cached event cards without a timer or network read',async t=>{
 const p=await fixture(t);await showLiveRail(p);
 const reads=await p.evaluate(()=>catalogReads);
 for(let cycle=0;cycle<3;cycle++){
  await p.evaluate(()=>{document.querySelector('.track-selection-ui').replaceChildren();});
  await p.waitForTimeout(220);
  await p.evaluate(()=>{const wrapper=document.createElement('div');wrapper.className='wrapper';wrapper.innerHTML='<div class="community-track-versions"><button>0.6.3</button></div>';document.querySelector('.track-selection-ui').append(wrapper);});
  await p.waitForFunction(()=>document.querySelectorAll('.sq-event-track-buttons .sq-event-card').length===2);
  assert.equal(await p.locator('.sq-event-track-buttons [data-event-id="daily-fixture"]').count(),1);
 }
 assert.equal(await p.evaluate(()=>catalogReads),reads);
});
test('live rail card enters native event screen directly without opening a modal',async t=>{const p=await fixture(t);await showLiveRail(p);await p.locator('.sq-event-track-buttons [data-event-id]').click();await p.waitForFunction(()=>!!window.car);assert.equal(await p.locator('.sq-events-overlay').count(),0);assert.equal(await p.locator('.sq-event-board').count(),1);await p.evaluate(()=>car.finish(21000));assert.match(await p.locator('.sq-event-personal').innerText(),/21000/);});
test('direct live-card entry is cancelled when leaving during readiness',async t=>{const p=await fixture(t,{deferReady:true});await showLiveRail(p);await p.locator('.sq-event-track-buttons [data-event-id]').click();await p.waitForFunction(()=>!!window.resolveReady);await p.evaluate(()=>{ui.leave();resolveReady();});await p.waitForTimeout(450);assert.equal(await p.evaluate(()=>document.body.classList.contains('sq-event-active')),false);assert.equal(await p.locator('.sq-event-board').count(),0);});
test('native integrity decorator keeps published event rows verified and local rows pending',async t=>{
 const p=await fixture(t);await p.evaluate(()=>{const read=bridgeFixture.readSnapshot;bridgeFixture.readSnapshot=async id=>({...await read(id),entries:[{accountId:'b'.repeat(64),name:'Published',rank:1,timeMs:20000,rp:100}]});});await enter(p);await p.waitForFunction(()=>!!window.car);await p.evaluate(()=>car.finish(19000));
 await p.evaluate(source=>eval('('+source+')')(),functionSource('syncIntegrityStateLabels'));
 assert.equal(await p.locator('.sq-event-board button.main.self .verified-state.pending').count(),1);assert.equal(await p.locator('.sq-event-board button.main:not(.self) .verified-state.verified').count(),1);assert.equal(await p.locator('.sq-event-board button.main:not(.self) .sq-integrity-label').innerText(),'');
});
test('ended event launches are removed while unavailable slots remain visible',async t=>{const p=await fixture(t);await showLiveRail(p);assert.equal(await p.locator('.sq-event-track-buttons [data-event-id]').count(),1);await p.evaluate(async()=>{bridgeFixture.readCatalog=async()=>({periods:[],archives:[]});await ui.refreshCatalog(true);ui.tick();});assert.equal(await p.locator('.sq-event-track-buttons [data-event-id]').count(),0);assert.equal(await p.locator('.sq-event-track-buttons .sq-event-card').count(),2);assert.match(await p.locator('.sq-event-track-buttons').innerText(),/Schedule unavailable/);assert.equal(await p.locator('.sq-events-entry').count(),1);await p.locator('.sq-event-track-buttons .sq-event-card').first().click();assert.equal(await p.locator('.sq-events-overlay').count(),1);});
test('native event view hides a matching rejected attempt from public standings',async t=>{const p=await fixture(t);await enter(p);await p.waitForFunction(()=>!!window.car);await p.evaluate(()=>car.finish(20000));await p.waitForFunction(()=>submits.length===1);await p.evaluate(()=>{bridgeFixture.readOwnStatus=async()=>({attemptId:submits[0].attemptId,timeMs:20000,status:'mismatch'});});await p.locator('.sq-event-refresh').click();await p.waitForFunction(()=>document.querySelector('.sq-event-board').textContent.includes('No points were added'));assert.equal(await p.locator('.sq-event-board .verified-state').count(),0);assert.match(await p.locator('.sq-event-board').innerText(),/No points were added/);assert.equal(await p.locator('.sq-event-board .verified-state.verified').count(),0);});
test('leaving event preserves native opponent controls and listeners',async t=>{const p=await fixture(t);await p.evaluate(()=>{const target=document.querySelector('.opponents-container');const button=document.createElement('button');button.textContent='Original opponent';button.onclick=()=>window.opponentClicked=true;target.append(button);window.originalOpponent=button;});await enter(p);await p.waitForFunction(()=>!!window.car);await p.evaluate(()=>ui.leave());assert.equal(await p.evaluate(()=>originalOpponent.isConnected),true);await p.locator('button',{hasText:'Original opponent'}).click();assert.equal(await p.evaluate(()=>opponentClicked),true);});

async function sharedTrackPeriods(p){await p.evaluate(async()=>{
 const daily={id:'daily-shared',kind:'daily',trackId:id,startsAt:Date.now()-1000,endsAt:Date.now()+3600000,maxRp:100};
 window.periods=[{...daily,id:'weekly-shared',kind:'weekly',maxRp:500},daily];
 bridgeFixture.readCatalog=async()=>({periods});bridgeFixture.readSnapshot=async key=>({period:periods.find(p=>p.id===key),entries:[],updatedAt:Date.now()});
 await ui.refreshCatalog(true);
});}
test('daily and weekly on the same physical track retain exact period binding',async t=>{
 const p=await fixture(t);await sharedTrackPeriods(p);
 let count=0;for(const kind of ['daily','weekly','daily']){
  assert.equal(await p.evaluate(kind=>ui.openEvent({kind,trackId:id}),kind),true);
  await p.waitForFunction(()=>!!window.car);await p.evaluate(ms=>car.finish(ms),20000-count*1000);count++;
  await p.waitForFunction(count=>submits.length===count*2,count);assert.equal(await p.locator('.sq-event-board h3').innerText(),(kind==='daily'?'Daily event':'Weekly event')+' · Fixture track');
  assert.deepEqual(await p.evaluate(()=>submits.slice(-2).map(run=>run.periodId).sort()),['daily-shared','weekly-shared']);
  assert.equal(await p.evaluate(()=>ui.finishPositions(id,id)?.newPosition),1);
  await p.evaluate(()=>{ui.leave();window.car=null;});
 }
});
test('featured track without exactly one matching server period never opens another event',async t=>{
 const p=await fixture(t);await sharedTrackPeriods(p);
 assert.equal(await p.evaluate(()=>ui.openEvent({kind:'daily',trackId:'b'.repeat(64)})),false);
 assert.equal(await p.evaluate(()=>!!window.car),false);assert.match(await p.locator('.sq-events-dialog main').innerText(),/may differ/);
 await p.evaluate(async()=>{periods.push({...periods[1],id:'duplicate-daily'});await ui.refreshCatalog(true);});
 assert.equal(await p.evaluate(()=>ui.openEvent({kind:'daily',trackId:id})),false);assert.equal(await p.evaluate(()=>!!window.car),false);
});
test('stale same-period launch failure cannot clear a newer event intent',async t=>{
 const p=await fixture(t);
 await p.evaluate(()=>{
  let rejectFirst, calls=0;
  bridgeFixture.openTrack=()=>++calls===1?new Promise((_,reject)=>{rejectFirst=reject;}):Promise.resolve();
  window.rejectOldLaunch=()=>rejectFirst(Error('stale launch failed'));
  window.startOldLaunch=()=>{window.oldLaunch=ui.openEvent({kind:'daily',trackId:id});};
  window.startNewLaunch=()=>{window.newLaunch=ui.openEvent({kind:'daily',trackId:id});};
 });
 await p.evaluate(()=>startOldLaunch());
 await p.waitForFunction(()=>typeof window.rejectOldLaunch==='function'&&bridgeFixture.openTrack);
 await p.evaluate(()=>startNewLaunch());
 assert.equal(await p.evaluate(()=>newLaunch),true);
 assert.equal(await p.evaluate(()=>ui.isEntered(id)),true);
 await p.evaluate(()=>rejectOldLaunch());
 await p.waitForTimeout(0);
 assert.equal(await p.evaluate(()=>ui.isEntered(id)),true);
});
test('current native track-open failure clears only its owned event intent',async t=>{
 const p=await fixture(t);
 await p.evaluate(()=>{bridgeFixture.openTrack=async()=>{throw Error('fixture launch failure');};});
 assert.equal(await p.evaluate(()=>ui.openEvent({kind:'daily',trackId:id})),false);
 assert.equal(await p.evaluate(()=>ui.isEntered(id)),false);
 assert.match(await p.locator('.sq-events-dialog main').innerText(),/could not be opened/);
});
async function addNativePlay(p){await p.evaluate(()=>{window.normalStarts=0;const play=document.createElement('button');play.className='button play';play.textContent='Play';play.onclick=()=>normalStarts++;document.querySelector('.side-panel').append(play);});}
test('event Play never falls through to normal PB launch; leaving restores normal Play',async t=>{
 const p=await fixture(t);await addNativePlay(p);await enter(p);
 await p.locator('.side-panel .play').click();assert.equal(await p.evaluate(()=>normalStarts),0);assert.match(await p.locator('.sq-event-inline-status').innerText(),/safe event race launch/);
 await p.evaluate(()=>{bridgeFixture.startEventRace=async context=>{window.eventLaunch=context;};});await p.locator('.side-panel .play').click();
 assert.deepEqual(await p.evaluate(()=>({period:eventLaunch.periodId,track:eventLaunch.trackId,account:eventLaunch.accountId,normalStarts})),{period:'daily-fixture',track:id,account:id,normalStarts:0});
 await p.evaluate(()=>{bridgeFixture.startEventRace=async()=>{throw Error('unavailable');};});await p.locator('.side-panel .play').click();assert.equal(await p.evaluate(()=>normalStarts),0);
 await p.evaluate(()=>ui.leave());await p.locator('.side-panel .play').click();assert.equal(await p.evaluate(()=>normalStarts),1);
});
test('native event cars use exact validated cached styles and label unknown cars honestly',async t=>{
 const p=await fixture(t);await p.evaluate(()=>{
  const original=bridgeFixture.require();bridgeFixture.require=()=>n=>n===8724?{A:{deserializeSafe:s=>s==='exact-saved-style'?{serialize:()=>s}:{serialize:()=>'default'}}}:original(n);
  window.__polytrackCarStyleByUser062={[id]:'exact-saved-style',['c'.repeat(64)]:'malformed'};window.renderCalls=[];
  window.BT=async(...args)=>{renderCalls.push(args);return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=';};
  const read=bridgeFixture.readSnapshot;bridgeFixture.readSnapshot=async key=>({...await read(key),entries:[{accountId:id,name:'Cached',timeMs:20000,rank:1,rp:100},{accountId:'b'.repeat(64),name:'Unknown',timeMs:21000,rank:2,rp:90},{accountId:'c'.repeat(64),name:'Malformed',timeMs:22000,rank:3,rp:80}]});
 });await enter(p);await p.waitForFunction(()=>renderCalls.length===1);assert.deepEqual(await p.evaluate(()=>renderCalls),[['exact-saved-style','']]);
 assert.equal(await p.locator('.sq-event-board .image-container img[alt="Car unavailable"]').count(),2);
 await p.locator('.sq-event-board .image-container img[alt="Cached profile car"]').waitFor();
 assert.equal(await p.locator('.sq-event-board .verified-state.verified').count(),3);
});
test('cold event rows supply exact cars and refreshed directory names',async t=>{
 const p=await fixture(t);await p.evaluate(()=>{
  const prior=bridgeFixture.require();bridgeFixture.require=()=>n=>n===8724?{A:{deserializeSafe:s=>({serialize:()=>s==='row-style'?s:'default'})}}:prior(n);
  bridgeFixture.displayName=(account,name)=>account===id?'Refreshed racer':name;
  window.renderCalls=[];window.BT=async style=>{renderCalls.push(style);return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=';};
  const read=bridgeFixture.readSnapshot;bridgeFixture.readSnapshot=async key=>({...await read(key),entries:[{accountId:id,name:'Old racer',carStyle:'row-style',timeMs:20000,rank:1,rp:100}]});
 });await enter(p);await p.waitForFunction(()=>renderCalls.length===1);
 assert.deepEqual(await p.evaluate(()=>renderCalls),['row-style']);
 assert.match(await p.locator('.sq-event-board').innerText(),/Refreshed racer/);
 assert.equal(await p.locator('.sq-event-board .total-players').innerText(),'1 racer');
});

test('event car falls back to an account-matched persisted style and native renderer',async t=>{
 const p=await fixture(t);await p.evaluate(()=>{
  localStorage.setItem('polytrack-0.6.2-s1-overall-snapshot-v5',JSON.stringify({entries:[{userId:id,carStyle:'saved-exact'}]}));
  const prior=bridgeFixture.require();window.fallbackCalls=0;window.BT=async()=>'';
  bridgeFixture.require=()=>n=>n===8724?{A:{deserializeSafe:s=>s==='saved-exact'?{style:s,serialize:()=>s}:null}}:n===3787?{F:async value=>{fallbackCalls++;if(value.style!=='saved-exact')throw Error('wrong style');return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=';}}:prior(n);
 });await enter(p);await p.waitForFunction(()=>!!window.car);await p.evaluate(()=>car.finish(20000));await p.waitForFunction(()=>fallbackCalls===1);
 await p.locator('.sq-event-board img[alt="Cached profile car"]').waitFor();await p.evaluate(()=>{for(let i=0;i<30;i++)ui.tick();});assert.equal(await p.evaluate(()=>fallbackCalls),1);
});
test('event leaderboard validates each cached car style once across repeated menu ticks',async t=>{
 const p=await fixture(t);await p.evaluate(()=>{
  const prior=bridgeFixture.require();window.deserializeCalls=[];
  bridgeFixture.require=()=>n=>n===8724?{A:{deserializeSafe:s=>{deserializeCalls.push(s);return {serialize:()=>s};}}}:prior(n);
  window.BT=async()=> 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=';
  const read=bridgeFixture.readSnapshot;bridgeFixture.readSnapshot=async key=>({...await read(key),entries:Array.from({length:5},(_,i)=>({accountId:String(i+1).repeat(64),name:'Racer '+i,carStyle:'menu-style-'+i,timeMs:20000+i,rank:i+1,rp:100}))});
 });await enter(p);await p.locator('.sq-event-board .total-players').getByText('5 racers').waitFor();
 await p.evaluate(()=>{for(let i=0;i<60;i++)ui.tick();});
 assert.deepEqual(await p.evaluate(()=>deserializeCalls),Array.from({length:5},(_,i)=>'menu-style-'+i));
});
test('unchanged event opponents do not mutate the native side panel on repeated ticks',async t=>{
 const p=await fixture(t);await enter(p);await p.locator('.sq-event-opponents').waitFor();
 const mutations=await p.evaluate(async()=>{
  const note=document.querySelector('.sq-event-opponents');let changes=0;
  const observer=new MutationObserver(records=>{changes+=records.length;});
  observer.observe(note,{childList:true,characterData:true,subtree:true});
  for(let i=0;i<30;i++)ui.tick();
  await Promise.resolve();observer.disconnect();return changes;
 });
 assert.equal(mutations,0);
});
test('repeated visible event ticks do not mutate an unchanged permanent-card title',async t=>{
 const p=await fixture(t);await showLiveRail(p);
 const mutations=await p.evaluate(async()=>{
  const group=document.querySelector('.sq-featured-events');const note=document.createElement('small');note.className='sq-permanent-note';group.append(note);ui.tick();let changes=0;
  const observer=new MutationObserver(records=>{changes+=records.length;});
  observer.observe(note,{attributes:true,attributeFilter:['title']});
  for(let i=0;i<30;i++)ui.tick();
  await Promise.resolve();observer.disconnect();return changes;
 });
 assert.equal(mutations,0);
});
test('event thumbnail rendering runs one job at a time',async t=>{
 const p=await fixture(t);await p.evaluate(()=>{
  const prior=bridgeFixture.require();bridgeFixture.require=()=>n=>n===8724?{A:{deserializeSafe:s=>s.startsWith('style-')?{serialize:()=>s}:null}}:prior(n);
  window.renderJobs=[];window.activeRenders=0;window.maxRenders=0;window.BT=()=>new Promise(resolve=>{activeRenders++;maxRenders=Math.max(maxRenders,activeRenders);renderJobs.push(()=>{activeRenders--;resolve('');});});
  const read=bridgeFixture.readSnapshot;bridgeFixture.readSnapshot=async key=>({...await read(key),entries:Array.from({length:5},(_,i)=>({accountId:String(i+1).repeat(64),carStyle:'style-'+i,timeMs:20000+i,rank:i+1}))});
 });await enter(p);await p.waitForFunction(()=>renderJobs.length===1);
 await p.evaluate(()=>renderJobs[0]());
 await p.waitForTimeout(200);
 assert.equal(await p.evaluate(()=>maxRenders),1);
});
test('shared event-car render uses a visible subscriber and reuses one row label',async t=>{
 const p=await fixture(t,{controlledIntersectionObserver:true});await p.evaluate(()=>{
  const prior=bridgeFixture.require();bridgeFixture.require=()=>n=>n===8724?{A:{deserializeSafe:s=>({serialize:()=>s})}}:prior(n);
  window.pendingIdle=[];window.requestIdleCallback=callback=>{pendingIdle.push(callback);return pendingIdle.length;};window.cancelIdleCallback=()=>{};
  window.renderCalls=[];window.BT=async style=>{renderCalls.push(style);return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=';};
  const read=bridgeFixture.readSnapshot;bridgeFixture.readSnapshot=async key=>({...await read(key),entries:[{accountId:'b'.repeat(64),name:'Hidden racer',carStyle:'shared-style',timeMs:20000,rank:1},{accountId:'c'.repeat(64),name:'Visible racer',carStyle:'shared-style',timeMs:21000,rank:2}]});
 });await enter(p);await p.waitForFunction(()=>eventCarObserver?.targets.size===2);
 await p.evaluate(()=>eventCarObserver.trigger([...eventCarObserver.targets].map(target=>({target,isIntersecting:true}))));
 await p.evaluate(()=>eventCarObserver.trigger([...eventCarObserver.targets].map(target=>({target,isIntersecting:true}))));
 await p.waitForFunction(()=>pendingIdle.length===1);
 assert.deepEqual(await p.evaluate(()=>[...document.querySelectorAll('.sq-event-board button.main')].map(row=>row.querySelectorAll('.sq-event-car-unavailable').length)),[1,1]);
 await p.evaluate(()=>{document.querySelector('.sq-event-board button.main').style.display='none';pendingIdle.shift()();});
 await p.waitForFunction(()=>renderCalls.length===1&&document.querySelectorAll('.sq-event-board button.main')[1].querySelector('.image-container img').getAttribute('src')?.startsWith('data:image/png;base64,'));
 assert.deepEqual(await p.evaluate(()=>renderCalls),['shared-style']);
});
test('event car queue overflow retries when IntersectionObserver is unavailable',async t=>{
 const p=await fixture(t,{noIntersectionObserver:true});await p.evaluate(()=>{
  const prior=bridgeFixture.require();bridgeFixture.require=()=>n=>n===8724?{A:{deserializeSafe:s=>({serialize:()=>s})}}:prior(n);
  window.renderCalls=[];window.BT=async style=>{renderCalls.push(style);return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=';};
  const read=bridgeFixture.readSnapshot;bridgeFixture.readSnapshot=async key=>({...await read(key),entries:Array.from({length:13},(_,i)=>({accountId:String(i+1).repeat(64),name:'Racer '+i,carStyle:'fallback-'+i,timeMs:20000+i,rank:i+1}))});
 });await enter(p);await p.waitForFunction(()=>renderCalls.length===13,{timeout:10000});
 await p.waitForFunction(()=>document.querySelectorAll('.sq-event-board .image-container img[src^="data:image/png;base64,"]').length===13);
 assert.equal(await p.evaluate(()=>new Set(renderCalls).size),13);
});
test('resolved event-car styles are reused after reopening the native event view',async t=>{
 const p=await fixture(t);await p.evaluate(()=>{
  const prior=bridgeFixture.require();bridgeFixture.require=()=>n=>n===8724?{A:{deserializeSafe:s=>({serialize:()=>s})}}:prior(n);
  window.renderCalls=[];window.BT=async style=>{renderCalls.push(style);return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=';};
  const read=bridgeFixture.readSnapshot;bridgeFixture.readSnapshot=async key=>({...await read(key),entries:[{accountId:'b'.repeat(64),name:'Cached racer',carStyle:'reopened-style',timeMs:20000,rank:1}]});
 });await enter(p);await p.waitForFunction(()=>renderCalls.length===1);await p.locator('.sq-event-board img[alt="Cached profile car"]').waitFor();
 await p.evaluate(()=>ui.leave());await enter(p);await p.locator('.sq-event-board img[alt="Cached profile car"]').waitFor();
 assert.deepEqual(await p.evaluate(()=>renderCalls),['reopened-style']);
});
test('readiness wait shows cancellable progress and cannot reopen after cancellation',async t=>{
 const p=await fixture(t,{deferReady:true});await showLiveRail(p);await p.locator('.sq-event-track-buttons [data-event-id]').click();
 assert.match(await p.locator('.sq-events-dialog main').innerText(),/Opening event/);await p.locator('[data-event-close]').click();await p.evaluate(()=>resolveReady());await p.waitForTimeout(400);assert.equal(await p.evaluate(()=>!!window.car),false);
});
test('own event replay survives upload without borrowing normal or another period replay',async t=>{
 const p=await fixture(t);await enter(p);await p.waitForFunction(()=>!!window.car);await p.evaluate(()=>car.finish(20000));await p.waitForFunction(()=>submits.length===1);
 assert.deepEqual(await p.evaluate(()=>{const r=ui.getOwnReplay('daily-fixture');return {period:r.periodId,track:r.trackId,account:r.accountId,time:r.timeMs,replay:r.replay,other:ui.getOwnReplay('weekly-fixture')};}),{period:'daily-fixture',track:id,account:id,time:20000,replay:'AAAA',other:null});
 await p.evaluate(()=>{const key='polytrack-062-events-v1-replays',rows=JSON.parse(localStorage.getItem(key));rows[0].trackId='b'.repeat(64);localStorage.setItem(key,JSON.stringify(rows));});assert.equal(await p.evaluate(()=>ui.getOwnReplay('daily-fixture')),null);
});
test('unchanged event ticks reuse parsed local replay cache and observe storage changes',async t=>{
 const p=await fixture(t);await enter(p);await p.waitForFunction(()=>!!window.car);await p.evaluate(()=>car.finish(20000));await p.waitForFunction(()=>submits.length===1);
 const result=await p.evaluate(()=>{
  const key='polytrack-062-events-v1-replays',raw=localStorage.getItem(key),parse=JSON.parse;let count=0;
  JSON.parse=function(value,...args){if(value===raw)count++;return parse.call(this,value,...args);};
  try{
   ui.tick();count=0;for(let i=0;i<30;i++)ui.tick();
   const cached=count,rows=JSON.parse(localStorage.getItem(key));rows[0].at++;
   localStorage.setItem(key,JSON.stringify(rows));ui.tick();
   return {parsedDuringRepeatedTicks:cached,changedValueObserved:!!ui.getOwnReplay('daily-fixture')};
  }finally{JSON.parse=parse;}
 });
 assert.deepEqual(result,{parsedDuringRepeatedTicks:0,changedValueObserved:true});
});
test('corrupt local replay cache never blocks event Play',async t=>{
 const p=await fixture(t);await addNativePlay(p);await enter(p);
 for(const cache of [null,{},[null],[null,{periodId:'daily-fixture',accountId:id,trackId:id}]]){
  await p.evaluate(cache=>{localStorage.setItem('polytrack-062-events-v1-replays',JSON.stringify(cache));bridgeFixture.supportsEventGhost=()=>true;bridgeFixture.startEventRace=context=>{window.safeContext=context;};},cache);
  assert.equal(await p.evaluate(()=>ui.getOwnReplay('daily-fixture')),null);
  await p.locator('.side-panel .play').click();assert.equal(await p.evaluate(()=>safeContext.ownGhost),null);
 }
});

test('normal leaderboard loading state cannot hide an event row or its car',async t=>{
 const p=await fixture(t);await p.addStyleTag({content:'.sq-track-leaderboard-loading .leaderboard-ui>.container>button.main{visibility:hidden!important}.sq-track-leaderboard-loading .leaderboard-ui>.container::after{content:"Loading track leaderboard";display:block}'});
 await p.addStyleTag({url:base+'/events/events.css'});await enter(p);await p.waitForFunction(()=>!!window.car);await p.evaluate(()=>{car.finish(20000);document.documentElement.classList.add('sq-track-leaderboard-loading');});
 assert.deepEqual(await p.evaluate(()=>({row:getComputedStyle(document.querySelector('.sq-event-board button.main')).visibility,overlay:getComputedStyle(document.querySelector('.sq-event-board>.container'),'::after').display})),{row:'visible',overlay:'none'});
});
test('expired event Play remains blocked after a UI tick, never reverting to normal ghosts',async t=>{
 const p=await fixture(t);await addNativePlay(p);await enter(p);
 await p.evaluate(()=>{const now=Date.now();Date.now=()=>now+7200000;ui.tick();});
 await p.locator('.side-panel .play').click();assert.equal(await p.evaluate(()=>normalStarts),0);
 assert.match(await p.locator('.sq-event-inline-status').innerText(),/no longer open/);
});
const eventBridge=section('  let pendingEventLaunch=null;','  async function eventCloudRead(');
test('event bridge rejects duplicate native launches until the first launch is consumed',async t=>{
 const p=await fixture(t);assert.deepEqual(await p.evaluate(source=>{
  const activeRankedAccountId=()=>id;window.__pt062NativeEventLaunchVersion=1;
  const start=eval('(()=>{'+source+';return startEventRace})()');let invokes=0,current=true,rejected=false;
  const context={periodId:'daily-fixture',trackId:id,accountId:id,endsAt:Date.now()+10000};
  start(context,()=>invokes++,()=>current);try{start(context,()=>invokes++,()=>true);}catch{rejected=true;}
  const first=window.__pt062PrepareEventRace(id,null);start(context,()=>invokes++,()=>current);current=false;start(context,()=>invokes++,()=>true);
  return {invokes,rejected,first,last:window.__pt062PrepareEventRace(id,null)};
 },eventBridge),{invokes:3,rejected:true,first:{ownGhost:null,opponents:[]},last:{ownGhost:null,opponents:[]}});
});
test('actual event bridge permits native click once and rejects stale launch context',async t=>{
 const p=await fixture(t);await addNativePlay(p);await p.evaluate(source=>{
  const activeRankedAccountId=()=>id;window.__pt062NativeEventLaunchVersion=1;
  bridgeFixture.startEventRace=eval('(()=>{'+source+';return startEventRace})()');
  document.querySelector('.side-panel .play').onclick=()=>{window.nativeEvent=window.__pt062PrepareEventRace(id,null);};
 },eventBridge);await enter(p);await p.locator('.side-panel .play').click();assert.deepEqual(await p.evaluate(()=>nativeEvent),{ownGhost:null,opponents:[]});
 assert.equal(await p.evaluate(()=>window.__pt062PrepareEventRace(id,null)),false,'launch policy is consumed, not sticky');
 assert.equal(await p.evaluate(()=>{
  let current=true;bridgeFixture.startEventRace({periodId:'daily-fixture',trackId:id,accountId:id,endsAt:Date.now()+10000},()=>{},()=>current);current=false;
  try{window.__pt062PrepareEventRace(id,null);return false;}catch{return true;}
 }),true);
 await p.evaluate(()=>ui.leave());await p.locator('.side-panel .play').click();assert.equal(await p.evaluate(()=>nativeEvent),false);
});
test('Ranked footer replaces legacy targets with exact catalog assignments without repeated reads',async t=>{
 const p=await fixture(t);await sharedTrackPeriods(p);await p.evaluate(()=>{
  const panel=document.createElement('div');panel.id='overallLeaderboardPanel';
  panel.innerHTML=['weekly-cup','daily-card'].map(kind=>`<section class="${kind}"><button class="competition-feature-button" data-track-id="legacy"><span class="competition-feature-image"></span><span class="competition-kicker">Legacy</span><strong class="competition-track-name">Wrong legacy track</strong><span class="competition-result">Normal result</span></button><small>Wrong deadline</small></section>`).join('');document.body.append(panel);ui.tick();window.beforeFooterReads=catalogReads;
  for(let i=0;i<100;i++)ui.tick();
 });
 assert.equal(await p.evaluate(()=>catalogReads),await p.evaluate(()=>beforeFooterReads));
 assert.equal(await p.locator('.daily-card button').getAttribute('data-event-id'),'daily-shared');assert.equal(await p.locator('.weekly-cup button').getAttribute('data-event-id'),'weekly-shared');
 assert.equal(await p.locator('.daily-card button').getAttribute('data-track-id'),null);assert.match(await p.locator('.daily-card small').innerText(),/Local/);assert.doesNotMatch(await p.locator('#overallLeaderboardPanel').innerText(),/Wrong|Normal result/);
 await p.locator('.daily-card button').click();await p.waitForFunction(()=>!!window.car);await p.evaluate(()=>car.finish(20000));await p.waitForFunction(()=>submits.length===2);assert.deepEqual(await p.evaluate(()=>submits.map(run=>run.periodId).sort()),['daily-shared','weekly-shared']);
});
test('ordinary Rolling Hills display stays normal but its finish credits the matching weekly event',async t=>{
 const p=await fixture(t);await sharedTrackPeriods(p);await p.evaluate(()=>{
  const trackId='fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';periods.forEach(p=>p.trackId=trackId);bridgeFixture.require()(9117).A.prototype.getId=()=>trackId;
  bridgeFixture.trackInfo=()=>({name:'Rolling Hills Racer'});const host=document.createElement('div');host.className='track-selection-ui';host.innerHTML='<div class="community-track-versions"><button>Static</button><button>0.6.3</button></div><div class="community-track-group"><div class="track"><button id="rolling"><span class="track-title"><p>Rolling Hills Racer</p></span></button></div></div>';document.body.append(host);
  window.nativeSelections=0;document.querySelector('#rolling').onclick=()=>{nativeSelections++;window.car=makeCar();};bridgeFixture.openTrack=()=>document.querySelector('#rolling').click();ui.tick();
 });
 assert.equal(await p.locator('#rolling[data-native-weekly-event]').count(),0);
 assert.equal(await p.locator('.sq-featured-events #rolling').count(),0);
 await p.evaluate(()=>ui.prepareCapture());await p.locator('#rolling').click();await p.evaluate(()=>car.finish(21000));await p.waitForFunction(()=>submits.length===2);assert.equal(await p.evaluate(()=>document.body.classList.contains('sq-event-active')),false);
 await p.locator('.sq-featured-events [data-event-id="weekly-shared"]').click();await p.evaluate(()=>car.finish(20000));
 await p.waitForFunction(()=>submits.length===4);assert.deepEqual(await p.evaluate(()=>submits.slice(2).map(run=>run.periodId).sort()),['daily-shared','weekly-shared']);
 await p.evaluate(()=>{document.querySelector('.community-track-group').style.display='none';ui.tick();});
 assert.equal(await p.locator('.sq-featured-events').isVisible(),true);assert.equal(await p.locator('.sq-featured-events .sq-event-card').count(),2);
});

test('Ranked visibility imports event module once even without any track group',async t=>{
 const p=await fixture(t);assert.deepEqual(await p.evaluate(async source=>{
  let eventUi=null,eventUiPromise=null,eventQueueChecked=true,eventModuleRetryAt=0,calls=0;
  const isElementVisible=e=>e.getClientRects().length>0&&getComputedStyle(e).display!=='none';
  const ensureEventUi=()=>{calls++;return Promise.resolve({tick(){}});};
  const ensureExtraTracksEntryContents=()=>{};
  document.querySelector('.track-info-ui').style.display='none';
  const panel=document.createElement('div');panel.id='overallLeaderboardPanel';panel.textContent='Ranked';panel.style.display='none';document.body.append(panel);
  const invoke=eval('('+source+')');invoke();const hidden=calls;panel.style.display='block';for(let i=0;i<100;i++)invoke();await Promise.resolve();return {hidden,visible:calls};
 },entry),{hidden:0,visible:1});
});

test('finish overlay shows ordinal event placement and never invents placement without a snapshot',async t=>{
 const p=await fixture(t);await enter(p);await p.waitForFunction(()=>!!window.car);
 await p.evaluate(()=>{car.finish(20000);const end=document.createElement('div');end.className='time-announcer-ui';end.innerHTML='<div class="current"><div class="time">00:20.000</div><div class="position-dash">-</div><div class="position"></div></div>';document.body.append(end);ui.tick();});
 assert.equal(await p.locator('.time-announcer-ui .position').innerText(),'1st');
 assert.match(await p.locator('.time-announcer-ui .position').getAttribute('title'),/provisional/);
 assert.equal(await p.locator('.sq-event-finish-place').count(),0);
});

test('live and archived event browser fits phone, tablet and desktop without horizontal overflow',async t=>{
 const p=await fixture(t);await p.addStyleTag({url:base+'/events/events.css'});await p.locator('#open').click();await p.locator('.sq-event-cards').waitFor();
 for(const [width,height] of [[320,720],[390,844],[820,1180],[1107,1282],[1920,1080]]){
  await p.setViewportSize({width,height});
  assert.equal(await p.locator('.sq-events-dialog').evaluate(node=>node.getBoundingClientRect().left>=-1&&node.getBoundingClientRect().right<=innerWidth+1&&node.scrollWidth<=node.clientWidth+2),true,width+'px live dialog');
  assert.equal(await p.locator('.sq-events-dialog main').evaluate(node=>node.scrollWidth<=node.clientWidth+2),true,width+'px live content');
 }
 await p.locator('[data-event-archives]').click();await p.locator('input[name="archive-month"]').fill('2026-08');await p.getByRole('button',{name:'View month',exact:true}).click();await p.locator('[data-archive-event-id="old-event"]').waitFor();
 for(const [width,height] of [[320,720],[390,844],[820,1180],[1920,1080]]){
  await p.setViewportSize({width,height});assert.equal(await p.locator('.sq-events-dialog main').evaluate(node=>node.scrollWidth<=node.clientWidth+2),true,width+'px archive content');
 }
});
