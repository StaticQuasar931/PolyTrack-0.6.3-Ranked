import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';

const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=new URL('../',import.meta.url);
const styles=await Promise.all(['events/events.css','home-ui.css','responsive-ui.css','practice-responsive.css'].map(file=>fs.readFile(new URL(file,root),'utf8')));
const weekly=JSON.parse(await fs.readFile(new URL('events/kodub/current.json',root),'utf8')).current;
const cover='data:image/webp;base64,'+(await fs.readFile(new URL('events/kodub/'+weekly.coverUrl,root))).toString('base64');
const artworkSelector='#ui .track-selection-ui .sq-featured-events .track.sq-kodub-weekly>.button>img:not(.environment)';
const oldEvents=styles[0].split('/* Featured artwork uses a near-native ratio')[0]+
 `@media(max-width:480px){${artworkSelector}{height:clamp(112px,36vw,160px)!important;min-height:0!important;max-height:160px!important;align-self:center}}
 @media(min-width:481px) and (orientation:landscape) and (max-height:460px){${artworkSelector}{height:min(var(--event-card-height,300px),60dvh)!important;min-height:0!important;max-height:100%!important;align-self:center}}`;

const svg=(width,height)=>'data:image/svg+xml;base64,'+Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#284b65"/><rect x="3" y="3" width="${width-6}" height="${height-6}" fill="none" stroke="#ffdf85" stroke-width="6"/><text x="50%" y="50%" text-anchor="middle" fill="white" font-size="28">Complete artwork</text></svg>`).toString('base64');
const asset=async(file,mime)=>'data:'+mime+';base64,'+(await fs.readFile(new URL(file,root))).toString('base64');
const icon=await asset('images/timer.svg','image/svg+xml');
const preview=await asset('tracks/community/thumbnails/rolling_hills_racer.png','image/png');
const support=kind=>`<button class="sq-event-card" data-event-kind="${kind}"><span class="sq-event-thumb"><span class="profile-track-image-frame"><img src="${preview}" alt="${kind} preview"></span></span><span class="sq-event-record">00:24.531</span><span><small>${kind.toUpperCase()} EVENT</small><strong>Winter 5</strong><span class="sq-event-card-details"><small class="sq-event-reward">Up to 500 Event RP</small><small class="sq-event-reset">Resets Sun 17:00</small></span></span></button>`;
// Native weekly structure: direct cover (or thumbnail fallback), then the information panel.
const markup=`<div id="ui"><main class="track-selection-ui"><div class="tracks-container open"><div class="wrapper"><div class="community-track-versions"><button class="button">Featured Events</button></div><section class="sq-featured-events"><div class="track track-of-the-week sq-kodub-weekly"><button class="button"><img class="cover" src="${cover}" alt="Kodub weekly artwork"><div class="track-of-the-week-info"><div class="title">Hydropower</div><div class="author">By Bobson Dugnutt</div><div class="time-remaining">5d 12h 30m</div><div class="date-range">Oct 25 - Nov 1</div><div class="personal-best"><div><img src="${icon}" alt="Timer">00:24.531</div></div><small class="sq-kodub-reward">Up to 700 Event RP</small></div></button></div><div class="track sq-permanent-track"><button class="button"><img class="thumbnail" src="${preview}" alt="Permanent preview"><div class="track-title"><p>Rolling</p></div><div class="record">00:24.531</div><small class="sq-permanent-note">Permanent Event RP</small></button></div><div class="sq-event-track-buttons">${support('weekly')}${support('daily')}</div></section></div></div></main></div><img class="unrelated" src="${icon}" alt="Unrelated preview">`;
const base=`@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,${(await fs.readFile(new URL('forced_square.woff2',root))).toString('base64')})}body{margin:0;background:#111d40;color:white;font-family:ForcedSquare,sans-serif}.button{background:#28346a;color:white;border:0;font:inherit}.track-of-the-week-info{display:flex;flex-direction:column}.unrelated{width:64px;height:48px;object-fit:cover}`;

async function measure(page){
 return page.evaluate(()=>{
  const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
  const card=document.querySelector('.sq-kodub-weekly>.button'),image=card.querySelector(':scope>img'),info=card.querySelector('.track-of-the-week-info');
  const sample=node=>({rect:rect(node),fit:getComputedStyle(node).objectFit,position:getComputedStyle(node).objectPosition});
  return {card:rect(card),image:sample(image),info:rect(info),natural:{width:image.naturalWidth,height:image.naturalHeight},grid:getComputedStyle(card).gridTemplateColumns,
   overflow:{client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth},
   others:[...document.querySelectorAll('.sq-permanent-track img,.sq-event-thumb img,.personal-best img,.unrelated')].map(sample)};
 });
}

const viewports=[
 [320,568],[375,812],[440,780],[479,800],[480,800],[481,800],
 [600,960],[768,1024],[820,1180],[1024,768],[1366,600],[1920,1080],[2560,1080],[3440,1440],
 ...[479,480,481,820,1024].flatMap(width=>[459,460,461].map(height=>[width,height])),
];
const previewStyles=items=>items.map(({rect,fit,position})=>({width:rect.width,height:rect.height,fit,position}));
const inside=(inner,outer)=>inner.x>=outer.x-1&&inner.right<=outer.right+1&&inner.y>=outer.y-1&&inner.bottom<=outer.bottom+1;
const settle=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));

test('Kodub cover has bounded mild cropping across sizes and live rotation; other previews stay native',{timeout:120000},async t=>{
 const directory=process.env.POLYTRACK_IMAGE_LAYOUT_OUTPUT||await fs.mkdtemp(path.join(tmpdir(),'polytrack-image-layout-'));
 await fs.mkdir(directory,{recursive:true});
 t.diagnostic('Screenshots: '+directory);
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
 try{
  const context=await browser.newContext({serviceWorkers:'block'});
  const requests=[];
  await context.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
  const page=await context.newPage(),baseline=await context.newPage();
  const load=async(page,events)=>{
   await page.setContent(`<style>${base}\n${[events,...styles.slice(1)].join('\n')}</style>${markup}`);
   await page.locator('img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
   await page.evaluate(()=>document.fonts.ready);
  };
  await load(page,styles[0]);await load(baseline,oldEvents);
  const results=[];
  const check=async(width,height,label)=>{
   await page.setViewportSize({width,height});await baseline.setViewportSize({width,height});
   await settle(page);await settle(baseline);
   const after=await measure(page),before=await measure(baseline);
   assert.equal(after.image.fit,'cover',label+': cover, never stretch');
   assert.equal(after.image.position,'50% 50%');
   const r=after.image.rect,ratio=r.width/r.height,native=after.natural.width/after.natural.height;
   const retained=Math.min(ratio/native,native/ratio);
   assert.ok(r.width>0&&r.height>0,label+': visible width AND height');
   assert.ok(Math.abs(ratio-1.9)<.005,label+': intentional box ratio');
   assert.ok(retained>=.94&&retained<1,label+': crop at most 6%, with no bars');
   assert.ok(inside(r,after.card),label+': art inside card');
   assert.ok(inside(after.info,after.card),label+': details inside card');
   assert.deepEqual(after.card,before.card,label+': outer card unchanged');
   assert.deepEqual(after.info,before.info,label+': details geometry unchanged');
   assert.deepEqual(previewStyles(after.others),previewStyles(before.others),label+': other previews unchanged');
   assert.ok(after.overflow.scroll<=after.overflow.client+1,label+': no horizontal page overflow');
   if(width>480&&width>height&&height<=460)assert.ok(r.height<=height*.6+1,label+': short-height bound');
   await page.screenshot({path:path.join(directory,`${label}.png`),fullPage:true});
   results.push({label,viewport:{width,height},cropFraction:1-retained,before,after});
   return after;
  };
  for(const [width,height] of viewports)await check(width,height,`kodub-${width}x${height}`);
  // One mounted DOM and decoded image throughout: no reload conceals stale resize state.
  for(const [width,height] of [[320,568],[375,812],[440,780],[600,960],[768,1024],[820,1180]]){
   const first=await check(width,height,`rotate-${width}-portrait`);
   await check(height,width,`rotate-${width}-landscape`);
   const last=await check(width,height,`rotate-${width}-return`);
   assert.deepEqual(last,first,`${width}: rotation restores exact geometry`);
  }
  // Native track maps are not cover artwork. Never crop wide/tall fallback maps.
  for(const [width,height] of [[320,568],[820,459],[1366,600]]){
   await page.setViewportSize({width,height});await settle(page);
   const original=await measure(page);
   for(const [w,h] of [[900,240],[240,900],[256,256]]){
    await page.locator('.sq-kodub-weekly>.button>img').evaluate(async(img,src)=>{img.className='thumbnail';img.src=src;await img.decode();},svg(w,h));
    const fallback=await measure(page);
    assert.equal(fallback.image.fit,'contain');
    assert.deepEqual(fallback.image.rect,original.image.rect,'fallback ratio does not dictate layout');
    await page.screenshot({path:path.join(directory,`fallback-${width}x${height}-${w}x${h}.png`),fullPage:true});
   }
   await page.locator('.sq-kodub-weekly>.button>img').evaluate(async(img,src)=>{img.className='cover';img.src=src;await img.decode();},cover);
  }
  assert.deepEqual(requests,[],'all fixture assets are inline local data; no external requests');
  await fs.writeFile(path.join(directory,'measurements.json'),JSON.stringify(results,null,2));
  t.diagnostic(`${results.length} viewport/resize checks; 9 fallback checks; zero network requests`);
 }finally{await browser.close();}
});
