import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {startResponsiveServer} from './responsive-server.mjs';
import {RELEASE_INFO} from './release-info.mjs';
import { createRequire } from 'node:module';

const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const home=fs.readFileSync(new URL('../home-ui.css',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('  function triggerRankedButtonSpawn('),source.indexOf('  const MULTIPLAYER_STUN_SERVERS'));

test('Ranked follows the native entrance, never appears during loading, and remains ready on return',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    await page.setContent(`<style>
      .main-buttons-container{display:flex}.hidden{display:none}
      .button-image{width:90px;height:80px}.button-spawn{animation:button-spawn .5s ease-out both}
      @keyframes button-spawn{from{opacity:0;transform:translateY(50px) scale(.8)}to{opacity:1;transform:none}}
    </style><div class="main-buttons-container hidden">${[0,1,2,3,4].map(i=>`<button class="button-image" style="animation-delay:${i*.15}s">Native ${i}</button>`).join('')}</div>`);
    await page.addStyleTag({content:home});
    await page.evaluate(code=>{
      window.rankTest=[];
      new Function(`let rankingsSpawnedOnce=false,rankedSpawnTimer=0,lastRankedSpawnAt=0,mainButtonsWereVisible=false,mainButtonsShownAt=0,nativeMenuButtonsAnimating=false,rankingsButtonRef=null;
        const tRankedWord=()=>"Ranked",openRankedPanel=()=>{},warmOverallFirstPreview=()=>{};
        const isElementVisible=el=>!!el&&el.isConnected&&getComputedStyle(el).display!=="none"&&el.getClientRects().length>0;
        ${code}
        window.injectRankingsButton=injectRankingsButton;
        window.syncRankingsButtonAnimation=syncRankingsButtonAnimation;
      `)();
      window.injectRankingsButton();
    },functions);
    assert.equal(await page.locator('#injectedRankingsBtn').isVisible(),false);
    await page.evaluate(()=>{
      const container=document.querySelector('.main-buttons-container');
      container.classList.remove('hidden');
      container.querySelectorAll('button:not(#injectedRankingsBtn)').forEach(el=>el.classList.add('button-spawn'));
      window.injectRankingsButton();
      let nativeEnded=0,rankedStarted=0,nativeStarted=0;
      container.addEventListener('animationend',event=>{if(event.target.id!=='injectedRankingsBtn')nativeEnded=performance.now();});
      container.addEventListener('animationstart',event=>{if(event.target.id==='injectedRankingsBtn')rankedStarted=performance.now();else nativeStarted=performance.now();});
      const sample=()=>{
        const ranked=document.querySelector('#injectedRankingsBtn');
        const active=[...container.querySelectorAll('button:not(#injectedRankingsBtn)')].some(el=>el.getAnimations().some(animation=>animation.playState!=='finished'));
        window.rankTest.push({active,visible:getComputedStyle(ranked).visibility!=='hidden',nativeEnded,rankedStarted,nativeStarted});
        if(!ranked.classList.contains('ranked-ready'))requestAnimationFrame(sample);
      };
      sample();
    });
    await page.waitForSelector('#injectedRankingsBtn.button-spawn');
    assert.equal(await page.locator('#injectedRankingsBtn').evaluate(button=>{
      button.querySelector('img').dispatchEvent(new Event('animationend',{bubbles:true}));
      return button.classList.contains('button-spawn');
    }),true,'an icon animation cannot finish the whole card entrance');
    await page.waitForSelector('#injectedRankingsBtn.ranked-ready');
    assert.ok(await page.evaluate(()=>rankTest.some(row=>row.rankedStarted>0)),'the native entrance animation actually ran');
    assert.equal(await page.locator('#injectedRankingsBtn').isVisible(),true);
    assert.equal(await page.locator('#injectedRankingsBtn').evaluate(el=>getComputedStyle(el).opacity),'1');
    assert.equal(await page.locator('#injectedRankingsBtn').evaluate(el=>el.classList.contains('ranked-waiting')),false);
    await page.evaluate(()=>{
      const container=document.querySelector('.main-buttons-container'),button=document.querySelector('#injectedRankingsBtn');
      container.classList.add('hidden');window.syncRankingsButtonAnimation(button,container);
      container.classList.remove('hidden');window.syncRankingsButtonAnimation(button,container);
    });
    assert.equal(await page.locator('#injectedRankingsBtn').evaluate(el=>el.classList.contains('ranked-ready')),true,'menu return does not replay entrance');
  }finally{await browser.close();}
});


test('settled home buttons and hidden loaders never leave Ranked waiting or animate it alone',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    for(const [width,height]of [[390,844],[844,390],[1366,768],[2560,1440]])for(const completed of [false,true]){
      const page=await browser.newPage({viewport:{width,height}});await page.route('**/*',route=>route.abort());
      await page.setContent('<style>.hidden{display:none!important}.main-buttons-container{display:flex}.button-image{width:80px;height:70px}</style><div class="loading-screen-ui hidden"></div><div class="main-buttons-container">'+[0,1,2,3,4].map(i=>'<button class="button-image">Native '+i+'</button>').join('')+'</div>');
      await page.addStyleTag({content:home});
      await page.evaluate(({code,completed})=>{
        new Function('completed',`let rankingsSpawnedOnce=completed,rankedSpawnTimer=0,lastRankedSpawnAt=0,mainButtonsWereVisible=false,mainButtonsShownAt=0,nativeMenuButtonsAnimating=false,rankingsButtonRef=null;
          const tRankedWord=()=>"Ranked",openRankedPanel=()=>{},warmOverallFirstPreview=()=>{};
          const isElementVisible=el=>!!el&&el.isConnected&&getComputedStyle(el).display!=="none"&&el.getClientRects().length>0;
          ${code}
          window.injectRankingsButton=injectRankingsButton;window.syncRankingsButtonAnimation=syncRankingsButtonAnimation;
        `)(completed);injectRankingsButton();
      },{code:functions,completed});
      const result=await page.locator('#injectedRankingsBtn').evaluate(b=>({visible:getComputedStyle(b).visibility,opacity:getComputedStyle(b).opacity,ready:b.classList.contains('ranked-ready'),waiting:b.classList.contains('ranked-waiting'),animations:b.getAnimations().length}));
      assert.deepEqual(result,{visible:'visible',opacity:'1',ready:true,waiting:false,animations:0},width+'x'+height+' completed='+completed);
      await page.evaluate(()=>{
        const container=document.querySelector('.main-buttons-container'),button=document.querySelector('#injectedRankingsBtn');
        button.classList.add('button-spawn');container.classList.add('hidden');syncRankingsButtonAnimation(button,container);
        container.classList.remove('hidden');syncRankingsButtonAnimation(button,container);
      });
      assert.equal(await page.locator('#injectedRankingsBtn').evaluate(b=>b.classList.contains('ranked-ready')&&!b.classList.contains('button-spawn')&&!b.classList.contains('ranked-waiting')),true,'interrupted entrances remain settled on return');
      await page.close();
    }
  }finally{await browser.close();}
});


test('actual game home return never gives Ranked a delayed solo entrance',{timeout:120000},async()=>{
 const server=await startResponsiveServer(),browser=await chromium.launch({headless:true});
 try{
  for(const [width,height]of [[390,844],[844,390],[2560,1440]]){
   const page=await browser.newPage({viewport:{width,height},serviceWorkers:'block'});
   await page.addInitScript(number=>{localStorage.setItem('polytrack-site-update-ack-release-v1:'+number,'acknowledged');localStorage.setItem('polytrack-0.6.2-ui-font-scale','125');},RELEASE_INFO.number);
   await page.route('**/*',route=>new URL(route.request().url()).origin===server.url&&['GET','HEAD'].includes(route.request().method())?route.continue():route.abort());
   await page.goto(server.url,{waitUntil:'domcontentloaded'});
   await page.getByRole('button',{name:'Exit',exact:true}).click({timeout:60000});
   await page.evaluate(()=>{
    window.homeEntranceFrames=[];const until=performance.now()+5000;
    const sample=()=>{
     const container=document.querySelector('.main-buttons-container'),ranked=document.getElementById('injectedRankingsBtn');
     if(container?.getClientRects().length&&ranked){
      const native=[...container.querySelectorAll('.button-image:not(#injectedRankingsBtn)')],css=getComputedStyle(ranked),loading=document.querySelector('.loading-screen-ui'),loadingStyle=loading&&getComputedStyle(loading);
      const loadingVisible=!!loading&&loading.getClientRects().length>0&&loadingStyle.visibility!=='hidden'&&Number(loadingStyle.opacity)>0;
      homeEntranceFrames.push({loadingVisible,nativeSpawn:native.some(b=>b.classList.contains('button-spawn')),rankedWaiting:ranked.classList.contains('ranked-waiting'),rankedEntrance:ranked.classList.contains('button-spawn'),rankedOpacity:Number(css.opacity),rankedVisible:css.visibility!=='hidden'});
     }
     if(performance.now()<until)requestAnimationFrame(sample);
    };requestAnimationFrame(sample);
   });
   await page.getByRole('button',{name:'Back',exact:true}).click();
   await page.locator('.main-buttons-container').waitFor({state:'visible'});
   await page.waitForTimeout(1000);
   const frames=await page.evaluate(()=>homeEntranceFrames);assert.ok(frames.length>5);
   const settledNative=frames.filter(f=>!f.nativeSpawn&&!f.loadingVisible);assert.ok(settledNative.length>5);
   assert.deepEqual(settledNative.filter(f=>f.rankedEntrance||!f.rankedVisible||f.rankedOpacity<.99),[],width+'x'+height+': no delayed solo Ranked entrance');
   await page.close();
  }
 }finally{await browser.close();await server.close();}
});
