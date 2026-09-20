import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../tools/verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const source=fs.readFileSync(new URL('./weekly-native.mjs',import.meta.url),'utf8').replace(/^export /gm,'');
test('native weekly card opens the event once and cannot launch a normal-PB race',async()=>{
 const browser=await chromium.launch({headless:true});try{const page=await browser.newPage();await page.setContent('<div class="track-selection-ui"><div class="track track-of-the-week"><button><div class="track-of-the-week-info"><div class="personal-best">NORMAL PB</div></div></button></div></div>');
 await page.addScriptTag({content:source});
 await page.evaluate(()=>{window.opens=[];window.normal=0;window.selection={trackId:'a'.repeat(64),endsAt:Date.now()+60000};document.querySelector('button').addEventListener('click',()=>window.normal++);window.stopWeekly=installWeeklyEventNavigation(document,()=>window.selection,async value=>window.opens.push(value));});
 assert.equal(await page.locator('.personal-best').isVisible(),false);await page.locator('button').click();
 assert.deepEqual(await page.evaluate(()=>opens),[{kind:'weekly',trackId:'a'.repeat(64)}]);assert.equal(await page.evaluate(()=>normal),0);
 await page.evaluate(()=>selection.endsAt=0);await page.locator('button').click();assert.equal(await page.evaluate(()=>opens.length),1);assert.equal(await page.evaluate(()=>normal),0);
 await page.evaluate(()=>stopWeekly());await page.locator('button').click();assert.equal(await page.evaluate(()=>normal),1);
 }finally{await browser.close();}
});
