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
let server,browser,base;
const requests = [], gates = new Map();
before(async () => {
  server = http.createServer(async (req,res) => {
    const url = new URL(req.url,'http://localhost'); requests.push(url.pathname + url.search);
    if (url.pathname === '/') {res.setHeader('Content-Type','text/html'); res.end('<!doctype html><html lang="en"><title>Inline achievements integration</title><main id="content"><div class="profile-customizer">Studio</div></main></html>');return;}
    if (!['/tools/profile-achievement-bridge.mjs','/tools/achievement-journal.mjs','/tools/achievement-journal.css','/tools/racer-studio-polish.css'].includes(url.pathname)) {res.writeHead(404).end();return;}
    const gate = gates.get(url.searchParams.get('v'));
    if (url.pathname === '/tools/achievement-journal.mjs' && gate) {gate.started();await gate.wait;}
    try {res.setHeader('Content-Type',url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript');res.end(await fs.readFile(path.join(root,url.pathname.slice(1))));} catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve)); base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {})});
});
after(async () => {await browser?.close();if (server) await new Promise(resolve => server.close(resolve));});

async function mount(page,revision,accountId = 'racer-a') {
  await page.evaluate(async ({revision,accountId}) => {
    const {mountProfileAchievements} = await import('/tools/profile-achievement-bridge.mjs?channel=studio');
    window.calls ??= {rewards:[],navigate:[]};
    window.cleanup = mountProfileAchievements(document.querySelector('#content'),{accountId,revision,confirmed:{raceCount:0},local:{pbCount:0},cosmetics:{theme:[['ocean','Deep ocean',1]]},onTryCosmetic:value => calls.rewards.push(value),onNavigate:value => calls.navigate.push(value)});
  },{revision,accountId});
}

test('inline section is lazy, accessible, revision-pinned, callback-compatible and reusable',{timeout:60000},async t => {
  const context = await browser.newContext(),page = await context.newPage();t.after(() => context.close());
  let external = 0;
  await page.route('**/*',route => route.request().url().startsWith(base + '/') ? route.continue() : (external++,route.abort()));
  await page.goto(base);await mount(page,'bridge-copy');
  assert.equal(await page.locator('.profile-customizer').evaluate(el => el.previousElementSibling.matches('details.profile-achievement-journey')),true);
  assert.equal(await page.locator('summary').innerText(),'Achievements Find your next unlock');
  assert.equal(await page.locator('[data-aj-root]').count(),0);
  assert.equal(await page.locator('link[data-profile-achievements-css]').count(),1);
  assert.equal(await page.locator('.profile-achievements').count(),0);
  await page.locator('link[data-profile-achievements-css]').evaluate(link => link.sheet ? undefined : new Promise(resolve => link.addEventListener('load',resolve,{once:true})));
  assert.equal(await page.locator('.profile-achievement-journey-summary').evaluate(el => getComputedStyle(el).cursor),'pointer');
  assert.ok(!requests.some(url => url.includes('/achievement-journal.mjs')));
  await page.locator('summary').focus();await page.keyboard.press('Space');
  await page.locator('[data-aj-root]').waitFor();
  const href = await page.locator('link[data-profile-achievements-css]').getAttribute('href');
  assert.equal(new URL(href).searchParams.get('channel'),'studio');assert.equal(new URL(href).searchParams.get('v'),'bridge-copy');
  assert.ok(requests.some(url => url === '/tools/achievement-journal.mjs?channel=studio&v=bridge-copy'));
  await page.locator('[data-aj-detail] [data-aj-try]').click();
  assert.deepEqual(await page.evaluate(() => calls.rewards[0]),{kind:'theme',id:'ocean',label:'Deep ocean',requirement:1,confirmed:false,previewOnly:true});
  await page.locator('[data-aj-detail] [data-aj-navigate]').click();
  assert.deepEqual(await page.evaluate(() => calls.navigate),['style']);
  await page.getByRole('button',{name:'Close achievements',exact:true}).click();
  assert.equal(await page.locator('details').evaluate(el => el.open),false);
  assert.equal(await page.locator('summary').evaluate(el => el === document.activeElement),true);
  await page.locator('summary').click();await page.locator('[data-aj-root]').waitFor({state:'visible'});
  assert.equal(await page.locator('[data-aj-root]').count(),1);
  await page.locator('[data-aj-filter="all"]').click();
  await page.evaluate(() => {window.oldButton = document.querySelector('[data-aj-try]');cleanup();cleanup();});
  await mount(page,'bridge-copy','racer-b');await page.locator('summary').click();await page.locator('[data-aj-root]').waitFor();
  assert.equal(await page.locator('details').getAttribute('data-account-id'),'racer-b');
  assert.equal(await page.locator('link[data-profile-achievements-css]').count(),1);
  assert.equal(await page.locator('[data-aj-filter="all"]').getAttribute('aria-pressed'),'true');
  await page.evaluate(() => oldButton.click());
  assert.equal(await page.evaluate(() => calls.rewards.length),1);
  assert.equal(external,0);
});

for (const mode of ['cleanup','disconnected']) test(`late import cannot mount after ${mode}`,{timeout:60000},async t => {
  const context = await browser.newContext(),page = await context.newPage();t.after(() => context.close());
  let release,started;
  const wait = new Promise(resolve => {release = resolve;});
  const began = new Promise(resolve => {started = resolve;});
  const revision = `late-${mode}`; gates.set(revision,{wait,started});t.after(() => {release();gates.delete(revision);});
  await page.goto(base);await mount(page,revision);
  await page.locator('summary').click();await began;
  await page.evaluate(mode => {
    window.oldHost = document.querySelector('.profile-achievement-journey-content');
    if (mode === 'cleanup') {cleanup();document.querySelector('#content').innerHTML = '<p>New account</p>';}
    else document.querySelector('#content').remove();
  },mode);
  if (mode === 'cleanup') {
    await mount(page,'replacement','racer-replacement');
    await page.locator('summary').click();await page.locator('[data-aj-root]').waitFor();
  }
  const response = page.waitForResponse(res => res.url().includes(`/achievement-journal.mjs?channel=studio&v=${revision}`));
  release();await response;
  await page.evaluate(async revision => {
    await import(`/tools/achievement-journal.mjs?channel=studio&v=${revision}`);
    await new Promise(resolve => setTimeout(resolve,0));
  },revision);
  assert.equal(await page.evaluate(() => oldHost.querySelectorAll('[data-aj-root]').length),0);
  assert.equal(await page.locator('[data-aj-root]').count(),mode === 'cleanup' ? 1 : 0);
  if (mode === 'cleanup') assert.equal(await page.locator('details').getAttribute('data-account-id'),'racer-replacement');
});

test('separate roots keep callbacks and cleanup scoped to their own account',async t => {
  const context = await browser.newContext(),page = await context.newPage();t.after(() => context.close());await page.goto(base);
  await page.evaluate(async () => {
    const {mountProfileAchievements} = await import('/tools/profile-achievement-bridge.mjs?channel=studio');
    const second = document.createElement('main');second.id = 'second';document.body.append(second);
    window.rootCalls = [];
    const options = accountId => ({accountId,revision:'roots',confirmed:{raceCount:1},cosmetics:{theme:[['ocean','Deep ocean',1]]},storage:null,onTryCosmetic:() => rootCalls.push(accountId)});
    window.disposeFirst = mountProfileAchievements(document.querySelector('#content'),options('first'));
    window.disposeSecond = mountProfileAchievements(second,options('second'));
  });
  for (const selector of ['#content','#second']) {await page.locator(`${selector} summary`).click();await page.locator(`${selector} [data-aj-root]`).waitFor();await page.locator(`${selector} [data-aj-filter="earned"]`).click();}
  await page.locator('#second [data-aj-detail] [data-aj-try]').click();
  await page.evaluate(() => {disposeFirst();disposeFirst();});
  assert.equal(await page.locator('#content details').count(),0);
  assert.equal(await page.locator('#second [data-aj-root]').count(),1);
  await page.locator('#second [data-aj-detail] [data-aj-try]').click();
  assert.deepEqual(await page.evaluate(() => rootCalls),['second','second']);
  assert.equal(await page.locator('link[data-profile-achievements-css]').count(),1);
});

test('blocked default localStorage does not stop the journal opening or filters working',async t => {
  const context = await browser.newContext(),page = await context.newPage();t.after(() => context.close());await page.goto(base);
  await page.evaluate(() => Object.defineProperty(window,'localStorage',{get(){throw new DOMException('Blocked','SecurityError');},configurable:true}));
  await mount(page,'blocked-storage');await page.locator('summary').click();await page.locator('[data-aj-root]').waitFor();
  await page.locator('[data-aj-filter="all"]').click();
  assert.equal(await page.locator('[data-aj-filter="all"]').getAttribute('aria-pressed'),'true');
});

test('missing customizer appends section; detached input safely does nothing',async t => {
  const context = await browser.newContext(),page = await context.newPage();t.after(() => context.close());await page.goto(base);
  await page.evaluate(() => document.querySelector('.profile-customizer').remove());await mount(page,'append');
  assert.equal(await page.locator('#content>details').count(),1);
  assert.equal(await page.evaluate(async () => {
    const {mountProfileAchievements} = await import('/tools/profile-achievement-bridge.mjs');
    const detached = document.createElement('div'); const dispose = mountProfileAchievements(detached,{accountId:'detached'});dispose();return detached.childElementCount;
  }),0);
});


test('actual profile hook mounts achievements and navigates rewards into the real Studio section',async t=>{
  const context=await browser.newContext(),page=await context.newPage();t.after(()=>context.close());
  await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort());await page.goto(base);
  await page.evaluate(()=>{document.querySelector('#content').innerHTML='<details class="profile-customizer"><summary>Customize</summary><button data-studio-tab="nameplate">Nameplate</button><div data-studio-panel="nameplate"><fieldset class="profile-cosmetic-group kind-theme"><legend>Theme</legend></fieldset></div></details>';Object.assign(window,{extraCatalogRevision:'real-profile-hook',eventsModuleUrl:new URL('/events/client.mjs',location.href),cleanUserId:String,readOverallSnapshotCache:()=>({entries:[{userId:'self',raceCount:3}]}),localExtraTrackCount:()=>0,currentPlaytimeMs:()=>0,PROFILE_COSMETIC_OPTIONS:{theme:[['ocean','Ocean',1]]}});});
  const patch=await fs.readFile(path.join(root,'polytrack_062_patch.js'),'utf8'),start=patch.indexOf('  function setupProfileAchievements('),end=patch.indexOf('  function setupRacerStudio(',start);assert.ok(start>=0&&end>start);
  await page.addScriptTag({content:'let profileAchievementBridgeRequest=null;'+patch.slice(start,end)});
  await page.evaluate(()=>setupProfileAchievements(document.querySelector('#content'),{userId:'self'},true));
  await page.locator('.profile-achievement-journey>summary').click();await page.locator('[data-aj-root]').waitFor();
  await page.getByRole('button',{name:'All tiers',exact:true}).click();await page.locator('[data-aj-select]').first().click();await page.getByRole('button',{name:'View reward: Ocean',exact:true}).click();
  assert.equal(await page.locator('.profile-customizer').evaluate(el=>el.open),true);assert.equal(await page.locator('.kind-theme').evaluate(el=>el===document.activeElement),true);
});
