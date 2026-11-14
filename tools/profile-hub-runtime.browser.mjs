import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {startResponsiveServer} from './responsive-server.mjs';
import {RELEASE_INFO} from './release-info.mjs';
const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const root=path.resolve(new URL('../',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'));
const output=process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR||'C:/Users/Static/Documents/Codexstorage/PolyTrack/Projects/Ranked-0.6.3/2026-11-13/late-update/native-profile';await fs.mkdir(output,{recursive:true});
const indexBytes=await fs.readFile(new URL('../public-snapshots81/index.json',import.meta.url));const index=JSON.parse(indexBytes),counts=new Map();
for(const logical of Object.keys(index.files))if(/^canonical\/[a-f0-9]{64}\/[a-f0-9]{64}\.json$/.test(logical)){const id=logical.split('/')[2].slice(0,-5);counts.set(id,(counts.get(id)||0)+1);}
const accountId=process.env.POLYTRACK_AUDIT_PUBLIC_ACCOUNT||[...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]))[0]?.[0];
if(!/^[a-f0-9]{64}$/.test(accountId||'')||!counts.has(accountId))throw Error('Public canonical account unavailable');
const report={startedAt:new Date().toISOString(),release:{number:RELEASE_INFO.number,revision:RELEASE_INFO.revision},source:{generation:index.generation,indexSha256:createHash('sha256').update(indexBytes).digest('hex'),publicAccountId:accountId,canonicalBindings:counts.get(accountId)},scope:'Real native app and rendered styles/fonts. Firebase is an empty local SDK mock with every write rejecting; all non-loopback requests blocked. No fixture profile HTML or injected UI.',phases:[],checks:[],errors:[],pageErrors:[],blockedExternalRequests:[],screenshots:[]};
const server=await startResponsiveServer(),browser=await chromium.launch({headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']}),context=await browser.newContext({viewport:{width:1366,height:768}}),page=await context.newPage();page.setDefaultTimeout(12000);
const phase=name=>{report.phases.push({name,at:new Date().toISOString()});console.log(name);};
const check=(name,pass,detail)=>report.checks.push({name,pass,detail});
const capture=async name=>{const file=path.join(output,name+'.png');await page.screenshot({path:file});report.screenshots.push(file);};
page.on('pageerror',error=>report.pageErrors.push(String(error.stack||error)));
await page.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin===server.url)return route.continue();report.blockedExternalRequests.push({origin:url.origin,method:route.request().method()});return route.abort();});
await context.addInitScript(({accountId,release})=>{
 localStorage.setItem('polytrack-0.6.2-active-account-id',accountId);localStorage.setItem('polytrack-0.6.2-guest-account-id',accountId);
 localStorage.setItem('polytrack-site-update-ack-release-v1:'+release.number,'acknowledged');localStorage.setItem('polytrack-site-update-ack-v1:'+release.revision,'acknowledged');
 window.__auditFirebaseWriteAttempts=0;window.__auditFirebaseWrites=0;
 const seen=new WeakSet(),reject=async()=>{window.__auditFirebaseWriteAttempts++;throw Object.assign(Error('Offline native audit: Firebase writes rejected'),{code:'unavailable'});};
 const wrapQuery=query=>{if(!query||seen.has(query))return query;seen.add(query);for(const key of ['set','update','delete','add','commit'])if(typeof query[key]==='function')query[key]=reject;for(const key of ['doc','collection','where','orderBy','limit','startAfter'])if(typeof query[key]==='function'){const original=query[key].bind(query);query[key]=(...args)=>wrapQuery(original(...args));}return query;};
 const wrapDb=db=>{if(!db||seen.has(db))return db;seen.add(db);db.runTransaction=reject;for(const key of ['collection','doc','batch'])if(typeof db[key]==='function'){const original=db[key].bind(db);db[key]=(...args)=>wrapQuery(original(...args));}return db;};
 let firebase;
 Object.defineProperty(window,'firebase',{configurable:true,get:()=>firebase,set:value=>{
  firebase=value;if(!value)return;
  const factory=value.firestore;if(typeof factory==='function'){const wrapped=(...args)=>wrapDb(factory(...args));Object.assign(wrapped,factory);value.firestore=wrapped;}
  for(const key of ['app','initializeApp'])if(typeof value[key]==='function'){const original=value[key].bind(value);value[key]=(...args)=>{const app=original(...args);if(app&&typeof app.firestore==='function'){const f=app.firestore.bind(app);app.firestore=(...items)=>wrapDb(f(...items));}return app;};}
 }});
},{accountId,release:RELEASE_INFO});
async function inspect(label){
 await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(200);
 const metrics=await page.evaluate(()=>{
  const visible=node=>node&&node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden';const rect=node=>{const r=node.getBoundingClientRect();return {x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height};};
  const dialog=document.querySelector('dialog.profile-hub[open]'),panel=dialog?.querySelector('.ph-panel:not([hidden])'),header=dialog?.querySelector('.ph-header'),tabs=dialog?.querySelector('.ph-tabbar'),preview=dialog?.querySelector('.profile-customizer-preview');
  return {viewport:{width:innerWidth,height:innerHeight},documentOverflow:document.documentElement.scrollWidth>innerWidth+2,dialog:dialog?{...rect(dialog),scrollWidth:dialog.scrollWidth,clientWidth:dialog.clientWidth}:null,panel:panel?{...rect(panel),scrollWidth:panel.scrollWidth,clientWidth:panel.clientWidth,scrollTop:panel.scrollTop}:null,header:header?rect(header):null,tabs:tabs?rect(tabs):null,preview:visible(preview)?{...rect(preview),position:getComputedStyle(preview).position}:null,font:header?getComputedStyle(header.querySelector('h2')).fontFamily:null,fontsReady:document.fonts.status,profileOpen:visible(document.getElementById('overallProfilePopup'))};
 });
 const failures=[];if(metrics.documentOverflow)failures.push('document horizontal overflow');for(const name of ['dialog','panel']){const r=metrics[name];if(!r)failures.push(name+' missing');else{if(r.x< -2||r.right>metrics.viewport.width+2||r.y< -2||r.bottom>metrics.viewport.height+2)failures.push(name+' outside viewport');if(r.scrollWidth>r.clientWidth+2)failures.push(name+' horizontal overflow');}}
 if(metrics.panel&&metrics.tabs&&metrics.panel.y<metrics.tabs.bottom-2)failures.push('content panel overlaps tab/header boundary');if(metrics.preview?.position==='sticky'&&metrics.panel&&metrics.preview.y<metrics.panel.y-2)failures.push('sticky preview overlaps header boundary');if(metrics.preview?.position==='sticky'&&metrics.panel&&metrics.preview.bottom>metrics.panel.bottom+2)failures.push('sticky preview block extends below visible content panel; action reachability needs review');
 check(label,failures.length===0,{metrics,failures});return metrics;
}
try{
 phase('load native game');await page.goto(server.url,{waitUntil:'domcontentloaded',timeout:25000});await page.getByRole('button',{name:'Exit',exact:true}).waitFor({timeout:45000});await page.getByRole('button',{name:'Exit',exact:true}).click();await page.getByRole('button',{name:'Back',exact:true}).click();await page.getByRole('button',{name:'Ranked',exact:true}).waitFor();
 phase('reseed public account after native mock identity startup');await page.evaluate(accountId=>{localStorage.setItem('polytrack-0.6.2-active-account-id',accountId);localStorage.setItem('polytrack-0.6.2-guest-account-id',accountId);window.dispatchEvent(new StorageEvent('storage',{key:'polytrack-0.6.2-active-account-id',newValue:accountId,storageArea:localStorage}));},accountId);
 phase('Ranked');await page.getByRole('button',{name:'Ranked',exact:true}).click();await page.locator('#overallLeaderboardList .overall-entry[data-userid]').first().waitFor({timeout:45000});
 phase('Find Me');await page.locator('#overallFindMeBtn').click();const own=page.locator('#overallLeaderboardList .overall-entry[data-userid="'+accountId+'"]');await own.waitFor({timeout:30000});await own.click();await page.locator('#overallProfilePopup').waitFor({state:'visible'});await page.locator('#overallProfileContent .profile-hero').waitFor({timeout:20000});
 phase('own real profile');await page.locator('[data-ph-launch="achievements"]').waitFor({timeout:20000});check('own studio launcher available',await page.locator('[data-ph-launch="studio"]').isVisible());
 const sizes=process.env.POLYTRACK_AUDIT_SIZES?JSON.parse(process.env.POLYTRACK_AUDIT_SIZES):[[390,844],[844,390],[1366,768]];
 for(const [width,height]of sizes){
  const size=width+'x'+height;try{
   phase('hub '+size);await page.setViewportSize({width,height});await page.locator('[data-ph-launch="achievements"]').click();await page.locator('dialog.profile-hub[open] .aj').waitFor({timeout:15000});await inspect('achievements '+size);await capture('achievements-'+size);
   await page.locator('dialog[open] [data-ph-tab="studio"]').click();await page.locator('dialog[open] .profile-customizer').waitFor({state:'visible'});await inspect('studio '+size);await capture('studio-'+size);
   const panel=page.locator('dialog[open] .ph-studio-panel');await panel.evaluate(node=>{node.scrollTop=250;});await inspect('studio scrolled '+size);await capture('studio-scrolled-'+size);
   let locked=page.locator('dialog[open] [data-cosmetic-locked="true"]:visible').first();if(!await locked.count()){for(const tab of await page.locator('dialog[open] [data-studio-tab]').all()){await tab.click();locked=page.locator('dialog[open] [data-cosmetic-locked="true"]:visible').first();if(await locked.count())break;}}
   if(!await locked.count())throw Error('No actual visible locked cosmetic option for this public account');
   const before=await page.evaluate(()=>{const card=document.querySelector('#overallProfileContent')?.closest('.overall-profile-card');const studio=document.querySelector('dialog[open] .profile-customizer');return {cls:card?.className,style:card?.getAttribute('style'),titles:[...studio.querySelectorAll('[data-cosmetic-title-preview]')].map(n=>n.textContent),badges:[...studio.querySelectorAll('[data-cosmetic-badge-preview]')].map(n=>n.innerHTML)};});
   await locked.click();await page.locator('dialog[open] .cosmetic-preview-banner').waitFor();check('preview publish disabled '+size,await page.evaluate(()=>document.getElementById('overallProfileContent').__cosmeticPreviewController?.isActive()&&!document.getElementById('overallProfileContent').__cosmeticPreviewController.canPublish()&&document.querySelector('dialog[open] [data-save-profile-cosmetics]').disabled));await capture('locked-preview-'+size);
   await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('overallProfileContent').__cosmeticPreviewController?.isActive());
   const restored=await page.evaluate(()=>{const card=document.querySelector('#overallProfileContent')?.closest('.overall-profile-card');const studio=document.querySelector('.profile-customizer');return {cls:card?.className,style:card?.getAttribute('style'),titles:[...studio.querySelectorAll('[data-cosmetic-title-preview]')].map(n=>n.textContent),badges:[...studio.querySelectorAll('[data-cosmetic-badge-preview]')].map(n=>n.innerHTML)};});check('Escape restores real profile '+size,JSON.stringify(before)===JSON.stringify(restored),{before,restored});
   check('Escape leaves hub open '+size,await page.locator('dialog.profile-hub[open]').count()===1);await page.locator('dialog[open] [data-ph-close]').click();await page.waitForFunction(()=>!document.querySelector('dialog.profile-hub[open]'));check('hub close retains outer profile '+size,await page.locator('#overallProfilePopup').isVisible());await capture('profile-after-hub-'+size);
  }catch(error){report.errors.push({phase:size,error:String(error.stack||error)});await capture('failure-'+size).catch(()=>{});break;}
 }
}catch(error){report.blocker={phase:report.phases.at(-1)?.name,error:String(error.stack||error),body:(await page.locator('body').innerText().catch(()=>'' )).slice(0,10000)};await capture('blocked').catch(()=>{});}
finally{
 report.finishedAt=new Date().toISOString();report.firebase=await page.evaluate(()=>({mockWriteAttempts:window.__auditFirebaseWriteAttempts||0,completedWrites:window.__auditFirebaseWrites||0,realFirebaseRequests:0,activeAccount:localStorage.getItem('polytrack-0.6.2-active-account-id'),sdkErrors:window.__ptNativeRankedAudit||null})).catch(()=>null);
 report.status=report.blocker?'blocked':report.errors.length||report.checks.some(c=>!c.pass)?'fail':'pass';if(report.status!=='pass')process.exitCode=1;await fs.writeFile(path.join(output,'native-profile-audit.private.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));await context.close();await browser.close();await server.close();
}
