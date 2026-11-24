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

test('Community version shortcuts wrap, respect text entry and restore tab focus',async()=>{
  const server=await startResponsiveServer(),browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).origin===server.url?route.continue():route.abort());
    await page.goto(server.url+'/tools/search-text.mjs');
    await page.setContent('<div class="track-selection-ui"><div class="search-bar-container"><input></div><div class="tracks-container open"><div class="community-track-versions"><button class="selected">Newest</button><button>Older</button><button disabled>Unavailable</button></div></div></div>');
    await page.evaluate(async origin=>{
      const buttons=[...document.querySelectorAll('.community-track-versions button')];
      for(const button of buttons)button.onclick=()=>buttons.forEach(other=>other.classList.toggle('selected',other===button));
      const {enhanceNativeTrackSearch}=await import(origin+'/tools/native-track-search.mjs');
      window.versionEnhancer=enhanceNativeTrackSearch({document});
    },server.url);
    const selected=page.locator('.community-track-versions .selected');
    await page.getByRole('button',{name:'Newest'}).focus();
    await page.keyboard.press('Shift+ArrowLeft');
    assert.equal(await selected.textContent(),'Older');
    assert.equal(await page.evaluate(()=>document.activeElement.textContent),'Older');
    await page.keyboard.press('Shift+ArrowRight');
    assert.equal(await selected.textContent(),'Newest');
    await page.locator('input').focus();
    await page.keyboard.press('Shift+ArrowRight');
    assert.equal(await selected.textContent(),'Newest');
    await page.evaluate(()=>window.versionEnhancer.dispose());
    await page.getByRole('button',{name:'Newest'}).focus();
    await page.keyboard.press('Shift+ArrowRight');
    assert.equal(await selected.textContent(),'Newest');
  }finally{await browser.close();await server.close();}
});

test('Community type-to-find opens only exact matches and knows the RHR alias',async()=>{
  const server=await startResponsiveServer(),browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).origin===server.url?route.continue():route.abort());
    await page.goto(server.url+'/tools/search-text.mjs');
    await page.setContent('<div class="track-selection-ui"><div class="search-bar-container"><input></div><div class="tracks-container open"><div class="community-track-versions"><button class="selected">Current</button></div><section><article class="track"><button><span class="track-title">Phantom Imperium</span></button></article><article class="track sq-permanent-track"><button><span class="track-title">Rolling Hills Racer</span></button></article></section></div></div>');
    await page.evaluate(async origin=>{
      window.openedTracks=[];
      for(const button of document.querySelectorAll('.track button'))button.onclick=()=>window.openedTracks.push(button.textContent);
      const {enhanceNativeTrackSearch}=await import(origin+'/tools/native-track-search.mjs');
      enhanceNativeTrackSearch({document});
    },server.url);
    const input=page.locator('input');
    const opened=()=>page.evaluate(()=>window.openedTracks);
    await page.getByRole('button',{name:'Current'}).focus();
    await page.keyboard.press('Shift+P');
    assert.equal(await input.inputValue(),'P');
    await page.keyboard.type('hantom');
    await page.keyboard.press('Enter');
    assert.deepEqual(await opened(),[]);
    await page.keyboard.type(' Imperium');
    await page.keyboard.press('Enter');
    assert.deepEqual(await opened(),['Phantom Imperium']);
    await page.getByRole('button',{name:'Current'}).focus();
    await page.keyboard.press('/');
    await page.keyboard.type('RHR');
    assert.equal(await input.inputValue(),'RHR');
    await page.keyboard.press('Enter');
    assert.deepEqual(await opened(),['Phantom Imperium','Rolling Hills Racer']);
    assert.equal(await page.evaluate(()=>localStorage.getItem('polytrack:shortcut-tutorial:community-search:v1')),null,'click without a preview does not complete the tutorial');
  }finally{await browser.close();await server.close();}
});

test('numbers and random shortcuts use the right list and do not override text entry',async()=>{
  const server=await startResponsiveServer(),browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    await page.route('**/*',route=>new URL(route.request().url()).origin===server.url?route.continue():route.abort());
    await page.goto(server.url+'/tools/search-text.mjs');
    await page.setContent('<div class="track-selection-ui"><div class="search-bar-container"><input></div><div class="tracks-container" style="display:none"><article class="track"><button>Official</button></article></div><div class="tracks-container open"><div class="community-track-versions"><button class="selected">Current</button></div><article class="track"><button>First</button></article><article class="track" hidden><button>Hidden</button></article><article class="track"><button>Second</button></article></div></div>');
    await page.evaluate(async origin=>{
      window.openedTracks=[];
      Math.random=()=>0;
      for(const button of document.querySelectorAll('.track button'))button.onclick=()=>window.openedTracks.push(button.textContent);
      const {enhanceNativeTrackSearch}=await import(origin+'/tools/native-track-search.mjs');
      enhanceNativeTrackSearch({document});
    },server.url);
    const current=page.getByRole('button',{name:'Current'});
    await current.focus();
    await page.keyboard.press('2');
    await page.keyboard.press('9');
    await page.keyboard.press('Shift+Slash');
    await page.keyboard.press('Shift+Digit1');
    assert.deepEqual(await page.evaluate(()=>window.openedTracks),['Second','First','Official']);
    await page.locator('input').focus();
    await page.keyboard.press('2');
    assert.equal(await page.locator('input').inputValue(),'2');
    assert.deepEqual(await page.evaluate(()=>window.openedTracks),['Second','First','Official']);
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
    await page.waitForFunction(()=>document.querySelector('.track-selection-ui .search-bar-container input')?.getAttribute('aria-label')==='Search tracks or authors');
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
    await community.locator('.sq-permanent-track').waitFor({state:'attached',timeout:30000});
    await menu.getByRole('button',{name:'Community tracks',exact:true}).focus();
    await page.keyboard.press('/');
    await page.keyboard.type('RHR');
    await community.locator('.sq-permanent-track').waitFor({state:'visible'});
    await page.keyboard.press('Enter');
    const preview=page.locator('.track-info-ui:not(.hidden)');
    await preview.waitFor({state:'visible'});
    assert.match(await preview.innerText(),/Rolling Hills Racer/i);
    await page.waitForFunction(()=>localStorage.getItem('polytrack:shortcut-tutorial:community-search:v1')==='1');
    const tutorial=await page.evaluate(async origin=>{
      const {renderAchievementJournal}=await import(origin+'/tools/achievement-journal.mjs');
      const {trackShortcutTutorialComplete}=await import(origin+'/tools/track-shortcut-progress.mjs');
      const scratch=document.createElement('div');
      scratch.innerHTML=renderAchievementJournal({shortcutTutorial:trackShortcutTutorialComplete(localStorage),selectedId:'tutorial:community-search'});
      return {earned:scratch.querySelector('[data-aj-node="tutorial:community-search"]')?.dataset.ajEarned,
        detail:scratch.querySelector('[data-aj-detail]').textContent};
    },server.url);
    assert.equal(tutorial.earned,'true');
    assert.match(tutorial.detail,/No Style Coins or cosmetic reward/);
    assert.ok(requests.slice(before).every(url=>!url.includes('firestore.googleapis.com')&&!url.includes('.workers.dev')));
    const audit=await page.evaluate(()=>window.__ptNativeRankedAudit);assert.deepEqual(audit.errors,[]);assert.deepEqual(audit.rejections,[]);
  }finally{await browser.close();await server.close();}
});
