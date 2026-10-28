import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const {chromium}=createRequire(new URL('./verifier/package.json',import.meta.url))('playwright');

test('static snapshot update results fit phones and restore keyboard focus',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
 const page=await browser.newPage();let external=0;
 const source=await fs.readFile(new URL('./snapshot-update-check.mjs',import.meta.url),'utf8');
 const guardSource=await fs.readFile(new URL('./partial-replay-selection.mjs',import.meta.url),'utf8');
 const css=await fs.readFile(new URL('../home-ui.css',import.meta.url),'utf8');
 const evidence=process.env.SNAPSHOT_UPDATE_EVIDENCE;
 if(evidence)await fs.mkdir(evidence,{recursive:true});
 await page.route('**/*',route=>{
  const url=new URL(route.request().url());if(url.hostname!=='snapshot.test'){external++;return route.abort();}
  return route.fulfill({contentType:url.pathname.endsWith('.mjs')?'text/javascript':'text/html',body:url.pathname.endsWith('partial-replay-selection.mjs')?guardSource:url.pathname.endsWith('.mjs')?source:'<button id="status">Snapshot package</button>'});
 });
 await page.goto('http://snapshot.test/');await page.addStyleTag({content:css});
 await page.evaluate(async()=>{
  window.nativeKeys=[];window.reloads=0;
  for(const type of ['keydown','keyup']){
   document.addEventListener(type,event=>window.nativeKeys.push('document:'+type+':'+event.key),true);
   window.addEventListener(type,event=>window.nativeKeys.push('window:'+type+':'+event.key));
  }
  window.check=await import('/snapshot-update-check.mjs');
 });
 for(const [width,height] of [[320,568],[390,844],[844,320],[768,1024],[1366,768]]){
  await page.setViewportSize({width,height});await page.locator('#status').focus();
  await page.evaluate(()=>check.showSnapshotUpdateResult({status:'newer',generation:69},{reload:()=>reloads++}));
  const box=await page.locator('dialog').boundingBox();assert.ok(box.x>=0&&box.y>=0&&box.x+box.width<=width+1&&box.y+box.height<=height+1);
  assert.equal(await page.getByRole('button',{name:'Reload this page'}).count(),1);
  assert.match(await page.locator('#sq-snapshot-update-description').textContent(),/Pinned links and embedded games may reopen the same build/);
  assert.doesNotMatch(await page.locator('#sq-snapshot-update-description').textContent(),/Reload to load the latest/);
  if(evidence)await page.screenshot({path:evidence+`/snapshot-update-${width}x${height}.png`});
  for(const key of ['=','y','u','i'])await page.keyboard.press(key);
  await page.keyboard.press('Tab');
  assert.equal(await page.getByRole('button',{name:'Reload this page'}).evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.getByRole('button',{name:'Close',exact:true}).evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('Escape');await page.locator('dialog').waitFor({state:'detached'});assert.equal(await page.locator('dialog').count(),0);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'status');
  assert.deepEqual(await page.evaluate(()=>window.nativeKeys),[],'native keys and Escape release do not escape the modal');
 }
 await page.evaluate(()=>check.showSnapshotUpdateResult({status:'current'}));
 assert.equal(await page.getByRole('button',{name:'Reload this page'}).count(),0);
 await page.getByRole('button',{name:'Close',exact:true}).focus();await page.keyboard.press('Enter');await page.locator('dialog').waitFor({state:'detached'});
 assert.equal(await page.evaluate(()=>reloads),0,'no automatic reload');
 await page.evaluate(()=>check.showSnapshotUpdateResult({status:'newer',generation:69},{reload:()=>reloads++}));
 await page.getByRole('button',{name:'Reload this page'}).focus();await page.keyboard.press('Space');assert.equal(await page.evaluate(()=>reloads),1);
 assert.deepEqual(await page.evaluate(()=>window.nativeKeys),[]);
 await page.keyboard.press('=');assert.ok((await page.evaluate(()=>window.nativeKeys)).length>0,'game listeners resume after the modal closes');
 assert.equal(external,0);
});
