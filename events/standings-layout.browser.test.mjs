import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';

const require=createRequire(new URL('../tools/verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const css=fs.readFileSync(new URL('./events.css',import.meta.url),'utf8');

test('event results and featured cards fit native desktop and narrow-phone viewports',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent(`<style>body{margin:0}.track-selection-ui{width:100%}.tracks-container>.wrapper{width:100%}</style>
   <div id="ui"><div class="track-selection-ui"><div class="tracks-container"><div class="wrapper">
    <section class="sq-featured-events sq-event-track-group"><h2 class="sq-featured-heading">Events</h2>
     <div class="track sq-kodub-weekly"><button class="button"><img><div class="track-of-the-week-info"><div class="title">A Long Weekly Event Track Name</div><div class="author">Track Author</div><div class="time-remaining">17 hours remaining</div><div class="date-range">Oct 1 - Oct 8</div><div class="personal-best">1:24.999 #12</div><small class="sq-kodub-reward">700 Event RP available</small></div></button></div>
     <div class="track sq-permanent-track"><button class="button"><div class="track-title"><p>Rolling Hills Racer</p></div><img class="thumbnail"><div class="record">1:24.999</div><small class="sq-permanent-note">Permanent event</small></button></div>
     <div class="sq-event-track-buttons"><button class="sq-event-card" data-event-kind="weekly"><div class="sq-event-record">No record</div><span class="sq-event-thumb"><img></span><span><small>Weekly event</small><strong>A weekly event track</strong><span>Up to 500 Event RP</span><small>Ends Sunday</small></span></button><button class="sq-event-card" data-event-kind="daily"><div class="sq-event-record">No record</div><span class="sq-event-thumb"><img></span><span><small>Daily event</small><strong>A daily event track</strong><span>Up to 500 Event RP</span><small>Ends tonight</small></span></button></div>
    </section><div class="community-track-versions"><button>0.6.3</button><button>0.6.1</button></div>
   </div></div></div></div>
   <div class="sq-events-overlay"><section class="sq-events-dialog" role="dialog"><header><h2>Events</h2><button class="button">Close</button></header><nav><button aria-pressed="true">Live events</button><button aria-pressed="false">Event RP</button><button aria-pressed="false">Past events</button></nav><p class="sq-event-status">Published standings</p><main><ol class="sq-event-results sq-event-verified-results"><li><img class="sq-event-result-verified" src="images/state_verified.svg" alt="Verified"><b>#1</b><span>A racer name that may be long <strong class="sq-event-you">YOU</strong></span><time>1:24.999</time><strong>700 RP</strong></li></ol></main></section></div>`);
  await page.addStyleTag({content:css});
  for(const [width,height] of [[1366,768],[768,1024],[390,844],[380,844],[320,700]]){
   await page.setViewportSize({width,height});
   const dialog=await page.locator('.sq-events-dialog').boundingBox();
   assert(dialog.x>=-1&&dialog.x+dialog.width<=width+1,`results panel stays within ${width}px viewport`);
   assert(dialog.y>=-1&&dialog.y+dialog.height<=height+1,`results panel stays within ${height}px viewport`);
   const result=await page.locator('.sq-event-results li').evaluate(node=>({left:node.getBoundingClientRect().left,right:node.getBoundingClientRect().right,scroll:node.scrollWidth,client:node.clientWidth}));
   assert(result.left>=dialog.x-1&&result.right<=dialog.x+dialog.width+1,'results row remains inside its native panel');
   assert(result.scroll<=result.client+1,'result names and scores do not create horizontal overflow');
   const rail=await page.locator('.sq-featured-events').boundingBox();
   for(const selector of ['.sq-kodub-weekly','.sq-permanent-track','.sq-event-card'])for(const card of await page.locator(selector).all()){
    const box=await card.boundingBox();assert(box.x>=rail.x-1&&box.x+box.width<=rail.x+rail.width+1,`${selector} fits in the ${width}px event rail`);
   }
   const kodub=await page.locator('.sq-kodub-weekly .track-of-the-week-info').boundingBox();
   const button=await page.locator('.sq-kodub-weekly>.button').boundingBox();
   assert(kodub.x>=button.x-1&&kodub.x+kodub.width<=button.x+button.width+1,`Kodub details stay inside the weekly card at ${width}px: ${JSON.stringify({button,kodub})}`);
  }
 }finally{await browser.close();}
});
