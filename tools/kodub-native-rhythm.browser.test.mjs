import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const source=process.env.SOURCE_ROOT||process.cwd();
const css=await fs.readFile(process.env.CARD_CSS||path.join(source,'events/events.css'),'utf8');
const bundle=await fs.readFile(path.join(source,'main.bundle.js'),'utf8');
const position=bundle.indexOf('.track.track-of-the-week');
const cssStart=bundle.lastIndexOf("push([e.id,'",position)+11;
const cssEnd=bundle.indexOf("',",position);
const native=Function('return '+bundle.slice(cssStart,cssEnd+1))();
const font=(await fs.readFile(path.join(source,'forced_square.woff2'))).toString('base64');
const weekly=JSON.parse(await fs.readFile(path.join(source,'events/kodub/current.json'))).current;
const data=async(file,type)=>'data:'+type+';base64,'+(await fs.readFile(path.join(source,file))).toString('base64');
const art=await data('events/kodub/'+weekly.coverUrl,'image/webp');
const icon=await data('images/timer.svg','image/svg+xml');
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
// Exact native child structure from shipped main.bundle.js: timer text, PB img + span.
const card=custom=>`<div class="track track-of-the-week ${custom?'sq-kodub-weekly':''}"><button class="button"><img class="cover" src="${art}"><div class="track-of-the-week-info"><div class="title">${escape(weekly.name)}</div><div class="author">By ${escape(weekly.author)}</div><div class="time-remaining">6d 23h 59m 59s</div><div class="date-range">Nov 15 - Nov 22 12:00 PM</div><div class="personal-best"><div><img src="${icon}"><span>00:24.531</span>${custom?'<span class="sq-record-placement">12/255</span>':''}</div></div>${custom?'<small class="sq-kodub-reward">Up to 700 Event RP</small>':''}</div></button></div>`;
const support=kind=>`<button class="sq-event-card" data-event-kind="${kind}"><span class="sq-event-thumb"><span class="profile-track-image-frame"><img src="${art}"></span></span><span class="sq-event-record"><time>00:24.531</time><span class="sq-record-placement">#12</span></span><span><small>${kind.toUpperCase()} EVENT</small><strong>Winter 5</strong><span class="sq-event-card-details"><small>Up to 10,000 Event RP</small><small>Resets Sunday</small></span></span></button>`;
const rhr=`<div class="track sq-permanent-track"><button class="button"><img class="thumbnail" src="${art}"><div class="track-title"><p>Rolling Hills Racer</p></div><div class="record">00:24.531</div><small class="sq-permanent-note">Normal RP + up to 10,101 Event RP\nPermanent event · no reset</small></button></div>`;
test('native weekly rhythm uses shipped font, cover, countdown and PB structure at real viewports',async()=>{
 const browser=await chromium.launch({headless:true});const measurements=[];
 try{const page=await browser.newPage();await page.route('**/*',r=>r.abort());
 for(const [width,height] of [[1920,1080],[1366,768],[390,844]]){
 await page.setViewportSize({width,height});
 for(const custom of [false,true]){
 const markup=custom?`<section class="sq-featured-events"><h2 class="sq-featured-heading">Events</h2>${card(true)}${rhr}<div class="sq-event-track-buttons">${support('daily')}${support('weekly')}</div></section>`:card(false);
 await page.setContent(`<style>@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,${font})}body{margin:0;background:#111d40;color:white;font-family:ForcedSquare}.button,button{font:inherit;background:#28346a;color:white;border:0}.wrapper{width:100%;display:block}${native}${custom?css:''}</style><div id="ui"><main class="track-selection-ui"><div class="tracks-container open"><div class="wrapper">${markup}</div></div></div></main></div>`);
 await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(i=>i.decode()));});
 const m=await page.locator('.track-of-the-week-info').evaluate(info=>{const b=n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom,right:r.right};};return {font:getComputedStyle(info).fontFamily,info:b(info),children:[...info.children].map(n=>({text:n.textContent,box:b(n),font:parseFloat(getComputedStyle(n).fontSize),display:getComputedStyle(n).display,scroll:n.scrollWidth>n.clientWidth+1})),card:b(info.closest('.track')),image:b(info.previousElementSibling),fit:getComputedStyle(info.previousElementSibling).objectFit,pbFont:parseFloat(getComputedStyle(info.querySelector('.personal-best>div')).fontSize)};});
 assert.match(m.font,/ForcedSquare/);assert.equal(m.pbFont,26);
 if(custom){const record=page.locator('.sq-kodub-weekly .personal-best>div');const spacing=await record.evaluate(row=>{const time=row.querySelector('span'),place=row.querySelector('.sq-record-placement');return {gap:place.getBoundingClientRect().left-time.getBoundingClientRect().right,align:getComputedStyle(row).justifyContent,info:getComputedStyle(row.closest('.track-of-the-week-info')).textAlign};});assert.ok(spacing.gap>=11.9,'clear time-to-placement gap');assert.equal(spacing.align,'flex-start');assert.equal(spacing.info,'left');assert.equal(m.children[0].font,48);assert.equal(m.fit,'contain');const timer=m.children.find(n=>n.text==='6d 23h 59m 59s');assert.equal(timer.font,28);assert.equal(timer.display,'block');assert.ok(!timer.scroll,'full countdown fits');
 for(const n of m.children){assert.ok(n.box.y>=m.info.y-1&&n.box.bottom<=m.info.bottom+1,'metadata within card: '+n.text);assert.ok(!n.scroll,'unclipped '+n.text);}
 if(width>1700){const boxes=await page.locator('.sq-kodub-weekly,.sq-permanent-track,[data-event-kind="daily"],[data-event-kind="weekly"]').evaluateAll(nodes=>nodes.map(n=>({kind:n.dataset.eventKind||n.className,x:n.getBoundingClientRect().x,h:n.getBoundingClientRect().height})));assert.ok(boxes.every(b=>Math.abs(b.h-boxes[0].h)<1),'shared card height');assert.ok(boxes.every((b,i)=>!i||b.x>boxes[i-1].x),'K/RHR/Daily/Weekly order');}
 }
 measurements.push({width,height,custom,...m});
 if(process.env.AUDIT_OUTPUT){await fs.mkdir(process.env.AUDIT_OUTPUT,{recursive:true});await page.screenshot({path:path.join(process.env.AUDIT_OUTPUT,`${custom?'custom-after':'native-before'}-${width}.png`),fullPage:true});}
 }
 }
 if(process.env.AUDIT_OUTPUT)await fs.writeFile(path.join(process.env.AUDIT_OUTPUT,'measurements.json'),JSON.stringify(measurements,null,2));
 }finally{await browser.close();}
});
test('Rolling Hills changes only display line separation and keeps reward policy contract',async()=>{
 const client=await fs.readFile(process.env.CARD_CLIENT||path.join(source,'events/client.mjs'),'utf8');
 assert.ok(client.includes("reward.text+'\\nPermanent event · no reset'"));
 assert.ok(client.includes("text:'Normal RP + up to '+policy.maxRp.toLocaleString('en-US')+' Event RP'"));
 assert.ok(css.includes('white-space:pre-line!important'));
});
