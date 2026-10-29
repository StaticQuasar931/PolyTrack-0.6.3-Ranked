import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {startResponsiveServer} from './responsive-server.mjs';
import {installNativeRankedAuditFixture,auditNativeRankedClick} from './native-ranked-audit-fixture.mjs';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require('playwright');

test('official no-match fallback never clears the query or relaxes other tabs, including native auto-switches',{timeout:60000},async()=>{
  const server=await startResponsiveServer(),browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).origin===server.url?route.continue():route.abort());
    await page.goto(server.url+'/tools/search-text.mjs');
    await page.setContent(`<div class="track-selection-ui"><div class="search-bar-container"><input></div><div class="image-button-container"><button data-tab="0">Official</button><button data-tab="1" class="selected">Community</button><button data-tab="2">Custom</button></div><div class="tracks-container"><section><article class="track"><div class="track-title"><p>Summer 1</p></div></article><article class="track"><div class="track-title"><p>Winter 1</p></div></article></section></div><div class="tracks-container open"><section><article class="track"><div class="track-title"><p>La Infinita</p></div></article><article class="track"><div class="track-title"><p>𝔚𝔦𝔫𝔱𝔢𝔯𝔱𝔦𝔡𝔢</p></div></article></section></div><div class="tracks-container"><section><article class="track" data-author="Secret Author"><div class="track-title"><p>My Track</p></div></article></section></div></div>`);
    await page.evaluate(async origin=>{
      const menu=document.querySelector('.track-selection-ui'),panes=[...menu.querySelectorAll('.tracks-container')],tabs=[...menu.querySelectorAll('[data-tab]')],input=menu.querySelector('input');
      const select=index=>{panes.forEach((pane,i)=>pane.classList.toggle('open',i===index));tabs.forEach((tab,i)=>tab.classList.toggle('selected',i===index));};
      tabs.forEach((tab,i)=>tab.onclick=()=>select(i));
      input.addEventListener('input',()=>{
        for(const tile of menu.querySelectorAll('.track'))tile.style.display=(tile.textContent+' '+(tile.dataset.author||'')).toLowerCase().includes(input.value.toLowerCase())?'':'none';
        for(const pane of panes)pane.firstElementChild.style.display=[...pane.querySelectorAll('.track')].some(tile=>tile.style.display!=='none')?'':'none';
        const current=panes.find(pane=>pane.classList.contains('open'));
        if(![...current.querySelectorAll('.track')].some(tile=>tile.style.display!=='none')){
          const found=panes.findIndex(pane=>[...pane.querySelectorAll('.track')].some(tile=>tile.style.display!=='none'));if(found>=0)select(found);
        }
      });
      const {enhanceNativeTrackSearch}=await import(origin+'/tools/native-track-search.mjs');
      window.searchEnhancer=enhanceNativeTrackSearch({document,metadata:[{name:'La Infinita',author:'Creator'},{name:'𝔚𝔦𝔫𝔱𝔢𝔯𝔱𝔦𝔡𝔢',plainName:'Wintertide'}]});
      window.trackSearchState=()=>({query:input.value,tab:tabs.findIndex(tab=>tab.classList.contains('selected')),rows:panes.map(pane=>[...pane.querySelectorAll('.track')].filter(tile=>tile.style.display!=='none').map(tile=>tile.textContent.trim())),groups:panes.map(pane=>pane.firstElementChild.style.display)});
    },server.url);
    const input=page.locator('input'),state=()=>page.evaluate(()=>window.trackSearchState());
    await input.fill('Infinita');assert.deepEqual((await state()).rows,[['Summer 1','Winter 1'],['La Infinita'],[]]);
    await page.locator('[data-tab="0"]').click();assert.equal((await state()).query,'Infinita');assert.equal((await state()).tab,0);
    await page.locator('[data-tab="1"]').click();assert.deepEqual((await state()).rows[1],['La Infinita']);
    await input.fill('Nothing matches');assert.equal((await state()).tab,1);assert.equal((await state()).rows[1].length,0);
    await page.locator('[data-tab="0"]').click();assert.equal((await state()).rows[0].length,2);assert.notEqual((await state()).groups[0],'none');
    await page.locator('[data-tab="1"]').click();assert.equal((await state()).rows[1].length,0);
    await input.fill('Winter');assert.deepEqual((await state()).rows[0],['Winter 1']);assert.deepEqual((await state()).rows[1],['𝔚𝔦𝔫𝔱𝔢𝔯𝔱𝔦𝔡𝔢']);
    await input.fill('Wintertide');assert.deepEqual((await state()).rows[1],['𝔚𝔦𝔫𝔱𝔢𝔯𝔱𝔦𝔡𝔢']);
    await page.locator('[data-tab="2"]').click();await input.fill('Secret Author');assert.deepEqual((await state()).rows[2],['My Track']);
    // Native keyboard/swipe tab selection changes classes rather than clicking a tab.
    await page.evaluate(()=>{const menu=document.querySelector('.track-selection-ui');menu.querySelectorAll('[data-tab]').forEach((tab,i)=>tab.classList.toggle('selected',i===0));menu.querySelectorAll('.tracks-container').forEach((pane,i)=>pane.classList.toggle('open',i===0));});
    await page.waitForFunction(()=>window.trackSearchState().rows[0].length===2);
    await input.fill('');assert.deepEqual((await state()).rows.map(rows=>rows.length),[2,2,1]);
    await page.evaluate(()=>window.searchEnhancer.dispose());
  }finally{await browser.close();await server.close();}
});

test('real native track selection preserves community search when visiting Official',{timeout:120000},async()=>{
  const server=await startResponsiveServer(),browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1024,height:768},serviceWorkers:'block'}),requests=[];
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/v6/user')return route.fulfill({status:200,contentType:'application/json',body:'null'});
      if(url.origin===server.url&&['GET','HEAD'].includes(route.request().method()))return route.continue();
      requests.push(url.href);return route.abort();
    });
    await installNativeRankedAuditFixture(page,{rejectWrites:true});
    await page.goto(server.url,{waitUntil:'domcontentloaded'});await auditNativeRankedClick(page);
    await page.locator('#closeOverallLeaderboard').click();
    await page.getByRole('button',{name:'Play',exact:true}).click();
    const menu=page.locator('.track-selection-ui:not(.hidden)'),input=menu.locator('.search-bar-container input');
    await input.waitFor({state:'visible'});
    await page.waitForFunction(()=>document.querySelector('.track-selection-ui .search-bar-container input')?.getAttribute('aria-label')?.includes('plain-text'));
    const official=menu.locator('.tracks-container').nth(0),community=menu.locator('.tracks-container').nth(1);
    const communityTiles=community.locator('.track:not(.sq-kodub-weekly):not(.sq-permanent-track):has(img.thumbnail[src*="tracks/community/thumbnails/"])');
    await menu.getByRole('button',{name:'Community tracks',exact:true}).click();
    const before=requests.length;
    await input.fill('Wintertide');
    await page.waitForFunction(()=>[...document.querySelectorAll('.tracks-container.open .track')].some(tile=>tile.style.display!=='none'&&tile.textContent.includes('𝔚')));
    await menu.getByRole('button',{name:'Official tracks',exact:true}).click();
    assert.equal(await input.inputValue(),'Wintertide');assert.ok(await official.locator('.track:visible').count()>=17);
    await menu.getByRole('button',{name:'Community tracks',exact:true}).click();
    assert.equal(await communityTiles.filter({visible:true}).count(),1,'only the matching catalog track is visible; spotlight and permanent event shortcuts are separate');
    await input.fill('no-such-track-unique-check');
    assert.equal(await community.evaluate(node=>node.classList.contains('open')),true);
    assert.equal(await communityTiles.filter({visible:true}).count(),0);
    await menu.getByRole('button',{name:'Official tracks',exact:true}).click();assert.ok(await official.locator('.track:visible').count()>=17);
    await menu.getByRole('button',{name:'Community tracks',exact:true}).click();assert.equal(await communityTiles.filter({visible:true}).count(),0);
    assert.ok(requests.slice(before).every(url=>!url.includes('firestore.googleapis.com')&&!url.includes('.workers.dev')));
    const audit=await page.evaluate(()=>window.__ptNativeRankedAudit);assert.deepEqual(audit.errors,[]);assert.deepEqual(audit.rejections,[]);
  }finally{await browser.close();await server.close();}
});
