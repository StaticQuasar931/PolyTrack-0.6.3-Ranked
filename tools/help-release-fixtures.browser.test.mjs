import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {RELEASE_INFO} from './release-info.mjs';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');

test('release 224 phone and desktop Help fixtures render with no network',{timeout:90000},async t=>{
  const browser=await chromium.launch({headless:true});
  t.after(()=>browser.close());
  const context=await browser.newContext({hasTouch:true,serviceWorkers:'block'});
  const requests=[];
  await context.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
  const page=await context.newPage();
  const [source,css,font]=await Promise.all([
    fs.readFile(new URL('./help-controls.mjs',import.meta.url),'utf8'),
    fs.readFile(new URL('../help-controls.css',import.meta.url),'utf8'),
    fs.readFile(new URL('../forced_square.woff2',import.meta.url))
  ]);
  const output=process.env.HELP_RELEASE_EVIDENCE;
  if(output)await fs.mkdir(output,{recursive:true});
  for(const [width,height] of [[1366,900],[390,844],[320,568]]){
    await page.setViewportSize({width,height});
    await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#09142c}main{max-width:1040px;margin:auto}</style><main></main>');
    await page.addStyleTag({content:'@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,'+font.toString('base64')+')}'+css});
    await page.addScriptTag({content:source.replace(/\bexport /g,'')+'\nwindow.helpAPI={renderHelpControls,bindHelpControls};'});
    await page.evaluate(release=>{
      const root=document.querySelector('main');
      root.innerHTML=window.helpAPI.renderHelpControls({idPrefix:'fixture',release,bindings:{VehicleAccelerate:['KeyI','ArrowUp']}});
      window.cleanup=window.helpAPI.bindHelpControls(root);
    },RELEASE_INFO);
    await page.evaluate(()=>document.fonts.ready);
    assert.equal(await page.locator('.hc-track-quick').isVisible(),true);
    assert.equal(await page.locator('.hc-track-quick').textContent(),'Track selectionShift + 1 OfficialShift + 2 CommunityShift + 3 Custom');
    assert.ok(await page.locator('[data-hc-row="VehicleAccelerate"]').textContent().then(text=>text.includes('Custom')));
    await page.locator('[data-hc-topic="tracks"]').tap();
    await page.locator('[data-hc-search]').fill('shift custom');
    assert.equal(await page.locator('[data-hc-row]:visible').count(),1);
    await page.locator('[data-hc-clear]').click();
    await page.locator('[data-hc-topic="tracks"]').focus();
    await page.keyboard.down('Shift');await page.keyboard.down('1');
    assert.equal(await page.locator('.hc-track-quick [data-hc-key="1"].is-pressed').count(),1);
    await page.keyboard.up('1');await page.keyboard.up('Shift');
    await page.evaluate(()=>scrollTo(0,0));
    if(output)await page.screenshot({path:join(output,`help-controls-${width}.png`),fullPage:true});
    await page.locator('[data-hc-view="release"]').tap();
    const release=page.locator('[data-hc-panel="release"]');
    assert.equal(await release.isVisible(),true);
    assert.ok((await release.textContent()).includes('Release number'+RELEASE_INFO.number+'Game version'+RELEASE_INFO.version+'Client revision'+RELEASE_INFO.revision));
    assert.doesNotMatch(await release.textContent(),/countdown|unlocks/i);
    assert.equal(await page.locator('.hc-track-quick').isVisible(),false);
    assert.equal(await release.locator('dt').filter({hasText:/^Commit$/}).count(),0);
    const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,rows:[...document.querySelectorAll('.hc-release-meta > div')].filter(node=>node.scrollWidth>node.clientWidth+1).length}));
    assert.ok(overflow.scroll<=overflow.width+1,JSON.stringify(overflow));assert.equal(overflow.rows,0);
    await page.evaluate(()=>scrollTo(0,0));
    if(output)await page.screenshot({path:join(output,`help-release-${width}.png`),fullPage:true});
    await page.evaluate(()=>window.cleanup());
  }
  assert.deepEqual(requests,[],'no external or local network requests, including Firebase');
});
