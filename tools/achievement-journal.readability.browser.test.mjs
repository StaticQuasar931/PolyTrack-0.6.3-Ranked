import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {chromium} = require('C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const root = fileURLToPath(new URL('../',import.meta.url));
const evidence = process.env.ACHIEVEMENT_EVIDENCE_DIR || 'C:/Users/Static/Documents/Codexstorage/PolyTrack/Projects/Ranked-0.6.3/2026-11-14/cosmetics-phase2';

test('offline readability, exact rewards, input and static Apex evidence',{timeout:90000},async () => {
  await fs.mkdir(evidence,{recursive:true});
  const allowed = new Set(['achievement-journal.css','achievement-journal.mjs','achievement-model.mjs','profile-shop-art.css','profile-shop-art.mjs','profile-shop-catalog.mjs','racer-studio-polish.css']);
  const server = http.createServer(async(req,res) => {
    const url = new URL(req.url,'http://localhost');
    if(url.pathname === '/') {
      res.setHeader('Content-Type','text/html');
      res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/tools/achievement-journal.css"><link rel="stylesheet" href="/tools/racer-studio-polish.css"><link rel="stylesheet" href="/tools/profile-shop-art.css"><style>@font-face{font-family:ForcedSquare;src:url(/forced_square.woff2)}body{margin:0;background:#172c48}dialog.profile-hub{--profile-pattern:repeating-linear-gradient(45deg,red 0 20px,lime 20px 40px);--profile-a:red;--profile-b:lime}#art{padding:20px;display:grid;gap:20px}#art figure{margin:0;background:#172c48;color:white;font:20px ForcedSquare,sans-serif}#art svg{height:auto;aspect-ratio:320/88}#art figcaption{padding:12px}</style><dialog class="profile-hub"><header class="ph-header"><h2>PolyTrack</h2><button class="ph-close">Close <span aria-hidden="true">x</span></button></header><div class="ph-panel"><main id="host"></main></div></dialog></html>');return;
    }
    const name = url.pathname.slice('/tools/'.length);
    if(url.pathname !== '/forced_square.woff2' && (!url.pathname.startsWith('/tools/') || !allowed.has(name))) {res.writeHead(404).end();return;}
    try {res.setHeader('Content-Type',url.pathname.endsWith('.css')?'text/css':url.pathname.endsWith('.mjs')?'text/javascript':'font/woff2');res.end(await fs.readFile(path.join(root,url.pathname.slice(1))));}catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  const report = {scope:'Offline component fixture, not live account or integrated garage',viewports:[],externalRequests:[],errors:[],screenshots:[]};
  try {
    browser = await chromium.launch({headless:true,timeout:12000,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    const context = await browser.newContext({reducedMotion:'reduce'});
    const page = await context.newPage();page.setDefaultTimeout(5000);
    page.on('pageerror',error=>report.errors.push(error.message));
    const base = `http://127.0.0.1:${server.address().port}`;
    await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():(report.externalRequests.push(route.request().url()),route.abort()));
    const mouse = async selector => {
      const point = await page.locator(selector).first().evaluate(el=>{
        el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
        const b=el.getBoundingClientRect(),x=b.x+b.width/2,y=b.y+b.height/2;
        const hit=document.elementFromPoint(x,y);
        if(!hit || !el.contains(hit))throw Error('Mouse target obscured: '+el.outerHTML.slice(0,120));
        return {x,y};
      });
      await page.mouse.click(point.x,point.y);
    };
    const screenshot = async name => {
      try {await page.screenshot({path:path.join(evidence,name),timeout:5000,animations:'disabled'});report.screenshots.push(name);}
      catch(error){report.screenshots.push({name,error:error.message});throw error;}
    };
    for(const [width,height] of [[1440,1000],[390,844],[844,390],[320,700]]) {
      await page.setViewportSize({width,height});await page.goto(base,{waitUntil:'load',timeout:10000});
      await page.evaluate(async()=>{
        const api=await import('/tools/achievement-journal.mjs');
        window.calls={close:0,rewards:[]};
        document.querySelector('#host').innerHTML=api.renderAchievementJournal({family:'practice',progress:{local:{practiceFinishes:2}},cosmetics:{theme:[['test-theme','Exact theme label',3]]}});
        api.bindAchievementJournal(document.querySelector('#host'),{onClose:()=>calls.close++,onTryCosmetic:r=>calls.rewards.push(r)});
        document.querySelector('.ph-close').onclick=()=>calls.close++;
        document.querySelector('dialog').showModal();await document.fonts.ready;
      });
      await mouse('[data-aj-select="achievement:v1:practice-finishes:10"]');
      const detail=page.locator('[data-aj-detail]');
      assert.match(await detail.innerText(),/No cosmetic reward or CP/);
      assert.match(await detail.innerText(),/Current progress: 2\s+Goal: 10/);
      assert.equal(await detail.locator('.aj-more').getAttribute('open'),'');
      const metrics=await page.evaluate(()=>{
        const style=s=>getComputedStyle(document.querySelector(s));
        return {overflow:document.documentElement.scrollWidth>innerWidth,hubPattern:style('dialog').backgroundImage,journalPattern:style('.aj').backgroundImage,journalBackground:style('.aj').backgroundColor,goalSize:parseFloat(style('[data-aj-select="achievement:v1:practice-finishes:10"]>strong').fontSize),detailSize:parseFloat(style('.aj-detail p').fontSize),panelOverflow:document.querySelector('.ph-panel').scrollWidth>document.querySelector('.ph-panel').clientWidth};
      });
      assert.equal(metrics.overflow,false);assert.equal(metrics.panelOverflow,false);
      assert.equal(metrics.hubPattern,'none');assert.equal(metrics.journalPattern,'none');
      assert.equal(metrics.journalBackground,'rgb(32, 44, 60)');assert.ok(metrics.goalSize>=24);assert.ok(metrics.detailSize>=17);
      report.viewports.push({width,height,...metrics});
      if(width===1440 || width===390) {
        await screenshot(`achievement-readable-${width}.png`);
        await page.locator('.aj-detail').evaluate(el=>el.scrollIntoView({block:'start',behavior:'instant'}));
        await screenshot(`achievement-expanded-${width}.png`);
      }
      await mouse('[data-aj-filter="all"]');await mouse('[data-aj-family="style"]');
      await mouse('[data-aj-select="style:3"]');
      assert.match(await detail.innerText(),/Actual rewards: 1 cosmetic choice/);
      assert.match(await detail.innerText(),/View reward: Exact theme label/);
      await mouse('[data-aj-detail] [data-aj-try]');
      assert.deepEqual(await page.evaluate(()=>calls.rewards[0]),{kind:'theme',id:'test-theme',label:'Exact theme label',requirement:3,confirmed:false,previewOnly:true});
      await page.locator('[data-aj-close]').focus();await page.keyboard.press('Enter');
      assert.equal(await page.evaluate(()=>calls.close),1);
      await mouse('.ph-close');assert.equal(await page.evaluate(()=>calls.close),2);
      await page.locator('[data-aj-close]').focus();await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(()=>calls.close),3);
    }
    await page.setViewportSize({width:1120,height:700});
    await page.evaluate(async()=>{
      const {renderProfileShopArt}=await import('/tools/profile-shop-art.mjs');
      document.querySelector('.ph-panel').scrollTop=0;
      document.querySelector('#host').innerHTML='<div id="art" style="grid-template-columns:1fr 1fr">'+['normal','low'].map(density=>'<figure>'+renderProfileShopArt('profile-apex-observatory',{density})+'<figcaption>Apex Observatory / '+density+' density / static</figcaption></figure>').join('')+'</div>';
    });
    await screenshot('apex-observatory-static-densities.png');
    assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);
    report.passed=true;
  } finally {
    await fs.writeFile(path.join(evidence,'achievement-readability-browser.json'),JSON.stringify(report,null,2));
    await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
  }
});
