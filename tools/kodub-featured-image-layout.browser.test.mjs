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
const marker='/* Bound only the featured Kodub artwork; keep desktop geometry and other previews intact. */';
// Recreate the old final cover rule for a focused, same-fixture regression comparison.
const oldEvents=styles[0].split(marker)[0].replace(/(\/\* Final card details override older event-rail experiments above\. \*\/[\s\S]*?object-fit:)contain/, '$1cover');
const svg=(width,height)=>'data:image/svg+xml;base64,'+Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#284b65"/><rect x="3" y="3" width="${width-6}" height="${height-6}" fill="none" stroke="#ffdf85" stroke-width="6"/><text x="50%" y="50%" text-anchor="middle" fill="white" font-size="28">Complete artwork</text></svg>`).toString('base64');
const icon=svg(32,32);
const support=kind=>`<button class="sq-event-card" data-event-kind="${kind}"><span class="sq-event-thumb"><span class="profile-track-image-frame"><img src="${icon}" alt="${kind} preview"></span></span><span class="sq-event-record">00:24.531</span><span><small>${kind.toUpperCase()} EVENT</small><strong>Winter 5</strong><span class="sq-event-card-details"><small class="sq-event-reward">Up to 500 Event RP</small><small class="sq-event-reset">Resets Sun 17:00</small></span></span></button>`;
// Native weekly structure: direct cover (or thumbnail fallback), then the information panel.
const markup=`<div id="ui"><main class="track-selection-ui"><div class="tracks-container open"><div class="wrapper"><div class="community-track-versions"><button class="button">Featured Events</button></div><section class="sq-featured-events"><div class="track track-of-the-week sq-kodub-weekly"><button class="button"><img class="cover" src="${cover}" alt="Kodub weekly artwork"><div class="track-of-the-week-info"><div class="title">Hydropower</div><div class="author">By Bobson Dugnutt</div><div class="time-remaining">5d 12h 30m</div><div class="date-range">Oct 25 - Nov 1</div><div class="personal-best"><div><img src="${icon}" alt="Timer">00:24.531</div></div><small class="sq-kodub-reward">Up to 700 Event RP</small></div></button></div><div class="track sq-permanent-track"><button class="button"><img class="thumbnail" src="${icon}" alt="Permanent preview"><div class="track-title"><p>Rolling</p></div><div class="record">00:24.531</div><small class="sq-permanent-note">Permanent Event RP</small></button></div><div class="sq-event-track-buttons">${support('weekly')}${support('daily')}</div></section></div></div></main></div><img class="unrelated" src="${icon}" alt="Unrelated preview">`;
const base=`@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,${(await fs.readFile(new URL('forced_square.woff2',root))).toString('base64')})}body{margin:0;background:#111d40;color:white;font-family:ForcedSquare,sans-serif}.button{background:#28346a;color:white;border:0;font:inherit}.track-of-the-week-info{display:flex;flex-direction:column}.unrelated{width:64px;height:48px;object-fit:cover}`;

async function measure(page){
 return page.evaluate(()=>{
  const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
  const card=document.querySelector('.sq-kodub-weekly>.button'),image=card.querySelector(':scope>img'),info=card.querySelector('.track-of-the-week-info');
  const sample=node=>({rect:rect(node),fit:getComputedStyle(node).objectFit,position:getComputedStyle(node).objectPosition});
  return {card:rect(card),image:sample(image),info:rect(info),natural:{width:image.naturalWidth,height:image.naturalHeight},grid:getComputedStyle(card).gridTemplateColumns,
   others:[...document.querySelectorAll('.sq-permanent-track img,.sq-event-thumb img,.personal-best img,.unrelated')].map(sample)};
 });
}

test('Kodub featured artwork is uncropped and bounded without changing desktop geometry or other previews',{timeout:60000},async t=>{
 const directory=process.env.POLYTRACK_IMAGE_LAYOUT_OUTPUT||await fs.mkdtemp(path.join(tmpdir(),'polytrack-image-layout-'));
 await fs.mkdir(directory,{recursive:true});
 t.diagnostic('Screenshots: '+directory);
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('**/*',route=>route.abort());
  const results=[];
  for(const [width,height] of [[375,812],[440,780],[844,320],[1366,600]]){
   await page.setViewportSize({width,height});
   const load=async events=>{
    await page.setContent(`<style>${base}\n${[events,...styles.slice(1)].join('\n')}</style>${markup}`);
    await page.locator('.sq-kodub-weekly>.button>img').evaluate(img=>img.decode());
    await page.evaluate(()=>document.fonts.ready);
   };
   await load(oldEvents);
   const before=await measure(page);
   await load(styles[0]);
   const after=await measure(page);
   assert.equal(after.image.fit,'contain',`${width}: artwork must not crop or stretch`);
   assert.equal(after.image.position,'50% 50%',`${width}: centered letterboxing`);
   const previewStyles=items=>items.map(({rect,fit,position})=>({width:rect.width,height:rect.height,fit,position}));
   assert.deepEqual(previewStyles(after.others),previewStyles(before.others),`${width}: unrelated previews and icons must not change`);
   assert.equal(after.grid,before.grid,`${width}: preserve native column proportions`);
   const {image,card}=after;
   assert.ok(image.rect.width>0&&image.rect.height>0,`${width}: visible image box`);
   assert.ok(image.rect.x>=card.x-1&&image.rect.right<=card.right+1&&image.rect.y>=card.y-1&&image.rect.bottom<=card.bottom+1,`${width}: image box stays inside card`);
   if(width<=480)assert.ok(image.rect.height>=112&&image.rect.height<=160,`${width}: bounded portrait preview`);
   if(width===844)assert.ok(image.rect.height<=height*.6+1,`${width}: bounded short landscape preview`);
   if(width===1366){assert.deepEqual(after.card,before.card);assert.deepEqual(after.info,before.info);assert.deepEqual(after.image.rect,before.image.rect);}
   await page.screenshot({path:path.join(directory,`kodub-${width}x${height}.png`),fullPage:true});
   results.push({viewport:{width,height},before,after});
   // Wide and tall fallback art must use the same contain policy, not just this week's cover.
   for(const [w,h] of [[900,240],[240,900]]){
    await page.locator('.sq-kodub-weekly>.button>img').evaluate(async(img,src)=>{img.className='thumbnail';img.src=src;await img.decode();},svg(w,h));
    const fallback=await measure(page);
    assert.equal(fallback.image.fit,'contain');
    assert.deepEqual(fallback.image.rect,after.image.rect,`${width}: art ratio must not dictate layout`);
   }
  }
  await fs.writeFile(path.join(directory,'measurements.json'),JSON.stringify(results,null,2));
 }finally{await browser.close();}
});
