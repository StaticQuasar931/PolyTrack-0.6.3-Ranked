import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {startResponsiveServer} from './responsive-server.mjs';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require('playwright');
const output=path.resolve(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR||'local-reports/responsive');await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true});
const report={scope:'Before = tracked HEAD revision 167 UI; after = working tree. Practice pictures are synthetic-data production-component fixtures.',captures:[],errors:[]};
try{
  for(const baseline of [true,false]){
    const phase=baseline?'before':'after',server=await startResponsiveServer({baseline}),context=await browser.newContext({viewport:{width:1366,height:600}}),page=await context.newPage();page.setDefaultTimeout(20000);
    await page.route('**/*',route=>new URL(route.request().url()).origin===server.url?route.continue():route.abort());
    const capture=async name=>{const file=phase+'-'+name+'.png';await page.screenshot({path:path.join(output,file)});report.captures.push(file);};
    try{
      await page.goto(server.url,{waitUntil:'domcontentloaded'});await page.getByRole('button',{name:'Exit',exact:true}).click({timeout:40000});await page.getByRole('button',{name:'Back',exact:true}).click();
      await page.getByRole('button',{name:'Settings',exact:true}).click();await page.locator('#sqRankedSettings').waitFor();await capture('settings-1366x600');await page.getByRole('button',{name:'Cancel',exact:true}).click();
      await page.getByRole('button',{name:'Ranked',exact:true}).click();await page.locator('#overallLeaderboardList .overall-entry').first().waitFor();await page.waitForTimeout(250);await capture('ranked-1366x600');
      await page.setViewportSize({width:390,height:844});await page.waitForTimeout(150);await capture('ranked-390x844');
      await page.evaluate(async()=>{
        const {renderPracticeProfile,installPracticeProfileControls}=await import('/tools/practice-profile.mjs');
        const names=['Summer 4','Winter 5','Winter 4','Desert 3'],thumbs=['summer4','winter5','winter4','desert3'];
        const rows=names.map((trackName,i)=>({trackId:String(i),trackName,activeMs:300000+i*42000,attempts:24-i,finishes:i?1:0,restarts:23-i,sincePbMs:96000,lastPlayedAt:Date.now()-i*86400000,trackedBestMs:i?21000+i*1000:0}));
        const results=rows.map((r,i)=>({trackId:r.trackId,timeMs:19000+i*1000,rank:8+i,fieldSize:124,source:'snapshot',pbAt:Date.now()-i*86400000}));
        const content=document.getElementById('overallProfileContent');content.innerHTML=renderPracticeProfile({rows,results,coverage:{coverageFraction:.05},trackPreview:id=>'<img src="/tracks/official/thumbnails/'+thumbs[Number(id)]+'.png" alt="">'});
        const section=content.querySelector('.polytrack-practice-profile');section.open=true;installPracticeProfileControls(section);
        document.getElementById('overallProfilePopup').style.display='flex';
      });
      await page.waitForTimeout(150);await capture('practice-390x844');await page.setViewportSize({width:1366,height:600});await page.waitForTimeout(150);await capture('practice-1366x600');
    }catch(error){report.errors.push({phase,error:String(error)});}
    finally{await context.close();await server.close();}
  }
}finally{await browser.close();await fs.writeFile(path.join(output,'comparisons.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
