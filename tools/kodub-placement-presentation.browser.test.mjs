import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';

const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const patch=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const native=fs.readFileSync(new URL('../main.bundle.js',import.meta.url),'utf8');
const start=patch.indexOf('  function compactKodubPersonalBestPlacement(){');
const end=patch.indexOf('  function decoratePersonalBestPodiums(){',start);
const nativeStart=native.indexOf('El=function(e,t){'),nativeEnd=native.indexOf(',Ml=function()',nativeStart);
assert.ok(start>0&&end>start&&nativeStart>0&&nativeEnd>nativeStart);

test('actual native trophy markup stays compact on desktop and mobile without network or new badges',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    await page.route('**/*',route=>route.abort('blockedbyclient'));
    await page.setContent('<style>.side-panel{width:220px}.personal-best>div{display:flex;align-items:center;gap:4px;font:20px monospace}.personal-best img{width:20px;height:20px}.faded{opacity:.6}</style><div class="track-info-ui"><div class="side-panel"><div class="personal-best"></div></div></div>');
    await page.evaluate(({code,nativeCode})=>{
      const record=document.querySelector('.personal-best');
      const R={gn:()=>record},vl=null,He={A:{formatTimeString:()=> '00:16.027'}},qe=position=>`${position}th`;
      const render=Function('R','vl','He','qe',`return (${nativeCode});`)(R,vl,He,qe);
      render({}, {position:4,total:29});
      window.nativeWeeklySelection={trackId:'a'.repeat(64)};window.kodubTrackHistory=new Map();
      document.querySelector('.track-info-ui').__pt062EventWatch={trackId:'a'.repeat(64)};
      window.compact=Function(code+';return compactKodubPersonalBestPlacement;')();
      window.originalTrophy=record.querySelector('img[src="images/trophy.svg"]');
      window.originalTimer=record.firstElementChild;
    },{code:patch.slice(start,end),nativeCode:native.slice(nativeStart+3,nativeEnd)});
    assert.match(await page.locator('.personal-best').innerText(),/4th.*13\.793%/s);
    await page.evaluate(()=>window.compact());
    for(const viewport of [{width:1366,height:768},{width:390,height:844}]){
      await page.setViewportSize(viewport);
      const result=await page.evaluate(()=>{
        window.compact();
        const record=document.querySelector('.personal-best'),row=record.lastElementChild;
        return {text:row.textContent,timer:record.firstElementChild===window.originalTimer,trophy:row.firstElementChild===window.originalTrophy,
          badges:document.querySelectorAll('[data-record-placement]').length,overflow:row.scrollWidth>row.clientWidth};
      });
      assert.equal(result.text,'4th (13.8%)');assert.equal(result.timer,true);assert.equal(result.trophy,true);
      assert.equal(result.badges,0);assert.equal(result.overflow,false);
    }
  }finally{
    await browser.close();assert.equal(browser.isConnected(),false);
  }
});
