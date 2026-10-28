import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {HELP_BINDING_IDS,helpKeyMatches,readHelpBindings,createHelpControlGroups,searchHelpControls,renderHelpControls,bindHelpControls} from './help-controls.mjs';

const flat=groups=>groups.flatMap(group=>group.rows);
const find=(groups,id)=>flat(groups).find(row=>row.id===id);

test('all 35 native default actions and numeric IDs match the shipped settings map exactly',async()=>{
  const bundle=await fs.readFile(new URL('../main.bundle.js',import.meta.url),'utf8');
  const start=bundle.indexOf('defaultKeyBindings(){');
  const defaults=bundle.slice(start,bundle.indexOf('setAutoDetectLanguage()',start));
  const native=[...defaults.matchAll(/\[ge\.A\.(\w+),\[([^\]]*)\]\]/g)].map(match=>[match[1],JSON.parse('['+match[2]+']').filter(Boolean)]);
  assert.equal(native.length,35);
  const groups=createHelpControlGroups();
  for(const [action,codes] of native){
    const control=find(groups,action);assert.ok(control,action);
    assert.deepEqual(control.aliases,codes,action);
    assert.ok(bundle.includes(`e[e.${action}=${HELP_BINDING_IDS[action]}]`),action+' enum ID');
  }
  assert.equal(flat(groups).filter(row=>row.binding).length,35);
  assert.deepEqual(find(groups,'SpectatorMoveUp').keys,[['Z']]);
  assert.deepEqual(find(groups,'EditorMoveUp').keys,[['C']]);
});

test('all established help topics are present with unique action IDs',()=>{
  const groups=createHelpControlGroups(),ids=flat(groups).map(row=>row.id);
  assert.deepEqual(groups.map(group=>group.id),['driving','menus','rankings','tracks','ghosts','events','replay','editor','access']);
  assert.equal(new Set(ids).size,ids.length);
  for(const group of groups)assert.ok(group.rows.length&&group.note);
  assert.match(find(groups,'page-offset').description,/Ranked only/);
  assert.match(find(groups,'extra-rate').description,/review menu/);
  assert.match(groups.find(group=>group.id==='ghosts').note,/not an Event board/);
});

test('Event ghost rows describe the actual Event handler and do not invent a saved-group shortcut',async()=>{
  const source=await fs.readFile(new URL('../events/client.mjs',import.meta.url),'utf8');
  const start=source.indexOf("  document.addEventListener('keydown',event=>{",source.indexOf('  function selectEventYouGroup()'));
  const handler=source.slice(start,source.indexOf("  window.addEventListener('blur'",start));
  const group=createHelpControlGroups().find(group=>group.id==='events');
  assert.equal(group.rows.length,10);
  assert.deepEqual(find([group],'event-ghost-clear').keys,[['C']]);
  assert.deepEqual(find([group],'event-ghost-you').keys,[['='],['Backspace']]);
  assert.deepEqual(find([group],'event-ghost-ahead').keys,[['-']]);
  for(const action of ['selectEventYouGroup()','clearEventGhostSelection(','selectEventRange(','selectTopEventRows(digit)','pages[digit-1]'])assert.ok(handler.includes(action),action);
  assert.ok(handler.includes('eventTopPrefixUntil=Date.now()+2500'));
  assert.ok(source.includes('const chosen=rows.slice(0,9),mine=rows.find'));
  assert.ok(!group.rows.some(row=>row.id==='ghost-group'));
  assert.equal(searchHelpControls(createHelpControlGroups(),'event ghost','events')[0].rows.some(row=>row.id==='event-ghost-top'),true);
});

test('current native bindings override defaults by name, numeric ID, Map or callback',()=>{
  for(const bindings of [{VehicleAccelerate:['KeyI','Numpad8']},{0:['KeyI','Numpad8']},new Map([[0,['KeyI','Numpad8']]])]){
    const control=find(createHelpControlGroups({bindings}),'VehicleAccelerate');
    assert.deepEqual(control.keys,[['I'],['Num 8']]);assert.equal(control.custom,true);
  }
  const control=find(createHelpControlGroups({bindings:{VehicleAccelerate:['KeyQ']},getBindings:(name,id)=>id===0?['KeyJ']:undefined}),'VehicleAccelerate');
  assert.deepEqual(control.keys,[['J']]);
  assert.deepEqual(find(createHelpControlGroups({bindings:{Pause:[]}}),'Pause').keys,[]);
  assert.deepEqual(find(createHelpControlGroups({bindings:new Map([['Pause',null]])}),'Pause').keys,[]);
  assert.match(renderHelpControls({bindings:{Pause:[]}}),/Not bound/);
  assert.equal(find(createHelpControlGroups({bindings:{Pause:['KeyP','Space']}}),'Pause').custom,false);
  assert.equal(find(createHelpControlGroups({ghostShortcut:'KeyF'}),'ghost-group').keys[0][0],'F');
  assert.deepEqual(find(createHelpControlGroups({ghostShortcut:'Shift+KeyF'}),'ghost-group').keys,[['Shift','F']]);
  assert.deepEqual(find(createHelpControlGroups({ghostShortcut:null}),'ghost-group').keys,[]);
});

test('readHelpBindings reads exactly the native storage key once, with no other storage access',()=>{
  const calls=[];
  const result=readHelpBindings({
    getItem(key){calls.push(key);return JSON.stringify([['VehicleAccelerate',['KeyI','ArrowUp']],['Pause',[null,null]]]);},
    setItem(){assert.fail('Help must not write storage');},key(){assert.fail('Help must not enumerate storage');}
  });
  assert.deepEqual(calls,['polytrack_v5_prod_key_bindings']);
  assert.deepEqual(result,{VehicleAccelerate:['KeyI','ArrowUp'],Pause:[null,null]});
  const groups=createHelpControlGroups({bindings:result});
  assert.deepEqual(find(groups,'VehicleAccelerate').keys,[['I'],['Up']]);
  assert.deepEqual(find(groups,'Pause').keys,[],'explicit null pair must not restore P / Space');
});

test('native tuple validation ignores malformed and unknown rows without losing valid rows',()=>{
  const input=[null,{},[],['Pause'],['Pause',['KeyQ']],['Pause',['KeyQ',null,0]],['Pause','KeyQ'],
    ['Pause',[false,null]],['Pause',[null,{}]],['UnknownAction',['KeyZ',null]],['__proto__',['KeyZ',null]],
    [0,['KeyZ',null]],['0',['KeyZ',null]],['VehicleBrake',['KeyB',null]],['Pause',[null,null]],
    ['VehicleBrake',['KeyV','ArrowDown']],['VehicleBrake',[3,null]]];
  assert.deepEqual(readHelpBindings({getItem:()=>JSON.stringify(input)}),{VehicleBrake:['KeyV','ArrowDown'],Pause:[null,null]});
});

test('native binding reader contains storage failures, bad JSON and oversized input',()=>{
  assert.deepEqual(readHelpBindings(null),{});
  assert.deepEqual(readHelpBindings({getItem(){throw Error('storage denied');}}),{});
  for(const raw of [undefined,null,123,'','{bad json}','{}','null','true','x'.repeat(65537),JSON.stringify(Array.from({length:257},()=>['Pause',[null,null]]))]){
    assert.deepEqual(readHelpBindings({getItem:()=>raw}),{},String(raw).slice(0,30));
  }
});

test('native binding parser parity for valid tuples, including nulls and unusual string labels',async()=>{
  const bundle=await fs.readFile(new URL('../main.bundle.js',import.meta.url),'utf8');
  assert.ok(bundle.includes('let e="polytrack_v5_";return e+="prod_",e'));
  assert.ok(bundle.includes('keyBindingsKey:Fu+"key_bindings"'));
  const tuples=Object.keys(HELP_BINDING_IDS).map((name,index)=>[name,index%2?[null,null]:['KeyQ',null]]);
  tuples.push(['Pause',['','<unusual & safe>']]);
  const storage={getItem:()=>JSON.stringify(tuples)},start=bundle.indexOf('loadKeyBindings(){');
  const method=bundle.slice(start,bundle.indexOf('saveTrackSelectionTab(',start));
  const native=vm.runInNewContext('({'+method+'}).loadKeyBindings()',{
    R:{gn:()=>storage},Hu:{},Ou:{keyBindingsKey:'polytrack_v5_prod_key_bindings'},ge:{A:HELP_BINDING_IDS},console:{error:()=>{}}
  });
  const byId=Object.fromEntries(Object.entries(HELP_BINDING_IDS).map(([name,id])=>[id,name]));
  const result=readHelpBindings(storage);
  assert.equal(JSON.stringify(result),JSON.stringify(Object.fromEntries(native.map(([id,pair])=>[byId[id],pair]))));
  assert.doesNotMatch(renderHelpControls({bindings:result}),/<unusual & safe>/);
});

test('search is word-based, case-insensitive and covers actions, context and actual key codes',()=>{
  const groups=createHelpControlGroups({bindings:{VehicleAccelerate:['KeyI']}});
  assert.equal(searchHelpControls(groups,'CHECKPOINT')[0].rows[0].id,'VehicleCheckpointReset');
  assert.equal(searchHelpControls(groups,'driving checkpoint')[0].rows[0].id,'VehicleCheckpointReset');
  assert.equal(searchHelpControls(groups,'KeyI')[0].rows[0].id,'VehicleAccelerate');
  assert.ok(searchHelpControls(groups,'spectator z').some(group=>group.rows.some(row=>row.id==='SpectatorMoveUp')));
  assert.equal(searchHelpControls(groups,'checkpoint','editor').length,0);
  assert.equal(searchHelpControls(groups,'<script>.*').length,0);
  assert.ok(searchHelpControls(groups,'  shift   page ').length>0);
  assert.equal(searchHelpControls(groups,'').length,9);
  assert.equal(find(groups,'VehicleAccelerate').keys[0][0],'I','search does not mutate rows');
});

test('untrusted key labels, release data and attribute values are escaped, never HTML',()=>{
  const attack='"><img src=x onerror="alert(1)">&\'';
  const html=renderHelpControls({idPrefix:attack,ghostShortcut:attack,bindings:{Pause:[attack]},release:{version:attack,revision:attack,commit:attack,commitConfirmed:true,notes:[attack]}});
  assert.doesNotMatch(html,/<img|onerror="alert|<script/);
  assert.match(html,/&lt;img/);assert.match(html,/&quot;/);assert.match(html,/&#39;/);assert.match(html,/&amp;/);
  assert.doesNotMatch(html,/id="[^"]*<|data-hc-search-text="[^"]*</);
});

test('release number and revision are separate; only confirmed hexadecimal Git hashes display',()=>{
  assert.doesNotMatch(renderHelpControls(),/data-hc-view="release"|Client revision|Commit/);
  const html=renderHelpControls({release:{number:224,revision:193,commit:'224',commitConfirmed:true,notes:['Local controls.']}});
  assert.match(html,/<dt>Release number<\/dt><dd>224/);
  assert.match(html,/<dt>Client revision<\/dt><dd>193/);
  assert.doesNotMatch(html,/<dt>Commit/);
  assert.match(html,/Local controls\./);
  assert.match(renderHelpControls({release:{commit:'abcdef123',commitConfirmed:true}}),/<dt>Commit<\/dt><dd>abcdef123/);
  assert.doesNotMatch(renderHelpControls({release:{commit:'abcdef123'}}),/<dt>Commit/);
});
test('HTML has semantic native disclosures, labels, status and one keycap per chord key',()=>{
  const html=renderHelpControls({idPrefix:'help-test'});
  assert.match(html,/aria-labelledby="help-test-title"/);
  assert.match(html,/<label for="help-test-search">/);
  assert.match(html,/id="help-test-search" type="search"/);
  assert.match(html,/role="status" aria-live="polite" aria-atomic="true"/);
  assert.equal((html.match(/<details /g)||[]).length,10);
  assert.equal((html.match(/<summary>/g)||[]).length,10);
  assert.match(html,/<kbd data-hc-key="Shift">Shift<\/kbd>.*?<kbd data-hc-key="Tab">Tab<\/kbd>/s);
  assert.doesNotMatch(html,/<kbd>Shift \+ Tab<\/kbd>|role="dialog"|tabindex="-1"|autofocus/);
  for(const action of ['profile','filters','ghost-shortcut'])assert.ok(html.includes(`data-help-action="${action}"`));
  assert.match(html,/Window Cleaner/);
  assert.doesNotMatch(html,/The right key|Built for the next|DRIVER HANDBOOK|Same key, different job/);
  assert.notEqual(renderHelpControls().match(/aria-labelledby="([^"]+)"/)[1],renderHelpControls().match(/aria-labelledby="([^"]+)"/)[1]);
});

test('binding an absent host is a safe no-op',()=>{
  const cleanup=bindHelpControls(null);assert.equal(typeof cleanup,'function');cleanup();cleanup();
});

async function keyboardGuardFixture() {
  const source=await fs.readFile(new URL('./help-controls.mjs',import.meta.url),'utf8');
  const start=source.indexOf('const keyboardGuards=new WeakMap();');
  const end=source.indexOf('/** Bind a rendered fragment',start);
  assert.ok(start>=0&&end>start);
  const install=vm.runInNewContext(source.slice(start,end)+'\nguardHelpKeyboard;');
  const listeners=new Map();
  const view={
    addEventListener(type,handler,capture){
      if(type!=='blur')assert.equal(capture,true,'intercept before document and native listeners');
      const list=listeners.get(type)||[];list.push(handler);listeners.set(type,list);
    },
    removeEventListener(type,handler){listeners.set(type,(listeners.get(type)||[]).filter(item=>item!==handler));}
  };
  const doc={defaultView:view};
  const emit=(type,key='=',code='Equal')=>{
    const event={type,key,code,cancelBubble:false,defaultPrevented:false,immediate:false,
      stopPropagation(){this.cancelBubble=true;},
      stopImmediatePropagation(){this.cancelBubble=true;this.immediate=true;},
      preventDefault(){this.defaultPrevented=true;}};
    for(const handler of [...(listeners.get(type)||[])]){handler(event);if(event.immediate)break;}
    return event;
  };
  return {install:binding=>install(doc,binding),listeners,emit};
}

test('Help guard runs feedback before containment, preserves defaults and drains keyup after close',async()=>{
  const f=await keyboardGuardFixture(),seen=[];
  const cleanup=f.install({accepts:()=>true,down:event=>seen.push('down:'+event.key),up:event=>seen.push('up:'+event.key),blur:()=>seen.push('blur')});
  const down=f.emit('keydown');
  assert.deepEqual(seen,['down:=']);assert.equal(down.immediate,true);assert.equal(down.defaultPrevented,false);
  cleanup();
  assert.equal(f.listeners.get('keyup').length,1,'retain only until held key is released');
  const up=f.emit('keyup');assert.equal(up.immediate,true);assert.equal(up.defaultPrevented,false);
  assert.equal(f.listeners.get('keyup').length,0);assert.equal(f.listeners.get('keydown').length,0);
  assert.equal(f.emit('keyup').immediate,false,'normal game input resumes');
});

test('Help guard delegates Tab and Escape to the parent but contains consumed search Escape',async()=>{
  const f=await keyboardGuardFixture();let consumed=false;
  const cleanup=f.install({accepts:()=>true,down:event=>{if(consumed){event.preventDefault();event.stopPropagation();}},up:()=>{},blur:()=>{}});
  for(const key of ['Tab','Escape']){
    const event=f.emit('keydown',key,key);assert.equal(event.immediate,false);assert.equal(event.defaultPrevented,false);
    assert.equal(f.emit('keyup',key,key).immediate,true);
  }
  consumed=true;
  const event=f.emit('keydown','Escape','Escape');assert.equal(event.immediate,true);assert.equal(event.defaultPrevented,true);
  f.emit('keyup','Escape','Escape');cleanup();
});

test('Help guard rebind shares one interceptor and blur releases retained cleanup state',async()=>{
  const f=await keyboardGuardFixture();let up=0,blur=0;
  const old=f.install({accepts:()=>true,down:()=>{},up:()=>{},blur:()=>{}});
  f.emit('keydown');old();
  const cleanup=f.install({accepts:()=>true,down:()=>{},up:()=>up++,blur:()=>blur++});
  assert.equal(f.listeners.get('keyup').length,1);
  assert.equal(f.emit('keyup').immediate,true);assert.equal(up,1);
  f.emit('blur');assert.equal(blur,1);
  f.emit('keydown');cleanup();f.emit('blur');
  assert.equal(f.listeners.get('keydown').length,0);assert.equal(f.listeners.get('keyup').length,0);
});

test('Help guard leaves foreign modal or hidden Help events alone',async()=>{
  const f=await keyboardGuardFixture();let feedback=0;
  const cleanup=f.install({accepts:()=>false,down:()=>feedback++,up:()=>{},blur:()=>{}});
  assert.equal(f.emit('keydown').immediate,false);assert.equal(f.emit('keyup').immediate,false);assert.equal(feedback,0);
  cleanup();assert.equal(f.listeners.get('keyup').length,0);
});

const require=createRequire(new URL('./verifier/package.json',import.meta.url));
let chromium;
try{({chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'));}catch{}

test('Help actual patch modal boundary blocks native keys and preserves keyboard defaults',{skip:!chromium||process.env.HELP_UNIT_ONLY==='1'},async t=>{
  const patch=await fs.readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
  const main=await fs.readFile(new URL('../main.bundle.js',import.meta.url),'utf8');
  const help=await fs.readFile(new URL('./help-controls.mjs',import.meta.url),'utf8');
  const release=await fs.readFile(new URL('./release-info.mjs',import.meta.url),'utf8');
  const focusStart=patch.indexOf('  let overallDialogReturnFocus=null;');
  const focusEnd=patch.indexOf('  /* Keep the select',focusStart);
  const keyStart=patch.indexOf("    panel.addEventListener('keydown', (event)=>{");
  const keyEnd=patch.indexOf('\n    });',keyStart)+'\n    });'.length;
  assert.ok(focusStart>=0&&focusEnd>focusStart&&keyStart>=0&&keyEnd>keyStart);
  const fps='window.addEventListener("keyup",(e=>{r.checkKeyBinding(e,ge.A.ToggleFpsCounter)&&M.toggle()}))';
  assert.ok(main.includes(fps),'exercise the exact shipped unconditional FPS keyup listener');
  const browser=await chromium.launch({headless:true});t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1000,height:800}});
  const requests=[];await page.route('**/*',route=>{requests.push(route.request().url());return route.abort();});
  await page.setContent('<button id="opener">Open Help</button><main id="overallLeaderboardPanel"><div id="overallProfilePopup" style="display:none"></div><div id="overallHelpPopup" style="display:none"><section role="dialog" aria-modal="true" aria-label="Help"><button id="overallHelpClose">Close</button><div id="help-content"></div></section></div></main>');
  await page.addScriptTag({content:(release+help.replace(/^const \{parseReleasePreparedAt,releaseAge\}=await import\([^\n]+;\r?\n/m,'')).replace(/\bexport /g,'')+`
    window.nativeKeys=[];window.fpsToggles=0;
    for(const type of ['keydown','keyup'])window.addEventListener(type,event=>nativeKeys.push(type+':'+event.key));
    const r={checkKeyBinding:event=>event.code==='Equal'},ge={A:{ToggleFpsCounter:24}},M={toggle:()=>fpsToggles++};
    ${fps};
    function isElementVisible(node){return Boolean(node&&node.getClientRects().length&&getComputedStyle(node).visibility!=='hidden');}
    function closeOverallPanel(){throw Error('Help must not close the underlying panel');}
    ${patch.slice(focusStart,focusEnd)}
    const panel=document.querySelector('#overallLeaderboardPanel'),popup=document.querySelector('#overallHelpPopup'),content=document.querySelector('#help-content'),close=document.querySelector('#overallHelpClose');
    content.innerHTML=renderHelpControls({idPrefix:'actual-boundary',release:{number:225,revision:194}});
    ${patch.slice(keyStart,keyEnd)}
    close.onclick=()=>closeRankedDialog(popup);
    window.openHelp=()=>{popup.__helpCleanup=bindHelpControls(content);openRankedDialog(popup,close);};
    window.focusLast=()=>visibleDialogFocusables(popup).at(-1).focus();
    window.isLastFocused=()=>visibleDialogFocusables(popup).at(-1)===document.activeElement;
  `});
  const open=async()=>{await page.locator('#opener').focus();await page.evaluate(()=>openHelp());await page.waitForFunction(()=>document.activeElement.id==='overallHelpClose');};
  await open();
  await page.keyboard.down('=');
  assert.ok(await page.locator('[data-hc-key="="].is-pressed').count()>0,'Close-focus feedback survives capture containment');
  await page.keyboard.up('=');assert.equal(await page.locator('kbd.is-pressed').count(),0);
  for(const key of ['y','u','i'])await page.keyboard.press(key);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('[data-hc-view="controls"]').evaluate(node=>node===document.activeElement),true,'ordinary Tab retains its default');
  await page.evaluate(()=>focusLast());await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement.id),'overallHelpClose');
  await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>isLastFocused()),true);
  const input=page.locator('[data-hc-search]');await input.focus();await input.pressSequentially('checkpoint');
  assert.equal(await input.inputValue(),'checkpoint');assert.equal(await page.locator('[data-hc-row]:visible').count(),1);
  await page.keyboard.press('Escape');assert.equal(await input.inputValue(),'');assert.equal(await page.locator('#overallHelpPopup').isVisible(),true);
  await page.keyboard.press('Escape');assert.equal(await page.locator('#overallHelpPopup').isVisible(),false);
  assert.equal(await page.evaluate(()=>document.activeElement.id),'opener');
  assert.deepEqual(await page.evaluate(()=>nativeKeys),[]);assert.equal(await page.evaluate(()=>fpsToggles),0);
  for(const key of ['Enter','Space']){await open();await page.keyboard.press(key);assert.equal(await page.locator('#overallHelpPopup').isVisible(),false,'native Close activation: '+key);}
  await open();await page.keyboard.down('=');await page.locator('#overallHelpClose').click();await page.keyboard.up('=');
  assert.deepEqual(await page.evaluate(()=>nativeKeys),[],'held releases after Close do not reach the native game');
  assert.equal(await page.evaluate(()=>fpsToggles),0);
  await page.keyboard.press('=');assert.equal(await page.evaluate(()=>fpsToggles),1,'native handler resumes after closure');
  assert.deepEqual(requests,[]);
});

test('offline DOM behavior: search, disclosures, keyboard, views, cleanup and responsive layout',{skip:!chromium||process.env.HELP_UNIT_ONLY==='1'},async t=>{
  const browser=await chromium.launch({headless:true});
  t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1100,height:900},hasTouch:true});
  let network=0;
  await page.route('**/*',route=>{network++;return route.abort();});
  const [module,css,font]=await Promise.all([
    fs.readFile(new URL('./help-controls.mjs',import.meta.url),'utf8'),
    fs.readFile(new URL('../help-controls.css',import.meta.url),'utf8'),
    fs.readFile(new URL('../forced_square.woff2',import.meta.url))
  ]);
  await page.setContent('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{margin:0;background:#09142c}#fixture{max-width:1040px;margin:auto}</style><main id="fixture"></main>');
  await page.addStyleTag({content:'@font-face{font-family:ForcedSquare;src:url(data:font/woff2;base64,'+font.toString('base64')+')}'+css});
  await page.addScriptTag({content:(await fs.readFile(new URL('./release-info.mjs',import.meta.url),'utf8')+module.replace(/^const \{parseReleasePreparedAt,releaseAge\}=await import\([^\n]+;\r?\n/m,'')).replace(/\bexport /g,'')+'\nwindow.helpAPI={renderHelpControls,bindHelpControls};'});
  await page.evaluate(()=>{
    const root=document.querySelector('#fixture');
    root.innerHTML=window.helpAPI.renderHelpControls({idPrefix:'test-help',ghostShortcut:'KeyF',release:{revision:189,commit:217,commitConfirmed:false,notes:['Offline fixture.']}});
    window.cleanupHelp=window.helpAPI.bindHelpControls(root);
    window.bubbledKeys=[];document.addEventListener('keydown',event=>window.bubbledKeys.push(event.key));
  });
  const input=page.locator('[data-hc-search]'),group=page.locator('[data-hc-group="driving"]');
  assert.equal(await group.getAttribute('open'),'');
  await page.evaluate(()=>{
    const fixture=document.querySelector('#fixture');fixture.setAttribute('role','dialog');
    const close=document.createElement('button');close.id='fixture-close';close.textContent='Close';fixture.prepend(close);close.focus();
    window.cleanupHelp=window.helpAPI.bindHelpControls(fixture);
  });
  await page.keyboard.down('w');
  assert.ok(await page.locator('[data-hc-key="W"].is-pressed').count()>0,'Close button focus lights keys before any Help-content click');
  await page.keyboard.up('w');
  await page.evaluate(()=>{window.bubbledKeys=[];});
  await input.fill('checkpoint');
  assert.equal(await page.locator('[data-hc-row]:visible').count(),1);
  assert.equal(await page.locator('[data-hc-status]').textContent(),'1 control found');
  assert.equal(await page.locator('[data-hc-group]:visible').count(),1);
  await input.press('Escape');assert.equal(await input.inputValue(),'');
  assert.equal(await group.getAttribute('open'),'');
  assert.equal(await page.locator('[data-hc-group="menus"]').getAttribute('open'),null);
  assert.deepEqual(await page.evaluate(()=>window.bubbledKeys),[]);
  await input.press('Escape');assert.deepEqual(await page.evaluate(()=>window.bubbledKeys),['Escape']);
  await page.locator('[data-hc-topic-select]').selectOption('editor');
  assert.equal(await page.locator('[data-hc-group]:visible').count(),1);
  await input.fill('not an actual control');
  assert.equal(await page.locator('[data-hc-empty]').isVisible(),true);
  await page.locator('[data-hc-reset]').click();assert.equal(await input.inputValue(),'');
  assert.equal(await page.locator('[data-hc-topic-select]').inputValue(),'all');
  await page.locator('[data-hc-topic-select]').focus();await page.keyboard.press('End');
  await page.keyboard.press('Tab');assert.equal(await page.locator('[data-hc-topic-select]').inputValue(),'access');
  assert.ok((await page.evaluate(()=>window.bubbledKeys)).includes('Tab'),'Tab reaches the outer modal trap');
  await input.fill('touch');await page.locator('[data-hc-clear]').click();assert.equal(await input.inputValue(),'');
  assert.equal(await input.evaluate(node=>node===document.activeElement),true);
  await page.locator('[data-hc-view="release"]').click();
  assert.equal(await page.locator('[data-hc-panel="release"]').isVisible(),true);
  assert.equal(await page.locator('[data-hc-panel="controls"]').isVisible(),false);
  assert.equal(await page.locator('.hc-release').textContent().then(text=>text.includes('217')),false);
  await page.locator('[data-hc-view="controls"]').click();
  await page.locator('[data-hc-topic-select]').selectOption('all');
  // Fully expanded rows exercise wrapping, not only collapsed headings.
  await page.evaluate(()=>{for(const node of document.querySelectorAll('details'))node.open=true;});
  for(const width of [320,390,620,768,1100]){
    await page.setViewportSize({width,height:850});await page.evaluate(()=>document.fonts.ready);
    const size=await page.evaluate(()=>{
      const root=document.querySelector('[data-help-controls]');
      return {scroll:document.documentElement.scrollWidth,width:innerWidth,root:root.scrollWidth,client:root.clientWidth,
        overflow:[...root.querySelectorAll('.hc-row,.hc-keycaps,.hc-group,.hc-topics')].filter(node=>node.scrollWidth>node.clientWidth+1).map(node=>node.className)};
    });
    assert.ok(size.scroll<=size.width+1,JSON.stringify({width,size}));
    assert.ok(size.root<=size.client+1,JSON.stringify({width,size}));assert.deepEqual(size.overflow,[]);
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  assert.equal(await page.locator('.hc-header').evaluate(node=>getComputedStyle(node).animationName),'none');
  await page.setViewportSize({width:390,height:844});
  await page.locator('[data-hc-topic-select]').selectOption('ghosts');
  assert.equal(await page.locator('[data-hc-topic-select]').inputValue(),'ghosts');
  await page.locator('[data-hc-topic-select]').selectOption('rankings');
  await page.locator('[data-hc-results-title]').evaluate(node=>{node.tabIndex=-1;node.focus();});
  await page.keyboard.down('d');
  assert.ok(await page.locator('[data-hc-key="D"].is-pressed:visible').count()>0);
  if(process.env.HELP_REVIEW_SCREENSHOT)await page.screenshot({path:process.env.HELP_REVIEW_SCREENSHOT,fullPage:true});
  await page.keyboard.up('d');assert.equal(await page.locator('kbd.is-pressed').count(),0);
  await input.focus();await page.keyboard.down('d');assert.equal(await page.locator('kbd.is-pressed').count(),0);await page.keyboard.up('d');
  await input.fill('');await page.locator('[data-hc-topic-select]').selectOption('ghosts');await page.locator('[data-hc-results-title]').evaluate(node=>{node.tabIndex=-1;node.focus();});
  await page.locator('[data-hc-results-title]').evaluate(node=>{node.tabIndex=-1;node.focus();});
  await page.keyboard.down('f');assert.ok(await page.locator('[data-hc-key="F"].is-pressed:visible').count()>0);
  await page.evaluate(()=>window.dispatchEvent(new Event('blur')));assert.equal(await page.locator('kbd.is-pressed').count(),0);await page.keyboard.up('f');
  await page.evaluate(()=>{window.cleanupHelp();window.cleanupHelp();});
  await page.keyboard.down('f');assert.equal(await page.locator('kbd.is-pressed').count(),0);await page.keyboard.up('f');
  const before=await page.locator('[data-hc-status]').textContent();await input.fill('no match after cleanup');
  assert.equal(await page.locator('[data-hc-status]').textContent(),before);
  await page.evaluate(()=>{window.cleanupHelp=window.helpAPI.bindHelpControls(document.querySelector('#fixture'));});
  assert.equal(await page.locator('[data-hc-empty]').isVisible(),true);
  assert.equal(network,0,'fixture and help must make no network requests');
});

test('highlight matching respects remaps, ranges, punctuation and modifier labels',()=>{
 const match=(label,code,key)=>helpKeyMatches(label,{code,key});
 assert.equal(match('D','KeyD','d'),true);assert.equal(match('D','KeyF','f'),false);assert.equal(match('D','KeyQ','d'),false);assert.equal(match('Q','KeyD','q'),false);
 assert.equal(match('Right','ArrowRight','ArrowRight'),true);assert.equal(match('Shift','ShiftRight','Shift'),true);
 assert.equal(match('Left Shift','ShiftRight','Shift'),false);assert.equal(match('Left Shift','ShiftLeft','Shift'),true);
 assert.equal(match('1-4','Digit4','4'),true);assert.equal(match('1-4','Digit5','5'),false);
 assert.equal(match('1-9, 0','Digit0','0'),true);assert.equal(match('1-9','Digit0','0'),false);
 assert.equal(match('+','Equal','+'),true);assert.equal(match('Esc','Escape','Escape'),true);
});

test('track tabs are explicit searchable chords matching the shipped track menu handler',async()=>{
  const groups=createHelpControlGroups(),control=find(groups,'track-tab-direct');
  assert.deepEqual(control.keys,[['Shift','1'],['Shift','2'],['Shift','3']]);
  for(const term of ['official','community','custom']) assert.ok(searchHelpControls(groups,'shift '+term).some(group=>group.rows.some(row=>row.id===control.id)));
  const html=renderHelpControls();
  assert.doesNotMatch(html,/hc-track-quick|Track selection shortcuts/);
  assert.match(html,/data-hc-topic-select/);
  for(const name of ['Official','Community','Custom']) assert.ok(html.includes(name));
  const source=await fs.readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
  const start=source.indexOf('  function handleTrackMenuShortcut(event)');
  const handler=source.slice(start,source.indexOf('\n  }',start));
  assert.ok(handler.includes('const digit=/^Digit([1-3])$/.exec(event.code'));
  assert.ok(handler.includes('if(event.shiftKey&&digit)index=Number(digit[1])-1'));
  assert.ok(handler.includes('tabs[index].click()'));
  assert.ok(handler.includes('target?.isContentEditable'));
});
