import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {PROFILE_SHOP_CATALOG} from './profile-shop-catalog.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require('C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const evidence='C:/Users/Static/Documents/Codexstorage/PolyTrack/Projects/Ranked-0.6.3/2026-11-14/cosmetics-phase2';

test('staged art and native paint hooks render offline without injecting live options',{timeout:60000},async()=>{
  const patch=await fs.readFile(path.join(root,'polytrack_062_patch.js'),'utf8');
  const nativeStyles=patch.match(/  function ensureStyles\([^\n]*\)\{[\s\S]*?\n  \}/)?.[0];assert(nativeStyles);
  const allowed=new Set(['profile-shop-art.mjs','profile-shop-art.css','profile-shop-expanded-designs.mjs','profile-shop-catalog.mjs']);
  const server=http.createServer(async(req,res)=>{
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>@font-face{font-family:ForcedSquare;src:url(/forced_square.woff2)}body{margin:0;background:#142439;color:#eaf2f5;font:17px/1.4 ForcedSquare,sans-serif}*{box-sizing:border-box}header{padding:20px;border-bottom:1px solid #61788d}h1{font-size:28px;font-weight:normal;margin:0}header p{margin:8px 0 0;color:#bad1db}#cards{padding:20px;display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:20px}figure{margin:0;min-width:0;background:#1b3046;border:1px solid #526a7e}figure>.profile-shop-art{height:auto;aspect-ratio:320/88}figcaption{padding:12px;font-size:20px}small{display:block;font-size:14px;line-height:1.5;color:#b9cedb;margin-top:6px}.native-sample{padding:12px;border-top:1px solid #526a7e}.native-sample .overall-entry{opacity:1!important;transform:none!important;display:block!important;min-height:58px!important;padding:12px!important;clip-path:none!important}.native-sample .overall-name-main{font-size:22px!important}.native-sample .overall-name{display:block!important}.native-sample .profile-identity h3{font-size:22px;margin:8px 0}.native-sample .name-preview{font-size:22px}@media(max-width:660px){#cards{grid-template-columns:1fr;padding:12px;gap:12px}}</style><header><h1>PolyTrack / six staged designs</h1><p>Offline art review only. No items added to the live shop.</p></header><main id="cards"></main></html>');return;}
    if(pathname!=='/forced_square.woff2'&&(!pathname.startsWith('/tools/')||!allowed.has(pathname.slice(7)))){res.writeHead(404).end();return;}
    try{res.setHeader('Content-Type',pathname.endsWith('.mjs')?'text/javascript':pathname.endsWith('.css')?'text/css':'font/woff2');res.end(await fs.readFile(path.join(root,pathname.slice(1))));}catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  const report={scope:'Staged visual-only cards with actual ensureStyles CSS; not purchase or option integration',external:[],errors:[],checks:[]};
  await fs.mkdir(evidence,{recursive:true});
  try{
    browser=await chromium.launch({headless:true,timeout:12000,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    const page=await browser.newPage({viewport:{width:1200,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(5000);
    const base=`http://127.0.0.1:${server.address().port}`;
    await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():(report.external.push(route.request().url()),route.abort()));
    page.on('pageerror',error=>report.errors.push(error.message));
    await page.goto(base,{waitUntil:'load'});
    await page.addScriptTag({content:'window.overallFooterLayoutCss=()=>"";'+nativeStyles+';ensureStyles();'});
    await page.addStyleTag({url:base+'/tools/profile-shop-art.css'});
    const state=await page.evaluate(async()=>{
      const {PROFILE_SHOP_EXPANDED_DESIGNS:designs}=await import('/tools/profile-shop-expanded-designs.mjs');
      const {PROFILE_SHOP_CATALOG}=await import('/tools/profile-shop-catalog.mjs');
      const {renderProfileShopArt}=await import('/tools/profile-shop-art.mjs');
      window.catalogBefore=JSON.stringify(PROFILE_SHOP_CATALOG);
      document.querySelector('#cards').innerHTML=designs.map(item=>`<figure data-design="${item.itemId}">${renderProfileShopArt(item.itemId)}<figcaption>${item.label} / ${item.price}<small>${item.fontNote||item.description}</small></figcaption><div class="native-sample"><div class="overall-entry cosmetic-theme-petrol ${item.className}"><span class="overall-name"><b class="overall-name-main">APEX RACER</b></span></div><div class="profile-cosmetic-choice ${item.className}"><div class="profile-cosmetic-preview ${item.slot==='nameFont'||item.slot==='nameColor'?'name-preview':''}">${item.slot==='nameFont'||item.slot==='nameColor'?'Aa':'<i></i>'}</div></div></div></figure>`).join('');
      await document.fonts.ready;
      const read=(id,selector)=>{const el=document.querySelector(`[data-design="${id}"] ${selector}`),s=getComputedStyle(el);return {family:s.fontFamily,color:s.color,a:s.getPropertyValue('--cosmetic-a').trim(),b:s.getPropertyValue('--cosmetic-b').trim(),edgeWidth:s.borderLeftWidth,edgeStyle:s.borderLeftStyle,pattern:s.getPropertyValue('--sq-stripe-art'),background:s.backgroundImage};};
      return {catalogLength:PROFILE_SHOP_CATALOG.length,petrol:read('profile-petrol','.overall-entry'),navy:read('profile-navy-secondary','.overall-entry'),rail:read('profile-rail','.overall-entry'),rally:read('profile-rally-lines','.overall-entry'),book:read('profile-book-serif','.overall-name-main'),copper:read('profile-copper-ink','.overall-name-main')};
    });
    assert.equal(state.catalogLength,PROFILE_SHOP_CATALOG.length);assert.equal(state.petrol.a,'#163e48');assert.equal(state.navy.b,'#142b46');
    assert.equal(state.rail.edgeWidth,'8px');assert.equal(state.rail.edgeStyle,'ridge');assert.match(state.rally.pattern,/data:image\/svg\+xml/);
    assert.match(state.book.family,/Palatino Linotype.*Palatino.*Georgia.*serif/);assert.equal(state.copper.color,'rgb(239, 186, 145)');
    report.checks.push(state);
    await page.screenshot({path:path.join(evidence,'expanded-profile-designs-desktop.png'),timeout:5000,animations:'disabled'});
    await page.setViewportSize({width:390,height:844});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.join(evidence,'expanded-profile-designs-phone.png'),timeout:5000,animations:'disabled',fullPage:true});
    await page.evaluate(async()=>{
      const {PROFILE_SHOP_EXPANDED_DESIGNS:designs}=await import('/tools/profile-shop-expanded-designs.mjs');const {renderProfileShopArt}=await import('/tools/profile-shop-art.mjs');
      for(const item of designs){const figure=document.querySelector(`[data-design="${item.itemId}"]`);figure.querySelector('svg').outerHTML=renderProfileShopArt(item.itemId,{density:'low'});figure.querySelector('.native-sample').dataset.profileArtDensity='low';}
    });
    const lowPattern=await page.locator('[data-design="profile-rally-lines"] .overall-entry').evaluate(el=>getComputedStyle(el).getPropertyValue('--sq-stripe-art'));
    assert.notEqual(lowPattern,state.rally.pattern,'low density drops detail strokes but retains rally lanes');
    report.lowDensityPatternDistinct=true;
    await page.setViewportSize({width:1200,height:1000});
    await page.screenshot({path:path.join(evidence,'expanded-profile-designs-low-density.png'),timeout:5000,animations:'disabled'});
    assert.equal(await page.evaluate(async()=>JSON.stringify((await import('/tools/profile-shop-catalog.mjs')).PROFILE_SHOP_CATALOG)===catalogBefore),true);
    assert.equal(await page.locator('[data-cosmetic-choice],[data-sp-action]').count(),0);
    assert.deepEqual(report.external,[]);assert.deepEqual(report.errors,[]);report.passed=true;
  }finally{await fs.writeFile(path.join(evidence,'expanded-profile-designs-browser.json'),JSON.stringify(report,null,2));await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
