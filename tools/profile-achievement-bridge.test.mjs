import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const root = fileURLToPath(new URL('../',import.meta.url));
const evidence = path.resolve(process.env.ACHIEVEMENT_EVIDENCE_DIR || path.join(root,'2026-11-13/evening-update'));
let server,browser,base,patch;
const requests = [], gates = new Map();
const extract = name => {
  const match = patch.match(new RegExp(`  function ${name}\\([^\\n]*\\)\\{[\\s\\S]*?\\n  \\}`));
  assert.ok(match,`native function ${name}`);return match[0];
};
before(async () => {
  patch = await fs.readFile(path.join(root,'polytrack_062_patch.js'),'utf8');
  server = http.createServer(async (req,res) => {
    const url = new URL(req.url,'http://localhost');requests.push(url.pathname + url.search);
    if (url.pathname === '/') {
      res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PolyTrack native racer hub fixture</title><style>@font-face{font-family:ForcedSquare;src:url(/forced_square.woff2)}body{margin:0;background:#16254c;color:white;font-family:ForcedSquare,sans-serif}</style><div id="overallLeaderboardPanel" style="display:flex"><div id="overallProfilePopup" style="display:flex"><div class="overall-profile-card"><button id="profile-return" type="button">Racer profile</button><main id="content"></main></div></div></div></html>');return;
    }
    const allowed = /^\/tools\/(profile-achievement-bridge|achievement-journal|achievement-model)\.mjs$/.test(url.pathname) || ['/tools/achievement-journal.css','/tools/racer-studio-polish.css','/tools/studio-art-polish.css','/tools/profile-shop-art.css','/forced_square.woff2','/images/car_thumbnail_placeholder.png'].includes(url.pathname);
    if (!allowed) {res.writeHead(404).end();return;}
    const gate = gates.get(url.searchParams.get('v'));
    if (url.pathname === '/tools/achievement-journal.mjs' && gate) {gate.started();await gate.wait;}
    try {res.setHeader('Content-Type',url.pathname.endsWith('.css') ? 'text/css' : url.pathname.endsWith('.woff2') ? 'font/woff2' : url.pathname.endsWith('.png') ? 'image/png' : 'text/javascript');res.end(await fs.readFile(path.join(root,url.pathname.slice(1))));} catch {res.writeHead(404).end();}
  });
  server.keepAliveTimeout = 500;
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {})});
  await fs.mkdir(evidence,{recursive:true});
});
after(async () => {await browser?.close();if (server) {server.closeAllConnections();await new Promise(resolve => server.close(resolve));}});

async function pageFor(t,viewport = {width:1440,height:1000}) {
  const context = await browser.newContext({viewport,reducedMotion:'reduce'}),page = await context.newPage();t.after(() => context.close());
  await page.route('**/*',route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
  await page.goto(base);return page;
}
async function mount(page,revision = 'hub-test',accountId = 'racer-a') {
  await page.evaluate(async ({revision,accountId}) => {
    const {mountProfileAchievements} = await import('/tools/profile-achievement-bridge.mjs?channel=studio');
    window.calls ??= {rewards:[],navigate:[]};
    const content = document.querySelector('#content');
    if (!content.querySelector('.profile-customizer')) content.innerHTML = '<details class="profile-customizer"><summary>Customize</summary><input data-draft value="saved draft"><button type="button" data-save-profile-cosmetics>Publish design</button></details>';
    window.cleanup = mountProfileAchievements(content,{accountId,revision,confirmed:{raceCount:0},local:{pbCount:0},cosmetics:{theme:[['ocean','Deep ocean',1]]},onTryCosmetic:value => calls.rewards.push(value),onNavigate:value => calls.navigate.push(value)});
  },{revision,accountId});
}
async function open(page,tab = 'achievements') {
  await page.evaluate(tab => cleanup.open(tab),tab);
  if (tab === 'achievements') await page.locator('dialog[open] [data-aj-root]').waitFor();
}

async function nativeFixture(page) {
  const catalog = patch.match(/const PROFILE_COSMETIC_OPTIONS=(\{[\s\S]*?\n  \});/)[0];
  const defaults = patch.match(/const COSMETIC_DEFAULTS=Object.freeze\((\{[^\n]+\})\);/)[0];
  const choiceStart = patch.indexOf("      const cosmeticChoice=event.target.closest?.('[data-cosmetic-choice]');");
  const choiceEnd = patch.indexOf("      const categoryInfo=",choiceStart);
  const tabStart = patch.indexOf("      const studioTab=event.target.closest?.('[data-studio-tab]');",choiceEnd);
  const tabEnd = patch.indexOf('      const podiumChoice=',tabStart);
  const saveStart = patch.indexOf("      const cosmeticSave=event.target.closest?.('[data-save-profile-cosmetics]');",tabEnd);
  const saveEnd = patch.indexOf('      const trackTarget=',saveStart);
  const changeStart = patch.indexOf("      if(event.target?.matches?.('[data-cosmetic-favorite]')){");
  const changeEnd = patch.indexOf('\n    });',changeStart);
  assert.ok(choiceStart >= 0 && choiceEnd > choiceStart && saveEnd > saveStart);
  await page.addScriptTag({content:`
    ${catalog}; ${defaults};
    Object.assign(window,{
      cleanUserId:value=>String(value||''),profileCosmeticDrafts:new Map(),profileCosmeticEntries:new Map(),
      sanitizeProfileCosmetics:value=>({...COSMETIC_DEFAULTS,...value}),cosmeticsForEntry:()=>({...COSMETIC_DEFAULTS}),
      localExtraTrackCount:()=>0,cosmeticTitleText:()=> 'Contender',profileBadgeMarkup:()=>'',
      escapeHtml:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
      trackInfo:id=>({id,name:'Summer 1'}),safeDisplayName:value=>value,
      __pt062NormalizeStyle:value=>value||'',__pt062GetRememberedStyle:()=>'',normalizeCarColorId:value=>value,
      overallFooterLayoutCss:()=>'',TRACK_CATALOG:new Map([['summer1',{id:'summer1',name:'Summer 1',type:'official'}]]),
      saveRankedProfileCosmetics:()=>{window.published=(window.published||0)+1;}
    });
    ${extract('cosmeticUnlocked')}
    ${extract('cosmeticUnlockReason')}
    ${extract('carModelPreview')}
    ${extract('applyProfileCosmetics')}
    ${extract('ensureStyles')}
    ${extract('profileCustomizerMarkup')}
    ${extract('setupRacerStudio')}
    ensureStyles();
    const fixtureEntry={userId:'racer-a',name:'APEX RACER',raceCount:8,pbCount:14,extraCount:0,totalPlaytimeMs:5400000,trackWins:0,rank:18,badges:{betaTester:false},cosmeticUnlocks:[]};
    document.querySelector('#content').innerHTML=profileCustomizerMarkup(fixtureEntry);
    setupRacerStudio(document.querySelector('#content'));
    const panel=document.querySelector('#overallLeaderboardPanel');
    panel.addEventListener('click',event=>{${patch.slice(choiceStart,choiceEnd)}${patch.slice(tabStart,tabEnd)}${patch.slice(saveStart,saveEnd)}});
    panel.addEventListener('change',event=>{${patch.slice(changeStart,changeEnd)}});
    window.nativeCatalog=PROFILE_COSMETIC_OPTIONS;window.nativeEntry=fixtureEntry;
    window.originalStudio=document.querySelector('.profile-customizer');
  `});
  await page.addStyleTag({url:base + '/tools/racer-studio-polish.css'});
  await page.evaluate(async () => {
    const {mountProfileAchievements} = await import('/tools/profile-achievement-bridge.mjs?channel=studio');
    const content = document.querySelector('#content');
    window.rewardCalls = [];
    cleanup = mountProfileAchievements(content,{accountId:'racer-a',confirmed:nativeEntry,local:{pbCount:17,extraCount:3,eventParticipations:2,practiceFinishes:17,verifiedTracks:8,activeDays:4},cosmetics:nativeCatalog,revision:'native-hub',onTryCosmetic:value => rewardCalls.push(value),onNavigate:value => rewardCalls.push(value)});
  });
}

test('native dialog is lazy, revision pinned, inline to event ancestry, and restores the exact Studio',async t => {
  const page = await pageFor(t);await mount(page);
  assert.equal(await page.locator('.profile-achievements').count(),0);
  assert.equal(await page.locator('link[data-profile-achievements-css]').count(),1);
  assert.equal(await page.locator('[data-aj-root]').count(),0);
  assert.equal(await page.locator('[data-ph-launch]').count(),2);
  assert.equal(await page.locator('.profile-customizer').isVisible(),false);
  assert.ok(!requests.some(url => url.includes('/achievement-journal.mjs')));
  await page.evaluate(() => {window.original = document.querySelector('.profile-customizer');original.addEventListener('input',()=>window.draftEvents=(window.draftEvents||0)+1);});
  await page.locator('[data-ph-launch="achievements"]').click();await page.locator('[data-aj-root]').waitFor();
  assert.equal(await page.locator('dialog').evaluate(el => el.matches(':modal')),true);
  assert.equal(await page.locator('.profile-customizer').evaluate(el => el === original && !!el.closest('.overall-profile-card') && !!el.closest('#overallLeaderboardPanel')),true);
  assert.ok(requests.includes('/tools/achievement-journal.mjs?channel=studio&v=hub-test'));
  await page.getByRole('tab',{name:'Racer Studio',exact:true}).click();
  await page.locator('[data-draft]').fill('Unpublished draft');
  await page.getByRole('button',{name:'Close racer hub',exact:true}).click();
  assert.equal(await page.locator('dialog').evaluate(el => el.open),false);
  assert.equal(await page.locator('#content>.profile-customizer').evaluate(el => el === original && el.hidden && !el.open && !el.querySelector('summary').hidden),true);
  assert.equal(await page.locator('[data-draft]').inputValue(),'Unpublished draft');
  assert.equal(await page.evaluate(() => draftEvents),1);
  assert.equal(await page.locator('[data-ph-launch="achievements"]').evaluate(el => el === document.activeElement),true);
});

test('modal keys stay scoped; native Studio handles its own keys; no duplicate global handlers',async t => {
  const page = await pageFor(t);await mount(page);await open(page);
  await page.evaluate(() => {window.outerKeys=[];document.querySelector('#overallLeaderboardPanel').addEventListener('keydown',event=>outerKeys.push(event.key));});
  const tab = page.getByRole('tab',{name:'Achievements',exact:true});await tab.focus();await page.keyboard.press('ArrowRight');
  assert.equal(await page.getByRole('tab',{name:'Racer Studio',exact:true}).getAttribute('aria-selected'),'true');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('dialog').evaluate(el => el.contains(document.activeElement)),true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog').evaluate(el => el.open),false);
  assert.deepEqual(await page.evaluate(() => outerKeys),[]);
  await page.locator('[data-ph-launch="achievements"]').focus();await page.keyboard.press('q');
  assert.deepEqual(await page.evaluate(() => outerKeys),['q']);
});

test('native cosmetic delegation, drafts, search and explicit publish survive Studio movement',{timeout:60000},async t => {
  const page = await pageFor(t);await nativeFixture(page);await open(page);
  await page.locator('[data-aj-family="style"]').click();await page.locator('[data-aj-filter="all"]').click();
  await page.locator('[data-aj-select="style:1"]').click();
  await page.getByRole('button',{name:'View reward: Deep ocean',exact:true}).click();
  assert.equal(await page.getByRole('tab',{name:'Racer Studio',exact:true}).getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('.profile-customizer').evaluate(el => el === originalStudio),true);
  assert.equal(await page.evaluate(() => window.published||0),0);
  assert.equal(await page.locator('[data-cosmetic-kind="theme"][data-cosmetic-value="ocean"]').getAttribute('aria-pressed'),'false');
  await page.locator('[data-cosmetic-kind="theme"][data-cosmetic-value="ocean"]').click();
  assert.equal(await page.evaluate(() => profileCosmeticDrafts.get('racer-a').theme),'ocean');
  const favorite = page.locator('[data-cosmetic-favorite]');
  await page.locator('[data-studio-tab="identity"]').click();await favorite.fill('Summer 1');await favorite.press('Tab');
  assert.equal(await page.evaluate(() => profileCosmeticDrafts.get('racer-a').favoriteTrackId),'summer1');
  await favorite.fill('Summer');await favorite.press('Escape');
  assert.equal(await page.locator('dialog').evaluate(el => el.open),true);
  assert.equal(await page.locator('.studio-track-options').getAttribute('hidden'),'');
  await favorite.press('ArrowDown');await favorite.press('ArrowDown');await favorite.press('Enter');
  assert.equal(await page.evaluate(() => profileCosmeticDrafts.get('racer-a').favoriteTrackId),'summer1');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('dialog').evaluate(el => el.open),false);
  assert.equal(await page.evaluate(() => profileCosmeticDrafts.get('racer-a').theme),'ocean');
  await open(page,'studio');
  assert.equal(await page.locator('[data-cosmetic-favorite]').inputValue(),'Summer 1');
  assert.equal(await page.evaluate(() => window.published||0),0);
  await page.locator('[data-save-profile-cosmetics]').click();assert.equal(await page.evaluate(() => published),1);
  await page.evaluate(() => cleanup());
  assert.equal(await page.locator('#content>.profile-customizer').evaluate(el => el === originalStudio),true);
  assert.equal(await page.locator('#content>.profile-customizer').getAttribute('hidden'),null);
  assert.equal(await page.locator('dialog').count(),0);
});

test('two half-bar launchers use one hub and restore original hidden/open states and drafts',async t => {
  for (const hidden of [false,true]) {
    const page = await pageFor(t);
    await page.evaluate(hidden => {
      document.querySelector('#content').innerHTML='<details class="profile-customizer" open><summary>Customize</summary><input data-draft value="Unpublished"></details>';
      window.savedStudio=document.querySelector('.profile-customizer');savedStudio.hidden=hidden;
    },hidden);
    await mount(page,'hidden-state');
    assert.equal(await page.locator('.profile-customizer').isVisible(),false);
    await page.locator('[data-ph-launch="studio"]').click();
    assert.equal(await page.getByRole('tab',{name:'Racer Studio',exact:true}).getAttribute('aria-selected'),'true');
    assert.equal(await page.locator('dialog .profile-customizer').evaluate(el => el===savedStudio&&!el.hidden&&el.open),true);
    await page.locator('[data-draft]').fill('Keep this draft');
    await page.evaluate(() => cleanup.close());
    assert.equal(await page.locator('#content>.profile-customizer').evaluate(el => el.hidden&&el.open),true);
    await page.evaluate(() => cleanup());
    assert.equal(await page.locator('#content>.profile-customizer').evaluate(el => el===savedStudio&&el.open),true);
    assert.equal(await page.locator('#content>.profile-customizer').evaluate(el => el.hidden),hidden);
    assert.equal(await page.locator('[data-draft]').inputValue(),'Keep this draft');
    assert.equal(await page.locator('dialog').count(),0);
  }
});

for (const mode of ['cleanup','disconnected','replaced','account']) test(`late import cannot mount into stale account after ${mode}`,{timeout:60000},async t => {
  const page = await pageFor(t);let release,started;
  const wait = new Promise(resolve => {release=resolve;}), began = new Promise(resolve => {started=resolve;});
  const revision = 'late-' + mode;gates.set(revision,{wait,started});t.after(() => {release();gates.delete(revision);});
  await mount(page,revision);await page.evaluate(() => cleanup.open());await began;
  await page.evaluate(mode => {
    window.oldHost=document.querySelector('[data-ph-journal]');
    if (mode==='cleanup') {cleanup();document.querySelector('#content').innerHTML='<p>New account</p>';}
    else if (mode==='replaced') document.querySelector('#content').innerHTML='<p>New account</p>';
    else if (mode==='account') document.querySelector('#content').dataset.accountId='different-racer';
    else document.querySelector('#content').remove();
  },mode);
  if (mode==='cleanup') {await mount(page,'replacement','replacement-racer');await open(page);}
  const response = page.waitForResponse(res => res.url().includes(`/achievement-journal.mjs?channel=studio&v=${revision}`));release();await response;
  await page.evaluate(async revision => {await import(`/tools/achievement-journal.mjs?channel=studio&v=${revision}`);await new Promise(resolve => setTimeout(resolve,0));},revision);
  assert.equal(await page.evaluate(() => oldHost.querySelectorAll('[data-aj-root]').length),0);
  assert.equal(await page.locator('dialog[open]').count(),mode==='cleanup'?1:0);
  if(mode==='cleanup') assert.equal(await page.locator('dialog').getAttribute('data-account-id'),'replacement-racer');
  else assert.equal(await page.locator('.profile-customizer').count(),0);
});

test('cleanup is root-scoped and storage persists safely across account mounts',async t => {
  const page = await pageFor(t);await mount(page);await open(page);
  await page.locator('[data-aj-filter="all"]').click();
  await page.evaluate(() => {window.oldCleanup=cleanup;cleanup();});await mount(page,'hub-test','racer-b');await open(page);
  await page.evaluate(() => oldCleanup());
  assert.equal(await page.locator('dialog[open]').getAttribute('data-account-id'),'racer-b');
  assert.equal(await page.locator('[data-aj-filter="all"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('link[data-profile-achievements-css]').count(),1);
  await page.evaluate(() => {cleanup();Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Blocked','SecurityError');},configurable:true});});
  await mount(page,'blocked');await open(page);await page.locator('[data-aj-filter="earned"]').click();
  assert.equal(await page.locator('[data-aj-filter="earned"]').getAttribute('aria-pressed'),'true');
});

test('native full-screen hub fits desktop, phone and landscape with usable reward navigation',{timeout:60000},async t => {
  for (const [name,width,height] of [['desktop',1440,1000],['laptop',1366,768],['phone',390,844],['landscape',844,390],['narrow',320,640]]) {
    const page = await pageFor(t,{width,height});await nativeFixture(page);
    assert.equal(await page.locator('.profile-customizer').isVisible(),false);
    if (name==='desktop'||name==='phone') await page.locator('.profile-achievement-journey').screenshot({path:path.join(evidence,`racer-hub-launcher-${name}.png`),animations:'disabled'});
    await page.locator('[data-ph-launch="achievements"]').click();await page.locator('[data-aj-root]').waitFor();await page.evaluate(() => document.fonts.ready);
    const bounds = await page.locator('dialog').boundingBox();assert.equal(Math.round(bounds.width),width);assert.equal(Math.round(bounds.height),height);
    assert.equal(await page.locator('dialog').evaluate(el => el.scrollWidth <= el.clientWidth),true,name);
    if (name==='landscape') {
      const goal=await page.locator('[data-aj-node]:visible').first().boundingBox();
      assert.ok(goal.y<height-30,'short landscape viewport shows the actual first goal, not only chrome');
    }
    if (name!=='narrow') await page.screenshot({path:path.join(evidence,`racer-hub-achievements-${name}.png`),animations:'disabled'});
    if (name==='phone'||name==='laptop') {
      await page.locator('[data-aj-node]:visible [data-aj-select]').first().click();
      assert.equal(await page.locator(name==='phone'?'[data-aj-node]>.aj-detail':'.aj-lane>.aj-detail').count(),1);
      await page.screenshot({path:path.join(evidence,`racer-hub-achievements-${name}-reward.png`),animations:'disabled'});
    }
    await page.getByRole('tab',{name:'Racer Studio',exact:true}).click();
    assert.equal(await page.locator('dialog').evaluate(el => el.scrollWidth <= el.clientWidth),true,name+' studio');
    assert.equal(await page.locator('.ph-studio-panel').evaluate(el => el.scrollWidth <= el.clientWidth),true,name+' studio panel');
    if (name!=='narrow') await page.screenshot({path:path.join(evidence,`racer-hub-studio-${name}.png`),animations:'disabled'});
  }
});

test('joined launcher has two native destinations with distinct recognizable SVG marks',async t=>{
  const page=await pageFor(t,{width:390,height:844});await nativeFixture(page);
  const launcher=page.locator('.profile-achievement-journey');assert.equal(await launcher.locator('button').count(),2);
  await page.locator('link[data-profile-achievements-css]').evaluate(link=>link.sheet?undefined:new Promise(resolve=>link.addEventListener('load',resolve,{once:true})));
  assert.equal(await launcher.locator('[data-ph-launch="achievements"] svg[data-ph-icon="achievements"]').count(),1);
  assert.equal(await launcher.locator('[data-ph-launch="studio"] svg[data-ph-icon="studio"]').count(),1);
  assert.equal(await launcher.locator('svg:not([aria-hidden="true"])').count(),0);
  assert.doesNotMatch(await launcher.innerText(),/\/\//);
  const bounds=await launcher.locator('button').evaluateAll(buttons=>buttons.map(button=>button.getBoundingClientRect().toJSON()));
  assert.ok(Math.abs(bounds[0].x+bounds[0].width-bounds[1].x)<2,`two destinations share one joined edge: ${JSON.stringify(bounds)}`);
  await launcher.locator('[data-ph-launch="studio"]').click();
  assert.equal(await page.getByRole('tab',{name:'Racer Studio',exact:true}).getAttribute('aria-selected'),'true');
  await page.keyboard.press('Escape');
  await launcher.locator('[data-ph-launch="achievements"]').click();
  assert.equal(await page.getByRole('tab',{name:'Achievements',exact:true}).getAttribute('aria-selected'),'true');
});

test('bounded joined launcher shares one highlight, preserves separate initial tabs and carries native pattern beneath panels',{timeout:30000},async t=>{
 for(const [name,width,height]of[['phone',390,844],['laptop',1366,768]]){
  const page=await pageFor(t,{width,height});await nativeFixture(page);
  await page.evaluate(()=>applyProfileCosmetics(document.querySelector('.overall-profile-card'),{theme:'forest',accent:'gold',stripe:'grid'}));
  await page.locator('link[data-profile-achievements-css]').evaluate(link=>link.sheet?undefined:new Promise(resolve=>link.addEventListener('load',resolve,{once:true})));
  await page.evaluate(()=>document.fonts.ready);
  const launcher=page.locator('.profile-achievement-journey');
  const joined=await launcher.evaluate(root=>({highlight:getComputedStyle(root).borderBottomWidth,accent:getComputedStyle(root).borderBottomColor,buttons:[...root.querySelectorAll('button')].map(button=>({background:getComputedStyle(button).backgroundColor,border:getComputedStyle(button).borderBottomWidth}))}));
  assert.equal(joined.highlight,'3px');assert.equal(joined.accent,'rgb(255, 213, 110)');assert.ok(joined.buttons.every(button=>button.background==='rgba(0, 0, 0, 0)'&&button.border==='0px'));
  await launcher.screenshot({path:path.join(evidence,`joined-theme-launcher-${name}.png`)});
  await launcher.locator('[data-ph-launch="studio"]').click();
  assert.equal(await page.locator('[data-ph-tab="studio"]').getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('[data-ph-tab="achievements"]').getAttribute('aria-selected'),'false');
  assert.match(await page.locator('.ph-studio-note').innerText(),/main menu garage/);
  assert.equal(await page.locator('.ph-studio-note button,.ph-studio-note a').count(),0);
  const painted=await page.locator('dialog').evaluate(root=>{const probe=document.createElement('i');probe.style.cssText='position:absolute;background-image:var(--profile-pattern,none)';root.append(probe);const pattern=getComputedStyle(probe).backgroundImage;probe.remove();return {background:getComputedStyle(root).backgroundImage,pattern,preview:getComputedStyle(root.querySelector('.profile-customizer-preview')).backgroundColor};});
  assert.ok(painted.pattern.includes('linear-gradient')&&painted.background.includes(painted.pattern),JSON.stringify(painted));assert.notEqual(painted.preview,'rgba(0, 0, 0, 0)');
  await page.screenshot({path:path.join(evidence,`joined-theme-studio-${name}.png`)});
  await page.keyboard.press('Escape');await launcher.locator('[data-ph-launch="achievements"]').click();await page.locator('[data-aj-root]').waitFor();
  assert.equal(await page.locator('[data-ph-tab="achievements"]').getAttribute('aria-selected'),'true');assert.equal(await page.locator('[data-ph-tab="studio"]').getAttribute('aria-selected'),'false');
  assert.equal(await page.locator('[data-aj-root]').evaluate(node=>getComputedStyle(node).backgroundColor),'rgba(0, 0, 0, 0)');
  assert.doesNotMatch(await page.locator('[data-aj-root]').innerText(),/wallet|planned coins|reward points|proposal|claim|credits earned/i);
  if(name==='phone'){
   const rail=await page.locator('.aj-paths button:visible').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect();return {family:node.dataset.ajFamily,x:r.x,right:r.right,scrollFits:node.scrollWidth<=node.clientWidth};}));
   assert.ok(rail.some(node=>node.family==='discovery'),'Discovery is visible without horizontal scrolling');
   assert.ok(rail.every(node=>node.x>=0&&node.right<=width&&node.scrollFits),JSON.stringify(rail));
  }
  assert.equal(await page.locator('dialog').evaluate(node=>node.scrollWidth<=node.clientWidth),true);
  await page.screenshot({path:path.join(evidence,`joined-theme-achievements-${name}.png`)});
  const before=await page.locator('dialog').evaluate(node=>getComputedStyle(node).backgroundImage);
  await page.evaluate(()=>{const card=document.querySelector('.overall-profile-card');card.classList.replace('cosmetic-theme-forest','cosmetic-theme-crimson');card.classList.replace('cosmetic-stripe-grid','cosmetic-stripe-chevron');});
  assert.notEqual(await page.locator('dialog').evaluate(node=>getComputedStyle(node).backgroundImage),before,'native theme and pattern update without cloning or remounting');
  assert.equal(await page.evaluate(()=>window.published||0),0);
 }
});

test('actual parent hook can still find moved Studio and focus reward without publication',async t => {
  const page = await pageFor(t);await nativeFixture(page);await page.evaluate(() => cleanup());
  await page.evaluate(() => Object.assign(window,{extraCatalogRevision:'real-hook',eventsModuleUrl:new URL('/events/client.mjs',location.href),readOverallSnapshotCache:()=>({entries:[nativeEntry]}),currentPlaytimeMs:()=>5400000}));
  const start=patch.indexOf('  function setupProfileAchievements('),end=patch.indexOf('  function setupRacerStudio(',start);assert.ok(start>=0&&end>start);
  await page.addScriptTag({content:'let profileAchievementBridgeRequest=null;'+patch.slice(start,end)});
  await page.evaluate(() => setupProfileAchievements(document.querySelector('#content'),nativeEntry,true));
  await page.locator('[data-ph-launch="achievements"]').click();await page.locator('[data-aj-root]').waitFor();
  await page.locator('[data-aj-family="style"]').click();await page.locator('[data-aj-filter="all"]').click();await page.locator('[data-aj-select="style:1"]').click();
  await page.getByRole('button',{name:'View reward: Deep ocean',exact:true}).click();
  assert.equal(await page.getByRole('tab',{name:'Racer Studio',exact:true}).getAttribute('aria-selected'),'true');
  assert.equal(await page.locator('.kind-theme').evaluate(el => el===document.activeElement || el.contains(document.activeElement)),true);
  assert.equal(await page.evaluate(() => window.published||0),0);
});

test('native hub body and rewards are explicitly sans serif while titles remain ForcedSquare',async t => {
  const page=await pageFor(t);await nativeFixture(page);await open(page);
  await page.locator('link[data-profile-achievements-css]').evaluate(link=>link.sheet?undefined:new Promise(resolve=>link.addEventListener('load',resolve,{once:true})));
  await page.evaluate(()=>document.fonts.ready);
  const typography=await page.evaluate(()=>{
    const read=selector=>{const style=getComputedStyle(document.querySelector(selector));return {fontFamily:style.fontFamily,fontSize:parseFloat(style.fontSize),lineHeight:parseFloat(style.lineHeight)};};
    return {root:read('dialog.profile-hub'),notice:read('.aj-notice'),reward:read('.aj-reward-label'),hint:read('.ph-tab-hint'),heading:read('.ph-heading h2'),goal:read('.aj-detail h3')};
  });
  const bodyFamilies={root:'Trebuchet MS',notice:'ForcedSquare',reward:'ForcedSquare',hint:'ForcedSquare'};
  for(const [key,family] of Object.entries(bodyFamilies)) {
    assert.deepEqual(typography[key].fontFamily.replaceAll('"','').split(',').map(value=>value.trim()),[family,'sans-serif'],`${key} intended font stack`);
    assert.ok(typography[key].fontSize>=13&&typography[key].fontSize<=14,`${key} body size`);
    assert.ok(typography[key].lineHeight/typography[key].fontSize>=1.35,`${key} body leading`);
  }
  for(const key of ['heading','goal']) assert.match(typography[key].fontFamily,/ForcedSquare/);
  const cdp=await page.context().newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');
  const documentNode=await cdp.send('DOM.getDocument');
  const noticeNode=await cdp.send('DOM.querySelector',{nodeId:documentNode.root.nodeId,selector:'.aj-notice'});
  typography.renderedNoticeFonts=(await cdp.send('CSS.getPlatformFontsForNode',{nodeId:noticeNode.nodeId})).fonts;
  assert.ok(typography.renderedNoticeFonts.length>0);
  assert.ok(typography.renderedNoticeFonts.every(font=>!/Times|Roman|Serif/i.test(font.familyName)), 'rendered prose must not fall back to a serif font');
  assert.ok(typography.renderedNoticeFonts.some(font=>font.isCustomFont&&font.glyphCount>0&&/forced.*square/i.test(font.familyName)), 'notice must render using the loaded native game font');
  await fs.writeFile(path.join(evidence,'racer-hub-typography.json'),JSON.stringify(typography,null,2));
});

test('1366x768 native sticky preview stays inside its panel and both design actions are reachable',{timeout:60000},async t=>{
  const page=await pageFor(t,{width:1366,height:768});await nativeFixture(page);await open(page,'studio');await page.evaluate(()=>document.fonts.ready);
  const panel=page.locator('.ph-studio-panel'),preview=page.locator('.profile-customizer-preview');
  const check=async()=>{
    const p=await panel.boundingBox(),v=await preview.boundingBox();
    assert.ok(v.y+v.height<=p.y+p.height+1,'preview bottom fits actual Studio panel');
    assert.equal(await preview.evaluate(el=>el.scrollWidth<=el.clientWidth),true,'no preview horizontal clipping');
    assert.equal(await preview.evaluate(el=>getComputedStyle(el).position),'sticky');
  };
  await check();
  await panel.evaluate(el=>{el.scrollTop=480;});await check();
  for(const selector of ['[data-save-profile-cosmetics]','[data-discard-profile-cosmetics]']){
    const button=page.locator(selector);await button.scrollIntoViewIfNeeded();await check();
    const b=await button.boundingBox(),v=await preview.boundingBox();
    assert.ok(b.y>=v.y-1&&b.y+b.height<=v.y+v.height+1,selector+' is vertically reachable');
    assert.ok(b.x>=v.x&&b.x+b.width<=v.x+v.width,selector+' is not left/right cropped');
  }
  await page.screenshot({path:path.join(evidence,'racer-hub-studio-scrolled-1366x768.png'),animations:'disabled'});
  await page.setViewportSize({width:1366,height:650});await page.waitForFunction(()=>Math.abs(parseFloat(document.querySelector('.ph-studio-panel').style.getPropertyValue('--ph-panel-height'))-document.querySelector('.ph-studio-panel').clientHeight)<1);
  await check();
  await page.setViewportSize({width:390,height:844});
  assert.equal(await preview.evaluate(el=>getComputedStyle(el).position),'static');
  assert.equal(await preview.evaluate(el=>getComputedStyle(el).maxHeight),'none');
});
