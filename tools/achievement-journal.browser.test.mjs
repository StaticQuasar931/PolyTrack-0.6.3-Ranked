import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)('C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const evidence='C:/Users/Static/Documents/Codexstorage/PolyTrack/Projects/Ranked-0.6.3/2026-11-14/cosmetics-phase2';
let server,browser,base,cosmetics;
before(async()=>{
 const patch=await fs.readFile(path.join(root,'polytrack_062_patch.js'),'utf8');
 cosmetics=JSON.parse(JSON.stringify(vm.runInNewContext(`(${patch.match(/const PROFILE_COSMETIC_OPTIONS=(\{[\s\S]*?\n  \});/)[1]})`)));
 server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tools/achievement-journal.css"><style>@font-face{font-family:ForcedSquare;src:url(/forced_square.woff2)}body{margin:0;background:#172b58}#host{--profile-accent:#edbe81;--profile-pattern:repeating-linear-gradient(45deg,red 0 20px,lime 20px 40px)}</style><main id="host"></main></html>');return;}
  if(!['/tools/achievement-journal.mjs','/tools/achievement-journal-currency.mjs','/tools/achievement-journal.css','/forced_square.woff2'].includes(url.pathname)){res.writeHead(404).end();return;}
  res.setHeader('Content-Type',url.pathname.endsWith('.css')?'text/css':url.pathname.endsWith('.mjs')?'text/javascript':'font/woff2');
  try{res.end(await fs.readFile(path.join(root,url.pathname.slice(1))));}catch{res.writeHead(404).end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
 browser=await chromium.launch({headless:true,timeout:12000,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});await fs.mkdir(evidence,{recursive:true});
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));});
async function fixture(t,{width=1366,height=900,...extra}={}){
 const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce'});t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(5000);
 const errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():(external.push(route.request().url()),route.abort()));
 await page.goto(base);await page.evaluate(async({cosmetics,extra})=>{
  const api=await import('/tools/achievement-journal.mjs');window.api=api;
  window.input={cosmetics,progress:{confirmed:{raceCount:8,pbCount:10,extraCount:0,totalPlaytimeMs:3600000,trackWins:0,rank:18,badges:{betaTester:false},cosmeticUnlocks:[]},local:{practiceFinishes:17,extraCount:3,totalPlaytimeMs:5400000}},...extra};
  calls={rewards:[],navigation:[],closed:0,storage:[]};
  document.querySelector('#host').innerHTML=api.renderAchievementJournal(input);
  window.dispose=api.bindAchievementJournal(document.querySelector('#host'),{onTryCosmetic:r=>calls.rewards.push(r),onNavigate:n=>calls.navigation.push(n),onClose:()=>calls.closed++,storage:{getItem:()=>null,setItem:(...args)=>calls.storage.push(args)}});
  await document.fonts.ready;
 },{cosmetics,extra});
 page.checkClean=()=>{assert.deepEqual(errors,[]);assert.deepEqual(external,[]);};return page;
}
async function mouse(page,selector){
 const point=await page.locator(selector).first().evaluate(el=>{el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});const r=el.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;if(!el.contains(document.elementFromPoint(x,y)))throw Error('Obscured browser target: '+el.outerHTML.slice(0,120));return {x,y};});await page.mouse.click(point.x,point.y);
}

test('only actual catalog unlocks are achievements; measured device progress stays separate',{timeout:20000},async t=>{
 const page=await fixture(t);await mouse(page,'[data-aj-filter="all"]');await mouse(page,'[data-aj-family="all"]');
 const model=await page.evaluate(()=>api.buildAchievementJournalModel(input));
 assert.equal(await page.locator('[data-aj-node]').count(),model.counts.total);
 assert.ok(model.milestones.every(x=>x.rewards.length>0&&x.source==='catalog'||x.source==='currency'&&x.reward.amount>0&&!x.earned));
 assert.equal(await page.locator('[data-aj-node^="achievement:v1:"]').count(),0);
 await mouse(page,'.aj-local-tools>summary');await mouse(page,'.aj-device-progress summary');
 assert.match(await page.locator('.aj-device-progress').innerText(),/Saved practice finishes\s+17/);
 assert.match(await page.locator('.aj-device-progress').innerText(),/No unlock or Style Coins/);
 assert.doesNotMatch(await page.locator('.aj').innerText(),/cosmetic choice|Tokens|\bCP\b|Claim Style Coins|earned Style Coins/i);
 await mouse(page,'[data-aj-family="discovery"]');await mouse(page,'[data-aj-select="discovery:extra:1"]');
 assert.match(await page.locator('[data-aj-detail]').innerText(),/Current progress: 0\s+Goal: 1/);
 assert.match(await page.locator('[data-aj-detail]').innerText(),/Direct unlock/);
 assert.match(await page.locator('[data-aj-detail]').innerText(),/Saved on this device: 3/);
 await mouse(page,'[data-aj-detail] [data-aj-try]');
 const reward=await page.evaluate(()=>calls.rewards[0]);assert.equal(reward.confirmed,false);assert.equal(reward.previewOnly,true);assert.equal(reward.requirement,'extra:1');
 assert.equal(await page.locator('[data-aj-detail] [data-aj-reward-icon]').count()>0,true);
 page.checkClean();
});

test('sorting respects progress/reward count and keyboard order with connected aria descriptions',{timeout:20000},async t=>{
 const page=await fixture(t);await mouse(page,'[data-aj-filter="all"]');await mouse(page,'[data-aj-family="all"]');
 for(const mode of ['progress','rewards','name','target']){
  await page.locator('[data-aj-sort]').selectOption(mode);
  const lists=await page.locator('.aj-tier-list').evaluateAll(lists=>lists.map(list=>[...list.querySelectorAll('[data-aj-node]')].map(el=>JSON.parse(el.dataset.ajSortItem))));
  for(const items of lists){const expected=await page.evaluate(({items,mode})=>api.sortAchievementJournalItems(items,mode).map(x=>x.id),{items,mode});assert.deepEqual(items.map(x=>x.id),expected);}
 }
 const broken=await page.locator('[data-aj-select]').evaluateAll(buttons=>buttons.filter(el=>!document.getElementById(el.getAttribute('aria-describedby'))||!el.getAttribute('aria-controls')).length);assert.equal(broken,0);
 await page.locator('[data-aj-sort]').selectOption('rewards');
 const goals=page.locator('[data-aj-node]:visible [data-aj-select]');
 await goals.first().focus();await page.keyboard.press('ArrowDown');assert.equal(await goals.nth(1).evaluate(el=>el===document.activeElement),true);
 await page.keyboard.press('Enter');assert.equal(await goals.nth(1).getAttribute('aria-expanded'),'true');
 await page.locator('[data-aj-sort]').selectOption('progress');assert.equal(await page.locator('.aj-detail').isVisible(),true);
 await page.locator('[data-aj-select][aria-expanded="true"]').focus();await page.keyboard.press('Escape');assert.equal(await page.evaluate(()=>calls.closed),1);
 page.checkClean();
});

test('blue surfaces, balanced goal rows, readable type and safe navigation fit desktop/phone/landscape',{timeout:30000},async t=>{
 const report=[];
 for(const [width,height]of [[1440,1000],[390,844],[320,700],[844,390]]){
  const page=await fixture(t,{width,height});
  const metrics=await page.evaluate(()=>{const s=getComputedStyle(document.querySelector('.aj')),goal=document.querySelector('[data-aj-node]:not([hidden]) strong');return {width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,background:s.backgroundColor,pattern:s.backgroundImage,accent:s.getPropertyValue('--aj-cosmetic-accent').trim(),goalSize:parseFloat(getComputedStyle(goal).fontSize)};});
  assert.equal(metrics.overflow,false);assert.equal(metrics.background,'rgb(32, 51, 99)');assert.equal(metrics.pattern,'none');assert.equal(metrics.accent,'#edbe81');assert.ok(metrics.goalSize>=24);report.push(metrics);
  await mouse(page,'.aj-local-tools>summary');
  for(const name of ['practice','discovery','events'])await mouse(page,'.aj-next-steps [data-aj-navigate="'+name+'"]');
  assert.deepEqual(await page.evaluate(()=>calls.navigation),['practice','discovery','events']);await mouse(page,'.aj-local-tools>summary');
  await mouse(page,'[data-aj-node]:not([hidden]) [data-aj-select]');
  assert.equal(await page.locator('.aj-more').getAttribute('open'),'');
  if(width<=660)assert.ok(await page.locator('[data-aj-select][aria-expanded="true"]').evaluate(el=>el.getBoundingClientRect().height<350),'expanded phone goal must not stretch to inspector height');
  if(width===1440||width===390){await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:path.join(evidence,'achievement-blue-overview-'+width+'.png'),timeout:5000,animations:'disabled'});await page.locator('.aj-detail').evaluate(el=>el.scrollIntoView({block:'start',behavior:'instant'}));await page.screenshot({path:path.join(evidence,'achievement-blue-unlocks-'+width+'.png'),timeout:5000,animations:'disabled'});}
  page.checkClean();
 }
 await fs.writeFile(path.join(evidence,'achievement-blue-browser.json'),JSON.stringify({scope:'Offline journal with real catalog mapping, no monolith changes or server awards',viewports:report,passed:true},null,2));
});

test('unknown and hostile data stay unknown; storage failures and cleanup stay safe',{timeout:15000},async t=>{
 const page=await fixture(t,{cosmetics:{theme:[['hostile','<img src=x onerror=alert(1)>',3]]},progress:{local:{practiceFinishes:4,teleportCount:99,historyVisits:999}}});
 assert.equal(await page.locator('.aj img').count(),0);
 await mouse(page,'[data-aj-filter="all"]');await mouse(page,'[data-aj-family="all"]');
 assert.equal(await page.locator('[data-aj-node]').count(),8);assert.equal(await page.locator('[data-aj-node="style:3"]').getAttribute('data-aj-known'),'false');
 assert.equal(await page.locator('[data-aj-node="style:3"] progress').getAttribute('value'),null);
 assert.doesNotMatch(await page.locator('.aj').innerText(),/teleportCount|historyVisits/);
 await page.evaluate(()=>{dispose();dispose=api.bindAchievementJournal(document.querySelector('#host'),{onClose:()=>calls.closed++,storage:{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}}});});
 await mouse(page,'[data-aj-filter="all"]');await mouse(page,'[data-aj-family="all"]');await mouse(page,'[data-aj-select="style:3"]');
 assert.match(await page.locator('[data-aj-detail]').innerText(),/Not tracked yet/);
 await page.evaluate(()=>dispose());await mouse(page,'[data-aj-close]');assert.equal(await page.evaluate(()=>calls.closed),0);
 page.checkClean();
});


test('currency shows real amounts and eligible-to-check status; action only navigates to Shop',{timeout:15000},async t=>{
 const page=await fixture(t,{cosmetics:{},progress:{confirmed:{casualCompletionCount:20},local:{casualCompletionCount:89}}});
 await mouse(page,'[data-aj-filter="all"]');await mouse(page,'[data-aj-family="currency"]');
 assert.equal(await page.locator('[data-aj-node]:visible').count(),7);
 assert.equal(await page.locator('[data-aj-earned="true"]').count(),0);
 await page.locator('[data-aj-sort]').selectOption('coins');
 assert.deepEqual(await page.locator('[data-aj-node]:visible').evaluateAll(nodes=>nodes.map(el=>JSON.parse(el.dataset.ajSortItem).reward.amount)),[60,50,50,40,30,30,20]);
 await mouse(page,'[data-aj-select="currency:tracks-20"]');
 assert.match(await page.locator('[data-aj-detail]').innerText(),/Eligible to check/);assert.match(await page.locator('[data-aj-detail]').innerText(),/50 Style Coins/);
 assert.match(await page.locator('[data-aj-detail]').innerText(),/Shop checks eligibility and previous receipts/);
 assert.match(await page.locator('.aj-lane-count:visible').innerText(),/3 eligible to check/);
 await page.screenshot({path:path.join(evidence,'achievement-style-coins-desktop.png'),timeout:5000});
 await page.setViewportSize({width:390,height:844});
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await page.locator('.aj-detail').evaluate(el=>el.scrollIntoView({block:'start',behavior:'instant'}));
 await page.screenshot({path:path.join(evidence,'achievement-style-coins-portrait.png'),timeout:5000});
 await mouse(page,'[data-aj-detail] [data-aj-navigate="shop"]');assert.deepEqual(await page.evaluate(()=>calls.navigation),['shop']);assert.deepEqual(await page.evaluate(()=>calls.rewards),[]);
 page.checkClean();
});

test('recommendations cap at five, render text safely and reject stale selection/filter/disposal results',{timeout:20000},async t=>{
 const page=await fixture(t);await mouse(page,'[data-aj-filter="all"]');await mouse(page,'[data-aj-family="style"]');
 await page.evaluate(()=>{dispose();window.pending=[];window.previewIds=[];dispose=api.bindAchievementJournal(document.querySelector('#host'),{getRecommendations:item=>new Promise((resolve,reject)=>pending.push({item,resolve,reject})),onRecommendedTrack:id=>previewIds.push(id)});});
 assert.equal(await page.evaluate(()=>pending.length),0,'no recommendation work before explicit expansion');
 const goals=page.locator('[data-aj-node]:visible [data-aj-select]');
 await goals.nth(0).focus();await page.keyboard.press('Enter');
 assert.match(await page.locator('.aj-recommendations [role=status]').innerText(),/Finding tracks/);
 await goals.nth(1).focus();await page.keyboard.press('Enter');
 assert.equal(await page.evaluate(()=>pending.length),2);
 await page.evaluate(()=>pending[0].resolve([{trackId:'stale',name:'STALE',reason:'Old selection',difficulty:'Easy'}]));
 assert.equal(await page.locator('[data-aj-recommended-track]').count(),0);
 await page.evaluate(()=>pending[1].resolve(Array.from({length:8},(_,i)=>({trackId:'track-'+i,name:'<img src=x onerror=bad> '+i,reason:'<script>bad</script>',difficulty:'<b>Medium</b>'}))));
 await page.locator('[data-aj-recommended-track]').first().waitFor();assert.equal(await page.locator('[data-aj-recommended-track]').count(),5);
 assert.equal(await page.locator('.aj-recommendations img,.aj-recommendations script,.aj-recommendations b').count(),0);
 assert.match(await page.locator('.aj-recommendations').innerText(),/Teleport to preview: <img/);
 assert.equal(await page.evaluate(()=>pending[1].item.source),'catalog');assert.equal(typeof await page.evaluate(()=>pending[1].item.metric),'string');
 await mouse(page,'[data-aj-recommended-track="track-0"]');assert.deepEqual(await page.evaluate(()=>previewIds),['track-0']);
 await goals.nth(2).focus();await page.keyboard.press('Enter');
 await mouse(page,'[data-aj-filter="earned"]');await page.evaluate(()=>pending[2].resolve([{trackId:'filtered',name:'FILTERED'}]));
 assert.equal(await page.locator('.aj-recommendations').count(),0);
 await mouse(page,'[data-aj-filter="all"]');const next=page.locator('[data-aj-node]:visible [data-aj-select]').first();await next.focus();await page.keyboard.press('Enter');
 await page.evaluate(()=>{dispose();pending.at(-1).resolve([{trackId:'disposed',name:'DISPOSED'}]);});
 assert.equal(await page.locator('.aj-recommendations').count(),0);assert.deepEqual(await page.evaluate(()=>previewIds),['track-0']);
 page.checkClean();
});

test('recommendation errors and missing data stay explicit and never fabricate tracks',{timeout:15000},async t=>{
 const page=await fixture(t);await page.evaluate(()=>{dispose();dispose=api.bindAchievementJournal(document.querySelector('#host'),{getRecommendations:async()=>{throw Error('snapshot unavailable');}});});
 await mouse(page,'[data-aj-node]:not([hidden]) [data-aj-select]');
 await page.waitForFunction(()=>document.querySelector('.aj-recommendations [role=status]')?.textContent.includes('unavailable'));
 assert.equal(await page.locator('[data-aj-recommended-track]').count(),0);
 await page.evaluate(()=>{dispose();dispose=api.bindAchievementJournal(document.querySelector('#host'),{getRecommendations:async()=>null});});
 await mouse(page,'[data-aj-node]:not([hidden]) [data-aj-select]');
 await page.waitForFunction(()=>document.querySelector('.aj-recommendations [role=status]')?.textContent.includes('No matching tracks'));
 assert.equal(await page.locator('[data-aj-recommended-track]').count(),0);page.checkClean();
});


test('detached or replaced journal DOM cannot receive late recommendations',{timeout:15000},async t=>{
 const page=await fixture(t);await page.evaluate(()=>{dispose();window.resolveDetached=null;dispose=api.bindAchievementJournal(document.querySelector('#host'),{getRecommendations:()=>new Promise(resolve=>resolveDetached=resolve),onRecommendedTrack:id=>{throw Error('unexpected preview '+id);}});});
 await mouse(page,'[data-aj-node]:not([hidden]) [data-aj-select]');
 await page.evaluate(()=>{document.querySelector('#host').replaceChildren();resolveDetached([{trackId:'stale-dom',name:'STALE DOM'}]);});
 assert.equal(await page.locator('.aj-recommendations,[data-aj-recommended-track]').count(),0);page.checkClean();
});


test('missing casual completion count still exposes Style Coins and the first Shop-check tier under Next',{timeout:15000},async t=>{
 const page=await fixture(t,{progress:{confirmed:{raceCount:28},local:{casualCompletionCount:89}}});
 assert.equal(await page.locator('[data-aj-filter="next"]').getAttribute('aria-pressed'),'true');
 const currencyPath=page.locator('[data-aj-family="currency"]');assert.equal(await currencyPath.isVisible(),true);
 assert.equal(await currencyPath.getAttribute('data-aj-path-known'),'false');assert.equal(await currencyPath.getAttribute('data-aj-path-navigable'),'true');
 await mouse(page,'[data-aj-family="currency"]');
 const node=page.locator('[data-aj-node="currency:tracks-1"]');assert.equal(await node.isVisible(),true);
 assert.equal(await node.getAttribute('data-aj-known'),'false');assert.equal(await node.getAttribute('data-aj-navigable'),'true');assert.equal(await node.getAttribute('data-aj-earned'),'false');
 assert.equal(await node.locator('progress').getAttribute('value'),null);
 assert.equal(await node.locator('.aj-progress').innerText(),'Shop checks eligibility');
 assert.match(await node.innerText(),/20 Style Coins/);assert.doesNotMatch(await node.innerText(),/Not tracked|0 \/ 1/);
 assert.equal(await page.locator('[data-aj-family-id="currency"]:visible').count(),1,'Next shows exactly the first unknown check tier');
 assert.equal(await page.locator('.aj-lane-count:visible').innerText(),'Shop checks eligibility');
 await mouse(page,'[data-aj-select="currency:tracks-1"]');assert.match(await page.locator('[data-aj-detail]').innerText(),/Claim history is not supplied here/);
 assert.equal(await node.evaluate(el=>JSON.parse(el.dataset.ajSortItem).value),null);
 await page.screenshot({path:path.join(evidence,'achievement-style-coins-unknown-next.png'),timeout:5000});
 await mouse(page,'[data-aj-detail] [data-aj-navigate="shop"]');assert.deepEqual(await page.evaluate(()=>calls.navigation),['shop']);assert.deepEqual(await page.evaluate(()=>calls.rewards),[]);page.checkClean();
});
