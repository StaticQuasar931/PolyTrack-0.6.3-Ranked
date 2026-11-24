import test from 'node:test';
import assert from 'node:assert/strict';
import {compactRankedMode,installCompactRankedLayout} from './compact-ranked-layout.mjs';

test('compact footer follows available width and short height, not a device identity',()=>{
 for(const [width,height,expected]of [
  [320,568,'portrait'],[440,780,'portrait'],[700,900,'portrait'],
  [701,900,'desktop'],[560,500,'landscape'],[844,320,'landscape'],
  [1100,500,'landscape'],[1101,500,'desktop'],[956,501,'desktop'],
  [1366,600,'desktop'],[1920,1080,'desktop'],[3440,1440,'desktop']
 ])assert.equal(compactRankedMode(width,height),expected,`${width}x${height}`);
});
test('optional setup is safe without a browser document',()=>{
 assert.equal(typeof installCompactRankedLayout({document:null,window:null}),'function');
 installCompactRankedLayout({document:null,window:null})();
});

test('dynamic ranking scope controls enter the mobile drawer and restore their original desktop position',async()=>{
 const {createRequire}=await import('node:module'),fs=await import('node:fs/promises');
 const {chromium}=createRequire(new URL('./verifier/package.json',import.meta.url))('playwright');
 const source=await fs.readFile(new URL('./compact-ranked-layout.mjs',import.meta.url),'utf8');
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:440,height:780}});
  await page.route('**/*',r=>r.abort());
  await page.setContent('<main id="overallLeaderboardPanel"><footer id="overallDailyGrid"><div class="overall-center-tools"><nav>Pages</nav></div><div class="overall-footer-right"><div class="overall-freshness">Snapshot</div></div></footer></main>');
  await page.evaluate(async text=>{const module=await import('data:text/javascript,'+encodeURIComponent(text));window.dispose=module.installCompactRankedLayout({document,window});},source);
  await page.evaluate(()=>document.querySelector('.overall-center-tools').insertAdjacentHTML('beforeend','<div id="overallRankingScope" class="overall-track-scope"><button>Total</button><button>Official only</button></div>'));
  await page.waitForFunction(()=>document.querySelector('#overallRankingScope').parentElement.id==='overallMobileTools');
  const tools=page.getByRole('button',{name:'More ranking tools'});
  await tools.evaluate(button=>button.focus());
  assert.equal(await tools.getAttribute('aria-description'),'Track filters, snapshot status, quick rankings, and challenges');
  assert.equal(await tools.getAttribute('aria-expanded'),'false');
  await tools.press('Enter');
  assert.equal(await tools.getAttribute('aria-expanded'),'true');
  assert.equal(await page.locator('#overallRankingScope').isVisible(),true);
  await page.evaluate(()=>document.querySelector('#overallRankingScope').outerHTML='<div id="overallRankingScope" class="overall-track-scope"><button>New scope</button></div>');
  await page.waitForFunction(()=>document.querySelector('#overallRankingScope').parentElement.id==='overallMobileTools');
  await page.setViewportSize({width:1366,height:600});
  await page.waitForFunction(()=>document.querySelector('#overallRankingScope').parentElement.classList.contains('overall-center-tools'));
  assert.equal(await page.locator('#overallRankingScope').count(),1);
  await page.setViewportSize({width:956,height:360});
  await page.waitForFunction(()=>document.querySelector('#overallRankingScope').parentElement.id==='overallMobileTools');
  await page.evaluate(()=>document.querySelector('#overallRankingScope').remove());
  await page.waitForTimeout(50);
  await page.evaluate(()=>document.querySelector('.overall-center-tools').insertAdjacentHTML('beforeend','<div id="overallRankingScope" class="overall-track-scope">Reopened scope</div>'));
  await page.waitForFunction(()=>document.querySelector('#overallRankingScope').parentElement.id==='overallMobileTools');
  await page.setViewportSize({width:1366,height:600});
  await page.waitForFunction(()=>document.querySelector('#overallRankingScope').parentElement.classList.contains('overall-center-tools'));
  await page.evaluate(()=>dispose());assert.equal(await page.locator('.overall-mobile-drawer').count(),0);
 }finally{await browser.close();}
});
