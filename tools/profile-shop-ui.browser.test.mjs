import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {PROFILE_SHOP_CATALOG,PROFILE_SHOP_CATALOG_VERSION} from './profile-shop-catalog.mjs';
import {WORKSHOP_STICKER_SHOP_CATALOG} from './workshop-sticker-shop-catalog.mjs';
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
    const types={'/tools/workshop-sticker-shop-catalog.mjs':'text/javascript','/tools/car-cosmetics-geometry.mjs':'text/javascript','/tools/profile-shop-art.css':'text/css','/tools/achievement-coin-schedule.mjs':'text/javascript','/tools/shop-preview.css':'text/css','/tools/profile-shop-expanded-designs.mjs':'text/javascript','/tools/profile-shop-ui.mjs':'text/javascript','/tools/profile-shop-ui.css':'text/css','/tools/profile-shop-art.mjs':'text/javascript','/tools/profile-shop-catalog.mjs':'text/javascript','/forced_square.woff2':'font/woff2'};
    if(!types[name]){res.writeHead(404).end();return;}
    try{res.setHeader('Content-Type',types[name]);res.end(await fs.readFile(path.join(root,name.slice(1))));}catch{res.writeHead(404).end();}
  });
  server.keepAliveTimeout=500;await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});await fs.mkdir(evidence,{recursive:true});
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));});
async function fixture(t,extra={},viewport={width:1366,height:768}){
  const context=await browser.newContext({viewport}),page=await context.newPage();t.after(()=>context.close());
  await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort());await page.goto(base,{waitUntil:'domcontentloaded'});assert.equal(await page.locator('.fixture-banner').innerText(),'Offline test preview \u00b7 Sample credits, not a live balance');
  await page.evaluate(async({catalog,extra})=>{
    const {mountProfileShopUi}=await import('/tools/profile-shop-ui.mjs');window.calls={buy:[],claim:[],apply:[],preview:[],restore:0,refresh:0,studio:0};
    window.options={accountId:'driver-a',cloudSaveConnected:true,catalog,wallet:{status:'confirmed',accountId:'driver-a',balance:100,revision:2},inventory:{status:'confirmed',accountId:'driver-a',ownedIds:[]},purchaseEnabled:true,claimsEnabled:true,...extra,
      actions:{onPurchase:value=>{calls.buy.push(value);return new Promise((resolve,reject)=>{window.resolveBuy=resolve;window.rejectBuy=reject;});},onPreview:value=>calls.preview.push(value.id),onRestorePreview:()=>calls.restore++,onRefresh:()=>calls.refresh++,onClaim:value=>{calls.claim.push(value);return new Promise((resolve,reject)=>{window.resolveClaim=resolve;window.rejectClaim=reject;});},onApply:value=>{calls.apply.push({...value,isCurrent:value.isCurrent()});return {applied:true,draftOnly:true,accountId:value.accountId,itemId:value.itemId};},onStudio:()=>calls.studio++}};
    window.cleanup=mountProfileShopUi(document.querySelector('main'),options);await document.fonts.ready;
  },{catalog:SHOP_CATALOG,extra});return page;
}

test('all canonical and staged styles render with Style Coins, categories and no overflow on phone/laptop',async t=>{
 assert.ok(SHOP_CATALOG.length>=9);
 for(const [name,width,height]of[['laptop',1366,768],['phone',360,800]]){
  const page=await fixture(t,{}, {width,height});assert.equal(await page.locator('.sp-item').count(),SHOP_CATALOG.length);assert.equal(await page.locator('[data-sp-cosmetic-sample]').count(),SHOP_CATALOG.length);
  assert.doesNotMatch(await page.locator('.shop-preview').innerText(),/\bCP\b|Three original|undefined/);
  assert.ok(await page.locator('.sp-style-sample').evaluateAll(nodes=>nodes.every(node=>node.getBoundingClientRect().width>0)));
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
 assert.equal(await page.locator('.sp-summary strong').innerText(),'12,345 Style Coins');assert.equal(await page.getByRole('button',{name:'Buy for 1,234 Style Coins'}).count(),0);assert.equal(await page.locator('.sp-item').count(),SHOP_CATALOG.length-1);
 await page.evaluate(()=>cleanup.update({wallet:{status:'pending',accountId:'driver-a',balance:99999,revision:3}}));assert.equal(await page.locator('.sp-summary strong').innerText(),'Not available');
 await page.evaluate(()=>cleanup.update({wallet:{status:'confirmed',accountId:'other',balance:99999,revision:3}}));assert.equal(await page.locator('.sp-summary strong').innerText(),'Not available');
 assert.equal(await page.locator('[data-sp-action="claim"]:enabled,[data-sp-action="buy"]:enabled').count(),0);
});
test('purchase requires confirmation, cancel restores focus, and pending never double submits or deducts',async t=>{
 const page=await fixture(t,{}, {width:360,height:800});const buy=()=>page.locator('[data-sp-action="buy"][data-sp-id="profile-pitlane-ticket"]');
 await buy().click();assert.equal(await page.evaluate(()=>calls.buy.length),0);await page.keyboard.press('Escape');assert.equal(await buy().evaluate(node=>node===document.activeElement),true);
 await buy().click();const bounds=await page.locator('.sp-confirm').boundingBox();assert.ok(bounds.y>=60&&bounds.y+bounds.height<=800);
 await page.screenshot({path:path.join(evidence,'studio-style-shop-confirm-phone.png')});await page.getByRole('button',{name:'Confirm purchase'}).click();assert.equal(await page.evaluate(()=>calls.buy.length),1);
 assert.equal(await page.locator('.sp-summary strong').innerText(),'100 Style Coins');assert.equal(await page.locator('[data-sp-action="buy"]:enabled,[data-sp-action="claim"]:enabled').count(),0);
 await page.evaluate(()=>resolveBuy({status:'pending'}));assert.equal(await page.locator('.sp-summary strong').innerText(),'100 Style Coins');
});
test('balance and reward chores are absent; opening synchronization text does not invent money',async t=>{
 const page=await fixture(t);assert.equal(await page.locator('[data-sp-action="claim"],[data-sp-action="refresh"]').count(),0);
 assert.match(await page.locator('.sp-earn').innerText(),/synchronize automatically.*server checks/is);
 assert.equal(await page.evaluate(()=>calls.claim.length+calls.refresh),0);
 await page.evaluate(()=>cleanup.update({wallet:{status:'unknown'},loading:true}));
 assert.equal(await page.locator('.sp-summary strong').innerText(),'Synchronizing...');
 await page.evaluate(()=>cleanup.update({loading:false,cloudSaveConnected:false,communityCodeState:{saved:true,formatValid:true}}));
 assert.match(await page.locator('.sp-status').innerText(),/Connect Cloud Save/);
 assert.match(await page.locator('[data-sp-community-local]').innerText(),/valid local format.*Cloud Save is separate.*Membership is not verified/);
 await page.evaluate(()=>cleanup.update({cloudSaveConnected:true}));assert.doesNotMatch(await page.locator('.sp-status').innerText(),/Connect Cloud Save|Sign in/i);
 await page.evaluate(()=>cleanup.update({error:'profile_not_owned'}));assert.match(await page.locator('.sp-status').innerText(),/first ranked run.*owning Cloud Save/);
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
 await page.evaluate(()=>{cleanup.update({accountId:'driver-b',wallet:{status:'confirmed',accountId:'driver-b',balance:7,revision:1},inventory:{status:'confirmed',accountId:'driver-b',ownedIds:[]}});resolveBuy({confirmed:true,accountId:'driver-a',itemId:'profile-pitlane-ticket',wallet:{status:'confirmed',accountId:'driver-a',balance:80,revision:3}});});assert.equal(await page.locator('.sp-summary strong').innerText(),'7 Style Coins');
 const source=await fs.readFile(new URL('./profile-shop-ui.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/fetch\(|XMLHttpRequest|firebase|localStorage|sessionStorage|indexedDB/);
 await page.evaluate(()=>cleanup());assert.equal(await page.locator('.shop-preview').count(),0);
});

test('faithful samples use existing cosmetic classes and detached renderer snapshots only',async t=>{
 const page=await fixture(t);assert.equal(await page.locator('[data-profile-art-sample]').count(),0);
 assert.equal(await page.locator('[data-sp-cosmetic-sample]').count(),SHOP_CATALOG.length);
 await page.evaluate(()=>cleanup.update({getRacerName:()=> 'Fixture Racer'}));
 assert.ok((await page.locator('.sp-sample-name>b').allTextContents()).every(text=>text==='Fixture Racer'));
 await page.evaluate(()=>cleanup.update({renderCosmeticPreview:({itemId})=>{const node=document.createElement('div');node.className='profile-cosmetic-choice';node.dataset.fixtureRenderer=itemId;node.textContent='Actual Studio snapshot';return node;}}));
 assert.equal(await page.locator('[data-sp-existing-preview][data-fixture-renderer]').count(),SHOP_CATALOG.length);
 assert.ok(await page.locator('[data-sp-existing-preview]').first().evaluate(node=>node.inert));
 await page.evaluate(()=>{const live=document.createElement('div');live.id='live-source';document.body.append(live);cleanup.update({renderCosmeticPreview:()=>live});});
 assert.equal(await page.locator('body>#live-source').count(),1);assert.equal(await page.locator('[data-sp-existing-preview]').count(),0);
});

test('achievement capability adds honest reward information, never a manual claim or a local award',async t=>{
 const page=await fixture(t);assert.equal(await page.locator('[data-sp-achievement-policy]').count(),0);
 await page.evaluate(()=>cleanup.update({achievementClaimsEnabled:true}));
 assert.match(await page.locator('[data-sp-achievement-policy]').innerText(),/14 once-only.*222 Style Coins/);
 assert.equal(await page.locator('[data-sp-action="claim"]').count(),0);assert.equal(await page.evaluate(()=>calls.claim.length),0);
 assert.equal(await page.locator('.sp-summary strong').innerText(),'100 Style Coins');
});

test('sorting stays presentation-only and lists only purchasable designs',async t=>{
 const page=await fixture(t);
 assert.match(await page.locator('.sp-note').innerText(),/Only the designs listed here can be bought/);
 await page.locator('[data-sp-sort]').selectOption('price');
 const expected=[...SHOP_CATALOG].sort((a,b)=>a.price-b.price).map(x=>x.id);
 assert.deepEqual(await page.locator('[data-sp-item-preview]').evaluateAll(nodes=>nodes.map(node=>node.dataset.spItemPreview)),expected);
 await page.locator('[data-sp-sort]').selectOption('name');
 assert.equal(await page.locator('[data-sp-action="buy"]').count(),SHOP_CATALOG.length);
 assert.deepEqual(await page.evaluate(()=>({buy:calls.buy,claim:calls.claim,refresh:calls.refresh})),{buy:[],claim:[],refresh:0});
 assert.ok(await page.locator('.sp-price .sp-coin').count()>0);
});
test('offline shop keeps catalog and last confirmation visible but disables purchases',async t=>{
 const page=await fixture(t,{wallet:{status:'confirmed',accountId:'driver-a',balance:100000,revision:2}});
 await page.context().setOffline(true);
 await page.evaluate(()=>cleanup.update(options));
 assert.match(await page.locator('.sp-summary').innerText(),/Last confirmed balance/);
 assert.match(await page.locator('.sp-status').innerText(),/preview offline/);
 const buttons=page.locator('[data-sp-action=buy]');assert((await buttons.count())>0);
 assert(await buttons.evaluateAll(items=>items.every(item=>item.disabled)));
 await page.locator('[data-sp-action=preview]').first().click();
 assert.deepEqual(await page.evaluate(()=>[calls.preview.length,calls.buy.length,calls.claim.length]),[1,0,0]);
});

test('sticker cards show the actual art, quote confirmation, and local equip instructions',async t=>{
 const page=await fixture(t,{catalog:[...SHOP_CATALOG,...WORKSHOP_STICKER_SHOP_CATALOG]},{width:360,height:800});
 assert.equal(await page.locator('.sp-sticker-swatch polygon').count(),6);
 for(const item of WORKSHOP_STICKER_SHOP_CATALOG){
  const card=page.locator('.sp-item').filter({has:page.getByRole('heading',{name:item.label,exact:true})});
  assert.match(await card.innerText(),/WORKSHOP STICKER/);
  assert.match(await card.innerText(),/Preview in Garage/);
  assert.equal(await card.locator('[data-sp-action=preview]').count(),0);
  await card.getByRole('button',{name:'Buy '+item.label+' for '+item.price+' Style Coins'}).click();
  assert.equal(await page.getByRole('heading',{name:'Buy '+item.label+'?'}).count(),1);
  assert.equal(await page.evaluate(()=>calls.buy.length),0);
  await page.getByRole('button',{name:'Cancel',exact:true}).click();
 }
 await page.evaluate(ids=>cleanup.update({inventory:{status:'confirmed',accountId:'driver-a',ownedIds:ids}}),WORKSHOP_STICKER_SHOP_CATALOG.map(item=>item.id));
 const owned=page.locator('.sp-item').filter({hasText:'WORKSHOP STICKER'});
 assert.equal(await owned.getByText(/Equip in Garage/).count(),2);
 assert.equal(await owned.locator('[data-sp-action=apply], [data-sp-action=buy]').count(),0);
 assert.deepEqual(await page.evaluate(()=>[calls.buy.length,calls.apply.length,calls.preview.length]),[0,0,0]);
});
