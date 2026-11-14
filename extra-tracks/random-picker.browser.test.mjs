import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let chromium;
try {({chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright'));} catch {}
const skip=!chromium && 'Pinned Playwright unavailable';
const modules=new Map(['catalog-ui.mjs','random-picker.mjs','review.mjs','reviewed.mjs','reviewed-data.mjs','snapshot-popularity.mjs','featured-picks.mjs'].map(name=>[name,fs.readFileSync(new URL(name,import.meta.url),'utf8')]));
modules.set('tools/search-text.mjs',fs.readFileSync(new URL('../tools/search-text.mjs',import.meta.url),'utf8'));
const css='@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,'+fs.readFileSync(new URL('../forced_square.woff2',import.meta.url)).toString('base64')+')}'+fs.readFileSync(new URL('catalog.css',import.meta.url),'utf8');
async function setup(browser, viewport, options={}) {
 const page=await browser.newPage({viewport}); const requests=[];
 await page.route('**/*',route=>{
  const url=new URL(route.request().url()); requests.push(url.pathname);
  if(modules.has(url.pathname.slice(1)))return route.fulfill({contentType:'text/javascript',body:modules.get(url.pathname.slice(1))});
  if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><button id="launch">Tracks</button><main id="root"></main>'});
  return route.abort();
 });
 await page.goto('http://picker.test/'); await page.addStyleTag({content:css});
 await page.evaluate(async options=>{
  const {mountExtraTracks}=await import('/catalog-ui.mjs');
  window.selected=[]; window.driveCalls=0; window.historyReads=0;
  if(options.blockStorage)Object.defineProperty(window,'localStorage',{get(){throw Error('blocked');}});
  const entries=Array.from({length:40},(_,i)=>({id:'track-'+i,name:'Track '+i,author:'Tester',tags:[],difficulty:i===39?9:2,source:'Local',trackId:String(i).padStart(64,'0')}));
  window.catalog=mountExtraTracks({document,root:document.querySelector('#root'),entries,onSelect:options.noPreview?undefined:entry=>{window.selected.push(entry.id);if(window.previewFails)throw Error('failed');},onPlay:()=>window.driveCalls++,onSave:()=>window.driveCalls++,getPersonalBest:()=>{window.historyReads++;return null;},isLoaded:()=>false});
  document.querySelector('#launch').focus();window.catalog.open();
 },options);
 return {page,requests};
}
test('desktop picker traps focus, restores focus, saves filters and contextmenu opens preview without track network', {skip}, async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const {page,requests}=await setup(browser,{width:1280,height:900});
  const choose=page.getByRole('button',{name:'Choose random track',exact:true});
  await choose.click(); const modal=page.getByRole('dialog',{name:'Choose random track',exact:true});
  assert.equal(await modal.isVisible(),true);
  assert.equal(await page.evaluate(()=>window.selected.length),0);
  const pool=modal.getByLabel('Track pool'); assert.equal(await pool.evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Shift+Tab'); assert.equal(await modal.getByRole('button',{name:'Reset picker options'}).evaluate(el=>el===document.activeElement),true);
  await page.keyboard.press('Tab'); assert.equal(await pool.evaluate(el=>el===document.activeElement),true);
  await modal.locator('summary').click(); await modal.getByLabel('Catalog difficulty level',{exact:true}).selectOption('9');
  assert.match(await modal.locator('[role=status]').textContent(),/1 matching track/);
  if(process.env.PICKER_SCREENSHOT_DIR)await page.screenshot({path:process.env.PICKER_SCREENSHOT_DIR+'/picker-desktop.png'});
  await page.keyboard.press('Escape'); assert.equal(await modal.isHidden(),true); assert.equal(await choose.evaluate(el=>el===document.activeElement),true);
  const before=requests.length; const reads=await page.evaluate(()=>window.historyReads);
  await choose.click({button:'right'});
  assert.deepEqual(await page.evaluate(()=>window.selected),['track-39']); assert.equal(await page.evaluate(()=>window.driveCalls),0);
  assert.equal(requests.length,before,'picking performs no network requests'); assert.equal(await page.evaluate(()=>window.historyReads),reads,'picking reuses cached records');
  await page.evaluate(()=>window.catalog.open()); await page.getByRole('button',{name:'Quick pick',exact:true}).click();
  assert.deepEqual(await page.evaluate(()=>window.selected),['track-39','track-39']);
 } finally {await browser.close();}
});
test('phone and short landscape have touch-sized controls, no overflow and recover from empty matches or failed preview', {skip}, async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const {page}=await setup(browser,{width:320,height:640},{blockStorage:true});
  await page.getByRole('button',{name:'Choose random track',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'Choose random track',exact:true}); await modal.locator('summary').click();
  await modal.getByLabel('Catalog difficulty level',{exact:true}).selectOption('10');
  assert.match(await modal.locator('[role=status]').textContent(),/No tracks match/);
  assert.equal(await modal.getByRole('button',{name:'Open random preview'}).isDisabled(),true);
  await modal.getByRole('button',{name:'Reset picker options'}).click();
  await modal.getByLabel('Catalog difficulty level',{exact:true}).selectOption('9');
  await modal.getByRole('button',{name:'Back',exact:true}).click();
  await page.evaluate(()=>window.previewFails=true); await page.getByRole('button',{name:'Quick pick',exact:true}).click();
  assert.equal(await modal.isVisible(),true); assert.match(await modal.locator('[role=status]').textContent(),/could not open/);
  assert.equal(await modal.getByRole('button',{name:'Open random preview'}).isEnabled(),true);
  assert.deepEqual(await page.evaluate(()=>window.selected),['track-39'],'blocked storage preserves in-memory filters');
  if(process.env.PICKER_SCREENSHOT_DIR)await page.screenshot({path:process.env.PICKER_SCREENSHOT_DIR+'/picker-phone.png'});
  for(const viewport of [{width:320,height:640},{width:844,height:390}]) {
   await page.setViewportSize(viewport);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
   const panel=await modal.locator('.sq-extra-picker').boundingBox(); assert.ok(panel.x>=0 && panel.y>=0 && panel.width<=viewport.width && panel.height<=viewport.height);
   for(const button of await modal.getByRole('button').all())assert.ok((await button.boundingBox()).height>=44);
   await modal.getByRole('button',{name:'Back',exact:true}).scrollIntoViewIfNeeded();
  }
  await page.evaluate(()=>window.previewFails=false); await modal.getByRole('button',{name:'Open random preview'}).click();
  assert.equal(await modal.isHidden(),true); assert.equal(await page.evaluate(()=>window.driveCalls),0);
 } finally {await browser.close();}
});
test('missing preview hook fails closed with an explicit parent integration message', {skip}, async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const {page}=await setup(browser,{width:390,height:844},{noPreview:true});
  await page.getByRole('button',{name:'Quick pick',exact:true}).click();
  const modal=page.getByRole('dialog',{name:'Choose random track',exact:true});
  assert.match(await modal.locator('[role=status]').textContent(),/parent must connect onSelect/);
  assert.equal(await modal.getByRole('button',{name:'Open random preview'}).isDisabled(),true);
  assert.equal(await page.evaluate(()=>window.driveCalls),0);
 } finally {await browser.close();}
});
