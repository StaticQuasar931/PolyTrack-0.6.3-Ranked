import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
let chromium;try{({chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'));}catch{}
const {snapshot,serve}=require('./verifier/assets.cjs');
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=source.indexOf('  async function importExtraTrack('),end=source.indexOf('  async function submitExtraTrack(',start);
assert.ok(start>=0&&end>start);
test('all thirty collection tracks import serially with the native importer and remain saved',{skip:!chromium,timeout:120000},async()=>{
 const root=new URL('../',import.meta.url);const {fileURLToPath}=await import('node:url');
 const engine=snapshot(fileURLToPath(root)),server=await serve(engine),browser=await chromium.launch({headless:true});
 try{
 const page=await browser.newPage();await page.addInitScript(()=>localStorage.setItem('polytrack_v5_prod_startup_info',JSON.stringify({lastVersion:'0.6.3',isTutorialCompleted:true})));await page.route('**/*',route=>new URL(route.request().url()).origin===server.origin?route.continue():route.abort());
 await page.goto(server.origin,{waitUntil:'domcontentloaded'});await page.waitForFunction(()=>globalThis.__vrRequire);
 await page.locator('.main-buttons-container button').filter({hasText:/^Play$/}).click();
 await page.locator('.track-selection-ui').waitFor();
 const entries=JSON.parse(fs.readFileSync(new URL('../extra-tracks/catalog.json',import.meta.url),'utf8')).filter(e=>e.packId==='tmnf-ab');assert.equal(entries.length,30);
 await page.evaluate(({body,base})=>{
  window.extraTracksBaseUrl=base+'/extra-tracks/';window.extraTrackKnownIds={};window.extraTrackIds=()=>window.extraTrackKnownIds;window.extraTrackIdsKey='test-extra-ids';window.extraTracksUi=null;window.__pt062WebpackRequire=()=>window.__vrRequire;
  window.testNativeImport=new Function('return '+body.trim())();
 },{body:source.slice(start,end),base:server.origin});
 for(const entry of entries)await page.evaluate(entry=>window.testNativeImport(entry,{saveOnly:true}),entry);
 const known=await page.evaluate(()=>window.extraTrackKnownIds);assert.equal(Object.keys(known).length,30);
 for(const entry of entries)assert.equal(known[entry.id],entry.trackId);
 await page.evaluate(entry=>window.testNativeImport(entry,{saveOnly:true}),entries[0]);
 assert.equal(await page.locator('.track-selection-ui .tracks-container.no-group-containers .track-title p').count(),30);
 }finally{await browser.close();await server.close();}
});
