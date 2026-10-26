import { pathToFileURL } from 'node:url';
const repositoryRoot = process.env.PRACTICE_UI_REPO ? pathToFileURL(process.env.PRACTICE_UI_REPO.replace(/\\/g, '/') + '/') : new URL('../', import.meta.url);
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(new URL('tools/verifier/package.json',repositoryRoot));
const {chromium}=require('playwright');

async function fixture(t){
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage({viewport:{width:1366,height:768}});
 const module=await fs.readFile(new URL('./practice-profile.mjs',import.meta.url),'utf8');
 const active=await fs.readFile(new URL('tools/active-time.mjs',repositoryRoot),'utf8');
 const history=await fs.readFile(new URL('tools/practice-history.mjs',repositoryRoot),'utf8');
 const patch=await fs.readFile(new URL('polytrack_062_patch.js',repositoryRoot),'utf8');
 const injected=[...patch.matchAll(/(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*("(?:\\.|[^"\\])*?")/g)].map(m=>JSON.parse(m[1])).join('\n');
 const css=injected+'\n'+await fs.readFile(new URL('home-ui.css',repositoryRoot),'utf8')+'\n'+await fs.readFile(new URL('../practice-responsive.css',import.meta.url),'utf8');
 const font=(await fs.readFile(new URL('forced_square.woff2',repositoryRoot))).toString('base64');
 await page.route('**/*',r=>r.fulfill({contentType:r.request().url().endsWith('.mjs')?'text/javascript':'text/html',body:r.request().url().endsWith('/practice-history.mjs')?history:r.request().url().endsWith('/practice.mjs')?module:r.request().url().endsWith('/active-time.mjs')?active:'<!doctype html><main id="overallProfilePopup"><article class="overall-profile-card"><div id="overallProfileContent"></div></article></main>'}));
 await page.goto('http://practice.test/');
 await page.addStyleTag({content:'@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,'+font+')}body{margin:0;background:#101b37;color:white;font-family:ForcedSquare}'+css+'\n#overallProfilePopup{display:block!important;position:static!important;padding:12px!important;box-sizing:border-box}#overallProfilePopup>.overall-profile-card{position:static!important;transform:none!important;width:100%!important;max-width:none!important;max-height:none!important;height:auto!important;box-sizing:border-box}'});
 await page.evaluate(async()=>{
  window.practice=await import('/practice.mjs');
  window.rows=['Alpha','Beta','Gamma','Delta'].map((name,i)=>({trackId:String(i),trackName:'Track '+name,activeMs:30000+i*10000,attempts:4+i,lastPlayedAt:Date.now()-i*1000,sincePbMs:30000,finishes:i%2?2:0,trackedBestMs:i%2?19000:0,observationVersion:i%2?1:0,movingMs:i%2?20000:0,pausedMs:i%2?10000:0}));
  window.results=[{trackId:'0',timeMs:21000,source:'snapshot'},{trackId:'1',timeMs:18000,source:'snapshot',rank:3,fieldSize:100},{trackId:'1',timeMs:17000,local:true}];
  window.renderPractice=state=>{
   document.querySelector('.polytrack-practice-profile')?.__ppDispose?.();
   document.querySelector('#overallProfileContent').innerHTML=practice.renderPracticeProfile({accountId:window.accountId||'fixture-a',rows,results,coverage:{coverageFraction:.05},trackPreview:()=>'<svg viewBox="0 0 80 50" aria-hidden="true"><path d="M0 25H80" stroke="cyan" stroke-width="10"/></svg>'});
   const root=document.querySelector('.polytrack-practice-profile');root.open=true;
   root.__ppDispose=practice.installPracticeProfileControls(root);practice.restorePracticeProfileView(root,state);
  };renderPractice();
 });await page.evaluate(()=>document.fonts.ready);return page;
}

test('mixed practice evidence produces aligned cards without hiding useful data',async t=>{
 const page=await fixture(t);
 for(const [width,height] of [[1920,1080],[1366,600],[820,1180],[390,844],[320,568],[844,320]]){
  await page.setViewportSize({width,height});
  const boxes=await page.locator('.pp-track').evaluateAll(items=>items.map(e=>{const r=e.getBoundingClientRect();return {top:r.top,height:r.height,overflow:e.scrollWidth>e.clientWidth+1};}));
  assert.equal(boxes.some(b=>b.overflow),false,'no card overflow at '+width);
  for(const a of boxes)for(const b of boxes)if(Math.abs(a.top-b.top)<1)assert.ok(Math.abs(a.height-b.height)<1,'same row has equal heights at '+width);
  assert.equal(await page.locator('[data-pp-track-id="2"] .pp-results').count(),0,'no invented PB panel');
  assert.equal(await page.locator('[data-pp-track-id="1"] .pp-card-details').getAttribute('open'),null);
  if(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR){await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR+'/practice-'+width+'x'+height+'.png',fullPage:true});}
 }
 await page.locator('[data-pp-track-id="1"] .pp-card-details > summary').focus();await page.keyboard.press('Enter');
 assert.equal(await page.locator('[data-pp-track-id="1"] .pp-extra-evidence').isVisible(),true);
 assert.match(await page.locator('[data-pp-track-id="1"] .pp-card-observations').innerText(),/Paused/);
 assert.match(await page.locator('[data-pp-track-id="0"] .pp-since-pb').innerText(),/without a tracked PB/);
});

test('sort and direction survive reopening and a new document, isolated by account', async t => {
 const page=await fixture(t);
 assert.equal(await page.locator('[data-pp-sort]').inputValue(),'active');
 await page.locator('[data-pp-sort]').selectOption('name');
 await page.locator('[data-pp-direction]').click();
 await page.locator('[data-pp-search]').fill('private query');
 await page.evaluate(()=>renderPractice());
 assert.equal(await page.locator('[data-pp-sort]').inputValue(),'name');
 assert.equal(await page.locator('[data-pp-direction]').getAttribute('data-pp-direction'),'asc');
 assert.equal(await page.locator('[data-pp-search]').inputValue(),'');
 await page.evaluate(()=>{window.accountId='fixture-b';renderPractice();});
 assert.equal(await page.locator('[data-pp-sort]').inputValue(),'active');
 assert.equal(await page.locator('[data-pp-direction]').getAttribute('data-pp-direction'),'desc');
 await page.evaluate(()=>{window.accountId='fixture-a';renderPractice();});
 const choice=await page.evaluate(()=>localStorage.getItem(practice.practiceProfileChoiceKey('fixture-a')));
 assert.deepEqual(JSON.parse(choice),{sort:'name',direction:'asc'});
 await page.reload();
 assert.deepEqual(await page.evaluate(async()=>{
  const p=await import('/practice.mjs');
  const root=document.querySelector('#overallProfileContent');root.innerHTML=p.renderPracticeProfile({accountId:'fixture-a',rows:[{trackId:'a',activeMs:1}]});
  p.installPracticeProfileControls(root.querySelector('.polytrack-practice-profile'));
  return [root.querySelector('[data-pp-sort]').value,root.querySelector('[data-pp-direction]').dataset.ppDirection];
 }),['name','asc']);
});

test('absent measurements fall back without overwriting the saved choice on refresh', async t => {
 const page=await fixture(t);
 await page.locator('[data-pp-sort]').selectOption('finishes');
 await page.locator('[data-pp-direction]').click();
 await page.evaluate(()=>{const state=practice.capturePracticeProfileView(document.querySelector('.polytrack-practice-profile'));window.originalRows=rows;rows=rows.map(r=>({...r,finishes:0}));renderPractice(state);});
 assert.equal(await page.locator('[data-pp-sort]').inputValue(),'active');
 assert.deepEqual(await page.evaluate(()=>practice.readPracticeProfileChoice('fixture-a')),{sort:'finishes',direction:'asc'});
 await page.evaluate(()=>{rows=originalRows;renderPractice();});
 assert.equal(await page.locator('[data-pp-sort]').inputValue(),'finishes');
});

test('account changes reject transient state and every toolbar control keeps a 44px target', async t => {
 const page=await fixture(t);
 await page.locator('[data-pp-search]').fill('Track');
 await page.locator('[data-pp-official]').click();
 await page.evaluate(()=>{const state=practice.capturePracticeProfileView(document.querySelector('.polytrack-practice-profile'));window.accountId='fixture-b';renderPractice(state);});
 assert.equal(await page.locator('[data-pp-search]').inputValue(),'');
 assert.equal(await page.locator('[data-pp-official]').getAttribute('aria-pressed'),'false');
 for(const [width,height] of [[1920,1080],[1366,600],[1024,768],[820,1180],[390,844],[320,568],[844,320]]){
  await page.setViewportSize({width,height});
  const boxes=await page.locator('.pp-toolbar input,.pp-toolbar select,.pp-toolbar button').evaluateAll(nodes=>nodes.map(node=>{
   const r=node.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,right:r.right,bottom:r.bottom};
  }));
  for(const box of boxes){assert.ok(box.w>=44&&box.h>=44,`44px target at ${width}: ${JSON.stringify(box)}`);assert.ok(box.x>=0&&box.right<=width,`fits ${width}`);}
  for(let i=0;i<boxes.length;i++)for(let j=i+1;j<boxes.length;j++){
   const a=boxes[i],b=boxes[j];assert.ok(Math.min(a.right,b.right)-Math.max(a.x,b.x)<=1||Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)<=1,`no overlap ${width}`);
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(width===1366){const search=boxes[0];assert.ok(search.w<=200);assert.ok(boxes.every(b=>Math.abs(b.y-search.y)<1),'inline desktop controls');}
 }
});

test('denied storage still permits controls, disposal and refresh focus', async t => {
 const page=await fixture(t);
 await page.evaluate(()=>{Object.defineProperty(window,'localStorage',{configurable:true,get(){throw Error('disabled');}});renderPractice();});
 await page.locator('[data-pp-sort]').selectOption('name');
 await page.locator('[data-pp-direction]').click();
 await page.locator('[data-pp-finished]').click();
 await page.locator('[data-pp-finished]').focus();
 await page.evaluate(()=>renderPractice(practice.capturePracticeProfileView(document.querySelector('.polytrack-practice-profile'))));
 assert.equal(await page.locator('[data-pp-finished]').evaluate(e=>e===document.activeElement&&e.getAttribute('aria-pressed')==='true'),true);
 assert.equal(await page.locator('[data-pp-sort]').inputValue(),'name');
 assert.equal(await page.locator('[data-pp-direction]').getAttribute('data-pp-direction'),'asc');
});

test('practice refresh retains direction, view, disclosures, focus and text selection',async t=>{
 const page=await fixture(t);
 await page.locator('[data-pp-sort]').selectOption('active');await page.locator('[data-pp-direction]').click();
 await page.locator('[data-pp-view="list"]').click();
 await page.locator('.pp-coverage-details > summary').click();
 await page.locator('[data-pp-track-id="1"] .pp-card-details > summary').click();
 await page.locator('[data-pp-search]').fill('Track');
 await page.locator('[data-pp-search]').evaluate(e=>{e.focus();e.setSelectionRange(1,3);});
 await page.evaluate(()=>renderPractice(practice.capturePracticeProfileView(document.querySelector('.polytrack-practice-profile'))));
 assert.equal(await page.locator('[data-pp-direction]').getAttribute('data-pp-direction'),'asc');
 assert.match(await page.locator('[data-pp-direction]').getAttribute('aria-label'),/Active race time, ascending/);
 assert.equal(await page.locator('[data-pp-view="list"]').getAttribute('aria-pressed'),'true');
 assert.equal(await page.locator('.pp-coverage-details').evaluate(e=>e.open),true);
 assert.equal(await page.locator('[data-pp-track-id="1"] .pp-card-details').evaluate(e=>e.open),true);
 assert.deepEqual(await page.locator('[data-pp-search]').evaluate(e=>[e===document.activeElement,e.value,e.selectionStart,e.selectionEnd]),[true,'Track',1,3]);
 await page.locator('[data-pp-track-id="1"] .pp-card-details > summary').focus();
 await page.evaluate(()=>renderPractice(practice.capturePracticeProfileView(document.querySelector('.polytrack-practice-profile'))));
 assert.equal(await page.locator('[data-pp-track-id="1"] .pp-card-details > summary').evaluate(e=>e===document.activeElement),true);
 await page.locator('[data-pp-sort]').selectOption('finishes');
 await page.evaluate(()=>{const state=practice.capturePracticeProfileView(document.querySelector('.polytrack-practice-profile'));rows=rows.map(r=>({...r,finishes:0}));renderPractice(state);});
 assert.equal(await page.locator('[data-pp-sort]').inputValue(),'active','removed measurements select a valid fallback');
});

test('official and finished filters combine and survive refresh without overlapping view controls',async t=>{
 const page=await fixture(t);
 await page.evaluate(()=>{rows=rows.map((r,i)=>({...r,type:i<2?'official':'custom',biggestObservedImprovementMs:(i+1)*100,biggestPbImprovementMs:(4-i)*100}));renderPractice();});
 const ids=()=>page.locator('.pp-track:not([hidden])').evaluateAll(items=>items.map(e=>e.dataset.ppTrackId));
 await page.locator('[data-pp-sort]').selectOption('observed-gain');assert.deepEqual(await ids(),['3','2','1','0']);
 await page.locator('[data-pp-direction]').click();assert.deepEqual(await ids(),['0','1','2','3']);
 await page.locator('[data-pp-sort]').selectOption('driven-gain');assert.deepEqual(await ids(),['3','2','1','0']);
 await page.locator('[data-pp-official]').click();assert.deepEqual(await ids(),['1','0']);
 await page.locator('[data-pp-finished]').click();assert.deepEqual(await ids(),['1','0']);
 await page.evaluate(()=>renderPractice(practice.capturePracticeProfileView(document.querySelector('.polytrack-practice-profile'))));
 assert.deepEqual(await ids(),['1','0']);
 for(const [width,height] of [[320,568],[440,650],[1366,600],[844,320]]){
  await page.setViewportSize({width,height});
  await page.locator('[data-pp-view="list"]').click();await page.locator('[data-pp-view="grid"]').click();
  assert.equal(await page.locator('[data-pp-official]').getAttribute('aria-pressed'),'true');
 }
});
