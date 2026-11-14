import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {PROFILE_SHOP_CATALOG} from './profile-shop-catalog.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const root=fileURLToPath(new URL('../',import.meta.url)),A='a'.repeat(64),B='b'.repeat(64);
const evidence=process.env.SHOP_EVIDENCE_DIR||path.resolve(root,'../../2026-11-14/profile-shop-host');
let server,browser,base,patch,nativeFixture,hostSource,cosmeticFunctions;
before(async()=>{
 patch=await fs.readFile(path.join(root,'polytrack_062_patch.js'),'utf8');
 const helpers=await fs.readFile(new URL('./profile-achievement-bridge.test.mjs',import.meta.url),'utf8'),start=helpers.indexOf('async function nativeFixture(page)'),end=helpers.indexOf('\ntest(',start);
 const extract=name=>{const m=patch.match(new RegExp(`  function ${name}\\([^\\n]*\\)\\{[\\s\\S]*?\\n  \\}`));assert.ok(m,name);return m[0];};
 cosmeticFunctions=['enforceCosmeticUnlocks','cosmeticsForEntry','resolveCosmeticsForEntry'].map(extract).join('\n');
 const hs=patch.indexOf('  // W-only gate: remain OFF'),he=patch.indexOf('  let profileAchievementBridgeRequest=null;',hs);assert.ok(hs>=0&&he>hs);hostSource=patch.slice(hs,he);
 server=http.createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname;
  if(name==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>@font-face{font-family:ForcedSquare;src:url(/forced_square.woff2)}body{margin:0;background:#192b57;color:white}.offline-note{padding:12px;background:#ffda83;color:#192b57;font:13px sans-serif}</style><aside class="offline-note">Offline integration test. Sample points, not a live balance.</aside><div id="overallLeaderboardPanel" style="display:flex"><div id="overallProfilePopup" style="display:flex"><article class="overall-profile-card"><div id="content"></div></article></div></div>');return;}
  if(!/^\/tools\/[A-Za-z0-9_.-]+\.(mjs|css)$/.test(name)&&!['/forced_square.woff2','/images/car_thumbnail_placeholder.png'].includes(name)){res.writeHead(404).end();return;}
  try{res.setHeader('content-type',name.endsWith('.mjs')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'font/woff2');res.end(await fs.readFile(path.join(root,name.slice(1))));}catch{res.writeHead(404).end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
 nativeFixture=new Function('patch','extract','base','assert','return ('+helpers.slice(start,end).replaceAll("'racer-a'",JSON.stringify(A)).replace('cosmeticUnlocks:[]','cosmeticUnlocks:(window.__fixtureEarned||[])')+')')(patch,extract,base,assert);
 browser=await chromium.launch({headless:true});await fs.mkdir(evidence,{recursive:true});
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));});
async function fixture(t,{enabled=true,width=390,height=844,owned=[],reusePage=null,savedDesign=null,earned=[]}={}){
 const context=reusePage?reusePage.context():await browser.newContext({viewport:{width,height},reducedMotion:'reduce'});if(!reusePage)t.after(()=>context.close());const page=reusePage||await context.newPage();page.on('pageerror',error=>console.log('HOST PAGE ERROR:',error.message));let external=0;
 await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():(external++,route.abort()));await page.goto(base);await page.evaluate(earned=>window.__fixtureEarned=earned,earned);await nativeFixture(page);await page.addStyleTag({url:base+'/tools/cosmetic-preview.css'});
 await page.evaluate(async({A,owned,catalog,savedDesign})=>{
  window.PROFILE_COSMETICS_KEY='offline-confirmed-design';window.cosmeticEpoch=0;window.cosmeticResolveCache=new WeakMap();window.readCosmeticDirectory=()=>({entries:{}});window.readJsonStorage=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};if(savedDesign)localStorage.setItem(PROFILE_COSMETICS_KEY,JSON.stringify(savedDesign));
  window.activeAccount=A;window.tokenCalls=0;window.dbCalls=0;window.network=[];window.holdTokens=false;window.tokenWaiters=[];window.claims=[];
  window.fixtureUser={uid:'offline-owner',getIdToken:async()=>{tokenCalls++;if(holdTokens)await new Promise(resolve=>tokenWaiters.push(resolve));return 'offline-test-token';}};
  window.fixtureAuth={currentUser:fixtureUser,callbacks:new Set(),onAuthStateChanged(fn){this.callbacks.add(fn);fn(this.currentUser);return()=>this.callbacks.delete(fn);},emit(user){this.currentUser=user;for(const fn of [...this.callbacks])fn(user);}};
  window.firebase={auth:()=>fixtureAuth,firestore:()=>{dbCalls++;throw Error('No Firestore access allowed');}};
  window.activeRankedAccountId=()=>activeAccount;window.extraCatalogRevision='321';window.eventsModuleUrl=new URL('/events/client.mjs',location.href);window.assertOnlineCompatibility=()=>{};
  window.serverWallet={accountId:A,catalogVersion:2,balance:100,revision:0,inventoryComplete:true,ownedItemIds:owned,equipRevision:0,equipped:null};
  window.rankedFetch=async(url,options)=>{
   const parsed=new URL(url),body=options.body?JSON.parse(options.body):null;network.push({path:parsed.pathname,method:options.method,body,authorization:options.headers.Authorization});
   if(parsed.pathname==='/v1/shop/catalog')return Response.json({version:2,items:catalog});
   if(parsed.pathname==='/v1/currency/wallet'){if(window.walletUnavailable)return Response.json({error:'currency_unavailable'},{status:503});return Response.json({...serverWallet,accountId:parsed.searchParams.get('accountId')});}
   if(parsed.pathname==='/v1/currency/claim'){claims.push(body.rewardId);if(window.claimRejection)return Response.json(window.claimRejection,{status:window.claimStatus||409});const delta=body.rewardId==='login'?8:100;serverWallet.balance+=delta;serverWallet.revision++;if(window.holdClaimResponse)await new Promise(resolve=>window.releaseClaim=resolve);return Response.json({op:'claim',...body,outcomeOnly:true,delta,balanceAfter:serverWallet.balance,walletRevision:serverWallet.revision,alreadyClaimed:false,duplicate:false,...(body.rewardId==='login'&&window.freshLoginClock?window.freshLoginClock:{}),...(window.claimSuccessOverride||{}),...(body.rewardId==='milestones'?{claimedRewardIds:['tracks-1','tracks-5','tracks-20']}:{} )});}
   return Response.json({error:'unexpected_request'},{status:400});
  };
  const {bindCosmeticPreview}=await import('/tools/cosmetic-preview.mjs');const content=document.querySelector('#content');content.__socialEpoch=1;
  content.__cosmeticPreviewController=bindCosmeticPreview(content.querySelector('.profile-customizer'),{catalog:nativeCatalog,onPreview:option=>applyProfileCosmetics(content.closest('.overall-profile-card'),{...profileCosmeticDrafts.get(A),[option.kind]:option.id}),onRestore:()=>applyProfileCosmetics(content.closest('.overall-profile-card'),profileCosmeticDrafts.get(A))});
  window.draftWrites=0;const set=profileCosmeticDrafts.set.bind(profileCosmeticDrafts);profileCosmeticDrafts.set=(...args)=>{draftWrites++;return set(...args);};
 },{A,owned,catalog:PROFILE_SHOP_CATALOG,savedDesign});
 await page.addScriptTag({content:cosmeticFunctions});
 await page.addScriptTag({content:hostSource.replace(/const PROFILE_SHOP_ENABLED=(?:true|false);/,`const PROFILE_SHOP_ENABLED=${enabled};`)+'\nwindow.actualShopSetup=setupProfileShop;window.actualShopHost=()=>profileShopHost;window.actualAccountTransition=noteProfileShopAccountTransition;window.actualShopReady=()=>profileShopHostRequest;'});
 await page.evaluate(()=>actualShopSetup(document.querySelector('#content'),nativeEntry,true));await page.locator('.profile-shop-open').waitFor();await page.evaluate(()=>actualShopReady());
 page.noExternal=()=>assert.equal(external,0);return page;
}
test('production shop is release-stamped and resets before all three active-account writes',()=>{
 assert.match(patch,/const PROFILE_SHOP_ENABLED=true;/);assert.match(patch,/const extraCatalogRevision='323'/);
 const writes=[...patch.matchAll(/noteProfileShopAccountTransition\(accountId\); localStorage\.setItem\('polytrack-0\.6\.2-active-account-id', accountId\);/g)];assert.equal(writes.length,3);
 assert.match(patch,/profileShopHost\?\.observeAuth\(app\.auth\(\)\)/);assert.match(patch,/content\.__shopCleanup\?\.\(\);content\.__shopCleanup=null/);
});
test('profile render and disabled Shop open issue no wallet/token/Firestore reads',{timeout:15000},async t=>{
 const page=await fixture(t,{enabled:false});assert.deepEqual(await page.evaluate(()=>({requests:network.length,tokens:tokenCalls,db:dbCalls})),{requests:0,tokens:0,db:0});
 await page.locator('.profile-shop-open').click();assert.match(await page.locator('.sp-host-gate').innerText(),/not enabled/);assert.equal(await page.locator('.sp-item').count(),3,await page.locator('.profile-shop-dialog').evaluate(node=>node.outerHTML));
 assert.equal(await page.locator('[data-sp-action="claim"]:enabled,[data-sp-action="buy"]:enabled').count(),0);assert.equal(await page.evaluate(()=>network.length+tokenCalls+dbCalls),0);page.noExternal();
});

test('all three locked original Studio choices use the short Profile shop label, never raw requirement IDs',async t=>{
 const page=await fixture(t,{enabled:false});
 for(const [kind,id]of [['plate','pitlane-ticket'],['stage','apex-observatory'],['stripe','vector-ribbon']]){
  const label=await page.locator(`[data-cosmetic-kind="${kind}"][data-cosmetic-value="${id}"] small`).innerText();
  assert.equal(label,'Profile shop');assert.doesNotMatch(label,/shop:|tracks/i);
 }
 assert.equal(await page.evaluate(()=>network.length+tokenCalls+dbCalls),0);page.noExternal();
});
test('explicit own Shop open fetches confirmed wallet using current user token; claim and refresh are explicit',{timeout:20000},async t=>{
 const page=await fixture(t);assert.equal(await page.evaluate(()=>network.length),0);await page.locator('.profile-shop-open').click();await page.waitForFunction(()=>document.querySelector('.sp-summary strong')?.textContent==='100 CP');
 const first=await page.evaluate(()=>network);assert.equal(first.length,2);assert.ok(first.every(row=>row.method==='GET'&&row.authorization==='Bearer offline-test-token'));
 if(!await page.locator('.sp-earn').getAttribute('open'))await page.locator('.sp-earn summary').click();
 await page.getByRole('button',{name:'Daily visit Claim 8 CP',exact:true}).click();await page.waitForFunction(()=>document.querySelector('.sp-summary strong')?.textContent==='108 CP');
 assert.deepEqual(await page.evaluate(()=>claims),['login']);assert.equal(await page.evaluate(()=>network.filter(row=>row.path.includes('equip')).length),0);
 const n=await page.evaluate(()=>network.length);await page.getByRole('button',{name:'Refresh balance'}).click();await page.waitForFunction(n=>network.length===n+2,n);
 assert.equal(await page.evaluate(()=>dbCalls),0);page.noExternal();
});
test('confirmed owned Apply changes actual Studio draft only, never saves/purchases/equips',{timeout:15000},async t=>{
 const page=await fixture(t,{owned:['profile-pitlane-ticket'],width:1366,height:768});await page.locator('.profile-shop-open').click();await page.getByRole('button',{name:'Apply to draft'}).waitFor();
 await page.getByRole('button',{name:'Apply to draft'}).click();assert.equal(await page.locator('[data-ph-tab="studio"]').getAttribute('aria-selected'),'true');
 const result=await page.evaluate(()=>({draft:profileCosmeticDrafts.get(activeAccount),writes:draftWrites,published:window.published||0,posts:network.filter(row=>row.method==='POST').length,db:dbCalls}));
 assert.equal(result.draft.plate,'pitlane-ticket');assert.equal(result.writes,1);assert.equal(result.published,0);assert.equal(result.posts,0);assert.equal(result.db,0);page.noExternal();
});
test('confirmed ownership and published design survive a real document reload without opening Shop or reading wallet',{timeout:20000},async t=>{
 let page=await fixture(t,{owned:['profile-pitlane-ticket']});await page.locator('.profile-shop-open').click();await page.getByRole('button',{name:'Apply to draft'}).waitFor();
 assert.equal(await page.locator('[data-cosmetic-kind="plate"][data-cosmetic-value="pitlane-ticket"]').getAttribute('data-cosmetic-locked'),null);
 const cached=await page.evaluate(()=>Object.entries(localStorage).filter(([key])=>key.startsWith('polytrack-profile-shop-owned-ui-v1:')));assert.equal(cached.length,1);assert.doesNotMatch(cached[0][1],/balance|token|price|wallet/);
 page=await fixture(t,{reusePage:page,earned:['emblem:target','stripe:overdrive'],savedDesign:{plate:'pitlane-ticket',emblem:'target',stripe:'overdrive'}});
 assert.equal(await page.evaluate(()=>network.length+tokenCalls+dbCalls),0);assert.equal(await page.locator('dialog.profile-shop-dialog').count(),0);
 const ownedChoice=page.locator('[data-cosmetic-kind="plate"][data-cosmetic-value="pitlane-ticket"]');assert.equal(await ownedChoice.getAttribute('data-cosmetic-locked'),null);
 assert.equal(await page.evaluate(()=>profileCosmeticDrafts.get(activeAccount).plate),'pitlane-ticket','existing saved design rehydrates only after same-owner UI ownership is available');
 assert.deepEqual(await page.evaluate(()=>({emblem:profileCosmeticDrafts.get(activeAccount).emblem,stripe:profileCosmeticDrafts.get(activeAccount).stripe,earned:nativeEntry.cosmeticUnlocks})),{emblem:'target',stripe:'overdrive',earned:['emblem:target','stripe:overdrive']},'current earned styles coexist with cached owned design; public unlock data is not rewritten');
 await page.evaluate(()=>cleanup.open('studio'));await ownedChoice.click();assert.equal(await page.evaluate(()=>profileCosmeticDrafts.get(activeAccount).plate),'pitlane-ticket');assert.equal(await page.evaluate(()=>document.querySelector('#content').__cosmeticPreviewController.isActive()),false);
 assert.equal(await page.evaluate(()=>network.length+tokenCalls+dbCalls+(window.published||0)),0);page.noExternal();
});
test('cached UI ownership disappears on sign-out/wrong auth owner and cannot unlock another racer',{timeout:15000},async t=>{
 const page=await fixture(t,{owned:['profile-pitlane-ticket']});await page.locator('.profile-shop-open').click();await page.getByRole('button',{name:'Apply to draft'}).waitFor();
 await page.evaluate(()=>fixtureAuth.emit(null));assert.equal(await page.evaluate(()=>actualShopHost().ownsForUi(activeAccount,'plate:pitlane-ticket')),false);
 await page.evaluate(()=>fixtureAuth.emit({...fixtureUser,uid:'different-owner'}));assert.equal(await page.locator('[data-cosmetic-value="pitlane-ticket"]').getAttribute('data-cosmetic-locked'),'true');
 assert.equal(await page.evaluate(B=>actualShopHost().ownsForUi(B,'plate:pitlane-ticket'),B),false);
 const before=await page.evaluate(()=>network.length);await page.evaluate(()=>fixtureAuth.emit(fixtureUser));assert.equal(await page.locator('[data-cosmetic-value="pitlane-ticket"]').getAttribute('data-cosmetic-locked'),null);assert.equal(await page.evaluate(()=>network.length),before);page.noExternal();
});
test('foreign profiles cannot acquire a Shop entry or purchase for the viewed racer',async t=>{
 const page=await fixture(t);await page.evaluate(B=>{document.querySelector('#content').__shopCleanup();actualShopSetup(document.querySelector('#content'),{...nativeEntry,userId:B},true);},B);
 await page.waitForTimeout(30);assert.equal(await page.locator('.profile-shop-open').count(),0);assert.equal(await page.evaluate(()=>network.length),0);page.noExternal();
});
test('auth A-B-A and all three account-set paths invalidate held-token requests without automatic re-fetch',{timeout:20000},async t=>{
 const page=await fixture(t);await page.evaluate(()=>holdTokens=true);await page.locator('.profile-shop-open').click();await page.waitForFunction(()=>tokenCalls>=1);
 await page.evaluate(()=>{const original=fixtureUser;fixtureAuth.emit(null);fixtureAuth.emit({...original,uid:'other-owner'});fixtureAuth.emit(original);holdTokens=false;for(const release of tokenWaiters)release();});
 await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>network.length),0);
 for(let path=0;path<3;path++)await page.evaluate(({A,B})=>{actualAccountTransition(B);localStorage.setItem('polytrack-0.6.2-active-account-id',B);activeAccount=B;actualAccountTransition(A);localStorage.setItem('polytrack-0.6.2-active-account-id',A);activeAccount=A;},{A,B});
 assert.equal(await page.evaluate(()=>network.length),0);assert.equal(await page.locator('dialog.profile-shop-dialog').count(),0);page.noExternal();
});
test('native host phone and laptop show original art without overflow or fake live balances',{timeout:20000},async t=>{
 for(const [name,width,height]of[['phone',360,800],['laptop',1366,768]]){
  const page=await fixture(t,{width,height});await page.locator('.profile-shop-open').click();await page.waitForFunction(()=>document.querySelector('.sp-summary strong')?.textContent==='100 CP');
  await page.evaluate(()=>document.querySelector('.sp-host-gate').textContent='Offline integration fixture. Sample CP, not a live balance.');await page.locator('.sp-host-gate').evaluate(node=>node.hidden=false);
  assert.equal(await page.locator('.sp-art svg').count(),3);assert.equal(await page.locator('.profile-shop-dialog').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
  await page.screenshot({path:path.join(evidence,`native-profile-shop-v2-${name}.png`)});page.noExternal();
 }
});

test('login-409 server-day metadata is bounded and internally consistent',async()=>{
 const {loginClaimWindow}=await import('./profile-shop-host.mjs');
 const day=86400000,claimDay=20000,serverNow=claimDay*day+1000,dayEndsAt=(claimDay+1)*day;
 const value={error:'reward_already_claimed',notCommitted:true,claimDay,serverNow,dayEndsAt};
 assert.equal(loginClaimWindow(value),day-1000);
 for(const change of [{claimDay:claimDay+1},{serverNow:dayEndsAt},{dayEndsAt:dayEndsAt+1},{notCommitted:false},{error:'currency_unavailable'},{claimDay:'20000'},{serverNow:NaN},{serverNow:Infinity},{dayEndsAt:undefined}])assert.equal(loginClaimWindow({...value,...change}),null);
});

test('definite daily rejection disables only login, with no extra reads or balance grant; marker expires and resets on auth A-B-A',{timeout:20000},async t=>{
 const page=await fixture(t,{width:1366,height:768});
 await page.evaluate(()=>{window.monotonicOffset=0;const original=performance.now.bind(performance);Object.defineProperty(performance,'now',{value:()=>original()+monotonicOffset});window.claimRejection={error:'reward_already_claimed',notCommitted:true,claimDay:20000,serverNow:20000*86400000+1000,dayEndsAt:20001*86400000};});
 await page.locator('.profile-shop-open').click();await page.waitForFunction(()=>document.querySelector('.sp-summary strong')?.textContent==='100 CP');
 await page.getByRole('button',{name:'Daily visit Claim 8 CP',exact:true}).click();
 const daily=page.locator('[data-sp-reward="login"]');await page.waitForFunction(()=>document.querySelector('[data-sp-reward="login"]')?.textContent.includes('Claimed today'));
 assert.equal(await daily.isDisabled(),true);assert.equal(await page.evaluate(()=>network.length),3,'409 does not trigger a wallet read');
 assert.equal(await page.evaluate(()=>serverWallet.balance),100);assert.equal(await page.evaluate(()=>Object.entries(localStorage).some(([key,value])=>key.includes('claimDay')||value.includes('claimDay'))),false);
 await page.locator('[data-sp-action="refresh"]').click();await page.waitForFunction(()=>document.querySelector('.sp-summary strong')?.textContent==='100 CP');
 assert.equal(await daily.isDisabled(),true);assert.equal(await page.locator('[data-sp-reward="milestones"]').isEnabled(),true);
 await page.evaluate(()=>{Date.now=()=>0;});assert.equal(await daily.isDisabled(),true,'device calendar cannot extend or reset server day');
 await page.evaluate(()=>monotonicOffset=86400000);await page.locator('[data-sp-action="refresh"]').click();await page.waitForFunction(()=>document.querySelector('[data-sp-reward="login"]')?.disabled===false);
 await page.evaluate(()=>monotonicOffset=0);await daily.click();await page.waitForFunction(()=>document.querySelector('[data-sp-reward="login"]')?.textContent.includes('Claimed today'));
 await page.evaluate(()=>{fixtureAuth.emit(null);fixtureAuth.emit({...fixtureUser,uid:'other-owner'});fixtureAuth.emit(fixtureUser);});
 await page.locator('.profile-shop-open').click();await page.waitForFunction(()=>document.querySelector('[data-sp-reward="login"]')?.disabled===false);
 assert.equal(await page.evaluate(()=>dbCalls),0);page.noExternal();
});

test('legacy, malformed, milestone and ambiguous rejections never create daily marker',{timeout:25000},async t=>{
 for(const [reward,change,status]of[['login',{dayEndsAt:1},409],['login',{claimDay:undefined,serverNow:undefined,dayEndsAt:undefined},409],['milestones',{},409],['login',{},503]]){
  const page=await fixture(t,{width:1366,height:768});
  await page.evaluate(({change,status})=>{window.claimStatus=status;window.claimRejection={error:'reward_already_claimed',notCommitted:true,claimDay:20000,serverNow:20000*86400000+1000,dayEndsAt:20001*86400000,...change};},{change,status});
  await page.locator('.profile-shop-open').click();await page.waitForFunction(()=>document.querySelector('.sp-summary strong')?.textContent==='100 CP');
  await page.locator('[data-sp-reward="'+reward+'"]').click();await page.waitForFunction(()=>document.querySelector('.sp-summary strong')?.textContent!=='100 CP');
  assert.doesNotMatch(await page.locator('[data-sp-reward="login"]').innerText(),/Claimed today/);assert.equal(await page.evaluate(()=>network.length),3);page.noExternal();
 }
});

test('native journal progress, subtitle, goals and shop balance helpers do not inherit serif racer fonts',{timeout:15000},async t=>{
 const page=await fixture(t);await page.evaluate(()=>{document.querySelector('.overall-profile-card').style.fontFamily='"Times New Roman",serif';});
 await page.locator('[data-ph-launch="achievements"]').click();await page.locator('[data-aj-root]').waitFor();await page.evaluate(()=>document.fonts.ready);
 await page.locator('[data-aj-select]:visible').first().click();
 const samples=await page.locator('.aj-summary p,.aj-notice,.aj-progress>span,.aj-node-reward,.aj-inspector-info p,.ph-heading p,[data-aj-select]>strong').evaluateAll(nodes=>nodes.map(node=>({text:node.textContent.slice(0,60),font:getComputedStyle(node).fontFamily,style:getComputedStyle(node).fontStyle})));
 assert.ok(samples.length>5);for(const sample of samples){assert.match(sample.font,/ForcedSquare/i,JSON.stringify(sample));assert.equal(sample.style,'normal');}
 await page.screenshot({path:path.join(evidence,'fixture-achievements-native-body-font-390.png')});
 await page.locator('[data-ph-close]').click();await page.locator('.profile-shop-open').click();await page.waitForFunction(()=>document.querySelector('.sp-summary strong')?.textContent==='100 CP');
 const helpers=await page.locator('.sp-status span,.sp-summary span,.sp-earn p').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).fontFamily));assert.ok(helpers.length>2);for(const font of helpers)assert.match(font,/ForcedSquare/i);page.noExternal();
});

test('public original art preview works with wallet unavailable or gate OFF, without grants, draft changes or spending',{timeout:20000},async t=>{
 for(const enabled of [true,false]){
  const page=await fixture(t,{enabled,width:390,height:844});await page.evaluate(()=>walletUnavailable=true);
  if(!enabled)await page.evaluate(()=>fixtureAuth.emit(null));
  await page.locator('.profile-shop-open').click();await page.locator('.sp-item').first().waitFor();
  if(enabled)await page.waitForFunction(()=>document.querySelector('.sp-host-gate')?.textContent.includes('could not be confirmed'));
  assert.equal(await page.locator('[data-sp-action="buy"]:enabled,[data-sp-action="apply"]:enabled,[data-sp-action="claim"]:enabled').count(),0);
  const before=await page.evaluate(()=>({draft:JSON.stringify(profileCosmeticDrafts.get(activeAccount)),requests:network.length,tokens:tokenCalls,writes:draftWrites}));
  await page.locator('[data-sp-action="preview"]').first().click();await page.locator('.cosmetic-preview-banner').waitFor();
  assert.equal(await page.locator('[data-ph-tab="studio"]').getAttribute('aria-selected'),'true');assert.match(await page.locator('.cosmetic-preview-banner strong').innerText(),/Preview only - not applied/);
  const header=await page.evaluate(()=>{const banner=document.querySelector('.cosmetic-preview-banner').getBoundingClientRect(),tabs=document.querySelector('.profile-customizer .studio-tabs').getBoundingClientRect();return {top:banner.top,bottom:banner.bottom,tabsTop:tabs.top,height:innerHeight};});assert.ok(header.top>=0&&header.bottom<=header.height&&header.bottom<=header.tabsTop+1,JSON.stringify(header));
  const after=await page.evaluate(()=>({draft:JSON.stringify(profileCosmeticDrafts.get(activeAccount)),requests:network.length,tokens:tokenCalls,writes:draftWrites}));assert.deepEqual(after,before);
  assert.equal(await page.evaluate(()=>network.filter(row=>row.method==='POST').length+dbCalls+(window.published||0)),0);
  if(!enabled)assert.equal(before.requests+before.tokens,0);
  await page.screenshot({path:path.join(evidence,`fixture-public-shop-preview-${enabled?'wallet-unavailable':'gate-off'}-390.png`)});
  await page.locator('[data-cosmetic-preview-clear]').click();assert.equal(await page.evaluate(()=>document.querySelector('#content').__cosmeticPreviewController.isActive()),false);
  assert.equal(await page.evaluate(()=>JSON.stringify(profileCosmeticDrafts.get(activeAccount))),before.draft);page.noExternal();
 }
});

test('fresh login response clock requires exact fresh result and originating request binding',async()=>{
 const {freshLoginClaimWindow}=await import('./profile-shop-host.mjs'),request={accountId:A,requestId:'fresh-request-123',rewardId:'login'};
 const value={op:'claim',...request,duplicate:false,alreadyClaimed:false,outcomeOnly:true,delta:8,walletRevision:1,balanceAfter:108,claimDay:20000,serverNow:20000*86400000+1000,dayEndsAt:20001*86400000};
 assert.equal(freshLoginClaimWindow(value,request),86400000-1000);
 for(const change of [{duplicate:true},{duplicate:undefined},{op:'purchase'},{rewardId:'milestones'},{accountId:B},{requestId:'other-request-123'},{alreadyClaimed:true},{outcomeOnly:false},{delta:0},{delta:16},{walletRevision:-1},{walletRevision:'1'},{balanceAfter:'108'},{balanceAfter:NaN},{dayEndsAt:1},{claimDay:20001},{serverNow:20001*86400000}])assert.equal(freshLoginClaimWindow({...value,...change},request),null,JSON.stringify(change));
 assert.equal(freshLoginClaimWindow(value,{...request,rewardId:'milestones'}),null);
});

test('fresh200 login disables daily immediately without repeated POST/GET; server-day expiry and auth A-B-A clear only UI marker',{timeout:20000},async t=>{
 const page=await fixture(t,{width:1366,height:768});
 await page.evaluate(()=>{window.monotonicOffset=0;const original=performance.now.bind(performance);Object.defineProperty(performance,'now',{value:()=>original()+monotonicOffset});window.freshLoginClock={claimDay:20000,serverNow:20000*86400000+1000,dayEndsAt:20001*86400000};});
 await page.locator('.profile-shop-open').click();await page.waitForFunction(()=>document.querySelector('.sp-summary strong')?.textContent==='100 CP');
 await page.locator('[data-sp-reward="login"]').click();await page.waitForFunction(()=>document.querySelector('.sp-summary strong')?.textContent==='108 CP');
 const daily=page.locator('[data-sp-reward="login"]');assert.match(await daily.innerText(),/Claimed today/);assert.equal(await daily.isDisabled(),true);assert.equal(await page.locator('[data-sp-reward="milestones"]').isEnabled(),true);
 const count=await page.evaluate(()=>network.length);assert.equal(count,4,'initial2 + explicit POST + one completion wallet GET only');
 await daily.dispatchEvent('click');assert.equal(await page.evaluate(()=>network.length),count);assert.deepEqual(await page.evaluate(()=>claims),['login']);
 assert.equal(await page.evaluate(()=>Object.values(localStorage).some(value=>/claimDay|balanceAfter|fixture-token/.test(value))),false);
 await page.evaluate(()=>{Date.now=()=>0;monotonicOffset=86400000;});await page.locator('[data-sp-action="refresh"]').click();await page.waitForFunction(()=>document.querySelector('[data-sp-reward="login"]')?.disabled===false);
 assert.equal(await page.evaluate(()=>claims.length),1,'clock expiry never auto-claims');
 await page.evaluate(()=>{const day=20001;window.monotonicOffset=0;freshLoginClock={claimDay:day,serverNow:day*86400000+1000,dayEndsAt:(day+1)*86400000};});
 await daily.click();await page.waitForFunction(()=>document.querySelector('.sp-summary strong')?.textContent==='116 CP');assert.equal(await daily.isDisabled(),true);
 await page.evaluate(()=>{fixtureAuth.emit(null);fixtureAuth.emit({...fixtureUser,uid:'other-owner'});fixtureAuth.emit(fixtureUser);});
 await page.locator('.profile-shop-open').click();await page.waitForFunction(()=>document.querySelector('[data-sp-reward="login"]')?.disabled===false);assert.equal(await page.evaluate(()=>dbCalls),0);page.noExternal();
});

test('duplicate old receipt and malformed fresh200 clocks never mark today',{timeout:20000},async t=>{
 for(const change of [{duplicate:true},{dayEndsAt:1},{requestId:'wrong-request-123'},{delta:16}]){
  const page=await fixture(t,{width:1366,height:768});await page.evaluate(change=>{window.freshLoginClock={claimDay:20000,serverNow:20000*86400000+1000,dayEndsAt:20001*86400000};window.claimSuccessOverride=change;},change);
  await page.locator('.profile-shop-open').click();await page.waitForFunction(()=>document.querySelector('.sp-summary strong')?.textContent==='100 CP');await page.locator('[data-sp-reward="login"]').click();await page.waitForFunction(()=>document.querySelector('.sp-summary strong')?.textContent!=='100 CP');
  assert.doesNotMatch(await page.locator('[data-sp-reward="login"]').innerText(),/Claimed today/);assert.equal(await page.evaluate(()=>claims.length),1);page.noExternal();
 }
});

test('late fresh200 success cannot carry daily UI marker across auth/account A-B-A',{timeout:15000},async t=>{
 const page=await fixture(t,{width:1366,height:768});await page.evaluate(()=>{window.holdClaimResponse=true;window.freshLoginClock={claimDay:20000,serverNow:20000*86400000+1000,dayEndsAt:20001*86400000};});
 await page.locator('.profile-shop-open').click();await page.waitForFunction(()=>document.querySelector('.sp-summary strong')?.textContent==='100 CP');await page.locator('[data-sp-reward="login"]').click();await page.waitForFunction(()=>typeof releaseClaim==='function');
 await page.evaluate(({A,B})=>{fixtureAuth.emit(null);fixtureAuth.emit(fixtureUser);actualAccountTransition(B);activeAccount=B;actualAccountTransition(A);activeAccount=A;holdClaimResponse=false;releaseClaim();},{A,B});
 await page.locator('.profile-shop-open').click();await page.locator('[data-sp-reward="login"]').waitFor();await page.waitForTimeout(50);assert.doesNotMatch(await page.locator('[data-sp-reward="login"]').innerText(),/Claimed today/);assert.equal(await page.evaluate(()=>claims.length),1);assert.equal(await page.evaluate(()=>dbCalls),0);page.noExternal();
});
