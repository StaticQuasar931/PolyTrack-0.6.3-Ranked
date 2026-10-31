import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {finishOrdinal} from '../tools/finish-presentation.mjs';
import {eventOrdinal,eventPlacementPresentation,eventOwnPlacementPresentation,eventSidebarPlacementPresentation,
  renderEventPersonalBest,decorateEventRowPresentation} from './client.mjs';
const require=createRequire(new URL('../tools/verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const bundle=await fs.readFile(new URL('../main.bundle.js',import.meta.url),'utf8');
const nativeCss=['leaderboard','track-info'].map(name=>JSON.parse(bundle.match(
  new RegExp('"\\.'+name+'-ui \\{(?:\\\\.|[^"\\\\])*"'))[0])).join('\n');
const fontRule=bundle.match(/\* \{\\n\\tfont-style: italic;\\n\\tfont-family: ForcedSquare, Arial, sans-serif;\\n\\tline-height: 1;\\n\}/)?.[0];
assert.ok(fontRule,'actual native universal font rule is present');
const nativeFontCss=fontRule.replaceAll('\\n','\n').replaceAll('\\t','\t');
const css=await fs.readFile(new URL('./events.css',import.meta.url),'utf8');
const placementSource=await fs.readFile(new URL('../tools/record-placement.mjs',import.meta.url),'utf8');
const start=placementSource.indexOf('  style.textContent = `'),end=placementSource.indexOf('`;',start+24);
assert.ok(start>=0&&end>start);
const placementCss=placementSource.slice(start+'  style.textContent = `'.length,end)
  .replaceAll('${HOST_CLASS}','sq-record-placement-host').replaceAll('${BADGE_ATTRIBUTE}','data-record-placement');

test('local native/event font and personal-best DOM parity without game boot or backend requests',async()=>{
  const browser=await chromium.launch({headless:true,...process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?
    {executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}});
  let blocked=0;
  try{
    const page=await browser.newPage({viewport:{width:1366,height:768}});
    await page.route('**/*',async route=>{
      const url=new URL(route.request().url()),file={'/forced_square.woff2':'../forced_square.woff2',
        '/images/timer.svg':'../images/timer.svg','/images/trophy.svg':'../images/trophy.svg'}[url.pathname];
      if(url.hostname!=='events-native.test'||!file){blocked++;await route.abort();return;}
      await route.fulfill({body:await fs.readFile(new URL(file,import.meta.url)),contentType:url.pathname.endsWith('.woff2')?'font/woff2':'image/svg+xml'});
    });
    const row=(id,event=false)=>`<section class="leaderboard-ui${event?' sq-event-board':''}" style="height:170px"><div class="container"><button class="button main"><div class="left"><p class="position" id="${id}">4<span>th</span></p><p>00:20.759</p></div></button></div></section>`;
    await page.setContent(`<base href="http://events-native.test/"><style>@font-face{font-family:ForcedSquare;src:url('/forced_square.woff2')}body{margin:20px;font-family:ForcedSquare;color:white;background:#17234f}.compare{display:grid;grid-template-columns:1fr 1fr;gap:20px}.track-info-ui{position:static!important;width:auto!important;height:auto!important}.record,.sq-event-record{font-size:18px}</style><div class="compare">${row('normal-rank')}${row('event-rank',true)}<div class="track-info-ui"><div class="side-panel"><div class="personal-best" id="normal-pb"><div><img src="images/timer.svg"><span>00:20.759</span></div><div><img src="images/trophy.svg">4th<span class="faded"> (2%)</span></div></div></div></div><div class="track-info-ui"><div class="side-panel"><div class="personal-best sq-event-personal" id="event-pb"></div></div></div><div class="record"><span data-record-placement class="sq-record-placement">4/200</span></div><div class="sq-event-record" id="event-record"></div></div>`);
    await page.addStyleTag({content:nativeFontCss+nativeCss+placementCss+css});
    const functions={finishOrdinal,eventOrdinal,eventPlacementPresentation,eventOwnPlacementPresentation,
      eventSidebarPlacementPresentation,renderEventPersonalBest,decorateEventRowPresentation};
    await page.evaluate(sources=>{
      const api={};for(const [name,source]of Object.entries(sources))api[name]=Function(...Object.keys(api),'return ('+source+')')(...Object.values(api));
      api.decorateEventRowPresentation(document.getElementById('event-rank').closest('button'),{rank:4});
      const place={rank:4,knownFieldSize:200};
      api.renderEventPersonalBest(document.getElementById('event-pb'),{timeText:'00:20.759',placement:api.eventSidebarPlacementPresentation(place)});
      const badge=document.createElement('span'),card=api.eventOwnPlacementPresentation(place);badge.className=card.className;badge.textContent=card.text;document.getElementById('event-record').append(badge);
    },Object.fromEntries(Object.entries(functions).map(([name,fn])=>[name,String(fn)])));
    await page.evaluate(()=>document.fonts.ready);
    const result=await page.evaluate(()=>{
      const style=(selector,props)=>{const s=getComputedStyle(document.querySelector(selector));return Object.fromEntries(props.map(k=>[k,s[k]]));};
      return {native:style('#normal-rank>span',['fontFamily','fontSize','opacity']),event:style('#event-rank>span',['fontFamily','fontSize','opacity']),
        nativePb:style('#normal-pb',['fontFamily','fontSize']),eventPb:style('#event-pb',['fontFamily','fontSize']),
        normalBox:style('[data-record-placement]',['fontFamily','fontSize','borderWidth','backgroundColor']),
        eventBox:style('#event-record>span',['fontFamily','fontSize','borderWidth','backgroundColor']),
        eventText:document.querySelector('#event-pb>div:last-child').textContent,font:document.fonts.check('20px ForcedSquare')};
    });
    assert.deepEqual(result.event,result.native);assert.equal(result.event.opacity,'0.3');assert.equal(result.event.fontSize,'20px');
    assert.match(result.event.fontFamily,/ForcedSquare/);
    assert.deepEqual(result.eventPb,result.nativePb);assert.deepEqual(result.eventBox,result.normalBox);
    assert.equal(result.eventText,'4th (2%)');assert.equal(result.font,true);assert.equal(blocked,0);
    if(process.env.EVENT_NATIVE_LOOK_SCREENSHOT){await fs.mkdir(path.dirname(process.env.EVENT_NATIVE_LOOK_SCREENSHOT),{recursive:true});await page.screenshot({path:process.env.EVENT_NATIVE_LOOK_SCREENSHOT});}
  }finally{await browser.close();}
});
