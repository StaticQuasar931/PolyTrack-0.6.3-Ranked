import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
const {chromium}=createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE||'C:/Users/Static/Documents/GitHub/PolyTrack 0.6.3 Ranked/tools/verifier/node_modules/playwright');
const root=fileURLToPath(new URL('../',import.meta.url)),A='a'.repeat(64),B='b'.repeat(64);
const evidence=process.env.COMMUNITY_BADGE_EVIDENCE_DIR;let server,browser,base;
before(async()=>{
  server=http.createServer(async(req,res)=>{
    const name=new URL(req.url,'http://local').pathname;
    if(name==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>@font-face{font-family:ForcedSquare;src:url(/forced_square.woff2)}body{margin:0;padding:12px;background:#1c315b;color:white;font:14px ForcedSquare,sans-serif}aside{margin-bottom:12px}#root{max-width:700px}</style><aside>Offline community claim fixture. No live account or rewards.</aside><div id="root"></div>');return;}
    if(!['/community-badge.mjs','/forced_square.woff2'].includes(name)){res.writeHead(404).end();return;}
    res.setHeader('content-type',name.endsWith('.mjs')?'text/javascript':'font/woff2');res.end(await fs.readFile(path.join(root,name==='/community-badge.mjs'?'tools/community-badge.mjs':'forced_square.woff2')));
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;browser=await chromium.launch({headless:true,args:['--disable-features=CalculateNativeWinOcclusion','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding','--disable-gpu']});if(evidence)await fs.mkdir(evidence,{recursive:true});
});
after(async()=>{await browser?.close();server?.closeAllConnections();if(server)await new Promise(resolve=>server.close(resolve));});
async function fixture(t,{width=390,height=844,hint=false,savedCode='',savedThrows=false,omitSavedGetter=false}={}){
  const context=await browser.newContext({viewport:{width,height}});t.after(()=>context.close());const page=await context.newPage();page.setDefaultTimeout(3000);let external=0;
  await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():(external++,route.abort()));await page.goto(base);await page.bringToFront();
  await page.evaluate(async({A,hint,savedCode,savedThrows,omitSavedGetter})=>{
    const {mountCommunityBadge}=await import('/community-badge.mjs');window.account=A;window.scope='scope-0';window.hint=hint;window.tokens=0;window.requests=[];window.claimed=[];window.used=[];window.holdToken=false;window.holdFetch=false;window.savedReads=0;window.useContexts=[];
    window.unhandled=[];window.addEventListener('unhandledrejection',event=>unhandled.push(String(event.reason)));
    window.user={uid:'owner-a',getIdToken:async()=>{tokens++;if(holdToken)await new Promise((resolve,reject)=>{window.releaseToken=resolve;window.rejectToken=reject;});return 'ephemeral-offline-token';}};
    window.auth={currentUser:user,listeners:new Set(),onAuthStateChanged(callback){this.listeners.add(callback);callback(this.currentUser);return()=>this.listeners.delete(callback);},emit(value){this.currentUser=value;for(const callback of [...this.listeners])callback(value);}};
    Storage.prototype.setItem=()=>{throw Error('No persistence allowed');};window.fetch=()=>{throw Error('No real fetch allowed');};
    window.dispose=mountCommunityBadge({document,root:document.querySelector('#root'),accountId:A,getAccountId:()=>account,getAuth:()=>auth,getAuthScope:()=>scope,revision:323,hasClaim:()=>window.hint,...(omitSavedGetter?{}:{getSavedCode:()=>{savedReads++;if(savedThrows)throw Error('offline getter unavailable');return savedCode;}}),
      fetch:async(url,options)=>{requests.push({url,options});if(holdFetch)await new Promise((resolve,reject)=>{window.releaseFetch=resolve;window.rejectFetch=reject;});return Response.json(window.result||{version:1,accepted:true,accountId:A,badgeId:'community',source:'relay-code',membershipVerified:false,alreadyClaimed:false},{status:window.responseStatus||200});},
      onClaimed:value=>{if(!Object.isFrozen(value))throw Error('Mutable claim');claimed.push(value);},onUse:value=>{useContexts.push(value);used.push({accountId:value.accountId,badgeId:value.badgeId,draftOnly:value.draftOnly,current:value.isCurrent()});}});
  },{A,hint,savedCode,savedThrows,omitSavedGetter});page.noExternal=()=>assert.equal(external,0);return page;
}
async function claim(page){await page.locator('input').fill('ABCDEFGHIJKLMNOP');await pointer(page,'[data-community-claim]');}
// Windows headless can starve rAF stability checks. Keep real input plus hit tests.
async function pointer(page,selector){
  const target=page.locator(selector);assert.equal(await target.isVisible(),true);assert.equal(await target.isEnabled(),true);
  await target.evaluate(node=>node.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}));
  const box=await target.boundingBox();assert.ok(box&&box.width>0&&box.height>0);
  const point={x:box.x+box.width/2,y:box.y+box.height/2};
  assert.equal(await target.evaluate((node,point)=>node.contains(document.elementFromPoint(point.x,point.y)),point),true);
  await page.mouse.click(point.x,point.y);
}
function until(page,predicate,arg){return page.waitForFunction(predicate,arg,{polling:25,timeout:3000});}
test('mount and claimed hint perform no token/network/storage calls; Use is separate draft-only callback',async t=>{
  const page=await fixture(t,{hint:true});assert.equal(await page.evaluate(()=>tokens+requests.length+claimed.length+used.length),0);
  assert.equal(await page.locator('[data-community-claim]').isDisabled(),true);await pointer(page,'[data-community-use]');assert.deepEqual(await page.evaluate(()=>used),[{accountId:A,badgeId:'community',draftOnly:true,current:true}]);assert.equal(await page.evaluate(()=>tokens+requests.length+claimed.length),0);page.noExternal();
});
test('explicit Claim uses exact pinned request and schema; never auto Uses/publishes or verifies membership',async t=>{
  const page=await fixture(t);assert.equal(await page.evaluate(()=>tokens+requests.length),0);await claim(page);await until(page,()=>claimed.length===1);
  const request=await page.evaluate(()=>{const row=requests[0];return {url:row.url,method:row.options.method,headers:row.options.headers,body:JSON.parse(row.options.body),credentials:row.options.credentials,redirect:row.options.redirect,cache:row.options.cache,referrerPolicy:row.options.referrerPolicy};});
  assert.equal(request.url,'https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/profile/community-badge');assert.equal(request.method,'POST');assert.deepEqual(request.body,{accountId:A,communityCode:'ABCDEFGHIJKLMNOP'});assert.equal(request.headers.Authorization,'Bearer ephemeral-offline-token');assert.equal(request.headers['X-PolyTrack-Revision'],'323');assert.equal(request.credentials,'omit');assert.equal(request.redirect,'error');assert.equal(request.cache,'no-store');assert.equal(request.referrerPolicy,'no-referrer');assert.deepEqual(Object.keys(request.headers).sort(),['Accept','Authorization','Content-Type','X-PolyTrack-Revision'].sort());assert.equal(request.headers.Accept,'application/json');assert.equal(request.headers['Content-Type'],'application/json');
  assert.equal(await page.evaluate(()=>used.length),0);assert.equal(await page.locator('[data-community-claim]').isDisabled(),true);assert.match(await page.locator('.community-badge').innerText(),/Membership is not checked/);assert.equal(new URL(await page.locator('a').getAttribute('href')).hostname,'discord.gg');
  await pointer(page,'[data-community-use]');assert.equal(await page.evaluate(()=>used[0].current),true);assert.equal(await page.evaluate(()=>requests.length),1);page.noExternal();
});
test('invalid input and pending double submit make no extra requests',async t=>{
  const page=await fixture(t);await page.locator('input').fill('https://evil.test/code');await pointer(page,'[data-community-claim]');assert.equal(await page.evaluate(()=>tokens+requests.length),0);assert.equal(await page.locator('input').getAttribute('aria-invalid'),'true');
  await page.evaluate(()=>holdFetch=true);await claim(page);await until(page,()=>requests.length===1);await page.locator('form').dispatchEvent('submit');assert.equal(await page.evaluate(()=>requests.length),1);assert.equal(await page.locator('[data-community-use]').isDisabled(),true);await page.evaluate(()=>releaseFetch());await until(page,()=>claimed.length===1);page.noExternal();
});
test('wrong-account, extra-field, malformed, membership and HTTP failures cannot invoke claim/use callbacks',async t=>{
  for(const change of [{accountId:B},{membershipVerified:true},{balance:8},{alreadyClaimed:'yes'},{badgeId:'betaTester'},{source:'invite-code'}]){
    const page=await fixture(t);await page.evaluate(({A,change})=>window.result={version:1,accepted:true,accountId:A,badgeId:'community',source:'relay-code',membershipVerified:false,alreadyClaimed:false,...change},{A,change});await claim(page);await until(page,()=>!document.querySelector('.community-badge').matches('[aria-busy="true"]'));assert.equal(await page.evaluate(()=>claimed.length+used.length),0);assert.equal(await page.locator('[data-community-use]').isDisabled(),true);page.noExternal();
  }
  const page=await fixture(t);await page.evaluate(()=>responseStatus=503);await claim(page);await until(page,()=>document.querySelector('[role=status]').textContent.includes('could not'));assert.equal(await page.evaluate(()=>claimed.length),0);page.noExternal();
});
test('dispose aborts pending work and late token/response cannot fetch or invoke callbacks',async t=>{
  for(const phase of ['token','response']){
    const page=await fixture(t);await page.evaluate(phase=>{holdToken=phase==='token';holdFetch=phase==='response';},phase);await claim(page);await until(page,phase=>typeof window[phase==='token'?'releaseToken':'releaseFetch']==='function',phase);
    const aborted=await page.evaluate(phase=>{dispose();const aborted=requests[0]?.options.signal.aborted??true;window[phase==='token'?'releaseToken':'releaseFetch']();return aborted;},phase);assert.equal(aborted,true);await page.waitForTimeout(20);assert.equal(await page.evaluate(()=>claimed.length+used.length),0);assert.equal(await page.evaluate(()=>requests.length),phase==='token'?0:1);assert.equal(await page.locator('.community-badge').count(),0);page.noExternal();
  }
});
test('account/scope and auth A-B-A reject late callbacks without retries',async t=>{
  for(const kind of ['scope','auth','detached']){
    const page=await fixture(t);await page.evaluate(()=>holdFetch=true);await claim(page);await until(page,()=>typeof releaseFetch==='function');
    await page.evaluate(({kind,A,B})=>{if(kind==='scope'){account=B;scope='scope-1';account=A;scope='scope-2';}else if(kind==='auth'){auth.emit(null);auth.emit(user);}else document.querySelector('#root').remove();releaseFetch();},{kind,A,B});await page.waitForTimeout(20);assert.equal(await page.evaluate(()=>claimed.length+used.length),0);assert.equal(await page.evaluate(()=>requests.length),1);page.noExternal();
  }
});
test('desktop, phone and landscape are keyboard accessible and fit without overflow',async t=>{
  for(const [width,height]of [[1366,768],[360,800],[844,390]]){
    const page=await fixture(t,{width,height});await page.locator('input').fill('ABCDEFGHIJKLMNOP');await page.locator('input').press('Enter');await until(page,()=>claimed.length===1);await page.locator('[data-community-use]').focus();await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>used.length),1);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.ok(await page.locator('[data-community-use]').evaluate(node=>node.getBoundingClientRect().height>=44));await page.evaluate(()=>document.fonts.ready);if(evidence)await page.screenshot({path:path.join(evidence,`community-${width}x${height}.png`),timeout:2000}).catch(()=>t.diagnostic('Screenshot unavailable: Windows headless compositor delivered no frame.'));page.noExternal();
  }
});

test('late token and fetch rejection after abort create no unhandled rejection or callback',async t=>{
 for(const phase of ['token','response']){
  const page=await fixture(t),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.evaluate(phase=>{holdToken=phase==='token';holdFetch=phase==='response';},phase);await claim(page);await until(page,phase=>typeof window[phase==='token'?'rejectToken':'rejectFetch']==='function',phase);
  await page.evaluate(phase=>{dispose();window[phase==='token'?'rejectToken':'rejectFetch'](Error('offline delayed rejection'));},phase);await page.waitForTimeout(50);
  assert.deepEqual(await page.evaluate(()=>unhandled),[]);assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>claimed.length+used.length),0);assert.equal(await page.evaluate(()=>requests.length),phase==='token'?0:1);page.noExternal();
 }
});

test('saved relay prefill is masked, never appears as text/markup, and requires explicit Claim',async t=>{
 const page=await fixture(t,{savedCode:'ABCDEFGHIJKLMNOP'});
 assert.equal(await page.locator('input').inputValue(),'ABCDEFGHIJKLMNOP');assert.equal(await page.locator('input').getAttribute('type'),'password');
 assert.equal(await page.locator('input').getAttribute('autocomplete'),'off');assert.equal(await page.locator('input').getAttribute('maxlength'),'16');
 assert.equal(await page.evaluate(()=>savedReads),1);assert.equal(await page.evaluate(()=>tokens+requests.length+claimed.length+used.length),0);
 assert.doesNotMatch(await page.locator('.community-badge').innerText(),/ABCDEFGHIJKLMNOP/);assert.doesNotMatch(await page.locator('.community-badge').innerHTML(),/ABCDEFGHIJKLMNOP/);
 await pointer(page,'[data-community-claim]');await until(page,()=>claimed.length===1);
 assert.deepEqual(await page.evaluate(()=>JSON.parse(requests[0].options.body)),{accountId:A,communityCode:'ABCDEFGHIJKLMNOP'});page.noExternal();
});

test('optional, unavailable, or invalid saved-code getters never claim or initialize token/network',async t=>{
 for(const options of [{omitSavedGetter:true},{savedThrows:true},{savedCode:'https://discord.gg/fixtureInvite'},{savedCode:'abcdefghijklmnop'}]){
  const page=await fixture(t,options);assert.equal(await page.locator('input').inputValue(),'');assert.equal(await page.evaluate(()=>tokens+requests.length+claimed.length+used.length),0);page.noExternal();
 }
});

test('Discord invite URLs and legacy invite slugs cannot trigger token acquisition or a claim',async t=>{
 const page=await fixture(t);
 for(const value of ['https://discord.gg/fixtureInvite','https://discord.com/invite/fixtureInvite','fixtureInvite']){
  await page.locator('input').fill(value);await page.locator('form').dispatchEvent('submit');assert.equal(await page.locator('input').getAttribute('aria-invalid'),'true');
 }
 assert.equal(await page.evaluate(()=>tokens+requests.length+claimed.length+used.length),0);page.noExternal();
});

test('auth/account A-B-A invalidates pending tokens and previously issued Use callbacks',async t=>{
 for(const kind of ['scope','auth','sameUid','authObject']){
  const page=await fixture(t,{hint:true});await pointer(page,'[data-community-use]');
  await page.evaluate(({kind,A,B})=>{
   if(kind==='scope'){account=B;scope='scope-1';account=A;scope='scope-2';}
   if(kind==='auth'){auth.emit({uid:'owner-b'});auth.emit(user);}
   if(kind==='sameUid'){auth.emit({...user});auth.emit(user);}
   if(kind==='authObject')auth={...auth};
  },{kind,A,B});assert.equal(await page.evaluate(()=>useContexts[0].isCurrent()),false);page.noExternal();
  const pending=await fixture(t);await pending.evaluate(()=>holdToken=true);await claim(pending);await until(pending,()=>typeof releaseToken==='function');
  await pending.evaluate(({kind,A,B})=>{
   if(kind==='scope'){account=B;scope='scope-1';account=A;scope='scope-2';}
   if(kind==='auth'){auth.emit({uid:'owner-b'});auth.emit(user);}
   if(kind==='sameUid'){auth.emit({...user});auth.emit(user);}
   if(kind==='authObject')auth={...auth};releaseToken();
  },{kind,A,B});await pending.waitForTimeout(20);assert.equal(await pending.evaluate(()=>requests.length+claimed.length+used.length),0);pending.noExternal();
 }
});

test('same-UID and auth-object replacement also reject late relay responses',async t=>{
 for(const kind of ['sameUid','authObject']){
  const page=await fixture(t);await page.evaluate(()=>holdFetch=true);await claim(page);await until(page,()=>typeof releaseFetch==='function');
  await page.evaluate(kind=>{if(kind==='sameUid'){auth.emit({...user});auth.emit(user);}else auth={...auth};releaseFetch();},kind);
  await page.waitForTimeout(25);assert.equal(await page.evaluate(()=>claimed.length+used.length),0);assert.equal(await page.evaluate(()=>requests.length),1);assert.equal(await page.locator('[data-community-use]').isDisabled(),true);page.noExternal();
 }
});
