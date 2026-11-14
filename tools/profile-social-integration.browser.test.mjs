import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {EXTRA_TRACK_IDS} from '../workers/ranked/src/extra-track-ids.js';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const root=new URL('../',import.meta.url),source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8').replace(/\r\n/g,'\n');
function actual(name){const start=source.indexOf('  function '+name+'('),end=source.indexOf('\n  }',start);assert.ok(start>=0&&end>start,'Actual function missing: '+name);return source.slice(start,end+4);}
const extracted=['setupLocalFriends','setupProfileTrackScopes','sortProfileFinishes','sortProfileTrackRows'].map(actual).join('\n');
const ids={self:'1'.padStart(64,'0'),friend:'2'.padStart(64,'0'),other:'9'.padStart(64,'0'),official:'a'.repeat(64),community:'b'.repeat(64),legacy:'c'.repeat(64),custom:'d'.repeat(64),extra:[...EXTRA_TRACK_IDS][0],rolling:'fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778'};
const evidence=process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR||'C:/Users/Static/Documents/Codexstorage/PolyTrack/Projects/Ranked-0.6.3/2026-11-13/late-update/test-logs';
const stamp=Date.now();let browser;
before(async()=>{browser=await chromium.launch({headless:true});});after(async()=>{await browser?.close();});
async function fixture({width=390,height=844,holdImports=false}={}){
 const page=await browser.newPage({viewport:{width,height}}),errors=[],external=[];let release;
 const gate=new Promise(resolve=>release=resolve);if(!holdImports)release();
 page.on('pageerror',e=>errors.push(e.message));
 const assets=new Set(['/tools/local-friends.mjs','/tools/profile-track-breakdown.mjs','/workers/ranked/src/extra-track-ids.js','/tools/local-friends.css','/tools/profile-social-polish.css']);
 await page.route('**/*',async route=>{
 const url=new URL(route.request().url());
 if(url.origin!=='https://social.test'){external.push(url.href);return route.abort();}
 if(assets.has(url.pathname)){
 if(url.pathname.endsWith('.mjs'))await gate;
 return route.fulfill({contentType:url.pathname.endsWith('.css')?'text/css':'text/javascript',body:fs.readFileSync(new URL('.'+url.pathname,root),'utf8')});
 }
 if(url.pathname==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:16px;background:#14274a;color:#fff;font:16px sans-serif}main{max-width:1000px;margin:auto}.profile-track-row{display:block;padding:12px;max-width:100%;box-sizing:border-box}.profile-track-row[hidden]{display:none}header{display:flex;gap:12px;justify-content:space-between}</style><main id="content"></main>'});
 external.push(url.href);return route.abort();
 });
 await page.goto('https://social.test/');
 await page.evaluate(({ids,extracted})=>{
 Object.assign(window,{ids,activeAccount:ids.self,extraCatalogRevision:'fixture',eventsModuleUrl:'https://social.test/events/events.mjs',scoringLoads:0,localRows:[],openedRacers:[],openedTracks:[],knownNames:new Map([[ids.friend,'Friendly Racer']])});
 window.activeRankedAccountId=()=>activeAccount;window.cleanUserId=id=>String(id||'');
 window.readOverallSnapshotCache=()=>({entries:[{userId:ids.friend,name:'Friendly Racer'}]});window.overallEntriesCache=[];
 window.safeDisplayName=name=>name;window.getLastKnownName=id=>knownNames.get(id)||'';
 window.metadata=new Map([[ids.official,{type:'official',name:'Official A'}],[ids.community,{type:'community',name:'Community B'}],[ids.legacy,{type:'custom',name:'Legacy C'}],[ids.custom,{type:'custom',name:'Custom D'}],[ids.extra,{type:'custom',name:'Extra E'}],[ids.rolling,{type:'custom',name:'Rolling Hills'}]]);
 window.TRACK_CATALOG=new Map(metadata);window.LEGACY_TRACK_CATALOG=new Map([[ids.legacy,metadata.get(ids.legacy)]]);window.trackInfo=id=>metadata.get(id)||{type:'custom',name:id};
 window.plannerTrackExpired=()=>false;window.cachedProfileFinishes=()=>localRows;
 window.loadPlannerScoringIndex=()=>{scoringLoads++;return Promise.resolve({profiles:new Map([[activeAccount,[{trackId:ids.official,timeMs:20000}]],[ids.friend,[{trackId:ids.official,timeMs:19000}]]])});};
 window.openRankedProfile=id=>openedRacers.push(id);window.focusTrackFromRanked=(id,options)=>openedTracks.push({id,options});window.formatRaceTime=ms=>ms+'ms';
 window.trackSnapshotStore=()=>{throw Error('Recently loaded boards must not control social grouping');};
 window.content=document.querySelector('#content');window.entry={userId:ids.self,raceCount:6};
 window.renderFixture=(nextEntry=entry)=>{entry=nextEntry;content.__localFriendsCleanup?.();content.__localFriendsCleanup=null;content.__applyProfileTrackScope=null;content.__socialEpoch=(content.__socialEpoch||0)+1;
 content.innerHTML='<div class="profile-identity-extras"></div><section class="profile-track-history"><header><b>Track breakdown</b><span></span></header><button data-profile-sort="time">Time</button><div class="profile-track-list"></div></section>';
 content.__profileFinishes=[ids.official,ids.community,ids.legacy,ids.extra,ids.rolling,ids.custom].map((trackId,index)=>({trackId,timeMs:(index+1)*1000,rank:1,fieldSize:10}));
 for(const row of content.__profileFinishes){const node=document.createElement('button');node.className='profile-track-row';node.dataset.trackId=row.trackId;node.textContent=trackInfo(row.trackId).name;content.querySelector('.profile-track-list').append(node);}
 };
 const script=document.createElement('script');script.textContent='let localFriendsModuleRequest=null,profileBreakdownModuleRequest=null,profileTrackScope="all",profileSort="time",profileSortDirection=1;\n'+extracted;document.head.append(script);
 renderFixture();content.addEventListener('click',event=>{if(event.target.closest('[data-profile-sort]')){profileSortDirection*=-1;sortProfileTrackRows(content);}});
 },{ids,extracted});
 return {page,release,errors,external,async finish(){release();assert.deepEqual(errors,[]);assert.deepEqual(external,[]);await page.close();}};
}

test('actual profile friend hook adds saved racer, mounts self list and loads challenges only on expand',async()=>{
 const f=await fixture(),p=f.page;try{
 await p.evaluate(()=>setupLocalFriends(content,{userId:ids.friend},false));await p.locator('[data-friend-toggle]').click();assert.match(await p.locator('[data-friend-status]').textContent(),/No friend request/);
 await p.evaluate(()=>{renderFixture({userId:ids.self,raceCount:6});setupLocalFriends(content,entry,true);});await p.locator('.local-friends-panel').waitFor();assert.equal(await p.evaluate(()=>scoringLoads),0);
 await p.locator('.local-friends-panel>summary').click();await p.locator('[data-friend-track]').waitFor();assert.equal(await p.evaluate(()=>scoringLoads),1);
 await p.locator('[data-friend-open]').click();await p.locator('[data-friend-track]').click();assert.deepEqual(await p.evaluate(()=>openedRacers),[ids.friend]);assert.deepEqual(await p.evaluate(()=>openedTracks),[{id:ids.official,options:{source:'local-friends'}}]);
 }finally{await f.finish();}
});

test('actual lazy imports cannot mount stale friends or scopes after renderer epoch/account swap',async()=>{
 const f=await fixture({holdImports:true}),p=f.page;try{
 await p.evaluate(()=>{setupLocalFriends(content,entry,true);setupProfileTrackScopes(content,entry);activeAccount=ids.other;renderFixture({userId:ids.other,raceCount:0});content.innerHTML='<strong>New account UI</strong>';});
 f.release();await p.evaluate(()=>Promise.all([localFriendsModuleRequest,profileBreakdownModuleRequest]));assert.equal(await p.locator('#content').innerHTML(),'<strong>New account UI</strong>');
 assert.equal(await p.locator('.profile-local-friends,.profile-track-type-nav').count(),0);
 }finally{await f.finish();}
});

test('actual scopes classify fixed IDs and metadata, preserve coverage and survive actual sorting on phone and desktop',async()=>{
 const f=await fixture(),p=f.page;try{
 await p.evaluate(()=>setupProfileTrackScopes(content,entry));await p.getByRole('navigation',{name:'Track breakdown type'}).waitFor();
 const visible=()=>p.locator('.profile-track-row:not([hidden])').evaluateAll(nodes=>nodes.map(n=>n.dataset.trackId));
 for(const viewport of [{width:390,height:844},{width:1366,height:900}]){
 await p.setViewportSize(viewport);
 for(const [scope,expected]of [['all',[ids.official,ids.community,ids.legacy,ids.extra,ids.rolling,ids.custom]],['official',[ids.official,ids.rolling]],['community',[ids.community,ids.legacy]],['extra',[ids.extra]]]){
 await p.locator('[data-profile-track-scope="'+scope+'"]').click();assert.deepEqual(new Set(await visible()),new Set(expected));
 assert.equal(await p.locator('.profile-track-history header>span').textContent(),'6 tracks');
 await p.locator('[data-profile-sort="time"]').click();assert.deepEqual(new Set(await visible()),new Set(expected));assert.equal(await p.locator('[data-profile-track-scope="'+scope+'"]').getAttribute('aria-pressed'),'true');
 }
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
 fs.mkdirSync(evidence,{recursive:true});await p.screenshot({path:path.join(evidence,'profile-social-scope-'+viewport.width+'-'+stamp+'.png'),fullPage:true});
 }
 await p.evaluate(()=>{renderFixture({userId:ids.self,raceCount:4});setupProfileTrackScopes(content,entry);});await p.getByRole('navigation',{name:'Track breakdown type'}).waitFor();assert.equal(await p.locator('.profile-track-history header>span').textContent(),'6 saved / 4 ranked');
 await p.locator('[data-profile-track-scope="community"]').click();assert.equal(await p.locator('.profile-track-history header>span').textContent(),'6 saved / 4 ranked');
 }finally{await f.finish();}
});

test('actual friend hook rejects late scoring after account replacement and includes current local PB',async()=>{
 const f=await fixture(),p=f.page;try{
 await p.evaluate(async()=>{
 const module=await import('/tools/local-friends.mjs');module.createLocalFriends({accountId:ids.self,storage:localStorage}).add(ids.friend);
 window.loadPlannerScoringIndex=()=>new Promise(resolve=>window.finishScoring=resolve);
 setupLocalFriends(content,entry,true);
 });
 await p.locator('.local-friends-panel>summary').click();await p.waitForFunction(()=>typeof finishScoring==='function');
 await p.evaluate(()=>{activeAccount=ids.other;renderFixture({userId:ids.other,raceCount:0});content.innerHTML='<strong>Replacement account results</strong>';finishScoring({profiles:new Map([[ids.self,[{trackId:ids.official,timeMs:20000}]],[ids.friend,[{trackId:ids.official,timeMs:19000}]]])});});
 await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(resolve)));assert.equal(await p.locator('#content').innerHTML(),'<strong>Replacement account results</strong>');
 await p.evaluate(()=>{
 activeAccount=ids.self;localRows=[{trackId:ids.official,timeMs:18000,local:true}];
 window.loadPlannerScoringIndex=()=>Promise.resolve({profiles:new Map([[ids.self,[{trackId:ids.official,timeMs:20000}]],[ids.friend,[{trackId:ids.official,timeMs:19000}]]])});
 renderFixture({userId:ids.self,raceCount:6});setupLocalFriends(content,entry,true);
 });
 await p.locator('.local-friends-panel>summary').click();await p.waitForFunction(()=>document.querySelector('.local-friend-challenges')?.textContent.includes('lead or tie'));
 assert.equal(await p.locator('[data-friend-track]').count(),0);
 }finally{await f.finish();}
});
