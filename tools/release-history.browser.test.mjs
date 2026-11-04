import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {startResponsiveServer} from './responsive-server.mjs';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require('playwright');

test('real update archive fits phones, closes without acknowledgment and keeps keyboard focus',{timeout:90000},async()=>{
  const server=await startResponsiveServer(),browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage({serviceWorkers:'block'}),unexpected=[];
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.origin===server.url&&url.pathname==='/history-fixture')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>@font-face{font-family:ForcedSquare;src:url(/forced_square.woff2)}body{margin:0;background:#14254b}</style><button id="start">Menu</button>'});
      if(url.origin===server.url&&(url.pathname.startsWith('/tools/')||url.pathname==='/forced_square.woff2')&&route.request().method()==='GET')return route.continue();
      unexpected.push(url.href);return route.abort();
    });
    await page.goto(server.url+'/history-fixture');
    const number=await page.evaluate(async()=>{
      const {RELEASE_INFO}=await import('/tools/release-info.mjs');
      const {RELEASE_HISTORY}=await import('/tools/release-history.mjs');
      const previous=RELEASE_HISTORY.entries.filter(entry=>Number.isSafeInteger(entry.number))[1];
      localStorage.setItem('polytrack-site-update-ack-release-v1:'+previous.number,'acknowledged');
      const {installInstalledRevisionNotice}=await import('/tools/site-updates.mjs');
      window.notice=installInstalledRevisionNotice({revision:RELEASE_INFO.revision,release:RELEASE_INFO,isReady:()=>true,isIdle:()=>true});
      await document.fonts.ready;return RELEASE_INFO.number;
    });
    const dialog=page.locator('dialog[data-site-installed-release]'),archive=dialog.locator('[data-release-history]');
    await dialog.waitFor();
    assert.match(await dialog.locator('[data-site-updates-since-ack]').innerText(),/^2 newer updates$/);
    for(const [width,height] of [[1366,900],[390,844],[320,568],[844,390]]){
      await page.setViewportSize({width,height});
      await archive.locator(':scope > summary').click();
      assert.equal(await archive.evaluate(node=>node.open),true);
      const entry=archive.locator('[data-release-history-entry]').first();
      assert.equal(await archive.locator(':scope > summary').innerText(),'Earlier updates');
      assert.match(await entry.locator('summary').getAttribute('title'),/^Committed: .+/);
      await entry.locator('summary').click();await page.keyboard.press('Escape');
      assert.equal(await entry.evaluate(node=>node.open),false);
      assert.equal(await archive.evaluate(node=>node.open),true);
      await page.keyboard.press('Escape');
      assert.equal(await archive.evaluate(node=>node.open),false);
      assert.equal(await dialog.isVisible(),true);
      assert.equal(await page.evaluate(n=>localStorage.getItem('polytrack-site-update-ack-release-v1:'+n),number),null);
      const box=await dialog.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1);
      assert.equal(await page.evaluate(()=>document.activeElement.matches('[data-release-history] > summary')),true);
    }
    await dialog.getByRole('button',{name:'OK',exact:true}).click();
    assert.equal(await page.evaluate(n=>localStorage.getItem('polytrack-site-update-ack-release-v1:'+n),number),'acknowledged');
    await page.evaluate(()=>window.notice.dispose());
    assert.deepEqual(unexpected,[]);
  } finally {await browser.close();await server.close();}
});
