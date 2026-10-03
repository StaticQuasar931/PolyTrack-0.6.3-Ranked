import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
let chromium = null;
try { ({ chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')); } catch {}

test('filter menu works offline in a real browser: focus, preview, share and loadouts', {
  skip: !chromium && 'Set PLAYWRIGHT_MODULE to the bundled Playwright package to run this browser test.'
}, async () => {
  const menuPath = resolve(here, 'filter-menu.mjs');
  const cssPath = resolve(here, 'filter-menu.css');
  const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/filter-menu.css"></head><body>
    <button id="opener">Open filters</button><main id="root"></main>
    <script type="module">
      import { mountFilterMenu } from '/filter-menu.mjs';
      const users=[{accountId:'racer-1',name:'Racer One',rank:1,rp:12.345},{accountId:'racer-2',name:'Racer Two',rank:2}];
      let current={enabled:true}; let rendered=0; let failLoadoutWrites=false;
      const storage={getItem:key=>localStorage.getItem(key),setItem:(key,value)=>{
        if(failLoadoutWrites&&key==='polytrack-advanced-filter-loadouts-v1')throw new Error('quota exceeded');
        localStorage.setItem(key,value);
      }};
      const menu=mountFilterMenu({root:document.querySelector('#root'),storage,
        getRows:()=>users,getFilter:()=>current,getTracks:()=>[],
        onApply:next=>{current=next;return {unavailable:[]};},
        renderRacer:row=>row.accountId==='racer-1'?'<div class="overall-car-model image-container"><img class="show" alt=""></div>':'',
        onRenderRacers:()=>{rendered++;},
        exportCode:value=>'SHARE:'+JSON.stringify(value),
        importCode:value=>{if(value!=='valid-code')throw new Error('Malformed share code');return {whitelist:['racer-1']};}
      });
      window.fixture={menu,get rendered(){return rendered;},setFailLoadoutWrites:value=>{failLoadoutWrites=value;},
        getBackup:()=>localStorage.getItem('polytrack-advanced-filter-backup-v1'),getCurrent:()=>current};
      document.querySelector('#opener').addEventListener('click',()=>menu.open());
      window.ready=true;
    </script></body></html>`;
  const server = createServer(async (req, res) => {
    try {
      if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(html); return; }
      if (req.url === '/filter-menu.mjs') { res.writeHead(200, { 'content-type': 'text/javascript' }); res.end(await readFile(menuPath)); return; }
      if (req.url === '/filter-menu.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end(await readFile(cssPath)); return; }
      res.writeHead(404); res.end();
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.hostname === '127.0.0.1' ? route.continue() : route.abort();
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.waitForFunction(() => window.ready === true);
    const opener = page.locator('#opener');
    await opener.focus();
    await opener.click();
    const overlay = page.locator('.pt-group-filter-menu');
    await assert.doesNotReject(() => overlay.waitFor({ state: 'visible' }));
    await assert.doesNotReject(() => page.getByRole('button', { name: 'Close advanced filters' }).waitFor());
    await overlay.locator('.fm-button-pause').focus();
    await page.keyboard.press('Shift+Tab');
    const lastFocused = await page.evaluate(() => document.activeElement?.textContent?.trim());
    assert.match(lastFocused, /Apply filters/);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), 'Pause filters');

    const include = page.getByRole('searchbox', { name: 'Include racers' });
    await include.fill('Racer');
    await page.locator('.fm-user-picker [role="status"]').getByText('2 racers found.').waitFor();
    await page.getByRole('option', { name: /Racer One/ }).click();
    assert.equal(await page.locator('.fm-chips .fm-racer-native-preview img.show').count(), 1);
    await include.fill('Racer Two');
    await page.getByRole('option', { name: /Racer Two/ }).click();
    const fallback = page.locator('.fm-chips .fm-initials');
    assert.equal(await fallback.textContent(), 'RT');
    assert.equal(await fallback.getAttribute('aria-hidden'), 'true');
    await page.locator('.fm-user-picker [role="status"]').getByText('Racer Two selected.').waitFor();
    assert.ok(await page.evaluate(() => window.fixture.rendered > 0));

    await page.getByRole('button', { name: 'Share and loadouts' }).click();
    await page.getByRole('button', { name: 'Create share code' }).click();
    assert.match(await page.getByRole('textbox', { name: 'Shared filter code' }).inputValue(), /^SHARE:/);
    const share = page.getByRole('textbox', { name: 'Shared filter code' });
    await share.fill('invalid');
    await page.getByRole('button', { name: 'Import code' }).click();
    await page.getByRole('status').getByText('Malformed share code').waitFor();
    await share.fill('valid-code');
    await page.getByRole('button', { name: 'Import code' }).click();
    await page.getByRole('status').getByText('Code imported into the editor').waitFor();

    await page.getByRole('button', { name: 'Share and loadouts' }).click();
    await page.getByRole('textbox', { name: 'Loadout name' }).fill('Browser test');
    await page.getByRole('button', { name: 'Save current' }).click();
    const loadoutData = page.getByRole('textbox', { name: 'Loadout import and export data' });
    await page.getByRole('button', { name: 'Export loadouts' }).click();
    const exported = JSON.parse(await loadoutData.inputValue());
    assert.equal(exported.presets[0].name, 'Browser test');
    await loadoutData.fill('{}');
    await page.getByRole('button', { name: 'Import loadouts' }).click();
    await page.getByRole('status').getByText('Loadout data must contain a presets list').waitFor();

    const backupBeforeFailures = await page.evaluate(() => window.fixture.getBackup());
    await page.evaluate(() => window.fixture.setFailLoadoutWrites(true));
    await page.getByRole('textbox', { name: 'Loadout name' }).fill('Unsaved');
    await page.getByRole('button', { name: 'Save current' }).click();
    await page.locator('.fm-status').getByText('Loadout could not be saved').waitFor();
    await page.getByRole('button', { name: 'Export loadouts' }).click();
    assert.deepEqual(JSON.parse(await loadoutData.inputValue()).presets.map(item => item.name), ['Browser test']);

    const select = page.getByRole('combobox', { name: 'Saved loadouts' });
    await select.selectOption({ value: 'Browser test' });
    await page.getByRole('button', { name: '☆ Favorite' }).click();
    await page.locator('.fm-status').getByText('Favorite could not be saved').waitFor();
    assert.equal(await page.getByRole('button', { name: '☆ Favorite' }).count(), 1);
    await page.getByRole('button', { name: 'Export loadouts' }).click();
    assert.equal(JSON.parse(await loadoutData.inputValue()).presets[0].favorite, false);
    await page.getByRole('button', { name: 'Delete selected' }).click();
    await page.locator('.fm-status').getByText('Loadout could not be deleted').waitFor();
    assert.equal(await select.inputValue(), 'Browser test');
    await page.getByRole('button', { name: 'Export loadouts' }).click();
    assert.deepEqual(JSON.parse(await loadoutData.inputValue()).presets.map(item => item.name), ['Browser test']);

    await loadoutData.fill(JSON.stringify({ presets: [{ name: 'Failed import', filter: { blacklist: ['racer-1'] } }] }));
    await page.getByRole('button', { name: 'Import loadouts' }).click();
    await page.locator('.fm-status').getByText('Loadouts could not be saved in this browser').waitFor();
    await page.getByRole('button', { name: 'Export loadouts' }).click();
    assert.deepEqual(JSON.parse(await loadoutData.inputValue()).presets.map(item => item.name), ['Browser test']);
    assert.equal(await page.evaluate(() => window.fixture.getBackup()), backupBeforeFailures);

    await select.selectOption({ value: 'Browser test' });
    const filterBeforeFailedLoad = await page.locator('.fm-user-picker').first().locator('.fm-chips').innerText();
    await page.getByRole('button', { name: 'Load selected' }).click();
    await page.locator('.fm-status').getByText('Loadout usage could not be saved').waitFor();
    assert.equal(await page.locator('.fm-user-picker').first().locator('.fm-chips').innerText(), filterBeforeFailedLoad);
    assert.equal(await page.evaluate(() => window.fixture.getBackup()), backupBeforeFailures);

    await page.evaluate(() => window.fixture.setFailLoadoutWrites(false));
    await page.getByRole('button', { name: '☆ Favorite' }).click();
    await page.getByRole('button', { name: '★ Favorited' }).waitFor();
    await page.getByRole('button', { name: 'Export loadouts' }).click();
    const savedBeforeQuickAction = JSON.parse(await loadoutData.inputValue()).presets[0];
    await page.evaluate(() => window.fixture.setFailLoadoutWrites(true));

    assert.equal(await page.evaluate(() => window.fixture.menu.updateRacer('racer-1', 'exclude')), true);
    await page.locator('.fm-status').getByText('Racer excluded in the active filter, but saved loadout "Browser test" could not be updated').waitFor();
    assert.deepEqual(await page.evaluate(() => window.fixture.getCurrent().blacklist), ['racer-1']);
    await page.getByRole('button', { name: 'Export loadouts' }).click();
    assert.deepEqual(JSON.parse(await loadoutData.inputValue()).presets[0], savedBeforeQuickAction);

    assert.equal(await page.evaluate(() => window.fixture.menu.updateRacer('racer-2', 'include')), true);
    await page.locator('.fm-status').getByText('Racer forced into results in the active filter, but saved loadout "Browser test" could not be updated').waitFor();
    assert.deepEqual(await page.evaluate(() => window.fixture.getCurrent().forcedIncludes), ['racer-2']);
    await page.getByRole('button', { name: 'Export loadouts' }).click();
    assert.deepEqual(JSON.parse(await loadoutData.inputValue()).presets[0], savedBeforeQuickAction);
    await page.evaluate(() => window.fixture.setFailLoadoutWrites(false));

    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'opener');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise(resolveClose => server.close(resolveClose));
  }
});
