import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {startResponsiveServer} from './responsive-server.mjs';
import {installNativeRankedAuditFixture} from './native-ranked-audit-fixture.mjs';

const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const noHook=process.env.POLYTRACK_LATENCY_NO_HOOK==='1';
const output=process.env.POLYTRACK_LATENCY_OUTPUT||path.resolve(fileURLToPath(new URL(`../../../Codexstorage/PolyTrack/Projects/Ranked-0.6.3/Diagnostics/LeaderboardLatency/leaderboard-latency-${noHook?'baseline':'integrated'}.json`,import.meta.url)));

test('offline native leaderboard click-to-visible timeline',async()=>{
  const server=await startResponsiveServer();
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  const page=await browser.newPage({viewport:{width:1366,height:768},reducedMotion:'no-preference'});
  const blocked=[],errors=[],requests=[];
  page.on('pageerror',e=>errors.push(String(e?.stack||e)));
  await page.route('**/*',route=>{
    const request=route.request(),target=new URL(request.url());
    if(target.pathname==='/v6/user')return route.fulfill({status:200,contentType:'application/json',body:'null'});
    if(target.origin===new URL(server.url).origin&&['GET','HEAD'].includes(request.method())){
      requests.push({path:target.pathname,at:Date.now()});
      return route.continue();
    }
    blocked.push(target.href);
    return route.abort('blockedbyclient');
  });
  await installNativeRankedAuditFixture(page,{rejectWrites:true});
  if(noHook)await page.route('**/tools/leaderboard-latency-hook.mjs*',route=>route.fulfill({status:200,contentType:'text/javascript',body:'export function installNativeInitialOpenLatencyHook() {}'}));
  await page.addInitScript(()=>{
    const state={events:[],clickAt:null};
    window.__leaderboardLatency=state;
    const mark=(kind,detail={})=>state.events.push({kind,at:performance.now(),...detail});
    const NativeXHR=window.XMLHttpRequest;
    const nativeBoard=JSON.stringify({total:40,entries:[{id:1,userId:'offline-audit',nickname:'Offline audit',frames:16027,time:'2026-10-20T00:00:00.000Z',carStyle:'AAAAAAD_9QAAABsbG____w',verifiedState:1,countryCode:null}],userEntry:null});
    window.XMLHttpRequest=function(){
      const real=new NativeXHR();let audit=false,readyState=0;
      return new Proxy(real,{
        get(target,key){
          if(audit&&key==='readyState')return readyState;
          if(audit&&key==='status')return 200;
          if(audit&&key==='responseText')return nativeBoard;
          if(key==='open')return (method,url,...rest)=>{
            audit=method==='GET'&&String(url).startsWith('https://vps.kodub.com/v6/leaderboard?');
            if(audit){mark('native-request',{url:String(url).replace(/userTokenHash=[^&]*/,'userTokenHash=redacted')});return;}
            return target.open(method,url,...rest);
          };
          if(key==='send')return (...args)=>{
            if(audit){queueMicrotask(()=>{readyState=4;target.onreadystatechange?.();});return;}
            return target.send(...args);
          };
          const value=target[key];return typeof value==='function'?value.bind(target):value;
        },
        set(target,key,value){target[key]=value;return true;}
      });
    };
    window.XMLHttpRequest.DONE=4;
    const visible=el=>!!(el&&el.isConnected&&el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none');
    document.addEventListener('click',event=>{
      const target=event.target.closest?.('button');
      if(!target)return;
      mark('click',{label:target.textContent.trim().slice(0,70),className:target.className,ancestor:target.parentElement?.className});
      if(target.closest('.track-selection-ui,.track-info-ui')&&!target.closest('.track-info-ui .leaderboard-ui'))state.clickAt=performance.now();
    },true);
    document.addEventListener('animationstart',event=>{
      if(event.target.closest?.('.track-selection-ui,.track-info-ui'))mark('animationstart',{name:event.animationName,className:event.target.className});
    },true);
    document.addEventListener('animationend',event=>{
      if(event.target.closest?.('.track-selection-ui,.track-info-ui'))mark('animationend',{name:event.animationName,className:event.target.className});
    },true);
    const seen=new Map();
    const sample=()=>{
      const selectors=['.track-selection-ui','.track-info-ui','.track-info-ui .leaderboard-ui','.track-info-ui .leaderboard-ui .container','.track-info-ui .leaderboard-ui .container button.main','.track-info-ui .leaderboard-ui .container .loading-spinner-container','.track-info-ui .leaderboard-ui .container .error-message'];
      for(const selector of selectors){
        const el=document.querySelector(selector),style=el&&getComputedStyle(el);
        const value=el?{exists:true,visible:visible(el),display:style.display,opacity:style.opacity,animation:style.animationName,transition:style.transitionDuration,rows:selector.includes('leaderboard-ui')?document.querySelectorAll('.track-info-ui .leaderboard-ui .container button.main').length:undefined}: {exists:false};
        const encoded=JSON.stringify(value);
        if(seen.get(selector)!==encoded){seen.set(selector,encoded);mark('state',{selector,...value});}
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    window.__latencyOriginalTimer=window.setTimeout;
  });
  try{
    await page.goto(server.url,{waitUntil:'domcontentloaded'});
    for(const name of ['Exit','Back','Play']){
      const button=page.getByRole('button',{name,exact:true}).last();
      await button.waitFor({state:'visible',timeout:60000});await button.click();
    }
    if(!noHook)await page.waitForFunction(()=>performance.getEntriesByType('resource').some(entry=>entry.name.includes('/tools/leaderboard-latency-hook.mjs')),null,{timeout:15000});
    const ui=await page.locator('#ui').innerText();
    const buttons=await page.locator('.track-selection-ui button:visible').allTextContents();
    const tracks=await page.locator('.track-selection-ui').evaluate(el=>Array.from(el.querySelectorAll('button')).slice(0,20).map(button=>({text:button.textContent.trim(),className:button.className,html:button.outerHTML.slice(0,320)})));
    const candidate=page.locator('.track-selection-ui button:has(.track-title)').first();
    await candidate.waitFor({state:'visible',timeout:30000});
    const trials=[];
    for(let index=0;index<4;index++){
      if(index){
        await page.locator('.track-info-ui button.back').first().click();
        await candidate.waitFor({state:'visible',timeout:30000});
      }
      await page.evaluate(()=>{window.__leaderboardLatency.events=[];window.__leaderboardLatency.clickAt=null;});
      await candidate.click();
      await page.waitForFunction(()=>{
        const board=document.querySelector('.track-info-ui .leaderboard-ui');
        return board&&board.getClientRects().length&&getComputedStyle(board).visibility!=='hidden'&&getComputedStyle(board).opacity!=='0';
      },null,{timeout:5000}).catch(async error=>{console.log(JSON.stringify({stage:'board-timeout',trial:index,dom:await page.locator('.track-info-ui').count(),timeline:await page.evaluate(()=>window.__leaderboardLatency.events.slice(-35))}));throw error;});
      await page.waitForFunction(()=>document.querySelector('.track-info-ui .leaderboard-ui .container button.main'),null,{timeout:15000}).catch(async error=>{console.log(JSON.stringify({stage:'rows-timeout',trial:index,text:await page.locator('.track-info-ui .leaderboard-ui').innerText(),events:await page.evaluate(()=>window.__leaderboardLatency.events.slice(-25))}));throw error;});
      await page.waitForTimeout(60);
      assert.equal(await page.evaluate(()=>window.setTimeout===window.__latencyOriginalTimer),true,'native timer shim must be restored after each click');
      trials.push(await page.evaluate(()=>({clickAt:window.__leaderboardLatency.clickAt,events:window.__leaderboardLatency.events,boardText:document.querySelector('.track-info-ui .leaderboard-ui')?.textContent?.slice(0,300)})));
    }
    const measureFollowup=async (selector,label)=>{
      await page.evaluate(()=>{window.__leaderboardLatency.events=[];});
      await (typeof selector==='string'?page.locator(selector):selector).click();
      await page.waitForFunction(()=>window.__leaderboardLatency.events.some(event=>event.kind==='native-request'),null,{timeout:6000});
      const measurement=await page.evaluate(()=>{
        const events=window.__leaderboardLatency.events;
        const click=events.find(event=>event.kind==='click');
        const request=events.find(event=>event.kind==='native-request');
        return {click:click?.label,delayMs:request.at-click.at,events};
      });
      assert.ok(measurement.delayMs>=450,`${label} keeps native 500 ms debounce: ${measurement.delayMs}`);
      assert.equal(await page.evaluate(()=>window.setTimeout===window.__latencyOriginalTimer),true);
      await page.waitForFunction(()=>document.querySelector('.track-info-ui .leaderboard-ui .container button.main'),null,{timeout:6000});
      return measurement;
    };
    const filter=await measureFollowup('.track-info-ui .leaderboard-ui button.only-verified','filter');
    const secondPage=page.locator('.track-info-ui .leaderboard-ui .pages button.page').nth(1);
    assert.equal(await secondPage.isEnabled(),true,'synthetic total enables a second native page');
    const pageChange=await measureFollowup(secondPage,'page');
    const result={mode:noHook?'baseline':'integrated',ui:ui.slice(0,500),buttons,tracks,trials,filter,pageChange,requests,blocked,errors};
    await fs.mkdir(path.dirname(output),{recursive:true});
    await fs.writeFile(output,JSON.stringify(result,null,2));
    assert.equal(trials.length,4);
    for(const [index,trial] of trials.entries()){
      assert.match(trial.boardText,/Offline audit/,`trial ${index} renders the synthetic native row`);
      const request=trial.events.find(event=>event.kind==='native-request'&&event.at>=trial.clickAt);
      const row=trial.events.find(event=>event.kind==='state'&&event.selector.endsWith('button.main')&&event.visible&&event.at>=trial.clickAt);
      assert.ok(request&&row,`trial ${index} records request and visible row`);
      assert.ok(request.at-trial.clickAt>=(noHook?450:0),`trial ${index} preserves expected native debounce mode`);
      assert.ok(request.at-trial.clickAt<(noHook?1000:200),`trial ${index} has expected initial-open request latency`);
    }
    assert.equal(blocked.length,0,'production requests must not be attempted');
    assert.deepEqual(errors,[]);
  }finally{await browser.close();await server.close();}
});
