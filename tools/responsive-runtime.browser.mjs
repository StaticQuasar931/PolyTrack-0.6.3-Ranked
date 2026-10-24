import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {startResponsiveServer} from './responsive-server.mjs';
import {layoutMatrix,representativeSizes} from './responsive-matrix.mjs';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const engines=require('playwright');
const output=path.resolve(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR||'local-reports/responsive');
await fs.mkdir(output,{recursive:true});
const report={scope:'Offline native game; mock Firebase, external network blocked. Not real-device performance.',cases:[],screenshots:[],unavailable:[],errors:[]};
const server=await startResponsiveServer();
const all=process.env.POLYTRACK_FULL_MATRIX==='1';
const sizes=process.env.POLYTRACK_AUDIT_SIZES?JSON.parse(process.env.POLYTRACK_AUDIT_SIZES).map(([width,height])=>({width,height})):all?layoutMatrix:representativeSizes.map(([width,height])=>({width,height}));
const enginesToTest=(process.env.POLYTRACK_AUDIT_BROWSERS||'chromium,firefox,webkit').split(',');
async function inspect(page,label,engine,profile){
  await page.waitForFunction(()=>{const canvas=document.querySelector('canvas');return !canvas||Math.abs(canvas.getBoundingClientRect().width-innerWidth)<2;},undefined,{timeout:3000}).catch(()=>{});
  // Native image buttons animate their skew after a resize; measure settled bounds.
  await page.waitForTimeout(180);
  const result=await page.evaluate(()=>{
    const visible=node=>{const s=getComputedStyle(node),r=node.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;};
    const rect=node=>{const r=node.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
    const roots=[...document.querySelectorAll('#overallLeaderboardPanel .overall-shell,.settings-menu-ui,.car-menu-ui,.multiplayer-ui,.track-selection-ui,.track-info-ui,.sq-events-dialog,.extra-tracks-dialog')].filter(visible);
    const panels=roots.map(node=>({name:node.className,...rect(node),scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,overflowChildren:[...node.children].filter(visible).filter(child=>child.getBoundingClientRect().right>node.getBoundingClientRect().right+2).map(child=>({name:child.className,...rect(child)})),overflowDescendants:node.scrollWidth>node.clientWidth+3?[...node.querySelectorAll('*')].filter(visible).filter(child=>child.getBoundingClientRect().right>node.getBoundingClientRect().right+2).slice(0,8).map(child=>({name:child.className,parent:child.parentElement.className,...rect(child)})):[]}));
    const canvas=document.querySelector('canvas');
    const controls=[...document.querySelectorAll('#closeOverallLeaderboard,#overallHelpBtn,#overallFindMeBtn,.settings-menu-ui>.button-wrapper>button,.track-info-ui>.leaderboard-ui>.button-wrapper>button,.sq-events-dialog header button')].filter(visible).map(node=>({label:node.getAttribute('aria-label')||node.textContent.trim(),...rect(node)}));
    return {width:innerWidth,height:innerHeight,dpr:devicePixelRatio,panels,controls,documentOverflow:document.documentElement.scrollWidth>innerWidth+2,canvas:canvas?rect(canvas):null};
  });
  const failures=[];
  if(result.documentOverflow)failures.push('page horizontal overflow');
  for(const panel of result.panels){if(panel.left<-2||panel.right>result.width+2||panel.top<-2||panel.bottom>result.height+2)failures.push('panel outside viewport: '+panel.name);if(panel.scrollWidth>panel.clientWidth+3)failures.push('panel horizontal overflow: '+panel.name);}
  for(const control of result.controls){if(control.left<-2||control.right>result.width+2||control.top<-2||control.bottom>result.height+2)failures.push('essential control outside viewport: '+control.label);}
  report.cases.push({screen:label,browser:engine,input:profile.hasTouch?'touch emulation':'mouse/keyboard',...result,failures,status:failures.length?'fail':'pass'});
  return result;
}
async function capture(page,label,engine){
  const size=page.viewportSize(),dpr=await page.evaluate(()=>devicePixelRatio),name=[engine,label,size.width+'x'+size.height,'dpr'+dpr].join('-').replace(/[^a-zA-Z0-9_-]/g,'_')+'.png';
  await page.screenshot({path:path.join(output,name)});report.screenshots.push(name);
}
async function mainMenu(page){
  await page.goto(server.url,{waitUntil:'domcontentloaded',timeout:20000});
  await page.getByRole('button',{name:'Exit',exact:true}).waitFor({timeout:40000});
  await page.getByRole('button',{name:'Exit',exact:true}).click();
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await page.getByRole('button',{name:'Settings',exact:true}).waitFor();
}
try{
  for(const engineName of enginesToTest){
    let browser;
    try{
      const executablePath=engineName==='firefox'&&process.env.POLYTRACK_FIREFOX_EXECUTABLE?process.env.POLYTRACK_FIREFOX_EXECUTABLE:undefined;
      browser=await engines[engineName].launch({headless:true,timeout:12000,...(executablePath?{executablePath}:{})});
    }
    catch(error){report.unavailable.push({browser:engineName,reason:String(error).split('\n')[0]});continue;}
    try{
      for(const profile of (process.env.POLYTRACK_AUDIT_FAST==='1'?[{deviceScaleFactor:1,hasTouch:false}]:[{deviceScaleFactor:1,hasTouch:false},{deviceScaleFactor:2,hasTouch:true},{deviceScaleFactor:3,hasTouch:true}])){
        const context=await browser.newContext({...profile,viewport:{width:1366,height:600}}),page=await context.newPage();
        page.setDefaultTimeout(12000);page.on('pageerror',error=>report.errors.push({browser:engineName,error:String(error)}));
        await page.route('**/*',route=>new URL(route.request().url()).origin===server.url?route.continue():route.abort());
        try{
          await mainMenu(page);
          const profileSizes=profile.deviceScaleFactor===1?sizes:[{width:390,height:844},{width:844,height:320}];
          for(const size of profileSizes){await page.setViewportSize(size);await page.waitForTimeout(50);await inspect(page,'home',engineName,profile);}
          await page.setViewportSize({width:1366,height:600});await capture(page,'home',engineName);
          for(const label of (process.env.POLYTRACK_AUDIT_SCREENS==='none'?[]:(process.env.POLYTRACK_AUDIT_SCREENS||'Settings,Garage,Multiplayer,Ranked').split(','))){
            await page.getByRole('button',{name:label,exact:true}).click();
            if(label==='Settings')await page.locator('#sqRankedSettings').waitFor({state:'attached'});
            if(label==='Ranked')await page.locator('#overallLeaderboardPanel').waitFor({state:'visible'});
            await page.waitForTimeout(300);
            for(const size of profileSizes){await page.setViewportSize(size);await page.waitForTimeout(50);await inspect(page,label.toLowerCase(),engineName,profile);}
            for(const [width,height]of [[1366,600],[390,844],[844,320]]){await page.setViewportSize({width,height});await page.waitForTimeout(80);await capture(page,label.toLowerCase(),engineName);}
            if(label==='Ranked'){
              await page.locator('#overallHelpBtn').click();await inspect(page,'help',engineName,profile);await capture(page,'help',engineName);
              await page.keyboard.press('Escape');await page.locator('#closeOverallLeaderboard').click();
            }else await page.getByRole('button',{name:label==='Settings'?'Cancel':label==='Garage'?'Exit':/^(Back|Cancel|Close)$/}).last().click();
            await page.getByRole('button',{name:'Settings',exact:true}).waitFor();
          }
          await page.getByRole('button',{name:'Play',exact:true}).click();await page.locator('.track-selection-ui').waitFor({state:'visible'});
          for(const size of profileSizes){await page.setViewportSize(size);await page.waitForTimeout(50);await inspect(page,'track-selection',engineName,profile);}
          await page.setViewportSize({width:1366,height:600});await capture(page,'track-selection',engineName);
          const community=page.locator('.track-selection-ui > .image-button-container > button').nth(1);await community.click();await page.waitForTimeout(300);await capture(page,'community-events',engineName);
          await page.setViewportSize({width:390,height:844});await inspect(page,'community-events-phone',engineName,profile);await capture(page,'community-events',engineName);
        }catch(error){report.errors.push({browser:engineName,input:profile,error:String(error)});}
        finally{await context.close();}
      }
    }finally{await browser.close();}
  }
}finally{
  await server.close();await fs.writeFile(path.join(output,'runtime-matrix.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({cases:report.cases.length,failed:report.cases.filter(c=>c.status==='fail').length,errors:report.errors,unavailable:report.unavailable}));
}
