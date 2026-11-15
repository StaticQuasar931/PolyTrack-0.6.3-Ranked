import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {gunzipSync} from 'node:zlib';
import {startResponsiveServer} from './responsive-server.mjs';
import {RELEASE_INFO} from './release-info.mjs';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const evidence=process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR||'C:/Users/Static/Documents/Codexstorage/PolyTrack/Projects/Ranked-0.6.3/2026-11-14/ui-followup';

test('actual native Studio retains real account car output and chosen scene across late history hydration',{timeout:110000},async()=>{
 const pointer=JSON.parse(await fs.readFile(path.join(root,'snapshot-current.json'))),index=JSON.parse(await fs.readFile(path.join(root,pointer.currentdir,'index.json')));
 const entry=index.files['overall-pages/1.json'];const encoded=await fs.readFile(path.join(root,pointer.currentdir,entry.path));
 const board=JSON.parse(gunzipSync(Buffer.from(encoded.map(b=>b^0xa7))));const accountId=board.entries[0].userId||board.entries[0].accountId;
 const server=await startResponsiveServer();let browser,releaseModule;
 const report={kind:'actual-native-studio-preview',sourceDirectory:pointer.currentdir,accountId,externalRequests:[],pageErrors:[],checks:{},fixtureHtml:false,syntheticCanvas:false};
 try{
  await fs.mkdir(evidence,{recursive:true});browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});const context=await browser.newContext({viewport:{width:1366,height:900}}),page=await context.newPage();page.setDefaultTimeout(12000);
  page.on('pageerror',error=>report.pageErrors.push(error.message));
  await page.route('**/*',async route=>{
   const url=new URL(route.request().url());if(url.origin!==server.url){report.externalRequests.push({origin:url.origin,method:route.request().method()});return route.abort();}
   if(url.pathname==='/tools/studio-draft-host.mjs')await new Promise(resolve=>{releaseModule=resolve;});return route.continue();
  });
  await context.addInitScript(({accountId,release})=>{
   localStorage.setItem('polytrack-0.6.2-active-account-id',accountId);localStorage.setItem('polytrack-0.6.2-guest-account-id',accountId);
   localStorage.setItem('polytrack-site-update-ack-release-v1:'+release.number,'acknowledged');localStorage.setItem('polytrack-site-update-ack-v1:'+release.revision,'acknowledged');
  },{accountId,release:RELEASE_INFO});
  console.log('boot actual native app');await page.goto(server.url,{waitUntil:'domcontentloaded',timeout:25000});await page.getByRole('button',{name:'Exit',exact:true}).waitFor({timeout:40000});await page.getByRole('button',{name:'Exit',exact:true}).click();await page.getByRole('button',{name:'Back',exact:true}).click();
  await page.evaluate(accountId=>{localStorage.setItem('polytrack-0.6.2-active-account-id',accountId);localStorage.setItem('polytrack-0.6.2-guest-account-id',accountId);window.dispatchEvent(new StorageEvent('storage',{key:'polytrack-0.6.2-active-account-id',newValue:accountId,storageArea:localStorage}));},accountId);
  await page.getByRole('button',{name:'Ranked',exact:true}).click();await page.locator('#overallLeaderboardList .overall-entry[data-userid]').first().waitFor({timeout:35000});await page.locator('#overallFindMeBtn').click();await page.locator('#overallLeaderboardList .overall-entry[data-userid="'+accountId+'"]').click();await page.locator('[data-ph-launch="studio"]').waitFor({timeout:20000});await page.locator('[data-ph-launch="studio"]').click();await page.locator('dialog[open] .profile-customizer').waitFor();
  const actual=page.locator('dialog[open] .profile-preview-stage>.overall-car-model');assert.equal(await actual.getAttribute('data-userid'),accountId);
  await page.waitForFunction(()=>{const images=document.querySelector('dialog[open] .profile-preview-stage>.overall-car-model')?.querySelectorAll('img');return images&&[...images].some(img=>img.naturalWidth>0&&img.currentSrc&&!img.currentSrc.includes('car_thumbnail_placeholder'));},null,{timeout:20000});
  report.checks.car=await actual.evaluate(node=>({renderArg:node.dataset.renderarg,images:[...node.querySelectorAll(':scope>img')].map(img=>({width:img.naturalWidth,height:img.naturalHeight,rendered:!!img.currentSrc&&!img.currentSrc.includes('car_thumbnail_placeholder')}))}));
  const authority=await page.locator('#overallProfileContent .profile-car-column>.overall-car-model').getAttribute('data-renderarg');assert.equal(report.checks.car.renderArg,authority,'Studio uses the same actual account style/colors as the real profile renderer');
  await page.locator('[data-studio-tab="car"]').click();const previous=await page.locator('[data-cosmetic-kind="stage"][aria-pressed="true"]').getAttribute('data-cosmetic-value');const next=previous==='slate'?'garage':'slate';report.checks.sourceScene=previous;report.checks.selectedScene=next;await page.locator('[data-cosmetic-kind="stage"][data-cosmetic-value="'+next+'"]').click();const selected=await actual.evaluate(node=>getComputedStyle(node).backgroundImage);assert.match(selected,/gradient/);
  await page.evaluate(()=>document.documentElement.classList.add('sq-plain-racer-themes'));assert.equal(await actual.evaluate(node=>getComputedStyle(node).backgroundImage),selected);
  assert.equal(typeof releaseModule,'function','History import was genuinely delayed');releaseModule();releaseModule=null;await page.waitForFunction(()=>document.querySelector('#overallProfileContent').__studioDraftHistory);
  assert.equal(await actual.evaluate(node=>getComputedStyle(node).backgroundImage),selected,'Late module initialization cannot reset the user selection');
  const misplaced=await actual.locator('[data-studio-favorite-preview]').count();assert.equal(misplaced,0,'Favorite text cannot become a native renderer child');
  assert.equal(await page.locator('dialog[open] .studio-tabs>.profile-shop-open').count(),1);report.checks.history=await page.evaluate(()=>({dirty:document.querySelector('#overallProfileContent').__studioDraftHistory.isDirty(),undoDisabled:document.querySelector('dialog[open] .studio-undo').disabled}));
  report.checks.scene=selected;report.checks.delayedHydrationPreserved=true;report.checks.nativeCarOutputPreserved=true;await page.screenshot({path:path.join(evidence,'actual-studio-preview-desktop.png'),animations:'disabled'});assert.equal(report.checks.history.undoDisabled,false);assert.equal(report.checks.history.dirty,true);
  await page.setViewportSize({width:390,height:844});await page.screenshot({path:path.join(evidence,'actual-studio-preview-phone.png'),animations:'disabled'});
  assert.equal(await page.locator('dialog[open]').evaluate(node=>node.scrollWidth>node.clientWidth+1),false);report.checks.phoneFits=true;
 }finally{
  releaseModule?.();await browser?.close();await server.close();await fs.writeFile(path.join(evidence,'actual-studio-preview-report.json'),JSON.stringify(report,null,2)+'\n');
 }
});
