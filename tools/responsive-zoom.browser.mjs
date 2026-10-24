import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {startResponsiveServer} from './responsive-server.mjs';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require('playwright');
const output=path.resolve(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR||'local-reports/responsive');
const extension=path.join(output,'local-zoom-fixture');await fs.mkdir(extension,{recursive:true});
// No host, tabs, network or user-profile permission. This isolated test profile is disposable.
await fs.writeFile(path.join(extension,'manifest.json'),JSON.stringify({manifest_version:3,name:'Local layout zoom fixture',version:'1.0',background:{service_worker:'background.js'}}));
await fs.writeFile(path.join(extension,'background.js'),"chrome.runtime.onInstalled.addListener(()=>{});\n");
const server=await startResponsiveServer();
const report={scope:'Actual isolated Chromium tab zoom using chrome.tabs.setZoom; not DPR emulation.',cases:[],unavailable:[]};
let context;
try{
  context=await chromium.launchPersistentContext(path.join(output,'zoom-test-profile'),{channel:'chromium',headless:true,timeout:15000,viewport:{width:1366,height:650},args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker',{timeout:12000});
  const page=context.pages()[0];page.setDefaultTimeout(15000);
  await page.route('**/*',route=>new URL(route.request().url()).origin===server.url?route.continue():route.abort());
  await page.goto(server.url,{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'Exit',exact:true}).click({timeout:30000});await page.getByRole('button',{name:'Back',exact:true}).click();
  await page.getByRole('button',{name:'Ranked',exact:true}).click();
  await page.locator('#overallLeaderboardList .overall-entry').first().waitFor({timeout:20000});
  for(const factor of [1,1.25,1.5,2]){
    const applied=await worker.evaluate(async factor=>{const tabs=await chrome.tabs.query({active:true,currentWindow:true});if(tabs.length!==1)throw Error('Ambiguous isolated test tab');await chrome.tabs.setZoom(tabs[0].id,factor);return chrome.tabs.getZoom(tabs[0].id);},factor);
    await page.waitForTimeout(250);
    const state=await page.evaluate(()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,overflow:document.documentElement.scrollWidth>innerWidth+1,controls:[...document.querySelectorAll('#overallFindMeBtn,#overallHelpBtn,#closeOverallLeaderboard')].map(node=>{const r=node.getBoundingClientRect();return {text:node.textContent,left:r.left,right:r.right,top:r.top,bottom:r.bottom};})}));
    const pass=Math.abs(applied-factor)<.01&&!state.overflow&&state.controls.every(r=>r.left>=0&&r.top>=0&&r.right<=state.width+1&&r.bottom<=state.height+1);
    report.cases.push({requestedZoom:factor,appliedZoom:applied,...state,status:pass?'pass':'fail'});
    await page.screenshot({path:path.join(output,'chromium-real-zoom-'+Math.round(factor*100)+'.png')});
  }
  await worker.evaluate(async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});await chrome.tabs.setZoom(tab.id,1);});
}catch(error){report.unavailable.push(String(error));}
finally{await context?.close();await server.close();await fs.writeFile(path.join(output,'zoom-matrix.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
