import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {fitKodubCover} from './kodub-weekly.mjs';
const require=createRequire(new URL('../tools/verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=new URL('../',import.meta.url),bundle=fs.readFileSync(new URL('main.bundle.js',root),'utf8');
// Evaluate only raw CSS-loader modules and their inert asset/runtime dependencies.
// This preserves concatenated font/global rules; no native game/physics module is invoked.
const end=bundle.lastIndexOf('},n={};function i(e)');assert(end>0,'native CSS module factory boundary');
const factories=vm.runInNewContext('('+bundle.slice(bundle.indexOf('t={')+2,end+1)+')',{URL}),cache={};
function cssRequire(id){if(cache[id])return cache[id].exports;const module=cache[id]={id,exports:{}};factories[id](module,module.exports,cssRequire);return module.exports;}
cssRequire.d=(exports,names)=>{for(const key in names)Object.defineProperty(exports,key,{get:names[key]});};
cssRequire.o=(object,key)=>Object.hasOwn(object,key);cssRequire.r=exports=>Object.defineProperty(exports,'__esModule',{value:true});
cssRequire.n=exports=>{const getter=exports?.__esModule?()=>exports.default:()=>exports;cssRequire.d(getter,{a:getter});return getter;};cssRequire.p='';cssRequire.b='https://offline.invalid/';
const mainCss=Object.entries(factories).filter(([,factory])=>factory.toString().includes('n(6314)')&&factory.toString().includes('.push([e.id')).map(([id])=>String(cssRequire(id).default??cssRequire(id).A));
assert(mainCss.some(value=>value.includes('.track-selection-ui {')),'Shipped native main CSS is required, not a replacement layout');
const eventsCss=fs.readFileSync(new URL('./events.css',import.meta.url),'utf8');
const current=JSON.parse(fs.readFileSync(new URL('./kodub/current.json',import.meta.url),'utf8')).current;
const cover='data:image/webp;base64,'+fs.readFileSync(new URL('./kodub/'+current.coverUrl,import.meta.url)).toString('base64');
const font=fs.readFileSync(new URL('forced_square.woff2',root)).toString('base64');
const evidence=process.env.PT_EVENT_FIRST_PAINT_EVIDENCE_DIRECTORY;
if(evidence)assert(path.isAbsolute(evidence),'Evidence path must be absolute');
for(const [width,height] of [[1920,1080],[390,844]])test('native and promoted TOTW first paint '+width+'x'+height,{timeout:45000},async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
 const failures=[];
 try{
  for(const promoted of [false,true]){
   const page=await browser.newPage({viewport:{width,height}}),requests=[];
   await page.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
   const card='<div class="track track-of-the-week '+(promoted?'sq-kodub-weekly':'')+'"><button class="button"><img class="cover" src="'+cover+'" alt="Complete weekly track cover"><div class="track-of-the-week-info"><div class="title">Summer1</div><div class="author">By Track Author</div><div class="time-remaining">17h remaining</div><div class="date-range">Weekly event</div><div class="personal-best"><div>00:20.759</div><div>4/200</div></div></div></button></div>';
   const body=promoted?'<section class="sq-featured-events sq-event-track-group"><h2 class="sq-featured-heading">Events</h2>'+card+'</section>':card;
   const styles=mainCss.map(value=>'<style>'+value+'</style>').join('');
   await page.setContent('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">'+styles+'<style>@font-face{font-family:ForcedSquare;src:url('+font.replace(/^/,'data:font/woff2;base64,')+')}html,body{margin:0;width:100%;height:100%;background:#17234f;color:white}#ui{position:absolute;inset:0;--ui-scale-factor:1;--safe-area-left:0px;--safe-area-right:0px;--safe-area-top:0px;--safe-area-bottom:0px}</style><style>'+eventsCss+'</style></head><body><div id="ui"><div class="track-selection-ui with-background"><div class="tracks-container open"><div class="wrapper">'+body+'</div></div></div></div><script>const coverBindings=new WeakMap();window.fitKodubCover='+fitKodubCover.toString()+';fitKodubCover(document.querySelector(".track-of-the-week"));</script></body></html>',{waitUntil:'load'});
   await page.locator('.cover').evaluate(async image=>{await image.decode();await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(resolve));});
   const measure=()=>page.evaluate(()=>{
    const image=document.querySelector('.cover'),card=image.closest('.track'),button=image.closest('.button');
    const box=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const rect=box(image),scale=Math.min(rect.width/image.naturalWidth,rect.height/image.naturalHeight);
    const painted={x:rect.x+(rect.width-image.naturalWidth*scale)/2,y:rect.y+(rect.height-image.naturalHeight*scale)/2,width:image.naturalWidth*scale,height:image.naturalHeight*scale};
    painted.right=painted.x+painted.width;painted.bottom=painted.y+painted.height;
    const clips=[];for(let node=image.parentElement;node&&node!==document.body;node=node.parentElement){const s=getComputedStyle(node);if(['hidden','clip','auto','scroll'].includes(s.overflowY)||['hidden','clip','auto','scroll'].includes(s.overflowX))clips.push({className:node.className,box:box(node),x:s.overflowX,y:s.overflowY});}
    const parents=[];for(let n=image;n;n=n.parentElement){const s=getComputedStyle(n);parents.push({tag:n.tagName,cls:n.className,display:s.display,visibility:s.visibility,width:s.width,height:s.height});}
    return {normalHeight:parseFloat(getComputedStyle(button).getPropertyValue('--event-card-height'))||300,ratio:image.naturalWidth/image.naturalHeight,gap:getComputedStyle(button).rowGap,parents,image:rect,painted,card:box(card),button:box(button),fit:getComputedStyle(image).objectFit,position:getComputedStyle(image).objectPosition,transform:getComputedStyle(image).transform,scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth,clips};
   });
   const metrics=await measure();
   const name=(promoted?'promoted':'native')+'-totw-first-paint-'+width+'x'+height;
   if(evidence){fs.mkdirSync(evidence,{recursive:true});fs.writeFileSync(path.join(evidence,name+'.json'),JSON.stringify({width,height,promoted,requests,metrics},null,2));await page.screenshot({path:path.join(evidence,name+'.png'),fullPage:true});}
   const message=JSON.stringify({width,height,promoted,metrics});
   try{assert.equal(metrics.fit,'contain',message);assert.equal(metrics.transform,'none',message);assert(metrics.image.width>0&&metrics.image.height>0,message);
   assert(metrics.scrollWidth<=width+1,message);assert(metrics.button.height>=metrics.normalHeight-2,message);
   if(width>700){assert(Math.abs(metrics.button.height-metrics.normalHeight)<2,message);assert(Math.abs(metrics.painted.height-metrics.image.height)<2,message);}
   for(const bounds of [metrics.image,metrics.painted]){
    for(const parent of [metrics.button])assert(bounds.x>=parent.x-1&&bounds.right<=parent.right+1&&bounds.y>=parent.y-1&&bounds.bottom<=parent.bottom+1,message);
    assert(bounds.x>=-1&&bounds.right<=width+1,message);
    for(const clip of metrics.clips){if(clip.y!=='visible')assert(bounds.y>=clip.box.y-1&&bounds.bottom<=clip.box.bottom+1,message);if(clip.x!=='visible')assert(bounds.x>=clip.box.x-1&&bounds.right<=clip.box.right+1,message);}
   }
   }catch(error){failures.push(error.message);}
   console.log(name+' measured on initial load; no resize/navigation/reentry');
   await page.evaluate(()=>{document.querySelector('.track-selection-ui').classList.add('hidden');});
   await page.evaluate(()=>{document.querySelector('.track-selection-ui').classList.remove('hidden');fitKodubCover(document.querySelector('.track-of-the-week'));});
   const returned=await measure();assert(Math.abs(returned.button.height-metrics.button.height)<2,JSON.stringify(returned));assert(returned.scrollWidth<=width+1);
   if(evidence){fs.writeFileSync(path.join(evidence,name+'-return.json'),JSON.stringify(returned,null,2));await page.screenshot({path:path.join(evidence,name+'-return.png'),fullPage:true});}
   if(width>700&&promoted){
    await page.locator('.cover').evaluate(async image=>{image.src='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="300"><rect width="300" height="300" fill="teal"/></svg>');await image.decode();});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
    const square=await measure();assert(square.image.width<metrics.image.width-50,'narrower intrinsic art must release horizontal room to details');
    await page.locator('.cover').evaluate(async(image,url)=>{image.src=url;await image.decode();},cover);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));
    const wide=await measure();assert(wide.image.width>square.image.width+50,'wider intrinsic art must use right-hand whitespace');assert(Math.abs(wide.button.height-metrics.button.height)<2,'cover changes must not shorten/grow the rail');assert(Math.abs(wide.painted.height-wide.image.height)<2,'wide art remains full height');
   }
   await page.close();
  }
  assert.equal(failures.length,0,failures.join('\n'));
 }finally{await browser.close();}
});
