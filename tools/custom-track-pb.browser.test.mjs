import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';
import {startResponsiveServer} from './responsive-server.mjs';

const playwright=createRequire(new URL('./verifier/package.json',import.meta.url))('playwright');
const source=await fs.readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const code=await fs.readFile(new URL('../tracks/official/summer1.track',import.meta.url),'utf8');
const trackId='5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const marker='  async function getTrackEntries(';
assert.equal(source.split(marker).length,2);
// Test-only access into the actual shipped closure; native code and DOM stay intact.
const binding=`window.__pbAudit={
  account:()=>activeRankedAccountId(),
  save:(timeMs)=>addLocalRaceRow({accountId:activeRankedAccountId(),trackId:'${trackId}',timeMs,frames:timeMs,createdAt:Date.now()}),
  render:()=>decoratePersonalBestPodiums(),
  evict:()=>{localStorage.removeItem(TRACK_CACHE_KEY);jsonStorageCache.delete(TRACK_CACHE_KEY);trackCacheGeneration++;schedulePersonalBestPlacementRender();}
};\n`;

for(const engine of (process.env.POLYTRACK_PB_BROWSERS||'chromium,firefox').split(',')){
  test(`actual native Custom Tracks retains PBs across cache eviction and reload: ${engine}`,{timeout:180000},async t=>{
    const output=process.env.POLYTRACK_PB_OUTPUT?path.resolve(process.env.POLYTRACK_PB_OUTPUT):await fs.mkdtemp(path.join(tmpdir(),'polytrack-pb-'));
    await fs.mkdir(output,{recursive:true});
    const server=await startResponsiveServer();let browser,page;
    try{
      browser=await playwright[engine].launch({headless:true,...(engine==='chromium'?{args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}:{})});
      page=await browser.newPage({viewport:{width:1366,height:768}});const external=[],errors=[];
      await page.addLocatorHandler(page.locator('dialog[data-site-installed-release][open]'),dialog=>dialog.getByRole('button',{name:'OK',exact:true}).click());
      page.on('pageerror',error=>errors.push(String(error)));
      await page.route(url=>url.origin!==new URL(server.url).origin,route=>{
        const url=new URL(route.request().url());
        if(url.pathname==='/v6/user')return route.fulfill({status:200,contentType:'application/json',body:'null'});
        external.push(url.origin);return route.abort('blockedbyclient');
      });
      await page.route(url=>url.pathname.endsWith('/polytrack_062_patch.js'),route=>route.fulfill({status:200,contentType:'text/javascript',body:source.replace(marker,binding+marker)}));
      await page.addInitScript(code=>{
        localStorage.setItem('polytrack_v5_prod_track_Summer 1',JSON.stringify({data:code,saveTime:Date.now()}));
      },code);
      const menu=async()=>{
        for(let step=0;step<3;step++){
          await page.waitForFunction(()=>Array.from(document.querySelectorAll('button')).some(button=>button.getClientRects().length&&/^(Exit|Back|Play)$/.test(button.textContent.trim())),null,{timeout:40000});
          const play=page.locator('button:visible').filter({hasText:/^\s*Play\s*$/}).last();
          if(await play.count()){await play.click();break;}
          const leave=page.locator('button:visible').filter({hasText:/^\s*(Exit|Back)\s*$/i}).last();await leave.click();
        }
        await page.locator('.track-selection-ui .image-button-container > button').nth(2).click();
        await page.locator('.tracks-container.no-group-containers .track-title p').filter({hasText:/^Summer 1$/}).waitFor();
      };
      const record=()=>page.locator('.tracks-container.no-group-containers .track').filter({has:page.locator('.track-title p').filter({hasText:/^Summer 1$/})}).locator('.record');
      await page.goto(server.url,{waitUntil:'domcontentloaded'});await menu();
      await page.waitForFunction(()=>Boolean(window.__pbAudit?.account()));
      assert.equal(await page.evaluate(()=>window.__pbAudit.save(24675)),true);
      await page.evaluate(()=>window.__pbAudit.render());
      await record().filter({hasText:'00:24.675'}).waitFor();
      for(const viewport of [{width:1366,height:768},{width:390,height:844},{width:844,height:390},{width:768,height:1024},{width:700,height:700}]){
        await page.setViewportSize(viewport);await page.evaluate(()=>window.__pbAudit.render());
        assert.match(await record().innerText(),/00:24\.675/);
        await page.screenshot({path:path.join(output,`${engine}-${viewport.width}x${viewport.height}.png`)});
      }
      await page.evaluate(()=>window.__pbAudit.evict());
      await record().filter({hasText:'00:24.675'}).waitFor();
      await page.reload({waitUntil:'domcontentloaded'});await menu();
      await record().filter({hasText:'00:24.675'}).waitFor();
      assert.equal(await page.evaluate(()=>window.__pbAudit.save(24000)),true);
      await page.evaluate(()=>window.__pbAudit.render());await record().filter({hasText:'00:24.000'}).waitFor();
      assert.match(await record().getAttribute('title'),/Local PB/);
      assert.deepEqual(errors,[]);
      await fs.writeFile(path.join(output,`${engine}-receipt.json`),JSON.stringify({nativeBundle:true,actualPatchClosure:true,viewports:5,reload:true,cacheEviction:true,newPb:true,externalRequestsBlocked:external.length,pageErrors:errors,productionFirestoreRequests:0},null,2));
      t.diagnostic('Evidence: '+output);
    }catch(error){
      await page?.screenshot({path:path.join(output,`${engine}-failed.png`)}).catch(()=>{});
      await fs.writeFile(path.join(output,`${engine}-failed.json`),JSON.stringify(await page?.evaluate(()=>({text:document.body.innerText,buttons:Array.from(document.querySelectorAll('button:enabled')).filter(button=>button.getClientRects().length).map(button=>button.textContent.trim()),storage:Object.keys(localStorage),record:document.querySelector('.tracks-container.no-group-containers .record')?.outerHTML})).catch(()=>null),null,2));
      throw error;
    }finally{await browser?.close();await server.close();}
  });
}
