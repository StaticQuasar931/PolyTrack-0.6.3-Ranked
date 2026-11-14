import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const evidence=process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR||'C:/Users/Static/Documents/Codexstorage/PolyTrack/Projects/Ranked-0.6.3/2026-11-13/late-update/test-logs';
const runTag=Date.now();
let browser;
before(async()=>{browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});
async function fixture({blocked=false}={}){
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[],external=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>{
 const url=new URL(route.request().url());
 if(url.origin==='https://friends.test'&&url.pathname==='/local-friends.mjs')return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(new URL('./local-friends.mjs',import.meta.url),'utf8')});
 if(url.href==='https://friends.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:16px;font:16px sans-serif;background:#14274a;color:white}main{width:100%;min-width:0}dialog{max-width:calc(100vw - 64px)}</style><button id="outside">Outside</button><main id="friends"></main><dialog id="modal"><input aria-label="Modal text"><button id="modal-close">Close</button></dialog>'});
 external.push(url.href);return route.abort();
 });
 await page.goto('https://friends.test/');
 await page.evaluate(async blocked=>{
 const m=await import('/local-friends.mjs');window.friendsModule=m;window.id=n=>n.toString(16).padStart(64,'0');window.account=id(1);
 window.storage=blocked?{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}}:localStorage;
 window.store=m.createLocalFriends({accountId:account,storage});window.openedRacers=[];window.openedTracks=[];window.localRows=[];window.scoring=null;window.racerName='Friendly racer';
 window.mount=(viewedId=null,options={})=>{
 window.cleanup?.();const host=document.querySelector('#friends');host.dataset.friendAccount=account;
 window.cleanup=m.mountLocalFriends(host,{store,viewedId,resolveRacer:()=>({name:racerName}),loadScoring:()=>Promise.resolve(scoring),localFinishes:()=>localRows,allowTrack:t=>t!=='expired',trackName:()=> 'Summer Sprint',onOpenRacer:id=>openedRacers.push(id),onOpenTrack:id=>openedTracks.push(id),...options});
 };
 },blocked);
 return {page,errors,external,async finish(){assert.deepEqual(errors,[],'uncaught browser errors');assert.deepEqual(external,[],'unexpected external request');await page.close();}};
}

test('blocked storage keeps add/remove working with honest visit-only feedback',async()=>{
 const f=await fixture({blocked:true}),p=f.page;try{
 await p.evaluate(()=>mount(id(2)));await p.locator('[data-friend-toggle]').click();
 assert.equal(await p.locator('[data-friend-toggle]').getAttribute('aria-pressed'),'true');assert.match(await p.getByRole('status').textContent(),/visit.*storage is unavailable/i);
 await p.locator('[data-friend-toggle]').click();assert.equal(await p.evaluate(()=>store.ids().length),0);
 assert.match(await p.getByRole('status').textContent(),/visit|storage/i);
 }finally{await f.finish();}
});

test('32-friend cap survives browser remount; removal permits one replacement',async()=>{
 const f=await fixture(),p=f.page;try{
 for(let n=2;n<=33;n++){await p.evaluate(n=>mount(id(n)),n);await p.locator('[data-friend-toggle]').click();}
 assert.equal(await p.evaluate(()=>store.ids().length),32);
 await p.evaluate(()=>mount(id(99)));await p.locator('[data-friend-toggle]').click();assert.match(await p.getByRole('status').textContent(),/full/i);assert.equal(await p.locator('[data-friend-toggle]').getAttribute('aria-pressed'),'false');
 await p.evaluate(()=>{store=friendsModule.createLocalFriends({accountId:account,storage});mount();});
 await p.locator('summary').click();assert.equal(await p.locator('[data-friend-remove]').count(),32);
 await p.locator('[data-friend-remove]').first().click();assert.equal(await p.locator('[data-friend-remove]').count(),31);
 await p.evaluate(()=>mount(id(99)));await p.locator('[data-friend-toggle]').click();assert.equal(await p.evaluate(()=>store.ids().length),32);
 }finally{await f.finish();}
});

test('malicious names stay text; friend/track buttons navigate with exact IDs and fit portrait',async()=>{
 const f=await fixture(),p=f.page;try{
 const evil='<img src="https://evil.invalid/x" onerror="window.pwned=true"> & Racer';
 await p.evaluate(evil=>{racerName=evil;store.add(id(2));scoring={profiles:new Map([[account,[{trackId:'track-a',timeMs:20000}]],[id(2),[{trackId:'track-a',timeMs:19000}]]])};mount();},evil);
 await p.locator('summary').click();await p.locator('[data-friend-track]').waitFor();
 assert.equal(await p.locator('[data-friend-open]').textContent(),evil);assert.equal(await p.locator('#friends img,#friends script').count(),0);assert.equal(await p.evaluate(()=>window.pwned),undefined);
 await p.locator('[data-friend-open]').click();await p.locator('[data-friend-track]').click();
 assert.deepEqual(await p.evaluate(()=>openedRacers),['2'.padStart(64,'0')]);assert.deepEqual(await p.evaluate(()=>openedTracks),['track-a']);
 const width=await p.evaluate(()=>({page:document.documentElement.scrollWidth,view:innerWidth}));assert.ok(width.page<=width.view+1,JSON.stringify(width));
 fs.mkdirSync(evidence,{recursive:true});await p.screenshot({path:path.join(evidence,'local-friends-portrait-390-'+runTag+'.png'),fullPage:true});
 }finally{await f.finish();}
});

test('account swap and disposed pending scoring cannot overwrite replacement UI',async()=>{
 const f=await fixture(),p=f.page;try{
 await p.evaluate(()=>{store.add(id(2));window.active=true;mount(null,{isCurrent:()=>active,loadScoring:()=>new Promise(resolve=>window.finishOld=resolve)});});
 await p.locator('summary').click();await p.waitForFunction(()=>typeof finishOld==='function');
 await p.evaluate(()=>{active=false;cleanup();account=id(9);store=friendsModule.createLocalFriends({accountId:account,storage});mount();});
 const before=await p.locator('#friends').innerHTML();await p.evaluate(()=>finishOld({profiles:new Map([[id(1),[{trackId:'a',timeMs:20000}]],[id(2),[{trackId:'a',timeMs:10000}]]])}));
 await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));assert.equal(await p.locator('#friends').innerHTML(),before);assert.equal(await p.evaluate(()=>store.ids().length),0);
 await p.evaluate(()=>{store.add(id(3));window.guard=true;mount(null,{isCurrent:()=>guard,loadScoring:()=>new Promise(resolve=>window.finishGuarded=resolve)});});
 await p.locator('summary').click();await p.waitForFunction(()=>typeof finishGuarded==='function');
 await p.evaluate(()=>{guard=false;document.querySelector('#friends').textContent='Replacement account UI';finishGuarded({profiles:new Map()});});
 await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));assert.equal(await p.locator('#friends').textContent(),'Replacement account UI');
 }finally{await f.finish();}
});

test('exact current local PB removes a stale chase; unrelated or held rows do not',async()=>{
 const f=await fixture(),p=f.page;try{
 await p.evaluate(()=>{store.add(id(2));scoring={profiles:new Map([[account,[{trackId:'a',timeMs:20000}]],[id(2),[{trackId:'a',timeMs:19000}]]])};localRows=[{trackId:'other',timeMs:10000}];mount();});
 await p.locator('summary').click();await p.locator('[data-friend-track]').waitFor();assert.equal(await p.locator('[data-friend-track]').count(),1);
 await p.evaluate(()=>{localRows=[{trackId:'a',timeMs:18000,reviewHold:true}];mount();});await p.locator('summary').click();await p.locator('[data-friend-track]').waitFor();
 await p.evaluate(()=>{localRows=[{trackId:'a',timeMs:18000}];mount();});await p.locator('summary').click();await p.waitForFunction(()=>document.querySelector('.local-friend-challenges')?.textContent.includes('lead or tie'));
 assert.equal(await p.locator('[data-friend-track]').count(),0);
 }finally{await f.finish();}
});

test('late scoring leaves modal focus and game keys alone',async()=>{
 const f=await fixture(),p=f.page;try{
 await p.evaluate(()=>{store.add(id(2));mount(null,{loadScoring:()=>new Promise(resolve=>window.finishScoring=resolve)});window.gameKeys=[];document.addEventListener('keydown',e=>gameKeys.push(e.key));});
 await p.locator('summary').click();await p.waitForFunction(()=>typeof finishScoring==='function');
 await p.evaluate(()=>document.querySelector('#modal').showModal());await p.getByRole('textbox').focus();await p.keyboard.type('racer');
 await p.evaluate(()=>finishScoring({profiles:new Map([[account,[{trackId:'a',timeMs:20000}]],[id(2),[{trackId:'a',timeMs:19000}]]])}));await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
 assert.equal(await p.getByRole('textbox').inputValue(),'racer');assert.equal(await p.getByRole('textbox').evaluate(el=>el===document.activeElement),true);
 await p.keyboard.press('Escape');assert.equal(await p.locator('#modal').evaluate(el=>el.open),false);
 await p.locator('#outside').focus();await p.keyboard.press('ArrowRight');assert.equal(await p.evaluate(()=>gameKeys.at(-1)),'ArrowRight');
 }finally{await f.finish();}
});


test('scoring is lazy and focus/pageshow never rescan; report local mount cost',async()=>{
 const f=await fixture(),p=f.page;try{
 const mountMs=await p.evaluate(()=>{for(let n=2;n<=33;n++)store.add(id(n));window.scoringLoads=0;const start=performance.now();mount(null,{loadScoring:()=>{scoringLoads++;return Promise.resolve({profiles:new Map([[account,[]]])});}});return performance.now()-start;});
 assert.equal(await p.evaluate(()=>scoringLoads),0);assert.equal(await p.locator('[data-friend-open]').count(),32);
 await p.locator('summary').click();await p.waitForFunction(()=>scoringLoads===1);
 await p.evaluate(()=>{dispatchEvent(new Event('focus'));dispatchEvent(new Event('pageshow'));});
 assert.equal(await p.evaluate(()=>scoringLoads),1);
 fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,'local-friends-loading-'+runTag+'.json'),JSON.stringify({viewport:'390x844',friends:32,mountMs,scoringLoadsBeforeOpen:0,scoringLoadsAfterOpenAndRestores:1,externalRequests:f.external.length,scope:'Isolated real module fixture, not full-site startup or parent profile integration'},null,2)+'\n',{flag:'wx'});
 }finally{await f.finish();}
});
