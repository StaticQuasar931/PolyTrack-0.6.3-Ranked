import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {startResponsiveServer} from './responsive-server.mjs';
import {installNativeRankedAuditFixture} from './native-ranked-audit-fixture.mjs';
const {chromium,webkit}=createRequire(new URL('./verifier/package.json',import.meta.url))('playwright');

test('native track screens keep tabs, chips and controls contained through phone rotations',{timeout:240000},async()=>{
 const server=await startResponsiveServer(),safari=process.env.POLYTRACK_PHONE_BROWSER==='webkit';
 const browser=await(safari?webkit:chromium).launch(safari?{headless:true}:{headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
 try{
  const page=await browser.newPage({viewport:{width:440,height:800},isMobile:true,hasTouch:true});
  await installNativeRankedAuditFixture(page,{rejectWrites:true});
  await page.route(url=>url.origin!==new URL(server.url).origin,route=>new URL(route.request().url()).pathname==='/v6/user'?route.fulfill({status:200,contentType:'application/json',body:'null'}):route.abort('blockedbyclient'));
  await page.goto(server.url,{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'Exit',exact:true}).click({timeout:60000});
  await page.locator('.track-selection-ui:not(.hidden)').waitFor();
  const capture=async label=>{
   if(!process.env.POLYTRACK_PHONE_CAPTURE)return;
   await fs.mkdir(process.env.POLYTRACK_PHONE_CAPTURE,{recursive:true});
   await page.screenshot({path:`${process.env.POLYTRACK_PHONE_CAPTURE}/${label}.png`});
  };
  const sizes=[[440,800],[956,440],[390,720],[844,390],[320,568],[568,320],[600,800],[800,600],[440,800]];
  for(const [width,height]of sizes){
   await page.setViewportSize({width,height});
   await page.waitForFunction(width=>Math.abs(parseFloat(document.documentElement.style.getPropertyValue('--sq-available-width'))-width)<2,width);
   const boxes=await page.locator('.track-selection-ui>.bar,.track-selection-ui>.image-button-container,.track-selection-ui>.image-button-container>button').evaluateAll(nodes=>nodes.map(n=>({name:n.textContent.trim(),...n.getBoundingClientRect().toJSON()})));
   for(const box of boxes)assert.ok(box.x>=-1&&box.right<=width+1,JSON.stringify({width,height,box}));
  }
  await capture('selection-portrait');
  await page.getByRole('button',{name:'Community tracks',exact:true}).click();
  await page.locator('.tracks-container.open .sq-featured-events .sq-kodub-weekly').waitFor({timeout:30000});
  for(const [width,height]of [[440,800],[956,440],[390,720],[844,390],[768,1024],[1024,768],[440,800]]){
   await page.setViewportSize({width,height});
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const cards=await page.locator('.tracks-container.open .sq-featured-events .sq-kodub-weekly,.tracks-container.open .sq-featured-events .sq-permanent-track,.tracks-container.open .sq-featured-events .sq-event-card').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().toJSON()));
   assert.equal(cards.length,4);
   for(const box of cards)assert.ok(box.x>=-1&&box.right<=width+1,JSON.stringify({width,height,box}));
   await capture(`events-${width}x${height}`);
  }
  await page.getByRole('button',{name:'Official tracks',exact:true}).click();
  await page.locator('.track-title').filter({hasText:/^Summer 1$/}).first().click();
  await page.locator('.leaderboard-ui button.main .verified-state').first().waitFor({timeout:45000});
  assert.equal(await page.locator('.track-info-ui>.side-panel>.opponents-container.no-opponents').textContent(),'Select racers from the leaderboard to race against.');
  for(const [width,height]of sizes){
   await page.setViewportSize({width,height});
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const result=await page.evaluate(()=>{
    const host=document.querySelector('.track-info-ui'),footer=host.querySelector('.leaderboard-ui>.button-wrapper');
    const chips=[...host.querySelectorAll('button.main .verified-state')].map(n=>({rect:n.getBoundingClientRect().toJSON(),row:n.closest('button.main').getBoundingClientRect().toJSON(),textWidth:n.scrollWidth,clientWidth:n.clientWidth}));
    const state=host.querySelector('button.main .verified-state');
    if(state){
     const classes=state.className,label=state.querySelector('.sq-integrity-label'),text=label?.textContent;
     state.classList.remove('verified');state.classList.add('pending');if(label)label.textContent='WAITING';
     chips.push({rect:state.getBoundingClientRect().toJSON(),row:state.closest('button.main').getBoundingClientRect().toJSON(),textWidth:state.scrollWidth,clientWidth:state.clientWidth});
     state.className=classes;if(label)label.textContent=text;
    }
    return{host:host.getBoundingClientRect().toJSON(),footer:footer.getBoundingClientRect().toJSON(),chips};
   });
   assert.ok(result.host.x>=-1&&result.host.right<=width+1,JSON.stringify({width,height,result}));
   assert.ok(result.chips.length>0);
   for(const chip of result.chips){
    assert.ok(chip.rect.x>=chip.row.x-1&&chip.rect.right<=chip.row.right+1,JSON.stringify({width,height,chip}));
    assert.ok(chip.rect.width<chip.row.width*.65,'Status remains a chip, not a stretched row: '+JSON.stringify({width,height,chip}));
    assert.ok(chip.textWidth<=chip.clientWidth+1,'Status text is not clipped: '+JSON.stringify({width,height,chip}));
   }
   if(width>=390&&width<=600&&height>width)assert.ok(result.footer.height<=56,JSON.stringify({width,height,footer:result.footer}));
   await capture(`board-${width}x${height}`);
  }
  // Safari tab/address bars can reduce the visible height without changing innerHeight.
  for(const [width,height,visibleHeight,top]of [[956,440,330,0],[844,390,280,12],[956,440,440,0]]){
   await page.setViewportSize({width,height});
   await page.evaluate(({visibleHeight,top})=>{
    Object.defineProperty(visualViewport,'height',{configurable:true,get:()=>visibleHeight});
    Object.defineProperty(visualViewport,'offsetTop',{configurable:true,get:()=>top});
    visualViewport.dispatchEvent(new Event('resize'));
   },{visibleHeight,top});
   await page.waitForFunction(value=>parseFloat(document.documentElement.style.getPropertyValue('--sq-available-height'))===value,visibleHeight);
   const controls=await page.locator('.track-info-ui .leaderboard-ui>.pages,.track-info-ui .leaderboard-ui>.button-wrapper,.track-info-ui>.side-panel>.play').evaluateAll(nodes=>nodes.map(n=>({name:n.textContent,...n.getBoundingClientRect().toJSON()})));
   for(const box of controls)assert.ok(box.top>=top-1&&box.bottom<=top+visibleHeight+1,JSON.stringify({width,height,visibleHeight,top,box}));
   await capture(`safari-chrome-${width}x${height}-${visibleHeight}`);
  }
  await page.evaluate(()=>{delete visualViewport.height;delete visualViewport.offsetTop;visualViewport.dispatchEvent(new Event('resize'));});
  await page.locator('.track-info-ui .leaderboard-ui>.button-wrapper>.back').click();
  await page.getByRole('button',{name:'Community tracks',exact:true}).click();
  await page.locator('.tracks-container.open .sq-event-card[data-event-kind="weekly"]').click();
  await page.locator('.sq-event-board button.main').first().waitFor({timeout:45000});
  await page.waitForFunction(()=>[...document.querySelectorAll('.sq-event-board button.main')].slice(0,4).every(row=>{
   const label=row.querySelector('.sq-event-car-unavailable');return !label||label.hidden||label.textContent!=='Loading car';
  }),null,{timeout:40000});
  const carResults=await page.locator('.sq-event-board button.main').evaluateAll(rows=>rows.slice(0,4).map(row=>({alt:row.querySelector('.image-container img')?.alt,label:row.querySelector('.sq-event-car-unavailable')?.textContent,labelHidden:row.querySelector('.sq-event-car-unavailable')?.hidden})));
  console.log('First four event car previews: '+JSON.stringify(carResults));
  for(const [width,height]of [[440,800],[956,330],[390,720]]){
   await page.setViewportSize({width,height});
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   const footer=await page.locator('.sq-event-board>.button-wrapper').boundingBox();
   assert.ok(footer.y+footer.height<=height+1,JSON.stringify({width,height,footer}));
   if(height>width)assert.ok(footer.height<=56,JSON.stringify({width,height,footer}));
   await capture(`weekly-${width}x${height}`);
  }
 }finally{await browser.close();await server.close();}
});
