import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {fitKodubCover} from './kodub-weekly.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=new URL('../',import.meta.url);
const font=(await fs.readFile(new URL('forced_square.woff2',root))).toString('base64');
const css=await fs.readFile(new URL('events/events.css',root),'utf8');
const bundle=await fs.readFile(new URL('main.bundle.js',root),'utf8');
const position=bundle.indexOf('.track.track-of-the-week');
const cssStart=bundle.lastIndexOf("push([e.id,'",position)+11;
const cssEnd=bundle.indexOf("',",position);
const native=Function('return '+bundle.slice(cssStart,cssEnd+1))();
assert.ok(native,'native CSS extracted from shipped bundle');
const svg=(w,h)=>'data:image/svg+xml;base64,'+Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="#284b65"/><rect x="2" y="2" width="${w-4}" height="${h-4}" stroke="gold" fill="none"/></svg>`).toString('base64');
const weekly=`<div class="track track-of-the-week"><button class="button"><img class="cover" src="${svg(900,240)}"><div class="track-of-the-week-info"><div class="title">A Longer Weekly Event Track Name</div><div class="author">By Track Author</div><div class="time-remaining">17h remaining</div><div class="date-range">Nov 15 - Nov 22</div><div class="personal-best"><div><img src="${svg(16,16)}">00:20.759</div><div><img src="${svg(16,16)}">4th (2%)</div></div><small class="sq-kodub-reward">Up to 700 Event RP</small></div></button></div>`;
const sibling=kind=>`<button class="sq-event-card" data-event-kind="${kind}"><span class="sq-event-thumb"><span class="profile-track-image-frame"><img src="${svg(256,256)}"></span></span><span class="sq-event-record"><time>00:20.759</time><span class="sq-record-placement is-cached">4/300</span></span><span><small>${kind} event</small><strong>Winter 5</strong><span class="sq-event-card-details"><small class="sq-event-reward">Up to 500 Event RP</small><small class="sq-event-reset">Resets Sunday</small></span></span></button>`;
test('Kodub matches shipped sibling heights across aspect changes and preserves unpromoted native height',async()=>{
 const browser=await chromium.launch({headless:true});const results=[];
 const output=process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR;
 try{
  const page=await browser.newPage();let requests=0;await page.route('**/*',route=>{requests++;return route.abort();});
  await page.setContent(`<style>@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,${font})}body{font-family:ForcedSquare,sans-serif;margin:0;background:#17234f;color:white}button{font:inherit}.wrapper{display:grid;width:100%}#native{position:absolute;left:-10000px;top:0;width:100%}</style><style>${native}</style><div id="ui"><main class="track-selection-ui"><section id="native">${weekly.replace(/<small class="sq-kodub-reward">.*?<\/small>/,'')}</section><div class="tracks-container open"><div class="wrapper"><section class="sq-featured-events"><h2 class="sq-featured-heading">Events</h2>${weekly.replace('track-of-the-week"','track-of-the-week sq-kodub-weekly"')}<div class="sq-event-track-buttons">${sibling('daily')}${sibling('weekly')}</div></section></div></div></main></div>`);
  await page.locator('#native img.cover').evaluate(async image=>{await image.decode();await document.fonts.ready;});
  const nativeHeight=await page.locator('#native .button').evaluate(node=>node.getBoundingClientRect().height);
  await page.addStyleTag({content:css});
  await page.evaluate(async source=>{const mod=await import('data:text/javascript;base64,'+btoa(source));window.fit=mod.fitKodubCover;},'const coverBindings=new WeakMap();const heightBindings=new WeakMap();export '+fitKodubCover.toString());
  for(const [width,height]of [[2543,415],[1920,1080],[1366,768],[768,1024],[390,844],[320,568],[844,390]]){
   await page.setViewportSize({width,height});
   const reference=await page.locator('[data-event-kind="daily"]').evaluate(node=>node.getBoundingClientRect().height);
   assert.ok(reference>=44,`visible sibling at ${width}x${height}: ${reference}`);
   for(const [w,h]of [[900,240],[512,256],[240,900],[256,256]]){
    await page.locator('.sq-kodub-weekly .cover').evaluate(async(node,src)=>{node.src=src;await node.decode();},svg(w,h));
    await page.evaluate(()=>window.fit(document.querySelector('.sq-kodub-weekly')));
    await page.waitForTimeout(60);
    const metrics=await page.evaluate(()=>{
     const card=document.querySelector('.sq-kodub-weekly'),button=card.querySelector('button'),image=button.querySelector('img'),info=button.querySelector('.track-of-the-week-info');
     const box=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
     return {card:box(card),button:box(button),image:box(image),info:box(info),fit:getComputedStyle(image).objectFit,position:getComputedStyle(image).objectPosition,details:[...info.children].map(node=>({...box(node),text:node.textContent,overflow:node.scrollWidth>node.clientWidth+1||node.scrollHeight>node.clientHeight+1}))};
    });
    assert.ok(metrics.image.width>0&&metrics.image.height>0,'visible artwork');
    assert.equal(metrics.position,'50% 50%','letterboxed artwork is centered, never pinned to the bottom');
    const available=Math.max(0,metrics.button.width-Math.min(300,metrics.button.width*.7));
    const expectedWidth=Math.min(metrics.button.height*w/h,available);
    assert.ok(Math.abs(metrics.image.width-expectedWidth)<2,'image width follows artwork ratio, not a fixed45% cap');
    if(w/h===2&&available>=metrics.button.height*2)assert.ok(Math.abs(metrics.image.width/2-metrics.button.height)<2,'normal weekly artwork fills the card height when there is enough horizontal room');
    const pb=await page.locator('[data-event-kind="weekly"] .sq-event-record').evaluate(node=>{const [time,place]=node.children;const a=time.getBoundingClientRect(),b=place.getBoundingClientRect();return {sameRow:Math.abs(a.y-b.y)<2,inside:node.scrollWidth<=node.clientWidth+1};});
    assert.ok(pb.sameRow&&pb.inside,'weekly PB time and placement share one unclipped row');
    assert.ok(metrics.info.width>=Math.min(300,metrics.button.width*.7)-1,'readable reserved metadata width');
    const nativePb=await page.locator('.sq-kodub-weekly .personal-best').evaluate(node=>{const a=node.children[0].getBoundingClientRect(),b=node.children[1].getBoundingClientRect();return {sameY:Math.abs(a.y-b.y)<1,inside:node.scrollWidth<=node.clientWidth+1,nonoverlap:a.right<=b.x+1};});
    assert.ok(nativePb.sameY&&nativePb.inside&&nativePb.nonoverlap,'native PB '+JSON.stringify({width,height,w,h,nativePb,metrics}));
    const weeklyHeight=await page.locator('[data-event-kind="weekly"]').evaluate(node=>node.getBoundingClientRect().height);
    assert.ok(Math.abs(weeklyHeight-reference)<1,'daily and weekly references agree');
    const label=JSON.stringify({width,height,w,h,reference,metrics});
    assert.ok(Math.abs(metrics.card.height-reference)<1,label);assert.ok(Math.abs(metrics.button.height-reference)<1,label);
    assert.equal(metrics.fit,'contain',label);assert.ok(metrics.image.right<=metrics.info.x+1,label);
    for(const node of metrics.details)assert.ok(!node.overflow&&node.y>=metrics.button.y-1&&node.bottom<=metrics.button.bottom+1&&node.right<=metrics.button.right+1,label);
    assert.equal(await page.locator('[data-event-kind="daily"]').evaluate(node=>node.getBoundingClientRect().height),reference,'sibling remains unchanged');
    results.push({width,height,w,h,reference,metrics});
    if(output&&width===2543&&w/h===2)await page.locator('.sq-featured-events').screenshot({path:output+'/wide-weekly-card.png'});
   }
   if(output){await fs.mkdir(output,{recursive:true});await page.screenshot({path:output+`/height-${width}x${height}.png`,fullPage:true});}
  }
  await page.setViewportSize({width:1280,height:720});
  assert.equal(await page.locator('#native .button').evaluate(node=>node.getBoundingClientRect().height),nativeHeight,'unpromoted native height remains shipped height');
  assert.equal(requests,0,'fixture makes no network requests');
  if(output)await fs.writeFile(output+'/height-measurements.json',JSON.stringify(results,null,2));
 }finally{await browser.close();}
});
