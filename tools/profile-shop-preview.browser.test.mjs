import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {PROFILE_SHOP_CATALOG,PROFILE_SHOP_CATALOG_VERSION} from './profile-shop-catalog.mjs';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const cosmeticClass=grant=>`cosmetic-${grant.slot.replace(/[A-Z]/g,c=>'-'+c.toLowerCase())}-${grant.value}`;
const root=fileURLToPath(new URL('../',import.meta.url)),account='a'.repeat(64);
const evidence=process.env.PROFILE_SHOP_EVIDENCE_DIR||path.resolve(root,'../../2026-11-14/profile-shop-originals');
let browser,server,base,patch,nativeFixture;
before(async()=>{
 patch=await fs.readFile(path.join(root,'polytrack_062_patch.js'),'utf8');
 // Reuse the existing actual-native-markup fixture without running its test matrix.
 const helpers=await fs.readFile(new URL('./profile-achievement-bridge.test.mjs',import.meta.url),'utf8');
 const start=helpers.indexOf('async function nativeFixture(page)'),end=helpers.indexOf('\ntest(',start);
 assert.ok(start>=0&&end>start);
 const extract=name=>{const m=patch.match(new RegExp(`  function ${name}\\([^\\n]*\\)\\{[\\s\\S]*?\\n  \\}`));assert.ok(m,name);return m[0];};
 server=http.createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname;
  if(name==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>@font-face{font-family:ForcedSquare;src:url(/forced_square.woff2)}body{margin:0;background:#192a56;color:white;font-family:ForcedSquare,sans-serif}</style><p>Offline art test preview. Wallet and purchases are disabled.</p><div id="overallLeaderboardPanel" style="display:flex"><div id="overallProfilePopup" style="display:flex"><article class="overall-profile-card"><div id="content"></div></article></div></div>');return;}
  if(!/^\/tools\/[A-Za-z0-9_.-]+\.(mjs|css)$/.test(name)&&!['/forced_square.woff2','/images/car_thumbnail_placeholder.png'].includes(name)){res.writeHead(404).end();return;}
  try{res.setHeader('content-type',name.endsWith('.mjs')?'text/javascript':name.endsWith('.css')?'text/css':name.endsWith('.png')?'image/png':'font/woff2');res.end(await fs.readFile(path.join(root,name.slice(1))));}catch{res.writeHead(404).end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base=`http://127.0.0.1:${server.address().port}`;
 nativeFixture=new Function('patch','extract','base','assert','return ('+helpers.slice(start,end).replaceAll("'racer-a'",JSON.stringify(account))+')')(patch,extract,base,assert);
 browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});await fs.mkdir(evidence,{recursive:true});
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));});
async function fixture(t,width=390,height=844){
 const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce'});t.after(()=>context.close());const page=await context.newPage();let external=0;
 await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():(external++,route.abort()));await page.goto(base);await nativeFixture(page);
 await page.addStyleTag({url:base+'/tools/cosmetic-preview.css'});
 await page.evaluate(async account=>{
  const {PROFILE_SHOP_CATALOG}=await import('/tools/profile-shop-catalog.mjs');
  const {bindCosmeticPreview}=await import('/tools/cosmetic-preview.mjs');const {bindProfileShopPreview}=await import('/tools/profile-shop-preview.mjs');
  window.activeAccount=account;window.authScope='auth-one';window.liveCatalog={version:2,items:PROFILE_SHOP_CATALOG};
  const content=document.querySelector('#content'),studio=content.querySelector('.profile-customizer'),card=content.closest('.overall-profile-card');
  // Fixture-only proposed catalog insertion. Parent alone owns production insertion
  // after server/union/rules tests. No ownership or publication is mocked as granted.
  for(const item of PROFILE_SHOP_CATALOG){const grant=item.grants[0];if(!nativeCatalog[grant.slot].some(row=>row[0]===grant.value))nativeCatalog[grant.slot].push([grant.value,item.label,'shop-pending']);}
  studio.innerHTML=profileCustomizerMarkup(nativeEntry).match(/^<details[^>]*>([\s\S]*)<\/details>$/)[1];
  for(const button of studio.querySelectorAll('[data-cosmetic-choice]'))if(PROFILE_SHOP_CATALOG.some(item=>item.grants[0].slot===button.dataset.cosmeticKind&&item.grants[0].value===button.dataset.cosmeticValue)){
   button.dataset.cosmeticLocked='true';button.removeAttribute('aria-disabled');button.title='Shop design. Preview only.';const text=button.querySelector('small');if(text)text.textContent='Shop design - preview only';
  }
  const draft=()=>({...profileCosmeticDrafts.get(account)});window.originalDraft=JSON.stringify(draft());window.originalUnlocks=JSON.stringify(nativeEntry.cosmeticUnlocks);window.draftWrites=0;const set=profileCosmeticDrafts.set.bind(profileCosmeticDrafts);profileCosmeticDrafts.set=(...args)=>{draftWrites++;return set(...args);};
  window.nativePreview=bindCosmeticPreview(studio,{catalog:nativeCatalog,onPreview:option=>applyProfileCosmetics(card,{...draft(),[option.kind]:option.id}),onRestore:()=>applyProfileCosmetics(card,draft())});
  window.shopPreview=bindProfileShopPreview(content,{accountId:account,getAccountId:()=>activeAccount,getAuthScope:()=>authScope,getCatalog:()=>liveCatalog,getPreviewController:()=>nativePreview,openStudio:reward=>cleanup.open('studio',reward),revision:'original-art-test'});
  document.querySelector('.ph-heading p').textContent='OFFLINE ART TEST - WALLET OFF';
  window.tryDesign=(itemId,signal)=>shopPreview.preview({accountId:account,itemId,previewOnly:true,isCurrent:()=>true,signal});
  window.readState=()=>({draft:JSON.stringify(draft()),writes:draftWrites,publishes:window.published||0,active:nativePreview.isActive(),canPublish:nativePreview.canPublish(),unlocks:JSON.stringify(nativeEntry.cosmeticUnlocks)});
 },account);
 await page.evaluate(()=>document.fonts.ready);page.noExternal=()=>assert.equal(external,0);return page;
}
test('canonical nine-design catalog has exact fixed single-slot grants and prices, deeply frozen, with version two',()=>{
 assert.equal(PROFILE_SHOP_CATALOG_VERSION,2);
 assert.deepEqual(PROFILE_SHOP_CATALOG.map(item=>[item.id,item.label,item.price,item.grants]),[
  ['profile-pitlane-ticket','Pitlane Ticket',20,[{slot:'plate',value:'pitlane-ticket'}]],
  ['profile-apex-observatory','Apex Observatory',30,[{slot:'stage',value:'apex-observatory'}]],
  ['profile-vector-ribbon','Vector Ribbon',50,[{slot:'stripe',value:'vector-ribbon'}]],
  ['profile-petrol','Petrol',16,[{slot:'theme',value:'petrol'}]],
  ['profile-navy-secondary','Midnight Navy',20,[{slot:'baseSecondary',value:'navy'}]],
  ['profile-rail','Pit Rail',32,[{slot:'edge',value:'rail'}]],
  ['profile-rally-lines','Rally Lines',36,[{slot:'stripe',value:'rally-lines'}]],
  ['profile-book-serif','Book Serif',45,[{slot:'nameFont',value:'book'}]],
  ['profile-copper-ink','Copper Ink',24,[{slot:'nameColor',value:'copper'}]]
 ]);
 assert.equal(new Set(PROFILE_SHOP_CATALOG.map(item=>item.id)).size,9);assert.ok(Object.isFrozen(PROFILE_SHOP_CATALOG));
 for(const item of PROFILE_SHOP_CATALOG){assert.equal(item.kind,'profile-cosmetic');assert.equal(item.grants.length,1);assert.ok(Object.isFrozen(item)&&Object.isFrozen(item.grants)&&Object.isFrozen(item.grants[0]));assert.equal(Object.hasOwn(item,'style'),false);}
});

test('all nine designs preview through actual Studio classes on phone/laptop, never mutate drafts or publish, and clear safely',{timeout:30000},async t=>{
 for(const [name,width,height]of[['phone',390,844],['laptop',1366,768]]){
  const page=await fixture(t,width,height);await page.evaluate(()=>cleanup.open('studio'));
  for(const item of PROFILE_SHOP_CATALOG){
   const carBefore=await page.locator('.profile-preview-stage>.overall-car-model').evaluate(node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return {width:r.width,height:r.height,clip:s.clipPath,padding:s.padding};});
   await page.evaluate(id=>tryDesign(id),item.id);await page.locator('link[data-profile-shop-art-css][href$="v=original-art-test"]').evaluate(link=>link.sheet?undefined:new Promise(resolve=>link.addEventListener('load',resolve,{once:true})));
   assert.deepEqual(await page.locator('.profile-preview-stage>.overall-car-model').evaluate(node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return {width:r.width,height:r.height,clip:s.clipPath,padding:s.padding};}),carBefore,'original profile art must not alter car geometry');
   const grant=item.grants[0];assert.equal(await page.locator('.overall-profile-card').evaluate((node,cls)=>node.classList.contains(cls),cosmeticClass(grant)),true);
   assert.equal(await page.locator('[data-ph-tab="studio"]').getAttribute('aria-selected'),'true');assert.equal(await page.locator('.cosmetic-preview-banner strong').innerText(),'Preview only - not applied');
   const state=await page.evaluate(()=>readState());assert.equal(state.draft,await page.evaluate(()=>originalDraft));assert.equal(state.writes,0);assert.equal(state.publishes,0);assert.equal(state.canPublish,false);assert.equal(state.unlocks,await page.evaluate(()=>originalUnlocks),'preview never grants ownership');
   await page.locator('[data-save-profile-cosmetics]').dispatchEvent('click');assert.equal(await page.evaluate(()=>window.published||0),0);
   await page.locator('dialog').waitFor({state:'visible'});await page.locator('.profile-customizer-preview').scrollIntoViewIfNeeded();
   await page.screenshot({path:path.join(evidence,`${item.id}-${name}.png`),timeout:5000});
   await page.evaluate(()=>shopPreview.clear());assert.equal(await page.evaluate(()=>readState().unlocks),await page.evaluate(()=>originalUnlocks),'clearing preview never grants ownership');assert.equal(await page.locator('.cosmetic-preview-banner').count(),0);assert.equal(await page.evaluate(()=>readState().active),false);
   assert.equal(await page.locator('.overall-profile-card').evaluate((node,cls)=>node.classList.contains(cls),cosmeticClass(grant)),false);
  }
  assert.equal(await page.locator('dialog').evaluate(node=>node.scrollWidth<=node.clientWidth),true);page.noExternal();
 }
});
test('ticket keeps four-digit ranks readable and low-density art stays static',{timeout:15000},async t=>{
 const page=await fixture(t,1366,768);await page.evaluate(()=>tryDesign('profile-pitlane-ticket'));
 await page.locator('link[data-profile-shop-art-css][href$="v=original-art-test"]').evaluate(link=>link.sheet?undefined:new Promise(resolve=>link.addEventListener('load',resolve,{once:true})));
 const ranks=await page.locator('.showcase-row>strong').evaluateAll(nodes=>nodes.map((node,index)=>{
  node.textContent=['#1','#999','#9999'][index];const range=document.createRange();range.selectNodeContents(node);const text=range.getBoundingClientRect(),r=node.getBoundingClientRect();return {label:node.textContent,width:r.width,textWidth:text.width,inside:text.left>=r.left&&text.right<=r.right,scrollFits:node.scrollWidth<=node.clientWidth,font:getComputedStyle(node).fontSize};
 }));assert.ok(ranks.every(row=>row.inside&&row.scrollFits),JSON.stringify(ranks));
 await page.evaluate(()=>{document.querySelector('.overall-profile-card').dataset.profileArtDensity='low';tryDesign('profile-apex-observatory');});
 const staticArt=await page.locator('.profile-preview-stage>.overall-car-model').evaluate(node=>({animation:getComputedStyle(node).animationName,stage:getComputedStyle(node).getPropertyValue('--stage-bg')}));
 assert.equal(staticArt.animation,'none');assert.match(staticArt.stage,/data-profile-art-density%3D%22low/);
 page.noExternal();
});
test('abort, stale auth/account, invalid catalog and detach cannot preview; abort cannot clear a newer native preview',{timeout:15000},async t=>{
 const page=await fixture(t);
 const result=await page.evaluate(()=>{
  const errors=[],attempt=request=>{try{shopPreview.preview(request);errors.push('unexpected-pass');}catch(error){errors.push(error.code);}};
  const request={accountId:activeAccount,itemId:'profile-pitlane-ticket',previewOnly:true,isCurrent:()=>true};
  const aborted=new AbortController();aborted.abort();attempt({...request,signal:aborted.signal});
  attempt({...request,itemId:'mint-rally'});const catalog=liveCatalog;liveCatalog={...catalog,version:1};attempt(request);liveCatalog=catalog;
  authScope='auth-two';attempt(request);authScope='auth-one';
  const controller=new AbortController();tryDesign(request.itemId,controller.signal);controller.abort();const abortedCleared=!nativePreview.isActive();
  const next=new AbortController();tryDesign(request.itemId,next.signal);nativePreview.preview({kind:'theme',id:'cyan'});next.abort();const newerSurvives=nativePreview.currentOption()?.id==='cyan';nativePreview.clear();
  document.querySelector('#content').remove();attempt(request);
  return {errors,abortedCleared,newerSurvives,state:readState()};
 });
 assert.ok(result.errors.every(code=>['stale_profile_preview','profile_preview_unavailable'].includes(code)));assert.equal(result.errors.length,5);assert.equal(result.abortedCleared,true);assert.equal(result.newerSurvives,true);assert.equal(result.state.writes,0);assert.equal(result.state.publishes,0);page.noExternal();
});
