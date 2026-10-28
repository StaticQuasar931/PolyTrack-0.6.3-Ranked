import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'../tools/verifier/node_modules/playwright');
const client=await fs.readFile(new URL('./client.mjs',import.meta.url),'utf8');
const patch=await fs.readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=client.indexOf('  async function playEvent(){');
const launch=client.slice(start,client.indexOf('  const ownReceipts=',start));
const nativeStart=patch.indexOf('  window.__pt062PrepareEventRace=function');
const native=patch.slice(nativeStart,patch.indexOf('  const eventCloudRequests=',nativeStart));
async function setup(page,{missingView=false,disabled=false,disposePanel=false,deferHandoff=false,kind='weekly'}={}){
 await page.route('**/*',route=>route.abort());
 await page.setContent('<div class="track-info-ui"><div class="side-panel"><button class="play">Play</button></div></div>');
 await page.evaluate(({launch,native,options})=>{
  window.__pt062NativeEventGhostVersion=1;window.__pt062NativeEventLaunchVersion=1;
  window.caseState=new Function('options',`
   let pendingEventLaunch=null,launching=false,nativePlayPermit=false,accountId='racer',at=Date.now();
   Date.now=()=>at;
   const messages=[],errors=[],policies=[],handoffs=[],pendingGhosts=new Map(),selectedGhosts=new Map();
   let session=Object.freeze({periodId:options.kind,accountId,trackId:'track',endsAt:at+60000});
   const sessions={current:()=>session&&at<session.endsAt?session:null},now=()=>at,activeRankedAccountId=()=>accountId;
   const getOwnReplay=()=>null,raceGhosts=()=>({ownGhost:null,opponents:[]});
   const root=document.querySelector('.track-info-ui');root.__pt062EventWatch={version:1,trackId:'track'};
   const nativeView=options.missingView?null:{root,periodId:session.periodId,accountId};
   const message=value=>messages.push(value);let nativeCalls=0,normalCalls=0,nativeDispatches=0;
   ${native}
   const bridge={accountId:activeRankedAccountId,startEventRace};
   const play=root.querySelector('button.play');play.disabled=options.disabled;
   play.onclick=()=>{
    nativeDispatches++;
    // Native Play disposes TrackInfo before track loading and the start-game handoff.
    if(options.disposePanel)root.remove();
    const handoff=(trackId='track',multiplayer=null)=>{
     try{const policy=window.__pt062PrepareEventRace(trackId,multiplayer);if(policy){nativeCalls++;policies.push(policy);}else normalCalls++;}
     catch(error){errors.push(error.message);}
    };
    if(options.deferHandoff)handoffs.push(handoff);else setTimeout(handoff,0);
   };
   document.addEventListener('click',e=>{if(e.target===play&&!nativePlayPermit){e.preventDefault();e.stopImmediatePropagation();void playEvent();}},true);
   ${launch}
   return {
    calls:()=>nativeCalls,normalCalls:()=>normalCalls,dispatches:()=>nativeDispatches,pending:()=>!!pendingEventLaunch,
    messages:()=>messages,errors:()=>errors,policies:()=>policies,launching:()=>launching,queued:()=>handoffs.length,
    release:(...args)=>{const handoff=handoffs.shift();if(!handoff)throw Error('No native handoff queued');handoff(...args);},
    mutate:change=>{
     if(change==='cancel')session=null;
     else if(change==='racer')accountId='other-racer';
     else if(change==='expiry')at=session.endsAt;
     else if(change==='session')session=Object.freeze({...session});
     else if(change==='detach')root.remove();
     else if(change==='replace-panel')root.replaceWith(root.cloneNode(true));
     else if(change==='disabled')play.disabled=true;
     else throw Error('Unknown fixture mutation: '+change);
    },play
   };
  `)(options);
 },{launch,native,options:{missingView,disabled,disposePanel,deferHandoff,kind}});
}
async function fixture(t,options){
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
 t.after(()=>browser.close());const page=await browser.newPage();await setup(page,options);return page;
}
for(const mode of ['programmatic','pointer'])test('event Play starts once after '+mode+' click without poisoning later launches',async t=>{
 const page=await fixture(t);
 for(let i=1;i<=2;i++){
  if(mode==='pointer')await page.locator('button.play').click();else await page.evaluate(()=>caseState.play.click());
  await page.waitForFunction(count=>caseState.calls()===count,i,{timeout:1500});
  assert.equal(await page.evaluate(()=>caseState.pending()),false);
 }
});
test('event Play does not depend on the leaderboard overlay finishing loading',async t=>{
 const page=await fixture(t,{missingView:true});
 await page.locator('button.play').click();await page.waitForFunction(()=>caseState.calls()===1,null,{timeout:1500});
});
for(const kind of ['weekly','daily'])test(kind+' event Play survives disposed panel and delayed native handoff',async t=>{
 const page=await fixture(t,{kind,disposePanel:true,deferHandoff:true});
 await page.locator('button.play').click();
 await page.waitForFunction(()=>caseState.queued()===1&&!caseState.launching(),null,{timeout:1500});
 assert.equal(await page.locator('.track-info-ui').count(),0);
 assert.deepEqual(await page.evaluate(()=>({pending:caseState.pending(),calls:caseState.calls(),dispatches:caseState.dispatches()})),{pending:true,calls:0,dispatches:1});
 await page.evaluate(()=>caseState.release());
 assert.deepEqual(await page.evaluate(()=>({calls:caseState.calls(),normal:caseState.normalCalls(),pending:caseState.pending(),errors:caseState.errors(),policies:caseState.policies()})),{calls:1,normal:0,pending:false,errors:[],policies:[{ownGhost:null,opponents:[]}]});
 assert.equal(await page.evaluate(()=>window.__pt062PrepareEventRace('track',null)),false);
});
for(const change of ['cancel','racer','expiry','session','detach','replace-panel','disabled'])test('event Play rejects '+change+' before native dispatch',async t=>{
 const page=await fixture(t,{deferHandoff:true});
 await page.evaluate(change=>{caseState.play.click();caseState.mutate(change);},change);
 await page.waitForFunction(()=>!caseState.launching(),null,{timeout:1500});
 assert.deepEqual(await page.evaluate(()=>({calls:caseState.calls(),normal:caseState.normalCalls(),dispatches:caseState.dispatches(),pending:caseState.pending(),queued:caseState.queued()})),{calls:0,normal:0,dispatches:0,pending:false,queued:0});
});
for(const change of ['cancel','racer','expiry','session','wrong-track','multiplayer'])test('event Play rejects '+change+' after panel disposal without normal fallback',async t=>{
 const page=await fixture(t,{disposePanel:true,deferHandoff:true});
 await page.locator('button.play').click();
 await page.waitForFunction(()=>caseState.queued()===1&&!caseState.launching(),null,{timeout:1500});
 assert.equal(await page.locator('.track-info-ui').count(),0);
 assert.equal(await page.evaluate(()=>caseState.pending()),true);
 await page.evaluate(change=>{
  if(change==='wrong-track')caseState.release('other-track');
  else if(change==='multiplayer')caseState.release('track',{});
  else{caseState.mutate(change);caseState.release();}
 },change);
 assert.deepEqual(await page.evaluate(()=>({calls:caseState.calls(),normal:caseState.normalCalls(),dispatches:caseState.dispatches(),pending:caseState.pending(),errors:caseState.errors()})),{calls:0,normal:0,dispatches:1,pending:false,errors:['Event launch context changed']});
 assert.equal(await page.evaluate(()=>window.__pt062PrepareEventRace('track',null)),false);
});
