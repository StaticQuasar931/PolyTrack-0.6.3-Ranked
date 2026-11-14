import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const source=fs.readFileSync(new URL('./cosmetic-preview.mjs',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('./cosmetic-preview.css',import.meta.url),'utf8');
let browser,server,base;
const root=fileURLToPath(new URL('../',import.meta.url));
const evidence=process.env.COSMETIC_EVIDENCE_DIR||path.resolve(root,'../../2026-11-14/studio-preview-polish');
const patch=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const extract = name => {
  const match = patch.match(new RegExp(`  function ${name}\\([^\\n]*\\)\\{[\\s\\S]*?\\n  \\}`));
  assert.ok(match,`native function ${name}`);return match[0];
};
before(async()=>{browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}});
async function fixture(t,{busy=false,storageFailure=false,width=800}={}){
 const context=await browser.newContext({viewport:{width,height:800}});t.after(()=>context.close());const page=await context.newPage();await page.route('**/*',route=>route.abort());
 await page.setContent(`<style>body{margin:8px;font-family:serif;background:#17223b;color:white}button{min-height:32px}details{max-width:700px}.preview{min-height:60px}.theme-blue{color:#9bd4ff}.theme-gold{color:#ffda83}</style><details class="profile-customizer studio-original" data-account-id="alpha" open><summary>Studio</summary><form id="studio-form"><section class="profile-customizer-preview preview theme-blue" style="--tone:blue"><span data-cosmetic-title-preview>Original title</span><span data-cosmetic-badge-preview><b class="original-badge">Original badge</b></span><div class="profile-customizer-actions"><span role="status">Original status</span><button type="button" data-save-profile-cosmetics data-account-id="alpha" title="Original publish" ${busy?'disabled':''}>Publish</button><button type="button" data-discard-profile-cosmetics>Discard</button></div></section><div><button type="button" id="gold" class="locked-choice" data-cosmetic-choice data-cosmetic-kind="theme" data-cosmetic-value="gold" data-cosmetic-locked="true" aria-disabled="true" aria-pressed="false">Locked gold</button><button type="button" id="blue" data-cosmetic-choice data-cosmetic-kind="theme" data-cosmetic-value="blue">Blue</button><button type="button" id="bad" data-cosmetic-choice data-cosmetic-kind="theme" data-cosmetic-value="missing" data-cosmetic-locked="true">Invalid</button><button type="button" id="try-title" data-cosmetic-try data-cosmetic-kind="title" data-cosmetic-value="champ">Try title</button><button type="button" id="disabled-badge" data-cosmetic-choice data-cosmetic-kind="badge" data-cosmetic-value="beta" data-cosmetic-locked="true" disabled>Locked badge</button><button type="button" id="try-badge" data-cosmetic-try data-cosmetic-kind="badge" data-cosmetic-value="beta">Try badge</button><input id="edit" value="original"></div></form></details><button id="outside">Outside</button>`);
 await page.addStyleTag({content:css});
 await page.evaluate(async({source,storageFailure})=>{
  const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));const {bindCosmeticPreview}=await import(url);URL.revokeObjectURL(url);
  window.catalog={theme:[['blue','Blue',0],['gold','Gold',12]],title:[['champ','Champion','pb:25']],badge:[['beta','Beta','beta']]};
  window.draft={theme:'blue',title:'original',badge:'original'};window.published=Object.freeze({...draft});window.previewCalls=[];window.restoreCalls=[];window.publishCalls=0;window.storageTouches=0;window.escapeBubbled=0;
  if(storageFailure)for(const key of ['localStorage','sessionStorage'])Object.defineProperty(window,key,{configurable:true,get(){window.storageTouches++;throw Error('Storage disabled');}});
  const studio=document.querySelector('details');window.studio=studio;window.bind=()=>bindCosmeticPreview(studio,{catalog,
   savedDraft:window.draft,published:window.published,
   onPreview:option=>{previewCalls.push(option);const preview=studio.querySelector('.preview');preview.className='profile-customizer-preview preview theme-'+option.id;preview.style.setProperty('--tone',option.id);studio.classList.add('callback-preview');studio.querySelector('[data-cosmetic-title-preview]').textContent='Preview '+option.id;const badge=document.createElement('i');badge.textContent='Preview badge '+option.id;studio.querySelector('[data-cosmetic-badge-preview]').replaceChildren(badge);if(window.failPreview)throw Error('synthetic render failure');},
   onRestore:info=>{restoreCalls.push(info.reason);}});
  window.api=bind();
  document.addEventListener('click',event=>{const target=event.target.closest('button');if(!target)return;if(target.matches('[data-cosmetic-choice]'))draft={...draft,[target.dataset.cosmeticKind]:target.dataset.cosmeticValue};if(target.matches('[data-save-profile-cosmetics]')){publishCalls++;published={...draft};}});
  document.addEventListener('keydown',event=>{if(event.key==='Escape')escapeBubbled++;});
  window.readState=()=>({active:api.isActive(),canPublish:api.canPublish(),draft:{...draft},published:{...published},publishCalls,previewCalls:previewCalls.length,restoreCalls:[...restoreCalls],disabled:studio.querySelector('[data-save-profile-cosmetics]')?.disabled,title:studio.querySelector('[data-cosmetic-title-preview]')?.textContent,badge:studio.querySelector('[data-cosmetic-badge-preview]')?.innerHTML,classes:studio.className,previewClass:studio.querySelector('.preview')?.className,tone:studio.querySelector('.preview')?.style.getPropertyValue('--tone'),storageTouches,notice:studio.querySelector('.cosmetic-preview-banner')?.textContent||null});
 },{source,storageFailure});
 return page;
}

test('locked capture never reaches draft/publish bubbling and restores original classes/title/badges',async t=>{
 const p=await fixture(t);const initial=await p.evaluate(()=>readState());await p.locator('#gold').click({force:true});
 let state=await p.evaluate(()=>readState());assert.equal(state.active,true);assert.equal(state.canPublish,false);assert.equal(state.disabled,true);assert.deepEqual(state.draft,initial.draft);assert.deepEqual(state.published,initial.published);assert.match(state.notice,/Preview only - not unlocked/);
 assert.equal(await p.locator('#gold').getAttribute('data-cosmetic-locked'),'true');assert.equal(await p.locator('#gold').getAttribute('aria-pressed'),'false');
 await p.locator('[data-save-profile-cosmetics]').dispatchEvent('click');await p.locator('#studio-form').dispatchEvent('submit');assert.equal(await p.evaluate(()=>publishCalls),0);
 const guarded=await p.evaluate(()=>{const event=new Event('click',{cancelable:true});return {allowed:api.guardPublish(event),prevented:event.defaultPrevented};});assert.deepEqual(guarded,{allowed:false,prevented:true});
 await p.locator('[data-cosmetic-preview-clear]').click();state=await p.evaluate(()=>readState());assert.equal(state.active,false);assert.equal(state.disabled,false);assert.equal(state.canPublish,true);
 for(const key of ['draft','published','title','badge','classes','previewClass','tone'])assert.deepEqual(state[key],initial[key],key);
 assert.equal(await p.locator('[data-save-profile-cosmetics]').getAttribute('title'),'Original publish');
});

test('keyboard Enter previews and Escape clears without closing the studio',async t=>{
 const p=await fixture(t);await p.locator('#gold').focus();await p.keyboard.press('Enter');assert.equal(await p.evaluate(()=>api.isActive()),true);await p.keyboard.press('Escape');
 const state=await p.evaluate(()=>readState());assert.equal(state.active,false);assert.equal(state.title,'Original title');assert.deepEqual(state.restoreCalls,['escape']);assert.equal(await p.evaluate(()=>escapeBubbled),0);assert.equal(await p.locator('details').getAttribute('open'),'');
});

test('switches do not accumulate temporary title/badge classes or grant disabled badge entitlement',async t=>{
 const p=await fixture(t);await p.locator('#gold').click({force:true});await p.locator('#try-title').click();await p.locator('#try-badge').click();
 assert.equal(await p.locator('#disabled-badge').isDisabled(),true);assert.equal(await p.evaluate(()=>previewCalls.length),3);assert.ok(await p.evaluate(()=>previewCalls.every(option=>option.previewOnly&&option.unlocked===false&&Object.isFrozen(option))));
 await p.evaluate(()=>api.clear());const state=await p.evaluate(()=>readState());assert.equal(state.title,'Original title');assert.equal(state.badge,'<b class="original-badge">Original badge</b>');assert.equal(state.previewClass,'profile-customizer-preview preview theme-blue');assert.deepEqual(state.draft,state.published);
});

test('invalid and outside requests do not preview or mutate anything',async t=>{
 const p=await fixture(t);await p.locator('#bad').click();assert.equal(await p.evaluate(()=>previewCalls.length),0);assert.equal(await p.evaluate(()=>draft.theme),'blue');
 assert.equal(await p.evaluate(()=>api.preview({kind:'fake',id:'gold'})),false);await p.locator('#outside').click();assert.equal(await p.evaluate(()=>api.isActive()),false);
});

test('storage failure does not persist, break restoration or touch the saved/published design',async t=>{
 const p=await fixture(t,{storageFailure:true});await p.locator('#gold').click({force:true});await p.evaluate(()=>api.clear('exit'));const state=await p.evaluate(()=>readState());assert.equal(state.storageTouches,0);assert.deepEqual(state.draft,{theme:'blue',title:'original',badge:'original'});assert.deepEqual(state.published,state.draft);assert.equal(state.publishCalls,0);
});

test('previously disabled publish remains disabled, and editing exits before legitimate draft handler',async t=>{
 const busy=await fixture(t,{busy:true});await busy.locator('#gold').click({force:true});await busy.evaluate(()=>api.clear());assert.equal(await busy.locator('[data-save-profile-cosmetics]').isDisabled(),true);
 const p=await fixture(t);await p.locator('#gold').click({force:true});await p.locator('#blue').click();const state=await p.evaluate(()=>readState());assert.equal(state.active,false);assert.deepEqual(state.restoreCalls,['edit']);assert.equal(state.draft.theme,'blue');
});

test('account replacement and detach dispose old preview, publish guard and observers',async t=>{
 const p=await fixture(t);await p.locator('#gold').click({force:true});await p.evaluate(()=>{studio.dataset.accountId='beta';studio.querySelector('[data-save-profile-cosmetics]').dataset.accountId='beta';});
 await p.waitForFunction(()=>!api.isActive());let state=await p.evaluate(()=>readState());assert.equal(state.canPublish,false);assert.equal(state.title,'Original title');assert.equal(state.disabled,false);assert.deepEqual(state.restoreCalls,['account-change']);assert.equal(await p.evaluate(()=>api.preview({kind:'theme',id:'gold'})),false);
 await p.evaluate(()=>{api=bind();api.preview({kind:'theme',id:'gold'});studio.remove();});await p.waitForFunction(()=>!api.isActive());assert.equal(await p.evaluate(()=>api.canPublish()),false);assert.equal(await p.evaluate(()=>restoreCalls.at(-1)),'detached');
});

test('new publish controls are guarded and render failures restore before returning an error',async t=>{
 const p=await fixture(t);await p.locator('#gold').click({force:true});await p.evaluate(()=>{const old=studio.querySelector('[data-save-profile-cosmetics]');const fresh=old.cloneNode(true);fresh.disabled=false;old.replaceWith(fresh);});await p.waitForFunction(()=>studio.querySelector('[data-save-profile-cosmetics]').disabled);await p.locator('[data-save-profile-cosmetics]').dispatchEvent('click');assert.equal(await p.evaluate(()=>publishCalls),0);await p.evaluate(()=>api.clear());
 const result=await p.evaluate(()=>{failPreview=true;try{api.preview({kind:'theme',id:'gold'});}catch(error){return {error:error.message,state:readState()};}});assert.match(result.error,/render failure/);assert.equal(result.state.active,false);assert.equal(result.state.title,'Original title');assert.equal(result.state.publishCalls,0);
});

test('small-screen preview notice fits with a usable clear control and no fake car',async t=>{
 const p=await fixture(t,{width:320});await p.locator('#gold').click({force:true});const size=await p.locator('.cosmetic-preview-banner').evaluate(node=>({overflow:node.scrollWidth>node.clientWidth,buttonHeight:node.querySelector('button').getBoundingClientRect().height,text:node.textContent}));assert.equal(size.overflow,false);assert.ok(size.buttonHeight>=44);assert.match(size.text,/Preview only - not unlocked/);assert.equal(await p.locator('canvas,model-viewer').count(),0);
});

test('binding before dynamic hub move clears parent root classes/title/badges on native close',async t=>{
 const p=await fixture(t);
 await p.evaluate(async({source})=>{
  api.dispose();const url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));const {bindCosmeticPreview}=await import(url);URL.revokeObjectURL(url);
  const card=document.createElement('article');card.id='owner-card';card.className='published-root';card.style.setProperty('--design','blue');
  const title=document.createElement('span');title.dataset.rootTitle='';title.textContent='Published title';const badge=document.createElement('span');badge.dataset.rootBadge='';badge.textContent='Published badge';card.append(title,badge);studio.before(card);card.append(studio);
  window.modalRestores=[];window.rootOriginal={cls:card.className,style:card.getAttribute('style'),title:title.textContent,badge:badge.textContent};
  api=bindCosmeticPreview(studio,{catalog,onPreview:option=>{card.className='locked-root-preview';card.style.setProperty('--design',option.id);title.textContent='Locked title';badge.textContent='Locked badge';},onRestore:info=>{modalRestores.push(info.reason);card.className=rootOriginal.cls;card.setAttribute('style',rootOriginal.style);title.textContent=rootOriginal.title;badge.textContent=rootOriginal.badge;}});
  window.boundBeforeModal=studio.closest('dialog')===null;
  const dialog=document.createElement('dialog');dialog.className='profile-hub';document.body.append(dialog);dialog.append(studio);dialog.addEventListener('close',()=>card.append(studio));dialog.showModal();window.hub=dialog;
 },{source});
 assert.equal(await p.evaluate(()=>boundBeforeModal),true);await p.locator('#gold').click({force:true});assert.equal(await p.locator('#owner-card').getAttribute('class'),'locked-root-preview');
 await p.locator('[data-save-profile-cosmetics]').dispatchEvent('click');assert.equal(await p.evaluate(()=>publishCalls),0);
 await p.evaluate(()=>hub.close());await p.waitForFunction(()=>!api.isActive());
 const result=await p.evaluate(()=>{const card=document.querySelector('#owner-card');return {cls:card.className,style:card.getAttribute('style'),title:card.querySelector('[data-root-title]').textContent,badge:card.querySelector('[data-root-badge]').textContent,restores:modalRestores,disabled:studio.querySelector('[data-save-profile-cosmetics]').disabled,draft,published,notice:!!studio.querySelector('.cosmetic-preview-banner')};});
 assert.equal(result.cls,'published-root');assert.equal(result.style,'--design: blue;');assert.equal(result.title,'Published title');assert.equal(result.badge,'Published badge');assert.deepEqual(result.restores,['modal-close']);assert.equal(result.disabled,false);assert.equal(result.notice,false);assert.deepEqual(result.draft,result.published);
});

test('native dialog cancel restores preview even when the modal remains open',async t=>{
 const p=await fixture(t);await p.evaluate(()=>{const dialog=document.createElement('dialog');dialog.className='profile-hub';document.body.append(dialog);dialog.append(studio);dialog.showModal();window.hub=dialog;});
 await p.locator('#gold').click({force:true});await p.evaluate(()=>hub.dispatchEvent(new Event('cancel',{cancelable:true})));const state=await p.evaluate(()=>readState());assert.equal(state.active,false);assert.equal(state.title,'Original title');assert.deepEqual(state.restoreCalls,['modal-cancel']);assert.equal(state.disabled,false);assert.equal(await p.evaluate(()=>hub.open),true);
});

test('overflowed max-height preview keeps the first-child warning and exit control visible at every scroll position',async t=>{
 const p=await fixture(t,{width:1366});await p.evaluate(()=>{
  const pane=studio.querySelector('.profile-customizer-preview');pane.style.maxHeight='190px';pane.style.overflowY='auto';pane.style.width='340px';pane.style.padding='0';
  const tall=document.createElement('div');tall.style.height='900px';tall.textContent='Actual scrollable showcase area';pane.insertBefore(tall,pane.querySelector('.profile-customizer-actions'));pane.scrollTop=400;
 });
 await p.locator('#gold').click({force:true});
 for(const scroll of [0,250,10000]){
  const result=await p.evaluate(scroll=>{
   const pane=studio.querySelector('.profile-customizer-preview');pane.scrollTop=scroll;
   const banner=pane.querySelector('.cosmetic-preview-banner'),button=banner.querySelector('button'),pr=pane.getBoundingClientRect(),br=banner.getBoundingClientRect(),cr=button.getBoundingClientRect();
   return {first:pane.firstElementChild===banner,text:banner.textContent,sticky:getComputedStyle(banner).position,top:getComputedStyle(banner).top,z:getComputedStyle(banner).zIndex,overflow:pane.scrollHeight>pane.clientHeight,bannerInside:br.top>=pr.top-1&&br.bottom<=pr.bottom+1,buttonInside:cr.top>=pr.top-1&&cr.bottom<=pr.bottom+1,buttonOnTop:document.elementFromPoint(cr.x+cr.width/2,cr.y+cr.height/2)===button};
  },scroll);
  assert.equal(result.first,true);assert.match(result.text,/Preview only - not unlocked/);assert.equal(result.sticky,'sticky');assert.equal(result.top,'0px');assert.equal(result.z,'5');assert.equal(result.overflow,true);assert.ok(result.bannerInside&&result.buttonInside&&result.buttonOnTop,JSON.stringify({scroll,result}));
 }
 const state=await p.evaluate(()=>readState());assert.equal(state.disabled,true);assert.equal(state.canPublish,false);assert.equal(state.publishCalls,0);assert.deepEqual(state.draft,state.published);
});

test('explicit exit and Escape return banner focus to last locked choice only',async t=>{
 const p=await fixture(t);await p.locator('#gold').click({force:true});await p.locator('[data-cosmetic-preview-clear]').click();assert.equal(await p.locator('#gold').evaluate(node=>node===document.activeElement),true);
 await p.locator('#try-title').click();await p.locator('[data-cosmetic-preview-clear]').focus();await p.keyboard.press('Escape');assert.equal(await p.locator('#try-title').evaluate(node=>node===document.activeElement),true);
 for(const reason of ['modal-close','modal-cancel','edit','account-change','dispose']){
  await p.evaluate(()=>api.preview({kind:'theme',id:'gold'}));await p.locator('[data-cosmetic-preview-clear]').focus();
  const refocused=await p.evaluate(reason=>{api.clear(reason);return document.activeElement===document.getElementById('gold');},reason);assert.equal(refocused,false,reason);
 }
 await p.evaluate(()=>api.preview({kind:'theme',id:'gold'}));await p.locator('#edit').focus();await p.keyboard.press('Escape');assert.equal(await p.locator('#edit').evaluate(node=>node===document.activeElement),true);
});


async function nativeArtSetup(page) {
  const catalog = patch.match(/const PROFILE_COSMETIC_OPTIONS=(\{[\s\S]*?\n  \});/)[0];
  const defaults = patch.match(/const COSMETIC_DEFAULTS=Object.freeze\((\{[^\n]+\})\);/)[0];
  const choiceStart = patch.indexOf("      const cosmeticChoice=event.target.closest?.('[data-cosmetic-choice]');");
  const choiceEnd = patch.indexOf("      const categoryInfo=",choiceStart);
  const tabStart = patch.indexOf("      const studioTab=event.target.closest?.('[data-studio-tab]');",choiceEnd);
  const tabEnd = patch.indexOf('      const podiumChoice=',tabStart);
  const saveStart = patch.indexOf("      const cosmeticSave=event.target.closest?.('[data-save-profile-cosmetics]');",tabEnd);
  const saveEnd = patch.indexOf('      const trackTarget=',saveStart);
  const changeStart = patch.indexOf("      if(event.target?.matches?.('[data-cosmetic-favorite]')){");
  const changeEnd = patch.indexOf('\n    });',changeStart);
  assert.ok(choiceStart >= 0 && choiceEnd > choiceStart && saveEnd > saveStart);
  await page.addScriptTag({content:`
    ${catalog}; ${defaults};
    Object.assign(window,{
      cleanUserId:value=>String(value||''),profileCosmeticDrafts:new Map(),profileCosmeticEntries:new Map(),
      sanitizeProfileCosmetics:value=>({...COSMETIC_DEFAULTS,...value}),cosmeticsForEntry:entry=>({...COSMETIC_DEFAULTS,...entry.profileCosmetics}),
      localExtraTrackCount:()=>0,cosmeticTitleText:()=> 'Contender',profileBadgeMarkup:()=>'',
      escapeHtml:value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
      trackInfo:id=>({id,name:'Summer 1'}),safeDisplayName:value=>value,
      __pt062NormalizeStyle:value=>value||'',__pt062GetRememberedStyle:()=>'',normalizeCarColorId:value=>value,
      overallFooterLayoutCss:()=>'',TRACK_CATALOG:new Map([['summer1',{id:'summer1',name:'Summer 1',type:'official'}]]),
      saveRankedProfileCosmetics:()=>{window.published=(window.published||0)+1;}
    });
    ${extract('cosmeticUnlocked')}
    ${extract('cosmeticUnlockReason')}
    ${extract('carModelPreview')}
    ${extract('applyProfileCosmetics')}
    ${extract('ensureStyles')}
    ${extract('profileCustomizerMarkup')}
    ${extract('setupRacerStudio')}
    ensureStyles();
    const fixtureEntry=window.publicFixture;
    document.querySelector('#content').innerHTML=profileCustomizerMarkup(fixtureEntry);
    setupRacerStudio(document.querySelector('#content'));
    const panel=document.querySelector('#overallLeaderboardPanel');
    panel.addEventListener('click',event=>{${patch.slice(choiceStart,choiceEnd)}${patch.slice(tabStart,tabEnd)}${patch.slice(saveStart,saveEnd)}});
    panel.addEventListener('change',event=>{${patch.slice(changeStart,changeEnd)}});
    window.nativeCatalog=PROFILE_COSMETIC_OPTIONS;window.nativeEntry=fixtureEntry;
    window.originalStudio=document.querySelector('.profile-customizer');
  `});
  await page.addStyleTag({url:base + '/tools/racer-studio-polish.css'});
  await page.evaluate(async () => {
    const {mountProfileAchievements} = await import('/tools/profile-achievement-bridge.mjs?channel=studio');
    const content = document.querySelector('#content');
    window.rewardCalls = [];
    cleanup = mountProfileAchievements(content,{accountId:nativeEntry.userId,confirmed:nativeEntry,local:{},cosmetics:nativeCatalog,revision:'native-hub',onTryCosmetic:value => rewardCalls.push(value),onNavigate:value => rewardCalls.push(value)});
  });
}

async function nativePublicFixture(t,{width=390,height=844}={}){
 if(!server){
  server=http.createServer((req,res)=>{
   const name=new URL(req.url,'http://localhost').pathname;
   if(name==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Saved public Studio fixture, offline audit</title><style>@font-face{font-family:ForcedSquare;src:url(/forced_square.woff2)}body{margin:0;background:#172b55;color:white;font-family:ForcedSquare,sans-serif}</style><div id="overallLeaderboardPanel" style="display:flex"><div id="overallProfilePopup" style="display:flex"><div class="overall-profile-card"><main id="content"></main></div></div></div></html>');return;}
   const allowed=/^\/tools\/(cosmetic-preview|profile-achievement-bridge|achievement-journal|achievement-model)\.mjs$/.test(name)||['/tools/cosmetic-preview.css','/tools/achievement-journal.css','/tools/studio-art-polish.css','/tools/racer-studio-polish.css','/forced_square.woff2','/images/car_thumbnail_placeholder.png'].includes(name);
   if(!allowed){res.writeHead(404).end();return;}
   try{res.setHeader('Content-Type',name.endsWith('.css')?'text/css':name.endsWith('.woff2')?'font/woff2':name.endsWith('.png')?'image/png':'text/javascript');res.end(fs.readFileSync(path.join(root,name.slice(1))));}catch{res.writeHead(404).end();}
  });server.keepAliveTimeout=500;await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 }
 const snapshotDirectory=JSON.parse(fs.readFileSync(path.join(root,'snapshot-current.json'),'utf8')).currentdir;
 assert.match(snapshotDirectory,/^public-snapshots[1-9]\d*$/);
 const index=JSON.parse(fs.readFileSync(path.join(root,snapshotDirectory,'bootstrap-fast.json'),'utf8'));
 const [hash]=index.files['overall-pages/1.json'];assert.match(hash,/^[a-f0-9]{64}$/);
 const bytes=fs.readFileSync(path.join(root,snapshotDirectory,hash+'.bin'));assert.equal(createHash('sha256').update(bytes).digest('hex'),hash);
 const saved=JSON.parse(gunzipSync(bytes.map(value=>value^0xa7)).toString('utf8'));
 const row=saved.entries.find(row=>row.trackWins===0)||saved.entries[0];assert.ok(row);
 const publicFixture={...row,name:'PUBLIC FIXTURE'};
 const context=await browser.newContext({viewport:{width,height},reducedMotion:'reduce'});t.after(()=>context.close());const page=await context.newPage();
 let external=0;await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():(external++,route.abort()));await page.goto(base);
 await page.evaluate(row=>{window.publicFixture=row;},publicFixture);await nativeArtSetup(page);
 await page.addStyleTag({url:base+'/tools/cosmetic-preview.css'});
 await page.evaluate(async()=>{
  const {bindCosmeticPreview}=await import('/tools/cosmetic-preview.mjs');
  window.studio=document.querySelector('.profile-customizer');const card=studio.closest('.overall-profile-card'),id=nativeEntry.userId;
  const draft=()=>({...profileCosmeticDrafts.get(id)});window.originalDraft=JSON.stringify(draft());window.nativePublishCalls=0;
  const restore=()=>applyProfileCosmetics(card,draft());restore();
  window.nativePreview=bindCosmeticPreview(studio,{catalog:nativeCatalog,onPreview:option=>applyProfileCosmetics(card,{...draft(),[option.kind]:option.id}),onRestore:restore});
  // Mirror setupCosmeticPreview: keyboard preview is enabled, ownership stays locked.
  for(const button of studio.querySelectorAll('[data-cosmetic-locked="true"]')){button.removeAttribute('aria-disabled');button.dataset.cosmeticPreviewable='true';}
  window.readNative=()=>({draft:JSON.stringify(draft()),active:nativePreview.isActive(),publishAllowed:nativePreview.canPublish(),publishCalls:window.published||0});
  cleanup.open('studio');
 });
 await page.locator('link[data-studio-art-polish-css]').evaluate(link=>link.sheet?undefined:new Promise(resolve=>link.addEventListener('load',resolve,{once:true})));
 await page.evaluate(()=>document.fonts.ready);fs.mkdirSync(evidence,{recursive:true});
 page.assertNoExternal=()=>assert.equal(external,0,'no external/Firebase calls');return page;
}

test('saved public native phone warning remains visible when car pane is offscreen; Exit/Escape still restore safely',{timeout:60000},async t=>{
 const page=await nativePublicFixture(t);await page.locator('[data-studio-tab="name"]').click();
 const target=page.locator('[data-cosmetic-kind="emblem3"][data-cosmetic-value="laurel"]');assert.equal(await target.getAttribute('data-cosmetic-locked'),'true');
 await target.click();
 const read=()=>page.evaluate(()=>{
  const banner=document.querySelector('.cosmetic-preview-banner'),panel=document.querySelector('.ph-studio-panel'),preview=document.querySelector('.profile-customizer-preview');
  const b=banner.getBoundingClientRect(),p=panel.getBoundingClientRect(),v=preview.getBoundingClientRect(),c=banner.querySelector('button').getBoundingClientRect();
  return {parent:banner.parentElement===panel,inside:b.top>=p.top-1&&b.bottom<=Math.min(p.bottom,innerHeight)+1,buttonInside:c.top>=p.top-1&&c.bottom<=innerHeight,carOffscreen:v.bottom<p.top,topmost:banner.contains(document.elementFromPoint(c.x+c.width/2,c.y+c.height/2)),state:readNative()};
 });
 let current=await read();assert.ok(current.parent&&current.inside&&current.buttonInside&&current.topmost,JSON.stringify(current));assert.equal(current.carOffscreen,true);
 assert.equal(current.state.draft,await page.evaluate(()=>originalDraft));assert.equal(current.state.publishAllowed,false);
 await page.locator('[data-save-profile-cosmetics]').dispatchEvent('click');assert.equal(await page.evaluate(()=>window.published||0),0);
 await page.screenshot({path:path.join(evidence,'native-phone-warning-visible-390.png')});
 await page.locator('[data-cosmetic-preview-clear]').click();assert.equal(await target.evaluate(node=>node===document.activeElement),true);assert.equal(await page.evaluate(()=>readNative().active),false);
 await target.click();await page.locator('[data-cosmetic-preview-clear]').focus();await page.keyboard.press('Escape');
 assert.equal(await page.locator('dialog').evaluate(node=>node.open),true);assert.equal(await target.evaluate(node=>node===document.activeElement),true);
 assert.equal(await page.evaluate(()=>readNative().draft),await page.evaluate(()=>originalDraft));
 await target.click();await page.setViewportSize({width:1366,height:768});
 await page.waitForFunction(()=>document.querySelector('.cosmetic-preview-banner')?.parentElement===document.querySelector('.profile-customizer-preview'));
 await page.setViewportSize({width:390,height:844});await page.waitForFunction(()=>document.querySelector('.cosmetic-preview-banner')?.parentElement===document.querySelector('.ph-studio-panel'));
 current=await read();assert.ok(current.inside&&current.topmost);page.assertNoExternal();
});

test('native warning and category tabs never overlap on phone or landscape, and exit leaves no header gap',{timeout:60000},async t=>{
 for(const [name,width,height]of[['phone',390,844],['landscape',844,390]]){
  const page=await nativePublicFixture(t,{width,height});
  // The real native home stylesheet has this higher-specificity mobile reset.
  await page.addStyleTag({content:'@media(max-width:850px),(max-height:500px){#overallProfilePopup .studio-tabs{position:static}}'});
  await page.locator('[data-studio-tab="name"]').click();
  await page.locator('[data-cosmetic-kind="emblem3"][data-cosmetic-value="laurel"]').click();
  const read=()=>page.evaluate(()=>{
   const panel=document.querySelector('.ph-studio-panel'),banner=document.querySelector('.cosmetic-preview-banner'),tabs=document.querySelector('.studio-tabs');
   const rect=node=>{const r=node.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};};
   return {banner:rect(banner),panel:rect(panel),tabs:rect(tabs),position:getComputedStyle(tabs).position,buttons:[...tabs.querySelectorAll('button')].map(rect),height:innerHeight};
  });
  for(const scroll of['current','bottom']){
   if(scroll==='bottom')await page.evaluate(()=>{const panel=document.querySelector('.ph-studio-panel');panel.scrollTop=panel.scrollHeight;});
   const layout=await read();
   assert.equal(layout.position,'sticky');
   assert.ok(layout.banner.top>=layout.panel.top-1&&layout.banner.bottom<=layout.height,JSON.stringify(layout));
   assert.ok(layout.tabs.top>=layout.banner.bottom,JSON.stringify(layout));
   assert.ok(layout.buttons.length>=4&&layout.buttons.every(button=>button.top>=layout.banner.bottom&&button.bottom<=layout.height),JSON.stringify(layout));
  }
  await page.screenshot({path:path.join(evidence,`native-warning-tabs-${name}-${width}.png`)});
  await page.locator('[data-cosmetic-preview-clear]').click();
  const cleared=await page.evaluate(()=>({banner:!!document.querySelector('.cosmetic-preview-banner'),offset:document.querySelector('.ph-studio-panel').style.getPropertyValue('--cosmetic-preview-header-height'),top:getComputedStyle(document.querySelector('.studio-tabs')).top,state:readNative()}));
  assert.equal(cleared.banner,false);assert.equal(cleared.offset,'');assert.equal(cleared.top,'-1px');assert.equal(cleared.state.active,false);
  assert.equal(cleared.state.draft,await page.evaluate(()=>originalDraft));page.assertNoExternal();
 }
});

test('native backdrop has one motif in a reserved gutter, no legacy gradient over the name on phone or landscape',{timeout:20000},async t=>{
 for(const [name,width,height]of[['phone',390,844],['landscape',844,390]]){
  const page=await nativePublicFixture(t,{width,height});await page.evaluate(()=>nativePreview.preview({kind:'emblemBackdrop',id:'shield'}));
  await page.locator('.profile-customizer-preview').scrollIntoViewIfNeeded();
  const layout=await page.locator('.profile-preview-stage>span:not(.overall-car-model)').evaluate(node=>{const style=getComputedStyle(node),art=getComputedStyle(node,'::before'),range=document.createRange();range.selectNodeContents(node.querySelector('b'));const text=range.getBoundingClientRect(),box=node.getBoundingClientRect();return {background:style.backgroundImage,padding:parseFloat(style.paddingInlineEnd),textRight:text.right,artLeft:box.left+parseFloat(art.left),artWidth:parseFloat(art.width)};});
  assert.equal(layout.background,'none');assert.ok(layout.padding>=48);assert.ok(layout.textRight<=layout.artLeft+1,JSON.stringify(layout));
  await page.screenshot({path:path.join(evidence,`native-clean-backdrop-${name}.png`)});page.assertNoExternal();
 }
});

test('native existing backdrop/detail swatches have distinct real shapes without clipping name text or granting choices',{timeout:60000},async t=>{
 for(const [name,width,height]of[['laptop',1366,768],['phone',390,844]]){
  const page=await nativePublicFixture(t,{width,height});await page.locator('[data-studio-tab="name"]').click();
  const shapes=await page.locator('.kind-emblemBackdrop [data-cosmetic-choice]:not(.cosmetic-emblem-backdrop-none) .profile-cosmetic-preview i').evaluateAll(nodes=>nodes.map(node=>{const r=node.getBoundingClientRect(),s=getComputedStyle(node);return {width:r.width,height:r.height,mask:s.maskImage,clip:s.clipPath};}));
  assert.equal(shapes.length,3);assert.equal(new Set(shapes.map(shape=>shape.mask)).size,3);assert.ok(shapes.every(shape=>shape.width===46&&shape.height===46&&shape.mask.includes('data:image/svg+xml')&&shape.clip==='none'));
  const details=await page.locator('.kind-emblem3 [data-cosmetic-choice]:not(.cosmetic-emblem3-none) .profile-cosmetic-preview i').evaluateAll(nodes=>nodes.map(node=>getComputedStyle(node).maskImage));
  assert.equal(details.length,3);assert.equal(new Set(details).size,3);
  await page.locator('.kind-emblemBackdrop').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,`native-emblem-controls-${name}.png`)});
  const carBefore=await page.locator('.profile-preview-stage>.overall-car-model').evaluate(node=>{const s=getComputedStyle(node);return {clip:s.clipPath,radius:s.borderRadius,padding:s.padding,border:s.borderTopWidth};});
  await page.evaluate(()=>nativePreview.preview({kind:'emblemBackdrop',id:'hex'}));
  const layout=await page.locator('.profile-preview-stage>span:not(.overall-car-model)').evaluate(node=>{const art=getComputedStyle(node,'::before');return {clip:getComputedStyle(node).clipPath,border:getComputedStyle(node).borderTopWidth,mask:art.maskImage,maskSize:art.maskSize,maskRepeat:art.maskRepeat,width:art.width,height:art.height,background:art.background,transform:art.transform};});
  assert.equal(layout.clip,'none');assert.equal(layout.border,'0px');assert.ok(layout.mask.includes('data:image/svg+xml'));
  assert.ok(parseFloat(layout.width)>=40&&parseFloat(layout.height)>=40,'live emblem mask fits the label without clipping');
  const carAfter=await page.locator('.profile-preview-stage>.overall-car-model').evaluate(node=>{const s=getComputedStyle(node);return {clip:s.clipPath,radius:s.borderRadius,padding:s.padding,border:s.borderTopWidth};});
  assert.deepEqual(carAfter,carBefore,'emblem preview must not change native thumbnail geometry');
  fs.writeFileSync(path.join(evidence,`native-art-layout-${name}.json`),JSON.stringify({layout,carBefore,carAfter},null,2));
  await page.locator('.profile-customizer-preview').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,`native-backdrop-preview-${name}.png`)});
  await page.evaluate(()=>nativePreview.preview({kind:'emblem3',id:'wings'}));
  assert.equal(await page.evaluate(()=>readNative().draft),await page.evaluate(()=>originalDraft));assert.equal(await page.evaluate(()=>readNative().publishCalls),0);
  await page.evaluate(()=>nativePreview.clear());assert.equal(await page.locator('.cosmetic-preview-banner').count(),0);assert.equal(await page.evaluate(()=>readNative().publishAllowed),true);
  assert.equal(await page.evaluate(()=>document.querySelector('.ph-studio-panel').scrollWidth<=document.querySelector('.ph-studio-panel').clientWidth),true);
  page.assertNoExternal();
 }
});
