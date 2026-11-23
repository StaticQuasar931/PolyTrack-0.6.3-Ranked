import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {startResponsiveServer} from './responsive-server.mjs';
import {encodeWorkshopStyle} from './public-workshop-style.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const supplied=JSON.parse(process.env.WORKSHOP_THUMB_TEST_RACER||'null');
test('native Workshop thumbnails decorate both ranked rows and profile cars without contacting Firebase',{timeout:85000},async()=>{
 const server=await startResponsiveServer();
 const browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 try{
  const page=await browser.newPage({viewport:{width:1366,height:768}});
  const source=await fs.readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
  const anchor='  const overallCarRenderCache = new Map();';
  const testTap=`window.__workshopThumbnailAudit=(row,views)=>{
    snapshotRacerDirectoryEntries[row.userId]={workshopStyle:row.workshopStyle,cosmeticContext:{medals:row.medals,rank:row.rank}};
    for(const [id,style] of views){
      const element=document.createElement('section');element.id=id;element.style='position:fixed;z-index:999999;right:0;top:'+(document.querySelectorAll('[data-workshop-audit]').length*210)+'px;width:200px;height:200px;background:#253963';
      element.dataset.workshopAudit='';element.innerHTML=carModelPreview(row.carStyle,'',row.userId,style==='directory'?null:style?row:{workshopStyle:''});element.firstElementChild.style='display:block;width:200px;height:200px';document.body.append(element);hydrateOverallCarModels(element);
    }
  };`;
  assert.ok(source.includes(anchor));
  let thumbnailCloudRequests=0;
  await page.route('**/*',route=>{
    const request=route.request();
    if(!request.url().startsWith(server.url+'/')){if(/firestore|workers\.dev/i.test(request.url()))thumbnailCloudRequests++;return route.abort();}
    if(new URL(request.url()).pathname==='/polytrack_062_patch.js')return route.fulfill({contentType:'text/javascript',body:source.replace(anchor,testTap+anchor)});
    return route.continue();
  });
  await page.goto(server.url,{waitUntil:'commit'});
  await page.waitForFunction(()=>!!window.__polytrackWebpackRequire062&&!!window.__workshopThumbnailAudit,{},{timeout:45000});

  const row={userId:supplied?.userId||'a'.repeat(64),medals:supplied?.medals||{gold:1},rank:1,
   workshopStyle:encodeWorkshopStyle(supplied?.saved||{accessory:'crown',finish:'neon',rear:'rearbar'})};
  row.carStyle=supplied?.carStyle||await page.evaluate(()=>__polytrackWebpackRequire062(8724).A.default().serialize());
  const raw=await page.evaluate(async row=>{
   const load=window.__polytrackWebpackRequire062;
   const {createWorkshopCarThumbnail}=await import('/tools/workshop-car-thumbnail.mjs');
   const {workshopThumbnailSelection}=await import('/tools/public-workshop-style.mjs');
   return createWorkshopCarThumbnail(document,load)(load(8724).A.deserializeSafe(row.carStyle),workshopThumbnailSelection(row.workshopStyle,row));
  },row);
  assert.match(raw,/^data:image\/png;base64,/);
  const baselineRequests=thumbnailCloudRequests;
  await page.evaluate(row=>window.__workshopThumbnailAudit(row,[['ranked-saved','directory'],['profile-saved',true],['stock-car',false]]),row);
  const thumbnails=await Promise.all(['ranked-saved','profile-saved','stock-car'].map(async id=>{
   const image=page.locator('#'+id+' .overall-car-model img:nth-child(2).show');
   await image.waitFor({state:'attached',timeout:25000});return image.getAttribute('src');
  }));
  for(const image of thumbnails)assert.match(image,/^data:image\/png;base64,/);
  assert.equal(thumbnails[0],thumbnails[1]);
  assert.notEqual(thumbnails[0],thumbnails[2]);
  assert.equal(thumbnailCloudRequests,baselineRequests);
  if(process.env.WORKSHOP_THUMB_EVIDENCE)await page.screenshot({path:process.env.WORKSHOP_THUMB_EVIDENCE,animations:'disabled'});
 }finally{await browser.close();await server.close();}
});
