import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import {createRequire} from 'node:module';
import {profilePodiumProgress} from './profile-podium-progress.mjs';
const {chromium}=createRequire(new URL('./verifier/package.json',import.meta.url))('playwright');
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=source.indexOf('content.innerHTML='+String.fromCharCode(96)+'<div class="profile-hero">');
assert.ok(start>0);const at=start+'content.innerHTML='.length;
const end=source.indexOf('$'+'{isSelf?profileCustomizerMarkup(entry)',at);assert.ok(end>at);
const template=source.slice(at,end)+String.fromCharCode(96);
const font=fs.readFileSync(new URL('../forced_square.woff2',import.meta.url)).toString('base64');
const css=[...source.matchAll(/(?:style|rankedPolish)\.textContent\s*(?:\+=|=)\s*("(?:\\.|[^"\\])*?")/g)].map(m=>JSON.parse(m[1])).join('\n')+'\n'+fs.readFileSync(new URL('../responsive-ui.css',import.meta.url),'utf8');
function hero(earned){
 const entry={userId:'fixture',name:'A racer with a long name',raceCount:28},podium=profilePodiumProgress({medals:earned?{gold:1,silver:0,bronze:0}:{gold:0,silver:0,bronze:0}},[{trackId:'s1',rank:4,fieldSize:200}],{isEligible:()=>true,trackName:()=> 'Summer 1'});
 return vm.runInNewContext(template,{entry,podium,carStyle:{},isSelf:true,escapeHtml:x=>String(x),safeDisplayName:x=>x,countryFlagMarkup:()=>'',carModelPreview:()=>'<div class="overall-car-model" style="aspect-ratio:1.6;background:#17264c">Car preview</div>',achievements:earned?'<span class="profile-medal-card gold">1 Gold</span>':'<span class="profile-podium-target">'+podium.detail+'</span>',profileIdentityExtras:'Beta Racer',primaryStats:'<span><b>#5</b>Overall RP rank</span><span><b>4,458</b>Overall RP</span><span><b>7.21</b>Average place</span><span><b>28 / 69</b>Ranked tracks</span><span><b>3,453</b>Skill RP</span><span><b>Apex I</b>Rank title</span>',secondaryStats:'More results'});
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
 if(!earned){assert.equal(await page.locator('.profile-podium-target').innerText(),'Summer 1 · #4 to top 3');assert.equal(await page.getByText('No eligible podiums yet').count(),0);}
 if(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR&&[430,1920].includes(width))await page.screenshot({path:path.join(process.env.POLYTRACK_AUDIT_SCREENSHOT_DIR,'profile-podium-'+width+'-'+earned+'.png'),fullPage:true});
 }
 }finally{await browser.close();}
});
