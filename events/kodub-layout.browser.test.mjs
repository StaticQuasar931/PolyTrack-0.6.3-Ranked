import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {combineKodubCard} from './kodub-weekly.mjs';
const require=createRequire(new URL('../tools/verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
test('native rollover replaces moved card and preserves click behavior',async()=>{
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage();
  await page.setContent('<div class="track-selection-ui"><section><div class="group-title">Weekly</div><div class="track track-of-the-week"><button>Old</button></div></section><div class="community-track-group"><div class="track">Rolling Hills</div></div></div>');
  await page.evaluate(source=>{window.combine=Function('return ('+source+')')();window.selection={trackId:'a',endTime:new Date(Date.now()+60000).toISOString()};window.clicks=0;document.querySelector('button').onclick=()=>window.clicks++;},combineKodubCard.toString());
  const sync=()=>page.evaluate(()=>window.combine(document,document.querySelector('.community-track-group'),window.selection));
  await sync();await sync();assert.equal(await page.locator('.sq-kodub-weekly').count(),1);
  await page.locator('.sq-kodub-weekly button').click();assert.equal(await page.evaluate(()=>window.clicks),1);
  await page.evaluate(()=>window.combine(document,document.querySelector('.community-track-group'),window.selection,Date.parse(window.selection.endTime)));
  assert.equal(await page.locator('.sq-kodub-weekly').isVisible(),false);
  await page.evaluate(()=>{window.selection={trackId:'b',endTime:new Date(Date.now()+120000).toISOString()};});
  await sync();assert.equal(await page.locator('.sq-kodub-weekly').isVisible(),false);
  await page.evaluate(()=>{const section=document.querySelector('section');section.innerHTML='<div class="group-title">Weekly</div><div class="track track-of-the-week"><button>Next</button></div>';});
  await sync();assert.equal(await page.locator('.sq-kodub-weekly').count(),1);
  assert.equal(await page.locator('.sq-kodub-weekly').isVisible(),true);
  assert.match(await page.locator('.sq-kodub-weekly').innerText(),/Next/);
  assert.equal(await page.locator('.community-track-group>.track').count(),2);
 } finally {await browser.close();}
});
