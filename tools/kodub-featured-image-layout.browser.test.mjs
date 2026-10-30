import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createRequire} from 'node:module';

const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=new URL('../',import.meta.url);
const styles=await Promise.all(['events/events.css','home-ui.css','responsive-ui.css','practice-responsive.css'].map(file=>fs.readFile(new URL(file,root),'utf8')));
const weekly=JSON.parse(await fs.readFile(new URL('events/kodub/current.json',root),'utf8')).current;
const {RELEASE_INFO}=await import('./release-info.mjs');
const cover='data:image/webp;base64,'+(await fs.readFile(new URL('events/kodub/'+weekly.coverUrl,root))).toString('base64');
const oldEvents=styles[0].split('/* Compact featured events share')[0];
const focused=process.env.POLYTRACK_LAYOUT_FOCUSED==='1';
const releaseAudit=process.env.POLYTRACK_LAYOUT_RELEASE241==='1';
const requestedViewports=[[320,568],[390,844],[844,390],[768,1024],[1366,768],[1920,1080]];

const svg=(width,height)=>'data:image/svg+xml;base64,'+Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#284b65"/><rect x="3" y="3" width="${width-6}" height="${height-6}" fill="none" stroke="#ffdf85" stroke-width="6"/><text x="50%" y="50%" text-anchor="middle" fill="white" font-size="28">Complete artwork</text></svg>`).toString('base64');
const asset=async(file,mime)=>'data:'+mime+';base64,'+(await fs.readFile(new URL(file,root))).toString('base64');
const icon=await asset('images/timer.svg','image/svg+xml');
const preview=await asset('tracks/community/thumbnails/rolling_hills_racer.png','image/png');
const support=kind=>`<button class="sq-event-card" data-event-kind="${kind}"><span class="sq-event-thumb"><span class="profile-track-image-frame"><img src="${preview}" alt="${kind} preview"></span></span><span class="sq-event-record">00:24.531</span><span><small>${kind.toUpperCase()} EVENT</small><strong>Winter 5</strong><span class="sq-event-card-details"><small class="sq-event-reward">Up to 500 Event RP</small><small class="sq-event-reset">Resets Sun 17:00</small></span></span></button>`;
// Native weekly structure: direct cover (or thumbnail fallback), then the information panel.
const markup=`<div id="ui"><main class="track-selection-ui"><div class="tracks-container open"><div class="wrapper"><div class="community-track-versions"><button class="button">Featured Events</button></div><section class="sq-featured-events"><h2 class="sq-featured-heading">Events</h2><div class="track track-of-the-week sq-kodub-weekly"><button class="button"><img class="cover" src="${cover}" alt="Kodub weekly artwork"><div class="track-of-the-week-info"><div class="title">Hydropower</div><div class="author">By Bobson Dugnutt</div><div class="time-remaining">5d 12h 30m</div><div class="date-range">Oct 25 - Nov 1</div><div class="personal-best"><div><img src="${icon}" alt="Timer">00:24.531</div></div><small class="sq-kodub-reward">Up to 700 Event RP</small></div></button></div><div class="track sq-permanent-track"><button class="button"><img class="thumbnail" src="${preview}" alt="Permanent preview"><div class="track-title"><p>Rolling</p></div><div class="record">00:24.531</div><small class="sq-permanent-note">Permanent Event RP</small></button></div><div class="sq-event-track-buttons">${support('weekly')}${support('daily')}</div></section></div></div></main></div><img class="unrelated" src="${icon}" alt="Unrelated preview">`;
const base=`@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,${(await fs.readFile(new URL('forced_square.woff2',root))).toString('base64')})}body{margin:0;background:#111d40;color:white;font-family:ForcedSquare,sans-serif}.button{background:#28346a;color:white;border:0;font:inherit}.track-of-the-week-info{display:flex;flex-direction:column}.unrelated{width:64px;height:48px;object-fit:cover}`;

async function measure(page){
 return page.evaluate(()=>{
  const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom};};
  const card=document.querySelector('.sq-kodub-weekly>.button'),image=card.querySelector(':scope>img'),info=card.querySelector('.track-of-the-week-info');
  const sample=node=>({rect:rect(node),fit:getComputedStyle(node).objectFit,position:getComputedStyle(node).objectPosition});
  return {card:rect(card),image:sample(image),info:rect(info),natural:{width:image.naturalWidth,height:image.naturalHeight},grid:getComputedStyle(card).gridTemplateColumns,
   overflow:{client:document.documentElement.clientWidth,scroll:document.documentElement.scrollWidth},
   cards:[...document.querySelectorAll('.sq-featured-events>.track>.button,.sq-featured-events .sq-event-card')].map(rect),
   others:[...document.querySelectorAll('.sq-permanent-track img,.sq-event-thumb img,.personal-best img,.unrelated')].map(sample)};
 });
}


const viewports=[
 [188,334],[220,478],
 ...[639,640,641,699,700,701,1199,1200,1201].flatMap(width=>[459,460,461].map(height=>[width,height])),
 [320,568],[375,667],[440,956],[956,440],[667,375],[479,800],[480,800],[481,800],
 [600,960],[768,1024],[820,1180],[1024,768],[1366,600],[1700,900],[1701,900],
 [1920,1080],[2560,1279],[3440,1440],[5120,1440],
 ...[479,480,481,820,1024].flatMap(width=>[459,460,461].map(height=>[width,height])),
];
const inside=(inner,outer)=>inner.x>=outer.x-1&&inner.right<=outer.right+1&&inner.y>=outer.y-1&&inner.bottom<=outer.bottom+1;
const settle=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));

async function assertCardContents(page,label){
 const problems=await page.locator('.sq-featured-events>.track>.button,.sq-featured-events .sq-event-card').evaluateAll(cards=>{
  const problems=[];
  for(const card of cards){
   const box=card.getBoundingClientRect();
   if(card.scrollWidth>card.clientWidth+1||card.scrollHeight>card.clientHeight+1)problems.push({kind:'card overflow',text:card.textContent});
   for(const node of card.querySelectorAll('strong,.track-title p,.record,.sq-event-record,.sq-permanent-note,.sq-event-card-details>small,.track-of-the-week-info>div,.sq-kodub-reward')){
    if(!node.getClientRects().length)continue;
    const r=node.getBoundingClientRect();
    if(r.left<box.left-1||r.right>box.right+1||r.top<box.top-1||r.bottom>box.bottom+1||node.scrollWidth>node.clientWidth+1||node.scrollHeight>node.clientHeight+1)problems.push({kind:'clipped text',text:node.textContent});
   }
  }
  return problems;
 });
 assert.deepEqual(problems,[],label+': every title, record and reward/reset stays inside its card');
}


test('Kodub artwork fills a bottom-left panel with responsive details and reachable cards',{timeout:180000},async t=>{
 const directory=process.env.POLYTRACK_IMAGE_LAYOUT_OUTPUT||await fs.mkdtemp(path.join(tmpdir(),'polytrack-image-layout-'));
 await fs.mkdir(directory,{recursive:true});
 t.diagnostic('Screenshots: '+directory);
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
 try{
  const context=await browser.newContext({serviceWorkers:'block'});
  const requests=[];
  await context.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
  const page=await context.newPage(),baseline=await context.newPage();
  const load=async(p,events)=>{
   await p.setContent('<style>'+base+'\n'+[events,...styles.slice(1)].join('\n')+'</style>'+markup);
   await p.locator('img').evaluateAll(images=>Promise.all(images.map(image=>image.decode())));
   await p.evaluate(()=>document.fonts.ready);
  };
  await load(page,styles[0]);await load(baseline,oldEvents);
  await baseline.setViewportSize({width:1920,height:1080});await baseline.screenshot({path:path.join(directory,'baseline-1920x1080.png'),fullPage:true});
  const appearance=p=>p.locator('.sq-permanent-track>.button,.sq-event-card,.sq-permanent-track img,.sq-event-thumb img,.personal-best img,.unrelated').evaluateAll(nodes=>nodes.map(node=>{
   const s=getComputedStyle(node);return {fit:s.objectFit,position:s.objectPosition,background:s.backgroundColor,border:s.border,color:s.color,rendering:s.imageRendering};
  }));
  const results=[];
  let textScale=1;
  const check=async(width,height,label)=>{
   await page.setViewportSize({width,height});await baseline.setViewportSize({width,height});
   await page.mouse.move(0,0);await baseline.mouse.move(0,0);
   await page.locator('.sq-featured-events button, .sq-featured-events button *').evaluateAll((nodes,scale)=>{
    for(const node of nodes){node.style.removeProperty('font-size');node.style.removeProperty('line-height');}
    const sizes=nodes.map(node=>({node,size:parseFloat(getComputedStyle(node).fontSize),line:parseFloat(getComputedStyle(node).lineHeight)}));
    for(const {node,size,line} of sizes){node.style.setProperty('font-size',size*scale+'px','important');if(Number.isFinite(line))node.style.setProperty('line-height',line*scale+'px','important');}
   },textScale);
   await settle(page);await settle(baseline);
   const after=await measure(page),r=after.image.rect;
   await assertCardContents(page,label);
   assert.equal(after.cards.length,4,label+': all four cards remain present');
   for(const card of after.cards){
    assert.ok(card.width<=after.card.width+1,label+': Kodub image-led card is at least as wide as map cards '+JSON.stringify(after.cards));
    if(width>1000&&Math.abs(card.y-after.card.y)<1)assert.ok(Math.abs(card.height-after.card.height)<1,label+': desktop card heights align '+JSON.stringify(after.cards));
   }
   const visibleFraction=Math.min((r.width/r.height)/(after.natural.width/after.natural.height),(after.natural.width/after.natural.height)/(r.width/r.height));
   assert.ok(visibleFraction>0,label+': artwork remains visible at enlarged text sizes');
   if(textScale===1&&width>1200)assert.ok(visibleFraction>=.5,label+': larger Kodub panel preserves its artwork');
   assert.equal(after.image.fit,'cover',label+': never distort artwork');
   assert.equal(after.image.position,'0% 100%',label+': bottom-left anchor');
   assert.ok(r.width>0&&r.height>0,label+': visible artwork');
   assert.ok(inside(r,after.card)&&inside(after.info,after.card),label+': art and details inside card');
   assert.ok(Math.abs(r.x-after.card.x)<1&&Math.abs(r.y-after.card.y)<1,label+': no top/left bezel');
   const stacked=after.info.y>=r.bottom-1;
   if(stacked){
    assert.ok(Math.abs(r.width-after.card.width)<1,label+': full-width narrow art');
    assert.ok(Math.abs(r.bottom-after.info.y)<1,label+': no art/details gap');
   }else{
    assert.ok(Math.abs(r.bottom-after.card.bottom)<1,label+': art fills panel height without bars');
    assert.ok(Math.abs(r.right-after.info.x)<1,label+': no art/details gap');
    assert.ok(r.width>=after.card.width*.2&&r.width<=after.card.width*.7,label+': landscape artwork and details have balanced space');
   }
   const unrelated=after.others.at(-1),originalUnrelated=(await measure(baseline)).others.at(-1);
   assert.deepEqual({width:unrelated.rect.width,height:unrelated.rect.height,fit:unrelated.fit,position:unrelated.position},{width:originalUnrelated.rect.width,height:originalUnrelated.rect.height,fit:originalUnrelated.fit,position:originalUnrelated.position},label+': unrelated image style stays intact');
   assert.equal(after.others.at(-1).fit,'cover');
   assert.ok(after.others.slice(0,-1).every(image=>image.fit==='contain'),label+': map previews and timer icons are never cropped');
   assert.ok(after.overflow.scroll<=after.overflow.client+1,label+': no horizontal page overflow');
   const fullWidth=await page.locator('.sq-featured-events').evaluate(grid=>{
    const row=grid.getBoundingClientRect(),parent=grid.parentElement.getBoundingClientRect();
    return {left:row.left-parent.left,right:parent.right-row.right,width:row.width,parentWidth:parent.width};
   });
   assert.ok(Math.abs(fullWidth.left-16)<=1&&Math.abs(fullWidth.right-16)<=1,
    label+': events span the available width with only 16px edge gutters: '+JSON.stringify(fullWidth));
   const text=await page.locator('.track-of-the-week-info').evaluate(node=>({scroll:node.scrollWidth,client:node.clientWidth,height:node.scrollHeight,box:node.clientHeight}));
   assert.ok(text.scroll<=text.client+1&&text.height<=text.box+1,label+': details not clipped');
   const decoration=await page.locator('.sq-kodub-weekly>.button').evaluate(e=>({border:getComputedStyle(e).borderTopWidth,shadow:getComputedStyle(e).boxShadow}));
   assert.deepEqual(decoration,{border:'0px',shadow:'none'},label+': no extra bezel');
   for(const button of await page.locator('.sq-featured-events button').all()){
    await button.scrollIntoViewIfNeeded();
    await button.click({trial:true});
   }
   await page.mouse.move(0,0);await page.evaluate(()=>scrollTo(0,0));await settle(page);
   await page.screenshot({path:path.join(directory,label+'.png'),fullPage:true});
   results.push({label,viewport:{width,height},stacked,after});
   return after;
  };
  for(const [width,height] of (releaseAudit?requestedViewports:focused?[[188,334],[220,478],[320,568],[640,460],[641,460],[1200,800],[1201,800],[1920,1080]]:viewports))await check(width,height,'kodub-'+width+'x'+height);
  // Keep the same mounted DOM through repeated orientation cycles.
  for(const [width,height] of (releaseAudit?[[390,844]]:focused?[]:[[440,956],[375,667],[768,1024]])){
   const first=await check(width,height,'rotate-'+width+'-portrait');
   for(let cycle=1;cycle<=2;cycle++){
    await check(height,width,'rotate-'+width+'-landscape-'+cycle);
    assert.deepEqual(await check(width,height,'rotate-'+width+'-return-'+cycle),first,'rotation restores exact geometry');
   }
  }
  // Desktop browser zoom reduces the CSS viewport while physical pixels stay fixed.
  for(const scale of (releaseAudit?[]:focused?[1.25]:[1,1.25,1.5,2])){
   for(const [width,height] of [[1366,600],[2560,1279],[440,956],[956,440],[375,667],[667,375]]){
    await check(Math.round(width/scale),Math.round(height/scale),'zoom-'+scale+'-'+width+'x'+height);
   }
  }
  // Text-only enlargement: preserve layout pixels and enlarge actual computed text.
  for(const scale of (releaseAudit?[]:focused?[1.25]:[1,1.25,1.5,2])){
   textScale=scale;
   for(const [width,height] of [[440,956],[375,667],[956,440],[667,375],[1366,600],[2560,1279]])await check(width,height,'text-'+scale+'-'+width+'x'+height);
  }
  await page.locator('.sq-featured-events button, .sq-featured-events button *').evaluateAll(nodes=>nodes.forEach(node=>{node.style.removeProperty('font-size');node.style.removeProperty('line-height');}));
  for(const [width,height] of [[320,568],[820,459],[1366,600]]){
   await page.setViewportSize({width,height});await settle(page);
   const original=await measure(page);
   for(const [w,h] of [[900,240],[240,900],[256,256]]){
    await page.locator('.sq-kodub-weekly>.button>img').evaluate(async(img,src)=>{img.className='thumbnail';img.src=src;await img.decode();},svg(w,h));
    const fallback=await measure(page);
    assert.equal(fallback.image.fit,'contain','map fallbacks must never crop');
    assert.deepEqual(fallback.image.rect,original.image.rect,'fallback native ratio does not dictate layout');
    await page.screenshot({path:path.join(directory,'fallback-'+width+'x'+height+'-'+w+'x'+h+'.png'),fullPage:true});
   }
   await page.locator('.sq-kodub-weekly>.button>img').evaluate(async(img,src)=>{img.className='cover';img.src=src;await img.decode();},cover);
  }
  assert.deepEqual(requests,[],'offline local fixture, no external requests');
  await fs.writeFile(path.join(directory,'measurements.json'),JSON.stringify(results,null,2));
  t.diagnostic(results.length+' viewport/rotation/zoom/text checks; 9 fallback checks; zero network requests');
 }finally{await browser.close();}
});

test('native Kodub titles fit available space and wrap overlong names at spaces, including UI125',{timeout:180000},async t=>{
 const {startResponsiveServer}=await import('./responsive-server.mjs');
 const directory=process.env.POLYTRACK_IMAGE_LAYOUT_OUTPUT||await fs.mkdtemp(path.join(tmpdir(),'polytrack-native-title-'));
 await fs.mkdir(directory,{recursive:true});
 const server=await startResponsiveServer();
 const browser=await chromium.launch({headless:true});
 const results=[],requests=[];
 try{
  for(const scale of [100,125]){
   const context=await browser.newContext({viewport:{width:1920,height:1080},serviceWorkers:'block'});
   await context.addInitScript(scale=>localStorage.setItem('polytrack-0.6.2-ui-font-scale',String(scale)),scale);
   await context.addInitScript(number=>localStorage.setItem('polytrack-site-update-ack-release-v1:'+number,'acknowledged'),RELEASE_INFO.number);
   const page=await context.newPage();
   page.on('pageerror',error=>t.diagnostic('Native page error: '+String(error)));
   await context.route('**/*',route=>{
    const request=route.request(),url=new URL(request.url());
    if(url.origin===server.url&&url.pathname==='/v6/user')return route.fulfill({status:200,contentType:'application/json',body:'null'});
    if(url.origin===server.url&&['GET','HEAD'].includes(request.method()))return route.continue();
    requests.push({url:url.origin,method:request.method()});return route.abort();
   });
   await page.goto(server.url,{waitUntil:'domcontentloaded'});
   await page.getByRole('button',{name:'Exit',exact:true}).click({timeout:20000}).catch(async error=>{await fs.writeFile(path.join(directory,'native-startup-failure.txt'),await page.locator('body').innerText());await page.screenshot({path:path.join(directory,'native-startup-failure.png'),timeout:5000}).catch(()=>{});throw error;});
   await page.getByRole('button',{name:'Back',exact:true}).click();
   await page.getByRole('button',{name:'Play',exact:true}).click();
   await page.locator('.track-selection-ui').waitFor();
   await page.keyboard.press('Shift+Digit2');
   const title=page.locator('.sq-kodub-weekly .track-of-the-week-info>.title');
   await title.waitFor();
   await page.locator('.sq-kodub-weekly>.button>img.cover').evaluate(image=>image.decode());
   await page.evaluate(()=>document.fonts.ready);
   assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--sq-ui-scale').trim()),String(scale/100));
   const sample=()=>title.evaluate(node=>{
    const range=document.createRange(),text=node.firstChild,chars=[];
    for(let i=0;i<text.length;i++){range.setStart(text,i);range.setEnd(text,i+1);const r=range.getBoundingClientRect();chars.push({char:text.textContent[i],y:Math.round(r.y*10)/10,right:r.right});}
    const style=getComputedStyle(node),info=node.parentElement,box=info.getBoundingClientRect();
    // Measure the same font without wrapping; viewport width alone cannot predict a line break.
    const copy=node.cloneNode(true);
    for(const [property,value] of Object.entries({position:'fixed',visibility:'hidden',width:'max-content','max-width':'none','white-space':'nowrap'}))copy.style.setProperty(property,value,'important');
    info.append(copy);
    const unwrappedWidth=parseFloat(getComputedStyle(copy).width);
    copy.remove();
    const contentWidth=parseFloat(style.width)-(style.boxSizing==='border-box'?parseFloat(style.paddingLeft)+parseFloat(style.paddingRight)+parseFloat(style.borderLeftWidth)+parseFloat(style.borderRightWidth):0);
    return {unwrappedWidth,contentWidth,text:node.textContent,lines:new Set(chars.filter(c=>c.char!==' ').map(c=>c.y)).size,chars,font:style.fontSize,wordBreak:style.wordBreak,wrap:style.overflowWrap,detailsWidth:box.width,titleWidth:node.getBoundingClientRect().width,overflow:info.scrollWidth>info.clientWidth+1};
   });
   const assertWrapping=(sample,label)=>{
    const details=label+': '+JSON.stringify(sample);
    assert.equal(sample.wordBreak,'normal',details+': ordinary words must not break arbitrarily');
    assert.equal(sample.overflow,false,details+': title must not overflow');
    assert.ok(sample.contentWidth>0&&sample.unwrappedWidth>0,details+': measurable text');
    assert.equal(sample.lines>1,sample.unwrappedWidth>sample.contentWidth,details+': wrap exactly when the title exceeds available space');
    let offset=0;
    for(const word of sample.text.split(' ')){
     const letters=sample.chars.slice(offset,offset+word.length);
     assert.equal(new Set(letters.map(c=>c.y)).size,1,details+': each ordinary word stays intact');
     offset+=word.length+1;
    }
   };
   for(const [width,height] of (releaseAudit?requestedViewports:focused?[[320,568],[1920,1080],[375,667],[956,440]]:[[320,568],[1920,1080],[2560,1279],[440,956],[375,667],[956,440],[667,375],[640,460],[641,460],[1200,800],[1201,800]])){
    await page.setViewportSize({width,height});await page.mouse.move(0,0);await settle(page);
    await title.evaluate(node=>node.textContent='Hydropower');await settle(page);
    const ordinary=await sample(),geometry=await measure(page);
    await assertCardContents(page,'native '+width+'x'+height+' UI'+scale);
    for(const card of geometry.cards){
     assert.ok(card.width<=geometry.card.width+1,'native Kodub card has room for its artwork: '+JSON.stringify(geometry.cards));
     if(width>1000&&Math.abs(card.y-geometry.card.y)<1)assert.ok(Math.abs(card.height-geometry.card.height)<1,'native desktop cards have equal height: '+JSON.stringify(geometry.cards));
    }
    await page.screenshot({path:path.join(directory,'native-title-'+width+'x'+height+'-ui'+scale+'.png')});
    assert.equal(ordinary.lines,1,JSON.stringify({width,height,scale,ordinary})+': Hydropower must be one line');
    assert.equal(ordinary.overflow,false,'ordinary title must not overflow');
    assert.equal(geometry.image.fit,'cover');assert.equal(geometry.image.position,'0% 100%');
    assert.ok(Math.abs(geometry.image.rect.x-geometry.card.x)<1,'art remains full bleed on left');
    assert.ok(geometry.image.rect.right<=geometry.info.x+1||geometry.image.rect.bottom<=geometry.info.y+1,'artwork never overlaps the native details');
    await title.evaluate(node=>node.textContent='Hydropower Mountain Expedition');await settle(page);
    const long=await sample();
    await assertCardContents(page,'native long title '+width+'x'+height+' UI'+scale);
    assertWrapping(long,'native long title '+width+'x'+height+' UI'+scale);
    await page.screenshot({path:path.join(directory,'native-long-title-'+width+'x'+height+'-ui'+scale+'.png')});
    // Exceed even the wider CSS panels produced by native short-landscape UI scaling.
    await title.evaluate(node=>node.textContent='Hydropower Mountain Expedition Through The Northern Highlands And Across The Frozen River Valley Beyond The Ancient Forest');await settle(page);
    const overlong=await sample(),expanded=await measure(page);
    await page.screenshot({path:path.join(directory,'native-overlong-title-'+width+'x'+height+'-ui'+scale+'.png')});
    await fs.writeFile(path.join(directory,'native-title-latest.json'),JSON.stringify({width,height,scale,ordinary,long,overlong,expanded},null,2));
    assert.ok(overlong.unwrappedWidth>overlong.contentWidth,'overlong fixture must exercise real wrapping: '+JSON.stringify({width,height,scale,overlong}));
    assert.ok(overlong.lines>1,'overlong names visibly wrap at spaces');
    assertWrapping(overlong,'native overlong title '+width+'x'+height+' UI'+scale);
    await assertCardContents(page,'native overlong title '+width+'x'+height+' UI'+scale);
    assert.equal(expanded.cards.length,4,'all four native cards remain present');
    for(const card of expanded.cards){
     assert.ok(card.width<=expanded.card.width+1,'wrapped native Kodub card keeps its larger artwork area');
     if(width>1000&&Math.abs(card.y-expanded.card.y)<1)assert.ok(Math.abs(card.height-expanded.card.height)<1,'wrapped native desktop cards have equal heights');
    }
    assert.ok(expanded.overflow.scroll<=expanded.overflow.client+1,'wrapped native cards do not overflow the page');
    results.push({width,height,scale,ordinary,long,overlong,artwork:geometry.image,card:geometry.card,expanded});
   }
   await context.close();
  }
  await fs.writeFile(path.join(directory,'native-title-measurements.json'),JSON.stringify({results,blockedRequests:requests},null,2));
  assert.deepEqual(requests,[],'native fixture uses only read-only loopback resources, no external requests');
  t.diagnostic(results.length+' native viewport/UI-scale checks, three title lengths each; zero external requests; screenshots: '+directory);
 }finally{await browser.close();await server.close();}
});
