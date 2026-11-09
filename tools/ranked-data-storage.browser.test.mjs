import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {createRequire} from 'node:module';
import {isRankedCacheKey} from './ranked-data-storage.mjs';
const require=createRequire(import.meta.url);
const playwright=process.env.PLAYWRIGHT_MODULE?require(process.env.PLAYWRIGHT_MODULE):createRequire(new URL('./verifier/package.json',import.meta.url))('playwright');
let server,base,moduleBytes,entries;
const reports=[];
before(async()=>{
 moduleBytes=await fs.readFile(new URL('./ranked-data-storage.mjs',import.meta.url));
 entries=[{key:'polytrack-062-ranked-event-totals-v1',value:JSON.stringify({entries:[],padding:'x'.repeat(620000)})},
  {key:'polytrack-0.6.2-category-ranks-overall-v1',value:JSON.stringify({ranks:{},padding:'y'.repeat(300000)})},
  {key:'polytrack-0.6.2-recording-store-v1',value:JSON.stringify({1:{recording:'saved-replay'}})},
  {key:'polytrack_v5_prod_track_local',value:'saved-track'},
  {key:'polytrack-062-events-v1-queue',value:'[{"pending":true}]'}];
 if(process.env.POLYTRACK_STORAGE_EXPORT_DIR){
  const directory=process.env.POLYTRACK_STORAGE_EXPORT_DIR,rows=[];
  for(const name of (await fs.readdir(directory)).filter(n=>/-part-\d+\.json$/.test(n)).sort()){
   const part=JSON.parse(await fs.readFile(path.join(directory,name),'utf8'));
   for(const entry of part.entries||[])if(entry.source==='localStorage'){
    assert.equal(typeof entry.key,'string');assert.equal(typeof entry.value,'string');rows.push({key:entry.key,value:entry.value});
   }
  }
  assert(rows.length>0);assert.equal(new Set(rows.map(r=>r.key)).size,rows.length);entries=rows;
 }
 server=http.createServer((req,res)=>{
  if(req.url==='/'){res.writeHead(200,{'content-type':'text/html','cache-control':'no-store'});res.end('<!doctype html><title>Isolated storage test</title>');}
  else if(req.url==='/ranked-data-storage.mjs'){res.writeHead(200,{'content-type':'text/javascript','cache-control':'no-store'});res.end(moduleBytes);}
  else{res.writeHead(404);res.end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{
 await new Promise(resolve=>server?.close(resolve));
 if(process.env.POLYTRACK_STORAGE_TEST_REPORT)await fs.writeFile(process.env.POLYTRACK_STORAGE_TEST_REPORT,JSON.stringify({reports,backendReads:0,backendWrites:0},null,2)+'\n');
});
for(const name of ['chromium','firefox']){
 test(name+': exported caches survive migration and reload; native saves and another game stay byte-identical',async t=>{
  const browser=await playwright[name].launch({headless:true});t.after(()=>browser.close());
  const context=await browser.newContext();t.after(()=>context.close());
  const requests=[];await context.route('**/*',route=>{if(!route.request().url().startsWith(base+'/')){requests.push(route.request().url());return route.abort();}return route.continue();});
  const page=await context.newPage();await page.goto(base);
  const rows=[...entries,{key:'another-game-save',value:'z'.repeat(580000)},{key:'polytrack_v4_prod_legacy_save',value:'legacy-version-save'}];
  await page.evaluate(rows=>{for(const {key,value}of rows)localStorage.setItem(key,value);},rows);
  const expectedMoved=rows.filter(row=>isRankedCacheKey(row.key)),expectedChars=expectedMoved.reduce((n,row)=>n+row.key.length+row.value.length,0);
  const result=await page.evaluate(async rows=>{
   const {createRankedDataStorage,isRankedCacheKey}=await import('/ranked-data-storage.mjs');
   window.facade=createRankedDataStorage({storage:localStorage,indexedDB,eventTarget:window});await facade.ready;await facade.flush();
   const mismatch=[],removed=[];for(const {key,value}of rows){
    if(facade.getItem(key)!==value)mismatch.push(key);
    if(isRankedCacheKey(key)){if(localStorage.getItem(key)!==null)mismatch.push('not-moved:'+key);else removed.push(key);}
    else if(localStorage.getItem(key)!==value)mismatch.push('changed-save:'+key);
   }
   const lsChars=Array.from({length:localStorage.length},(_,i)=>localStorage.key(i)).reduce((n,key)=>n+key.length+localStorage.getItem(key).length,0);
   return{mismatch,removed:removed.length,remainingChars:lsChars,status:facade.status()};
  },rows);
  assert.deepEqual(result.mismatch,[]);assert.equal(result.removed,expectedMoved.length);assert.equal(result.status.durable,true);
  await page.reload();
  await page.evaluate(async()=>{const {createRankedDataStorage}=await import('/ranked-data-storage.mjs');window.facade=createRankedDataStorage({storage:localStorage,indexedDB,eventTarget:window});await facade.ready;});
  assert.equal(await page.evaluate(rows=>rows.every(row=>facade.getItem(row.key)===row.value),rows),true);
  const large=JSON.stringify({entries:[],padding:'n'.repeat(1500000)}),key='polytrack-062-ranked-event-totals-v1';
  await page.evaluate(async({key,large})=>{facade.setItem(key,large);await facade.flush();},{key,large});
  assert.equal(await page.evaluate(key=>localStorage.getItem(key),key),null);
  await page.reload();await page.evaluate(async()=>{const{createRankedDataStorage}=await import('/ranked-data-storage.mjs');window.facade=createRankedDataStorage({storage:localStorage,indexedDB,eventTarget:window});await facade.ready;});
  assert.equal(await page.evaluate(key=>facade.getItem(key),key),large);
  const old=await context.newPage();await old.goto(base);const legacy='{"entries":[],"legacyTabUpdate":true}';
  await old.evaluate(({key,legacy})=>localStorage.setItem(key,legacy),{key,legacy});
  await page.waitForFunction(({key,legacy})=>facade.getItem(key)===legacy,{key,legacy});
  assert.equal(await old.evaluate(()=>localStorage.getItem('another-game-save')),'z'.repeat(580000));
  await page.evaluate(async()=>facade.close());assert.deepEqual(requests,[]);
  const report={engine:name,originalEntries:rows.length,movedEntries:result.removed,freedCharacters:expectedChars,freedUtf16Bytes:expectedChars*2,remainingCharacters:result.remainingChars,protectedValuesChanged:0,reloadPassed:true,largeWritePassed:true,legacyTabUpdatePassed:true,externalRequests:0};reports.push(report);console.log(JSON.stringify(report));
 });
 test(name+': unavailable/blocked storage preserves all legacy sources and never expands localStorage with new caches',async t=>{
  const browser=await playwright[name].launch({headless:true});t.after(()=>browser.close());const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();await page.goto(base);
  const result=await page.evaluate(async()=>{
   const key='polytrack-062-ranked-event-totals-v1',original='cached-original';localStorage.setItem(key,original);localStorage.setItem('another-game-save','keep');
   const {createRankedDataStorage}=await import('/ranked-data-storage.mjs');
   const blocked={open(){return {};}};const facade=createRankedDataStorage({storage:localStorage,indexedDB:blocked,eventTarget:window,openTimeoutMs:30});
   await facade.ready;facade.setItem(key,'new-memory-only-cache');await facade.flush();const result={original:localStorage.getItem(key),other:localStorage.getItem('another-game-save'),visible:facade.getItem(key),status:facade.status()};await facade.close();return result;
  });
  assert.equal(result.original,'cached-original');assert.equal(result.other,'keep');assert.equal(result.visible,'new-memory-only-cache');assert.equal(result.status.durable,false);
 });
}
