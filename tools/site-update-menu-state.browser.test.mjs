import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import http from 'node:http';
import {createRequire} from 'node:module';
const require=createRequire(new URL('./verifier/package.json',import.meta.url));
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
let server,browser,base;
before(async()=>{
  server=http.createServer((request,response)=>{
    const path=new URL(request.url,'http://localhost').pathname;
    if(path==='/'){response.setHeader('Content-Type','text/html');response.end('<!doctype html><title>Local updater menu contract</title>');return;}
    if(!/^\/tools\/[a-z0-9-]+\.mjs$/.test(path)){response.writeHead(404).end();return;}
    try{response.setHeader('Content-Type','text/javascript');response.end(readFileSync(new URL('../'+path.slice(1),import.meta.url)));}
    catch{response.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
});
after(async()=>{await browser?.close();await new Promise(resolve=>server?server.close(resolve):resolve());});
async function fixture(t){
  const page=await browser.newPage();t.after(()=>page.close());
  await page.route('**/*',route=>route.request().url().startsWith(base+'/')?route.continue():route.abort());
  await page.goto(base);
  await page.setContent('<style>.hidden,[hidden]{display:none!important}.menu-ui,.sq-events-overlay,#overallProfilePopup{width:400px;height:200px}body{margin:0}</style><div id="ui"><div class="menu-ui"><button>Play</button></div></div>');
  await page.evaluate(async()=>{const module=await import('/tools/site-update-menu-state.mjs');window.menuState=()=>module.readSiteUpdateMenuState(document);});
  return page;
}

test('native top-layer updater dialog and modal inertness do not hide safe menu state',async t=>{
  const page=await fixture(t);
  const states=await page.evaluate(()=>{
    const dialog=document.createElement('dialog');dialog.dataset.siteCompatibility='unsupported';
    dialog.innerHTML='<input type="text"><button>Reload to update</button>';document.body.append(dialog);dialog.showModal();
    dialog.querySelector('button').focus();const ready=menuState();
    dialog.querySelector('input').focus();const editing=menuState();
    dialog.querySelector('button').focus();const restored=menuState();
    return {ready,editing,restored,modal:dialog.matches(':modal')};
  });
  assert.equal(states.modal,true);assert.equal(states.ready.canUpdate,true);
  assert.equal(states.editing.reason,'text-entry');assert.equal(states.restored.canUpdate,true);
});

test('a hidden running/paused native track or editor wins over foreground menus and dialogs',async t=>{
  const page=await fixture(t);
  const states=await page.evaluate(()=>{
    const dialog=document.createElement('dialog');dialog.innerHTML='<button>Settings</button>';document.body.append(dialog);dialog.showModal();
    const ui=document.getElementById('ui'),game=document.createElement('div');game.className='game-ui hidden';ui.append(game);
    const track=menuState();game.innerHTML='<div class="pause-screen-ui"></div>';const paused=menuState();game.remove();
    const editor=document.createElement('div');editor.className='hidden';editor.innerHTML='<div class="editor-side-toolbar-ui"></div><div class="editor-height-selector-ui"></div>';
    ui.append(editor);const loadSave=menuState();editor.remove();const returned=menuState();
    return {track,paused,loadSave,returned};
  });
  assert.equal(states.track.reason,'track-active');assert.equal(states.paused.reason,'track-active');
  assert.equal(states.loadSave.reason,'editor-active');assert.equal(states.returned.canUpdate,true);
});

test('real ancestor visibility and custom event/profile overlays are checked independently',async t=>{
  const page=await fixture(t);
  const states=await page.evaluate(()=>{
    const menu=document.querySelector('.menu-ui'),ui=document.getElementById('ui');ui.style.opacity='0';
    const hiddenParent=menuState();ui.style.opacity='1';menu.style.display='none';
    const overlay=document.createElement('div');overlay.className='sq-events-overlay';overlay.setAttribute('role','dialog');document.body.append(overlay);
    const events=menuState();overlay.style.visibility='hidden';const hiddenEvents=menuState();overlay.remove();
    const profile=document.createElement('div');profile.id='overallProfilePopup';document.body.append(profile);const profileMenu=menuState();
    return {hiddenParent,events,hiddenEvents,profileMenu};
  });
  assert.equal(states.hiddenParent.canUpdate,false);assert.equal(states.events.canUpdate,true);
  assert.equal(states.hiddenEvents.canUpdate,false);assert.equal(states.profileMenu.canUpdate,true);
});

test('the same guard keeps the updater own modal stable and defers it through track entry',async t=>{
  const page=await fixture(t);
  const states=await page.evaluate(async()=>{
    const {installSiteUpdates}=await import('/tools/site-updates.mjs');let reads=0;
    const safe=()=>menuState().canUpdate;
    const handle=installSiteUpdates({revision:100,document,isIdle:safe,canReload:safe,endpoint:'site-version.json',
      fetch:async()=>{reads++;return {ok:true,json:async()=>({revision:101,minimumSupportedRevision:101})};},
      setTimeout:()=>1,clearTimeout:()=>{}});
    await handle.check();const own=()=>document.querySelector('[data-site-compatibility]');
    const original=own();handle.resume();const stable=own()===original&&original.open;
    const game=document.createElement('div');game.className='game-ui hidden';document.getElementById('ui').append(game);
    handle.resume();const deferred=!own()&&document.querySelector('[data-site-update]').hidden;
    game.remove();handle.resume();const returned=!!own()?.open&&!document.querySelector('[data-site-update]').hidden;
    handle.dispose();return {stable,deferred,returned,reads};
  });
  assert.deepEqual(states,{stable:true,deferred:true,returned:true,reads:1});
});
