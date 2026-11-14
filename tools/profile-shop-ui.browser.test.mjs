import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {PROFILE_SHOP_CATALOG,PROFILE_SHOP_CATALOG_VERSION} from './profile-shop-catalog.mjs';
import {PROFILE_SHOP_EXPANDED_DESIGNS} from './profile-shop-expanded-designs.mjs';
// Offline projection of Franklin's staged additions; never writes the live catalog.
const SHOP_CATALOG=[...PROFILE_SHOP_CATALOG,...PROFILE_SHOP_EXPANDED_DESIGNS.filter(design=>!PROFILE_SHOP_CATALOG.some(item=>item.id===design.itemId)).map(design=>({id:design.itemId,label:design.label,price:design.price,kind:'profile-cosmetic',grants:[{slot:design.slot,value:design.value}]}))];
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const evidence=process.env.SHOP_EVIDENCE_DIR||path.resolve(root,'../../2026-11-13/late-update/shop-preview');
let server,browser,base;
before(async()=>{
  server=http.createServer(async(req,res)=>{
    const name=new URL(req.url,'http://localhost').pathname;
    if(name==='/tools/profile-shop-catalog.mjs'){res.setHeader('Content-Type','text/javascript');res.end('export const PROFILE_SHOP_CATALOG_VERSION='+PROFILE_SHOP_CATALOG_VERSION+';export const PROFILE_SHOP_CATALOG='+JSON.stringify(SHOP_CATALOG)+';');return;}
    if(name==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local PolyTrack shop draft</title><link rel="stylesheet" href="/tools/profile-shop-ui.css"><style>@font-face{font-family:ForcedSquare;src:url(/forced_square.woff2)}body{margin:0;background:#192b57}main{max-width:1366px;margin:auto;--sp-sticky-top:60px}.fixture-banner{position:sticky;top:0;z-index:99;box-sizing:border-box;height:60px;display:flex;align-items:center;padding:12px;background:#ffd185;color:#142449;font:13px/18px Trebuchet MS,sans-serif;border-bottom:2px solid #b98b39}</style><aside class="fixture-banner" role="note">Offline test preview &middot; Sample credits, not a live balance</aside><main></main></html>');return;}
    const types={'/tools/shop-preview.css':'text/css','/tools/profile-shop-expanded-designs.mjs':'text/javascript','/tools/profile-shop-ui.mjs':'text/javascript','/tools/profile-shop-ui.css':'text/css','/tools/profile-shop-art.mjs':'text/javascript','/tools/profile-shop-catalog.mjs':'text/javascript','/forced_square.woff2':'font/woff2'};
    if(!types[name]){res.writeHead(404).end();return;}
    try{res.setHeader('Content-Type',types[name]);res.end(await fs.readFile(path.join(root,name.slice(1))));}catch{res.writeHead(404).end();}
  });
  server.keepAliveTimeout=500;await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});await fs.mkdir(evidence,{recursive:true});
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));});
async function fixture(t,extra={},viewport={width:1366,height:768}){
  const context=await browser.newContext({viewport}),page=await context.newPage();t.after(()=>context.close());
  await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort());await page.goto(base);assert.equal(await page.locator('.fixture-banner').innerText(),'Offline test preview \u00b7 Sample credits, not a live balance');
  await page.evaluate(async({catalog,extra})=>{
    const {mountProfileShopUi}=await import('/tools/profile-shop-ui.mjs');window.calls={buy:[],claim:[],apply:[],preview:[],restore:0,refresh:0,studio:0};
    window.options={accountId:'driver-a',catalog,wallet:{status:'confirmed',accountId:'driver-a',balance:100,revision:2},inventory:{status:'confirmed',accountId:'driver-a',ownedIds:[]},purchaseEnabled:true,claimsEnabled:true,...extra,
      actions:{onPurchase:value=>{calls.buy.push(value);return new Promise((resolve,reject)=>{window.resolveBuy=resolve;window.rejectBuy=reject;});},onPreview:value=>calls.preview.push(value.id),onRestorePreview:()=>calls.restore++,onRefresh:()=>calls.refresh++,onClaim:value=>{calls.claim.push(value);return new Promise((resolve,reject)=>{window.resolveClaim=resolve;window.rejectClaim=reject;});},onApply:value=>{calls.apply.push({...value,isCurrent:value.isCurrent()});return {applied:true,draftOnly:true,accountId:value.accountId,itemId:value.itemId};},onStudio:()=>calls.studio++}};
    window.cleanup=mountProfileShopUi(document.querySelector('main'),options);await document.fonts.ready;
  },{catalog:SHOP_CATALOG,extra});return page;
}

test('all canonical and staged styles render with Tokens, categories and no overflow on phone/laptop',async t=>{
 assert.ok(SHOP_CATALOG.length>=9);
 for(const [name,width,height]of[['laptop',1366,768],['phone',360,800]]){
  const page=await fixture(t,{}, {width,height});assert.equal(await page.locator('.sp-item').count(),SHOP_CATALOG.length);assert.equal(await page.locator('.sp-art svg').count(),SHOP_CATALOG.length);
  assert.doesNotMatch(await page.locator('.shop-preview').innerText(),/\bCP\b|Three original|undefined/);
  assert.ok(await page.locator('.sp-art svg').evaluateAll(nodes=>nodes.every(node=>node.getAttribute('preserveAspectRatio')==='xMidYMid meet')));
  assert.equal(await page.locator('[data-sp-category],.sp-palette').count(),0);assert.doesNotMatch(await page.locator('.shop-preview').innerText(),/Car presets|native parts|saved style preset/);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.equal(await page.evaluate(()=>calls.buy.length+calls.claim.length+calls.refresh+calls.apply.length),0);
  await page.screenshot({path:path.join(evidence,'studio-style-shop-'+name+'.png'),fullPage:true});
  await page.locator('[data-sp-action="preview"]').last().click();const warning=await page.locator('.sp-status').boundingBox();assert.ok(warning.y>=60&&warning.y+warning.height<=height);
  await page.screenshot({path:path.join(evidence,'studio-style-shop-warning-'+name+'.png')});
  await page.getByRole('button',{name:'Exit preview'}).click();assert.equal(await page.evaluate(()=>calls.restore),1);
 }
});
test('points are comma formatted; only confirmed same-account wallet data is shown',async t=>{
 const page=await fixture(t,{wallet:{status:'confirmed',accountId:'driver-a',balance:12345,revision:2},catalog:SHOP_CATALOG.map((item,index)=>index?item:{...item,price:1234})});
 assert.equal(await page.locator('.sp-summary strong').innerText(),'12,345 Tokens');assert.equal(await page.getByRole('button',{name:'Buy for 1,234 Tokens'}).count(),0);assert.equal(await page.locator('.sp-item').count(),SHOP_CATALOG.length-1);
 await page.evaluate(()=>cleanup.update({wallet:{status:'pending',accountId:'driver-a',balance:99999,revision:3}}));assert.equal(await page.locator('.sp-summary strong').innerText(),'Not available');
 await page.evaluate(()=>cleanup.update({wallet:{status:'confirmed',accountId:'other',balance:99999,revision:3}}));assert.equal(await page.locator('.sp-summary strong').innerText(),'Not available');
 assert.equal(await page.locator('[data-sp-action="claim"]:enabled,[data-sp-action="buy"]:enabled').count(),0);
});
test('purchase requires confirmation, cancel restores focus, and pending never double submits or deducts',async t=>{
 const page=await fixture(t,{}, {width:360,height:800});const buy=()=>page.locator('[data-sp-action="buy"][data-sp-id="profile-pitlane-ticket"]');
 await buy().click();assert.equal(await page.evaluate(()=>calls.buy.length),0);await page.keyboard.press('Escape');assert.equal(await buy().evaluate(node=>node===document.activeElement),true);
 await buy().click();const bounds=await page.locator('.sp-confirm').boundingBox();assert.ok(bounds.y>=60&&bounds.y+bounds.height<=800);
 await page.screenshot({path:path.join(evidence,'studio-style-shop-confirm-phone.png')});await page.getByRole('button',{name:'Confirm purchase'}).click();assert.equal(await page.evaluate(()=>calls.buy.length),1);
 assert.equal(await page.locator('.sp-summary strong').innerText(),'100 Tokens');assert.equal(await page.locator('[data-sp-action="buy"]:enabled,[data-sp-action="claim"]:enabled').count(),0);
 await page.evaluate(()=>resolveBuy({status:'pending'}));assert.equal(await page.locator('.sp-summary strong').innerText(),'100 Tokens');
});
test('daily 8 Tokens and milestone claims are explicit; pending/error never invent points',async t=>{
 const page=await fixture(t);assert.equal(await page.evaluate(()=>calls.claim.length),0);assert.match(await page.locator('.sp-earn').innerText(),/1 track \+20 Tokens.*5 tracks \+30 Tokens.*20 tracks \+50 Tokens/);
 await page.getByRole('button',{name:'Daily visit Claim 8 Tokens',exact:true}).click();assert.equal(await page.evaluate(()=>calls.claim[0].rewardId),'login');
 assert.equal(await page.locator('.sp-summary strong').innerText(),'100 Tokens');assert.equal(await page.locator('[data-sp-action="claim"]:enabled').count(),0);
 await page.evaluate(()=>resolveClaim({confirmed:true,accountId:'driver-a',rewardId:'login',wallet:{status:'confirmed',accountId:'driver-a',balance:108,revision:3}}));await page.waitForFunction(()=>document.querySelector('.sp-summary strong').textContent==='108 Tokens');
 await page.getByRole('button',{name:'1 / 5 / 20 ranked tracks Claim milestones',exact:true}).click();assert.equal(await page.evaluate(()=>calls.claim[1].rewardId),'milestones');
 await page.evaluate(()=>rejectClaim(Error('not confirmed')));await page.waitForFunction(()=>document.querySelector('.sp-status').textContent.includes('Could not confirm'));assert.equal(await page.locator('.sp-summary strong').innerText(),'108 Tokens');
});
test('Apply requires confirmed ownership and invokes draft-only callback, never purchase or publication',async t=>{
 const page=await fixture(t);assert.equal(await page.locator('[data-sp-action="apply"]').count(),0);
 await page.evaluate(()=>cleanup.update({inventory:{status:'confirmed',accountId:'other',ownedIds:['profile-pitlane-ticket']}}));assert.equal(await page.locator('[data-sp-action="apply"]').count(),0);
 await page.evaluate(()=>cleanup.update({inventory:{status:'confirmed',accountId:'driver-a',ownedIds:['profile-pitlane-ticket']}}));await page.getByRole('button',{name:'Apply to draft'}).click();
 await page.waitForFunction(()=>document.querySelector('.sp-status').textContent.includes('Added to your Studio draft'));
 const calls=await page.evaluate(()=>window.calls);assert.equal(calls.apply.length,1);assert.equal(calls.apply[0].draftOnly,true);assert.equal(calls.apply[0].isCurrent,true);assert.equal(calls.buy.length,0);
});
test('closed gates, legacy car catalogs, unsafe labels and late cross-account results fail safely',async t=>{
 const page=await fixture(t,{purchaseEnabled:false,claimsEnabled:false});assert.equal(await page.locator('[data-sp-action="claim"]:enabled,[data-sp-action="buy"]:enabled').count(),0);
 await page.evaluate(()=>cleanup.update({catalog:{version:1,items:[{id:'mint-rally',label:'stock',price:20}]}}));assert.equal(await page.locator('.sp-item').count(),0);
 await page.evaluate(async()=>{const {PROFILE_SHOP_CATALOG}=await import('/tools/profile-shop-catalog.mjs');cleanup.update({catalog:PROFILE_SHOP_CATALOG.map((item,index)=>index?item:{...item,label:'<img src=x onerror=alert(1)>'}),purchaseEnabled:true});});assert.equal(await page.locator('img').count(),0);
 await page.locator('[data-sp-action="buy"][data-sp-id="profile-pitlane-ticket"]').click();await page.getByRole('button',{name:'Confirm purchase'}).click();
 await page.evaluate(()=>{cleanup.update({accountId:'driver-b',wallet:{status:'confirmed',accountId:'driver-b',balance:7,revision:1},inventory:{status:'confirmed',accountId:'driver-b',ownedIds:[]}});resolveBuy({confirmed:true,accountId:'driver-a',itemId:'profile-pitlane-ticket',wallet:{status:'confirmed',accountId:'driver-a',balance:80,revision:3}});});assert.equal(await page.locator('.sp-summary strong').innerText(),'7 Tokens');
 const source=await fs.readFile(new URL('./profile-shop-ui.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/fetch\(|XMLHttpRequest|firebase|localStorage|sessionStorage|indexedDB/);
 await page.evaluate(()=>cleanup());assert.equal(await page.locator('.shop-preview').count(),0);
});
