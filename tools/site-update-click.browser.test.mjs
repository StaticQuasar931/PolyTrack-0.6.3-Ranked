import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const {chromium}=createRequire(new URL('./verifier/package.json',import.meta.url))('playwright');
const patch=await readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const site=await readFile(new URL('./site-updates.mjs',import.meta.url),'utf8');
const history=await readFile(new URL('./release-history.mjs',import.meta.url),'utf8');
const canonical='https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/';
const commit='a'.repeat(40),base=`https://cdn.jsdelivr.net/gh/StaticQuasar931/PolyTrack-0.6.3-Ranked@${commit}/`;
const functions=['isElementVisible','isStartMenuHotkeyContext','canShowInstalledRevisionNotice'].map(name=>{
 const start=patch.indexOf('  function '+name+'(');assert.ok(start>0);return patch.slice(start,patch.indexOf('\n  }',start)+4);
}).join('\n');
const bundle=history.slice(0,history.indexOf('/** Offline builder.')).replace(/\bexport /g,'')+'\n'+site.slice(site.indexOf('\n')+1).replace(/\bexport /g,'')+'\nwindow.updateAPI={installSiteUpdates};';
for(const launcher of [false,true])test(`${launcher?'automatic embedded':'canonical'} compatibility update rechecks real gameplay guards and reloads only this document`,{timeout:45000},async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({serviceWorkers:'block'}),url=launcher?'https://script.googleusercontent.com/userCodeAppPanel?user_content_key=fixture':canonical;
  let visits=0;const unexpected=[];
  await page.route('**/*',route=>{
   if(route.request().url()===url){visits++;return route.fulfill({contentType:'text/html',body:`<!doctype html>${launcher?`<base href="${base}">`:''}<style>.hidden{display:none}</style><div class="menu-ui"><div class="main-buttons-container"><button>Play</button></div></div><div class="settings-menu-ui hidden">Settings</div>`});}
   unexpected.push(route.request().url());return route.abort();
  });
  await page.goto(url);await page.addScriptTag({content:bundle+'\n'+functions});
  await page.evaluate(({launcher,commit})=>{
   localStorage.setItem('saved-run','preserved');
   if(launcher){window.__polytrackAutomaticLoad=Promise.resolve();localStorage.setItem('polytrack-automatic-release-v2',JSON.stringify({sha:commit,indexSha256:'b'.repeat(64),checkedAt:12345}));}
   window.guardTrace=[];
   window.updater=updateAPI.installSiteUpdates({revision:238,isIdle:()=>canShowInstalledRevisionNotice()&&!document.querySelector('dialog[data-site-installed-revision][open]'),
    canReload:()=>{const safe=canShowInstalledRevisionNotice();guardTrace.push(safe);return safe;},fetch:async()=>({ok:true,json:async()=>({revision:239,minimumSupportedRevision:239})})});
   return updater.check();
  },{launcher,commit});
  const dialog=page.locator('dialog[data-site-compatibility][open]');await dialog.waitFor();
  const update=dialog.getByRole('button',{name:'Reload to update',exact:true});
  assert.equal(await update.count(),1,'trusted local launcher must not use the foreign-copy new-tab action');
  assert.equal(await dialog.getByRole('link').count(),0);
  await page.evaluate(()=>document.querySelector('.menu-ui').classList.add('hidden'));
  await update.click();assert.equal(visits,1);assert.equal(await dialog.count(),1,'unsafe race restores the updater dialog');
  assert.equal(await page.evaluate(()=>localStorage.getItem('saved-run')),'preserved');
  if(launcher)assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('polytrack-automatic-release-v2')).checkedAt),12345);
  await page.evaluate(()=>{document.querySelector('.menu-ui').classList.remove('hidden');document.querySelector('.settings-menu-ui').classList.remove('hidden');});
  await update.click();assert.equal(visits,1);assert.equal(await dialog.count(),1,'settings remains a real reload blocker');
  await page.evaluate(()=>document.querySelector('.settings-menu-ui').classList.add('hidden'));
  await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),update.click()]);
  assert.equal(visits,2);assert.equal(page.url(),url);assert.equal(await page.evaluate(()=>localStorage.getItem('saved-run')),'preserved');
  if(launcher)assert.equal(await page.evaluate(()=>JSON.parse(localStorage.getItem('polytrack-automatic-release-v2')).checkedAt),0);
  assert.deepEqual(unexpected,[]);
 }finally{await browser.close();}
});
test('fork with a copied official base and marker cannot receive an in-place compatibility reload',{timeout:30000},async()=>{
 const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage({serviceWorkers:'block'});await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<base href="${base}"><button>Play</button>`}));
  await page.goto('https://fork.invalid/');await page.addScriptTag({content:bundle});
  await page.evaluate(async()=>{window.__polytrackAutomaticLoad=Promise.resolve();window.updater=updateAPI.installSiteUpdates({revision:238,isIdle:()=>true,canReload:()=>true,fetch:async()=>({ok:true,json:async()=>({revision:239,minimumSupportedRevision:239})})});await updater.check();});
  const dialog=page.locator('dialog[data-site-compatibility][open]');assert.equal(await dialog.getByRole('button',{name:'Reload to update'}).count(),0);
  const link=dialog.getByRole('link',{name:'Open updated game (opens in a new tab)'});assert.equal(await link.getAttribute('href'),canonical);assert.equal(await link.getAttribute('target'),'_blank');assert.equal(page.url(),'https://fork.invalid/');
 }finally{await browser.close();}
});

test('canonical floating button explains blocked clicks and restores on real safe-menu transitions without auto-reload',{timeout:45000},async()=>{
 const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage({serviceWorkers:'block'});let visits=0;
  await page.route('**/*',route=>{
   assert.equal(route.request().url(),canonical,'all browser requests stay on the intercepted fixture');visits++;
   return route.fulfill({contentType:'text/html',body:'<!doctype html><style>.hidden{display:none}</style><div class="menu-ui"><div class="main-buttons-container"><button>Play</button></div></div><div id="overallLeaderboardPanel" style="display:none">Ranked</div><div class="track-selection-ui hidden">Tracks</div><div class="editor-ui hidden">Editor</div><div class="pause-screen-ui hidden">Paused</div>'});
  });
  await page.goto(canonical);await page.addScriptTag({content:bundle+'\n'+functions});
  await page.evaluate(async()=>{
   localStorage.setItem('saved-run','never clear');sessionStorage.setItem('unsaved-session','keep');window.checks=0;
   window.updater=updateAPI.installSiteUpdates({revision:238,isIdle:()=>canShowInstalledRevisionNotice(),canReload:()=>canShowInstalledRevisionNotice(),
    fetch:async()=>{checks++;return {ok:true,json:async()=>({revision:239})};}});await updater.check();
  });
  const offer=page.locator('button[data-site-update]');
  for(const state of ['ranked','track','editor','paused','racing']){
   await page.evaluate(state=>{
    if(state==='ranked')document.getElementById('overallLeaderboardPanel').style.display='flex';
    if(state==='track')document.querySelector('.track-selection-ui').classList.remove('hidden');
    if(state==='editor')document.querySelector('.editor-ui').classList.remove('hidden');
    if(state==='paused')document.querySelector('.pause-screen-ui').classList.remove('hidden');
    if(state==='racing')document.querySelector('.menu-ui').classList.add('hidden');
   },state);
   await offer.click();assert.equal(visits,1,state+' cannot reload');
   assert.equal(await offer.innerText(),'To update, return to main menu');
   assert.equal(await offer.getAttribute('aria-label'),'To update, return to main menu');
   await page.evaluate(()=>{
    document.getElementById('overallLeaderboardPanel').style.display='none';
    for(const selector of ['.track-selection-ui','.editor-ui','.pause-screen-ui'])document.querySelector(selector).classList.add('hidden');
    document.querySelector('.menu-ui').classList.remove('hidden');
   });
   await page.waitForFunction(()=>document.querySelector('[data-site-update]').textContent==='Update available');
   assert.equal(visits,1,'returning home restores the label, never reloads automatically');
  }
  assert.equal(await page.evaluate(()=>checks),1,'menu transitions never refetch discovery');
  await Promise.all([page.waitForNavigation({waitUntil:'domcontentloaded'}),offer.click()]);
  assert.equal(visits,2);assert.equal(page.url(),canonical);
  assert.equal(await page.evaluate(()=>localStorage.getItem('saved-run')),'never clear');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('unsaved-session')),'keep');
 }finally{await browser.close();}
});

test('compatibility dialog contains game keys and exposes truthful retry feedback',{timeout:45000},async()=>{
 const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage({serviceWorkers:'block'}),unexpected=[];
  await page.route('**/*',route=>{
   if(route.request().url()===canonical)return route.fulfill({contentType:'text/html',body:'<!doctype html><button id="play">Play</button>'});
   unexpected.push(route.request().url());return route.abort();
  });
  await page.goto(canonical);await page.addScriptTag({content:bundle});
  await page.evaluate(async()=>{
   window.keys=[];for(const type of ['keydown','keyup'])document.addEventListener(type,event=>keys.push(type+':'+event.key),true);
   document.getElementById('play').focus();
   window.updater=updateAPI.installSiteUpdates({revision:238,isIdle:()=>true,canReload:()=>{throw Error('unavailable');},
    fetch:async()=>({ok:true,json:async()=>({revision:239,minimumSupportedRevision:239})})});await updater.check();
  });
  const dialog=page.getByRole('dialog',{name:'Update needed for online play'});
  await page.keyboard.press('r');
  assert.deepEqual(await page.evaluate(()=>keys),[],'open compatibility modal must block native game shortcuts');
  await dialog.getByRole('button',{name:'Reload to update'}).click();
  assert.equal(await dialog.getByRole('status').textContent(),'Update could not reload. Try again.');
  await page.keyboard.press('r');await page.keyboard.press('Space');await page.keyboard.press('Tab');await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(()=>document.querySelector('dialog').contains(document.activeElement)),true);
  await page.keyboard.press('Escape');assert.equal(await dialog.count(),0);
  assert.deepEqual(await page.evaluate(()=>keys),[],'modal keys and dismissal keyup cannot reach game shortcuts');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'play');
  assert.equal(await page.evaluate(()=>updater.getCompatibility().reason),'offline-selected');
  await page.keyboard.press('r');assert.deepEqual(await page.evaluate(()=>keys),['keydown:r','keyup:r']);
  await page.evaluate(()=>updater.dispose());assert.deepEqual(unexpected,[]);
 }finally{await browser.close();}
});
