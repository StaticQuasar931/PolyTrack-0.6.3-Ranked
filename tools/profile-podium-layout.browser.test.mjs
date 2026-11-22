import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {profilePodiumProgress} from './profile-podium-progress.mjs';
import {compactProfileAchievementMarkup} from './profile-compact-presentation.mjs';
const {chromium}=createRequire(new URL('./verifier/package.json',import.meta.url))(process.env.PLAYWRIGHT_MODULE||'playwright');
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=source.indexOf('content.innerHTML='+String.fromCharCode(96)+'<div class="profile-hero">');
assert.ok(start>0);const at=start+'content.innerHTML='.length;
const end=source.indexOf('$'+'{isSelf?profileCustomizerMarkup(entry)',at);assert.ok(end>at);
const template=source.slice(at,end)+String.fromCharCode(96);
const font=fs.readFileSync(new URL('../forced_square.woff2',import.meta.url)).toString('base64');
const css=[...source.matchAll(/(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*("(?:\\.|[^"\\])*?")/g)].map(m=>JSON.parse(m[1])).join('\n')+'\n'+fs.readFileSync(new URL('../responsive-ui.css',import.meta.url),'utf8');
const socialCss=fs.readFileSync(new URL('./profile-social-polish.css',import.meta.url),'utf8');
function hero(earned){
 const entry={userId:'fixture',name:'A racer with a long name',raceCount:28},podium=profilePodiumProgress({medals:earned?{gold:1,silver:0,bronze:0}:{gold:0,silver:0,bronze:0}},[{trackId:'s1',rank:4,fieldSize:200}],{isEligible:()=>true,trackName:()=> 'Summer 1'});
 return vm.runInNewContext(template,{entry,podium,carStyle:{},isSelf:true,escapeHtml:x=>String(x),safeDisplayName:x=>x,countryFlagMarkup:()=>'',carModelPreview:()=>'<div class="overall-car-model" style="aspect-ratio:1.6;background:#17264c">Car preview</div>',achievements:earned?compactProfileAchievementMarkup({gold:17,silver:0,bronze:7},{showEmpty:true,medalIcon:kind=>'data:image/svg+xml,'+encodeURIComponent(fs.readFileSync(new URL('../images/'+({gold:'ranked-trophy.svg',silver:'ranked-award.svg',bronze:'ranked-star.svg'}[kind]),import.meta.url),'utf8'))}):'<button type="button" class="profile-podium-target"><span class="profile-track-image-frame"><svg viewBox="0 0 42 42"><path d="M5 8h18v10h14v15H9v-8h14" fill="none" stroke="white" stroke-width="7"/></svg></span><span class="profile-podium-copy"><strong>Summer 1</strong><small>#4 to top 3</small></span></button>',profileIdentityExtras:'Beta Racer',primaryStats:'<span><b>#5</b>Overall RP rank</span><span><b>4,458</b>Overall RP</span><span><b>7.21</b>Average place</span><span><b>28 / 69</b>Ranked tracks</span><span><b>3,453</b>Skill RP</span><span><b>Apex I</b>Rank title</span>',secondaryStats:'More results'});
}
test('actual profile hero keeps podium progress below the car across phone, tablet and 125% desktop UI',async()=>{
 const browser=await chromium.launch({headless:true});
 try{const page=await browser.newPage();await page.route('**/*',r=>r.abort());
 for(const earned of [false,true])for(const [width,height]of [[320,740],[430,932],[932,430],[768,1024],[900,900],[1366,768],[1920,1080]]){
 await page.setViewportSize({width,height});
 await page.setContent('<style>@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,'+font+')}body{margin:0;background:#10182f;color:white;font-family:ForcedSquare,sans-serif}'+css+'</style><div id="overallProfilePopup" style="display:flex"><article class="overall-profile-card" style="--sq-ui-scale:1.25;background-image:linear-gradient(120deg,#8a2639,#ac5629)"><header class="profile-dialog-toolbar">Racer profile <button>Close</button></header>'+hero(earned)+'</article></div>');
 await page.evaluate(()=>document.fonts.ready);
 const box=await page.locator('.profile-hero').evaluate(hero=>{const bar=hero.querySelector('.profile-podium-wide').getBoundingClientRect(),b=hero.getBoundingClientRect(),identity=hero.querySelector('.profile-identity').getBoundingClientRect(),card=hero.closest('article');const car=hero.querySelector('.overall-car-model').getBoundingClientRect();return{left:bar.left-car.left,right:car.right-bar.right,below:bar.top>=car.bottom,identityRight:b.right-identity.right,overflow:card.scrollWidth-card.clientWidth,background:getComputedStyle(card).backgroundAttachment,wide:[...card.querySelectorAll('*')].map(e=>({tag:e.className,width:e.getBoundingClientRect().width,scroll:e.scrollWidth,client:e.clientWidth,white:getComputedStyle(e).whiteSpace})).filter(e=>e.scroll>e.client+2).slice(0,7)};});
 assert.ok(box.overflow<=2,'no overflow '+width+': '+JSON.stringify(box));assert.ok(Math.abs(box.left)<=2&&Math.abs(box.right)<=2,'podium matches car width '+width+': '+JSON.stringify(box));assert.equal(box.below,true,'podium below car');assert.ok(Math.abs(box.identityRight)<=2,'identity flush right '+width);assert.equal(box.background,'local');
 if(!earned){assert.match(await page.locator('.profile-podium-target').innerText(),/Summer 1[\s\S]*#4 to top 3/);assert.equal(await page.getByText('No eligible podiums yet').count(),0);}
 if(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR&&[430,1920].includes(width))await page.screenshot({path:path.join(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR,'profile-podium-'+width+'-'+earned+'.png'),fullPage:true});
 }
 }finally{await browser.close();}
});

function section(start,end){
 const from=source.indexOf(start),to=source.indexOf(end,from);
 assert.ok(from>=0&&to>from,start);
 return source.slice(from,to);
}

test('podium drill-down keeps controls in view and releases the native modal on every exit',async()=>{
 const browser=await chromium.launch({headless:true});
 try{
  const page=await browser.newPage();
  await page.route('**/*',route=>route.abort());
  await page.setContent('<style>'+css+'\n'+socialCss+'</style>'+
   '<button id="racer">Racer</button><div id="overallLeaderboardPanel" style="display:block">'+
   '<div id="overallProfilePopup" style="display:flex"><article class="overall-profile-card">'+
   '<button id="overallProfileClose">Close profile</button><div id="overallProfileContent">'+hero(true)+
   '<section class="profile-track-history"><header><span></span></header><div class="profile-track-list"></div></section>'+
   '</div></article></div></div>');
  await page.addScriptTag({content:`
   const panel=document.querySelector('#overallLeaderboardPanel'),popup=document.querySelector('#overallProfilePopup'),
     content=document.querySelector('#overallProfileContent');
   const rows=Array.from({length:17},(_,i)=>({trackId:'track'+i,rank:1,fieldSize:i+90,timeMs:1234,runVerified:true,integrityVerified:true}));
   content.__profileFinishes=[...rows,{...rows[0],trackId:'local',local:true},{...rows[0],trackId:'pending',localPending:true},
     {...rows[0],trackId:'not verified',runVerified:false},{...rows[0],trackId:'no integrity',integrityVerified:false},
     {...rows[0],trackId:'review',needsReview:true},{...rows[0],trackId:'hold',reviewHold:true},
     {...rows[0],trackId:'small field',fieldSize:4},{...rows[0],trackId:'wrong medal',rank:2}];
   const TRACK_CATALOG=new Map(content.__profileFinishes.map(row=>[row.trackId,{}])),LEGACY_TRACK_CATALOG=new Map();
   content.__profileFinishes.push({...rows[0],trackId:'unrecognized'});
   const trackInfo=id=>({name:id==='track16'?'AReallyLongUnbrokenTrackLabel'.repeat(8):id,type:'official'});
   const formatRaceTime=()=> '0:01.234';
   const focusTrackFromRanked=id=>{
     window.trackNavigation=[id,!!document.querySelector('dialog:modal')];
     closeOverallPanel(panel);
   };
   const cleanupCommunityBadgeViews=()=>{},cancelPublishedSnapshotUpdate=()=>{};
   const eventsModuleUrl=location.href,profileTrackScope='all';
   let profileBreakdownModuleRequest=Promise.resolve({trackCoverageSummary:()=>'',profileTrackGroup:()=> 'official'});
   const socialLink=document.createElement('link');socialLink.dataset.profileSocialCss='';document.head.append(socialLink);
   const cleanUserId=id=>id,activeRankedAccountId=()=> 'self',overallCategory='events',overallEntriesCache=[];
   const profileSnapshotResults=new Map(),localPlannerProfileEntry=()=>null,practiceObserver=null;
   const loadProfileSnapshotResults=async()=>false,warmProfileLocalPlacements=async()=>false;
   const compactProfilePresentationLoad=true,rankedFilterSnapshotMeta={};
   const applyPersonalFilters=()=>({active:false}),isElementVisible=node=>!!node?.getClientRects().length;

   ${section('  const MIN_PODIUM_FIELD_SIZE=','  function medalIcon(')}
   ${section('  let activeProfilePodium=','  // W-only gate')}
   ${section('  let overallDialogReturnFocus=','  function trapRankedDialogFocus(')}
   ${section('  let rankedFreshnessTimer =','  let lastRankedManualRefreshAt')}
   ${section('  function deferProfileHubRefresh(','  function renderEntries(')}

   setupProfileTrackScopes(content,{raceCount:17});
   window.capturedEscapes=[];window.bubbledKeys=[];window.racerClicks=0;window.panelClicks=0;
   for(const type of ['keydown','keyup']){
     window.addEventListener(type,event=>{if(event.key==='Escape')capturedEscapes.push(type);},true);
     window.addEventListener(type,event=>bubbledKeys.push(event.key));
   }
   panel.addEventListener('click',()=>window.panelClicks++);
   document.querySelector('#overallProfileClose').onclick=()=>closeRankedDialog(popup);
   document.querySelector('#racer').onclick=()=>window.racerClicks++;
  `});
  const gold=page.locator('.profile-medal-card.gold[role=button]');
  const dialog=page.locator('dialog.profile-podium-details');
  const close=dialog.getByRole('button',{name:'Close',exact:true});
  const profile=page.locator('#overallProfilePopup');
  const panel=page.locator('#overallLeaderboardPanel');
  const assertClosed=async()=>{
   assert.equal(await dialog.count(),0);
   assert.equal(await page.locator('dialog:modal').count(),0);
  };
  const assertOnMedal=()=>gold.evaluate(node=>node===document.activeElement).then(active=>assert.equal(active,true));

  for(const [width,height] of [[320,740],[568,320],[1366,768]]){
   await page.setViewportSize({width,height});
   await gold.click();
   assert.equal(await close.evaluate(node=>node===document.activeElement),true);
   assert.equal(await dialog.locator('li').count(),17);
   assert.match(await dialog.locator('p').textContent(),/Showing 17 of 17/);
   assert.match(await dialog.locator('li').first().textContent(),/#1 of 106\s*\|\s*0:01\.234/);
   assert.equal(await dialog.locator('li[data-large-field]').count(),7);
   const layout=await dialog.evaluate(node=>{
    const list=node.querySelector('ul'),header=node.querySelector('header'),rect=node.getBoundingClientRect();
    const headerTop=header.getBoundingClientRect().top;
    list.scrollTop=list.scrollHeight;
    return {fits:rect.left>=0&&rect.right<=innerWidth&&rect.top>=0&&rect.bottom<=innerHeight,
     noHorizontalOverflow:list.scrollWidth<=list.clientWidth+1,scrolled:list.scrollTop>0,
     headerFixed:header.getBoundingClientRect().top===headerTop};
   });
   assert.deepEqual(layout,{fits:true,noHorizontalOverflow:true,scrolled:true,headerFixed:true},`${width}x${height}`);
   await close.click();
   await assertClosed();
   await assertOnMedal();
  }

  await gold.press('Enter');
  await dialog.waitFor();
  await page.evaluate(()=>{bubbledKeys.length=0;});
  await page.keyboard.press('Tab');
  assert.equal(await dialog.locator('li button').first().evaluate(node=>node===document.activeElement),true);
  await page.keyboard.down('Escape');
  await page.keyboard.down('Escape');
  await page.keyboard.up('Escape');
  await assertClosed();
  await assertOnMedal();
  assert.equal(await profile.isVisible(),true);
  assert.equal(await panel.isVisible(),true);
  assert.deepEqual(await page.evaluate(()=>[capturedEscapes,bubbledKeys]),[[],[]]);
  await page.keyboard.press('Escape');
  assert.deepEqual(await page.evaluate(()=>capturedEscapes),['keydown','keyup']);

  await gold.click({button:'right'});
  await dialog.waitFor();
  const panelClicksBefore=await page.evaluate(()=>panelClicks);
  await dialog.getByRole('heading').click();
  assert.equal(await dialog.isVisible(),true);
  await page.mouse.click(2,2);
  await assertClosed();
  await assertOnMedal();
  assert.equal(await page.evaluate(()=>panelClicks),panelClicksBefore);
  assert.equal(await profile.isVisible(),true);

  await gold.press('Space');
  await dialog.waitFor();
  await dialog.evaluate(node=>node.requestClose());
  await assertClosed();
  await assertOnMedal();

  await gold.click();
  await page.evaluate(()=>closeRankedDialog(popup));
  await assertClosed();
  assert.equal(await profile.isVisible(),false);
  await page.evaluate(()=>openRankedDialog(popup));
  await gold.click();
  await page.evaluate(()=>closeOverallPanel(panel));
  await assertClosed();
  await page.locator('#racer').click();
  assert.equal(await page.evaluate(()=>racerClicks),1);

  await panel.evaluate(node=>{node.style.display='block';});
  await gold.click();
  await dialog.locator('li button').first().press('Enter');
  await assertClosed();
  assert.deepEqual(await page.evaluate(()=>trackNavigation),['track16',false]);
  assert.equal(await panel.isVisible(),false);
  await page.locator('#racer').click();
  assert.equal(await page.evaluate(()=>racerClicks),2);

  await panel.evaluate(node=>{node.style.display='block';});
  await gold.click();
  await page.evaluate(()=>openRankedProfile('another-racer'));
  await assertClosed();
  assert.equal(await profile.getByText('Ranked profile unavailable').isVisible(),true);
  await page.locator('#overallProfileClose').click();
  assert.equal(await profile.isVisible(),false);
 }finally{await browser.close();}
});
