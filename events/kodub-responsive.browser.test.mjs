import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(new URL('../tools/verifier/package.json',import.meta.url));
const {chromium,firefox}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const css=fs.readFileSync(new URL('./events.css',import.meta.url),'utf8');
const current=JSON.parse(fs.readFileSync(new URL('./kodub/current.json',import.meta.url),'utf8')).current;
const cover='data:image/webp;base64,'+fs.readFileSync(new URL('./kodub/'+current.coverUrl,import.meta.url)).toString('base64');
const font=fs.readFileSync(new URL('../forced_square.woff2',import.meta.url)).toString('base64');
const icon=name=>'data:image/svg+xml;base64,'+fs.readFileSync(new URL('../images/'+name+'.svg',import.meta.url)).toString('base64');

test('Kodub preserves phone artwork and shares compact landscape rows across rotation',async()=>{
 const browser=await (process.env.POLYTRACK_TEST_BROWSER==='firefox'?firefox:chromium).launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('**/*',route=>route.abort());
  const card=kind=>`<button class="sq-event-card" data-event-kind="${kind}"><div class="sq-event-record"><time>00:20.759</time><span class="sq-event-place">4/200</span></div><span class="sq-event-thumb"><span class="profile-track-image-frame"><img alt=""></span></span><span><small>${kind} event</small><strong>A longer event track name</strong><span class="sq-event-card-details"><small class="sq-event-reward">Up to 500 Event RP</small><small class="sq-event-reset">Ends Sunday 13:00 Local</small></span></span></button>`;
  await page.setContent(`<style>@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,${font})}*{font-family:ForcedSquare,Arial,sans-serif;font-style:italic;line-height:1}body{margin:0;background:#17234f;color:white}.wrapper{display:grid;width:100%}</style><div id="ui"><div class="track-selection-ui"><div class="tracks-container"><div class="wrapper"><section class="sq-featured-events sq-event-track-group"><h2 class="sq-featured-heading">Events</h2><div class="track track-of-the-week sq-kodub-weekly"><button class="button"><img class="cover" src="${cover}" alt="Weekly artwork"><div class="track-of-the-week-info"><div class="title">A Longer Weekly Event Track Name</div><div class="author">By Track Author</div><div class="time-remaining">17h remaining</div><div class="date-range">Oct 1 - Oct 8</div><div class="personal-best"><div><img src="${icon('timer')}"><span>00:20.759</span></div><div><img src="${icon('trophy')}">4th <span class="faded">(2%)</span></div></div><small class="sq-kodub-reward">Up to 700 Event RP</small></div></button></div><div class="track sq-permanent-track"><button class="button"><div class="track-title"><p>Rolling Hills Racer</p></div><img class="thumbnail" alt=""><div class="record">00:19.993</div><small class="sq-permanent-note">Normal RP + up to 1001 Event RP / No reset</small></button></div><div class="sq-event-track-buttons">${card('weekly')}${card('daily')}</div></section><div class="community-track-versions"></div></div></div></div></div>`);
  await page.addStyleTag({content:`@media(max-width:700px) and (orientation:portrait),(min-width:600px) and (max-width:1200px) and (max-height:500px) and (orientation:landscape){#ui .track-selection-ui .sq-featured-events .track.sq-kodub-weekly>.button>img.cover{transform:translateX(-50%);margin-left:-80px;min-width:500px;max-width:none}}`+css});
  await page.locator('.cover').evaluate(async image=>{await image.decode();await document.fonts.ready;});
  for(const [width,height]of [[320,568],[360,780],[390,844],[600,800],[601,800],[440,956],[956,440],[956,360],[390,844],[844,390],[667,300],[768,1024],[700,700],[1366,768],[1920,1080],[440,956]]){
   await page.setViewportSize({width,height});
   const metrics=await page.evaluate(()=>{
    const box=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    const rail=document.querySelector('.sq-featured-events'),image=rail.querySelector('.cover'),info=rail.querySelector('.track-of-the-week-info');
    const cards=[...rail.querySelectorAll('.sq-kodub-weekly,.sq-permanent-track,.sq-event-card')].map(box);
    const imageBox=box(image),factor=Math.min(imageBox.width/image.naturalWidth,imageBox.height/image.naturalHeight);
    const painted={x:imageBox.x,y:imageBox.bottom-image.naturalHeight*factor,width:image.naturalWidth*factor,height:image.naturalHeight*factor,right:imageBox.x+image.naturalWidth*factor,bottom:imageBox.bottom};
    return {rail:box(rail),cards,image:imageBox,painted,imagePosition:getComputedStyle(image).objectPosition,imageFit:getComputedStyle(image).objectFit,nativeRatio:image.naturalWidth/image.naturalHeight,
     imageTransform:getComputedStyle(image).transform,imageMargin:getComputedStyle(image).marginLeft,
     info:box(info),details:[...info.children].map(node=>({...box(node),name:node.className,overflow:node.scrollWidth>node.clientWidth+1})),
     text:[...rail.querySelectorAll('.track-title p,.record,.sq-event-record,strong,.sq-permanent-note,.sq-event-card-details>small')].map(node=>({...box(node),text:node.textContent,card:box(node.closest('.button,.sq-event-card')),overflow:node.scrollWidth>node.clientWidth+1||node.scrollHeight>node.clientHeight+1})),
     label:getComputedStyle(rail.querySelector('.sq-permanent-track>.button'),'::before').content,
     badges:[...rail.querySelectorAll('.sq-event-place')].map(node=>node.textContent)};
   });
   const message=JSON.stringify({width,height,metrics});
   assert.equal(metrics.cards.length,4);
   for(const card of metrics.cards)assert(card.x>=-1&&card.right<=width+1&&card.y>=metrics.rail.y-1&&card.bottom<=metrics.rail.bottom+1,message);
   for(let i=0;i<4;i++)for(let j=i+1;j<4;j++){
    const a=metrics.cards[i],b=metrics.cards[j];
    assert(a.right<=b.x+1||b.right<=a.x+1||a.bottom<=b.y+1||b.bottom<=a.y+1,message);
   }
   for(const detail of metrics.details)assert(!detail.overflow&&detail.x>=metrics.cards[0].x-1&&detail.right<=metrics.cards[0].right+1&&detail.y>=metrics.cards[0].y-1&&detail.bottom<=metrics.cards[0].bottom+1,message);
   for(const text of metrics.text)assert(!text.overflow&&text.x>=text.card.x-1&&text.right<=text.card.right+1&&text.y>=text.card.y-1&&text.bottom<=text.card.bottom+1,message);
   if(width>=360&&width<=480&&height>width){
    assert(metrics.cards[1].bottom<=metrics.cards[2].y+1,'portrait cards remain in vertical order: '+message);
    assert(metrics.cards.every(card=>card.width>=44&&card.height>=44),message);
   }
   const compact=width>=600&&width<=1200&&height<=500&&width>height;
   if(width<=700&&height>=width||compact){
    assert.equal(metrics.imageFit,'contain',message);
    assert.equal(metrics.imagePosition,'0% 100%',message);
    assert(metrics.nativeRatio>0&&metrics.painted.width>0&&metrics.painted.height>0,message);
    assert(Math.abs(metrics.painted.width/metrics.painted.height-metrics.nativeRatio)<.01,message);
    for(const bounds of [metrics.image,metrics.painted]){
     assert(bounds.x>=metrics.cards[0].x-1&&bounds.right<=metrics.cards[0].right+1&&bounds.y>=metrics.cards[0].y-1&&bounds.bottom<=metrics.cards[0].bottom+1,message);
     assert(width<=700&&height>=width?bounds.bottom<=metrics.info.y+1:bounds.right<=metrics.info.x+1,message);
    }
    assert.equal(metrics.imageTransform,'none',message);assert.equal(metrics.imageMargin,'0px',message);
    assert(metrics.image.x>=metrics.cards[0].x-1&&metrics.image.right<=metrics.cards[0].right+1,message);
    assert(width<=700&&height>=width?metrics.image.bottom<=metrics.info.y+1:metrics.image.right<=metrics.info.x+1,message);
   }
   if(compact&&width>=840){
    assert(metrics.cards.every(card=>Math.abs(card.y-metrics.cards[0].y)<1),message);
    assert(Math.max(...metrics.cards.map(card=>card.height))<=300,message);
    assert(metrics.cards[0].width>metrics.cards[1].width,message);
   }
   assert.match(metrics.label,/PERMANENT EVENT/);assert.deepEqual(metrics.badges,['4/200','4/200']);
   if(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR){
    fs.mkdirSync(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR,{recursive:true});
    await page.screenshot({path:path.join(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR,`kodub-${width}x${height}.png`),fullPage:true});
   }
  }
 }finally{await browser.close();}
});
