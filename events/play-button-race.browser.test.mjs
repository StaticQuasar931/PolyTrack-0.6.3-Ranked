import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require('../tools/verifier/node_modules/playwright');
const client=await fs.readFile(new URL('./client.mjs',import.meta.url),'utf8');
const patch=await fs.readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=client.indexOf('  async function playEvent(){');
const launch=client.slice(start,client.indexOf('  const ownReceipts=',start));
const nativeStart=patch.indexOf('  window.__pt062PrepareEventRace=function');
const native=patch.slice(nativeStart,patch.indexOf('  const eventCloudRequests=',nativeStart));
async function setup(page,{missingView=false,disabled=false}={}){
 await page.setContent('<div class="track-info-ui"><div class="side-panel"><button class="play">Play</button></div></div>');
 await page.evaluate(({launch,native,missingView,disabled})=>{
  window.__pt062NativeEventGhostVersion=1;window.__pt062NativeEventLaunchVersion=1;
  window.caseState=new Function('options',
   'let pendingEventLaunch=null,launching=false,nativePlayPermit=false;'+
   'const messages=[],pendingGhosts=new Map(),selectedGhosts=new Map();'+
   'let session={periodId:"weekly",accountId:"racer",trackId:"track",endsAt:Date.now()+60000};'+
   'const sessions={current:()=>session},now=()=>Date.now(),activeRankedAccountId=()=>"racer",getOwnReplay=()=>null,raceGhosts=()=>({ownGhost:null,opponents:[]});'+
   'const root=document.querySelector(".track-info-ui");root.__pt062EventWatch={version:1,trackId:"track"};'+
   'const nativeView=options.missingView?null:{root,periodId:"weekly",accountId:"racer"};'+
   'const message=value=>messages.push(value);let nativeCalls=0;'+native+
   'const bridge={accountId:activeRankedAccountId,startEventRace};'+
   'const play=root.querySelector("button.play");play.disabled=options.disabled;'+
   'play.onclick=()=>setTimeout(()=>{try{if(window.__pt062PrepareEventRace("track",null))nativeCalls++;}catch(e){messages.push(e.message);}},0);'+
   'document.addEventListener("click",e=>{if(e.target===play&&!nativePlayPermit){e.preventDefault();e.stopImmediatePropagation();void playEvent();}},true);'+launch+
   'return {calls:()=>nativeCalls,pending:()=>!!pendingEventLaunch,messages:()=>messages,launching:()=>launching,cancel:()=>{session=null;},play};'
  )({missingView,disabled});
 },{launch,native,missingView,disabled});
}
for(const mode of ['programmatic','pointer'])test('event Play starts once after '+mode+' click without poisoning later launches',async()=>{
 const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage();await setup(page);
  for(let i=1;i<=2;i++){
   if(mode==='pointer')await page.locator('button.play').click();else await page.evaluate(()=>caseState.play.click());
   await page.waitForFunction(count=>caseState.calls()===count,i,{timeout:1500});
   assert.equal(await page.evaluate(()=>caseState.pending()),false);
  }
 }finally{await browser.close();}
});
test('event Play does not depend on the leaderboard overlay finishing loading',async()=>{
 const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage();await setup(page,{missingView:true});
  await page.locator('button.play').click();await page.waitForFunction(()=>caseState.calls()===1,null,{timeout:1500});
 }finally{await browser.close();}
});
test('a cancelled event cannot launch after yielding the original click',async()=>{
 const browser=await chromium.launch({headless:true});try{
  const page=await browser.newPage();await setup(page);
  await page.evaluate(()=>{caseState.play.click();caseState.cancel();});
  await page.waitForTimeout(50);assert.equal(await page.evaluate(()=>caseState.calls()),0);
  assert.equal(await page.evaluate(()=>caseState.pending()),false);
 }finally{await browser.close();}
});
