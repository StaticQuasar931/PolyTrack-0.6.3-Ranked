import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import {startResponsiveServer} from './responsive-server.mjs';
import {installNativeRankedAuditFixture} from './native-ranked-audit-fixture.mjs';
const {chromium}=createRequire(new URL('./verifier/package.json',import.meta.url))('playwright');

test('home and track selection fit offset visual viewports through rotation',{timeout:180000},async()=>{
 const server=await startResponsiveServer(),browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 let page;
 try{
  page=await browser.newPage({viewport:{width:440,height:800},isMobile:true,hasTouch:true});
  await installNativeRankedAuditFixture(page,{rejectWrites:true});
  await page.route(url=>url.origin!==new URL(server.url).origin,route=>new URL(route.request().url()).pathname==='/v6/user'?route.fulfill({status:200,contentType:'application/json',body:'null'}):route.abort());
  await page.goto(server.url,{waitUntil:'domcontentloaded'});
  await page.waitForFunction(()=>[...document.querySelectorAll('.main-buttons-container:not(.hidden),.track-selection-ui:not(.hidden),button')].some(n=>n.getClientRects().length&&(n.matches('.main-buttons-container,.track-selection-ui')||n.textContent.trim()==='Exit')),null,{timeout:60000});
  if(await page.getByRole('button',{name:'Exit',exact:true}).isVisible()){
   await page.getByRole('button',{name:'Exit',exact:true}).click();
   await page.locator('.track-selection-ui:not(.hidden)').waitFor();
  }
  if(await page.locator('.track-selection-ui:not(.hidden)').isVisible())await page.getByRole('button',{name:'Back',exact:true}).click();
  await page.locator('.main-buttons-container:not(.hidden)').waitFor();
  await page.locator('#injectedRankingsBtn.ranked-ready').waitFor({timeout:45000});
  for(const mode of ['home','selection']){
   if(mode==='selection')await page.locator('.main-buttons-container .button-image').filter({hasText:/^\s*Play\s*$/}).click();
   for(const [width,height,visibleWidth,visibleHeight,left,top]of [[440,800,414,720,26,12],[956,440,900,330,28,0],[440,800,440,800,0,0]]){
    await page.setViewportSize({width,height});
    await page.evaluate(({visibleWidth,visibleHeight,left,top})=>{
     for(const [key,value]of Object.entries({width:visibleWidth,height:visibleHeight,offsetLeft:left,offsetTop:top}))Object.defineProperty(visualViewport,key,{configurable:true,get:()=>value});
     visualViewport.dispatchEvent(new Event('resize'));
    },{visibleWidth,visibleHeight,left,top});
    await page.waitForFunction(({visibleWidth,visibleHeight})=>parseFloat(document.documentElement.style.getPropertyValue('--sq-available-width'))===visibleWidth&&parseFloat(document.documentElement.style.getPropertyValue('--sq-available-height'))===visibleHeight,{visibleWidth,visibleHeight});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    const selectors=mode==='home'?'.main-buttons-container>.button-image,.menu-ui>.info,#staticMenu':'.track-selection-ui>.bar,.track-selection-ui>.image-button-container,.track-selection-ui>.tracks-container.open';
    if(mode==='home')assert.equal(await page.locator('.main-buttons-container>.button-image').count(),6);
    const boxes=await page.locator(selectors).evaluateAll(nodes=>nodes.map(n=>({text:n.textContent.slice(0,50),...n.getBoundingClientRect().toJSON()})));
    for(const box of boxes)assert.ok(box.x>=left-1&&box.right<=left+visibleWidth+1&&box.top>=top-1&&box.bottom<=top+visibleHeight+1,JSON.stringify({mode,width,height,visibleWidth,visibleHeight,left,top,box}));
    if(mode==='selection'){
     const cards=page.locator('.tracks-container.open .track:not(.hidden)>.button');
     assert.equal(await cards.count(),17);
     await cards.last().scrollIntoViewIfNeeded();
     const last=await cards.last().boundingBox();
     assert.ok(last.y+last.height<=top+visibleHeight+1,JSON.stringify({width,height,visibleHeight,top,last}));
    }
    if(process.env.POLYTRACK_OFFSET_CAPTURE){await fs.mkdir(process.env.POLYTRACK_OFFSET_CAPTURE,{recursive:true});await page.screenshot({path:`${process.env.POLYTRACK_OFFSET_CAPTURE}/${mode}-${width}x${height}-${left}.png`});}
   }
  }
 }catch(error){
  if(page&&process.env.POLYTRACK_OFFSET_CAPTURE){await fs.mkdir(process.env.POLYTRACK_OFFSET_CAPTURE,{recursive:true});await page.screenshot({path:process.env.POLYTRACK_OFFSET_CAPTURE+'/failure.png'});await fs.writeFile(process.env.POLYTRACK_OFFSET_CAPTURE+'/failure.txt',await page.locator('body').innerText());await fs.writeFile(process.env.POLYTRACK_OFFSET_CAPTURE+'/failure.json',JSON.stringify(await page.evaluate(()=>({audit:window.__ptNativeRankedAudit,viewport:document.documentElement.style.cssText})),null,2));}
  throw error;
 }finally{await browser.close();await server.close();}
});
