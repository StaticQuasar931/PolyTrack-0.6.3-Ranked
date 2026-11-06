import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const engines=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const engine=process.env.POLYTRACK_LAYOUT_BROWSER==='firefox'?engines.firefox:engines.chromium;
const source=fs.readFileSync(new URL('../main.bundle.js',import.meta.url),'utf8');
const native=JSON.parse(source.match(/"\.menu-ui \{(?:\\.|[^"\\])*"/)[0]);
// Optional downloaded production CSS supports post-deployment visual verification.
const home=fs.readFileSync(process.env.POLYTRACK_HOME_CSS_FIXTURE||new URL('../home-ui.css',import.meta.url),'utf8');
const patch=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');

test('home cards retain the original Kodub bounce, stagger and reduced-motion support',async()=>{
  const browser=await engine.launch({headless:true});
  try{
    const page=await browser.newPage();await page.route('**/*',route=>route.abort());
    await page.setContent('<style>html,body{margin:0}#ui{position:absolute;width:100%;height:100%}</style><div id="ui"><div class="menu-ui"><div class="main-buttons-container">'+
      Array.from({length:6},(_,i)=>`<button class="button-image button-spawn" ${i===5?'id="injectedRankingsBtn"':''} style="animation-delay:${i*.1}s"><p>Play</p></button>`).join('')+'</div></div></div>');
    await page.addStyleTag({content:native+home});
    for(const [width,height]of [[390,844],[844,390],[1366,768],[1920,1080]]){
      await page.setViewportSize({width,height});
      const metrics=await page.locator('.button-image').evaluateAll(buttons=>buttons.map((button,index)=>{
        const animation=button.getAnimations()[0];animation.pause();
        const timing=animation.effect.getTiming(),frames=[];
        for(const fraction of [0,.2,.5,.7,.85,1]){
          animation.currentTime=Number(timing.delay)+Number(timing.duration)*fraction;
          const css=getComputedStyle(button),matrix=new DOMMatrix(css.transform);
          frames.push({x:matrix.a,y:matrix.d,dy:matrix.f,opacity:Number(css.opacity)});
        }
        return {index,delay:timing.delay,duration:timing.duration,name:getComputedStyle(button).animationName,frames};
      }));
      for(const row of metrics){
        assert.equal(row.name,'button-spawn');assert.equal(row.duration,500);
        assert.ok(Math.abs(row.delay-(row.index===5?0:row.index*100))<.001);
        assert.ok(Math.abs(row.frames[0].x-.8)<.001);assert.ok(Math.abs(row.frames[0].dy-50)<.01);
        assert.ok(Math.abs(row.frames[3].x-1)<.001);assert.ok(Math.abs(row.frames[3].dy+10)<.01,'native upward overshoot is retained');
        for(let i=0;i<row.frames.length;i++){
          const f=row.frames[i];assert.ok(f.x>=.799&&f.x<=1.001);assert.equal(f.x,f.y);assert.ok(f.dy>=-10.01&&f.dy<=50.01);
          if(i)assert.ok(f.opacity>=row.frames[i-1].opacity-.01);
        }
        assert.ok(Math.abs(row.frames.at(-1).dy)<.01);
        assert.equal(row.frames.at(-1).opacity,1);
      }
    }
    await page.emulateMedia({reducedMotion:'reduce'});
    for(const value of await page.locator('.button-image').evaluateAll(nodes=>nodes.map(node=>({duration:getComputedStyle(node).animationDuration,delay:getComputedStyle(node).animationDelay})))){
      assert.ok(parseFloat(value.duration)<.001);assert.equal(parseFloat(value.delay),0);
    }
    const trigger=patch.slice(patch.indexOf('  function triggerRankedButtonSpawn('),patch.indexOf('  function cssTimeMs('));
    assert.doesNotMatch(trigger,/offsetWidth|getBoundingClientRect/);
  }finally{await browser.close();}
});
