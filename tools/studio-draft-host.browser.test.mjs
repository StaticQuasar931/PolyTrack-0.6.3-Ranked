import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
let browser,server,base;
before(async()=>{
 server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><details open><summary>Studio</summary><div class="profile-customizer-actions"></div><button id="choice" aria-pressed="false">Choice</button><input id="favorite"></details>');return;}
  if(!['/tools/studio-draft-host.mjs','/tools/studio-edit-history.mjs'].includes(pathname)){res.writeHead(404).end();return;}
  res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(new URL('..'+pathname,import.meta.url)));
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true});
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));});
async function fixture(t,{preview=false}={}){
 const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();
 await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort());await page.goto(base);
 await page.evaluate(async preview=>{
  const {bindStudioDraftHistory}=await import('/tools/studio-draft-host.mjs');window.bindHistory=bindStudioDraftHistory;
  window.studio=document.querySelector('details');window.account='alpha';window.draft={theme:'blue'};window.saved={theme:'blue'};window.reads=0;window.restores=0;window.previewUndos=0;window.echoReads=0;
  window.bind=()=>bindHistory(studio,{accountId:'alpha',getAccountId:()=>account,getDraft:()=>{reads++;return draft;},getSavedDraft:()=>saved,
   onRestore:value=>{restores++;draft={...value};document.querySelector('#choice').setAttribute('aria-pressed',String(restores%2===1));
    queueMicrotask(()=>{const before=reads;api.record();echoReads+=reads-before;});},
   onUndoPreview:preview?()=>{previewUndos++;return true;}:undefined});
  window.api=bind();window.edit=value=>{draft={theme:value};document.querySelector('#favorite').dispatchEvent(new Event('input',{bubbles:true}));};
  for(const key of ['localStorage','sessionStorage','indexedDB'])Object.defineProperty(window,key,{configurable:true,get(){throw Error('Unexpected storage I/O');}});
  window.fetch=()=>{throw Error('Unexpected network I/O');};
 },preview);return page;
}

test('unsaved edit -> undo restores baseline; restore microtasks and observers never auto-record',async t=>{
 const p=await fixture(t);assert.equal(await p.evaluate(()=>api.isDirty()),false);
 await p.evaluate(()=>edit('gold'));assert.equal(await p.evaluate(()=>api.isDirty()),true);
 assert.equal(await p.locator('.studio-dirty-marker').isVisible(),true);
 assert.equal(await p.evaluate(()=>api.undo()),true);
 assert.deepEqual(await p.evaluate(()=>({draft,dirty:api.isDirty(),restores,echoReads})),{draft:{theme:'blue'},dirty:false,restores:1,echoReads:0});
 assert.equal(await p.evaluate(()=>api.undo()),false);assert.equal(await p.locator('.studio-undo').isDisabled(),true);
});

test('older confirmed save never cleans a newer draft; exact saved snapshot becomes clean on undo',async t=>{
 const p=await fixture(t);await p.evaluate(()=>edit('gold'));await p.evaluate(()=>edit('red'));
 assert.equal(await p.evaluate(()=>api.markSaved({theme:'gold'})),true);assert.equal(await p.evaluate(()=>api.isDirty()),true);
 await p.evaluate(()=>api.undo());assert.deepEqual(await p.evaluate(()=>draft),{theme:'gold'});assert.equal(await p.evaluate(()=>api.isDirty()),false);
 assert.equal(await p.evaluate(()=>api.markSaved()),false);
});

test('queued event/observer callbacks cannot read drafts or restore after dispose',async t=>{
 const p=await fixture(t);const before=await p.evaluate(()=>{
  edit('gold');document.querySelector('#choice').setAttribute('aria-pressed','true');const count=reads;api.dispose();return count;
 });
 assert.equal(await p.evaluate(()=>reads),before);assert.equal(await p.locator('.studio-dirty-marker,.studio-undo').count(),0);
 assert.equal(await p.evaluate(()=>studio.classList.contains('studio-has-unsaved-changes')),false);
 assert.deepEqual(await p.evaluate(()=>({record:api.record(),undo:api.undo(),save:api.markSaved({}),dirty:api.isDirty(),restores})),{record:false,undo:false,save:false,dirty:false,restores:0});
});

test('account changes reject all callbacks including preview undo and queued draft reads',async t=>{
 const p=await fixture(t,{preview:true});const before=await p.evaluate(()=>{edit('gold');account='beta';const count=reads;document.querySelector('.studio-undo').click();return count;});
 assert.equal(await p.evaluate(()=>reads),before);assert.equal(await p.evaluate(()=>previewUndos),0);
 assert.equal(await p.evaluate(()=>api.markSaved({theme:'gold'})),false);assert.equal(await p.evaluate(()=>api.undo()),false);
 const result=await p.evaluate(()=>{let accessed=false;try{bindHistory(studio,{accountId:'alpha',getAccountId:()=>account,getDraft:()=>{accessed=true;return {};},getSavedDraft:()=>{accessed=true;return {};},onRestore(){}});}catch(error){return {message:error.message,accessed};}});
 assert.match(result.message,/Current account/);assert.equal(result.accessed,false);
});

test('preview-only undo remains clickable with clean draft and rebind removes old controls',async t=>{
 const p=await fixture(t,{preview:true});assert.equal(await p.locator('.studio-undo').isDisabled(),false);
 await p.locator('.studio-undo').click();assert.equal(await p.evaluate(()=>previewUndos),1);assert.equal(await p.evaluate(()=>restores),0);assert.equal(await p.evaluate(()=>api.isDirty()),false);
 const before=await p.evaluate(()=>{edit('gold');api=bind();return reads;});assert.equal(await p.evaluate(()=>reads),before);
 assert.equal(await p.locator('.studio-undo').count(),1);assert.equal(await p.locator('.studio-dirty-marker').count(),1);
});

test('aria-pressed-only edits are recorded, initial unsaved drafts are undoable, and click/change are captured',async t=>{
 const p=await fixture(t);
 await p.evaluate(()=>{draft={theme:'gold'};document.querySelector('#choice').setAttribute('aria-pressed','true');});
 assert.equal(await p.evaluate(()=>api.isDirty()),true);await p.evaluate(()=>api.undo());assert.deepEqual(await p.evaluate(()=>draft),{theme:'blue'});
 await p.evaluate(()=>{draft={theme:'red'};studio.dispatchEvent(new Event('change',{bubbles:true}));});
 await p.evaluate(()=>{draft={theme:'green'};studio.dispatchEvent(new Event('click',{bubbles:true}));});
 await p.evaluate(()=>api.undo());assert.deepEqual(await p.evaluate(()=>draft),{theme:'red'});
 await p.evaluate(()=>{draft={theme:'pending'};api=bind();});assert.equal(await p.evaluate(()=>api.isDirty()),true);
 await p.evaluate(()=>api.undo());assert.deepEqual(await p.evaluate(()=>draft),{theme:'blue'});
});
