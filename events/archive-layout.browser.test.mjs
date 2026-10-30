import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'../tools/verifier/node_modules/playwright');

test('archive controls and month jumps work offline at desktop and mobile widths',async()=>{
 const server=http.createServer(async(req,res)=>{
  const name=req.url.split('?')[0];
  if(name==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="/events/events.css"><style>body{margin:0;padding:16px;background:#101d40;color:white;font-family:Verdana}button{min-height:44px}main{max-width:1050px;margin:auto}</style><main></main>');return;}
  if(!['/events/events.css','/events/archive-view.mjs'].includes(name)){res.writeHead(404).end();return;}
  res.setHeader('content-type',name.endsWith('.css')?'text/css':'text/javascript');res.end(await fs.readFile(new URL('..'+name,import.meta.url)));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const base=`http://127.0.0.1:${server.address().port}`;
 const browser=await chromium.launch({headless:true});
 try{
  for(const width of [1366,390]){
   const page=await browser.newPage({viewport:{width,height:900}});const errors=[];
   page.on('pageerror',error=>errors.push(error.message));
   await page.route('**/*',route=>route.request().url().startsWith(base)?route.continue():route.abort());
   await page.goto(base);
   await page.evaluate(async()=>{
    const {mountArchiveView}=await import('/events/archive-view.mjs');window.loads=0;window.opens=[];
    const periods=Array.from({length:80},(_,i)=>({id:`event-${i}`,kind:i%2?'daily':'kodub',trackName:`Saved track ${i}`,author:'Saved author',endsAt:Date.UTC(2026,9,24-i),racerCount:0}));
    mountArchiveView(document.querySelector('main'),{periods,loadSnapshot:()=>{window.loads++;},onOpenPeriod:p=>window.opens.push(p.id)});
   });
   await page.getByLabel('Daily',{exact:true}).uncheck();
   await page.getByLabel('Archive month',{exact:true}).fill('2026-09');
   await page.getByRole('button',{name:'Jump to month',exact:true}).click();
   assert.match(await page.locator('.sq-archive-page-count').innerText(),/Page 2 of 4/);
   assert.equal(await page.locator('details[data-event-kind="daily"]').count(),0);
   await page.getByRole('button',{name:'Next',exact:true}).click();
   assert.match(await page.locator('.sq-archive-page-count').innerText(),/Page 3 of 4/);
   assert.equal(await page.locator('details[data-event-kind="daily"]').count(),0);
   await page.locator('summary').first().click();
   await page.getByRole('button',{name:'Track details / practice',exact:true}).first().click();
   assert.equal(await page.evaluate(()=>window.opens.length),1);assert.equal(await page.evaluate(()=>window.loads),1);
   const metrics=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,
    height:document.querySelector('input[type=search]').getBoundingClientRect().height,
    color:getComputedStyle(document.querySelector('input[type=search]')).backgroundColor}));
   assert.equal(metrics.overflow,false);assert.ok(metrics.height>=44);assert.equal(metrics.color,'rgb(20, 36, 81)');
   await page.screenshot({path:new URL(`../tools/archive-${width}.png`,import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),fullPage:true});
   assert.deepEqual(errors,[]);await page.close();
  }
 }finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
});
