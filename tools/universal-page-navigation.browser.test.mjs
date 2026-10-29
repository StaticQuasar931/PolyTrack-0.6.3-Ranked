import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(new URL('./verifier/package.json',import.meta.url)),{chromium}=require('playwright');
const patch=await readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const event=await readFile(new URL('../events/client.mjs',import.meta.url),'utf8');
const from=patch.indexOf('  let nativeTopSelectToken=0,'),to=patch.indexOf('  let officialTrackPrefix=',from);
const eventFrom=event.indexOf("  document.addEventListener('keydown',event=>{\n    if(event.defaultPrevented||event.repeat||event.ctrlKey||event.altKey||event.metaKey||!nativeView?.board?"),eventTo=event.indexOf("  document.addEventListener('keyup',event=>{",eventFrom);
assert.ok(from>0&&to>from&&eventFrom>0&&eventTo>eventFrom);
test('real keyboard chords navigate Overall, normal tracks, event boards and archives consistently',{timeout:30000},async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();await page.route('**/*',route=>route.abort());
    await page.setContent('<section id="overallLeaderboardPanel"><input id="overallInput"></section><section id="normal" class="track-info-ui"><div class="leaderboard-ui"><div class="container"></div><div class="pages"></div></div><input></section><section id="event" class="track-info-ui"><div class="leaderboard-ui sq-event-board"><div class="container"></div><div class="pages"></div></div><input></section><section id="archive" class="sq-events-dialog"><nav class="sq-archive-pagination"><button>Back</button><span class="sq-archive-page-count"></span><button>Next</button></nav><input></section>');
    await page.evaluate(({code,eventCode})=>{
      const views=['overallLeaderboardPanel','normal','event','archive'].map(id=>document.getElementById(id));
      const numbers=new Map(views.map(view=>[view,5]));let active=views[0];
      const draw=(view,page)=>{
        const value=Math.max(1,Math.min(20,page));numbers.set(view,value);
        const pages=view.querySelector('.pages');if(pages)for(const button of pages.children)button.classList.toggle('selected',Number(button.textContent)===value);
        const count=view.querySelector('.sq-archive-page-count');if(count)count.textContent=`Page ${value} of 20`;
      };
      for(const view of views){
        const pages=view.querySelector('.pages');if(pages)for(let i=1;i<=20;i++){const button=document.createElement('button');button.className='page';button.textContent=String(i);button.onclick=()=>draw(view,i);pages.append(button);}
        const nav=view.querySelector('.sq-archive-pagination');if(nav){nav.addEventListener('sq:page',event=>draw(view,event.detail.page));nav.firstElementChild.onclick=()=>draw(view,numbers.get(view)-1);nav.lastElementChild.onclick=()=>draw(view,numbers.get(view)+1);}
        draw(view,5);view.hidden=view!==active;
      }
      const visible=node=>!!node?.isConnected&&node.getClientRects().length>0;
      const api=new Function('isElementVisible','code',`
        let overallPage=4;const OVERALL_PAGE_SIZE=15,currentLeaderboardCount=()=>300;
        const invalidateNativePartialReplay=()=>{},changeOverallPage=direction=>{overallPage=Math.max(0,Math.min(19,overallPage+direction));},jumpOverallPage=page=>{overallPage=page-1;};
        ${code}
        return {overall:handleOverallLeaderboardShortcut,normal:handleTrackLeaderboardShortcut,archive:handleArchivePageShortcut,release:handleOverallLeaderboardModifierRelease,
          navigation:readPageNavigation,reset:resetOverallPageOffset,setOverall:page=>{overallPage=page-1;},getOverall:()=>overallPage+1};
      `)(visible,code);
      const eventBoard=document.querySelector('#event .leaderboard-ui');
      new Function('bridge','nativeView',`
        let dialog=null,eventDigitBoard=null,eventTopPrefixUntil=0,eventTopHeld=false,topSelectionToken=0;
        const eventDigitsHeld=new Map(),eventDigitsConsumed=new Set();
        ${eventCode}
      `)({pageNavigation:api.navigation},{board:eventBoard,root:document.getElementById('event')});
      window.addEventListener('keydown',event=>{
        if(active===views[0])api.overall(event);else if(active===views[1])api.normal(event);else if(active===views[3])api.archive(event);
      });
      window.addEventListener('keyup',api.release);
      window.fixture={set(index){active=views[index];for(const view of views)view.hidden=view!==active;draw(active,5);api.setOverall(5);api.reset();document.activeElement.blur();},page(){return active===views[0]?api.getOverall():numbers.get(active);}};
    },{code:patch.slice(from,to),eventCode:event.slice(eventFrom,eventTo)});
    for(let index=0;index<4;index++){
      await page.evaluate(index=>fixture.set(index),index);
      await page.keyboard.down('Shift');await page.keyboard.press('Equal');await page.keyboard.press('Digit3');
      await page.waitForFunction(()=>fixture.page()===8);
      await page.keyboard.press('Minus');await page.keyboard.press('Digit2');await page.waitForFunction(()=>fixture.page()===6);
      await page.keyboard.up('Shift');await page.keyboard.press('Shift+Digit0');await page.waitForFunction(()=>fixture.page()===10);
      await page.keyboard.press('a');await page.waitForFunction(()=>fixture.page()===9);
      await page.keyboard.press('d');await page.waitForFunction(()=>fixture.page()===10);
      await page.locator('section:visible input').focus();await page.keyboard.press('Shift+Digit2');
      assert.equal(await page.evaluate(()=>fixture.page()),10,'typing does not change page in scope '+index);
    }
  }finally{await browser.close();}
});
