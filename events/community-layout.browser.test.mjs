import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../tools/verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const css=fs.readFileSync(new URL('./events.css',import.meta.url),'utf8');
const weekly=JSON.parse(fs.readFileSync(new URL('./kodub/current.json',import.meta.url),'utf8')).current;
const cover='data:image/webp;base64,'+fs.readFileSync(new URL('./kodub/'+weekly.coverUrl,import.meta.url)).toString('base64');
test('0.6.3 version navigation and event cards stay within desktop and portrait widths',async()=>{
 const browser=await chromium.launch({headless:true});
 try{const page=await browser.newPage();
 await page.setContent(`<style>body{margin:0}.wrapper{display:grid;grid-template-columns:repeat(2,1fr);width:1150px}.community-track-versions{height:488px}.hidden{display:none}</style><div id="ui"><div class="track-selection-ui"><div class="tracks-container"><div class="wrapper"><section class="sq-featured-events sq-event-track-group"><h2 class="sq-featured-heading">Events</h2><div class="track track-of-the-week sq-kodub-weekly"><button class="button"><small class="sq-kodub-label">Kodub weekly</small><img class="cover" src="${cover}"><div class="track-of-the-week-info"><div class="title">going back in time</div><div class="time-remaining">17h remaining</div></div></button></div><button class="sq-events-entry">Events</button><div class="track sq-permanent-track"><button class="button"><div class="track-title"><p>Rolling Hills Racer</p></div><img class="thumbnail"><div class="record">00:19.993</div><small class="sq-permanent-note">Normal RP active / 1001 Event RP pending target</small></button></div><div class="sq-event-track-buttons"><button class="sq-event-card" data-event-kind="weekly"><div class="sq-event-record">No record</div><span class="sq-event-thumb"><span class="profile-track-image-frame"><img></span></span><span><small>Weekly event</small><strong>Test track</strong><span>Up to 500 Event RP</span><small>Up to 200 racers</small><small>Ends Sunday 13:00 Local</small></span></button><button class="sq-event-card" data-event-kind="daily"><div class="sq-event-record">No record</div><span class="sq-event-thumb"><span class="profile-track-image-frame"><img></span></span><span><small>Daily event</small><strong>Test track</strong><span>Up to 500 Event RP</span><small>Up to 200 racers</small><small>Ends Sunday 13:00 Local</small></span></button></div></section><div class="community-track-versions"><button class="button">0.6.3</button><button class="button">0.6.1</button></div><div class="community-track-group"><div class="track"><button class="button">Rolling Hills Racer</button></div></div></div></div></div></div>`);
 await page.addStyleTag({content:css});
 await page.locator('.sq-kodub-weekly>button>img').evaluate(image=>image.decode());
 for(const [width,height] of [[1366,768],[390,844],[768,1024]]){
  await page.setViewportSize({width,height});
  const featured=await page.locator('.sq-featured-events').boundingBox();
  const nav=await page.locator('.community-track-versions').boundingBox();assert.equal(nav.height,width<=700?160:width>1000?160:136);assert(featured.y+featured.height<=nav.y);assert.equal(Math.round(nav.width),width);assert.equal(Math.round(featured.width),width-(width<=700?32:120));assert.equal(Math.round(featured.x),width<=700?16:60);
  assert(featured.x+featured.width<=width+1,'Section must fit the page');
  const rects=[];for(const card of await page.locator('.sq-kodub-weekly,.sq-permanent-track,.sq-event-card').all())rects.push(await card.boundingBox());
  assert.equal(rects.length,4);for(const rect of rects)assert(rect.x>=featured.x-1&&rect.x+rect.width<=featured.x+featured.width+1,'Every event card stays in the section');
  if(width<=480)assert(rects.every(rect=>Math.abs(rect.width-featured.width)<=1),'Phone cards use the full section width: '+JSON.stringify({width,rects}));
  else assert(rects[0].width>rects[1].width,'Kodub is wider than the supporting cards: '+JSON.stringify({width,rects}));
  for(const rect of rects.slice(2))assert(Math.abs(rect.width-rects[1].width)<=1,'Supporting cards share a coherent native width');
  if(width>1700)for(const rect of rects)assert.equal(Math.round(rect.y),Math.round(rects[0].y));
  else assert(rects.slice(1).every(rect=>rect.y>rects[0].y),'Responsive layouts place supporting cards below Kodub');
  const titleBoxes=[];for(const e of await page.locator('.sq-permanent-track .track-title,.sq-event-card strong').all())titleBoxes.push(await e.boundingBox());
  assert.equal(titleBoxes.length,3);const titleOffset=titleBoxes[0].y-rects[1].y;for(const [index,box] of titleBoxes.entries())assert(Math.abs(box.y-rects[index+1].y-titleOffset)<=1,'Titles align within their cards');
  const rewardBoxes=[];for(const e of await page.locator('.sq-permanent-track .record,.sq-event-card .sq-event-record').all())rewardBoxes.push(await e.boundingBox());
  const thumbBoxes=[];for(const e of await page.locator('.sq-permanent-track .thumbnail,.sq-event-card .sq-event-thumb').all())thumbBoxes.push(await e.boundingBox());
  assert.equal(rewardBoxes.length,3);assert.equal(thumbBoxes.length,3);for(const [index,box] of rewardBoxes.entries()){if(width<=480)assert(box.x>=thumbBoxes[index].x+thumbBoxes[index].width-1,'Phone record sits beside artwork');else assert(box.y>=thumbBoxes[index].y+thumbBoxes[index].height-1,'Record row must not overlap its artwork');assert(box.y+box.height<=rects[index+1].y+rects[index+1].height+1,'Record row stays inside its card');}
  if(width>=1366)for(const rect of rects)assert(rect.x+rect.width<=width+1);
  const artwork=await page.locator('.sq-kodub-weekly>button>img').evaluate(image=>{
   const rect=image.getBoundingClientRect(),style=getComputedStyle(image);
   return {width:rect.width,height:rect.height,left:rect.left,right:rect.right,top:rect.top,bottom:rect.bottom,fit:style.objectFit,position:style.objectPosition,nativeRatio:image.naturalWidth/image.naturalHeight};
  });
  const card=await page.locator('.sq-kodub-weekly>button').boundingBox();
  const info=await page.locator('.sq-kodub-weekly .track-of-the-week-info').boundingBox();
  assert(artwork.width>0&&artwork.height>0,'Artwork has visible width and height');
  assert(Math.abs(artwork.left-card.x)<1,'Artwork is flush with the left edge');
  assert.equal(artwork.fit,'cover');assert.equal(artwork.position,'0% 100%');
  const stacked=info.y>=artwork.bottom-1;
  assert(artwork.top>=card.y-1&&artwork.bottom<=card.y+card.height+1,'Artwork stays inside card');
  if(stacked)assert(Math.abs(artwork.width-card.width)<1,'Stacked artwork uses full width');
  else {assert(Math.abs(artwork.bottom-card.y-card.height)<1,'Artwork fills full left-panel height');assert(Math.abs(artwork.right-info.x)<1,'Details sit flush beside artwork');}
  const tabs=await page.locator('.community-track-versions>.button').all();
  assert.equal((await tabs[0].boundingBox()).width,(await tabs[1].boundingBox()).width);
  if(width>650)assert.equal(await page.locator('.community-track-versions').evaluate(e=>e.scrollWidth),await page.locator('.community-track-versions').evaluate(e=>e.clientWidth));
 }
 const decoration=await page.locator('.sq-kodub-weekly>button').evaluate(e=>({border:getComputedStyle(e).borderTopWidth,shadow:getComputedStyle(e).boxShadow}));
 assert.equal(decoration.border,'0px');assert.equal(decoration.shadow,'none');
 await page.locator('.community-track-group').evaluate(e=>e.classList.add('hidden'));
 assert.equal(await page.locator('.sq-event-card').first().isVisible(),true);
 }finally{await browser.close();}
});
