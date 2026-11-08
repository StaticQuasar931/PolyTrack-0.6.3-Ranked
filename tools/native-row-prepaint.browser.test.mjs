import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function extract(name){const start=source.indexOf('  function '+name+'('),end=source.indexOf('\n  }',start);assert(start>=0&&end>start,name);return source.slice(start,end+4);}

test('native flags, latest names and waiting status are correct on the first frame',async()=>{
  const browser=await chromium.launch({headless:true});
  try{
    const page=await browser.newPage();
    await page.route('**/*',route=>route.abort());
    await page.setContent('<section class="leaderboard-ui"><div class="container"></div></section><section class="leaderboard-ui sq-event-board"><div class="container"></div></section>');
    const names=['rowIdentityFreshness','snapshotRacerDirectoryIdentity','rankedIdentityRows','rankedIdentityForRacer','canonicalDisplayName','decorateNativeLeaderboardIdentity','decorateNativeLeaderboardCosmetics','syncIntegrityStateLabels','prepaintNativeLeaderboardRows'];
    const firstFrame=await page.evaluate(async functions=>{
      const row={accountId:'r',userId:'r',name:'Old',timeMs:10000,identityUpdatedAt:100,countryCode:'US'};
      Object.assign(window,{currentTrackLoadState:{trackId:'track'},overallEntriesCache:[row],
        snapshotRacerDirectoryEntries:{r:{name:'Current',nickname:'Current',countryCode:'JP',updatedAt:300}},
        rankedIdentityIndex:null,rankedIdentityIndexSource:null,nativeDecorationLookupCache:null,trackCacheGeneration:0,overallCacheGeneration:0,localRaceGeneration:0,cosmeticEpoch:0,
        isElementVisible:()=>true,ensureNativeAllRunsDefault(){},activeRankedAccountId:()=> 'r',readTrackSnapshotCache:()=>({entries:[row]}),
        localTrackDisplayEntries:(_id,rows)=>rows,canonicalRaceTimeMs:row=>row.timeMs,formatRaceTime:()=> '00:10.000',readOverallSnapshotCache:()=>null,
        readCosmeticDirectory:()=>({entries:{}}),cleanUserId:x=>x||'',safeDisplayName:x=>x,getLastKnownName:()=>'',setLastKnownName(){},
        runStatus:()=> 'submitted',pbTimestamp:()=>0,syncNativeSelfHighlight(){},racerCosmeticClasses:()=>'',__pt062NormalizeStyle:x=>x,hydrateOverallCarModels(){},
        countryFlagMarkup:country=>country?'<img class="country-flag" alt="'+country+'">':'',prepaintPasses:0,
        withoutUiFeedback:fn=>{window.paintObserver.disconnect();try{window.prepaintPasses++;fn();}finally{window.paintObserver.observe(document.body,{childList:true,subtree:true});}}});
      (0,eval)(functions);
      window.paintObserver=new MutationObserver(records=>prepaintNativeLeaderboardRows(records));
      window.paintObserver.observe(document.body,{childList:true,subtree:true});
      document.querySelector('.leaderboard-ui:not(.sq-event-board) .container').innerHTML='<button class="main"><div class="image-container"></div><div class="left"><p class="position">1</p><p>00:10.000</p></div><div class="name-container"><img class="country-flag" alt="US"><span class="name">Old</span></div><div class="verified-state">1 day ago<img></div></button>';
      return new Promise(resolve=>requestAnimationFrame(()=>{
        const button=document.querySelector('button.main');
        resolve({name:button.querySelector('.name').textContent,oldFlags:button.querySelectorAll('.name-container > .country-flag').length,
          flag:button.querySelector('.name .sq-track-identity img')?.alt,status:button.querySelector('.sq-integrity-label')?.textContent,
          verified:button.querySelector('.verified-state').classList.contains('verified'),passes:window.prepaintPasses});
      }));
    },names.map(extract).join('\n'));
    assert.deepEqual(firstFrame,{name:'Current',oldFlags:0,flag:'JP',status:'WAITING',verified:false,passes:1});
    const event=await page.evaluate(async()=>{
      document.querySelector('.sq-event-board .container').innerHTML='<button class="main"><div class="verified-state">Local event</div></button>';
      await new Promise(resolve=>requestAnimationFrame(resolve));
      syncIntegrityStateLabels();
      return {text:document.querySelector('.sq-event-board .verified-state').textContent,passes:window.prepaintPasses};
    });
    assert.deepEqual(event,{text:'Local event',passes:1});
    await page.evaluate(()=>window.paintObserver.disconnect());
  }finally{await browser.close();}
});

test('mutation callback applies native presentation before the general throttle',()=>{
  const start=source.indexOf('const observer = new MutationObserver((records) => {',source.indexOf('const RECONCILE_MIN_GAP_MS'));
  const callback=source.slice(start,source.indexOf('function boot()',start));
  assert(callback.indexOf('prepaintNativeLeaderboardRows(records)')>=0);
  assert(callback.indexOf('prepaintNativeLeaderboardRows(records)')<callback.indexOf('setTimeout('));
});
