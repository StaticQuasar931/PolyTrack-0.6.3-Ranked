import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {PROFILE_SHOP_CATALOG} from './profile-shop-catalog.mjs';
import {ACHIEVEMENT_COIN_SCHEDULE,ACHIEVEMENT_COIN_POLICY_VERSION} from './achievement-coin-schedule.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const root=fileURLToPath(new URL('../',import.meta.url)),A='a'.repeat(64),B='b'.repeat(64);
const evidence=process.env.SHOP_EVIDENCE_DIR||path.resolve(root,'../../2026-11-14/profile-shop-host');
let server,browser,base,patch,nativeFixture,hostSource,cosmeticFunctions,authHelperSource;
before(async()=>{
 patch=await fs.readFile(path.join(root,'polytrack_062_patch.js'),'utf8');
 const helpers=await fs.readFile(new URL('./profile-achievement-bridge.test.mjs',import.meta.url),'utf8'),start=helpers.indexOf('async function nativeFixture(page)'),end=helpers.indexOf('\ntest(',start);
 const extract=name=>{const m=patch.match(new RegExp(`  function ${name}\\([^\\n]*\\)\\{[\\s\\S]*?\\n  \\}`));assert.ok(m,name);return m[0];};
 authHelperSource=extract('ensureFirebaseAuthApp');
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
 const context=reusePage?reusePage.context():await browser.newContext({viewport:{width,height},reducedMotion:'reduce'});if(!reusePage)t.after(()=>context.close());const page=reusePage||await context.newPage();page.setDefaultTimeout(5000);page.on('pageerror',error=>console.log('HOST PAGE ERROR:',error.message));let external=0;
 await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():(external++,route.abort()));await page.goto(base);await page.evaluate(earned=>window.__fixtureEarned=earned,earned);await nativeFixture(page);await page.addStyleTag({url:base+'/tools/cosmetic-preview.css'});
 await page.evaluate(async({A,owned,catalog,savedDesign,achievementReceipt})=>{
  window.PROFILE_COSMETICS_KEY='offline-confirmed-design';window.cosmeticEpoch=0;window.cosmeticResolveCache=new WeakMap();window.readCosmeticDirectory=()=>({entries:{}});window.readJsonStorage=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};if(savedDesign)localStorage.setItem(PROFILE_COSMETICS_KEY,JSON.stringify(savedDesign));
  window.activeAccount=A;window.tokenCalls=0;window.dbCalls=0;window.network=[];window.holdTokens=false;window.tokenWaiters=[];window.claims=[];window.claimReceipts=new Map();window.grantedRewards=new Set();
  window.fixtureUser={uid:'offline-owner',getIdToken:async()=>{tokenCalls++;if(holdTokens)await new Promise(resolve=>tokenWaiters.push(resolve));return 'offline-test-token';}};
  window.fixtureAuth={currentUser:fixtureUser,callbacks:new Set(),onAuthStateChanged(fn){this.callbacks.add(fn);fn(this.currentUser);return()=>this.callbacks.delete(fn);},emit(user){this.currentUser=user;for(const fn of [...this.callbacks])fn(user);}};
  window.firebase={auth:()=>fixtureAuth,firestore:()=>{dbCalls++;throw Error('No Firestore access allowed');}};
  window.authBootstrapCalls=0;window.communityAuthNotifications=0;window.firebaseAuthAppLoader=Promise.resolve(async()=>{authBootstrapCalls++;return {auth:()=>fixtureAuth};});window.observeCommunityBadgeAuth=()=>{communityAuthNotifications++;};
  window.activeRankedAccountId=()=>activeAccount;window.extraCatalogRevision='321';window.eventsModuleUrl=new URL('/events/client.mjs',location.href);window.assertOnlineCompatibility=()=>{};
  window.serverWallet={accountId:A,catalogVersion:2,balance:100,revision:0,inventoryComplete:true,ownedItemIds:owned,equipRevision:0,equipped:null};
  window.rankedFetch=async(url,options)=>{
   const parsed=new URL(url),body=options.body?JSON.parse(options.body):null;network.push({path:parsed.pathname,method:options.method,body,authorization:options.headers.Authorization});
   if(parsed.pathname==='/v1/shop/catalog')return Response.json({version:2,items:catalog});
   if(parsed.pathname==='/v1/currency/wallet'){if(window.walletUnavailable)return Response.json({error:'currency_unavailable'},{status:503});return Response.json({...serverWallet,accountId:parsed.searchParams.get('accountId')});}
   if(parsed.pathname==='/v1/currency/claim'){
    claims.push(body.rewardId);
    const reject=window.claimRejectionsByReward?.[body.rewardId]||window.claimRejection;
    if(reject)return Response.json(reject,{status:window.claimStatus||409});
    const previous=claimReceipts.get(body.requestId);
    if(previous)return Response.json({...previous,duplicate:true});
    if(grantedRewards.has(body.rewardId))return Response.json({error:'reward_already_claimed',notCommitted:true},{status:409});
    const delta=body.rewardId==='login'?8:body.rewardId==='achievements'?achievementReceipt.delta:(window.milestoneClaimDelta??100);
    serverWallet.balance+=delta;serverWallet.revision++;grantedRewards.add(body.rewardId);
    const receipt={op:'claim',...body,outcomeOnly:true,delta,balanceAfter:serverWallet.balance,walletRevision:serverWallet.revision,alreadyClaimed:false,duplicate:false,...(body.rewardId==='login'&&window.freshLoginClock?window.freshLoginClock:{}),...(body.rewardId==='milestones'?{claimedRewardIds:window.milestoneClaimIds||['tracks-1','tracks-5','tracks-20']}:body.rewardId==='achievements'?achievementReceipt:{})};
    claimReceipts.set(body.requestId,receipt);
    if(window.holdClaimResponse)await new Promise(resolve=>window.releaseClaim=resolve);
    return Response.json({...receipt,...(window.claimSuccessOverride||{})});
   }
   return Response.json({error:'unexpected_request'},{status:400});
  };
  const {bindCosmeticPreview}=await import('/tools/cosmetic-preview.mjs');const content=document.querySelector('#content');content.__socialEpoch=1;
  content.__cosmeticPreviewController=bindCosmeticPreview(content.querySelector('.profile-customizer'),{catalog:nativeCatalog,onPreview:option=>applyProfileCosmetics(content.closest('.overall-profile-card'),{...profileCosmeticDrafts.get(A),[option.kind]:option.id}),onRestore:()=>applyProfileCosmetics(content.closest('.overall-profile-card'),profileCosmeticDrafts.get(A))});
  window.draftWrites=0;const set=profileCosmeticDrafts.set.bind(profileCosmeticDrafts);profileCosmeticDrafts.set=(...args)=>{draftWrites++;return set(...args);};
 },{A,owned,catalog:PROFILE_SHOP_CATALOG,savedDesign,achievementReceipt:{policyVersion:ACHIEVEMENT_COIN_POLICY_VERSION,delta:ACHIEVEMENT_COIN_SCHEDULE.reduce((sum,row)=>sum+row.amount,0),claimedRewardIds:ACHIEVEMENT_COIN_SCHEDULE.map(row=>row.id)}});
 await page.addScriptTag({content:cosmeticFunctions});
 await page.addScriptTag({content:authHelperSource+'\n'+hostSource.replace(/const PROFILE_SHOP_ENABLED=(?:true|false);/,`const PROFILE_SHOP_ENABLED=${enabled};`)+'\nwindow.actualShopSetup=setupProfileShop;window.actualShopHost=()=>profileShopHost;window.actualAccountTransition=noteProfileShopAccountTransition;window.actualShopReady=()=>profileShopHostRequest;'});
 await page.evaluate(()=>actualShopSetup(document.querySelector('#content'),nativeEntry,true));await page.locator('.profile-shop-open').waitFor({state:'attached'});await page.evaluate(()=>actualShopReady());
 page.noExternal=()=>assert.equal(external,0);return page;
}
async function openShop(page){
 if(!await page.locator('.profile-shop-open').isVisible())await page.evaluate(()=>cleanup.open('studio'));
 await page.locator('.profile-shop-open').click();
}

async function settleShop(page){await page.evaluate(()=>document.querySelector('#content').__shopCleanup.open());}
async function reopenShop(page){await page.evaluate(()=>document.querySelector('#content').__profileShopClose());await openShop(page);await settleShop(page);}
async function installClock(page){await page.evaluate(()=>{const wall=Date.now(),mono=performance.now();window.shopElapsed=0;Object.defineProperty(Date,'now',{configurable:true,value:()=>wall+shopElapsed});Object.defineProperty(performance,'now',{configurable:true,value:()=>mono+shopElapsed});});}
async function assertConfirmedBalance(page){assert.equal(await page.locator('.sp-summary strong').innerText(),await page.evaluate(()=>serverWallet.balance+' Style Coins'));}

test('production shop is release-stamped and resets before all three active-account writes',()=>{
 assert.match(patch,/const PROFILE_SHOP_ENABLED=true;/);assert.match(patch,/const extraCatalogRevision='[0-9]+'/);
 const writes=[...patch.matchAll(/noteProfileShopAccountTransition\(accountId\); localStorage\.setItem\('polytrack-0\.6\.2-active-account-id', accountId\);/g)];assert.equal(writes.length,3);
 assert.match(patch,/profileShopHost\?\.observeAuth\(app\.auth\(\)\)/);assert.match(patch,/content\.__shopCleanup\?\.\(\);content\.__shopCleanup=null/);
});
test('profile render and disabled Shop open issue no wallet/token/Firestore reads',{timeout:15000},async t=>{
 const page=await fixture(t,{enabled:false});assert.deepEqual(await page.evaluate(()=>({requests:network.length,tokens:tokenCalls,db:dbCalls})),{requests:0,tokens:0,db:0});
 await openShop(page);assert.match(await page.locator('.sp-host-gate').innerText(),/not enabled/);assert.equal(await page.locator('.sp-item').count(),PROFILE_SHOP_CATALOG.length,await page.locator('.profile-shop-dialog').evaluate(node=>node.outerHTML));
 assert.equal(await page.locator('[data-sp-action="claim"]:enabled,[data-sp-action="buy"]:enabled').count(),0);assert.equal(await page.evaluate(()=>network.length+tokenCalls+dbCalls),0);page.noExternal();
});

test('all canonical locked Studio choices show their Style Coins price, never raw requirement IDs',async t=>{
 const page=await fixture(t,{enabled:false});
 for(const item of PROFILE_SHOP_CATALOG){
  const {slot:kind,value:id}=item.grants[0];
  const label=await page.locator(`[data-cosmetic-kind="${kind}"][data-cosmetic-value="${id}"] small`).innerText();
  assert.equal(label,item.price+' Style Coins');assert.doesNotMatch(label,/shop:|tracks|\bCP\b/i);
 }
 assert.equal(await page.evaluate(()=>network.length+tokenCalls+dbCalls),0);page.noExternal();
});
test('explicit Shop opening settles bounded eligible rewards before one authoritative wallet read; warm reopen is cached',async t=>{
 const page=await fixture(t);assert.equal(await page.evaluate(()=>network.length+authBootstrapCalls),0);await openShop(page);await settleShop(page);await assertConfirmedBalance(page);
 const first=await page.evaluate(()=>network);assert.equal(first.filter(r=>r.path==='/v1/currency/wallet').length,1);assert.equal(first.filter(r=>r.path==='/v1/shop/catalog').length,1);
 const posts=first.filter(r=>r.method==='POST');assert.deepEqual(posts.map(r=>r.body.rewardId),['login','milestones','achievements']);assert.equal(new Set(posts.map(r=>r.body.requestId)).size,3);assert.ok(first.every(r=>r.authorization==='Bearer offline-test-token'));
 assert.equal(await page.evaluate(()=>serverWallet.balance),100+8+100+ACHIEVEMENT_COIN_SCHEDULE.reduce((n,r)=>n+r.amount,0));assert.equal(first.at(-1).path,'/v1/currency/wallet');
 assert.equal(await page.locator('[data-sp-action="claim"],[data-sp-action="refresh"]').count(),0);await reopenShop(page);assert.equal(await page.evaluate(()=>network.length),first.length);assert.equal(await page.evaluate(()=>dbCalls+communityAuthNotifications),0);page.noExternal();
});

test('confirmed owned Apply changes actual Studio draft only, never saves/purchases/equips',{timeout:15000},async t=>{
 const page=await fixture(t,{owned:['profile-pitlane-ticket'],width:1366,height:768});await openShop(page);await page.getByRole('button',{name:'Apply to draft'}).waitFor();
 const beforePosts=await page.evaluate(()=>network.filter(row=>row.method==='POST').length);await page.getByRole('button',{name:'Apply to draft'}).click();assert.equal(await page.locator('[data-ph-tab="studio"]').getAttribute('aria-selected'),'true');
 const result=await page.evaluate(()=>({draft:profileCosmeticDrafts.get(activeAccount),writes:draftWrites,published:window.published||0,posts:network.filter(row=>row.method==='POST').length,db:dbCalls}));
 assert.equal(result.draft.plate,'pitlane-ticket');assert.equal(result.writes,1);assert.equal(result.published,0);assert.equal(result.posts,beforePosts);assert.equal(result.db,0);page.noExternal();
});
test('confirmed ownership and published design survive a real document reload without opening Shop or reading wallet',{timeout:20000},async t=>{
 let page=await fixture(t,{owned:['profile-pitlane-ticket']});await openShop(page);await page.getByRole('button',{name:'Apply to draft'}).waitFor();
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
 const page=await fixture(t,{owned:['profile-pitlane-ticket']});await openShop(page);await page.getByRole('button',{name:'Apply to draft'}).waitFor();
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
 const page=await fixture(t);await page.evaluate(()=>holdTokens=true);await openShop(page);await page.waitForFunction(()=>tokenCalls>=1);
 await page.evaluate(()=>{const original=fixtureUser;fixtureAuth.emit(null);fixtureAuth.emit({...original,uid:'other-owner'});fixtureAuth.emit(original);holdTokens=false;for(const release of tokenWaiters)release();});
 await page.waitForTimeout(30);assert.equal(await page.evaluate(()=>network.length),0);
 for(let path=0;path<3;path++)await page.evaluate(({A,B})=>{actualAccountTransition(B);localStorage.setItem('polytrack-0.6.2-active-account-id',B);activeAccount=B;actualAccountTransition(A);localStorage.setItem('polytrack-0.6.2-active-account-id',A);activeAccount=A;},{A,B});
 assert.equal(await page.evaluate(()=>network.length),0);assert.equal(await page.locator('dialog.profile-shop-dialog').count(),0);page.noExternal();
});
test('native host phone and laptop show original art without overflow or fake live balances',{timeout:20000},async t=>{
 for(const [name,width,height]of[['phone',360,800],['laptop',1366,768]]){
  const page=await fixture(t,{enabled:false,width,height});await openShop(page);assert.equal(await page.evaluate(()=>network.length+tokenCalls+dbCalls),0);
  await page.evaluate(()=>document.querySelector('.sp-host-gate').textContent='Offline integration fixture. Sample Style Coins, not a live balance.');await page.locator('.sp-host-gate').evaluate(node=>node.hidden=false);
  assert.equal(await page.locator('.sp-art [data-sp-renderer-preview]').count(),PROFILE_SHOP_CATALOG.length);assert.equal(await page.locator('.profile-shop-dialog').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
  await page.screenshot({path:path.join(evidence,`native-profile-shop-v2-${name}.png`),animations:'disabled',timeout:5000});page.noExternal();
 }
});

test('login-409 server-day metadata is bounded and internally consistent',async()=>{
 const {loginClaimWindow}=await import('./profile-shop-host.mjs');
 const day=86400000,claimDay=20000,serverNow=claimDay*day+1000,dayEndsAt=(claimDay+1)*day;
 const value={error:'reward_already_claimed',notCommitted:true,claimDay,serverNow,dayEndsAt};
 assert.equal(loginClaimWindow(value),day-1000);
 for(const change of [{claimDay:claimDay+1},{serverNow:dayEndsAt},{dayEndsAt:dayEndsAt+1},{notCommitted:false},{error:'currency_unavailable'},{claimDay:'20000'},{serverNow:NaN},{serverNow:Infinity},{dayEndsAt:undefined}])assert.equal(loginClaimWindow({...value,...change}),null);
});

test('certified daily denial awards nothing, cools down bounded probes, and preserves server UTC login knowledge',async t=>{
 const page=await fixture(t);await installClock(page);await page.evaluate(()=>{window.claimRejection={error:'reward_already_claimed',notCommitted:true,claimDay:20000,serverNow:20000*86400000+1000,dayEndsAt:20001*86400000};});
 await openShop(page);await settleShop(page);await assertConfirmedBalance(page);assert.equal(await page.evaluate(()=>serverWallet.balance),100);assert.deepEqual(await page.evaluate(()=>claims),['login','milestones','achievements']);
 const initial=await page.evaluate(()=>network.length);await reopenShop(page);assert.equal(await page.evaluate(()=>network.length),initial);
 await page.evaluate(()=>shopElapsed=31000);await reopenShop(page);assert.equal(await page.evaluate(()=>network.length),initial+1);assert.equal(await page.evaluate(()=>claims.length),3);
 await page.evaluate(()=>shopElapsed=900001);await reopenShop(page);assert.deepEqual(await page.evaluate(()=>claims),['login','milestones','achievements','milestones','achievements']);await assertConfirmedBalance(page);
 assert.equal(await page.evaluate(()=>Object.values(localStorage).some(v=>v.includes('claimDay'))),false);assert.equal(await page.evaluate(()=>dbCalls),0);page.noExternal();
});

test('legacy malformed and non-login rejection clocks do not suppress login; ambiguity is never replayed automatically',async t=>{
 for(const [kind,status]of[['bad-clock',409],['legacy',409],['milestone-clock',409],['ambiguous',503]]){
  const page=await fixture(t);await installClock(page);await page.evaluate(({kind,status})=>{
   window.claimStatus=status;const plain={error:'reward_already_claimed',notCommitted:true},clock={claimDay:20000,serverNow:20000*86400000+1000,dayEndsAt:20001*86400000};
   window.claimRejectionsByReward={login:{...plain,...(kind==='bad-clock'?{...clock,dayEndsAt:1}:{})},milestones:{...plain,...(kind==='milestone-clock'?clock:{})},achievements:plain};
  },{kind,status});
  await openShop(page);await settleShop(page);assert.equal(await page.evaluate(()=>serverWallet.balance),100);
  const before=await page.evaluate(()=>claims.length);await page.evaluate(()=>shopElapsed=900001);await reopenShop(page);
  if(status===503){assert.equal(await page.evaluate(()=>claims.length),before);assert.ok(await page.evaluate(()=>Object.entries(localStorage).some(([k,v])=>k.startsWith('polytrack-shop')&&v.includes('requestId'))));}
  else {assert.equal(await page.evaluate(()=>claims.filter(id=>id==='login').length),2);await assertConfirmedBalance(page);}
  assert.equal(await page.evaluate(()=>draftWrites+dbCalls),0);page.noExternal();
 }
});

test('native journal progress, subtitle, goals and shop balance helpers do not inherit serif racer fonts',{timeout:15000},async t=>{
 const page=await fixture(t);await page.evaluate(()=>{document.querySelector('.overall-profile-card').style.fontFamily='"Times New Roman",serif';});
 await page.locator('[data-ph-launch="achievements"]').click();await page.locator('[data-aj-root]').waitFor();await page.evaluate(()=>document.fonts.ready);
 await page.locator('[data-aj-select]:visible').first().click();
 const samples=await page.locator('.aj-summary p,.aj-notice,.aj-progress>span,.aj-node-reward,.aj-inspector-info p,.ph-heading p,[data-aj-select]>strong').evaluateAll(nodes=>nodes.map(node=>({text:node.textContent.slice(0,60),font:getComputedStyle(node).fontFamily,style:getComputedStyle(node).fontStyle})));
 assert.ok(samples.length>5);for(const sample of samples){assert.match(sample.font,/ForcedSquare/i,JSON.stringify(sample));assert.equal(sample.style,'normal');}
 await page.screenshot({path:path.join(evidence,'fixture-achievements-native-body-font-390.png')});
 await page.locator('[data-ph-close]').click();await openShop(page);await settleShop(page);await assertConfirmedBalance(page);
 await page.locator('link[data-profile-shop-css]').evaluate(link=>link.sheet?undefined:new Promise(resolve=>link.addEventListener('load',resolve,{once:true})));await page.evaluate(()=>document.fonts.ready);
 const helpers=await page.locator('.sp-status span,.sp-summary span,.sp-summary p').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).fontFamily));assert.ok(helpers.length>2);for(const font of helpers)assert.match(font,/ForcedSquare/i);page.noExternal();
});

test('public original art preview works with wallet unavailable or gate OFF, without grants, draft changes or spending',{timeout:20000},async t=>{
 for(const enabled of [true,false]){
  const page=await fixture(t,{enabled,width:390,height:844});await page.evaluate(()=>walletUnavailable=true);
  if(!enabled)await page.evaluate(()=>fixtureAuth.emit(null));
  await openShop(page);await page.locator('.sp-item').first().waitFor();
  if(enabled)await page.waitForFunction(()=>document.querySelector('.sp-host-gate')?.textContent.includes('could not be confirmed'));
  assert.equal(await page.locator('[data-sp-action="buy"]:enabled,[data-sp-action="apply"]:enabled,[data-sp-action="claim"]:enabled').count(),0);
  const before=await page.evaluate(()=>({draft:JSON.stringify(profileCosmeticDrafts.get(activeAccount)),requests:network.length,tokens:tokenCalls,writes:draftWrites}));
  await page.locator('[data-sp-action="preview"]').first().click();await page.locator('[data-sp-live-clear]').waitFor();
  assert.equal(await page.locator('[data-ph-tab="studio"]').getAttribute('aria-selected'),'true');assert.match(await page.locator('[data-sp-live-note]').innerText(),/Preview only/);
  const header=await page.evaluate(()=>{const banner=document.querySelector('[data-sp-live-note]').getBoundingClientRect();return {top:banner.top,bottom:banner.bottom,tabsTop:innerHeight,height:innerHeight};});assert.ok(header.top>=0&&header.bottom<=header.height&&header.bottom<=header.tabsTop+1,JSON.stringify(header));
  const after=await page.evaluate(()=>({draft:JSON.stringify(profileCosmeticDrafts.get(activeAccount)),requests:network.length,tokens:tokenCalls,writes:draftWrites}));assert.deepEqual(after,before);
  assert.equal(await page.evaluate(()=>network.filter(row=>row.method==='POST'&&row.path!=='/v1/currency/claim').length+dbCalls+(window.published||0)),0);
  if(!enabled)assert.equal(before.requests+before.tokens,0);
  await page.screenshot({path:path.join(evidence,`fixture-public-shop-preview-${enabled?'wallet-unavailable':'gate-off'}-390.png`)});
  await page.locator('[data-sp-live-clear]').click();assert.equal(await page.evaluate(()=>document.querySelector('#content').__cosmeticPreviewController.isActive()),false);
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

test('fresh login receipt defers same-day probes independently from the wallet cache and reward cooldown',async t=>{
 const page=await fixture(t);await installClock(page);await page.evaluate(()=>{window.freshLoginClock={claimDay:20000,serverNow:20000*86400000+1000,dayEndsAt:20001*86400000};});
 await openShop(page);await settleShop(page);await assertConfirmedBalance(page);assert.deepEqual(await page.evaluate(()=>claims),['login','milestones','achievements']);const count=await page.evaluate(()=>network.length),balance=await page.evaluate(()=>serverWallet.balance);
 await reopenShop(page);assert.equal(await page.evaluate(()=>network.length),count);
 await page.evaluate(()=>shopElapsed=31000);await reopenShop(page);assert.equal(await page.evaluate(()=>network.length),count+1);assert.equal(await page.evaluate(()=>claims.length),3);
 await page.evaluate(()=>shopElapsed=900001);await reopenShop(page);assert.deepEqual(await page.evaluate(()=>claims),['login','milestones','achievements','milestones','achievements']);assert.equal(await page.evaluate(()=>serverWallet.balance),balance);await assertConfirmedBalance(page);
 await page.evaluate(()=>shopElapsed=86400001);await reopenShop(page);assert.equal(await page.evaluate(()=>claims.filter(id=>id==='login').length),2,'expired validated server window allows one probe, not a fabricated grant');assert.equal(await page.evaluate(()=>serverWallet.balance),balance);
 assert.equal(await page.evaluate(()=>Object.values(localStorage).some(v=>/claimDay|balanceAfter|offline-test-token/.test(v))),false);page.noExternal();
});

test('duplicate and malformed fresh receipts never fabricate a balance or authorize automatic ambiguous replay',async t=>{
 for(const change of [{duplicate:true},{dayEndsAt:1},{requestId:'wrong-request-123'},{delta:16}]){
  const page=await fixture(t);await installClock(page);await page.evaluate(change=>{window.freshLoginClock={claimDay:20000,serverNow:20000*86400000+1000,dayEndsAt:20001*86400000};window.claimSuccessOverride=change;},change);
  await openShop(page);await settleShop(page);const before=await page.evaluate(()=>({claims:claims.length,walletReads:network.filter(r=>r.path==='/v1/currency/wallet').length,pending:Object.entries(localStorage).some(([k,v])=>k.startsWith('polytrack-shop')&&v.includes('requestId'))}));
  if(before.walletReads)await assertConfirmedBalance(page);else {const labels=await page.locator('.sp-summary strong').allTextContents();assert.ok(labels.every(text=>/^(Not available|Synchronizing\.\.\.)$/.test(text)),'unconfirmed claim balance is not a wallet: '+JSON.stringify(labels));}
  await page.evaluate(()=>shopElapsed=900001);await reopenShop(page);
  if(before.pending)assert.equal(await page.evaluate(()=>claims.length),before.claims,'pending request is never auto-replayed');else assert.equal(await page.evaluate(()=>claims.filter(id=>id==='login').length),2,'untrusted fresh/duplicate clock does not suppress future probes');
  assert.equal(await page.evaluate(()=>draftWrites+dbCalls),0);page.noExternal();
 }
});

test('late fresh success across auth and account A-B-A cannot update the view or replay a pending claim',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{window.holdClaimResponse=true;window.freshLoginClock={claimDay:20000,serverNow:20000*86400000+1000,dayEndsAt:20001*86400000};});
 await openShop(page);await page.waitForFunction(()=>typeof releaseClaim==='function');
 await page.evaluate(({A,B})=>{fixtureAuth.emit(null);fixtureAuth.emit(fixtureUser);actualAccountTransition(B);activeAccount=B;actualAccountTransition(A);activeAccount=A;holdClaimResponse=false;releaseClaim();},{A,B});
 assert.equal(await page.locator('.profile-shop-dialog').count(),0);await openShop(page);await settleShop(page);
 assert.equal(await page.evaluate(()=>claims.length),1);assert.ok(await page.evaluate(()=>Object.entries(localStorage).some(([k,v])=>k.startsWith('polytrack-shop')&&v.includes('requestId'))));assert.equal(await page.evaluate(()=>draftWrites+dbCalls+(window.published||0)),0);page.noExternal();
});

test('owned Shop preview Escape and Apply round-trip preserve saved styles and only change the Studio draft at all three viewports',{timeout:25000},async t=>{
 for(const [name,width,height]of[['desktop',1366,768],['portrait',390,844],['landscape',844,390]]){
  const owned=PROFILE_SHOP_CATALOG.map(item=>item.id);
  let page=await fixture(t,{width,height,owned});await openShop(page);await page.waitForFunction(count=>document.querySelectorAll('[data-sp-action="apply"]:enabled').length===count,owned.length);
  page=await fixture(t,{width,height,owned,reusePage:page,savedDesign:{plate:'pitlane-ticket',stage:'apex-observatory',stripe:'vector-ribbon'}});
  assert.equal(await page.evaluate(()=>network.length+tokenCalls+dbCalls),0,'saved paid styles use only previously confirmed same-owner inventory on reload');
  await openShop(page);await page.waitForFunction(count=>document.querySelectorAll('[data-sp-action="apply"]:enabled').length===count,owned.length);
  const initial=await page.evaluate(()=>({draft:JSON.stringify(profileCosmeticDrafts.get(activeAccount)),classes:document.querySelector('.overall-profile-card').className,style:document.querySelector('.overall-profile-card').getAttribute('style'),writes:draftWrites,requests:network.length,posts:network.filter(row=>row.method==='POST').length}));
  assert.equal(JSON.parse(initial.draft).plate,'pitlane-ticket');assert.equal(JSON.parse(initial.draft).stage,'apex-observatory');assert.equal(JSON.parse(initial.draft).stripe,'vector-ribbon');
  await page.locator('.sp-host-gate').evaluate(node=>{node.textContent='Offline fixture - confirmed sample inventory, not a live balance.';node.hidden=false;});
  assert.equal(await page.locator('.sp-item').count(),PROFILE_SHOP_CATALOG.length);assert.equal(await page.locator('[data-sp-action="buy"]').count(),0);assert.equal(await page.locator('dialog.profile-shop-dialog').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
  assert.equal(await page.locator('.sp-art [data-sp-renderer-preview]').count(),PROFILE_SHOP_CATALOG.length);
  const names=await page.locator('.sp-art .showcase-row>span>b,.sp-art .profile-preview-stage>span>b').allTextContents();assert.ok(names.every(name=>name.includes('APEX RACER')),'actual source identity replaces generic SVG samples');
  assert.doesNotMatch(await page.locator('#overallProfilePopup > article.overall-profile-card').evaluate(node=>getComputedStyle(node).getPropertyValue('--plate-bg')),/url\(|RACER|text/i);
  await page.screenshot({path:path.join(evidence,`owned-shop-${name}-${width}x${height}.png`),animations:'disabled',timeout:5000});
  await page.locator('[data-sp-action="preview"]').first().click();await page.locator('.cosmetic-preview-banner').waitFor();
  assert.equal(await page.locator('[data-save-profile-cosmetics]').isDisabled(),true);assert.match(await page.locator('.cosmetic-preview-banner strong').innerText(),/Preview only - not applied/);
  await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.querySelector('#content').__cosmeticPreviewController.isActive());
  const restored=await page.evaluate(()=>({draft:JSON.stringify(profileCosmeticDrafts.get(activeAccount)),classes:document.querySelector('.overall-profile-card').className,style:document.querySelector('.overall-profile-card').getAttribute('style'),writes:draftWrites,requests:network.length,posts:network.filter(row=>row.method==='POST').length}));assert.deepEqual(restored,initial,'Escape restores already-owned saved style, no requests or draft writes');
  assert.equal(await page.locator('dialog.profile-hub[open]').count(),1);await page.locator('[data-ph-close]').click();
  await openShop(page);await page.locator('[data-sp-action="apply"][data-sp-id="profile-vector-ribbon"]').click();
  assert.equal(await page.locator('[data-ph-tab="studio"]').getAttribute('aria-selected'),'true');
  const applied=await page.evaluate(()=>({stripe:profileCosmeticDrafts.get(activeAccount).stripe,writes:draftWrites,posts:network.filter(row=>row.method==='POST').length,published:window.published||0,db:dbCalls,preview:document.querySelector('#content').__cosmeticPreviewController.isActive(),unlockIds:nativeEntry.cosmeticUnlocks}));
  assert.equal(applied.stripe,'vector-ribbon');assert.equal(applied.writes,initial.writes+1);assert.equal(applied.posts,initial.posts);assert.equal(applied.published+applied.db,0);assert.equal(applied.preview,false);assert.deepEqual(applied.unlockIds,[]);
  assert.equal(await page.locator('dialog.profile-hub').evaluate(node=>node.scrollWidth<=node.clientWidth),true);await page.screenshot({path:path.join(evidence,`owned-studio-${name}-${width}x${height}.png`)});page.noExternal();
 }
});

test('Style shop launcher lives in Studio controls, outside the preview; mount does no I/O',async t=>{
 const page=await fixture(t,{enabled:false});
 assert.equal(await page.locator('.profile-customizer .profile-customizer-controls > .profile-shop-open').count(),1);
 assert.equal(await page.locator('.profile-achievement-journey + .profile-shop-open').count(),0);
 assert.equal(await page.locator('.profile-shop-open').innerText(),'Style shop');
 assert.equal(await page.locator('.profile-shop-open').getAttribute('aria-haspopup'),'dialog');
 assert.equal(await page.evaluate(()=>network.length+tokenCalls+dbCalls),0);
 await openShop(page);assert.equal(await page.getByRole('dialog',{name:'Style shop',exact:true}).count(),1);
 assert.doesNotMatch(await page.locator('.profile-shop-dialog').innerText(),/\bCP\b|Three original/);
 const price=await page.evaluate(()=>actualShopHost().priceForUi('plate','pitlane-ticket'));assert.equal(price,PROFILE_SHOP_CATALOG.find(item=>item.id==='profile-pitlane-ticket').price);
 assert.equal(await page.evaluate(()=>network.length+tokenCalls+dbCalls),0);page.noExternal();
});

test('real rendered racer stays beside shop while locked preview changes no draft or balance',async t=>{
 for(const [width,height]of [[1366,768],[390,844],[844,390]]){
  const page=await fixture(t,{enabled:false,width,height});
  const expectedName=await page.evaluate(()=>nativeEntry.name);
  assert.equal(await page.locator('[data-ph-launch="shop"]').isVisible(),true);
  await page.locator('[data-ph-launch="shop"]').click();await page.locator('.profile-shop-dialog[open]').waitFor();
  assert.equal(await page.locator('.sp-live-preview>header>strong').innerText(),expectedName);
  const sourceRow=(await page.locator('.profile-customizer .profile-row-showcase').textContent()).replace(/\s+/g,' ').trim();
  assert.equal((await page.locator('[data-sp-live-stage] .profile-row-showcase').textContent()).replace(/\s+/g,' ').trim(),sourceRow);
  assert.equal(await page.locator('[data-sp-live-stage] .profile-preview-stage>span>b').innerText(),expectedName);
  const before=await page.evaluate(()=>({draft:JSON.stringify(profileCosmeticDrafts.get(activeAccount)),writes:draftWrites,network:network.length}));
  await page.locator('[data-sp-action="preview"][data-sp-id="profile-petrol"]').click();await page.locator('[data-sp-live-clear]').waitFor();
  assert.equal(await page.locator('.profile-shop-dialog').evaluate(node=>node.open),true);
  assert.equal(await page.evaluate(()=>document.querySelector('#content').__cosmeticPreviewController.canPublish()),false);
  assert.equal(await page.locator('[data-sp-live-stage] .profile-preview-stage>span>b').innerText(),expectedName);
  assert.equal(await page.locator('[data-sp-live-stage] .profile-preview-stage').evaluate(node=>node.inert),false);
  const layout=await page.locator('.sp-live-preview').evaluate(node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:innerHeight,grid:document.querySelector('.sp-live-layout').getBoundingClientRect().height,visible:r.top>=0&&r.bottom<=innerHeight+1,overflow:document.querySelector('dialog.profile-shop-dialog').scrollWidth>innerWidth};});
  assert.equal(layout.visible,true,JSON.stringify({width,height,layout}));assert.equal(layout.overflow,false);
  assert.deepEqual(await page.evaluate(()=>({draft:JSON.stringify(profileCosmeticDrafts.get(activeAccount)),writes:draftWrites,network:network.length})),before);
  await page.screenshot({path:path.join(evidence,`personal-shop-${width}x${height}.png`)});
  await page.locator('[data-sp-live-clear]').click();assert.equal(await page.evaluate(()=>document.querySelector('#content').__cosmeticPreviewController.canPublish()),true);
  await page.evaluate(()=>document.querySelector('#content').__profileHubClose());assert.equal(await page.locator('dialog[open]').count(),0);
  page.noExternal();
 }
});

test('parent identity callback is account-scoped and does not cause independent reads',async t=>{
 const page=await fixture(t,{enabled:false});
 await page.evaluate(()=>{
  const root=document.querySelector('#content');root.__shopCleanup();window.identityAccount=activeAccount;
  root.__shopCleanup=actualShopHost().bind(root,{accountId:activeAccount,isSelf:true,openStudio:reward=>cleanup.open('studio',reward),getPreviewController:()=>root.__cosmeticPreviewController,getPreviewIdentity:()=>({accountId:identityAccount,name:'Supplied Fixture'})});
 });
 await openShop(page);
 assert.equal(await page.locator('[data-sp-live-stage] .profile-preview-stage>span>b').innerText(),'Supplied Fixture');
 const texts=await page.locator('.sp-art .showcase-row>span>b,.sp-art .profile-preview-stage>span>b').evaluateAll(nodes=>nodes.map(node=>[...node.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent).join('').trim()));assert.equal(texts.length,PROFILE_SHOP_CATALOG.length);assert.ok(texts.every(text=>text==='Supplied Fixture'));
 assert.equal(await page.locator('.sp-art [data-sp-renderer-preview]').evaluateAll(nodes=>nodes.every(node=>node.inert)),true);
 assert.equal(await page.evaluate(()=>network.length+tokenCalls+dbCalls),0);
 await page.evaluate(B=>identityAccount=B,B);await page.locator('[data-sp-action="preview"]').first().click();
 assert.match(await page.locator('[data-sp-live-stage]').innerText(),/unavailable/);
 await page.evaluate(()=>{fixtureAuth.emit(null);fixtureAuth.emit(fixtureUser);});assert.equal(await page.locator('.profile-shop-dialog').count(),0);
 page.noExternal();
});

test('revisioned host bypasses warm unversioned UI/art and propagates the full release query',async t=>{
 const page=await fixture(t,{enabled:false});const requests=[],errors=[];
 page.on('request',request=>requests.push(new URL(request.url()).pathname+new URL(request.url()).search));page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/tools/profile-shop-ui.mjs',route=>route.fulfill({contentType:'text/javascript',body:'export function mountProfileShopUi(){throw Error("stale unversioned UI used");}'}));
 await page.route('**/tools/profile-shop-art.mjs',route=>route.fulfill({contentType:'text/javascript',body:'export function renderProfileShopArt(){throw Error("stale unversioned art used");}'}));
 await page.evaluate(async()=>{
  await import('/tools/profile-shop-ui.mjs');await import('/tools/profile-shop-art.mjs');
  const {createProfileShopHost}=await import('/tools/profile-shop-host.mjs?v=328&probe=cache');
  const root=document.querySelector('#content');root.__shopCleanup();
  window.revisionHost=createProfileShopHost({document,getAccountId:()=>activeAccount,getAuth:()=>fixtureAuth,storage:localStorage,revision:328,enabled:false,fetch:rankedFetch});
  root.__shopCleanup=revisionHost.bind(root,{accountId:activeAccount,isSelf:true,openStudio:reward=>cleanup.open('studio',reward),getPreviewController:()=>root.__cosmeticPreviewController});
  await root.__shopCleanup.open();
 });
 assert.ok(requests.includes('/tools/profile-shop-ui.mjs?v=328&probe=cache'),JSON.stringify(requests));
 assert.ok(requests.includes('/tools/profile-shop-art.mjs?v=328&probe=cache'),JSON.stringify(requests));
 assert.equal(await page.locator('.sp-item').count(),PROFILE_SHOP_CATALOG.length);
 assert.match(await page.locator('.profile-shop-dialog').innerText(),/Style Coins/);
 assert.equal(await page.evaluate(()=>network.length+tokenCalls+dbCalls),0);assert.deepEqual(errors,[]);
 await page.evaluate(()=>revisionHost.dispose());assert.equal(await page.locator('.profile-shop-dialog').count(),0);page.noExternal();
});

test('live mirror follows renderer row updates and replaced stages without draft/storage activity',async t=>{
 const page=await fixture(t,{enabled:false});await openShop(page);
 const before=await page.evaluate(()=>({writes:draftWrites,network:network.length,stored:JSON.stringify(Object.entries(localStorage))}));
 await page.evaluate(()=>{nativeEntry.name='Updated Fixture';const root=document.querySelector('.profile-customizer .profile-row-showcase');root.querySelector('b').textContent='Updated Fixture';});
 await page.waitForFunction(()=>document.querySelector('[data-sp-live-stage] .profile-row-showcase').textContent.includes('Updated Fixture'),null,{timeout:3000});
 assert.equal(await page.locator('.sp-live-preview>header>strong').innerText(),'Updated Fixture');
 await page.evaluate(()=>{const old=document.querySelector('.profile-customizer .profile-preview-stage'),next=old.cloneNode(true);next.dataset.rendererFrame='replacement';old.replaceWith(next);});
 await page.waitForFunction(()=>document.querySelector('[data-sp-live-stage] [data-renderer-frame="replacement"]'),null,{timeout:3000});
 assert.deepEqual(await page.evaluate(()=>({writes:draftWrites,network:network.length,stored:JSON.stringify(Object.entries(localStorage))})),before);
 await page.evaluate(()=>document.querySelector('#content').__shopCleanup());
 await page.evaluate(()=>document.querySelector('.profile-customizer .profile-row-showcase b').textContent='Disposed Fixture');
 assert.equal(await page.locator('.profile-shop-dialog').count(),0);page.noExternal();
});

test('live canvas preview copies existing renderer pixels rather than an empty cloned bitmap',async t=>{
 const page=await fixture(t,{enabled:false});
 await page.evaluate(()=>{const canvas=document.createElement('canvas');canvas.width=16;canvas.height=8;canvas.dataset.rendererFixture='';const context=canvas.getContext('2d');context.fillStyle='#2468ac';context.fillRect(0,0,16,8);document.querySelector('.profile-customizer .profile-preview-stage').append(canvas);});
 await openShop(page);
 assert.deepEqual(await page.locator('[data-sp-live-stage] canvas').evaluate(node=>[...node.getContext('2d').getImageData(0,0,1,1).data]),[36,104,172,255]);
 await page.evaluate(()=>{const canvas=document.querySelector('.profile-customizer canvas'),context=canvas.getContext('2d');context.fillStyle='#aabbcc';context.fillRect(0,0,16,8);document.querySelector('#content').__profileShopRefreshPreview();});
 assert.deepEqual(await page.locator('[data-sp-live-stage] canvas').evaluate(node=>[...node.getContext('2d').getImageData(0,0,1,1).data]),[170,187,204,255]);
 assert.equal(await page.evaluate(()=>network.length+tokenCalls+dbCalls+draftWrites),0);
 assert.equal(await page.locator('[data-sp-live-stage] .profile-preview-stage').evaluate(node=>node.inert),false);page.noExternal();
});

test('live preview has category links instead of redundant Workshop or Shop launchers',async t=>{
 const page=await fixture(t,{enabled:false});await openShop(page);
 assert.equal(await page.locator('[data-sp-live-garage],.sp-live-preview .profile-shop-open').count(),0);
 await page.locator('[data-sp-live-stage] [data-studio-preview-part="stage"]').click();
 assert.equal(await page.locator('.profile-shop-dialog').count(),0);assert.equal(await page.locator('[data-studio-tab="car"]').getAttribute('aria-selected'),'true');
 assert.equal(await page.evaluate(()=>network.length+tokenCalls+dbCalls+draftWrites),0);page.noExternal();
});

test('canvas-only frames and supplied identity refresh without DOM changes; disposal stops mirror work',async t=>{
 const page=await fixture(t,{enabled:false});await page.evaluate(()=>{const c=document.createElement('canvas');c.width=4;c.height=4;c.getContext('2d').fillRect(0,0,4,4);document.querySelector('.profile-customizer .profile-preview-stage').append(c);});await openShop(page);
 await page.evaluate(()=>{nativeEntry.name='Fresh Fixture';const c=document.querySelector('.profile-customizer canvas');c.getContext('2d').fillStyle='#aabbcc';c.getContext('2d').fillRect(0,0,4,4);});
 await page.waitForFunction(()=>document.querySelector('.sp-live-preview>header>strong')?.textContent==='Fresh Fixture');
 await page.waitForFunction(()=>{let c=document.querySelector('[data-sp-live-stage] canvas');return c?.getContext('2d').getImageData(0,0,1,1).data[0]===170;});
 await page.evaluate(()=>document.querySelector('#content').__shopCleanup());assert.equal(await page.locator('.profile-shop-dialog').count(),0);assert.equal(await page.evaluate(()=>network.length+tokenCalls+dbCalls+draftWrites),0);page.noExternal();
});

test('valid seven-tier milestone receipt settles once and is reflected only by the final authoritative wallet',async t=>{
 const page=await fixture(t);await page.evaluate(()=>{window.milestoneClaimDelta=280;window.milestoneClaimIds=['tracks-1','tracks-5','tracks-20','tracks-35','tracks-50','tracks-70','tracks-89'];window.claimRejectionsByReward={login:{error:'reward_already_claimed',notCommitted:true},achievements:{error:'reward_already_claimed',notCommitted:true}};});
 await openShop(page);await settleShop(page);await assertConfirmedBalance(page);assert.equal(await page.evaluate(()=>serverWallet.balance),380);assert.deepEqual(await page.evaluate(()=>claims),['login','milestones','achievements']);assert.equal(await page.evaluate(()=>network.filter(r=>r.path==='/v1/currency/wallet').length),1);
 const before=await page.evaluate(()=>network.length);await reopenShop(page);assert.equal(await page.evaluate(()=>network.length),before);assert.equal(await page.evaluate(()=>draftWrites+(window.published||0)+dbCalls),0);page.noExternal();
});

test('achievement capability makes one bounded durable claim and accepts only the authoritative completion wallet',async t=>{
 const page=await fixture(t);await page.evaluate(async()=>{
  const root=document.querySelector('#content');root.__shopCleanup();actualShopHost().dispose();const {createProfileShopHost}=await import('/tools/profile-shop-host.mjs');
  window.claimRejectionsByReward={login:{error:'reward_already_claimed',notCommitted:true},milestones:{error:'reward_already_claimed',notCommitted:true}};
  window.achievementHost=createProfileShopHost({document,getAccountId:()=>activeAccount,getAuth:()=>fixtureAuth,storage:localStorage,revision:390,enabled:true,achievementClaimsEnabled:true,fetch:rankedFetch});
  root.__shopCleanup=achievementHost.bind(root,{accountId:activeAccount,isSelf:true,openStudio:reward=>cleanup.open('studio',reward),getPreviewController:()=>root.__cosmeticPreviewController});
 });await openShop(page);await settleShop(page);await assertConfirmedBalance(page);
 assert.equal(await page.evaluate(()=>serverWallet.balance),100+ACHIEVEMENT_COIN_SCHEDULE.reduce((n,r)=>n+r.amount,0));const posts=await page.evaluate(()=>network.filter(r=>r.method==='POST'));assert.deepEqual(posts.map(r=>r.body.rewardId),['login','milestones','achievements']);assert.ok(posts.every(r=>r.body.accountId===A&&r.body.requestId));assert.equal(await page.evaluate(()=>network.filter(r=>r.path==='/v1/currency/wallet').length),1);
 const before=await page.evaluate(()=>network.length);await reopenShop(page);assert.equal(await page.evaluate(()=>network.length),before);assert.equal(await page.evaluate(()=>draftWrites+dbCalls+(window.published||0)),0);page.noExternal();
});

async function authRestoreFixture(t,{existing=false,notify=false}={}){
 const page=await fixture(t,{enabled:false});
 await page.evaluate(async({existing,notify})=>{
  actualShopHost().dispose();const {createProfileShopHost}=await import('/tools/profile-shop-host.mjs');
  if(existing)fixtureAuth.currentUser=null;
  window.restoredAuth=existing?fixtureAuth:null;window.prepareCalls=0;
  window.restoringHost=createProfileShopHost({document,getAccountId:()=>activeAccount,getAuth:()=>restoredAuth,storage:localStorage,revision:321,enabled:true,
   prepareAuth:async()=>{prepareCalls++;await new Promise(resolve=>window.releaseAuthRestore=resolve);restoredAuth=fixtureAuth;if(existing)fixtureAuth.emit(fixtureUser);if(notify)restoringHost.observeAuth(fixtureAuth);},
   fetch:async(url,options)=>{if(new URL(url).pathname==='/v1/currency/claim'){network.push({path:'/v1/currency/claim',method:'POST',body:JSON.parse(options.body)});return Response.json({error:'reward_already_claimed',notCommitted:true},{status:409});}return rankedFetch(url,options);}});
  const root=document.querySelector('#content');root.__shopCleanup=restoringHost.bind(root,{accountId:activeAccount,isSelf:true,openStudio:reward=>cleanup.open('studio',reward),getPreviewController:()=>root.__cosmeticPreviewController,getPreviewIdentity:()=>({accountId:activeAccount,name:nativeEntry.name})});
 },{existing,notify});return page;
}

test('auth restore is explicit, coalesced, and finishes before the first scoped store load',async t=>{
 const page=await authRestoreFixture(t);assert.deepEqual(await page.evaluate(()=>({prepares:prepareCalls,network:network.length,dialogs:document.querySelectorAll('.profile-shop-dialog').length})),{prepares:0,network:0,dialogs:0});
 const pending=await page.evaluate(()=>{window.firstOpen=document.querySelector('#content').__shopCleanup.open();window.secondOpen=document.querySelector('#content').__shopCleanup.open();return {same:firstOpen===secondOpen,prepares:prepareCalls,network:network.length,dialogs:document.querySelectorAll('.profile-shop-dialog').length};});assert.deepEqual(pending,{same:true,prepares:1,network:0,dialogs:0});
 assert.equal(await page.evaluate(async()=>{releaseAuthRestore();return await firstOpen;}),true);
 assert.equal(await page.evaluate(()=>network.filter(row=>row.path==='/v1/currency/wallet').length),1);
 assert.equal(await page.evaluate(()=>network.filter(row=>row.path==='/v1/currency/claim').length),2);
 assert.doesNotMatch(await page.locator('.profile-shop-dialog').innerText(),/Connect Cloud Save|Sign in to check/);assert.equal(await page.evaluate(()=>dbCalls),0);await page.evaluate(()=>restoringHost.dispose());page.noExternal();
});

test('auth restore cannot reopen or load after account A-B-A, explicit close, or disposal',async t=>{
 for(const mode of ['account','close','dispose']){
  const page=await authRestoreFixture(t);await page.evaluate(()=>{window.pendingOpen=document.querySelector('#content').__shopCleanup.open();});
  await page.evaluate(({mode,A,B})=>{if(mode==='account'){restoringHost.noteAccountTransition(B);activeAccount=B;restoringHost.noteAccountTransition(A);activeAccount=A;}else if(mode==='close')document.querySelector('#content').__profileShopClose();else restoringHost.dispose();},{mode,A,B});
  assert.equal(await page.evaluate(async()=>{releaseAuthRestore();return await pendingOpen;}),false,mode);
  assert.equal(await page.evaluate(()=>network.length+tokenCalls+dbCalls),0,mode);assert.equal(await page.locator('.profile-shop-dialog').count(),0);await page.evaluate(()=>restoringHost.dispose());page.noExternal();
 }
});

test('auth restore opens on the first click when the parent notifies observeAuth before resolving',async t=>{
 const page=await authRestoreFixture(t,{notify:true});await page.evaluate(()=>{window.pendingOpen=document.querySelector('#content').__shopCleanup.open();});
 assert.equal(await page.evaluate(async()=>{releaseAuthRestore();return await pendingOpen;}),true);
 assert.equal(await page.locator('.profile-shop-dialog[open]').count(),1);assert.equal(await page.evaluate(()=>network.filter(row=>row.path==='/v1/currency/wallet').length),1);assert.equal(await page.evaluate(()=>dbCalls),0);await page.evaluate(()=>restoringHost.dispose());page.noExternal();
});

test('auth restore permits the existing same-SDK null UID to initial owner callback only in the explicit scope',async t=>{
 const page=await authRestoreFixture(t,{existing:true,notify:true});await page.evaluate(()=>{window.pendingOpen=document.querySelector('#content').__shopCleanup.open();});
 assert.equal(await page.evaluate(async()=>{releaseAuthRestore();return await pendingOpen;}),true);
 assert.equal(await page.locator('.profile-shop-dialog[open]').count(),1);assert.equal(await page.evaluate(()=>network.filter(row=>row.path==='/v1/currency/wallet').length),1);await page.evaluate(()=>restoringHost.dispose());page.noExternal();
});

test('auth restore rejects owner UID A-B-A, SDK replacement, and callback reset followed by explicit close',async t=>{
 for(const mode of ['uid-aba','sdk','close-after-bootstrap']){
  const page=await authRestoreFixture(t,{existing:true,notify:true});await page.evaluate(()=>{window.pendingOpen=document.querySelector('#content').__shopCleanup.open();});
  await page.evaluate(mode=>{
   if(mode==='uid-aba'){fixtureAuth.emit(fixtureUser);fixtureAuth.emit({...fixtureUser,uid:'other-owner'});fixtureAuth.emit(fixtureUser);}
   else if(mode==='sdk'){restoredAuth={currentUser:fixtureUser};restoringHost.observeAuth(restoredAuth);}
   else{fixtureAuth.emit(fixtureUser);document.querySelector('#content').__profileShopClose();}
  },mode);
  assert.equal(await page.evaluate(async()=>{releaseAuthRestore();return await pendingOpen;}),false,mode);assert.equal(await page.evaluate(()=>network.length+tokenCalls+dbCalls),0,mode);assert.equal(await page.locator('.profile-shop-dialog').count(),0);await page.evaluate(()=>restoringHost.dispose());page.noExternal();
 }
});
