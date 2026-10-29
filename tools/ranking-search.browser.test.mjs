import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {startResponsiveServer} from './responsive-server.mjs';
import {installNativeRankedAuditFixture,auditNativeRankedClick} from './native-ranked-audit-fixture.mjs';
const require=createRequire(new URL('./verifier/package.json',import.meta.url)),{chromium}=require('playwright');
test('native Overall search finds later-page racers with no remote reads and fits resized headers',{timeout:150000},async t=>{
  const server=await startResponsiveServer(),browser=await chromium.launch({headless:true});
  const output=process.env.POLYTRACK_SEARCH_OUTPUT||await fs.mkdtemp(join(tmpdir(),'polytrack-search-'));
  await fs.mkdir(output,{recursive:true});
  t.diagnostic('Search evidence: '+output);
  try{
    const page=await browser.newPage({viewport:{width:1366,height:768},serviceWorkers:'block'}),remote=[],messages=[],responses=[];
    page.on('console',message=>{if(['warning','error'].includes(message.type()))messages.push(message.text());});
    page.on('response',response=>{if(response.status()>=400||response.url().includes('public-snapshots'))responses.push({url:response.url(),status:response.status()});});
    page.on('requestfailed',request=>responses.push({url:request.url(),error:request.failure()?.errorText}));
    await page.route('**/*',route=>{
      const url=new URL(route.request().url());
      if(url.pathname==='/v6/user')return route.fulfill({status:200,contentType:'application/json',body:'null'});
      if(url.origin===server.url&&['GET','HEAD'].includes(route.request().method()))return route.continue();
      remote.push(url.href);return route.abort();
    });
    await installNativeRankedAuditFixture(page,{rejectWrites:true});
    await page.goto(server.url,{waitUntil:'domcontentloaded'});const audit=await auditNativeRankedClick(page);
    assert.deepEqual(audit.errors,[]);assert.deepEqual(audit.rejections,[]);assert.deepEqual(audit.pageErrors,[]);
    try{await page.locator('#overallLeaderboardList .overall-entry').first().waitFor();}catch(error){
      await page.screenshot({path:output+'/load-failure.png'});await fs.writeFile(output+'/load-failure.json',JSON.stringify({state:await page.evaluate(()=>({body:document.body.innerText,audit:window.__ptNativeRankedAudit})),messages,responses},null,2));throw error;
    }
    await page.waitForFunction(()=>!document.getElementById('overallNextPage').disabled);
    await page.locator('#overallNextPage').click();
    await page.waitForFunction(()=>document.getElementById('overallPageJump').value==='2');
    const target=await page.locator('#overallLeaderboardList .overall-entry').first().evaluate(row=>({id:row.dataset.userid,rank:row.querySelector('.overall-rank').textContent,name:row.querySelector('.overall-name-main').firstChild.textContent.trim()}));
    await page.locator('#overallPrevPage').click();
    const remoteBeforeSearch=remote.length;
    await page.keyboard.press('Control+f');assert.equal(await page.evaluate(()=>document.activeElement.id),'overallRacerSearch');
    await page.locator('#overallRacerSearch').fill(target.id);
    await page.waitForFunction(id=>document.querySelector('#overallLeaderboardList .overall-entry')?.dataset.userid===id,target.id);
    assert.equal(await page.locator('#overallLeaderboardList .overall-rank').textContent(),target.rank);
    assert.equal(await page.locator('#overallPageJump').inputValue(),'1');
    assert.match(await page.locator('#overallSearchStatus').textContent(),/1 matches/);
    await page.keyboard.press('Escape');assert.equal(await page.locator('#overallRacerSearch').inputValue(),'');
    assert.equal(await page.locator('#overallLeaderboardPanel').isVisible(),true);
    await page.locator('#overallRacerSearch').fill(target.name);
    assert.ok(await page.locator('#overallLeaderboardList .overall-entry').count()>0);
    await page.locator('#overallRacerSearch').fill('no-such-racer-unique-check');
    await page.getByRole('button',{name:'Clear search',exact:true}).click();
    assert.equal(await page.locator('#overallRacerSearch').inputValue(),'');
    await page.locator('#overallRacerSearch').fill('rank:<=3');
    const ranks=await page.locator('#overallLeaderboardList .overall-rank').allTextContents();
    assert.ok(ranks.length>0&&ranks.every(rank=>Number(rank.replace(/\D/g,''))<=3),'numeric rank filters cover the loaded standing, not just the visible page');
    await page.locator('#overallRacerSearch').fill('playtime:>bad');
    assert.equal(await page.locator('#overallRacerSearch').getAttribute('aria-invalid'),'true');
    assert.match(await page.locator('#overallLeaderboardList').textContent(),/playtime:>42h/);
    await page.getByRole('button',{name:'Clear search',exact:true}).click();
    assert.equal(await page.locator('#overallRacerSearch').getAttribute('aria-invalid'),'false');
    for(const [width,height]of [[1366,768],[390,844],[844,390],[768,1024],[320,568],[1920,1080],[540,720],[720,540],[344,882],[882,344]]){
      await page.setViewportSize({width,height});
      const geometry=await page.locator('#overallRacerSearch').evaluate(input=>{
        const r=input.getBoundingClientRect(),header=input.closest('.overall-top').getBoundingClientRect();
        const host=input.closest('#overallFilterPanel'),label=input.closest('label'),filter=host.querySelector('[data-personal-filter-button]');
        return {left:r.left,right:r.right,width:r.width,headerLeft:header.left,headerRight:header.right,scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth,
          hostWidth:host.getBoundingClientRect().width,labelWidth:label.getBoundingClientRect().width,filterWidth:filter?.getBoundingClientRect().width};
      });
      await page.screenshot({path:`${output}/${width}x${height}.png`});
      await fs.writeFile(`${output}/${width}x${height}.json`,JSON.stringify(geometry));
      assert.ok(geometry.width>=70&&geometry.left>=geometry.headerLeft-1&&geometry.right<=geometry.headerRight+1,JSON.stringify({width,height,geometry}));
      assert.ok(geometry.scroll<=geometry.client+1);
    }
    // Search and paging do not trigger any remote backend request.
    assert.ok(remote.slice(remoteBeforeSearch).every(url=>!url.includes('firestore.googleapis.com')&&!url.includes('.workers.dev')),'search never falls back to a live database or Worker read');
    const evidence=await page.evaluate(()=>window.__ptNativeRankedAudit);assert.deepEqual(evidence.errors,[]);assert.deepEqual(evidence.rejections,[]);
    t.diagnostic('Search uses complete loaded standings; screenshots: '+output);
  }finally{await browser.close();await server.close();}
});
