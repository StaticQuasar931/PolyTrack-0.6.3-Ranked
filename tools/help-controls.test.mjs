import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {HELP_BINDING_IDS,readHelpBindings,createHelpControlGroups,searchHelpControls,renderHelpControls,bindHelpControls} from './help-controls.mjs';

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

test('revision and commit are configurable, never assumed, and unconfirmed commit is omitted',()=>{
  const normal=renderHelpControls();
  assert.doesNotMatch(normal,/data-hc-view="release"|Client revision|Commit|189|217/);
  const draft=renderHelpControls({release:{revision:189,commit:217}});
  assert.match(draft,/Client revision/);assert.match(draft,/>189</);assert.doesNotMatch(draft,/>217<|<dt>Commit/);
  const confirmed=renderHelpControls({release:{revision:189,commit:217,commitConfirmed:true,notes:['Verified local controls.']}});
  assert.match(confirmed,/<dt>Commit<\/dt><dd>217/);assert.match(confirmed,/Verified local controls\./);
  assert.match(renderHelpControls({release:{revision:999,commit:123,commitConfirmed:true}}),/<dt>Commit<\/dt><dd>123/);
});

test('HTML has semantic native disclosures, labels, status and one keycap per chord key',()=>{
  const html=renderHelpControls({idPrefix:'help-test'});
  assert.match(html,/aria-labelledby="help-test-title"/);
  assert.match(html,/<label for="help-test-search">/);
  assert.match(html,/id="help-test-search" type="search"/);
  assert.match(html,/role="status" aria-live="polite" aria-atomic="true"/);
  assert.equal((html.match(/<details /g)||[]).length,10);
  assert.equal((html.match(/<summary>/g)||[]).length,10);
  assert.match(html,/<kbd>Shift<\/kbd>.*?<kbd>Tab<\/kbd>/s);
  assert.doesNotMatch(html,/<kbd>Shift \+ Tab<\/kbd>|role="dialog"|tabindex="-1"|autofocus/);
  for(const action of ['profile','filters','ghost-shortcut'])assert.ok(html.includes(`data-help-action="${action}"`));
  assert.match(html,/Window Cleaner/);
  assert.doesNotMatch(html,/The right key|Built for the next|DRIVER HANDBOOK|Same key, different job/);
  assert.notEqual(renderHelpControls().match(/aria-labelledby="([^"]+)"/)[1],renderHelpControls().match(/aria-labelledby="([^"]+)"/)[1]);
});

test('binding an absent host is a safe no-op',()=>{
  const cleanup=bindHelpControls(null);assert.equal(typeof cleanup,'function');cleanup();cleanup();
});

const require=createRequire(new URL('./verifier/package.json',import.meta.url));
let chromium;
try{({chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright'));}catch{}

test('offline DOM behavior: search, disclosures, keyboard, views, cleanup and responsive layout',{skip:!chromium},async t=>{
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
  await page.addScriptTag({content:module.replace(/\bexport /g,'')+'\nwindow.helpAPI={renderHelpControls,bindHelpControls};'});
  await page.evaluate(()=>{
    const root=document.querySelector('#fixture');
    root.innerHTML=window.helpAPI.renderHelpControls({idPrefix:'test-help',ghostShortcut:'KeyF',release:{revision:189,commit:217,commitConfirmed:false,notes:['Offline fixture.']}});
    window.cleanupHelp=window.helpAPI.bindHelpControls(root);
    window.bubbledKeys=[];document.addEventListener('keydown',event=>window.bubbledKeys.push(event.key));
  });
  const input=page.locator('[data-hc-search]'),group=page.locator('[data-hc-group="driving"]');
  assert.equal(await group.getAttribute('open'),'');
  await input.fill('checkpoint');
  assert.equal(await page.locator('[data-hc-row]:visible').count(),1);
  assert.equal(await page.locator('[data-hc-status]').textContent(),'1 control found');
  assert.equal(await page.locator('[data-hc-group]:visible').count(),1);
  await input.press('Escape');assert.equal(await input.inputValue(),'');
  assert.equal(await group.getAttribute('open'),'');
  assert.equal(await page.locator('[data-hc-group="menus"]').getAttribute('open'),null);
  assert.deepEqual(await page.evaluate(()=>window.bubbledKeys),[]);
  await input.press('Escape');assert.deepEqual(await page.evaluate(()=>window.bubbledKeys),['Escape']);
  await page.locator('[data-hc-topic="editor"]').click();
  assert.equal(await page.locator('[data-hc-group]:visible').count(),1);
  await input.fill('not an actual control');
  assert.equal(await page.locator('[data-hc-empty]').isVisible(),true);
  await page.locator('[data-hc-reset]').click();assert.equal(await input.inputValue(),'');
  assert.equal(await page.locator('[data-hc-topic="all"]').getAttribute('aria-pressed'),'true');
  await page.locator('[data-hc-topic="all"]').focus();await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('[data-hc-topic="driving"]').evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('End');assert.equal(await page.locator('[data-hc-topic="access"]').evaluate(node=>node===document.activeElement),true);
  await page.keyboard.press('Enter');assert.equal(await page.locator('[data-hc-topic="access"]').getAttribute('aria-pressed'),'true');
  await input.fill('touch');await page.locator('[data-hc-clear]').click();assert.equal(await input.inputValue(),'');
  assert.equal(await input.evaluate(node=>node===document.activeElement),true);
  await page.locator('[data-hc-view="release"]').click();
  assert.equal(await page.locator('[data-hc-panel="release"]').isVisible(),true);
  assert.equal(await page.locator('[data-hc-panel="controls"]').isVisible(),false);
  assert.equal(await page.locator('.hc-release').textContent().then(text=>text.includes('217')),false);
  await page.locator('[data-hc-view="controls"]').click();
  await page.locator('[data-hc-topic="all"]').click();
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
  await page.locator('[data-hc-topic="ghosts"]').tap();
  assert.equal(await page.locator('[data-hc-topic="ghosts"]').getAttribute('aria-pressed'),'true');
  await page.evaluate(()=>{window.cleanupHelp();window.cleanupHelp();});
  const before=await page.locator('[data-hc-status]').textContent();await input.fill('no match after cleanup');
  assert.equal(await page.locator('[data-hc-status]').textContent(),before);
  await page.evaluate(()=>{window.cleanupHelp=window.helpAPI.bindHelpControls(document.querySelector('#fixture'));});
  assert.equal(await page.locator('[data-hc-empty]').isVisible(),true);
  assert.equal(network,0,'fixture and help must make no network requests');
});
