import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createRequire} from 'node:module';
const {chromium}=createRequire(new URL('./verifier/package.json',import.meta.url))('playwright');
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const extract=name=>{const start=source.indexOf('  function '+name+'(');return source.slice(start,source.indexOf('\n  }',start)+4);};
const board={complete:true,totalEntries:2,updatedAt:100,entries:[{accountId:'leader',name:'Snapshot Leader',timeMs:12345},{accountId:'viewer',name:'Viewer',timeMs:14000}]};
const c=vm.createContext({personalFilterRuntime:null,topTrackDetailBoard:()=>board,topTrackDetails:new Map(),
 cleanUserId:x=>x,safeDisplayName:x=>x,escapeHtml:x=>String(x),ageLabel:()=> '1 hour ago',finishWeightParts:()=>null,
 readTrackSnapshotCache:()=>board,activeRankedAccountId:()=> 'viewer',entryTimeMs:r=>r.timeMs,formatRaceTime:n=>(n/1000).toFixed(3),
 pbTimestamp:()=>0,trackInfo:()=>({displayType:'Community'}),rankedWeightTitle:()=> 'Track weight',categoryTrackObservationMarkup:()=>'<span class="overall-move">Saved snapshot</span>',
 trackThumbnailMarkup:()=>'<span class="profile-track-image-frame"><svg viewBox="0 0 100 80"><path d="M10 10H80V60H30V35" fill="none" stroke="white" stroke-width="8"/></svg></span>',OVERALL_PAGE_SIZE:15});
vm.runInContext(extract('renderTrackRankingRow'),c);
const markup=c.renderTrackRankingRow({trackId:'a'.repeat(64),name:'A Long Community Track Name',type:'community',fieldSize:2,weight:4.2,updatedAt:100},0);
const font=fs.readFileSync(new URL('../forced_square.woff2',import.meta.url)).toString('base64');
const css='@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,'+font+')}\n'+[...source.matchAll(/(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*("(?:\\.|[^"\\])*?")/g)].map(m=>JSON.parse(m[1])).join('\n')+'\n'+fs.readFileSync(new URL('../responsive-ui.css',import.meta.url),'utf8');
test('actual Top Tracks row keeps leader, PB and viewer information readable across phone, tablet and desktop',async()=>{
 const browser=await chromium.launch({headless:true});
 try{const page=await browser.newPage();await page.route('**/*',r=>r.abort());
 for(const [width,height] of [[320,740],[430,932],[932,430],[768,1024],[900,900],[1366,768],[1920,1080]]){
  await page.setViewportSize({width,height});
  await page.setContent('<style>body{margin:0;background:#172650;color:white}*{box-sizing:border-box}'+css+'</style><main id="overallLeaderboardPanel" data-category="topTracks" style="display:flex"><div id="overallLeaderboardList" class="overall-list">'+markup+'</div></main>');
  await page.evaluate(()=>document.fonts.ready);
  await page.waitForTimeout(500);
  const metrics=await page.locator('.overall-track-entry').evaluate(row=>{const middle=row.querySelector('.overall-mid'),r=row.getBoundingClientRect(),m=middle.getBoundingClientRect();return {overflow:document.documentElement.scrollWidth-innerWidth,rowOverflow:row.scrollWidth-row.clientWidth,rowWidth:r.width,grid:getComputedStyle(row).gridTemplateColumns,children:[...row.children].map(n=>({class:n.className,width:n.getBoundingClientRect().width,scroll:n.scrollWidth,client:n.clientWidth})),middleWidth:m.width,middleHeight:m.height,viewerVisible:getComputedStyle(middle.querySelector('.overall-best-line:nth-child(2)')).display!=='none',text:middle.textContent};});
  assert.ok(metrics.middleWidth>0&&metrics.middleHeight>0,JSON.stringify({width,metrics}));assert.match(metrics.text,/Snapshot Leader.*12\.345/);assert.match(metrics.text,/YOU #2 of 2.*14\.000/);assert.equal(metrics.viewerVisible,true,JSON.stringify({width,metrics}));
  assert.ok(metrics.overflow<=1&&metrics.rowOverflow<=1,JSON.stringify({width,metrics}));
  if(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR&&[430,932].includes(width))await page.screenshot({path:process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR+'/top-tracks-'+width+'.png'});
 }
 }finally{await browser.close();}
});
