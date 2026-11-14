import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const fontCss='@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,'+fs.readFileSync(new URL('../forced_square.woff2',import.meta.url)).toString('base64')+') format("woff2")}body{font-family:ForcedSquare,sans-serif}';
const require=createRequire(import.meta.url);
let chromium;try{({chromium}=require(process.env.PLAYWRIGHT_MODULE||'../tools/verifier/node_modules/playwright'));}catch{}
const moduleSource=fs.readFileSync(new URL('./catalog-ui.mjs',import.meta.url),'utf8');
const reviewSource=fs.readFileSync(new URL('./review.mjs',import.meta.url),'utf8');
const reviewedModules = new Map(['reviewed.mjs', 'reviewed-data.mjs', 'snapshot-popularity.mjs', 'featured-picks.mjs', 'random-picker.mjs'].map(name => [name, fs.readFileSync(new URL('./' + name, import.meta.url), 'utf8')]));
reviewedModules.set('tools/search-text.mjs', fs.readFileSync(new URL('../tools/search-text.mjs', import.meta.url), 'utf8'));
const css=fs.readFileSync(new URL('./catalog.css',import.meta.url),'utf8');

test('shared normalized search, selected counts and grading credit work in the browser',{skip:!chromium},async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true});
  const catUrl='https://cdn.jsdelivr.net/gh/StaticQuasar931/Images@main/Window_Cleaner_Cat.jpg';
  const catRequests=[];
  await page.route('**/*',route=>{
   const url=route.request().url(),pathname=new URL(url).pathname.slice(1);
   if(reviewedModules.has(pathname))return route.fulfill({contentType:'text/javascript',body:reviewedModules.get(pathname)});
   if(url===catUrl){catRequests.push(url);return route.abort();}
   if(url==='http://polish.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><main id="root"></main>'});
   if(url==='http://polish.test/catalog-ui.mjs')return route.fulfill({contentType:'text/javascript',body:moduleSource});
   if(url==='http://polish.test/review.mjs')return route.fulfill({contentType:'text/javascript',body:reviewSource});
   return route.abort();
  });
  await page.goto('http://polish.test/');await page.addStyleTag({content:fontCss+css});
  const entries=JSON.parse(fs.readFileSync(new URL('./catalog.json',import.meta.url),'utf8')).slice(0,3);
  await page.evaluate(async entries=>{
   const {mountExtraTracks}=await import('/catalog-ui.mjs');
   window.catalog=mountExtraTracks({document,root:document.querySelector('#root'),entries:[...entries,{id:'alias',name:'B\u26f6XED IN',author:'Jos\u00e9',source:'Test'}]});catalog.open();
  },entries);
  const search=page.getByRole('searchbox',{name:'Search tracks'});
  for(const query of ['boxed in','jose']){
   await search.fill(query);assert.equal(await page.locator('.sq-extra-card').count(),1);
   assert.equal(await page.locator('.sq-extra-card h3').textContent(),'B\u26f6XED IN');
  }
  await search.fill('');await page.getByRole('button',{name:'Filters',exact:true}).click();
  await page.getByLabel('Rating',{exact:true}).selectOption('6');
  assert.equal(await page.getByLabel('Rating',{exact:true}).locator('option:checked').textContent(),'At least 6/10 (2)');
  assert.equal(await page.locator('.sq-extra-card').count(),2);
  await page.getByRole('button',{name:'Reset filters',exact:true}).click();
  const help=page.locator('.sq-extra-grading-help');await help.locator('summary').click();
  assert.match(await help.innerText(),/Thanks to Window Cleaner for help with track gradings/);
  assert.deepEqual(catRequests,[],'normal discovery does not request the cat');
  await search.fill('window cleaner');
  const cat=page.getByAltText('Window Cleaner cat');await cat.scrollIntoViewIfNeeded();
  await page.waitForFunction(()=>document.querySelector('.sq-extra-cleaner img')?.complete);
  assert.equal(await cat.getAttribute('src'),catUrl);
  assert.equal(await page.locator('.sq-extra-cleaner').isVisible(),true);
  assert.equal(await page.locator('.sq-extra-empty').count(),0,'the credit reveal is not called an empty search');
  assert.deepEqual(catRequests,[catUrl],'only the requested external image URL is used');
  await search.fill('');assert.equal(await page.locator('.sq-extra-cleaner').isHidden(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }finally{await browser.close();}
});
test('toolbar groups stay adjacent with expanded filters at requested sizes and never fetch catalog data',{skip:!chromium},async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage({hasTouch:true});
  const dataRequests=[];
  await page.route('**/*',route=>{
   const url=route.request().url();
   if(reviewedModules.has(new URL(url).pathname.slice(1)))return route.fulfill({contentType:'text/javascript',body:reviewedModules.get(new URL(url).pathname.slice(1))});
   if(url==='http://toolbar.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><main id="root"></main>'});
   if(url==='http://toolbar.test/catalog-ui.mjs')return route.fulfill({contentType:'text/javascript',body:moduleSource});
   if(url==='http://toolbar.test/review.mjs')return route.fulfill({contentType:'text/javascript',body:reviewSource});
   dataRequests.push(url);return route.abort();
  });
  await page.goto('http://toolbar.test/');await page.addStyleTag({content:fontCss+css});await page.evaluate(()=>document.fonts.ready);
  await page.evaluate(async()=>{
   const {mountExtraTracks}=await import('/catalog-ui.mjs');
   window.catalog=mountExtraTracks({document,root:document.querySelector('#root'),entries:[{id:'toolbar',name:'Toolbar track',source:'Community',tags:['technical'],tier:'Curated'}]});
   catalog.open();
  });
  for(const [width,height] of [[1366,600],[820,1180],[390,844],[844,320]]){
   await page.setViewportSize({width,height});
   await page.waitForFunction(()=>document.querySelector('.sq-extra-advanced-toggle').hidden===false);
   {
    const toggle=page.locator('.sq-extra-advanced-toggle');
    if(await toggle.getAttribute('aria-expanded')==='false')await toggle.click();
   }
   const layout=await page.locator('.sq-extra-controls').evaluate(el=>{
    const box=node=>{const r=node.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    const advanced=el.querySelector('.sq-extra-advanced'),search=el.querySelector('.sq-extra-search-field');
    return {sort:box(el.querySelector('.sq-extra-sort-controls select')),reset:box(el.querySelector('.sq-extra-quick-filters .sq-extra-clear')),checks:[...el.querySelectorAll('.sq-extra-check')].map(box),filterToggle:box(el.querySelector('.sq-extra-advanced-toggle')),firstFilter:box(advanced.querySelector('.sq-extra-field')),overflow:el.scrollWidth>el.clientWidth+1,labels:[...el.querySelectorAll('.sq-extra-check')].map(n=>n.textContent),toolbarBackground:getComputedStyle(el).backgroundColor,searchBackground:getComputedStyle(search).backgroundColor,advancedBackground:getComputedStyle(advanced).backgroundColor,advancedBorder:getComputedStyle(advanced).borderWidth};
   });
   assert.equal(layout.overflow,false,'toolbar fits '+width+'x'+height);
   assert.ok(layout.reset.top>=layout.firstFilter.top,'Reset stays with the expanded filters');

   assert.ok(layout.sort.width>=130,'Sort remains readable at '+width+'x'+height+': '+JSON.stringify(layout));
   assert.deepEqual(layout.labels,['My favorites','Curated only']);
   assert.equal(layout.searchBackground,'rgba(0, 0, 0, 0)','search shares the toolbar surface');
   assert.equal(layout.advancedBackground,'rgba(0, 0, 0, 0)','filters share the toolbar surface');
   assert.equal(layout.advancedBorder,'0px','filters have no separate boxed band');
   if(width<=600||height<=650)assert.ok(layout.filterToggle.bottom<=layout.firstFilter.top,'compact filter toggle precedes its fields');
   assert.ok(Math.abs(layout.checks[0].top-layout.checks[1].top)<1,'quick filters share a row');
   for(const control of [layout.sort,layout.reset,...layout.checks])assert.ok(control.left>=0&&control.right<=width&&control.height>=44,'toolbar controls fit and retain touch height');
   if([1366,390,844].includes(width)&&process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR){await page.evaluate(()=>document.querySelector('.sq-extra-menu').scrollTop=0);await page.screenshot({path:process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR+`/catalog-toolbar-${width}x${height}.png`});}
   await page.getByRole('searchbox').fill('no matching track');
   assert.equal(await page.locator('.sq-extra-empty h3').textContent(),'No matching tracks');
   await page.locator('.sq-extra-quick-filters .sq-extra-clear').click();
   assert.equal(await page.locator('.sq-extra-card').count(),1);
   await page.evaluate(()=>{catalog.refresh();catalog.close();catalog.open();});
  }
  assert.deepEqual(dataRequests,[],'filtering, resetting, refresh and reopen use supplied entries without fetching');
 }finally{await browser.close();}
});
test('catalog header, filters and review controls fit small touch screens with export enabled',{skip:!chromium},async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
 try{
  const page=await browser.newPage({hasTouch:true});
  await page.route('**/*',route=>{
   const url=route.request().url();
   if(reviewedModules.has(new URL(url).pathname.slice(1)))return route.fulfill({contentType:'text/javascript',body:reviewedModules.get(new URL(url).pathname.slice(1))});
   if(url==='http://catalog.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><main id="root"></main>'});
   if(url==='http://catalog.test/catalog-ui.mjs')return route.fulfill({contentType:'text/javascript',body:moduleSource});
   if(url==='http://catalog.test/review.mjs')return route.fulfill({contentType:'text/javascript',body:reviewSource});
   return route.abort();
  });
  await page.goto('http://catalog.test/');await page.addStyleTag({content:fontCss+css});await page.evaluate(()=>document.fonts.ready);
  await page.evaluate(async()=>{
   const {mountExtraTracks}=await import('/catalog-ui.mjs');
   window.feedback={};window.exportCount=0;
   window.catalog=mountExtraTracks({document,root:document.querySelector('#root'),entries:Array.from({length:24},(_,i)=>({id:'track-'+i,name:'Track '+i,author:'Test creator',tags:['technical','scenic'],source:'Test collection'})),onExportFeedback:async()=>exportCount++,getFeedback:entry=>feedback[entry.id]||{},onFeedback:(entry,value)=>{feedback[entry.id]={...feedback[entry.id],...value};},onReport:async()=>{}});
   catalog.open();
  });
  for(const [width,height] of [[320,568],[390,844],[568,320],[844,390],[768,1024],[1024,768],[1366,600],[820,1180],[844,320]]){
   await page.setViewportSize({width,height});
   await page.locator('.sq-extra-header').scrollIntoViewIfNeeded();
   assert.equal(await page.locator('.sq-extra-field').filter({has:page.getByLabel('Sort',{exact:true})}).locator('.sq-extra-filter-count').count(),0,'Sort has no empty count badge');
   if(width<=560){const rows=await page.locator('.sq-extra-check').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().top));assert.ok(Math.abs(rows[0]-rows[1])<1,'compact checkboxes share one row');}
   const info=await page.locator('.sq-extra-header').evaluate(el=>({width:el.clientWidth,content:el.scrollWidth,children:[...el.children].map(node=>{const box=node.getBoundingClientRect();return {left:box.left,right:box.right,top:box.top,bottom:box.bottom,height:box.height,scroll:node.scrollWidth,client:node.clientWidth,button:node.tagName==='BUTTON'};})}));
   assert.ok(info.content<=info.width+1,'header has no overflow at '+width+'x'+height);
   for(const item of info.children){
    assert.ok(item.left>=0&&item.right<=width+1,'header content fits');
    assert.ok(item.scroll<=item.client+1,'header labels are not clipped');
    if(item.button)assert.ok(item.height>=44,'touch header buttons must be at least 44px at '+width+'x'+height);
   }
   const menuState=await page.locator('.sq-extra-menu').evaluate(menu=>{
    menu.scrollTop=menu.scrollHeight;
    const box=menu.getBoundingClientRect(),pagination=menu.querySelector('.sq-extra-pagination').getBoundingClientRect();
    const visibleControls=[...menu.querySelectorAll('.sq-extra-close,.sq-extra-export,.sq-extra-submit,.sq-extra-advanced-toggle,.sq-extra-field input,.sq-extra-field select,.sq-extra-favorite,.sq-extra-more,.sq-extra-play,.sq-extra-pagination button')].filter(node=>node.getClientRects().length);
    return {box:{top:box.top,bottom:box.bottom,height:box.height},scrollHeight:menu.scrollHeight,clientHeight:menu.clientHeight,scrollTop:menu.scrollTop,pagination:{top:pagination.top,bottom:pagination.bottom},controls:visibleControls.map(node=>({name:node.className||node.type,height:node.getBoundingClientRect().height,width:node.getBoundingClientRect().width}))};
   });
   assert.ok(menuState.box.top>=0&&menuState.box.bottom<=height+1,'catalog scroller stays inside '+width+'x'+height);
   assert.ok(menuState.scrollHeight>menuState.clientHeight&&menuState.scrollTop>0,'catalog content scrolls in short viewport '+width+'x'+height);
   assert.ok(menuState.pagination.bottom<=height+1&&menuState.pagination.top>=0,'bottom pagination is reachable after scrolling at '+width+'x'+height);
   for(const control of menuState.controls)assert.ok(control.height>=43.99&&control.width>=43.99,'coarse-pointer target is at least 44px: '+control.name+' at '+width+'x'+height+' ('+control.width+'x'+control.height+')');
   if(width===390&&process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR)await page.screenshot({path:process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR+'/catalog-390.png'});
   await page.locator('.sq-extra-header-more > summary').click();
   await page.locator('.sq-extra-export').click();
   await page.locator('.sq-extra-header-more > summary').click();
   const more=page.locator('.sq-extra-more').first();await more.scrollIntoViewIfNeeded();await more.click();
   const menu=page.locator('.sq-extra-more-menu:not([hidden])');
   const bounds=await menu.boundingBox();
   assert.ok(bounds&&bounds.x>=7&&bounds.y>=7&&bounds.x+bounds.width<=width-7&&bounds.y+bounds.height<=height-7,'review popup remains inside '+width+'x'+height);
   if(width===390&&process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR)await page.screenshot({path:process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR+'/review-390.png'});
   await menu.getByRole('button',{name:'Done',exact:true}).click();
   assert.equal(await more.evaluate(node=>node===document.activeElement),true);
  }
  assert.equal(await page.evaluate(()=>exportCount),9);
 }finally{await browser.close();}
});

test('local review filter and ordering include ratings and update after a review is cleared',{skip:!chromium},async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage({viewport:{width:1366,height:600}}),unexpected=[];
  await page.route('**/*',route=>{
   const url=route.request().url();
   if(reviewedModules.has(new URL(url).pathname.slice(1)))return route.fulfill({contentType:'text/javascript',body:reviewedModules.get(new URL(url).pathname.slice(1))});
   if(url==='http://review.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html><main id="root"></main>'});
   if(url==='http://review.test/catalog-ui.mjs')return route.fulfill({contentType:'text/javascript',body:moduleSource});
   if(url==='http://review.test/review.mjs')return route.fulfill({contentType:'text/javascript',body:reviewSource});
   unexpected.push(url);return route.abort();
  });
  await page.goto('http://review.test/');await page.addStyleTag({content:fontCss+css});
  await page.evaluate(async()=>{
   const {mountExtraTracks}=await import('/catalog-ui.mjs');
   const entries=['Alpha','Beta','Gamma'].map((name,i)=>({id:String(i),name,source:'Community',tags:[]}));
   window.reviews=[{}, {rating:8}, {favorite:true}];
   window.catalog=mountExtraTracks({document,root:document.querySelector('#root'),entries,getFeedback:e=>reviews[e.id],getLocalRating:e=>reviews[e.id].rating});catalog.open();
  });
  const filters=page.locator('.sq-extra-advanced');
  const disclosure=page.getByRole('button',{name:'Filters',exact:true});
  assert.equal(await filters.isHidden(),true,'short-height catalog starts with filters collapsed');
  assert.equal(await disclosure.getAttribute('aria-expanded'),'false');
  await disclosure.click();
  assert.equal(await filters.isVisible(),true,'open the existing disclosure before using its controls');
  assert.equal(await disclosure.getAttribute('aria-expanded'),'true');
  const names=()=>page.locator('.sq-extra-card h3').allTextContents();
  await page.locator('.sq-extra-review-field select').selectOption('edited');assert.deepEqual(await names(),['Beta']);
  await page.locator('.sq-extra-review-field select').selectOption('not-edited');assert.deepEqual(await names(),['Alpha','Gamma']);
  await page.locator('.sq-extra-review-field select').selectOption('all');
  await page.locator('.sq-extra-sort-controls select').selectOption('my-reviews');assert.deepEqual(await names(),['Beta','Alpha','Gamma']);
  await page.locator('.sq-extra-sort-direction').click();assert.deepEqual(await names(),['Alpha','Gamma','Beta']);
  await page.locator('.sq-extra-sort-controls select').selectOption('my-rating');assert.equal((await names())[0],'Beta');
  await page.evaluate(()=>{reviews[0]={rating:10};catalog.refresh();});assert.equal((await names())[0],'Alpha');
  await page.evaluate(()=>{reviews[0]={rating:0};catalog.refresh();});assert.equal((await names())[0],'Beta');
  await page.getByRole('button',{name:'Reset filters',exact:true}).click();assert.equal(await page.locator('.sq-extra-review-field select').inputValue(),'all');
  assert.deepEqual(await names(),['Alpha','Beta','Gamma']);assert.deepEqual(unexpected,[]);
 }finally{await browser.close();}
});

test('desktop and compact discovery keep filters accessible with optional Static artwork',{skip:!chromium},async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  const unexpected=[];
  await page.route('**/*',route=>{
   const url=route.request().url(),pathname=new URL(url).pathname.slice(1);
   if(reviewedModules.has(pathname))return route.fulfill({contentType:'text/javascript',body:reviewedModules.get(pathname)});
   if(pathname==='catalog-ui.mjs')return route.fulfill({contentType:'text/javascript',body:moduleSource});
   if(pathname==='review.mjs')return route.fulfill({contentType:'text/javascript',body:reviewSource});
   if(pathname==='native-track-search.mjs')return route.fulfill({contentType:'text/javascript',body:fs.readFileSync(new URL('../tools/native-track-search.mjs',import.meta.url),'utf8').replace("'./search-text.mjs'","'./tools/search-text.mjs'")});
   if(url==='http://discovery.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><main id="root"></main>'});
   unexpected.push(url);return route.abort();
  });
  await page.goto('http://discovery.test/');await page.addStyleTag({content:fontCss+css});await page.evaluate(()=>document.fonts.ready);
  const entries=JSON.parse(fs.readFileSync(new URL('./catalog.json',import.meta.url),'utf8')).slice(0,12).map(({thumbnailUrl,...entry})=>entry);
  await page.evaluate(async entries=>{
   const {mountExtraTracks}=await import('/catalog-ui.mjs');
   window.catalog=mountExtraTracks({document,root:document.querySelector('#root'),entries,onExportFeedback:async()=>{},getFeedback:()=>({}),onFeedback:()=>{}});catalog.open();
  },entries);
  const shot=async name=>{
   if(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR)await page.screenshot({animations:'disabled',path:process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR+'/'+name+'.png'});
  };
  const search=page.getByRole('searchbox',{name:'Search tracks'}),toggle=page.locator('.sq-extra-advanced-toggle');
  for(const [width,height] of [[1366,900],[390,844],[844,320]]){
   await page.setViewportSize({width,height});
   if(await toggle.getAttribute('aria-expanded')==='true')await toggle.click();
   await search.fill('');await page.evaluate(()=>document.querySelector('.sq-extra-menu').scrollTop=0);
   assert.equal(await toggle.isVisible(),true,'disclosure is discoverable at '+width);
   assert.equal(await page.locator('.sq-extra-advanced').isHidden(),true);
   assert.equal(await page.getByLabel('Sort',{exact:true}).isVisible(),true,'common Sort never needs the filters disclosure');
   assert.equal(await page.locator('.sq-extra-menu>.sq-extra-invite-row').count(),0);
   await page.getByLabel('Sort',{exact:true}).selectOption('name');
   assert.equal(await page.locator('.sq-extra-advanced').isHidden(),true,'sorting does not open filters');
   assert.equal(await toggle.textContent(),'Filters','Sort is not counted as a hidden filter');
   const rect=await toggle.boundingBox();assert.ok(rect&&rect.y>=0&&rect.y+rect.height<=height&&rect.height>=44);
   await shot('catalog-collapsed-'+width);
   await search.focus();await page.keyboard.press('Tab');await page.keyboard.press('Tab');await page.keyboard.press('Tab');assert.equal(await toggle.evaluate(node=>node===document.activeElement),true);
   await page.keyboard.press('Enter');
   for(const label of ['Source','Tag','Catalog level','Progress','Review status','Sort','Rating','Difficulty','Votes'])assert.equal(await page.getByLabel(label,{exact:true}).isVisible(),true,label+' is exposed');
   await page.getByLabel('Rating',{exact:true}).selectOption('6');
   assert.match(await page.getByLabel('Rating',{exact:true}).locator('option:checked').textContent(),/At least 6\/10 \(\d+\)/);
   assert.equal(await toggle.textContent(),'Filters (1)');
   await page.getByRole('button',{name:'Reset filters',exact:true}).click();
   await page.evaluate(()=>document.querySelector('.sq-extra-menu').scrollTop=0);
   await shot('catalog-expanded-'+width);
   const overflow=await page.locator('.sq-extra-menu').evaluate(menu=>menu.scrollWidth>menu.clientWidth+1);assert.equal(overflow,false);
   await toggle.click();await search.fill('Static');
   assert.equal(await page.locator('.sq-extra-static').isVisible(),true);
   assert.equal(await page.locator('.sq-extra-cleaner').isHidden(),true);
   assert.equal(await page.locator('.sq-extra-empty').count(),0);
   await shot('static-'+width);
  }
  // Exercise every close/confirmation action in the short landscape viewport.
  await search.fill('');
  const more=page.locator('.sq-extra-more').first();await more.click();
  const menu=page.locator('.sq-extra-more-menu:not([hidden])');
  const reachable=async control=>{
   await control.scrollIntoViewIfNeeded();const b=await control.boundingBox();
   assert.ok(b&&b.x>=0&&b.y>=0&&b.x+b.width<=844&&b.y+b.height<=320,'action fits 844x320');
  };
  const reset=menu.getByRole('button',{name:'Reset review',exact:true});await reachable(reset);await reset.click();
  const confirm=menu.getByRole('button',{name:'Confirm reset review',exact:true});await reachable(confirm);
  await shot('review-confirm-844x320');await confirm.click();
  const done=menu.getByRole('button',{name:'Done',exact:true});await reachable(done);await shot('review-close-844x320');await done.click();
  assert.equal(await more.evaluate(node=>node===document.activeElement),true);
  await page.locator('.sq-extra-submit').click();
  await reachable(page.locator('.sq-extra-send'));await shot('submission-send-844x320');
  await reachable(page.locator('.sq-extra-submission-modal .sq-extra-submission-close'));await shot('submission-close-844x320');await page.locator('.sq-extra-submission-modal .sq-extra-submission-close').click();
  await reachable(page.locator('.sq-extra-close'));await shot('catalog-close-844x320');await page.locator('.sq-extra-close').click();
  assert.equal(await page.locator('.sq-extra-overlay').isHidden(),true);
  await page.evaluate(()=>catalog.open());await page.setViewportSize({width:390,height:844});
  assert.deepEqual(unexpected,['https://cdn.jsdelivr.net/gh/StaticQuasar931/Images@main/squarestaticquasar931logo.jpg'],'only the requested Static artwork uses an external asset');
  await page.route('**/Window_Cleaner_Cat.jpg',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="240" height="72"><text x="12" y="36" fill="white">Window Cleaner cat (offline fixture)</text></svg>'}));
  await search.fill('credits');
  assert.equal(await page.locator('.sq-extra-static').isVisible(),true);
  assert.equal(await page.locator('.sq-extra-cleaner').isVisible(),true);
  await shot('credits-390');
  await page.evaluate(()=>catalog.destroy());
  const metadata=JSON.parse(fs.readFileSync(new URL('../tracks/search-metadata.json',import.meta.url),'utf8'));
  const results=await page.evaluate(async metadata=>{
   const {enhanceNativeTrackSearch}=await import('/native-track-search.mjs');
   const menu=document.createElement('section');menu.className='track-selection-ui';
   menu.innerHTML='<div class="search-bar-container"><input></div><div class="tracks-container open"></div>';
   document.body.append(menu);
   const container=menu.querySelector('.tracks-container');
   for(const row of metadata){const tile=document.createElement('div');tile.className='track';const title=document.createElement('p');title.className='track-title';title.textContent=row.name;tile.append(title);container.append(tile);}
   const enhancer=enhanceNativeTrackSearch({document,metadata});
   const input=menu.querySelector('input'),results={};
   for(const query of ['Wintertide','winterrtibe','atlantis','steinwallburg','paradise palace','evanescent bliss','levitation','cogware']){
    input.value=query;for(const tile of container.children)tile.style.display='none';enhancer.apply(input);
    results[query]=[...container.children].filter(tile=>tile.style.display!=='none').map(tile=>tile.textContent);
   }
   enhancer.dispose();return results;
  },metadata);
  for(const [query,names] of Object.entries(results))assert.equal(names.length,1,'native plain search: '+query);
  assert.deepEqual(results.Wintertide,results.winterrtibe);
 }finally{await browser.close();}
});

test('metric direction is keyboard accessible and compact published filters retain selections across resize', {skip:!chromium}, async () => {
 const browser=await chromium.launch({headless:true});
 try {
  const page=await browser.newPage({viewport:{width:1366,height:900},hasTouch:true});
  const requests=[];
  await page.route('**/*',route=>{
   const url=route.request().url(),pathname=new URL(url).pathname.slice(1);
   if(reviewedModules.has(pathname))return route.fulfill({contentType:'text/javascript',body:reviewedModules.get(pathname)});
   if(pathname==='catalog-ui.mjs')return route.fulfill({contentType:'text/javascript',body:moduleSource});
   if(pathname==='review.mjs')return route.fulfill({contentType:'text/javascript',body:reviewSource});
   if(url==='http://direction.test/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0}</style><main id="root"></main>'});
   requests.push(url);return route.abort();
  });
  await page.goto('http://direction.test/');await page.addStyleTag({content:fontCss+css});await page.evaluate(()=>document.fonts.ready);
  const entries=JSON.parse(fs.readFileSync(new URL('./catalog.json',import.meta.url),'utf8')).slice(0,3).map(({thumbnailUrl,...entry})=>({...entry,tier:'Curated'}));
  await page.evaluate(async entries=>{
   const {mountExtraTracks}=await import('/catalog-ui.mjs');
   window.catalog=mountExtraTracks({document,root:document.querySelector('#root'),entries,getFeedback:()=>({favorite:true})});catalog.open();
  },entries);
  const sort=page.getByLabel('Sort',{exact:true}),direction=page.locator('.sq-extra-sort-direction');
  assert.equal(await direction.isDisabled(),true);
  const labels=await sort.locator('option').allTextContents();
  assert.equal(new Set(labels).size,labels.length);
  for(const label of ['Name','Rating','Difficulty','Votes'])assert.ok(labels.includes(label));
  assert.ok(labels.every(label=>!/:|first|A-Z|10 to 1|1 to 10/.test(label)),'metric labels are not directional');
  const names=()=>page.locator('.sq-extra-card h3').allTextContents();
  await sort.selectOption('name');const ascending=await names();
  await direction.focus();await page.keyboard.press('Enter');
  assert.deepEqual(await names(),[...ascending].reverse());
  assert.match(await direction.getAttribute('aria-label'),/descending.*Switch to ascending/);
  assert.equal(await direction.evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('Space');assert.deepEqual(await names(),ascending);
  await page.locator('.sq-extra-advanced-toggle').click();
  await page.getByLabel('My favorites',{exact:true}).check();await page.getByLabel('Curated only',{exact:true}).check();
  await page.getByLabel('Rating',{exact:true}).selectOption('6');
  const filtered=[...await names()].sort(),qualityOptions=await page.getByLabel('Rating',{exact:true}).locator('option').allTextContents();
  await sort.selectOption('review-quality');await direction.focus();await page.keyboard.press('Enter');
  assert.deepEqual([...await names()].sort(),filtered);
  assert.deepEqual(await page.getByLabel('Rating',{exact:true}).locator('option').allTextContents(),qualityOptions);
  for(const [width,height] of [[1366,900],[820,1180],[390,844],[320,568],[844,320]]) {
   await page.setViewportSize({width,height});
   assert.equal(await page.getByLabel('Rating',{exact:true}).inputValue(),'6');
   assert.equal(await page.getByLabel('My favorites',{exact:true}).isChecked(),true);
   assert.equal(await page.getByLabel('Curated only',{exact:true}).isChecked(),true);
   const layout=await page.locator('.sq-extra-controls').evaluate(el=>{
    const box=node=>{const r=node.getBoundingClientRect();return {x:r.x,right:r.right,y:r.y,bottom:r.bottom,width:r.width,height:r.height};};
    return {overflow:el.scrollWidth>el.clientWidth+1,sort:box(el.querySelector('.sq-extra-sort-controls')),arrow:box(el.querySelector('.sq-extra-sort-direction')),fields:[...el.querySelectorAll('.sq-extra-reviewed-controls .sq-extra-field')].map(box),checks:[...el.querySelectorAll('.sq-extra-check')].map(box)};
   });
   assert.equal(layout.overflow,false,'no toolbar overflow at '+width);
   assert.ok(layout.sort.width<=300,'Sort is bounded rather than stretching at '+width);
   assert.ok(layout.arrow.width>=44&&layout.arrow.height>=44,'direction has a touch target');
   assert.ok(Math.abs(layout.checks[0].y-layout.checks[1].y)<1,'Favorites and Curated share a row');
   for(const field of layout.fields)assert.ok(field.x>=0&&field.right<=width,'published fields fit');
   if(width>=601)assert.ok(layout.fields.every(field=>Math.abs(field.y-layout.fields[0].y)<1),'three published metrics share one row');
   if(width===390)assert.ok(layout.fields[0].width>=160,'mobile rating retains room for its selected score and count');
   if(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR&&[1366,390,320].includes(width)) {
    await page.evaluate(()=>document.querySelector('.sq-extra-menu').scrollTop=0);
    await page.screenshot({path:process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR+'/extra-direction-'+width+'.png'});
   }
  }
  await page.getByRole('button',{name:'Reset filters',exact:true}).click();
  assert.equal(await sort.inputValue(),'recommended');assert.equal(await direction.isDisabled(),true);
  assert.deepEqual(requests,[],'all UI interactions stay offline');
 } finally {await browser.close();}
});
