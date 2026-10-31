import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {startResponsiveServer} from './responsive-server.mjs';
import {installNativeRankedAuditFixture} from './native-ranked-audit-fixture.mjs';
const require=createRequire(new URL('./verifier/package.json',import.meta.url)),{chromium}=require('playwright');
const {revision}=JSON.parse(await readFile(new URL('../site-version.json',import.meta.url),'utf8'));
const {RELEASE_INFO}=await import('./release-info.mjs');
test('installed release notice defers to home, acknowledges exactly once and preserves local preferences',{timeout:150000},async()=>{
  const server=await startResponsiveServer(),browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage({viewport:{width:1366,height:768},serviceWorkers:'block'}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/v6/user')return route.fulfill({status:200,contentType:'application/json',body:'null'});
      if(url.origin===server.url&&['GET','HEAD'].includes(route.request().method()))return route.continue();
      return route.abort();
    });
    await installNativeRankedAuditFixture(page,{rejectWrites:true,acknowledgeInstalledRevision:false});
    await page.addInitScript(()=>localStorage.setItem('polytrack-0.6.2-ui-font-scale','110'));
    const home=async()=>{
      await page.waitForFunction(()=>{
        const visible=node=>!!node&&node.getClientRects().length>0;
        return visible(document.querySelector('.main-buttons-container'))||[...document.querySelectorAll('button')].some(button=>visible(button)&&button.textContent.trim()==='Exit');
      },null,{timeout:45000});
      if(await page.locator('.main-buttons-container').isVisible())return;
      await page.getByRole('button',{name:'Exit',exact:true}).click();
      assert.equal(await page.locator('dialog[data-site-installed-revision][open]').count(),0,'track menus do not show the installed-release modal');
      await page.getByRole('button',{name:'Back',exact:true}).click();
    };
    await page.goto(server.url,{waitUntil:'domcontentloaded'});await home();
    const notice=page.locator('dialog[data-site-installed-revision][open]');await notice.waitFor({timeout:20000});
    assert.equal(await notice.getAttribute('data-site-installed-revision'),String(revision));
    assert.equal(await notice.locator('h2').textContent(), `PolyTrack Ranked - Update ${RELEASE_INFO.number}`);
    assert.doesNotMatch(await notice.innerText(), /client revision/i);
    assert.match(await notice.locator('[data-site-update-age]').textContent(), /Committed|Device clock/);
    await page.keyboard.press('Escape');await notice.waitFor({state:'detached'});
    assert.equal(await page.evaluate(value=>localStorage.getItem(`polytrack-site-update-ack-release-v1:${value}`),RELEASE_INFO.number),'acknowledged');
    assert.equal(await page.evaluate(()=>localStorage.getItem('polytrack-0.6.2-ui-font-scale')),'110');
    await page.reload({waitUntil:'domcontentloaded'});await home();
    await page.waitForTimeout(6000);
    assert.equal(await notice.count(),0,'an acknowledged revision is not announced on every reload');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();await server.close();}
});
