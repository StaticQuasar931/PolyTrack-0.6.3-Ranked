import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import fs from 'node:fs/promises';
import {installNativeRankedAuditFixture,auditNativeRankedClick} from './native-ranked-audit-fixture.mjs';
import {startResponsiveServer} from './responsive-server.mjs';

const url=String(process.env.POLYTRACK_NATIVE_AUDIT_URL||'').trim();

test('native Ranked Help fits phone, portrait, landscape, and desktop viewports', {timeout:120000}, async t=>{
 const server=url?null:await startResponsiveServer();
 if(server)t.after(()=>server.close());
 const target=url||server.url;
 assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(target).hostname),'native Help audit is loopback-only');
 const require=createRequire(new URL('./verifier/package.json',import.meta.url));
 const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage({viewport:{width:1366,height:768},serviceWorkers:'block'}),localOrigin=new URL(target).origin;
  await page.route('**/*',route=>{
   const request=route.request(),requestUrl=new URL(request.url());
   if(requestUrl.pathname==='/v6/user')return route.fulfill({status:200,contentType:'application/json',body:'null'});
   if(requestUrl.origin===localOrigin&&['GET','HEAD'].includes(request.method()))return route.continue();
   return route.abort('blockedbyclient');
  });
  await installNativeRankedAuditFixture(page,{rejectWrites:true});
  await page.addLocatorHandler(page.locator('dialog[data-site-installed-revision][open]'),async dialog=>{
   await dialog.getByRole('button',{name:'OK',exact:true}).click();
  });
  await page.goto(target,{waitUntil:'domcontentloaded'});
  let ranked;
  try{ranked=await auditNativeRankedClick(page);}catch(error){
   t.diagnostic(JSON.stringify({nativeStartup:await page.evaluate(()=>({text:document.body.innerText.slice(0,1400),audit:window.__ptNativeRankedAudit}))}));
   throw error;
  }
  assert.equal(ranked.panelConnected,true,'the real Ranked panel must be open');
  assert.deepEqual(ranked.errors,[]);assert.deepEqual(ranked.rejections,[]);assert.deepEqual(ranked.pageErrors,[]);
  // Help remains usable while standings are loading or unavailable.
  await page.locator('#overallHelpBtn').waitFor({state:'visible'});
  await page.locator('#overallHelpBtn').click();
  const popup=page.locator('#overallHelpPopup'),card=popup.locator('.overall-help-card');
  await popup.waitFor({state:'visible'});
  await popup.locator('[data-help-controls]').waitFor({state:'visible'});
  if(process.env.HELP_CSS_PROPOSAL)await page.addStyleTag({path:process.env.HELP_CSS_PROPOSAL});
  await page.keyboard.down('a');
  assert.ok(await popup.locator('[data-hc-key="A"].is-pressed:visible').count()>0,'native Help keys react from opening focus, without clicking its content');
  await page.keyboard.up('a');
  await popup.locator('[data-hc-view="release"]').click();
  assert.equal(await popup.locator('[data-hc-panel="release"]').isVisible(),true,'relocated release tab remains functional');
  await page.keyboard.press('Control+f');
  assert.equal(await popup.locator('[data-hc-search]').evaluate(node=>node===document.activeElement),true);
  assert.equal(await popup.locator('[data-hc-view="controls"]').getAttribute('aria-pressed'),'true');
  await page.locator('#overallHelpClose').focus();
  const screenshotDir=process.env.POLYTRACK_NATIVE_HELP_SCREENSHOT_DIR;
  if(screenshotDir)await fs.mkdir(screenshotDir,{recursive:true});
  for(const [width,height] of [[1366,768],[390,844],[844,390],[320,568]]){
   await page.setViewportSize({width,height});
    await card.evaluate(node=>{node.scrollTop=0;});
    const toolbar=await popup.evaluate(node=>{
      const rect=element=>{const r=element.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};};
      return {head:rect(node.querySelector('.overall-help-head')),tabs:rect(node.querySelector('.hc-view-switch')),search:rect(node.querySelector('.hc-search-field'))};
    });
    assert.ok(toolbar.tabs.top>=toolbar.head.top-1&&toolbar.tabs.bottom<=toolbar.head.bottom+1,'view tabs stay in the toolbar, not over search');
    assert.ok(toolbar.search.top>=toolbar.head.bottom-1,'search remains below the toolbar');
   await card.evaluate(node=>{node.scrollTop=0;});
   const layout=await page.evaluate(()=>{
    const popup=document.querySelector('#overallHelpPopup'),card=popup.querySelector('.overall-help-card');
    const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    const overflow=[...card.querySelectorAll('*')].filter(node=>{
      if(node.closest('.hc-sr-only'))return false;
      const style=getComputedStyle(node);
      return node.clientWidth&&node.scrollWidth>node.clientWidth+1&&style.overflowX==='visible'&&style.clipPath==='none'&&node.getAttribute('aria-hidden')!=='true';
    }).map(node=>({selector:node.className||node.tagName,clientWidth:node.clientWidth,scrollWidth:node.scrollWidth}));
    return {popupDisplay:getComputedStyle(popup).display,popup:rect(popup),card:rect(card),cardClientWidth:card.clientWidth,cardScrollWidth:card.scrollWidth,cardClientHeight:card.clientHeight,cardScrollHeight:card.scrollHeight,overflow,documentWidth:document.documentElement.scrollWidth};
   });
   t.diagnostic(JSON.stringify({nativeHelpLayout:{width,height,...layout}}));
   if(screenshotDir&&(width===390||width===1366))await page.screenshot({path:join(screenshotDir,`ranked-help-${width}.png`)});
   assert.notEqual(layout.popupDisplay,'none',`Help remains open at ${width}x${height}`);
   assert.ok(layout.popup.left>=-1&&layout.popup.right<=width+1,`Help overlay stays in viewport at ${width}x${height}`);
   assert.ok(layout.popup.top>=-1&&layout.popup.bottom<=height+1,`Help overlay stays in viewport vertically at ${width}x${height}`);
   assert.ok(layout.card.left>=-1&&layout.card.right<=width+1,`Help card stays in viewport horizontally at ${width}x${height}`);
   assert.ok(layout.card.top>=-1&&layout.card.bottom<=height+1,`Help card stays in viewport vertically at ${width}x${height}`);
   assert.ok(layout.cardScrollWidth<=layout.cardClientWidth+1,`Help card has no horizontal overflow at ${width}x${height}`);
   assert.ok(layout.documentWidth<=width+1,`Help does not widen the page at ${width}x${height}`);
   assert.deepEqual(layout.overflow,[],`Help text and cards have no horizontal overflow at ${width}x${height}`);
   const metrics=await popup.evaluate(node=>{
    const first=node.querySelector('.hc-row'),label=first.querySelector('dt');
    return {width:innerWidth,firstControlTop:Math.round(first.getBoundingClientRect().top),labelFont:getComputedStyle(label).fontSize,cardWidth:Math.round(node.querySelector('.overall-help-card').getBoundingClientRect().width)};
   });
   t.diagnostic(JSON.stringify({nativeHelp:metrics}));
   await popup.locator('.hc-essentials').evaluate(node=>{node.open=true;});
   for(const selector of ['[data-help-action]','#overallHelpClose']){
    const action=card.locator(selector).last();
    await action.scrollIntoViewIfNeeded();
    const bounds=await action.boundingBox();
    assert.ok(bounds&&bounds.x>=0&&bounds.x+bounds.width<=width+1,`${selector} is horizontally reachable at ${width}x${height}`);
    assert.ok(bounds&&bounds.y>=0&&bounds.y+bounds.height<=height+1,`${selector} is vertically reachable by scrolling at ${width}x${height}`);
   }
   await popup.locator('.hc-essentials').evaluate(node=>{node.open=false;});
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await popup.locator('.hc-header').evaluate(node=>getComputedStyle(node).animationName),'none');
  await page.keyboard.press('Escape');
  await popup.waitFor({state:'hidden'});
  assert.equal(await page.locator('#overallLeaderboardPanel').evaluate(node=>getComputedStyle(node).display!=='none'),true,'Escape closes Help without closing Ranked');
 }finally{await browser.close();}
});
