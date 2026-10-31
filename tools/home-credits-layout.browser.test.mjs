import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const bundle=fs.readFileSync(new URL('../main.bundle.js',import.meta.url),'utf8');
const nativeCss=JSON.parse(bundle.match(/"\.menu-ui \{(?:\\.|[^"\\])*"/)[0]);
const fontCss=bundle.match(/\* \{\\n\\tfont-style: italic;\\n\\tfont-family: ForcedSquare, Arial, sans-serif;\\n\\tline-height: 1;\\n\}/)[0].replaceAll('\\n','\n').replaceAll('\\t','\t');
const patch=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const rankedCss=[...patch.matchAll(/(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*("(?:\\.|[^"\\])*?")/g)].map(match=>JSON.parse(match[1])).join('\n');
const homeCss=fs.readFileSync(new URL('../home-ui.css',import.meta.url),'utf8');
const responsiveCss=fs.readFileSync(new URL('../responsive-ui.css',import.meta.url),'utf8');
const font=fs.readFileSync(new URL('../forced_square.woff2',import.meta.url)).toString('base64');
const image=name=>'data:image/svg+xml;base64,'+fs.readFileSync(new URL('../images/'+name+'.svg',import.meta.url)).toString('base64');

test('native scaled home credits and three social badges stay inside available space through rotation',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();await page.route('**/*',route=>route.abort());
  const buttons=['Play','Ranked','Profile','Editor','Settings','Help'].map((name,index)=>`<button class="button button-image"><img src="${image(['play','play','play','editor','settings','help'][index])}" alt=""><p>${name}</p></button>`).join('');
  const social=['google_play','discord','reddit'].map(name=>`<a href="#${name}" aria-label="${name}"><img src="${image(name)}" alt="${name}"></a>`).join('');
  // Match native menu/info ancestry, credit text and all three published social assets.
  await page.setContent(`<style>@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,${font})}html,body{margin:0;width:100%;height:100%;overflow:hidden}#ui{position:absolute;transform:scale(var(--ui-scale-factor));transform-origin:0 0}.button{border:0;background:#263e78;color:white}.button-bar{min-height:40px}.menu-ui>.info a{color:white}</style><div id="ui"><div class="menu-ui"><img class="logo" src="${image('logo')}" alt="PolyTrack"><div class="main-buttons-container">${buttons}</div><div class="button-bar"><button>Version 0.6.3</button></div><div class="info sq-brand-intro-complete"><a class="staticFunPill" href="#games"><span class="staticFunText">StaticQuasar931 Games</span></a><a href="#kodub">Kodub.com - Version 0.6.3</a><a href="#music">OpenGameArt.org "Sci-fi Theme" by Maou (CC-BY 4.0)</a><div class="social-links">${social}</div></div></div></div>`);
  await page.addStyleTag({content:fontCss+nativeCss+rankedCss+homeCss+responsiveCss});
  await page.evaluate(async()=>{await document.fonts.ready;await Promise.all([...document.images].map(image=>image.decode()));});
  const matrix=[
   [390,844,390,844,0,0,.4],[440,956,440,956,0,0,.4],
   [956,440,956,330,0,0,.4],[844,390,844,280,0,12,.4],
   [440,800,414,720,26,12,.4],[956,440,900,330,28,0,.4],
   [768,1024,768,1024,0,0,.65],[1024,768,1024,768,0,0,.8],
   [1366,768,1366,768,0,0,.8],[390,844,390,844,0,0,.4]
  ];
  for(const [width,height,availableWidth,availableHeight,left,top,scale]of matrix){
   await page.setViewportSize({width,height});
   await page.evaluate(({availableWidth,availableHeight,left,top,scale})=>{
    const style=document.documentElement.style;
    for(const [key,value]of Object.entries({'--sq-available-width':availableWidth+'px','--sq-available-height':availableHeight+'px','--sq-visible-left':left+'px','--sq-visible-top':top+'px','--ui-scale-factor':scale,'--sq-menu-fit-scale':scale}))style.setProperty(key,String(value));
   },{availableWidth,availableHeight,left,top,scale});
   const result=await page.evaluate(()=>{
    const box=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
    const info=document.querySelector('.menu-ui>.info');
    return {info:box(info),links:[...info.querySelectorAll('a,img')].map(node=>({...box(node),text:node.textContent||node.alt})),
     buttons:[...document.querySelectorAll('.main-buttons-container>.button-image')].map(box),
     bar:box(document.querySelector('.button-bar')),rootTransform:getComputedStyle(document.querySelector('#ui')).transform,
     font:getComputedStyle(info.querySelector('.staticFunText')).fontFamily};
   });
   const message=JSON.stringify({width,height,availableWidth,availableHeight,left,top,scale,result});
   const within=box=>box.x>=left-.5&&box.right<=left+availableWidth+.5&&box.y>=top-.5&&box.bottom<=top+availableHeight+.5;
   assert(within(result.info),message);
   for(const link of result.links){assert(within(link),message);assert(link.width>0&&link.height>0,message);}
   assert(result.info.bottom<=result.bar.y+1,message);
   assert(result.buttons.every(button=>button.bottom<=result.info.y+1),message);
   assert.match(result.rootTransform,/matrix\(/);assert.match(result.font,/ForcedSquare/);
   if(process.env.POLYTRACK_HOME_CREDITS_CAPTURE){
    fs.mkdirSync(process.env.POLYTRACK_HOME_CREDITS_CAPTURE,{recursive:true});
    await page.screenshot({path:path.join(process.env.POLYTRACK_HOME_CREDITS_CAPTURE,`home-${width}x${height}-visible-${availableWidth}x${availableHeight}.png`)});
   }
  }
  await page.locator('.menu-ui>.info').evaluate(node=>node.classList.add('hidden'));
  assert.equal(await page.locator('.menu-ui>.info').isVisible(),false,'native hidden state still wins');
 }finally{await browser.close();}
});
