import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const root=process.env.EVENT_TEST_REPO||fileURLToPath(new URL('../',import.meta.url));
const require=createRequire(path.join(root,'tools/verifier/package.json'));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const patch=fs.readFileSync(path.join(root,'polytrack_062_patch.js'),'utf8');
const nativeBundle=fs.readFileSync(path.join(root,'main.bundle.js'),'utf8');
const match=/style\.textContent\s*=\s*("(?:\\.|[^"\\])*")/.exec(patch.slice(patch.indexOf('  function ensureStyles(){')));
assert.ok(match,'read the shipped Ranked style cascade');
const literal=String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60)`;
const rankedCss=[...patch.matchAll(new RegExp(String.raw`(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*(${literal})`,'g'))].map(row=>vm.runInNewContext(row[1],{},{timeout:100})).join('\n');
const nativeMatch=nativeBundle.match(/"\.track-selection-ui \{(?:\\.|[^"\\])*"/);
const nativeCss=nativeMatch?JSON.parse(nativeMatch[0]):'';
const css=fs.readFileSync(new URL('./events.css',import.meta.url),'utf8');
const client=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
test('event ordinals remain readable and receipt dates survive the real shared status-label updater',async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage();await page.route('**/*',route=>route.abort());
    await page.setContent('<div class="leaderboard-ui sq-event-board"><button class="main"><div class="left"><p class="position" style="font-size:36px">1<span>X</span></p></div><div class="verified-state">1 hour ago<img alt="Verified"></div></button></div>');
    await page.addStyleTag({content:css});await page.addStyleTag({content:rankedCss});
    const ordinalHelper=fs.readFileSync(new URL('../tools/finish-presentation.mjs',import.meta.url),'utf8');
    const helpers=ordinalHelper.slice(ordinalHelper.indexOf('export function finishOrdinal('),ordinalHelper.indexOf('export function enhanceFinishAnnouncers('))+
      client.slice(client.indexOf('export function eventRowVerified('),client.indexOf('export function eventSnapshotRows('))+
      client.slice(client.indexOf('export function eventRunDate('),client.indexOf('export function eventStandingsLabel('))+
      client.slice(client.indexOf('export function eventOrdinal('),client.indexOf('export function eventTrackName('));
    const shared=patch.slice(patch.indexOf('  function syncIntegrityStateLabels(){'),patch.indexOf('  let nativeDecorationLookupCache='));
    await page.evaluate(({helpers,shared})=>{
      const decorate=Function(helpers.replace(/export (async )?function /g,'$1function ')+';return decorateEventRowPresentation;')();
      decorate(document.querySelector('button.main'),{rank:1,submittedAt:Date.now()-3600000,verified:true,integrityVerified:true,competition:'verified'});
      Function(shared+';syncIntegrityStateLabels();')();
    },{helpers,shared});
    assert.equal(await page.locator('.position').innerText(),'1st');
    assert.equal(await page.locator('.position').getAttribute('aria-label'),'1st');
    assert.equal(await page.locator('.position > span').count(),1,'native ordinal suffix remains separate from the rank number');
    assert.equal(await page.locator('.position > span').textContent(),'st');
    assert.match(await page.locator('.verified-state').getAttribute('title'),/^Received .* - Run verified$/);
    assert.doesNotMatch(await page.locator('.verified-state').getAttribute('aria-label'),/Date unavailable/);
  }finally{await browser.close();}
});
test('daily and weekly preview frames fit their thumbnail slot under the shipped later-loading native/Ranked CSS',async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage();await page.route('**/*',route=>route.abort());
    const svg='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 80"><rect x="1" y="1" width="318" height="78" fill="cyan" stroke="red" stroke-width="2"/></svg>');
    const cards=['weekly','daily'].map(kind=>`<button class="sq-event-card" data-event-kind="${kind}"><span class="sq-event-thumb"><span class="profile-track-image-frame ${kind==='daily'?'is-artwork':'is-silhouette'}"><img class="profile-track-thumb" src="${svg}" alt="${kind} track"></span></span><div class="sq-event-record">No record</div><span><small>${kind}</small><strong>Track</strong><span class="sq-event-card-details"><span class="sq-event-reward">Up to 100 Event RP</span><small class="sq-event-reset">Resets tomorrow</small></span></span></button>`).join('');
    await page.setContent(`<style>body{margin:0}</style><div id="ui"><div class="track-selection-ui"><section class="sq-featured-events"><h2>Events</h2><div class="sq-event-track-buttons">${cards}</div></section></div></div>`);
    // Match production order: event CSS first, native/Ranked styles inserted later.
    await page.addStyleTag({content:css});await page.addStyleTag({content:nativeCss+'\n'+rankedCss});
    for(const [width,height] of [[390,844],[844,390],[1366,768]]){
      await page.setViewportSize({width,height});
      const values=await page.locator('.sq-event-thumb').evaluateAll(nodes=>nodes.map(slot=>{
        const frame=slot.querySelector('.profile-track-image-frame'),image=frame.querySelector('img');
        const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
        return {slot:rect(slot),frame:rect(frame),image:rect(image),fit:getComputedStyle(image).objectFit,padding:getComputedStyle(image).padding,filter:getComputedStyle(image).filter,rendering:getComputedStyle(image).imageRendering};
      }));
      for(const value of values){
        assert.equal(value.rendering,'pixelated');assert.equal(value.fit,'contain');assert.equal(value.padding,'0px');assert.equal(value.filter,'none');
        assert.ok(value.frame.width>0&&value.frame.height>0,JSON.stringify({width,value}));
        assert.ok(value.frame.width<=value.slot.width+1&&value.frame.height<=value.slot.height+1,JSON.stringify({width,value}));
        assert.ok(value.image.x>=value.frame.x-1&&value.image.y>=value.frame.y-1&&value.image.right<=value.frame.right+1&&value.image.bottom<=value.frame.bottom+1,JSON.stringify({width,value}));
      }
    }
  }finally{await browser.close();}
});
