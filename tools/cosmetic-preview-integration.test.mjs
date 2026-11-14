import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8').replaceAll('\r\n','\n');
function between(start,end){const a=source.indexOf(start),b=source.indexOf(end,a);assert.ok(a>=0&&b>a,'Actual parent hook boundary missing');return source.slice(a,b);}
const hook=between('  function setupCosmeticPreview(content,entry,isSelf){','  function setupRacerStudio(content){');
const save=between('  async function saveRankedProfileCosmetics(accountId,status,button){','  let rankedQueueFlushPromise=');
let browser,server,base;
before(async()=>{
 server=http.createServer((request,response)=>{
  const name=new URL(request.url,'http://localhost').pathname;
  if(name==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Actual cosmetic preview hook</title>');return;}
  if(!['/tools/cosmetic-preview.mjs','/tools/cosmetic-preview.css'].includes(name)){response.writeHead(404).end();return;}
  response.setHeader('Content-Type',name.endsWith('.mjs')?'text/javascript':'text/css');response.end(fs.readFileSync(new URL('..'+name,import.meta.url)));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({headless:true});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server.close(resolve));});
async function fixture(t){
 const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort());await page.goto(base);
 await page.evaluate(({hook,save,base})=>{
  document.body.innerHTML='<article class="overall-profile-card theme-blue" style="--theme:blue"><div id="overallProfileContent"><details class="profile-customizer" open><summary>Studio</summary><section class="profile-customizer-preview"><span data-cosmetic-title-preview>Original title</span><span data-cosmetic-badge-preview><span class="original-badge">Original badge</span></span><div class="profile-customizer-actions"><span id="publish-status" role="status">Original status</span><button type="button" data-save-profile-cosmetics>Publish</button></div></section><button type="button" id="gold" data-cosmetic-choice data-cosmetic-kind="theme" data-cosmetic-value="gold" data-cosmetic-locked="true" aria-disabled="true" title="Locked"><b>Gold</b></button><button type="button" id="champ" data-cosmetic-choice data-cosmetic-kind="title" data-cosmetic-value="champ" data-cosmetic-locked="true" aria-disabled="true" title="Locked"><b>Champion</b></button><button type="button" id="beta" data-cosmetic-choice data-cosmetic-kind="badge" data-cosmetic-value="betaTester" data-cosmetic-locked="true" aria-disabled="true" title="Locked"><b>Beta</b></button></details></div></article>';
  const accountId='a'.repeat(64);window.activeAccount=accountId;window.storageWrites=0;window.cloudAttempts=0;window.draftSets=0;
  const content=document.getElementById('overallProfileContent');content.__socialEpoch=1;content.querySelector('[data-save-profile-cosmetics]').dataset.accountId=accountId;
  const entry={accountId},initial={theme:'blue',title:'none',badge:'none'};
  const profileCosmeticDrafts=new Map([[accountId,{...initial}]]),set=profileCosmeticDrafts.set.bind(profileCosmeticDrafts);profileCosmeticDrafts.set=(...args)=>{draftSets++;return set(...args);};window.drafts=profileCosmeticDrafts;
  const PROFILE_COSMETIC_OPTIONS={theme:[['blue','Blue',0],['gold','Gold',12]],title:[['none','None',0],['champ','Champion','pb:25']],badge:[['none','None',0],['betaTester','Beta','beta']]};
  let cosmeticPreviewModuleRequest=null;const extraCatalogRevision=313,eventsModuleUrl=new URL('/events/client.mjs',base);
  const cleanUserId=value=>String(value||''),activeRankedAccountId=()=>activeAccount,sanitizeProfileCosmetics=value=>({...value}),cosmeticsForEntry=()=>({...initial});
  const applyProfileCosmetics=(card,value)=>{card.className='overall-profile-card theme-'+value.theme;card.style.setProperty('--theme',value.theme);};
  const cosmeticTitleText=(_entry,value)=>value.title==='champ'?'Champion':'Original title';
  const profileBadgeMarkup=()=>'<span class="original-badge">Original badge</span>',escapeHtml=value=>String(value);
  const PROFILE_COSMETICS_KEY='synthetic-cosmetics',writeJsonStorage=()=>{storageWrites++;return false;};
  window.firebase={auth(){cloudAttempts++;throw Error('No cloud access permitted');}};
  const db=()=>{cloudAttempts++;throw Error('No cloud access permitted');};
  eval(hook+'\n'+save+'\nwindow.actualSetup=setupCosmeticPreview;window.actualSave=saveRankedProfileCosmetics;');
  window.content=content;window.studio=content.querySelector('details');window.card=content.closest('article');window.originalDraft=JSON.stringify(profileCosmeticDrafts.get(accountId));
  window.callSave=()=>actualSave(accountId,studio.querySelector('.profile-customizer-actions [role="status"]'),studio.querySelector('[data-save-profile-cosmetics]'));
  actualSetup(content,entry,true);
 },{hook,save,base});
 await page.waitForFunction(()=>!!content.__cosmeticPreviewController);return page;
}

test('actual setup hook previews without draft mutation and actual save guard returns before storage/cloud',async t=>{
 const p=await fixture(t);assert.equal(await p.locator('#gold').getAttribute('aria-disabled'),null);assert.equal(await p.locator('#gold').getAttribute('data-cosmetic-previewable'),'true');
 await p.locator('#gold').click();assert.equal(await p.locator('article').getAttribute('class'),'overall-profile-card theme-gold');
 assert.equal(await p.evaluate(()=>draftSets),0);assert.equal(await p.evaluate(()=>JSON.stringify([...drafts.values()][0])===originalDraft),true);
 assert.equal(await p.evaluate(()=>callSave()),false);assert.deepEqual(await p.evaluate(()=>({storageWrites,cloudAttempts})),{storageWrites:0,cloudAttempts:0});
 assert.match(await p.locator('#publish-status').innerText(),/Exit the locked-item preview/);
 assert.equal(await p.locator('[data-cosmetic-preview-clear]').count(),1);assert.match(await p.locator('.cosmetic-preview-banner').innerText(),/Preview only - not unlocked/);
 await p.locator('#champ').click();assert.equal(await p.locator('[data-cosmetic-title-preview]').innerText(),'Champion');await p.locator('#beta').click();assert.match(await p.locator('[data-cosmetic-badge-preview]').innerText(),/Beta/);
 await p.evaluate(()=>content.__cosmeticPreviewController.clear());assert.equal(await p.locator('article').getAttribute('class'),'overall-profile-card theme-blue');assert.equal(await p.locator('[data-cosmetic-title-preview]').innerText(),'Original title');assert.equal(await p.locator('[data-cosmetic-badge-preview]').innerText(),'Original badge');assert.equal(await p.evaluate(()=>draftSets),0);
});

test('actual hook bound before native hub move restores root and labels on hub close and account cleanup',async t=>{
 const p=await fixture(t);assert.equal(await p.evaluate(()=>studio.closest('dialog')),null);
 await p.evaluate(()=>{const dialog=document.createElement('dialog');dialog.className='profile-hub';document.body.append(dialog);dialog.append(studio);dialog.addEventListener('close',()=>content.append(studio));dialog.showModal();window.hub=dialog;});
 await p.locator('#gold').click();await p.locator('#champ').click();await p.locator('#beta').click();await p.evaluate(()=>hub.close());await p.waitForFunction(()=>!content.__cosmeticPreviewController.isActive());
 assert.equal(await p.locator('article').getAttribute('class'),'overall-profile-card theme-blue');assert.equal(await p.locator('article').evaluate(node=>node.style.getPropertyValue('--theme')),'blue');assert.equal(await p.locator('[data-cosmetic-title-preview]').innerText(),'Original title');assert.equal(await p.locator('[data-cosmetic-badge-preview]').innerText(),'Original badge');
 await p.evaluate(()=>content.__cosmeticPreviewController.preview({kind:'theme',id:'gold'}));await p.evaluate(()=>{content.__cosmeticPreviewController.dispose();content.__cosmeticPreviewController=null;activeAccount='b'.repeat(64);});
 assert.equal(await p.locator('article').getAttribute('class'),'overall-profile-card theme-blue');assert.deepEqual(await p.evaluate(()=>({draftSets,storageWrites,cloudAttempts,unchanged:JSON.stringify([...drafts.values()][0])===originalDraft})),{draftSets:0,storageWrites:0,cloudAttempts:0,unchanged:true});
});
