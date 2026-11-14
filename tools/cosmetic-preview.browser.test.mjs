import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const source=fs.readFileSync(new URL('./cosmetic-preview.mjs',import.meta.url),'utf8');
const css=fs.readFileSync(new URL('./cosmetic-preview.css',import.meta.url),'utf8');
let browser;
before(async()=>{browser=await chromium.launch({headless:true});});
after(async()=>{await browser?.close();});
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
