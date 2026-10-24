import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {startResponsiveServer} from './responsive-server.mjs';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require('playwright');
const output=path.resolve(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR||'local-reports/ranked-controls');
await fs.mkdir(output,{recursive:true});
const server=await startResponsiveServer(),browser=await chromium.launch({headless:true});
const report={scope:'Offline Chromium emulation; no production requests.',cases:[],errors:[]};
try{
  const page=await browser.newPage({viewport:{width:1366,height:600}});
  page.on('pageerror',error=>report.errors.push(String(error)));
  await page.route('**/*',route=>new URL(route.request().url()).origin===server.url?route.continue():route.abort());
  await page.goto(server.url,{waitUntil:'domcontentloaded'});
  await page.getByRole('button',{name:'Exit',exact:true}).waitFor({timeout:45000});
  await page.getByRole('button',{name:'Exit',exact:true}).click();
  await page.getByRole('button',{name:'Back',exact:true}).click();
  await page.getByRole('button',{name:'Ranked',exact:true}).click();
  const shortcuts=page.locator('[data-leaderboard-shortcut]');
  await shortcuts.first().waitFor();
  if(await shortcuts.count()!==4)throw Error('Expected four quick rankings');
  for(const key of ['2','3','4','1']){
    const target=await shortcuts.nth(Number(key)-1).getAttribute('data-leaderboard-shortcut');
    await page.keyboard.press(key);
    const selected=page.locator(`[data-leaderboard-shortcut="${target}"]`);
    if(await selected.getAttribute('aria-pressed')!=='true')throw Error('Shortcut failed: '+key);
  }
  report.cases.push({test:'four ranking shortcuts',status:'pass'});
  await page.locator('[data-leaderboard-shortcut="overall"]').click();
  const pageInput=page.locator('#overallPageJump');
  if(await pageInput.getAttribute('type')!=='text')throw Error('Page input still has a spinner');
  if(await pageInput.isEnabled()){
    await pageInput.fill('1');await pageInput.press('Enter');await pageInput.press('ArrowUp');
    if(await pageInput.inputValue()!=='1')throw Error('Arrow key changed page input');
    report.cases.push({test:'plain numeric page field',status:'pass'});
  }else report.cases.push({test:'plain numeric page field',status:'disabled for single-page fixture; input behavior covered by unit tests'});
  await page.locator('#overallHelpBtn').click();
  for(const [width,height] of [[1366,600],[390,844],[844,320],[1920,1080]]){
    await page.setViewportSize({width,height});
    const summaries=page.locator('.ranked-help-controls summary');
    for(let i=0;i<await summaries.count();i++){
      const item=summaries.nth(i);
      if(!await item.evaluate(node=>node.parentElement.open))await item.click();
    }
    await page.locator('#overallHelpClose').scrollIntoViewIfNeeded();
    const closeLabelFits=await page.locator('#overallHelpClose').evaluate(node=>{
      const range=document.createRange();range.selectNodeContents(node);
      const label=range.getBoundingClientRect(),button=node.getBoundingClientRect();
      return button.width>=88&&button.height>=44&&label.left>=button.left+10&&label.right<=button.right-10;
    });
    if(!closeLabelFits)throw Error(`Help Close label clipped at ${width}x${height}`);
    const bounds=await page.locator('.overall-help-card').evaluate(node=>{
      const r=node.getBoundingClientRect();
      return {overflow:node.scrollWidth>node.clientWidth+2,inBounds:r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1};
    });
    if(bounds.overflow||!bounds.inBounds)throw Error(`Help overflow at ${width}x${height}`);
    await page.locator('.overall-help-card').evaluate(node=>node.scrollTop=0);
    if(width>=1000){
      const tops=await page.locator('.overall-help-grid > section').evaluateAll(nodes=>nodes.map(node=>node.getBoundingClientRect().top));
      if(Math.max(...tops)-Math.min(...tops)>2)throw Error('Desktop help overview has an unintended empty column');
    }
    await page.screenshot({path:path.join(output,`help-${width}x${height}.png`)});
    report.cases.push({test:`help expanded ${width}x${height}`,status:'pass'});
  }
  await page.keyboard.press('Escape');
  if(await page.locator('#overallHelpPopup').isVisible())throw Error('Escape did not close Help');
  report.cases.push({test:'Escape closes help',status:'pass'});
}catch(error){report.errors.push(String(error));process.exitCode=1;}
finally{await browser.close();await server.close();await fs.writeFile(path.join(output,'ranked-controls.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
