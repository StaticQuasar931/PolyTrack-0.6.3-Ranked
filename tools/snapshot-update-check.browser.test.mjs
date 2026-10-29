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
 await page.evaluate(()=>{
  window.shakes=[];const origin=document.getElementById('status'),animate=origin.animate.bind(origin);
  origin.animate=(frames,options)=>{shakes.push({frames,options});return animate(frames,options);};
  origin.setAttribute('aria-describedby','existing-description');
 });
 for(const reducedMotion of ['no-preference','reduce']){
  await page.emulateMedia({reducedMotion});
  const before=await page.evaluate(()=>shakes.length);
  for(let click=0;click<2;click++){
   await page.evaluate(()=>{window.feedback=check.showSnapshotUpdateResult({status:'current'},{origin:document.getElementById('status')});});
   await page.waitForFunction(()=>document.querySelector('[role="status"]')?.textContent==='No newer snapshot reported.');
   assert.equal(await page.locator('dialog').count(),0,'no-update must never open a modal');
   assert.equal(await page.getByRole('status').count(),1,'repeat feedback replaces, not stacks');
   assert.equal(await page.getByRole('status').textContent(),'No newer snapshot reported.');
   assert.equal(await page.getByRole('status').getAttribute('aria-live'),'polite');
   assert.equal(await page.evaluate(()=>document.activeElement.id),'status');
   assert.match(await page.locator('#status').getAttribute('aria-describedby'),/^existing-description sq-snapshot-check-status-/);
  }
  assert.equal(await page.evaluate(()=>shakes.length),before+(reducedMotion==='reduce'?0:2));
  await page.evaluate(()=>feedback.dispose());
  assert.equal(await page.getByRole('status').count(),0);
  assert.equal(await page.locator('#status').getAttribute('aria-describedby'),'existing-description');
 }
 assert.deepEqual(await page.evaluate(()=>shakes[0].frames.map(frame=>frame.translate)),['0px','-3px','3px','-2px','2px','0px']);
 for(const status of ['unavailable','stale']){
  await page.evaluate(status=>{window.feedback=check.showSnapshotUpdateResult({status});},status);
  await page.waitForFunction(()=>document.querySelector('[role="status"]')?.textContent);
  assert.equal(await page.locator('dialog').count(),0);
  assert.match(await page.getByRole('status').textContent(),status==='stale'?/older than/:/check failed/);
  assert.doesNotMatch(await page.getByRole('status').textContent(),/No newer/);
  await page.evaluate(()=>feedback.dispose());
 }
 await page.evaluate(()=>{
  check.showSnapshotUpdateResult({status:'cancelled'});
  check.showSnapshotUpdateResult({status:'current'},{isCurrent:()=>false});
  const detached=document.createElement('button');check.showSnapshotUpdateResult({status:'current'},{origin:detached});
 });
 assert.equal(await page.getByRole('status').count(),0);
 await page.evaluate(()=>{
  const controller=new AbortController();
  check.showSnapshotUpdateResult({status:'current'},{signal:controller.signal});controller.abort();
 });
 assert.equal(await page.getByRole('status').count(),0,'cancel cleans up before announcement');
 await page.evaluate(()=>{
  const controller=new AbortController();
  check.showSnapshotUpdateResult({status:'newer',generation:69},{signal:controller.signal});controller.abort();
 });
 assert.equal(await page.locator('dialog').count(),0,'panel lifecycle removes late prompts');
 await page.evaluate(()=>{window.feedback=check.showSnapshotUpdateResult({status:'current'},{origin:document.getElementById('status')});});
 await page.evaluate(()=>window.dispatchEvent(new Event('pagehide')));
 assert.equal(await page.getByRole('status').count(),0,'page lifecycle releases feedback');
 assert.equal(await page.evaluate(()=>reloads),0,'no automatic reload');
 await page.locator('#status').focus();
 await page.evaluate(()=>check.showSnapshotUpdateResult({status:'newer',generation:69},{reload:()=>reloads++}));
 await page.getByRole('button',{name:'Reload this page'}).focus();await page.keyboard.press('Space');assert.equal(await page.evaluate(()=>reloads),1);
 assert.deepEqual(await page.evaluate(()=>window.nativeKeys),[]);
 await page.keyboard.press('=');assert.ok((await page.evaluate(()=>window.nativeKeys)).length>0,'game listeners resume after the modal closes');
 assert.equal(external,0);
});
