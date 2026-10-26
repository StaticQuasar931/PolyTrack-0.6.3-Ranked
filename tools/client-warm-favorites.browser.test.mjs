import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {startResponsiveServer} from './responsive-server.mjs';
import {installNativeRankedAuditFixture} from './native-ranked-audit-fixture.mjs';
import {installActualClientAuditBindings,installNextPackageAudit} from './client-native-package-audit.mjs';
const {chromium}=createRequire(new URL('./verifier/package.json',import.meta.url))(process.env.PLAYWRIGHT_MODULE||'playwright');
async function createAuditFixture(t){
  const output=process.env.POLYTRACK_CLIENT_AUDIT_OUTPUT
    ? path.resolve(process.env.POLYTRACK_CLIENT_AUDIT_OUTPUT)
    : await fs.mkdtemp(path.join(tmpdir(),'polytrack-client-audit-'));
  t.diagnostic('Client audit evidence: '+output);
  await fs.mkdir(output,{recursive:true});
  const server=await startResponsiveServer();
  let browser,closingBrowser;
  const closeBrowser=()=>browser?(closingBrowser ||= browser.close()):undefined;
  // Close active browser requests before draining the server, in either hook order.
  t.after(async()=>{try{await closeBrowser();}finally{await server.close();}});
  browser=await chromium.launch({headless:true,...(process.env.POLYTRACK_TEST_SWIFTSHADER==='1'?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{}),...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  t.after(closeBrowser);
  const page=await browser.newPage({viewport:{width:1366,height:768}});
  t.after(()=>page.close());
  return {server,page,output};
}

test('offline warm native boards remain visible and favorite keys match displayed positions',{timeout:300000},async t=>{
  const {server,page,output}=await createAuditFixture(t);
  const blocked=[],errors=[],trials=[],shortcuts=[],shortFooter=[],consoleMessages=[],requestFailures=[];
  page.on('console',message=>{if(['warning','error'].includes(message.type()))consoleMessages.push(message.text());});
  page.on('requestfailed',request=>requestFailures.push({url:request.url(),error:request.failure()?.errorText}));
  page.on('pageerror',error=>errors.push(String(error?.stack||error)));
  await page.route(url=>url.origin!==new URL(server.url).origin,route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.pathname==='/v6/user')return route.fulfill({status:200,contentType:'application/json',body:'null'});
    if(url.origin===new URL(server.url).origin&&['GET','HEAD'].includes(request.method()))return route.continue();
    blocked.push(url.origin+url.pathname);return route.abort('blockedbyclient');
  });
  await installNativeRankedAuditFixture(page,{rejectWrites:true});
  await page.addInitScript(()=>{
    const state={active:false,started:0,events:[],prior:''};window.__warmAudit=state;
    window.__warmAuditOriginalTimer=window.setTimeout;
    const click=HTMLElement.prototype.click;
    HTMLElement.prototype.click=function(...args){
      if(state.active&&this.matches('.only-verified'))state.events.push({kind:'policy',at:performance.now()-state.started,rows:this.closest('.leaderboard-ui')?.querySelectorAll('.container > button.main').length});
      return click.apply(this,args);
    };
    const sample=()=>{
      if(!state.active)return;
      const board=document.querySelector('.track-info-ui > .leaderboard-ui:not(.sq-event-board)');
      const rows=[...(board?.querySelectorAll('.container > button.main')||[])];
      const snapshot={rows:rows.length,visible:rows.filter(row=>row.getClientRects().length&&getComputedStyle(row).visibility!=='hidden'&&getComputedStyle(row).opacity!=='0').length,loading:document.documentElement.classList.contains('sq-track-leaderboard-loading')};
      const encoded=JSON.stringify(snapshot);
      if(encoded!==state.prior){state.prior=encoded;state.events.push({kind:'state',at:performance.now()-state.started,...snapshot});}
    };
    window.addEventListener('DOMContentLoaded',()=>{
      new MutationObserver(sample).observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:['class','style']});
      const frame=()=>{sample();requestAnimationFrame(frame);};requestAnimationFrame(frame);
    });
  });
  const visibleMenuButton=name=>page.locator('button').filter({hasText:new RegExp('^\\s*'+name+'\\s*$','i')}).last();
  const favoriteState=()=>page.locator('#overallDailyGrid .leaderboard-arcade').evaluate(element=>({
    rows:[...element.querySelectorAll('[data-leaderboard-shortcut]')].map(button=>({key:button.dataset.leaderboardShortcut,label:button.childNodes[0].textContent.trim(),number:button.getAttribute('aria-keyshortcuts'),selected:button.getAttribute('aria-pressed'),title:button.title})),
    label:document.querySelector('.sq-category-trigger .sq-category-label')?.textContent,
    saved:localStorage.getItem('polytrack-0.6.2-leaderboard-arcade-v1')
  }));
  const assertBlockedKey=async()=>{
    const before=await favoriteState();await page.keyboard.press('1');await page.keyboard.press('Numpad4');
    assert.deepEqual(await favoriteState(),before);
  };
  try{
    await fs.mkdir(output,{recursive:true});
    await page.goto(server.url,{waitUntil:'domcontentloaded'});
    for(const name of ['Exit','Back'])await visibleMenuButton(name).click({timeout:30000});
    await page.locator('#injectedRankingsBtn.ranked-ready').click({timeout:30000});
    await page.locator('#overallDailyGrid .leaderboard-arcade button').first().waitFor({state:'visible'});
    await page.locator('#overallLeaderboardList .overall-entry[data-userid]').first().waitFor({state:'visible'});
    assert.ok((await favoriteState()).rows.every(row=>row.title==='Suggested ranking'));
    for(const prefix of ['','Numpad'])for(let digit=1;digit<=4;digit++){
      const before=await favoriteState(),target=before.rows.find(row=>row.number===String(digit));
      await page.keyboard.press(prefix+digit);
      await page.waitForFunction(key=>document.querySelector('[data-leaderboard-shortcut="'+key+'"]')?.getAttribute('aria-pressed')==='true',target.key);
      const after=await favoriteState();assert.equal(after.rows.filter(row=>row.selected==='true').length,1);
      assert.equal(after.label,after.rows.find(row=>row.selected==='true').label);
      shortcuts.push({key:prefix+digit,category:target.key});
    }
    await page.locator('[data-leaderboard-shortcut="overall"]').click();
    await page.locator('#overallLeaderboardList .overall-entry[data-userid]').first().click();
    await page.locator('#overallProfilePopup').waitFor({state:'visible'});await assertBlockedKey();await page.locator('#overallProfileClose').click();
    await page.locator('#overallHelpBtn').click();await assertBlockedKey();await page.locator('#overallHelpClose').click();
    const pageField=page.locator('#overallPageJump');await pageField.focus();
    const beforeTyping=await favoriteState();await page.keyboard.press('1');assert.deepEqual(await favoriteState(),beforeTyping);
    await pageField.blur();
    await page.locator('#overallFilterPanel [data-personal-filter-button]').click();
    await page.locator('.pt-group-filter-menu:not([hidden])').waitFor({state:'visible'});await assertBlockedKey();await page.keyboard.press('Escape');
    await page.locator('#overallDailyGrid .leaderboard-arcade button').first().focus();
    // Exercise cross-tab storage notification without touching any public data.
    await page.evaluate(()=>{
      const key='polytrack-0.6.2-leaderboard-arcade-v1',oldValue=localStorage.getItem(key),newValue=JSON.stringify({overall:7,tracks:6,topTracks:5,events:4});
      localStorage.setItem(key,newValue);window.dispatchEvent(new StorageEvent('storage',{key,oldValue,newValue,storageArea:localStorage,url:location.href}));
    });
    assert.deepEqual((await favoriteState()).rows.map(row=>row.key),['overall','tracks','topTracks','events']);
    await page.keyboard.press('2');assert.equal((await favoriteState()).rows.find(row=>row.selected==='true').key,'tracks');
    for(const viewport of [{width:1366,height:768},{width:1280,height:600},{width:390,height:844}]){
      await page.setViewportSize(viewport);await page.screenshot({path:path.join(output,`favorites-${viewport.width}x${viewport.height}.png`)});
      assert.equal(await page.locator('#overallDailyGrid .leaderboard-arcade [data-leaderboard-shortcut]').count(),4);
    }
    await page.setViewportSize({width:844,height:320});
    const touch=await page.context().newCDPSession(page);
    t.after(()=>touch.detach().catch(()=>{}));
    await touch.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
    for(let digit=1;digit<=4;digit++){
      await page.locator('#overallDailyGrid').evaluate(element=>{element.scrollTop=0;});
      for(const prefix of ['', 'Numpad']){
        const target=(await favoriteState()).rows.find(row=>row.number===String(digit));
        await page.keyboard.press(prefix+digit);
        const after=await favoriteState();
        assert.equal(after.rows.find(row=>row.selected==='true').key,target.key,'off-scroll favorite key '+prefix+digit);
        assert.equal(after.label,target.label);
      }
      const beforeTouch=await favoriteState();
      const target=beforeTouch.rows.find(row=>row.number===String(digit)).key;
      const other=beforeTouch.rows.find(row=>row.key!==target);
      await page.keyboard.press(other.number);
      assert.equal((await favoriteState()).rows.find(row=>row.selected==='true').key,other.key);
      const button=page.locator('#overallDailyGrid .leaderboard-arcade [data-leaderboard-shortcut="'+target+'"]');
      const slotAtTap=await button.getAttribute('aria-keyshortcuts');
      const drawer=page.locator('#overallMobileTools');
      if(await drawer.isHidden())await page.locator('#overallDailyGrid .overall-mobile-tools').click();
      await button.scrollIntoViewIfNeeded();
      const reach=await button.evaluate(element=>{
        const footer=element.closest('.overall-mobile-drawer')||element.closest('#overallDailyGrid'),rect=element.getBoundingClientRect();
        const hit=document.elementFromPoint(rect.left+rect.width/2,rect.top+rect.height/2);
        return {height:footer.clientHeight,scrollHeight:footer.scrollHeight,scrollTop:footer.scrollTop,overflow:getComputedStyle(footer).overflowY,top:footer.getBoundingClientRect().top,bottom:footer.getBoundingClientRect().bottom,windowScroll:window.scrollY,reachable:hit===element||element.contains(hit)};
      });
      assert.equal(reach.reachable,true,'short footer favorite '+digit+' is reachable after internal scrolling');
      assert.equal(reach.overflow,'auto');

      const box=await button.boundingBox();
      await touch.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:box.x+box.width/2,y:box.y+box.height/2}]});
      await touch.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
      await page.waitForFunction(key=>document.querySelector('[data-leaderboard-shortcut="'+key+'"]')?.getAttribute('aria-pressed')==='true',target);
      const afterTouch=await favoriteState();
      assert.equal(afterTouch.rows.find(row=>row.selected==='true').key,target);
      assert.equal(afterTouch.label,afterTouch.rows.find(row=>row.key===target).label);
      const expected=(await favoriteState()).rows.find(row=>row.number===String(digit)).key;
      await page.keyboard.press(String(digit));assert.equal((await favoriteState()).rows.find(row=>row.selected==='true').key,expected);
      shortFooter.push({digit,touchFrom:other.key,touchTarget:target,slotAtTap,...reach});
    }
    await page.screenshot({path:path.join(output,'favorites-844x320-scrolled.png')});
    await touch.send('Emulation.setTouchEmulationEnabled',{enabled:false});await touch.detach();
    await page.setViewportSize({width:1366,height:768});await page.locator('#closeOverallLeaderboard').click();await visibleMenuButton('Play').click();
    const track=page.locator('.track-selection-ui button:has(.track-title)').first();
    await page.waitForFunction(()=>performance.getEntriesByType('resource').some(item=>item.name.includes('/tools/leaderboard-latency-hook.mjs')));
    for(let index=0;index<21;index++){
      await page.evaluate(()=>Object.assign(window.__warmAudit,{active:true,started:performance.now(),events:[],prior:''}));
      await track.click();
      await page.locator('.track-info-ui .leaderboard-ui .container > button.main').first().waitFor({state:'visible',timeout:20000});
      await page.waitForTimeout(850);
      const events=await page.evaluate(()=>{window.__warmAudit.active=false;return window.__warmAudit.events;});trials.push({index,events});
      const first=events.findIndex(event=>event.kind==='state'&&event.visible>0);assert.ok(first>=0);
      assert.ok(events.slice(first).filter(event=>event.kind==='state').every(event=>event.visible>0&&!event.loading),`trial ${index}: visible rows must not disappear`);
      assert.ok(events.filter(event=>event.kind==='policy').every(event=>event.rows===0),`trial ${index}: default applied before rows render`);
      assert.equal(await page.evaluate(()=>window.setTimeout===window.__warmAuditOriginalTimer),true);
      if(index===20)await page.screenshot({path:path.join(output,'native-warm-20.png')});
      await page.locator('.track-info-ui button.back').first().click();
    }
    assert.equal(trials.length,21);assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  }finally{
    await page.screenshot({path:path.join(output,'last-state.png')}).catch(()=>{});
    await fs.writeFile(path.join(output,'last-state.json'),JSON.stringify(await page.evaluate(()=>({body:document.body.innerText,ready:document.readyState})).catch(()=>null),null,2));
    await fs.mkdir(output,{recursive:true});await fs.writeFile(path.join(output,'evidence.json'),JSON.stringify({trials,shortcuts,shortFooter,errors,blocked,consoleMessages,requestFailures},null,2));
  }
});

test('actual native binding keeps a delayed newer-package response owned across exit and A-B-A',{timeout:180000},async t=>{
  const {server,page,output}=await createAuditFixture(t);
  const errors=[],blocked=[],result={binding:'Actual patch closure and native main.bundle.js; test-only accessor and loopback package responses'};
  let packageAudit;
  page.on('pageerror',error=>errors.push(String(error)));
  await page.route(url=>url.origin!==new URL(server.url).origin,route=>{
    const url=new URL(route.request().url());
    if(url.pathname==='/v6/user')return route.fulfill({status:200,contentType:'application/json',body:'null'});
    blocked.push(url.origin+url.pathname);return route.abort('blockedbyclient');
  });
  await installNativeRankedAuditFixture(page,{rejectWrites:true});
  await installActualClientAuditBindings(page);
  const board=page.locator('.track-info-ui > .leaderboard-ui:not(.sq-event-board)');
  const rows=board.locator('.container > button.main');
  const readState=()=>page.evaluate(()=>window.__ptClientAudit.snapshot());
  const back=()=>page.locator('.track-info-ui button.back').first().click();
  try{
    await page.goto(server.url,{waitUntil:'domcontentloaded'});
    for(const name of ['Exit','Back','Play'])await page.getByRole('button',{name,exact:true}).click({timeout:60000});
    const tracks=page.locator('.track-selection-ui button:has(.track-title)');
    await tracks.nth(0).click();await rows.first().waitFor({state:'visible',timeout:20000});
    const a=await readState();assert.ok(a.cache?.entries.length);result.cold={trackId:a.state.trackId,rows:a.cache.entries.length};
    await back();await tracks.nth(1).click();await rows.first().waitFor({state:'visible',timeout:20000});
    const b=await readState(),bText=await rows.first().innerText();assert.notEqual(a.state.trackId,b.state.trackId);
    await back();await tracks.nth(0).click();await rows.first().waitFor({state:'visible'});
    assert.equal((await readState()).state.trackId,a.state.trackId);
    packageAudit=await installNextPackageAudit(page,await readState());
    t.after(()=>packageAudit.release());
    const refreshing=page.evaluate(()=>window.__ptClientAudit.refreshPackage());
    await packageAudit.waitForRequest();
    const heldAt=Date.now();await back();await tracks.nth(1).click();packageAudit.release();
    result.delayedResponseHeldMs=Date.now()-heldAt;
    await refreshing;await rows.first().waitFor({state:'visible',timeout:20000});await page.waitForTimeout(850);
    const afterSwitch=await readState();assert.equal(afterSwitch.state.trackId,b.state.trackId);
    assert.equal(await rows.first().innerText(),bText,'late A response cannot repaint B');
    result.exitAndSwitch={pass:true,selectedTrack:b.state.trackId};
    await back();await tracks.nth(0).click();await rows.first().waitFor({state:'visible',timeout:20000});
    const updated=await readState();assert.equal(updated.cache.revision,packageAudit.revision);
    assert.equal(updated.cache.entries[0].timeMs,packageAudit.newTime);
    const ms=packageAudit.newTime,formatted=String(Math.floor(ms/60000)).padStart(2,'0')+':'+String(Math.floor(ms/1000)%60).padStart(2,'0')+'.'+String(ms%1000).padStart(3,'0');
    assert.ok((await rows.first().innerText()).includes(formatted),'new accepted package time is displayed by the native row');
    await page.waitForTimeout(850);assert.ok(await rows.first().isVisible());
    result.newPackage={pass:true,directory:packageAudit.directory,revision:updated.cache.revision,oldTime:packageAudit.oldTime,newTime:packageAudit.newTime};
    await page.screenshot({path:path.join(output,'native-package-updated.png')});
    assert.deepEqual(errors,[]);assert.deepEqual(blocked,[]);
  }finally{
    packageAudit?.release();
    await fs.mkdir(output,{recursive:true});
    await page.screenshot({path:path.join(output,'package-last-state.png')}).catch(()=>{});
    await fs.writeFile(path.join(output,'package-evidence.json'),JSON.stringify({...result,errors,blocked,requests:packageAudit?.events},null,2));
  }
});
