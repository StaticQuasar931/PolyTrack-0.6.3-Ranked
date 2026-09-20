import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../tools/verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const css=fs.readFileSync(new URL('./events.css',import.meta.url),'utf8');
test('0.6.3 version navigation and event cards stay within desktop and portrait widths',async()=>{
 const browser=await chromium.launch({headless:true});
 try{const page=await browser.newPage();
 await page.setContent(`<style>body{margin:0}.wrapper{display:grid;grid-template-columns:repeat(2,1fr);width:1150px}.community-track-versions{height:488px}.hidden{display:none}</style><div id="ui"><div class="track-selection-ui"><div class="tracks-container"><div class="wrapper"><div class="community-track-versions"><button class="button">StaticQuasar931</button><button class="button">0.6.3</button><button class="button">0.6.1</button></div><div class="community-track-group sq-event-track-group"><div class="track"><button class="button">Rolling Hills Racer</button></div><button class="sq-events-entry">Events</button><div class="sq-event-track-buttons"><button class="sq-event-card">Weekly event</button><button class="sq-event-card">Daily event</button></div></div></div></div></div></div>`);
 await page.addStyleTag({content:css});
 for(const [width,height] of [[1366,768],[390,844],[768,1024]]){
  await page.setViewportSize({width,height});
  const nav=await page.locator('.community-track-versions').boundingBox();assert(nav.height<=64);
  for(const selector of ['.sq-event-track-group','.sq-event-card'])for(const item of await page.locator(selector).all()){
   const box=await item.boundingBox();assert(box.x>=0&&box.x+box.width<=width+1,`${selector} overflow at ${width}`);
  }
 }
 await page.locator('.sq-event-track-group').evaluate(e=>e.classList.add('hidden'));
 assert.equal(await page.locator('.sq-event-card').first().isVisible(),false);
 }finally{await browser.close();}
});
