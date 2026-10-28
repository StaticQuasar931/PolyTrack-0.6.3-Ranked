import test from 'node:test';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {startResponsiveServer} from './responsive-server.mjs';
import {installNativeRankedAuditFixture} from './native-ranked-audit-fixture.mjs';
const {chromium}=createRequire(new URL('./verifier/package.json',import.meta.url))('playwright');
test('native phone layouts retain reachable seasons and compact ranking controls across live rotation',{timeout:300000},async t=>{
const server=await startResponsiveServer();const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const directory=process.env.POLYTRACK_MOBILE_AUDIT_OUTPUT||await fs.mkdtemp(path.join(tmpdir(),'polytrack-mobile-'));await fs.mkdir(directory,{recursive:true});t.diagnostic('Screenshots and bounds: '+directory);const output=pathToFileURL(path.resolve(directory)+path.sep);const results=[];
let page;
try{
 page=await browser.newPage({viewport:{width:440,height:780},deviceScaleFactor:1,isMobile:true,hasTouch:true});
 await installNativeRankedAuditFixture(page,{rejectWrites:true});
 await page.route(url=>url.origin!==new URL(server.url).origin,route=>new URL(route.request().url()).pathname==='/v6/user'?route.fulfill({status:200,contentType:'application/json',body:'null'}):route.abort('blockedbyclient'));
 await page.goto(server.url,{waitUntil:'domcontentloaded'});
 await page.locator('button:visible').filter({hasText:/^\s*Exit\s*$/}).last().click({timeout:60000});
 await page.locator('.track-selection-ui:not(.hidden)').waitFor({state:'visible'});
 await page.locator('button:visible').filter({hasText:/^\s*Back\s*$/}).last().click({timeout:45000});
 await page.locator('#injectedRankingsBtn.ranked-ready').waitFor({state:'visible',timeout:45000});
 await page.screenshot({path:new URL('after-home.png',output).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
 await page.setViewportSize({width:956,height:360});
 await page.waitForFunction(()=>parseFloat(document.documentElement.style.getPropertyValue('--sq-available-width'))===956);
 const home=await page.locator('button:visible').filter({hasText:/^\s*Play\s*$/}).last().evaluate(n=>({play:n.getBoundingClientRect().toJSON(),info:document.querySelector('.menu-ui>.info').getBoundingClientRect().toJSON()}));
 console.log('Landscape home bounds: '+JSON.stringify(home));
 await page.screenshot({path:new URL('after-home-landscape.png',output).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
 assert.ok(home.info.top>=home.play.bottom-1,'Home credits must not overlap menu buttons');
 await page.setViewportSize({width:440,height:780});
 await page.waitForFunction(()=>parseFloat(document.documentElement.style.getPropertyValue('--sq-available-width'))===440);
 await page.evaluate(()=>{Object.defineProperty(document,'fullscreenEnabled',{configurable:true,value:false});document.dispatchEvent(new Event('fullscreenchange'));});
 await page.getByRole('button',{name:'Fullscreen help',exact:true}).click();
 await page.locator('[data-sq-expanded-controls]').waitFor({state:'visible'});
 assert.equal(await page.locator('html.sq-game-expanded').count(),0);
 await page.getByRole('button',{name:'Close fullscreen help',exact:true}).last().click();
 await page.locator('#injectedRankingsBtn.ranked-ready').click({timeout:45000});
 await page.locator('#overallLeaderboardList .overall-entry[data-userid]').first().waitFor({state:'visible',timeout:45000});
 // Measure layout only after the shell entrance scale settles; scrollWidth is untransformed CSS pixels.
 await page.locator('#overallLeaderboardPanel .overall-shell').evaluate(async node=>{await Promise.all(node.getAnimations().map(animation=>animation.finished.catch(()=>{})));});
 for(const [width,height]of [[440,780],[440,680],[390,720],[375,600],[320,500],[956,360],[844,320],[667,300],[1366,600],[1920,1080]]){
  await page.setViewportSize({width,height});await page.waitForFunction(size=>Math.abs(parseFloat(document.documentElement.style.getPropertyValue('--sq-available-width'))-size.width)<2&&Math.abs(parseFloat(document.documentElement.style.getPropertyValue('--sq-available-height'))-size.height)<2,{width,height});
  const metrics=await page.evaluate(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect().toJSON();return {footer:rect('#overallDailyGrid'),list:rect('#overallLeaderboardList'),mode:document.querySelector('#overallDailyGrid').dataset.mobileAxis||'desktop',scrollWidth:document.querySelector('#overallDailyGrid').scrollWidth,category:rect('.sq-category-trigger')};});
  if(metrics.mode!=='desktop'){assert.ok(metrics.footer.height<=110,JSON.stringify(metrics));assert.ok(metrics.scrollWidth<=metrics.footer.width+1,JSON.stringify(metrics));assert.ok(metrics.list.height>=height*.4,JSON.stringify(metrics));}
  results.push({width,height,...metrics});
  if([440,956,1366,320].includes(width))await page.screenshot({path:new URL('after-overall-'+width+'x'+height+'.png',output).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
 }
 await page.setViewportSize({width:440,height:780});await page.locator('.overall-mobile-tools').click();
 await page.locator('.overall-mobile-drawer .leaderboard-arcade').waitFor({state:'visible'});
 const drawer=await page.locator('.overall-mobile-drawer').evaluate(n=>({width:n.clientWidth,scrollWidth:n.scrollWidth,rect:n.getBoundingClientRect().toJSON()}));
 assert.ok(drawer.scrollWidth<=drawer.width+1);assert.ok(drawer.rect.top>=0);
 await page.screenshot({path:new URL('after-more.png',output).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
 await page.keyboard.press('Escape');assert.equal(await page.locator('.overall-mobile-drawer').isVisible(),false);
 await page.setViewportSize({width:1920,height:1080});await page.waitForFunction(()=>document.querySelector('#overallDailyGrid').dataset.mobileAxis===undefined);

 assert.equal(await page.locator('.overall-mobile-drawer .leaderboard-arcade').count(),0);
 await page.setViewportSize({width:440,height:780});await page.locator('#closeOverallLeaderboard').click();
 await page.locator('button:visible').filter({hasText:/^\s*Play\s*$/}).last().click();
 await page.locator('.track-selection-ui:not(.hidden)').waitFor({state:'visible'});
 const tracks=await page.locator('.tracks-container.open .track:not(.hidden)').evaluateAll(nodes=>nodes.map(n=>({name:n.querySelector('.track-title')?.textContent,rect:n.getBoundingClientRect().toJSON(),image:n.querySelector('.thumbnail')?.getBoundingClientRect().toJSON()})));
 assert.equal(tracks.length,17);assert.ok(tracks.every(n=>n.rect.x>=0&&n.rect.right<=440));assert.ok(Math.max(...tracks.map(n=>n.rect.width))-Math.min(...tracks.map(n=>n.rect.width))<2);
 results.push({tracks});
 await page.locator('.track-title').filter({hasText:'Winter 1'}).scrollIntoViewIfNeeded();
 await page.screenshot({path:new URL('after-winter.png',output).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
 await page.locator('.search-bar-container input').fill('Winter 1');
 await page.waitForFunction(()=>[...document.querySelectorAll('.tracks-container.open .track')].filter(n=>n.getClientRects().length).length===1);
 assert.match(await page.locator('.tracks-container.open .track:visible .track-title').textContent(),/Winter 1/);
 await page.locator('.search-bar-container input').fill('');
 await page.waitForFunction(()=>[...document.querySelectorAll('.tracks-container.open .track')].filter(n=>n.getClientRects().length).length===17);
 await page.getByRole('button',{name:'Community tracks',exact:true}).click();
 await page.locator('.tracks-container.open .community-track-group > .track:visible').first().waitFor({state:'visible'});
 const community=await page.locator('.tracks-container.open .community-track-group > .track:visible').evaluateAll(nodes=>nodes.map(n=>({...n.getBoundingClientRect().toJSON(),name:n.textContent.slice(0,70),className:n.className,parent:n.parentElement.className})));
 await fs.writeFile(new URL('community-bounds.json',output),JSON.stringify(community,null,2));
 assert.ok(community.every(n=>n.x>=0&&n.right<=440));assert.ok(Math.max(...community.map(n=>n.width))-Math.min(...community.map(n=>n.width))<2);
 await page.locator('.tracks-container.open .community-track-group > .track:visible').first().scrollIntoViewIfNeeded();
 await page.screenshot({path:new URL('after-community.png',output).pathname.replace(/^\/([A-Za-z]:)/,'$1')});
 await fs.writeFile(new URL('mobile-check.json',output),JSON.stringify(results,null,2));console.log(JSON.stringify(results.map(r=>r.tracks?{tracks:r.tracks.length}:{width:r.width,height:r.height,mode:r.mode,footer:r.footer.height,list:r.list.height})));
}catch(error){if(page){await page.screenshot({path:new URL('failure.png',output).pathname.replace(/^\/([A-Za-z]:)/,'$1')});await fs.writeFile(new URL('failure.txt',output),await page.locator('body').innerText());await fs.writeFile(new URL('failure-geometry.json',output),JSON.stringify(await page.evaluate(()=>({width:innerWidth,height:innerHeight,visual:{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale},available:document.documentElement.style.cssText,body:document.body.getBoundingClientRect().toJSON(),html:document.documentElement.getBoundingClientRect().toJSON(),screen:document.querySelector('#screen').getBoundingClientRect().toJSON(),scale:getComputedStyle(document.documentElement).getPropertyValue('--ui-scale-factor')})),null,2));}throw error;}finally{await browser.close();await server.close();}
});
