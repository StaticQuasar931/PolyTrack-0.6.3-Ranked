import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import vm from 'node:vm';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createKodubErpFixtureV1} from './native-kodub-erp-fixture-v1.mjs';
const require=createRequire(import.meta.url);
const {chromium}=createRequire(new URL('../tools/verifier/package.json',import.meta.url))(process.env.PLAYWRIGHT_MODULE||'playwright');
const repo=fileURLToPath(new URL('../',import.meta.url));
const patch=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=patch.indexOf('  function decorateNativeLeaderboardCosmetics(){');
const end=patch.indexOf('  /* The per-track rows',start);
assert.ok(start>=0&&end>start);
const batchSource=patch.slice(start,end);
const {publishedAt,eventBoard,normalBoard}=createKodubErpFixtureV1();
let server,browser,base;
before(async()=>{
  server=http.createServer((req,res)=>{
    const name=new URL(req.url,'http://localhost').pathname;
    if(name==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Native Kodub ERP regression</title>');return;}
    if(/^\/images\/state_(verified|pending)\.svg$/.test(name)){res.setHeader('Content-Type','image/svg+xml');res.end(fs.readFileSync(path.join(repo,name.slice(1))));return;}
    const target=path.resolve(repo,'.'+name);
    if(!target.startsWith(path.resolve(repo)+path.sep)||!/^\/(events|tools)\/[a-z0-9-]+\.mjs$/.test(name)){res.writeHead(404).end();return;}
    try{res.setHeader('Content-Type','text/javascript');res.end(fs.readFileSync(target));}catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());});
async function fixture(t,{deferred=false,board=eventBoard}={}){
  const context=await browser.newContext();t.after(()=>context.close());const page=await context.newPage();
  await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort());
  await page.goto(base);
  await page.evaluate(async({batchSource,normalBoard,eventBoard,board,deferred,at})=>{
    Date.now=()=>at;
    document.body.innerHTML='<div class="track-info-ui"><div class="leaderboard-ui"><div class="container"></div></div><div class="side-panel"><div class="personal-best">Original normal PB</div></div></div>';
    window.rows=normalBoard.entries;window.saved=board;window.snapshotEpoch=75;window.trackId=eventBoard.period.trackId;
    window.period=eventBoard.period;window.viewer='a'.repeat(64);window.staticReads=0;window.liveReads=0;window.deferred=deferred;
    const currentTrackLoadState={get trackId(){return window.trackId;}};
    const formatRaceTime=value=>window.layoutFormat?window.layoutFormat(value):String(value),cleanUserId=value=>String(value||''),activeRankedAccountId=()=>window.viewer;
    const localTrackDisplayEntries=(_track,entries)=>entries,readTrackSnapshotCache=()=>({entries:window.rows});
    const canonicalRaceTimeMs=row=>row.timeMs,rowIdentityFreshness=()=>0,canonicalDisplayName=(_id,name)=>name;
    const isElementVisible=()=>true,ensureNativeAllRunsDefault=()=>{},runStatus=row=>row?.runVerified===true?'verified':'unchecked';
    const pbTimestamp=row=>row.pbAt||0,syncNativeSelfHighlight=()=>{},rankedIdentityForRacer=row=>row;
    const __pt062NormalizeStyle=()=>'',racerCosmeticClasses=()=>'',decorateNativeLeaderboardIdentity=()=>{},hydrateOverallCarModels=()=>{};
    let nativeDecorationLookupCache=null,trackCacheGeneration=0;const overallCacheGeneration=0,localRaceGeneration=0,cosmeticEpoch=0;
    const {createNormalKodubErpDecorator}=await import('/events/client.mjs');
    window.bridge={currentTrackId:()=>window.trackId,accountId:()=>window.viewer,normalKodubPeriod:()=>window.period,
      normalEventSnapshotEpoch:()=>window.snapshotEpoch,formatTime:formatRaceTime,
      readStaticEventSnapshot:async()=>{window.staticReads++;return window.deferred?new Promise(resolve=>window.resolveBoard=resolve):window.saved;},
      readSnapshot:()=>{window.liveReads++;throw Error('Live event read is forbidden');}};
    const decorator=createNormalKodubErpDecorator(window.bridge);
    const eventUi=window.eventUi={decorateNormalLeaderboardRow:decorator.decorate,invalidateNormalLeaderboardERP:decorator.invalidate};
    window.batch=eval('('+batchSource.trim()+')');
    window.render=()=>{
      trackCacheGeneration++;
      const container=document.querySelector('.container');container.replaceChildren();
      for(const row of window.rows){
        const button=document.createElement('button');button.className='main';button.dataset.testAccount=row.accountId;
        button.innerHTML='<div class="left"><p class="position"></p><p class="time"></p></div><div class="name"></div><div class="verified-state"><img><span class="original-status">Original status</span></div>';
        button.querySelector('.position').textContent=String(row.rank);button.querySelector('.time').textContent=String(row.timeMs);
        button.querySelector('.name').textContent=row.name;container.append(button);
      }
      window.batch();
    };
    window.render();
  },{batchSource,normalBoard,eventBoard,board,deferred,at:publishedAt});
  return page;
}
const labelFor=(page,account)=>page.locator('[data-test-account="'+account+'"] .sq-normal-kodub-erp');
test('real native batch hydrates 18 exact and four separate synthetic v1 Kodub Event PBs with one static read',async t=>{
  const p=await fixture(t);
  await p.waitForFunction(()=>{const labels=[...document.querySelectorAll('.sq-normal-kodub-erp')];return labels.length===22&&labels.every(node=>!node.hidden&&node.dataset.status==='awarded');});
  let exact=0,separate=0;
  for(const saved of eventBoard.entries){
    const normal=normalBoard.entries.find(row=>row.accountId===saved.accountId);
    const same=normal.timeMs===saved.timeMs&&normal.replayHash===saved.replayHash;
    const label=labelFor(p,saved.accountId);
    assert.equal(await label.innerText(),same?saved.rp+' ERP':'Event PB '+saved.timeMs);
    assert.equal(await label.getAttribute('data-verified'),String(same));
    assert.equal(await label.getAttribute('data-separate'),String(!same));
    if(!same){
      assert.ok((await label.getAttribute('title')).includes(String(saved.timeMs)));
      assert.ok(!(await label.getAttribute('title')).includes(String(normal.timeMs)));
    }
    if(same)exact++;else separate++;
  }
  assert.equal(exact,18);assert.equal(separate,4);
  assert.equal(await p.locator('.sq-normal-kodub-erp').count(),22);
  assert.equal(await p.locator('.sq-event-board').count(),0);
  assert.equal(await p.locator('.personal-best').innerText(),'Original normal PB');
  await p.evaluate(()=>{for(let i=0;i<20;i++)batch();});
  assert.deepEqual(await p.evaluate(()=>[staticReads,liveReads]),[1,0]);
  assert.equal(await p.locator('.original-status').count(),22);
  assert.equal(await p.locator('.sq-normal-kodub-erp img').count(),0,'ERP does not duplicate the native verification icon');
  assert.equal(await p.locator('.sq-normal-kodub-erp').evaluateAll(labels=>labels.some(label=>label.style.backgroundImage)),false);
});
test('snapshot epoch replacement discards late old awards and clears already rendered labels',async t=>{
  const p=await fixture(t,{deferred:true});await p.waitForFunction(()=>!!window.resolveBoard);
  await p.evaluate(()=>{window.resolveOld=resolveBoard;snapshotEpoch++;eventUi.invalidateNormalLeaderboardERP();batch();});
  await p.waitForFunction(()=>staticReads===2);
  await p.evaluate(()=>{resolveOld(saved);});
  assert.equal(await labelFor(p,eventBoard.entries[0].accountId).innerText(),'');
  await p.evaluate(()=>{const next=structuredClone(saved);next.entries[0].rp=0;resolveBoard(next);});
  await p.waitForFunction(()=>document.querySelector('.sq-normal-kodub-erp')?.textContent==='0 ERP');
  await p.evaluate(()=>eventUi.invalidateNormalLeaderboardERP());
  assert.equal(await p.locator('.sq-normal-kodub-erp').count(),0);
});
test('late hydration cannot write into a replaced/rebound row or another track/account',async t=>{
  const p=await fixture(t,{deferred:true});await p.waitForFunction(()=>!!window.resolveBoard);
  await p.evaluate(()=>{
    const button=document.querySelector('button.main');button.dataset.sqRacerAccountId='f'.repeat(64);
    const second=document.querySelectorAll('button.main')[1];second.dataset.sqRacerReplayHash='f'.repeat(64);
    const third=document.querySelectorAll('button.main')[2];third.querySelector('.time').textContent='1';
    document.querySelectorAll('button.main')[4].querySelector('.name').textContent='Recycled row';
    window.detached=document.querySelectorAll('button.main')[3];detached.remove();resolveBoard(saved);
  });
  await p.waitForFunction(()=>!document.querySelectorAll('button.main')[0].querySelector('.sq-normal-kodub-erp'));
  for(const i of [0,1,2,3])assert.equal(await p.locator('button.main').nth(i).locator('.sq-normal-kodub-erp').count(),0);
  assert.equal(await p.evaluate(()=>detached.querySelector('.sq-normal-kodub-erp')),null);
  assert.equal(await p.evaluate(()=>staticReads),1);
  await p.evaluate(()=>{render();});
  await p.waitForFunction(()=>document.querySelector('.sq-normal-kodub-erp')?.textContent==='489 ERP');
  assert.equal(await p.evaluate(()=>staticReads),1);
  await p.evaluate(()=>{trackId='f'.repeat(64);batch();});
  assert.equal(await p.locator('.sq-normal-kodub-erp').count(),0);
});
test('published zero, confirmed absence, pending and unavailable ERP stay distinct without live fallback',async t=>{
  const board=structuredClone(eventBoard);board.entries[0].rp=0;delete board.entries[1].rp;board.entries.pop();
  board.totalEntries=board.entries.length;
  const p=await fixture(t,{board});
  await p.waitForFunction(()=>document.querySelector('.sq-normal-kodub-erp')?.textContent==='0 ERP');
  const zero=labelFor(p,board.entries[0].accountId),unknown=labelFor(p,board.entries[1].accountId);
  assert.equal(await zero.getAttribute('data-verified'),'true');
  assert.equal(await zero.getAttribute('data-status'),'awarded');
  assert.equal(await unknown.textContent(),'');assert.equal(await unknown.isHidden(),true);
  assert.equal(await unknown.getAttribute('data-status'),'unavailable');
  const outside=normalBoard.entries.find(row=>!board.entries.some(entry=>entry.accountId===row.accountId));
  const absent=labelFor(p,outside.accountId);
  assert.equal(await absent.textContent(),'No event result');assert.equal(await absent.isHidden(),false);
  assert.equal(await absent.getAttribute('data-status'),'none');assert.equal(await absent.getAttribute('data-verified'),'false');
  const pendingTime=outside.timeMs+500;
  await p.evaluate(({accountId,timeMs})=>{
    saved={...saved,pendingPlaybacks:[{accountId,timeMs,runId:'d'.repeat(64),replayHash:'e'.repeat(64),
      submittedAt:period.startsAt+1000,pending:true,verified:false,eventRpEligible:false,verificationStatus:'waiting',source:'pending-event-playback'}]};
    snapshotEpoch++;batch();
  },{accountId:outside.accountId,timeMs:pendingTime});
  await p.waitForFunction(account=>document.querySelector('[data-test-account="'+account+'"] .sq-normal-kodub-erp')?.dataset.status==='pending',outside.accountId);
  assert.equal(await absent.textContent(),'Event PB pending');assert.equal(await absent.getAttribute('data-verified'),'false');
  assert.ok((await absent.getAttribute('title')).includes(String(pendingTime)));
  assert.doesNotMatch(await absent.textContent(),/\d+ ERP/);
  for(const mode of ['partial','count-mismatch']){
    await p.evaluate(mode=>{
      saved={...saved,pendingPlaybacks:[],complete:mode!=='partial',sourceComplete:mode!=='partial',
        totalEntries:saved.entries.length+(mode==='count-mismatch'?1:0)};snapshotEpoch++;batch();
    },mode);
    await p.waitForFunction(account=>document.querySelector('[data-test-account="'+account+'"] .sq-normal-kodub-erp')?.dataset.status==='unavailable',outside.accountId);
    assert.equal(await absent.textContent(),'');assert.equal(await absent.isHidden(),true);
  }
  await p.evaluate(()=>{snapshotEpoch++;saved=null;batch();});
  await p.waitForFunction(()=>{const labels=[...document.querySelectorAll('.sq-normal-kodub-erp')];return labels.length===22&&labels.every(label=>label.dataset.status==='unavailable'&&label.hidden&&label.textContent==='');});
  assert.deepEqual(await p.evaluate(()=>[staticReads,liveReads]),[5,0]);
  assert.equal(await p.evaluate(account=>rows.find(row=>row.accountId===account).runVerified,outside.accountId),true);
});
test('equal time with another replay stays a separate Event PB and never changes ordinary proof',async t=>{
  const p=await fixture(t,{deferred:true});await p.waitForFunction(()=>!!window.resolveBoard);
  await p.evaluate(()=>{rows[0].replayHash='f'.repeat(64);render();resolveBoard(saved);});
  await p.waitForFunction(()=>document.querySelector('.sq-normal-kodub-erp')?.textContent.startsWith('Event PB '));
  const label=labelFor(p,eventBoard.entries[0].accountId);
  assert.equal(await label.innerText(),'Event PB 51459');
  assert.equal(await label.getAttribute('data-verified'),'false');
  assert.doesNotMatch(await label.innerText(),/ERP/);
  assert.equal(await label.getAttribute('data-separate'),'true');
  assert.ok((await label.getAttribute('title')).includes('51459'));
  assert.equal(await p.evaluate(()=>rows[0].runVerified),true);
  assert.equal(await p.evaluate(()=>staticReads),1);
});
test('normal ERP bridge remains static-only and participates in generation invalidation',()=>{
  assert.match(patch,/readStaticEventSnapshot:id=>readPublicSnapshotBackup\('event',id\)/);
  assert.match(patch,/normalEventSnapshotEpoch:\(\)=>eventCloudRead\.snapshotEpoch\|\|0/);
  assert.match(patch,/eventUi\?\.invalidateNormalLeaderboardERP\?\.\(\)/);
  assert.match(batchSource,/decorateNativeLeaderboardIdentity\(button,identity\);\s*normalEventUi\?\.decorateNormalLeaderboardRow/);
});

test('account change and event expiry reject pending hydration without leaking old labels',async t=>{
  const p=await fixture(t,{deferred:true});await p.waitForFunction(()=>!!window.resolveBoard);
  await p.evaluate(()=>{viewer='e'.repeat(64);resolveBoard(saved);});
  await p.waitForFunction(()=>!document.querySelector('.sq-normal-kodub-erp'));
  await p.evaluate(()=>{deferred=false;batch();});
  await p.waitForFunction(()=>document.querySelector('.sq-normal-kodub-erp')?.textContent==='489 ERP');
  assert.equal(await p.evaluate(()=>staticReads),1);
  await p.evaluate(()=>{period={...period,endsAt:Date.now()};batch();});
  assert.equal(await p.locator('.sq-normal-kodub-erp').count(),0);
});
test('wrong period, track, kind or explicit negative event proof cannot supply a native award',async t=>{
  const bad=structuredClone(eventBoard);bad.period.trackId='f'.repeat(64);
  const p=await fixture(t,{board:bad});
  await p.waitForFunction(()=>document.querySelector('.sq-normal-kodub-erp')?.textContent==='');
  for(const change of ['id','kind','proof']){
    await p.evaluate(({eventBoard,change})=>{
      saved=structuredClone(eventBoard);snapshotEpoch++;
      if(change==='proof')saved.entries[0].eventRpEligible=false;
      else saved.period[change]='wrong';batch();
    },{eventBoard,change});
    await p.waitForFunction(()=>document.querySelector('.sq-normal-kodub-erp')?.textContent==='');
  }
  assert.equal(await p.evaluate(()=>liveReads),0);
});

const nativeBundle=fs.readFileSync(new URL('../main.bundle.js',import.meta.url),'utf8');
const rowStart=nativeBundle.indexOf('il=function(e,t,n,i,r,a,s,o,l,c,h,z){');
const nativeRow=nativeBundle.slice(rowStart+3,nativeBundle.indexOf(',rl=function e()',rowStart));
const timeStart=nativeBundle.indexOf('static formatTimeString(');
const nativeTime=nativeBundle.slice(timeStart+7,nativeBundle.indexOf('update(e){',timeStart+7)).trim();
const literal=String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60)`;
const rankedCss=[...patch.matchAll(new RegExp(String.raw`(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*(${literal})`,'g'))].map(match=>vm.runInNewContext(match[1],{},{timeout:100})).join('\n');
const nativeCss=[/"\.leaderboard-ui \{(?:\\.|[^"\\])*"/,/"\.track-info-ui \{(?:\\.|[^"\\])*"/].map(re=>JSON.parse(nativeBundle.match(re)[0])).join('\n');
const eventCss=fs.readFileSync(new URL('./events.css',import.meta.url),'utf8');
const font=fs.readFileSync(new URL('../forced_square.woff2',import.meta.url)).toString('base64');
for(const [width,height] of [[430,932],[1366,768]])test('native Kodub ERP fits real row layout '+width+'x'+height,async t=>{
  const p=await fixture(t);await p.setViewportSize({width,height});
  await p.addStyleTag({content:`@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,${font})}html,body{margin:0;width:100%;height:100%;background:#151c33;color:#fff;font-family:ForcedSquare}button{position:relative;border:0;background:#28346a;color:#fff;font-family:inherit}body>div,.menu-ui{width:100%;height:100%}:root{--text-color:#fff;--surface-color:#202b50;--surface-secondary-color:#17203d}`});
  await p.addStyleTag({content:eventCss});await p.addStyleTag({content:nativeCss+'\n'+rankedCss});
  await p.evaluate(()=>document.fonts.ready);
  const before=await p.evaluate(({nativeRow,nativeTime})=>{
    const root=document.querySelector('.track-info-ui'),wrapper=document.createElement('div'),menu=document.createElement('div');menu.className='menu-ui';wrapper.append(menu);root.before(wrapper);menu.append(root);
    const Oo=new WeakMap(),$o=new WeakMap(),el=new WeakMap(),zo=new WeakMap(),Do=new WeakMap(),Io=new WeakMap(),Ro={},owner={};
    const R={gn:(object,map,type,key)=>type==='m'?key:map.get(object),GG:(object,map,value)=>map.set(object,value)};
    const Qe=String,Je=()=> 'th',He={A:{formatTimeString:eval('(function '+nativeTime+')')}},ni={O:()=>[]},_o={Y:{Pending:0,Verified:1,InvalidDuplicate:3}},sl={u:()=> '1 hour ago'},kr={F:()=>{throw Error('No car reads in layout test');}};
    Io.set(owner,{get:value=>value});el.set(owner,[]);zo.set(owner,{playUIClick(){}});Do.set(owner,()=>{});
    window.layoutFormat=value=>He.A.formatTimeString({numberOfFrames:value});
    rows=rows.filter(row=>saved.entries.some(entry=>entry.accountId===row.accountId&&entry.timeMs!==row.timeMs));
    render();
    const container=document.querySelector('.container');container.replaceChildren();Oo.set(owner,container);
    const draw=eval('('+nativeRow+')');
    for(const row of rows){const button=draw.call(owner,row.rank,row.name,null,{numberOfFrames:row.timeMs},new Date(row.pbAt),null,row.runVerified?1:0,false,row.accountId,new Date(),{isCancelled:false},{event:true});button.dataset.testAccount=row.accountId;}
    const size=node=>{const r=node.getBoundingClientRect();return {width:r.width,height:r.height};};
    const sizes=[...container.querySelectorAll('button.main')].map(button=>size(button.querySelector('.verified-state')));
    batch();return sizes;
  },{nativeRow,nativeTime});
  await p.waitForFunction(()=>document.querySelectorAll('.sq-normal-kodub-erp').length===4&&[...document.querySelectorAll('.sq-normal-kodub-erp')].every(label=>label.textContent.startsWith('Event PB ')));
  const measurements=await p.locator('button.main').evaluateAll(buttons=>buttons.map(button=>{
    const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    return {row:rect(button),erp:rect(button.querySelector('.sq-normal-kodub-erp')),age:rect(button.querySelector('.verified-state')),name:rect(button.querySelector('.name')),time:rect(button.querySelector('.left p:not(.position)')),text:button.querySelector('.sq-normal-kodub-erp').textContent,clipped:button.querySelector('.sq-normal-kodub-erp').scrollWidth>button.querySelector('.sq-normal-kodub-erp').clientWidth};
  }));
  const screenshot=path.join(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR||os.tmpdir(),'polytrack-native-kodub-'+width+'.png');fs.mkdirSync(path.dirname(screenshot),{recursive:true});await p.screenshot({path:screenshot});
  const overlaps=(a,b)=>Math.min(a.right,b.right)-Math.max(a.x,b.x)>1&&Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>1;
  for(const [i,m] of measurements.entries()){
    assert.ok(m.erp.x>=m.age.x-1&&m.erp.right<=m.age.right+1&&m.erp.y>=m.age.y-1&&m.erp.bottom<=m.age.bottom+1,JSON.stringify({width,m,screenshot}));
    assert.ok(!overlaps(m.age,m.name)&&!overlaps(m.erp,m.name)&&!overlaps(m.erp,m.time),JSON.stringify({width,m,screenshot}));
    assert.ok(m.erp.x>=m.row.x&&m.erp.right<=m.row.right+1&&m.erp.y>=m.row.y&&m.erp.bottom<=m.row.bottom+1,JSON.stringify({width,m,screenshot}));
    assert.ok(m.age.x>=m.row.x&&m.age.right<=m.row.right+1&&m.age.y>=m.row.y&&m.age.bottom<=m.row.bottom+1,JSON.stringify({width,m,screenshot}));
    assert.match(m.text,/Event PB /);assert.doesNotMatch(m.text,/ERP/);assert.equal(m.clipped,false,JSON.stringify({width,m}));
  }
  assert.deepEqual(await p.evaluate(()=>[staticReads,liveReads]),[1,0]);
});

test('temporary Kodub snapshot failure recovers all visible labels with one coalesced static retry',async t=>{
 const p=await fixture(t,{board:null});
 await p.waitForFunction(()=>[...document.querySelectorAll('.sq-normal-kodub-erp')].every(node=>node.textContent===''));
 await p.evaluate(()=>{for(let i=0;i<20;i++)batch();});
 assert.deepEqual(await p.evaluate(()=>[staticReads,liveReads]),[1,0]);
 await p.evaluate(({eventBoard,at})=>{window.saved=eventBoard;Date.now=()=>at+30001;batch();},{eventBoard,at:publishedAt});
 await p.waitForFunction(()=>document.querySelector('.sq-normal-kodub-erp')?.textContent==='489 ERP');
 assert.equal(await p.locator('.sq-normal-kodub-erp').count(),22);
 assert.deepEqual(await p.evaluate(()=>[staticReads,liveReads]),[2,0]);
});

test('persistent Kodub static failure stops after three attempts, without live fallback or tick polling',async t=>{
 const p=await fixture(t,{board:null});
 await p.waitForFunction(()=>document.querySelector('.sq-normal-kodub-erp')?.textContent==='');
 for(const offset of [30001,150002]){
  await p.evaluate(at=>{Date.now=()=>at;batch();},publishedAt+offset);
  await p.waitForFunction(()=>document.querySelector('.sq-normal-kodub-erp')?.textContent==='');
 }
 await p.evaluate(at=>{Date.now=()=>at;for(let i=0;i<20;i++)batch();},publishedAt+1000000);
 assert.deepEqual(await p.evaluate(()=>[staticReads,liveReads]),[3,0]);
});

for(const [width,height] of [[320,568],[390,844],[1366,768]])test('pending event badges are compact, right aligned and proof-neutral '+width+'x'+height,async t=>{
  const p=await fixture(t);await p.setViewportSize({width,height});
  await p.addStyleTag({content:nativeCss+'\n'+rankedCss+'\n'+eventCss});
  await p.addStyleTag({content:'@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,'+font+')}html,body{margin:0;background:#151c33;color:#fff;font-family:ForcedSquare}button{position:relative;border:0;background:#28346a;color:#fff;font-family:inherit}.track-info-ui{position:static!important;transform:none!important;display:block!important;width:100%!important;padding:0!important}.track-info-ui>.leaderboard-ui{position:static!important;transform:none!important;width:100%!important;max-width:600px!important;margin:0!important}.leaderboard-ui>.container{height:auto!important}'});
  await p.evaluate(async({drawSource,timeSource,at})=>{
    const {decorateEventRowPresentation}=await import('/events/client.mjs');
    const board=document.querySelector('.leaderboard-ui');board.classList.add('sq-event-board');
    const container=board.querySelector('.container');container.replaceChildren();
    const Oo=new WeakMap(),$o=new WeakMap(),el=new WeakMap(),zo=new WeakMap(),Do=new WeakMap(),Io=new WeakMap(),Ro={},owner={};
    const R={gn:(object,map,type,key)=>type==='m'?key:map.get(object),GG:(object,map,value)=>map.set(object,value)};
    const Qe=String,Je=()=> 'th',He={A:{formatTimeString:eval('(function '+timeSource+')')}},ni={O:()=>[]},_o={Y:{Pending:0,Verified:1,InvalidDuplicate:3}},sl={u:()=> '1 hour ago'},kr={F:()=>{throw Error('No replay or car reads in badge presentation');}};
    Io.set(owner,{get:value=>value});el.set(owner,[]);zo.set(owner,{playUIClick(){}});Do.set(owner,()=>{});Oo.set(owner,container);
    const draw=eval('('+drawSource+')');window.badgeRows=[];
    for(const [i,source] of ['pending-event-playback','submitted-event-recording','local-event-recording'].entries()){
      const row={rank:i+1,timeMs:20000+i,source,pending:true,verified:false,eventRpEligible:false,verificationStatus:'waiting',rp:999,pbAt:at-3600000};
      const button=draw.call(owner,row.rank,'Pending racer '+(i+1),null,{numberOfFrames:row.timeMs},new Date(row.pbAt),null,0,false,'pending-'+i,new Date(),{isCancelled:false},{event:true});
      decorateEventRowPresentation(button,row,at);decorateEventRowPresentation(button,row,at);
      button.querySelector('.image-container img')?.remove();
      window.badgeRows.push({button,row});
    }
  },{drawSource:nativeRow,timeSource:nativeTime,at:publishedAt});
  await p.evaluate(()=>document.fonts.ready);
  const states=await p.evaluate(()=>badgeRows.map(({button,row})=>{
    const badge=button.querySelector('.verified-state'),r=badge.getBoundingClientRect(),parent=button.getBoundingClientRect();
    return {source:row.source,text:badge.textContent,title:badge.title,aria:badge.getAttribute('aria-label'),labels:badge.querySelectorAll('.sq-event-status-label').length,verified:badge.classList.contains('verified'),icon:badge.querySelector('img').getAttribute('src'),right:parent.right-r.right,cssRight:getComputedStyle(badge).right,height:r.height,clipped:badge.scrollWidth>badge.clientWidth,within:r.left>=parent.left&&r.right<=parent.right&&r.top>=parent.top&&r.bottom<=parent.bottom};
  }));
  for(const state of states){
    const message=JSON.stringify({width,state});assert.equal(state.verified,false,message);assert.equal(state.labels,1,message);
    assert.match(state.text,state.source==='local-event-recording'?/Local PB/:/Pending/,message);assert.doesNotMatch(state.text,/ERP|Verified/i,message);
    assert.equal(state.title,state.aria,message);assert.match(state.icon,/state_pending/);assert.ok(state.within&&!state.clipped,message);assert.ok(state.height<=32,message);assert.equal(state.cssRight,'12px',message);assert.ok(state.right>0&&state.right<=14,message);
  }
  if(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR){fs.mkdirSync(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR,{recursive:true});await p.screenshot({path:path.join(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR,'event-pending-'+width+'.png')});}
});
