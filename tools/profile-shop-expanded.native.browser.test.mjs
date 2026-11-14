import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {gunzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
import {startResponsiveServer} from './responsive-server.mjs';
import {RELEASE_INFO} from './release-info.mjs';
const {chromium}=createRequire(import.meta.url)('C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const root=fileURLToPath(new URL('../',import.meta.url));
const evidence='C:/Users/Static/Documents/Codexstorage/PolyTrack/Projects/Ranked-0.6.3/2026-11-14/cosmetics-phase2';

test('six staged classes paint actual native Main rows and real Studio without registration',{timeout:120000},async()=>{
  const index=JSON.parse(await fs.readFile(path.join(root,'public-snapshots83/index.json'),'utf8'));
  const encoded=await fs.readFile(path.join(root,'public-snapshots83',index.files['overall-pages/1.json'].path));
  const firstPage=JSON.parse(gunzipSync(Buffer.from(encoded.map(byte=>byte^0xa7))));
  const accountId=String(firstPage.entries[0].userId||firstPage.entries[0].accountId);
  const server=await startResponsiveServer();let browser,page;
  const report={scope:'Actual native app with temporary visual classes only; no option insertion, grant, saved design or catalog mutation',phases:[],main:[],studio:null,external:[],errors:[]};
  const phase=name=>{report.phases.push(name);console.log(name);};
  try{
    browser=await chromium.launch({headless:true,timeout:12000,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
    const context=await browser.newContext({viewport:{width:1366,height:900}});page=await context.newPage();page.setDefaultTimeout(6000);
    page.on('pageerror',e=>report.errors.push(e.message));
    await page.route('**/*',route=>route.request().url().startsWith(server.url+'/')?route.continue():(report.external.push(route.request().url()),route.abort()));
    await context.addInitScript(({accountId,release})=>{
      localStorage.setItem('polytrack-0.6.2-active-account-id',accountId);localStorage.setItem('polytrack-0.6.2-guest-account-id',accountId);
      localStorage.setItem('polytrack-site-update-ack-release-v1:'+release.number,'acknowledged');localStorage.setItem('polytrack-site-update-ack-v1:'+release.revision,'acknowledged');
    },{accountId,release:RELEASE_INFO});
    const mouse=async locator=>{
      await locator.waitFor({state:'visible',timeout:20000});
      const deadline=Date.now()+6000;let last;
      do{
        last=await locator.evaluate(el=>{
          el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
          const r=el.getBoundingClientRect(),style=getComputedStyle(el);
          const blockers=[];
          if(!el.disabled&&style.pointerEvents!=='none')for(const fy of [.5,.3,.7])for(const fx of [.5,.3,.7]){
            const x=r.x+r.width*fx,y=r.y+r.height*fy;
            if(x<0||y<0||x>=innerWidth||y>=innerHeight)continue;
            const hit=document.elementFromPoint(x,y);
            if(hit&&el.contains(hit))return {point:{x,y}};
            if(blockers.length<3)blockers.push(hit?.tagName+'.'+hit?.className);
          }
          return {target:el.outerHTML.slice(0,200),rect:r.toJSON(),blockers};
        });
        if(last.point){await page.mouse.click(last.point.x,last.point.y);return;}
        await page.waitForTimeout(100);
      }while(Date.now()<deadline);
      throw Error('Native target remains obscured after bounded hit checks: '+JSON.stringify(last));
    };
    phase('boot actual native app');await page.goto(server.url,{waitUntil:'domcontentloaded',timeout:20000});
    await mouse(page.getByRole('button',{name:'Exit',exact:true}));
    await page.locator('.track-selection-ui:not(.hidden)').waitFor({timeout:20000});
    phase('open Summer 1 native leaderboard');
    await mouse(page.locator('.track-title').filter({hasText:/^Summer 1$/}).first());
    const rowDeadline=Date.now()+35000;let rowsReady=false;
    do{
      rowsReady=await page.evaluate(()=>[...document.querySelectorAll('.leaderboard-ui button.main')].some(el=>el.getBoundingClientRect().width>0));
      if(rowsReady)break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }while(Date.now()<rowDeadline);
    assert.equal(rowsReady,true,'native Main rows render within the bounded Node-side readiness loop');
    await page.evaluate(css=>{const style=document.createElement('style');style.dataset.expandedArtAudit='production-css';style.textContent=css;document.head.append(style);},await fs.readFile(path.join(root,'tools/profile-shop-art.css'),'utf8'));
    phase('inspect native Main row rendered paint');
    report.main=await page.evaluate(async()=>{
      const {PROFILE_SHOP_EXPANDED_DESIGNS:designs}=await import('/tools/profile-shop-expanded-designs.mjs');
      const row=[...document.querySelectorAll('.leaderboard-ui button.main')].find(el=>el.getBoundingClientRect().width>0);
      const before=row.className,style=row.getAttribute('style');const results=[];
      for(const item of designs){
        for(const cls of [...row.classList])if(cls.startsWith('cosmetic-')||cls==='sq-racer-top')row.classList.remove(cls);
        row.classList.add('sq-racer-cosmetic',item.className);
        const s=getComputedStyle(row),name=getComputedStyle(row.querySelector('.name')),pattern=getComputedStyle(row,'::before');
        results.push({slot:item.slot,value:item.value,background:s.backgroundImage,color:name.color,font:name.fontFamily,edgeWidth:s.borderLeftWidth,edgeStyle:s.borderLeftStyle,pattern:pattern.backgroundImage,patternOpacity:pattern.opacity,className:row.className});
      }
      row.className=before;if(style===null)row.removeAttribute('style');else row.setAttribute('style',style);
      return results;
    });
    const bySlot=slot=>report.main.find(x=>x.slot===slot);
    assert.match(bySlot('theme').background,/rgb\(22, 62, 72\).*rgb\(16, 38, 49\)/);
    assert.match(bySlot('baseSecondary').background,/rgb\(20, 43, 70\)/);
    assert.equal(bySlot('edge').edgeWidth,'8px');assert.equal(bySlot('edge').edgeStyle,'ridge');
    assert.match(bySlot('stripe').pattern,/data:image\/svg\+xml/);assert.ok(+bySlot('stripe').patternOpacity>0);
    assert.match(bySlot('nameFont').font,/Palatino Linotype.*Palatino.*Georgia.*serif/);
    assert.equal(bySlot('nameColor').color,'rgb(239, 186, 145)');
    await page.evaluate(async()=>{
      const {PROFILE_SHOP_EXPANDED_DESIGNS:designs}=await import('/tools/profile-shop-expanded-designs.mjs');
      const rows=[...document.querySelectorAll('.leaderboard-ui button.main')].filter(el=>el.getBoundingClientRect().width>0);
      window.nativeRowClasses=rows.slice(0,6).map(el=>el.className);
      designs.forEach((item,i)=>{const row=rows[i];if(!row)return;for(const cls of [...row.classList])if(cls.startsWith('cosmetic-')||cls==='sq-racer-top')row.classList.remove(cls);row.classList.add('sq-racer-cosmetic',item.className);});
    });
    await page.screenshot({path:path.join(evidence,'expanded-real-native-main.png'),timeout:5000});
    await page.evaluate(()=>{const rows=[...document.querySelectorAll('.leaderboard-ui button.main')].filter(el=>el.getBoundingClientRect().width>0);nativeRowClasses.forEach((cls,i)=>rows[i].className=cls);});
    phase('return to actual Ranked profile');
    await mouse(page.locator('.track-info-ui .leaderboard-ui>.button-wrapper>.back:visible'));
    await mouse(page.getByRole('button',{name:'Back',exact:true}).last());
    await page.evaluate(accountId=>{localStorage.setItem('polytrack-0.6.2-active-account-id',accountId);localStorage.setItem('polytrack-0.6.2-guest-account-id',accountId);window.dispatchEvent(new StorageEvent('storage',{key:'polytrack-0.6.2-active-account-id',newValue:accountId,storageArea:localStorage}));},accountId);
    await mouse(page.getByRole('button',{name:'Ranked',exact:true}));
    await page.locator('#overallLeaderboardList .overall-entry[data-userid]').first().waitFor({timeout:20000});
    await mouse(page.locator('#overallFindMeBtn'));
    const ownRow=page.locator('#overallLeaderboardList .overall-entry[data-userid="'+accountId+'"]');
    await ownRow.focus();await page.keyboard.press('Enter');
    await page.locator('#overallProfilePopup').waitFor({state:'visible',timeout:15000});
    await mouse(page.locator('[data-ph-launch="studio"]'));
    const name=page.locator('dialog[open] .profile-preview-stage>span>b');await name.waitFor({state:'visible'});
    phase('inspect actual Studio book font and copper lettering');
    const optionCountBefore=await page.locator('[data-cosmetic-value="book"]').count();
    report.studio=await page.evaluate(()=>{
      const card=document.querySelector('#overallProfileContent').closest('.overall-profile-card');window.nativeCardClass=card.className;
      for(const cls of [...card.classList])if(/^cosmetic-(name-font|name-color|theme|base-secondary|edge|stripe)-/.test(cls))card.classList.remove(cls);
      card.classList.add('cosmetic-name-font-book','cosmetic-name-color-copper','cosmetic-theme-petrol','cosmetic-base-secondary-navy','cosmetic-edge-rail','cosmetic-stripe-rally-lines');
      const el=document.querySelector('dialog[open] .profile-preview-stage>span>b'),s=getComputedStyle(el),r=el.getBoundingClientRect();
      return {text:el.textContent,font:s.fontFamily,color:s.color,visible:r.width>0&&r.height>0,rect:r.toJSON(),optionCount:document.querySelectorAll('[data-cosmetic-value="book"]').length};
    });
    assert.match(report.studio.font,/Palatino Linotype.*Palatino.*Georgia.*serif/);assert.equal(report.studio.color,'rgb(239, 186, 145)');assert.equal(report.studio.visible,true);assert.equal(report.studio.optionCount,optionCountBefore,'visual class application does not insert options');
    const cdp=await context.newCDPSession(page);await cdp.send('DOM.enable');await cdp.send('CSS.enable');
    const doc=await cdp.send('DOM.getDocument');const node=await cdp.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'dialog[open] .profile-preview-stage>span>b'});
    report.studio.platformFonts=(await cdp.send('CSS.getPlatformFontsForNode',{nodeId:node.nodeId})).fonts.filter(f=>f.glyphCount>0);
    assert.ok(report.studio.platformFonts.some(f=>/Palatino|Georgia/i.test(f.familyName)),'installed Book Serif fallback actually renders glyphs');
    await page.screenshot({path:path.join(evidence,'expanded-real-native-studio-book.png'),timeout:5000});
    await page.evaluate(()=>document.querySelector('#overallProfileContent').closest('.overall-profile-card').className=nativeCardClass);
    report.passed=true;
  }catch(error){report.failure=error.stack;report.body=await page?.locator('body').innerText().catch(()=>null);report.dom=await page?.evaluate(()=>[...document.querySelectorAll('button.main')].slice(0,2).map(el=>({rect:el.getBoundingClientRect().toJSON(),html:el.outerHTML.slice(0,1200),parent:el.parentElement.outerHTML.slice(0,200),grandparent:el.parentElement.parentElement.className}))).catch(()=>null);throw error;}
  finally{await fs.mkdir(evidence,{recursive:true});await fs.writeFile(path.join(evidence,'expanded-real-native-browser.json'),JSON.stringify(report,null,2));await browser?.close();await server.close();}
});
