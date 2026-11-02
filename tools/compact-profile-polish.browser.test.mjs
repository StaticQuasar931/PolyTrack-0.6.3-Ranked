import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compactProfileParticipationMarkup,compactProfileAchievementMarkup} from './profile-compact-presentation.mjs';
const root=process.env.POLYTRACK_AUDIT_REPO||fileURLToPath(new URL('../',import.meta.url));
const source=fs.readFileSync(resolve(root,'polytrack_062_patch.js'),'utf8');
const css=[...source.matchAll(/(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*("(?:\\.|[^"\\])*?")/g)].map(m=>JSON.parse(m[1])).join('\n')+'\n'+fs.readFileSync(resolve(root,'home-ui.css'),'utf8')+'\n'+fs.readFileSync(resolve(root,'responsive-ui.css'),'utf8');
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
let chromium;try{({chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'));}catch{}
test('compact profiles keep car spacing, tabs, and close controls inside the card',{skip:!chromium},async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage();
    await page.route('**/*',route=>route.abort());
    await page.setContent('<style>body{margin:0}</style><div id="overallProfilePopup" style="display:flex"><article class="overall-profile-card"><header class="profile-dialog-toolbar"><span>Racer profile - Filtered results</span><button id="overallProfileClose" class="button">Close</button></header><div class="profile-hero"><div class="profile-car-column"><span class="overall-car-model"></span><div class="profile-achievement-row">Eligible podiums</div></div><div>Racer profile</div></div><details class="profile-customizer" open><summary>Racer Studio</summary><div class="profile-customizer-body"><section class="profile-customizer-preview">Live preview</section><div class="profile-customizer-controls"><div class="studio-tabs" role="tablist">'+['NAMEPLATE','NAME','CAR','IDENTITY'].map(label=>'<button class="studio-tab" role="tab">'+label+'</button>').join('')+'</div><div style="height:600px">Options</div><button class="studio-close-bottom">Close Racer Studio</button></div></div></details></article></div>');
    await page.addStyleTag({content:css});
    const summaries=compactProfileParticipationMarkup({officialCount:28,communityCount:52,extraCount:1234,customCount:1240},1234)+
      '<div class="profile-achievement-row">'+compactProfileAchievementMarkup({gold:0,silver:0,bronze:0})+'</div>';
    await page.locator('.profile-customizer').evaluate((node,html)=>node.insertAdjacentHTML('beforebegin',html),summaries);
    for(const [width,height] of [[320,568],[390,844],[460,700],[568,320],[844,390],[768,1024],[1024,768],[1366,768],[384,216]]){
      await page.setViewportSize({width,height});
      await page.locator('.overall-profile-card').evaluate(el=>el.scrollTop=0);
      const layout=await page.evaluate(()=>{
        const card=document.querySelector('.overall-profile-card'),tabs=document.querySelector('.studio-tabs'),car=document.querySelector('.profile-car-column');
        const close=document.querySelector('#overallProfileClose').getBoundingClientRect();
        return {cardWidth:card.clientWidth,cardContent:card.scrollWidth,tabWidth:tabs.clientWidth,tabContent:tabs.scrollWidth,carMargin:parseFloat(getComputedStyle(car).marginTop),carPadding:parseFloat(getComputedStyle(car).paddingTop),close:{left:close.left,right:close.right,top:close.top,bottom:close.bottom},buttons:[...tabs.children].map(el=>({width:el.clientWidth,content:el.scrollWidth,height:el.getBoundingClientRect().height}))};
      });
      const label=width+'x'+height;
      assert.ok(layout.cardContent<=layout.cardWidth+2,'profile horizontal overflow at '+label);
      const summary=await page.locator('.profile-participation').evaluate(node=>({width:node.clientWidth,content:node.scrollWidth,height:node.getBoundingClientRect().height}));
      assert.ok(summary.content<=summary.width+1,'participation stays inside the card at '+label);
      assert.ok(summary.height<=120,'participation remains compact at '+label);
      assert.equal(await page.locator('.profile-no-medals').innerText(),'No eligible podiums yet');
      assert.ok(layout.tabContent<=layout.tabWidth+2,'studio tabs overflow at '+label);
      assert.ok(layout.buttons.every(b=>b.content<=b.width+1&&b.height>=44),'readable touch tabs at '+label);
      assert.ok(layout.close.left>=0&&layout.close.right<=width&&layout.close.top>=0&&layout.close.bottom<=height,'close accessible at '+label);
      for(const scrollTop of [0,120,400]){
        const gap=await page.locator('.overall-profile-card').evaluate((card,scrollTop)=>{
          card.scrollTop=scrollTop;
          return card.querySelector('.profile-dialog-toolbar').getBoundingClientRect().top-card.getBoundingClientRect().top-card.clientTop;
        },scrollTop);
        assert.ok(Math.abs(gap)<=1,'toolbar stays flush at '+label+' scroll '+scrollTop+': '+gap);
      }
      if(width<=620){assert.equal(layout.carMargin,0);assert.equal(layout.carPadding,0);}
      await page.locator('.studio-close-bottom').scrollIntoViewIfNeeded();
      const bottom=await page.locator('.studio-close-bottom').boundingBox();
      assert.ok(bottom.y>=0&&bottom.y+bottom.height<=height+1,'studio end reachable at '+label);
    }
  }finally{await browser.close();}
});

test('Ranked help and loading decoration respect reduced motion',{skip:!chromium},async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage();
    await page.setContent('<div id="overallLeaderboardPanel" style="display:flex"><div class="overall-shell"><aside class="overall-help-card">Help</aside><div class="overall-entry">Racer</div><div class="overall-loading-bar"></div><div class="overall-freshness is-loading">Loading</div></div></div>');
    await page.addStyleTag({content:css});
    for(const system of [true,false]){
      await page.emulateMedia({reducedMotion:system?'reduce':'no-preference'});
      await page.evaluate(system=>document.documentElement.classList.toggle('sq-reduced-effects',!system),system);
      const styles=await page.evaluate(()=>[
        getComputedStyle(document.querySelector('.overall-help-card')).animationName,
        getComputedStyle(document.querySelector('.overall-entry')).animationName,
        getComputedStyle(document.querySelector('.overall-entry'),'::after').animationName,
        getComputedStyle(document.querySelector('.overall-loading-bar'),'::after').animationName,
        getComputedStyle(document.querySelector('.overall-freshness'),'::before').animationName
      ]);
      assert.deepEqual(styles,['none','none','none','none','none']);
      assert.equal(await page.locator('.overall-entry').evaluate(n=>getComputedStyle(n).opacity),'1');
    }
  }finally{await browser.close();}
});
