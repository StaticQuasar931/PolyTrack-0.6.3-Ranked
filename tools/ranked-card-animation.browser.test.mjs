import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const home=fs.readFileSync(new URL('../home-ui.css',import.meta.url),'utf8');
const functions=source.slice(source.indexOf('  function triggerRankedButtonSpawn('),source.indexOf('  const MULTIPLAYER_STUN_SERVERS'));

test('Ranked never flashes before its last native card entrance, including hidden startup and menu returns',async()=>{
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
        const tRankedWord=()=>"Ranked",openRankedPanel=()=>{};
        const isElementVisible=el=>!!el&&el.isConnected&&getComputedStyle(el).display!=="none"&&el.getClientRects().length>0;
        ${code}
        window.injectRankingsButton=injectRankingsButton;
        window.syncRankingsButtonAnimation=syncRankingsButtonAnimation;
      `)();
      window.injectRankingsButton();
    },functions);
    assert.equal(await page.locator('#injectedRankingsBtn').evaluate(el=>getComputedStyle(el).visibility),'hidden');
    await page.evaluate(()=>{
      const container=document.querySelector('.main-buttons-container');
      container.classList.remove('hidden');
      container.querySelectorAll('button:not(#injectedRankingsBtn)').forEach(el=>el.classList.add('button-spawn'));
      window.injectRankingsButton();
      let nativeEnded=0,rankedStarted=0;
      container.addEventListener('animationend',event=>{if(event.target.id!=='injectedRankingsBtn')nativeEnded=performance.now();});
      container.addEventListener('animationstart',event=>{if(event.target.id==='injectedRankingsBtn')rankedStarted=performance.now();});
      const sample=()=>{
        const ranked=document.querySelector('#injectedRankingsBtn');
        const active=[...container.querySelectorAll('button:not(#injectedRankingsBtn)')].some(el=>el.getAnimations().some(animation=>animation.playState!=='finished'));
        window.rankTest.push({active,visible:getComputedStyle(ranked).visibility!=='hidden',nativeEnded,rankedStarted});
        if(!ranked.classList.contains('ranked-ready'))requestAnimationFrame(sample);
      };
      sample();
    });
    await page.waitForSelector('#injectedRankingsBtn.ranked-ready');
    const samples=await page.evaluate(()=>window.rankTest);
    assert.ok(samples.length>10,'sampled the full staggered entrance');
    assert.equal(samples.some(row=>row.active&&row.visible),false,'Ranked stays hidden until native cards finish');
    const last=samples.at(-1);
    assert.ok(last.rankedStarted>=last.nativeEnded,'Ranked entrance starts last');
    await page.evaluate(()=>{
      const container=document.querySelector('.main-buttons-container'),button=document.querySelector('#injectedRankingsBtn');
      container.classList.add('hidden');window.syncRankingsButtonAnimation(button,container);
      container.classList.remove('hidden');window.syncRankingsButtonAnimation(button,container);
    });
    assert.equal(await page.locator('#injectedRankingsBtn').evaluate(el=>el.classList.contains('ranked-ready')),true,'menu return does not replay entrance');
  }finally{await browser.close();}
});
