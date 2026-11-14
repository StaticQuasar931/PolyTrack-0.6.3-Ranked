import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const root = fileURLToPath(new URL('../',import.meta.url));
const evidence = path.resolve(process.env.ACHIEVEMENT_EVIDENCE_DIR || path.join(root,'2026-11-13/evening-update'));
let server,browser,base,cosmetics;
before(async () => {
  const patch = await fs.readFile(path.join(root,'polytrack_062_patch.js'),'utf8');
  cosmetics = JSON.parse(JSON.stringify(vm.runInNewContext(`(${patch.match(/const PROFILE_COSMETIC_OPTIONS=(\{[\s\S]*?\n  \});/)[1]})`)));
  server = http.createServer(async (req,res) => {
    const pathname = new URL(req.url,'http://localhost').pathname;
    if (pathname === '/') {
      res.setHeader('Content-Type','text/html');
      res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>PolyTrack achievement journal fixture</title><link rel="stylesheet" href="/tools/achievement-journal.css"><style>@font-face{font-family:ForcedSquare;src:url(/forced_square.woff2)}body{margin:0;background:#0e1934}main{max-width:1440px;margin:auto}</style><main id="host"></main></html>'); return;
    }
    const allowed = {'/tools/achievement-journal.mjs':'text/javascript','/tools/achievement-model.mjs':'text/javascript','/tools/achievement-journal.css':'text/css','/forced_square.woff2':'font/woff2'};
    if (!allowed[pathname]) { res.writeHead(404).end(); return; }
    try { res.setHeader('Content-Type',allowed[pathname]); res.end(await fs.readFile(path.join(root,pathname.slice(1)))); } catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ? {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE} : {})});
  await fs.mkdir(evidence,{recursive:true});
});
after(async () => { await browser?.close(); if (server) {server.closeAllConnections();await new Promise(resolve => server.close(resolve));} });

async function fixture(page,extra = {}) {
  await page.goto(base);
  return page.evaluate(async ({cosmetics,extra}) => {
    const api = await import('/tools/achievement-journal.mjs');
    window.calls = {try:[],navigate:[],closed:0,storage:[]};
    window.input = {cosmetics,progress:{confirmed:{raceCount:8,pbCount:10,extraCount:0,totalPlaytimeMs:3600000,trackWins:0,rank:18,badges:{betaTester:false},cosmeticUnlocks:[]},local:{pbCount:14,verifiedTracks:8,extraCount:3,totalPlaytimeMs:5400000,trackWins:0,eventParticipations:2,practiceFinishes:17}},...extra};
    const host = document.querySelector('#host');
    host.innerHTML = api.renderAchievementJournal(window.input);
    window.dispose = api.bindAchievementJournal(host,{onTryCosmetic:value => calls.try.push(value),onNavigate:value => calls.navigate.push(value),onClose:() => calls.closed++,storage:{getItem:() => null,setItem:(...args) => calls.storage.push(args)}});
    await document.fonts.ready;
    return api.buildAchievementJournalModel(window.input).counts;
  },{cosmetics,extra});
}

test('desktop catalog, filters, reward callbacks, keyboard, disposal and no external requests',{timeout:60000},async t => {
  const context = await browser.newContext({viewport:{width:1440,height:1100}}),page = await context.newPage();
  t.after(() => context.close()); let external = 0; const errors = [];
  page.on('pageerror',error => errors.push(error.message));
  await page.route('**/*',route => route.request().url().startsWith(base + '/') ? route.continue() : (external++,route.abort()));
  const counts = await fixture(page);
  assert.equal(await page.locator('.aj-branch').count(),6);
  await page.screenshot({path:path.join(evidence,'achievement-journal-desktop.png'),fullPage:true,animations:'disabled'});
  await page.locator('[data-aj-filter="all"]').click();
  await page.locator('[data-aj-family="discovery"]').click();
  const extra = page.locator('[data-aj-select="discovery:extra:1"]');
  await extra.click();
  assert.match(await page.locator('[data-aj-detail]').innerText(),/In progress/);
  assert.match(await page.locator('[data-aj-detail]').innerText(),/Saved on this device: 3/);
  assert.match(await page.locator('[data-aj-detail] [data-aj-try]').first().getAttribute('aria-label'),/^View reward:/);
  await page.locator('[data-aj-detail] [data-aj-try]').first().click();
  assert.equal(await page.evaluate(() => calls.try[0].confirmed),false);
  assert.equal(await page.evaluate(() => calls.try[0].previewOnly),true);
  assert.equal(await page.evaluate(() => calls.try[0].requirement),'extra:1');
  await page.locator('[data-aj-detail] [data-aj-navigate]').click();
  assert.deepEqual(await page.evaluate(() => calls.navigate),['discovery']);
  await page.locator('[data-aj-family="all"]').click();
  await page.locator('[data-aj-filter="earned"]').click();
  assert.equal(await page.locator('[data-aj-node]:visible').count(),counts.earned);
  const first = page.locator('[data-aj-node]:visible [data-aj-select]').first();
  await first.focus(); await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('[data-aj-node]:visible [data-aj-select]').nth(1).evaluate(el => document.activeElement === el),true);
  await page.keyboard.press('Home'); assert.equal(await first.evaluate(el => document.activeElement === el),true);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => calls.closed),1);
  await page.evaluate(() => dispose()); await page.locator('[data-aj-close]').click();
  assert.equal(await page.evaluate(() => calls.closed),1);
  assert.equal(external,0); assert.deepEqual(errors,[]);
  await fs.writeFile(path.join(evidence,'achievement-journal-counts.json'),JSON.stringify({fixture:'Anonymized exact-count fixture, not a live account',counts,externalRequests:external},null,2));
});

test('portrait, narrow phone, zoom and reduced motion fit without horizontal overflow',{timeout:60000},async t => {
  const context = await browser.newContext({reducedMotion:'reduce'}),page = await context.newPage(); t.after(() => context.close());
  for (const width of [390,320,768]) {
    await page.setViewportSize({width,height:844}); await fixture(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true,`overflow at ${width}`);
    assert.equal(await page.locator('.aj').evaluate(el => getComputedStyle(el).animationName),'none');
    const undersized = await page.locator('.aj button:visible').evaluateAll(elements => elements.filter(el => el.getBoundingClientRect().height < 44).length);
    assert.equal(undersized,0);
    if (width <= 660) {
      assert.equal(await page.locator('[data-aj-node]>.aj-detail').count(),0);
      await page.locator('[data-aj-family="events"]').click();
      await page.locator('[data-aj-select="achievement:v1:event-participation:3"]').click();
      assert.match(await page.locator('[data-aj-node="achievement:v1:event-participation:3"] .aj-detail').innerText(),/Personal milestone/);
      assert.match(await page.locator('[data-aj-node="achievement:v1:event-participation:3"] .aj-detail').innerText(),/Saved on this device/);
    } else assert.equal(await page.locator('.aj-lane>.aj-detail').count(),1);
    if (width === 390) await page.screenshot({path:path.join(evidence,'achievement-journal-phone.png'),fullPage:true,animations:'disabled'});
  }
  // A 1280x900 window at 200% zoom has a 640x450 CSS layout viewport.
  await page.setViewportSize({width:640,height:450});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),true);
});

test('empty, zero counts, hostile labels and blocked preference storage remain usable',async t => {
  const context = await browser.newContext(),page = await context.newPage();t.after(() => context.close());
  await fixture(page,{cosmetics:{},progress:{}});
  assert.match(await page.locator('.aj-empty').innerText(),/No progress/);
  assert.equal(await page.locator('.aj-branch').count(),0);
  await fixture(page,{cosmetics:{theme:[['x','<img src=x onerror=alert(1)>',1]]},progress:{local:{eventParticipations:0}}});
  assert.equal(await page.locator('.aj img').count(),0);
  await page.evaluate(async () => {
    dispose(); const {bindAchievementJournal} = await import('/tools/achievement-journal.mjs');
    dispose = bindAchievementJournal(document.querySelector('#host'),{storage:{getItem(){throw Error('blocked');},setItem(){throw Error('blocked');}}});
  });
  await page.locator('[data-aj-filter="earned"]').click();
  assert.equal(await page.locator('[data-aj-node]:visible').count(),0);
  assert.match(await page.locator('[data-aj-detail]').innerText(),/No milestones match/);
  await page.locator('[data-aj-filter="all"]').click();
  await page.locator('[data-aj-family="all"]').click();
  assert.equal(await page.locator('[data-aj-node]:visible').count(),await page.evaluate(async()=> (await import('/tools/achievement-journal.mjs')).buildAchievementJournalModel(input).counts.total));
});

test('known goals lead by default, unknowns stay under All tiers, and proposal points never appear',async t => {
  const context=await browser.newContext(),page=await context.newPage();t.after(()=>context.close());
  await fixture(page,{cosmetics:{},progress:{local:{practiceFinishes:5}}});
  assert.equal(await page.locator('[data-aj-family="practice"]').getAttribute('aria-pressed'),'true');
  assert.equal(await page.locator('[data-aj-node]:visible').count(),1);
  assert.equal(await page.locator('[data-aj-node]:visible').getAttribute('data-aj-known'),'true');
  assert.equal(await page.locator('[data-aj-node]:visible').getAttribute('data-aj-node'),'achievement:v1:practice-finishes:10');
  assert.equal(await page.locator('[data-aj-family="daily"]').isVisible(),false);
  await page.locator('[data-aj-filter="all"]').click();await page.locator('[data-aj-family="all"]').click();
  assert.equal(await page.locator('[data-aj-family="daily"]').isVisible(),true);
  assert.ok(await page.locator('[data-aj-known="false"]:visible').count()>0);
  assert.equal(await page.locator('[data-aj-known="false"] progress').first().getAttribute('value'),null);
  assert.match(await page.locator('[data-aj-known="false"]').first().innerText(),/Not tracked yet/);
  assert.doesNotMatch(await page.locator('[data-aj-root]').innerText(),/wallet|planned coins|reward points|proposal|claim/i);
  await page.locator('[data-aj-search-input]').fill('faster line');
  assert.ok(await page.locator('[data-aj-node]:visible').count()>0);
  await page.locator('[data-aj-node]:visible [data-aj-select]').first().click();
  assert.equal(await page.locator('.aj-more').count(),1);
  assert.equal(await page.locator('.aj-more').getAttribute('open'),null);
});

test('full-width lanes preserve all 81 model tiers and use recognizable inline path icons',async t=>{
  const context=await browser.newContext({viewport:{width:1366,height:768}}),page=await context.newPage();t.after(()=>context.close());
  await fixture(page);await page.locator('[data-aj-filter="all"]').click();await page.locator('[data-aj-family="all"]').click();
  const ids=await page.locator('[data-aj-node]').evaluateAll(nodes=>nodes.map(node=>node.dataset.ajNode));
  assert.equal(ids.filter(id=>id.startsWith('achievement:v1:')).length,81);assert.equal(new Set(ids).size,ids.length);
  assert.ok(await page.locator('[data-aj-lane]').count()>10);
  const widths=await page.locator('[data-aj-lane]:visible').evaluateAll(lanes=>lanes.map(lane=>({lane:lane.getBoundingClientRect().width,tree:lane.closest('.aj-tree').getBoundingClientRect().width})));
  assert.ok(widths.every(row=>Math.abs(row.lane-row.tree)<2),'lanes occupy the full goal area');
  assert.equal(await page.locator('[data-aj-family="daily"] svg[data-aj-icon="daily"]').count(),1);
  assert.equal(await page.locator('[data-aj-family="style"] svg[data-aj-icon="style"]').count(),1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.locator('[data-aj-family="practice"]').click();
  assert.match(await page.locator('.aj-lane-head h4').allTextContents().then(names=>names.join(' ')),/Personal bests|Finish your practice runs/);
});

test('lane overview starts compact and opens or closes the actual selected reward inspector by keyboard',async t=>{
  const context=await browser.newContext({viewport:{width:1366,height:768}}),page=await context.newPage();t.after(()=>context.close());
  await fixture(page);assert.equal(await page.locator('.aj-detail').isVisible(),false);
  const goal=page.locator('[data-aj-node]:visible [data-aj-select]').first();
  assert.equal(await goal.getAttribute('aria-expanded'),'false');await goal.focus();await goal.press('Enter');
  assert.equal(await goal.getAttribute('aria-expanded'),'true');assert.equal(await page.locator('.aj-lane>.aj-detail').isVisible(),true);
  await goal.press('Enter');assert.equal(await goal.getAttribute('aria-expanded'),'false');assert.equal(await page.locator('.aj-detail').isVisible(),false);
  await goal.press('Enter');await page.locator('[data-aj-filter="all"]').click();assert.equal(await page.locator('.aj-detail').isVisible(),false);
});
