import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
test('real updater menu supports keyboard, explicit dismissals, Help and critical guards',async()=>{
 const browser=await chromium.launch({headless:true});try{
 const page=await browser.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>{
 const url=new URL(route.request().url());const name=url.pathname.slice(1);
 if(url.origin!=='https://updates.test')return route.abort();
 if(['site-updates.mjs','release-history.mjs','site-update-dismissal.mjs'].includes(name))return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(new URL('./'+name,import.meta.url),'utf8')});
 if(name===''||name==='index.html')return route.fulfill({contentType:'text/html',body:'<button id="outside">Outside</button>'});
 return route.abort();
 });
 const boot=async()=>{
 await page.goto('https://updates.test/');await page.evaluate(async()=>{
 const mod=await import('/site-updates.mjs');window.mod=mod;window.racing=false;window.manifest={revision:2};
 window.updates=mod.installSiteUpdates({revision:1,document,endpoint:'site-version.json',fetch:async()=>({ok:true,json:async()=>window.manifest}),isIdle:()=>!window.racing,canReload:()=>false,setTimeout:()=>1,clearTimeout:()=>{}});await updates.check();
 });};
 await boot();const badge=page.locator('[data-site-update="available"]');
 await badge.click({button:'right'});assert.equal(await page.getByRole('menuitem').count(),2);
 await page.keyboard.press('Escape');assert.equal(await page.getByRole('menu').count(),0);assert.equal(await badge.evaluate(el=>el===document.activeElement),true);
 await page.keyboard.press('Shift+F10');await page.keyboard.press('ArrowDown');assert.equal(await page.locator(':focus').textContent(),'Remind me after 3 visits');
 await page.locator('#outside').focus();assert.equal(await page.getByRole('menu').count(),0);
 await badge.click();assert.match(await badge.textContent(),/leave the current run/);
 for(let i=0;i<3;i++){
 if(i)await boot();await badge.click({button:'right'});assert.equal(await page.getByRole('menuitem').count(),2);
 await page.getByRole('menuitem',{name:'Hide for current session',exact:true}).click();assert.equal(await badge.isVisible(),false);
 await page.evaluate(()=>{updates.resume();dispatchEvent(new Event('pageshow'));});assert.equal(await badge.isVisible(),false);
 }
 await boot();await badge.click({button:'right'});assert.equal(await page.getByRole('menuitem').count(),3);
 await page.getByRole('menuitem',{name:'Turn off update reminders',exact:true}).click();await boot();assert.equal(await badge.count(),0);
 await page.evaluate(()=>mod.requestSiteUpdateCheck(document));assert.equal(await badge.isVisible(),true);
 await page.evaluate(()=>{racing=true;updates.resume();});assert.equal(await badge.isVisible(),false);
 await page.evaluate(()=>{racing=false;manifest={revision:3,minimumSupportedRevision:2};return updates.check({force:true});});
 assert.equal(await page.locator('[data-site-compatibility="unsupported"]').isVisible(),true);assert.equal(await page.evaluate(()=>updates.getCompatibility().onlineAllowed),false);
 await page.evaluate(()=>updates.dispose());assert.equal(await page.getByRole('menu').count(),0);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
