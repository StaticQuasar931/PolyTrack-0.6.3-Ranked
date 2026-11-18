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

test('a confirmed single podium fills its rail at phone and desktop sizes',{skip:!chromium},async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage();
    await page.route('**/*',route=>route.abort());
    const socialCss=fs.readFileSync(new URL('./profile-social-polish.css',import.meta.url),'utf8');
    const medalIcon=kind=>'data:image/svg+xml,'+encodeURIComponent(fs.readFileSync(resolve(root,'images',
      {gold:'ranked-trophy.svg',silver:'ranked-award.svg',bronze:'ranked-star.svg'}[kind]),'utf8'));
    const scenarios=[
      [{gold:1,silver:0,bronze:0},'gold','rgb(255, 227, 129)',1,true],
      [{gold:0,silver:1200,bronze:0},'silver','rgb(229, 239, 255)',1,true],
      [{gold:0,silver:0,bronze:Number.MAX_SAFE_INTEGER},'bronze','rgb(255, 183, 134)',1,false],
      [{gold:1,silver:0,bronze:3},null,null,3,true],
      [{gold:1,silver:0},null,null,1,true],
    ];
    for(const [width,height] of [[320,740],[768,1024],[1366,768]]){
      await page.setViewportSize({width,height});
      for(const [medals,kind,color,tileCount,useIcon] of scenarios){
        const tiles=compactProfileAchievementMarkup(medals,{showEmpty:true,medalIcon:useIcon?medalIcon:undefined});
        await page.setContent('<style>body{margin:0}'+css+'\n'+socialCss+'</style><div id="overallProfilePopup" style="display:flex"><article class="overall-profile-card" style="--sq-ui-scale:1.25"><div id="overallProfileContent"><div class="profile-hero"><div class="profile-car-column"><div class="overall-car-model"></div><div class="profile-achievement-row profile-podium-wide" data-podium-kind="earned"><span class="profile-achievement-label">Eligible podiums</span><div class="profile-achievement-medals">'+tiles+'</div><span class="profile-ranked-count">28 ranked tracks</span></div></div><div class="profile-identity">Racer profile</div></div></div></article></div>');
        const cards=page.locator('.profile-medal-card');
        assert.equal(await cards.count(),tileCount);
        const rail=page.locator('.profile-achievement-medals');
        const columns=await rail.evaluate(el=>getComputedStyle(el).gridTemplateColumns);
        assert.equal(columns.split(' ').length,kind?1:width===320?2:3,`${width}px: ${columns}`);
        if(!kind){
          assert.equal(await page.locator('.profile-medal-card--single').count(),0);
          continue;
        }
        const card=cards.first();
        await card.evaluate(el=>{
          el.tabIndex=0;
          el.setAttribute('role','button');
          el.title='View podium tracks';
        });
        await page.keyboard.press('Tab');
        assert.equal(await card.evaluate(el=>el.matches(':focus-visible')),true);
        const count=medals[kind];
        const name=count+' '+kind+(count===1?' podium':' podiums');
        assert.equal(await page.getByRole('button',{name,exact:true}).count(),1);
        const layout=await card.evaluate(el=>{
          const b=el.querySelector(':scope > b'),img=el.querySelector(':scope > img');
          const style=getComputedStyle(el),rail=el.parentElement;
          return {fill:Math.abs(el.getBoundingClientRect().width-rail.getBoundingClientRect().width),
            overflow:el.scrollWidth-el.clientWidth,color:style.borderInlineStartColor,focus:style.outlineStyle,
            count:Number(b.textContent),iconAlongside:!img||img.getBoundingClientRect().right<b.getBoundingClientRect().left};
        });
        assert.ok(layout.fill<=1&&layout.overflow<=1,kind+' podium fits at '+width+': '+JSON.stringify(layout));
        assert.equal(layout.count,count);
        assert.equal(layout.color,color);
        assert.equal(layout.focus,'solid');
        assert.equal(layout.iconAlongside,true);
      }
    }
  }finally{await browser.close();}
});
