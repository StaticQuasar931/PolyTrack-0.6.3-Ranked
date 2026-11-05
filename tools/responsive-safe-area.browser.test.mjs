import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
const {chromium}=createRequire(new URL('./verifier/package.json',import.meta.url))('playwright');
const root=new URL('../',import.meta.url);
const patch=await fs.readFile(new URL('polytrack_062_patch.js',root),'utf8');
const injected=[...patch.matchAll(/(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*("(?:\\.|[^"\\])*?")/g)].map(m=>JSON.parse(m[1])).join('\n');
const styles=(await Promise.all(['home-ui.css','responsive-ui.css','help-controls.css'].map(name=>fs.readFile(new URL(name,root),'utf8')))).join('\n');
const sizes=[[320,568],[360,780],[390,844],[430,932],[540,720],[768,1024],[820,1180],[1024,768],[1280,720],[1366,600],[1920,1080],[844,390],[1024,1024],[1366,400]];

test('phone native menus and Ranked reserve physical safe areas through live resize',async()=>{
 const browser=await chromium.launch({headless:true});
 const results=[];
 try{
  const page=await browser.newPage();await page.route('**/*',r=>r.abort());
  await page.setContent(`<style>html,body{margin:0;height:100%}#ui,.menu-ui{position:absolute;inset:0}.track-info-ui{position:absolute;inset:0;display:flex}.track-selection-ui{position:absolute;inset:0}.hidden{display:none!important}#overallLeaderboardPanel{display:none}.overall-shell{animation:none!important}</style><div id="ui"><div class="menu-ui"><div class="track-info-ui"><section class="leaderboard-ui"><h2>Leaderboard</h2><div class="container"><button class="main">Racer</button></div></section><section class="side-panel"><h2>Summer 1</h2><button class="button play">Play</button></section></div><div class="track-selection-ui hidden"><div class="bar"><button>Back</button><input aria-label="Search"></div></div></div></div><div id="overallLeaderboardPanel"><section class="overall-shell"><header class="overall-top"><h2>Ranked</h2><button>Close</button></header><div id="overallLeaderboardList">Racers</div></section></div>`);
  await page.addStyleTag({content:injected+'\n'+styles});
  const cdp=await page.context().newCDPSession(page);
  for(const scale of [1,1.25,1.5])for(const [width,height]of sizes){
   await page.setViewportSize({width,height});
   const insets=height>width?{top:44,bottom:34,left:0,right:0}:{top:0,bottom:21,left:44,right:44};
   await cdp.send('Emulation.setSafeAreaInsetsOverride',{insets});
   await page.evaluate(({width,height,scale})=>{
    const s=document.documentElement.style;s.setProperty('--sq-available-width',width+'px');s.setProperty('--sq-available-height',height+'px');s.setProperty('--sq-ui-scale',scale);s.setProperty('--sq-menu-fit-scale',Math.min(1,width/1150,height/800));
   },{width,height,scale});
   if(width<=600&&height>width){
    for(const selector of ['.track-info-ui','.track-selection-ui']){
     await page.evaluate(selector=>{document.querySelectorAll('.menu-ui>*').forEach(n=>n.classList.toggle('hidden',!n.matches(selector)));},selector);
     const padding=await page.locator(selector).evaluate(n=>{const s=getComputedStyle(n);return Object.fromEntries(['top','right','bottom','left'].map(k=>[k,parseFloat(s.getPropertyValue('padding-'+k))]));});
     results.push({width,height,scale,selector,insets,padding});
     for(const edge of Object.keys(insets))assert.ok(padding[edge]>=insets[edge],JSON.stringify(results.at(-1)));
    }
   }
   await page.evaluate(()=>{document.querySelectorAll('.menu-ui>*').forEach(n=>n.classList.add('hidden'));document.querySelector('#overallLeaderboardPanel').style.display='flex';});
   const shell=await page.locator('.overall-shell').boundingBox();
   results.push({width,height,scale,insets,shell});
   assert.ok(shell.x>=insets.left&&shell.y>=insets.top&&shell.x+shell.width<=width-insets.right+1&&shell.y+shell.height<=height-insets.bottom+1,JSON.stringify(results.at(-1)));
   if(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR&&scale===1&&[320,390,1366].includes(width))await page.screenshot({path:process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR+`/safe-area-${width}x${height}.png`});
   await page.evaluate(()=>document.querySelector('#overallLeaderboardPanel').style.display='none');
  }
 }finally{
  if(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR)await fs.writeFile(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR+'/safe-area-bounds.json',JSON.stringify(results,null,2));
  await browser.close();
 }
});

test('narrow Ranked names stay on one line without overlapping the details row',async()=>{
 const browser=await chromium.launch({headless:true});const results=[];
 try{
  const page=await browser.newPage();await page.route('**/*',r=>r.abort());
  const font=(await fs.readFile(new URL('forced_square.woff2',root))).toString('base64');
  await page.setContent(`<style>@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,${font})}body{margin:0;font-family:ForcedSquare}#overallLeaderboardPanel{display:flex!important}.overall-shell,.overall-entry{animation:none!important;opacity:1!important;transform:none!important}</style><div id="overallLeaderboardPanel"><section class="overall-shell"><div id="overallLeaderboardList"><div class="overall-entry" role="button" tabindex="0" aria-label="View Spyder cant beat this ranked profile"><span class="overall-rank">#1</span><span class="overall-name"><span class="overall-car-model"></span><span class="overall-name-label"><span class="overall-name-main">Spyder cant beat this <span class="profile-badge">BETA</span></span><span class="overall-racer-meta">3rd at rank</span></span></span><div class="overall-mid"><span class="overall-move">Up 1 rank</span><div class="overall-best">Best #1 of 34 Summer 4</div></div><div class="overall-stats"><div class="overall-score">1,842</div><div class="overall-score-unit">Rank points</div></div></div></div></section></div>`);
  await page.addStyleTag({content:injected+'\n'+styles});await page.evaluate(()=>document.fonts.ready);
  for(const [width,height]of sizes){
   await page.setViewportSize({width,height});
   for(const scale of [1,1.25,1.5]){
    await page.evaluate(scale=>document.documentElement.style.setProperty('--sq-ui-scale',scale),scale);
    const result=await page.evaluate(()=>{const rect=s=>document.querySelector(s).getBoundingClientRect().toJSON();return{row:rect('.overall-entry'),name:rect('.overall-name-main'),identity:rect('.overall-name'),details:rect('.overall-mid'),stats:rect('.overall-stats'),whiteSpace:getComputedStyle(document.querySelector('.overall-name-main')).whiteSpace};});
    results.push({width,height,scale,...result});
    if(width<=540){
     assert.equal(result.whiteSpace,'nowrap',JSON.stringify(results.at(-1)));
     assert.ok(result.name.height<=32,JSON.stringify(results.at(-1)));
     assert.ok(result.identity.bottom<=result.details.top+1,JSON.stringify(results.at(-1)));
     assert.ok(result.name.right<=result.row.right+1&&result.stats.right<=result.row.right+1,JSON.stringify(results.at(-1)));
    }
   }
  }
  await page.locator('.overall-entry').focus();assert.equal(await page.locator('.overall-entry').evaluate(n=>n===document.activeElement),true);
 }finally{if(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR)await fs.writeFile(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR+'/ranked-name-bounds.json',JSON.stringify(results,null,2));await browser.close();}
});
