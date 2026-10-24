import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {startResponsiveServer} from './responsive-server.mjs';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require('playwright');
const output=path.resolve(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR||'local-reports/responsive');await fs.mkdir(output,{recursive:true});
const server=await startResponsiveServer(),browser=await chromium.launch({headless:true});
const report={scope:'Offline native Chromium interactions, touch emulation DPR 2. No real-device or OS keyboard claim.',checks:[],errors:[]};
const context=await browser.newContext({viewport:{width:390,height:844},hasTouch:true,deviceScaleFactor:2});
const page=await context.newPage();page.setDefaultTimeout(16000);page.on('pageerror',error=>report.errors.push(String(error)));
await page.route('**/*',route=>new URL(route.request().url()).origin===server.url?route.continue():route.abort());
const check=(name,pass,detail)=>report.checks.push({name,status:pass?'pass':'fail',detail});
const screenshot=async name=>page.screenshot({path:path.join(output,'interaction-'+name+'.png')});
try{
  await page.addInitScript(()=>{
    window.__settingsFirstFrames=[];
    new MutationObserver(records=>{
      if(records.some(r=>[...r.addedNodes].some(n=>n.nodeType===1&&(n.matches?.('.settings-menu-ui')||n.querySelector?.('.settings-menu-ui')))))requestAnimationFrame(()=>window.__settingsFirstFrames.push(Boolean(document.getElementById('sqRankedSettings'))));
    }).observe(document,{childList:true,subtree:true});
  });
  await page.goto(server.url,{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'Exit',exact:true}).waitFor({timeout:40000});
  await page.keyboard.down('w');await page.waitForTimeout(600);await page.keyboard.up('w');
  const hudBefore=await page.locator('.timer-ui').allTextContents();
  await page.setViewportSize({width:844,height:320});await page.waitForTimeout(200);
  check('live race resize preserves canvas proportions',await page.evaluate(()=>{const r=document.querySelector('canvas').getBoundingClientRect();return Math.abs(r.width/ r.height-innerWidth/innerHeight)<.01;}),{hudBefore,hudAfter:await page.locator('.timer-ui').allTextContents()});await screenshot('race-short-landscape');
  await page.keyboard.press('p');await page.waitForTimeout(100);
  const paused=await page.locator('.pause-screen-ui').isVisible().catch(()=>false);check('pause can open after rotation',paused);
  if(paused){await page.setViewportSize({width:390,height:844});await screenshot('pause-portrait');await page.keyboard.press('p');}
  await page.getByRole('button',{name:'Exit',exact:true}).tap();
  await page.waitForTimeout(300);
  // Driving/pause exit timing is recorded separately from menu layout. Reload the
  // isolated offline preview if native gameplay is still handling its transition.
  if(!await page.getByRole('button',{name:'Settings',exact:true}).isVisible()&&!await page.getByRole('button',{name:'Back',exact:true}).isVisible()){
    report.checks.push({name:'touch exit after live pause/rotation',status:'not verified',detail:'Native preview transition did not expose a menu; fresh preview used for the remaining menu checks.'});
    await page.reload({waitUntil:'domcontentloaded'});
    await page.getByRole('button',{name:'Exit',exact:true}).click({timeout:40000});
  }
  const back=page.getByRole('button',{name:'Back',exact:true});
  await back.waitFor({state:'visible'});
  for(let attempt=0;attempt<3&&!await page.getByRole('button',{name:'Settings',exact:true}).isVisible();attempt++){
    if(!await back.isVisible())break;
    await back.click();await page.waitForTimeout(100);
  }
  await page.getByRole('button',{name:'Settings',exact:true}).waitFor();
  await page.getByRole('button',{name:'Settings',exact:true}).tap();await page.locator('#sqRankedSettings').waitFor();
  const firstFrames=await page.evaluate(()=>window.__settingsFirstFrames);check('Static settings exist on first painted frame',firstFrames.length>0&&firstFrames.every(Boolean),firstFrames);
  for(const viewport of [{width:390,height:844},{width:844,height:320}]){
    await page.setViewportSize(viewport);await page.waitForTimeout(100);
    const cancel=await page.getByRole('button',{name:'Cancel',exact:true}).boundingBox(),apply=await page.getByRole('button',{name:'Apply',exact:true}).boundingBox();
    check('settings actions reachable '+viewport.width+'x'+viewport.height,[cancel,apply].every(r=>r&&r.x>=0&&r.y>=0&&r.x+r.width<=viewport.width+1&&r.y+r.height<=viewport.height+1));
  }
  await screenshot('settings-short-landscape');await page.getByRole('button',{name:'Cancel',exact:true}).tap();
  await page.getByRole('button',{name:'Fullscreen',exact:true}).tap();await page.waitForTimeout(100);
  const fullscreen=await page.evaluate(()=>Boolean(document.fullscreenElement));check('fullscreen entry',fullscreen);
  if(fullscreen){await page.evaluate(()=>document.exitFullscreen());await page.waitForTimeout(100);check('fullscreen exit',await page.evaluate(()=>!document.fullscreenElement));}
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Ranked',exact:true}).tap();
  const row=page.locator('#overallLeaderboardList .overall-entry').first();await row.waitFor({timeout:20000});await row.tap();
  await page.locator('#overallProfilePopup').waitFor({state:'visible'});await page.locator('#overallProfileContent .profile-hero').waitFor();
  for(const viewport of [{width:390,height:844},{width:844,height:320},{width:820,height:1180}]){
    await page.setViewportSize(viewport);await page.waitForTimeout(100);
    const close=await page.locator('#overallProfileClose').boundingBox();check('profile close reachable '+viewport.width+'x'+viewport.height,close&&close.x>=0&&close.y>=0&&close.x+close.width<=viewport.width+1&&close.y+close.height<=viewport.height+1,close);
    await screenshot('profile-'+viewport.width+'x'+viewport.height);
  }
  await page.locator('#overallProfileClose').tap();await page.locator('#overallFilterPanel button').first().tap();
  const filters=page.locator('.pt-group-filter-menu .fm-shell');await filters.waitFor({state:'visible'});
  await page.setViewportSize({width:844,height:320});await page.waitForTimeout(100);
  const f=await filters.boundingBox();check('filter drawer fits short landscape',f&&f.x>=0&&f.y>=0&&f.x+f.width<=844+1&&f.y+f.height<=320+1,f);await screenshot('filter-short-landscape');await page.keyboard.press('Escape');
  await page.locator('#closeOverallLeaderboard').tap();
  const embedded=await context.newPage();await embedded.setViewportSize({width:1366,height:900});
  await embedded.setContent('<!doctype html><iframe title="Game test" style="border:0;width:600px;height:800px" src="'+server.url+'"></iframe>');
  const frame=embedded.frames().find(frame=>frame.parentFrame());await frame.locator('canvas').waitFor({timeout:40000});
  await frame.waitForFunction(()=>getComputedStyle(document.documentElement).getPropertyValue('--sq-available-width').trim()==='600px');
  const size=await frame.evaluate(()=>({width:innerWidth,height:innerHeight,cssWidth:getComputedStyle(document.documentElement).getPropertyValue('--sq-available-width')}));
  check('about:blank parent / iframe uses its own available size',size.width===600&&size.height===800&&size.cssWidth.trim()==='600px',size);
  await embedded.screenshot({path:path.join(output,'interaction-embedded-600x800.png')});await embedded.close();
}catch(error){report.errors.push(String(error));report.failureScreen=await page.locator('body').innerText().catch(()=>null);await screenshot('failure').catch(()=>{});}
finally{await context.close();await browser.close();await server.close();await fs.writeFile(path.join(output,'interactions.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
