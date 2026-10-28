import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
let chromium;
try { ({chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright')); } catch {}
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const css=[...source.matchAll(/(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*("(?:\\.|[^"\\])*?")/g)]
  .map(match=>JSON.parse(match[1])).join('\n')+'\n'+fs.readFileSync(new URL('../home-ui.css',import.meta.url),'utf8');
test('Ranked controls remain reachable in short CSS viewports equivalent to high browser zoom',{skip:!chromium},async()=>{
  const browser=await chromium.launch({headless:true,
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  try {
    const page=await browser.newPage();
    await page.setContent(`<style>body{margin:0}#overallLeaderboardPanel{display:flex!important}.overall-shell{animation:none!important}</style>
      <div id="overallLeaderboardPanel"><section class="overall-shell"><header class="overall-top"><h2>Ranked</h2>
      <div class="overall-actions"><button class="overall-action-btn">Help</button><button class="overall-action-btn close">Close</button></div></header>
      <p class="overall-sub">Community rankings and your personal bests</p><div class="overall-columns">Rank Racer Best Score</div>
      <div id="overallLeaderboardList">${Array.from({length:10},(_,i)=>`<button class="overall-entry">${i+1} Racer</button>`).join('')}</div>
      <footer class="overall-pager"><button>Previous</button><span>1 / 1</span><button class="next">Next</button></footer></section></div>`);
    await page.addStyleTag({content:css});
    for(const [width,height] of [[384,216],[560,312],[320,300]]){
      await page.setViewportSize({width,height});
      const shell=await page.locator('.overall-shell').boundingBox();
      assert.ok(shell.x>=0&&shell.y>=0&&shell.x+shell.width<=width+1&&shell.y+shell.height<=height+1,JSON.stringify(shell));
      for(const selector of ['.close','.next']){
        await page.locator(selector).scrollIntoViewIfNeeded();
        const button=await page.locator(selector).boundingBox();
        assert.ok(button.y>=0&&button.y+button.height<=height+1,`${selector} is reachable at ${width}x${height}`);
      }
    }
  } finally {await browser.close();}
});
