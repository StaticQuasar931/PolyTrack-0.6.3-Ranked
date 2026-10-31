import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {renderEventPersonalBest} from './client.mjs';
const require=createRequire(new URL('../tools/verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const bundle=fs.readFileSync(new URL('../main.bundle.js',import.meta.url),'utf8');
const nativeCss=['leaderboard','track-info'].map(name=>JSON.parse(bundle.match(new RegExp('"\\.'+name+'-ui \\{(?:\\\\.|[^"\\\\])*"'))[0])).join('\n');
const fontRule=bundle.match(/\* \{\\n\\tfont-style: italic;\\n\\tfont-family: ForcedSquare, Arial, sans-serif;\\n\\tline-height: 1;\\n\}/)[0].replaceAll('\\n','\n').replaceAll('\\t','\t');
const css=fs.readFileSync(new URL('./events.css',import.meta.url),'utf8');
const responsive=fs.readFileSync(new URL('../responsive-ui.css',import.meta.url),'utf8');
const homeCss=fs.readFileSync(new URL('../home-ui.css',import.meta.url),'utf8');
const patch=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const rankedCss=[...patch.matchAll(/(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*("(?:\\.|[^"\\])*?")/g)].map(match=>JSON.parse(match[1])).join('\n');
const font=fs.readFileSync(new URL('../forced_square.woff2',import.meta.url)).toString('base64');
const icon=name=>'data:image/svg+xml;base64,'+fs.readFileSync(new URL('../images/'+name+'.svg',import.meta.url)).toString('base64');

test('event portrait footer keeps native one-row controls and PB slots fit inline across rotation',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.route('**/*',route=>route.abort());
  const back=`<button class="button back">Back</button>`,filter='<button class="button" data-personal-filter-button>Filters</button>',verified=`<button class="button only-verified"><img src="${icon('trophy')}">Only verified</button>`;
  await page.setContent(`<style>@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,${font})}body{margin:0;background:#17234f;color:white}#ui .track-info-ui{position:static!important;display:block!important;width:100vw!important;height:auto!important;padding:0!important;transform:none!important}#ui .track-info-ui>.leaderboard-ui{position:static!important;width:100%!important;height:auto!important;max-width:none!important;transform:none!important}#ui .track-info-ui>.side-panel{width:calc(100% - 32px)!important;max-width:500px!important;margin:16px!important;padding:0!important;box-sizing:border-box}.personal-best{font-size:24px}</style><div id="ui"><div class="track-info-ui"><section class="leaderboard-ui sq-event-board"><div class="button-wrapper">${back}${verified}<button class="button icon-button first sq-event-find-me" aria-label="Find your event result"><img src="${icon('trophy')}"></button></div></section><aside class="side-panel"><div class="personal-best sq-event-personal"></div></aside></div></div>`);
  await page.addStyleTag({content:fontRule+nativeCss+css+homeCss+responsive+rankedCss});
  await page.locator('.track-info-ui').evaluate(node=>node.classList.add('sq-event-layout-ready'));
  await page.evaluate(({render,filter,icons})=>{
   Function('return ('+render+')')()(document.querySelector('.sq-event-personal'),{timeText:'00:20.759',placement:{ordinal:'4th',percentile:'2',text:'4th (2%)',title:'4th of 200 loaded racers.'}});
   for(const [index,image]of [...document.querySelectorAll('.sq-event-personal img')].entries())image.src=icons[index];
   window.addFilter=()=>document.querySelector('.back').insertAdjacentHTML('afterend',filter);
  },{render:String(renderEventPersonalBest),filter,icons:[icon('timer'),icon('trophy')]});
  await page.evaluate(()=>document.fonts.ready);
  await page.evaluate(()=>document.body.classList.add('sq-event-active'));
  for(const [width,height]of [[390,844],[440,956],[956,440],[390,600],[320,568],[390,844]]){
   await page.setViewportSize({width,height});
   for(const withFilter of [false,true]){
    await page.evaluate(withFilter=>{document.querySelector('[data-personal-filter-button]')?.remove();if(withFilter)window.addFilter();},withFilter);
    const result=await page.evaluate(()=>{
     const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
     const footer=document.querySelector('.button-wrapper');
     return {footer:rect(footer),controls:[...footer.children].map(rect),slots:[...document.querySelector('.sq-event-personal').children].map(rect),pb:rect(document.querySelector('.sq-event-personal')),visibility:getComputedStyle(document.querySelector('.sq-event-personal')).visibility,text:document.querySelector('.sq-event-personal').textContent};
    });
    const message=JSON.stringify({width,height,withFilter,result});
    assert.equal(result.visibility,'visible',message);
    if(width>=390&&width<=600&&height>=width){
     assert(result.footer.height<=53,message);assert(result.controls.every(rect=>Math.abs(rect.y-result.controls[0].y)<1&&rect.height>=44),message);
     for(const rect of result.controls)assert(rect.x>=result.footer.x-1&&rect.right<=result.footer.right+1,message);
     assert(Math.abs((result.slots[0].y+result.slots[0].height/2)-(result.slots[1].y+result.slots[1].height/2))<1,message);
    }
    for(const rect of result.slots)assert(rect.x>=result.pb.x-1&&rect.right<=result.pb.right+1,message);
    assert.equal(result.text,'00:20.7594th (2%)');
   }
   if(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR){fs.mkdirSync(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR,{recursive:true});await page.screenshot({path:path.join(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR,`event-row-ui-${width}x${height}.png`),fullPage:true});}
  }
 }finally{await browser.close();}
});
