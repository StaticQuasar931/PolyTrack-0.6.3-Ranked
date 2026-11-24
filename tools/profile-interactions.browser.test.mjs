import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
function extract(name){
  const start=source.search(new RegExp('^  function '+name+'\\(','m'));
  assert.ok(start>=0,name);const tail=source.slice(start),end=tail.indexOf('\n  }');
  assert.ok(end>0,name);return tail.slice(0,end+4);
}
const css=[...source.matchAll(/(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*("(?:\\.|[^"\\])*?")/g)].map(m=>JSON.parse(m[1])).join('\n')+'\n'+fs.readFileSync(new URL('../home-ui.css',import.meta.url),'utf8');
const fontCss='@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,'+fs.readFileSync(new URL('../forced_square.woff2',import.meta.url)).toString('base64')+') format("woff2")}body{font-family:ForcedSquare,sans-serif;color:#fff}';
const require=createRequire(import.meta.url);
let chromium;try{({chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'));}catch{}
test('profile sorting keeps existing controls and previews; dialog focus respects user actions',{skip:!chromium},async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage({viewport:{width:1024,height:768}});
    await page.route('**/*',route=>route.abort());
    await page.setContent('<button id="opener">Racer</button><div id="overallProfilePopup" style="display:none"><article class="overall-profile-card"><header class="profile-dialog-toolbar"><span>Racer profile</span><button id="overallProfileClose" class="button overall-action-btn">Close</button></header><div id="overallProfileContent"><details class="profile-customizer" open><summary>Racer Studio</summary><input id="draft" value="Unsaved favorite"></details><details class="profile-more-stats" open><summary>More profile stats</summary>Stats</details><section class="profile-track-history"><header><h4>Loaded results</h4><button class="profile-track-percent-sort" data-profile-sort="percent">Top %</button></header><div class="profile-track-head">'+['track','weight','place','time'].map(key=>'<button data-profile-sort="'+key+'">'+key+'</button>').join('')+'</div><div class="profile-track-list"></div></section><div style="height:400px"></div></div></article></div>');
    await page.addStyleTag({content:fontCss+css});await page.evaluate(()=>document.fonts.ready);
    await page.evaluate(()=>{
      window.profileSort='place';window.profileSortDirection=1;window.overallDialogReturnFocus=null;
      window.profileCleanup={podium:0,community:0};
      window.closeProfilePodiumDetails=()=>window.profileCleanup.podium++;
      window.cleanupCommunityBadgeViews=()=>window.profileCleanup.community++;
      window.knownFinishWeight=row=>row.weight;
      window.trackInfo=id=>({name:({a:'Alpine Long Track',b:'Bayside',c:'Canyon'})[id]});
      window.isElementVisible=node=>!!node?.getClientRects().length&&getComputedStyle(node).display!=='none';
      const content=document.querySelector('#overallProfileContent');
      content.__profileFinishes=[{trackId:'a',rank:3,fieldSize:20,timeMs:18000,weight:1.3},{trackId:'b',rank:2,fieldSize:8,timeMs:28000,weight:2},{trackId:'c',rank:null,fieldSize:0,timeMs:0,weight:null}];
      content.querySelector('.profile-track-list').innerHTML=content.__profileFinishes.map(row=>'<button type="button" class="profile-track-row" data-track-id="'+row.trackId+'"><span class="profile-track-visual"><span class="profile-track-image-frame"></span></span><span class="profile-track-name"><b>'+trackInfo(row.trackId).name+'</b><small>Extra track</small></span><span class="profile-track-weight"><b>Ranked</b><small>Weight available</small></span><span class="profile-track-result"><b>'+(row.rank?'#'+row.rank+' of '+row.fieldSize:'Result not loaded')+'</b><small>Saved result</small></span><time>00:28.000<small>PB Oct 10, 2026</small></time></button>').join('');
      window.originalNodes=[...content.querySelectorAll('.profile-track-row')];
      window.clicks=0;originalNodes[0].addEventListener('click',()=>window.clicks++);
      window.frames=[];
    });
    const functions=['visibleDialogFocusables','closeRankedDialog','openRankedDialog','sortProfileFinishes','sortProfileTrackRows'];
    await page.addScriptTag({content:'(()=>{const requestAnimationFrame=fn=>window.frames.push(fn);'+functions.map(extract).join('\n')+';Object.assign(window,{'+functions.join(',')+'});})();'});
    // Exercise the real delegated click branch, not a second sorting implementation.
    const sortBranch=source.slice(source.indexOf('      const profileSortTarget='),source.indexOf('      const racerRow=',source.indexOf('      const profileSortTarget=')));
    assert.doesNotMatch(sortBranch,/openRankedProfile/);
    await page.addScriptTag({content:'document.addEventListener("click",event=>{'+sortBranch+'});'});
    await page.locator('#opener').focus();
    await page.evaluate(()=>{openRankedDialog(document.querySelector('#overallProfilePopup'),document.querySelector('#overallProfileClose'));frames.shift()();});
    assert.equal(await page.evaluate(()=>document.activeElement.id),'overallProfileClose');
    await page.locator('#draft').fill('My draft remains');
    await page.evaluate(()=>openRankedDialog(document.querySelector('#overallProfilePopup'),document.querySelector('#overallProfileClose')));
    assert.equal(await page.evaluate(()=>frames.length),0,'refreshing an open dialog must not schedule another focus reset');
    assert.equal(await page.evaluate(()=>document.activeElement.id),'draft');
    for(const [key,expected] of [['time',['a','b','c']],['time',['b','a','c']],['weight',['b','a','c']],['place',['b','a','c']],['percent',['a','b','c']],['percent',['b','a','c']],['track',['a','b','c']]]){
      await page.locator('[data-profile-sort="'+key+'"]').click();
      assert.deepEqual(await page.locator('.profile-track-row').evaluateAll(nodes=>nodes.map(node=>node.dataset.trackId)),expected);
      assert.equal(await page.locator('[data-profile-sort="'+key+'"]').getAttribute('aria-pressed'),'true');
      assert.equal(await page.evaluate(()=>document.activeElement.dataset.profileSort),key);
      assert.equal(await page.locator('#draft').inputValue(),'My draft remains');
      assert.equal(await page.locator('.profile-customizer').getAttribute('open'),'');
      assert.equal(await page.locator('.profile-more-stats').getAttribute('open'),'');
      assert.equal(await page.evaluate(()=>originalNodes.every(node=>document.querySelector('[data-track-id="'+node.dataset.trackId+'"]')===node)),true,'reuse row and thumbnail nodes');
    }
    await page.locator('[data-track-id="a"]').click();assert.equal(await page.evaluate(()=>clicks),1,'existing row listeners survive');
    for(const [width,height] of [
      [320,568],[360,800],[375,667],[390,844],[393,852],[412,915],[430,932],
      [568,320],[667,375],[740,360],[844,390],[915,412],[932,430],[384,216],
      [768,1024],[820,1180],[1024,768],[900,700],[1000,768],[1280,720],
      [1280,800],[1366,768],[1536,864],[1920,1080],[2560,1440],[3440,1440]
    ]){
      await page.setViewportSize({width,height});
      const dimensions=await page.locator('.profile-track-history').evaluate(node=>({client:node.clientWidth,scroll:node.scrollWidth}));
      assert.ok(dimensions.scroll<=dimensions.client+2,'track controls fit '+width+'x'+height);
      if(width<=1000){for(const selector of ['.profile-track-weight','.profile-track-row>time'])assert.equal(await page.locator(selector).first().isVisible(),true,'PB and weight remain visible at '+width+'x'+height);}
      for(const key of ['track','weight','place','percent','time']){
        await page.locator('[data-profile-sort="'+key+'"]').scrollIntoViewIfNeeded();
        const button=await page.locator('[data-profile-sort="'+key+'"]').boundingBox();
        assert.ok(button.x>=0&&button.x+button.width<=width+1&&button.height>=40,'usable sort button at '+width+'x'+height);
      }
    }
    if(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR){await page.setViewportSize({width:390,height:844});await page.locator('.profile-track-head').scrollIntoViewIfNeeded();await page.screenshot({path:process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR+'/profile-390.png'});}
    await page.evaluate(()=>closeRankedDialog(document.querySelector('#overallProfilePopup')));
    assert.equal(await page.evaluate(()=>document.activeElement.id),'opener');
    assert.deepEqual(await page.evaluate(()=>window.profileCleanup),{podium:1,community:1});
    await page.evaluate(()=>{const dialog=document.querySelector('#overallProfilePopup');openRankedDialog(dialog);closeRankedDialog(dialog);frames.shift()();});
    assert.equal(await page.evaluate(()=>document.activeElement.id),'opener','closed dialog cannot take focus on the next frame');
    await page.evaluate(()=>{openRankedDialog(document.querySelector('#overallProfilePopup'));document.querySelector('#draft').focus();frames.shift()();});
    assert.equal(await page.evaluate(()=>document.activeElement.id),'draft','a deliberate focus choice wins over the scheduled default');
  }finally{await browser.close();}
});


test('planner filter buttons fit portrait, landscape and tablet widths',{skip:!chromium},async()=>{
 const browser=await chromium.launch({headless:true});
 try{const page=await browser.newPage();await page.route('**/*',route=>route.abort());
 await page.setContent('<main style="width:calc(100% - 24px);margin:12px"><div class="profile-guide"><div id="filters"></div></div></main>');
 await page.addStyleTag({content:css+'\n'+fontCss});
 await page.addScriptTag({content:'let plannerCurrentTracksOnly=true,plannerOfficialOnly=false;'+extract('plannerFilterMarkup')+';document.getElementById("filters").innerHTML=plannerFilterMarkup();'});
 await page.evaluate(()=>document.fonts.ready);
 for(const width of [320,390,768,844,1280]){await page.setViewportSize({width,height:800});
 const result=await page.locator('.profile-guide-filters').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth,buttons:[...el.querySelectorAll('button')].map(b=>({left:b.getBoundingClientRect().left,right:b.getBoundingClientRect().right,height:b.getBoundingClientRect().height,pressed:b.getAttribute('aria-pressed')}))}));
 assert.ok(result.scroll<=result.width+1);assert.equal(result.buttons.length,2);
 for(const button of result.buttons){assert.ok(button.left>=0&&button.right<=width);assert.ok(button.height>=32);}
 assert.equal(result.buttons[0].pressed,'true');assert.equal(result.buttons[1].pressed,'false');
 }
 }finally{await browser.close();}
});


test('planner recalculation keeps its controls and scroll anchor in place',{skip:!chromium},async()=>{
 const browser=await chromium.launch({headless:true});try{
 const page=await browser.newPage({viewport:{width:1366,height:900}});const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));await page.route('**/*',route=>route.abort());
 await page.setContent('<div id="overallProfilePopup" data-profile-user="self" style="display:block"><article class="overall-profile-card" style="height:600px;overflow:auto"><div id="overallProfileContent"><div style="height:700px"></div><details class="profile-guide" open><summary>Plan</summary><div class="profile-guide-body"><header><div><div class="profile-guide-controls"><label class="profile-guide-metric">Improve <select data-planner-metric><option>Overall RP</option></select></label><label class="profile-guide-metric">Sort by <select data-planner-sort><option>Biggest benefit</option></select></label><span id="controls"></span></div></div></header><div style="height:800px"></div></div></details></div></article></div>');
 await page.addStyleTag({content:fontCss+css});
 await page.addScriptTag({content:'let plannerCurrentTracksOnly=false,plannerOfficialOnly=false,plannerMetric="overall",plannerSort="impact";const cleanUserId=x=>x,isElementVisible=()=>true;let finish;const cachedProfileGuideMarkup=()=>new Promise(resolve=>finish=resolve);'+extract('plannerFilterMarkup')+';'+extract('refreshProfilePlanner')+';document.getElementById("controls").outerHTML=plannerFilterMarkup();window.refresh=()=>{const content=document.getElementById("overallProfileContent"),popup=document.getElementById("overallProfilePopup"),profileCard=content.closest("article");window.originalGuide=content.querySelector(".profile-guide");return refreshProfilePlanner(content,{entry:{userId:"self"},popup,profileCard});};window.calculationReady=()=>typeof finish==="function";window.complete=()=>{const clone=originalGuide.cloneNode(true);clone.removeAttribute("aria-busy");finish(clone.outerHTML);};'});
 await page.evaluate(()=>document.fonts.ready);
 assert.deepEqual(pageErrors,[]);
 await page.locator('[data-planner-filter="official"]').scrollIntoViewIfNeeded();await page.locator('[data-planner-filter="official"]').focus();
 const before=await page.locator('.overall-profile-card').evaluate(el=>({scroll:el.scrollTop,height:el.scrollHeight}));const top=await page.locator('[data-planner-filter="official"]').evaluate(el=>el.getBoundingClientRect().top);
 await page.evaluate(()=>{window.pending=refresh();});
 assert.equal(await page.evaluate(()=>originalGuide.isConnected),true,'keep the visible plan while computing');
 assert.equal(await page.locator('.overall-profile-card').evaluate(el=>el.scrollHeight),before.height);
 assert.equal(await page.locator('.profile-guide-status').textContent(),'Recalculating plan...');
 await page.waitForFunction(()=>window.calculationReady());
 await page.evaluate(async()=>{complete();await pending;});
 const afterTop=await page.locator('[data-planner-filter="official"]').evaluate(el=>el.getBoundingClientRect().top);assert.ok(Math.abs(afterTop-top)<=1);assert.equal(await page.evaluate(()=>document.activeElement.getAttribute('data-planner-filter')),'official');
 for(const width of [320,390,768,1366]){await page.setViewportSize({width,height:900});const bounds=await page.locator('.profile-guide-controls').evaluate(el=>({client:el.clientWidth,scroll:el.scrollWidth,items:[...el.querySelectorAll('label,button')].map(n=>({x:n.getBoundingClientRect().left,right:n.getBoundingClientRect().right,y:n.getBoundingClientRect().top}))}));assert.ok(bounds.scroll<=bounds.client+1);for(const item of bounds.items)assert.ok(item.x>=0&&item.right<=width+1);if(width===1366)assert.ok(Math.max(...bounds.items.map(n=>n.y))-Math.min(...bounds.items.map(n=>n.y))<12,'desktop controls share a row');}
 }finally{await browser.close();}
});
