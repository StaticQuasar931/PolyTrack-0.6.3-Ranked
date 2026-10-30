// Keep this dependency on the same client cache revision as the loaded Help module.
const {parseReleasePreparedAt}=await import(new URL('./release-info.mjs'+new URL(import.meta.url).search,import.meta.url).href);
const {releaseUpdateAge,formatReleaseUpdateAge}=await import(new URL('./site-updates.mjs'+new URL(import.meta.url).search,import.meta.url).href);

// Native action names and IDs mirror main.bundle.js: defaultKeyBindings / module 3277.
const nativeRows = [
  ['VehicleAccelerate',0,'driving','Accelerate',['KeyW','ArrowUp'],''],
  ['VehicleTurnRight',1,'driving','Steer right',['KeyD','ArrowRight'],''],
  ['VehicleBrake',2,'driving','Brake / reverse',['KeyS','ArrowDown'],'Slow down; reverse when stopped.'],
  ['VehicleTurnLeft',3,'driving','Steer left',['KeyA','ArrowLeft'],''],
  ['VehicleCheckpointReset',4,'driving','Reset to checkpoint',['KeyR','Enter'],''],
  ['VehicleStartReset',5,'driving','Restart track',['KeyT','Backspace'],''],
  ['VehicleCockpitCamera',6,'driving','Cockpit camera',['KeyC','KeyM'],''],
  ['ToggleUI',7,'driving','Show / hide race UI',['KeyH',null],''],
  ['Pause',8,'driving','Pause',['KeyP','Space'],'Open the pause menu.'],
  ['EditorRotatePart',9,'editor','Rotate part',['KeyR','Space'],'Rotate the selected part.'],
  ['EditorHeightModifier',10,'editor','Height modifier',['ShiftLeft','ShiftRight'],'Hold while adjusting height.'],
  ['EditorDelete',11,'editor','Delete part',['Delete','KeyX'],''],
  ['EditorMoveForwards',12,'editor','Move forward',['KeyW','ArrowUp'],''],
  ['EditorMoveRight',13,'editor','Move right',['KeyD','ArrowRight'],''],
  ['EditorMoveBackwards',14,'editor','Move backward',['KeyS','ArrowDown'],''],
  ['EditorMoveLeft',15,'editor','Move left',['KeyA','ArrowLeft'],''],
  ['EditorRotateViewUp',16,'editor','Rotate view up',['KeyY',null],''],
  ['EditorRotateViewDown',17,'editor','Rotate view down',['KeyH',null],''],
  ['EditorRotateViewLeft',18,'editor','Rotate view left',['KeyQ',null],''],
  ['EditorRotateViewRight',19,'editor','Rotate view right',['KeyE',null],''],
  ['EditorMoveDown',20,'editor','Move down',['KeyZ',null],''],
  ['EditorMoveUp',21,'editor','Move up',['KeyC',null],''],
  ['EditorTest',22,'editor','Test track',['KeyT',null],'Drive the track you are editing.'],
  ['EditorPick',23,'editor','Pick part',['KeyG',null],''],
  ['ToggleFpsCounter',24,'driving','Show / hide FPS',['Equal',null],''],
  ['ToggleSpectatorCamera',25,'replay','Spectator camera',['Slash',null],'Toggle the spectator camera.'],
  ['SpectatorMoveForwards',26,'replay','Move forward',['KeyW','ArrowUp'],'With the spectator camera active.'],
  ['SpectatorMoveRight',27,'replay','Move right',['KeyD','ArrowRight'],''],
  ['SpectatorMoveBackwards',28,'replay','Move backward',['KeyS','ArrowDown'],''],
  ['SpectatorMoveLeft',29,'replay','Move left',['KeyA','ArrowLeft'],''],
  ['SpectatorMoveUp',30,'replay','Move up',['KeyZ',null],'Spectator uses Z for up; editor uses C.'],
  ['SpectatorMoveDown',31,'replay','Move down',['KeyC',null],''],
  ['SpectatorSpeedModifier',32,'replay','Speed modifier',['ShiftLeft','ShiftRight'],'Hold while moving the spectator camera.'],
  ['PreviewStepForward',33,'replay','Step preview forward',['Period',null],'In replay preview.'],
  ['PreviewStepBack',34,'replay','Step preview backward',['Comma',null],'In replay preview.']
];

export const HELP_BINDING_IDS = Object.freeze(Object.fromEntries(nativeRows.map(([name,id])=>[name,id])));

/** Read only the native binding store. Bad rows are ignored; a null pair stays unbound.
 * Bounds cover 35 native actions with room for duplicates, without scanning other storage.
 */
export function readHelpBindings(storage) {
  try {
    const raw=storage?.getItem?.('polytrack_v5_prod_key_bindings');
    if(typeof raw!=='string'||raw.length>65536)return {};
    const tuples=JSON.parse(raw);
    if(!Array.isArray(tuples)||tuples.length>256)return {};
    const bindings={};
    for(const tuple of tuples) {
      if(!Array.isArray(tuple)||tuple.length!==2||typeof tuple[0]!=='string'||!Object.hasOwn(HELP_BINDING_IDS,tuple[0]))continue;
      const pair=tuple[1];
      if(!Array.isArray(pair)||pair.length!==2||!pair.every(key=>key===null||typeof key==='string'))continue;
      bindings[tuple[0]]=[...pair];
    }
    return bindings;
  }catch{return {};}
}
const escape = value => String(value ?? '').replace(/[&<>"']/g, char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const keyNames = {ArrowUp:'Up',ArrowDown:'Down',ArrowLeft:'Left',ArrowRight:'Right',Space:'Space',Equal:'=',Minus:'-',Slash:'/',Period:'.',Comma:',',ShiftLeft:'Left Shift',ShiftRight:'Right Shift',ControlLeft:'Left Ctrl',ControlRight:'Right Ctrl',AltLeft:'Left Alt',AltRight:'Right Alt',MetaLeft:'Left Meta',MetaRight:'Right Meta',Backquote:'`',BracketLeft:'[',BracketRight:']',Backslash:'\\',Semicolon:';',Quote:"'",Escape:'Esc'};
const keyLabel = code => keyNames[code] || (/^Key[A-Z]$/.test(code)?code.slice(3):/^Digit\d$/.test(code)?code.slice(5):/^Numpad/.test(code)?code.replace(/^Numpad/,'Num '):String(code));
const row = (id,title,keys,description='',extra={}) => ({id,title,keys,description,...extra});

/** bindings: object/Map keyed by native action name or numeric ID. Own [] / null means unbound.
 * getBindings(name,id) may return a current binding array, or undefined for defaults.
 * No game settings are read here. Re-render when bindings change.
 */
export function createHelpControlGroups({bindings,getBindings,ghostShortcut='G',initialGroup=null}={}) {
  const groups = [
    {id:'driving',title:'Driving',note:'During a race.',open:true,rows:[]},
    {id:'menus',title:'Main menu',note:'From the main menu, outside text fields.',rows:[
      row('menu-play','Play',[['P'],['Space']]),row('menu-rankings','Rankings',[['R']]),
      row('menu-garage','Garage',[['G']]),row('menu-settings','Settings',[['S']]),
      row('menu-multiplayer','Multiplayer',[['M']]),row('menu-editor','Track editor',[['E']]),
      row('menu-community','Community',[['C']]),row('menu-help','Help',[['H']]),
      row('menu-number','Open menu button',[['1-9']],'The number follows the visible button order.')
    ]},
    {id:'rankings',title:'Rankings & pages',note:'All ranked boards and archives. Outside text fields.',rows:[
      row('page-previous','Previous page',[['Left'],['A']]),
      row('page-next','Next page',[['Right'],['D']]),
      row('page-jump','Go to page 1-10',[['Shift','1-9, 0']],'0 = page 10.',{aliases:['Overall normal track Event archive pages']}),
      row('page-offset','Jump forward / back',[['Shift','+ / -'],['1-9, 0']],'Hold Shift. Press + or -, then a number. 0 = 10.',{sequence:true,aliases:['Overall normal track Event archive pages']}),
      row('overall-search','Find a racer / filter Overall',[['Ctrl','F']],'Search across all loaded pages in Overall. Combine a name with >3.19 (selected ranking), playtime:>42h or rank:<=10.',{aliases:['score rp rank playtime tracks wins weight players pbs official community average podium h m s d w']}),
      row('page-field','Type a page',[['Enter']],'Enter a page number in the page field, then confirm.'),
      row('quick-ranking','Quick Ranking',[['1-4']],'Open that saved Quick Ranking in Ranked.'),
      row('filters-toggle','Pause / resume filters',[['Right-click']],'On the Ranked Filters button.'),
      row('category-move','Move through categories',[['Up'],['Down'],['Home'],['End']],'While the ranking-category menu is open.'),
      row('category-select','Choose / close category',[['Enter'],['Esc']],'Enter selects; Escape closes the category menu.')
    ]},
    {id:'tracks',title:'Track browsing',note:'In track selection or Extra Tracks.',rows:[
      row('track-tabs','Switch track tab',[['Left'],['Right']],'Cycle Official, Community and Custom.'),
      row('track-tab-direct','Official / Community / Custom',[['Shift','1'],['Shift','2'],['Shift','3']],'Shift + 1 = Official; Shift + 2 = Community; Shift + 3 = Custom. Use the top-row number keys.'),
      row('summer-track','Open Summer track',[['1-9'],['0']],'Official tracks only. 0 opens Summer 10, when present.'),
      row('season-track','Choose a season track',[['S'],['W'],['D']],'Official tracks only. Summer / Winter / Desert, then 1-9 or 0 within 1.5 seconds.'),
      row('extra-rate','Rate an Extra Track',[['1-9'],['0']],'Open its review menu. 0 = 10. Focus Difficulty to rate difficulty.'),
      row('extra-search','Apply Extra Tracks search',[['Enter']],'While the search field is focused.')
    ]},
    {id:'ghosts',title:'Ghosts & track boards',note:'On a normal track leaderboard, not an Event board.',rows:[
      row('ghost-group','Saved ghost group',ghostShortcut?[String(ghostShortcut).split('+').map(keyLabel)]:[],'Choose the shortcut and group in Filters > Ghost shortcut.',{custom:ghostShortcut!=='G'&&ghostShortcut!=='KeyG'}),
      row('ghost-row','Toggle a ghost',[['1-9'],['0']],'Without Shift: select a visible racer, not a page. 0 = row 10. Clicking works too.'),
      row('ghost-range','Select a range',[['Two numbers']],'Hold two row numbers together; both ends are included.'),
      row('ghost-top','Select leading racers',[['T'],['1-9, 0']],'Hold T with a number, or press T then the number within 2.5 seconds. 0 = ten racers.',{sequence:true}),
      row('ghost-clear','Clear selections',[['C']]),
      row('ghost-leading','Leaders + your ghost',[['='],['Backspace']],'Select leading racers and your ghost when visible. = can fill the tenth slot.'),
      row('ghost-ahead','Racer ahead',[['-']],'Toggle the visible racer immediately above you.'),
      row('ghost-play','Play track',[['Enter'],['Space']],'Space plays when a racer is focused. Enter toggles the focused racer; other buttons keep their own action.')
    ]},
    {id:'events',title:'Event ghosts',note:'Available Event replays only. Shared navigation is in Rankings & pages.',rows:[
      row('event-ghost-row','Toggle Event ghost',[['1-9'],['0']],'Without Shift: select a visible Event racer. 0 = row 10. Clicking works too.'),
      row('event-ghost-range','Select Event ghost range',[['Two numbers']],'Hold two row numbers together; both ends are included.'),
      row('event-ghost-top','Select leading Event ghosts',[['T'],['1-9, 0']],'Hold T with a number, or press T then the number within 2.5 seconds. 0 = ten racers.',{sequence:true}),
      row('event-ghost-clear','Clear Event ghosts',[['C']],'Clear selected and pending Event ghosts.'),
      row('event-ghost-you','Event leaders + your ghost',[['='],['Backspace']],'Top nine + your Event ghost; otherwise top ten.'),
      row('event-ghost-ahead','Event racer ahead',[['-']],'Toggle the racer immediately above your Event PB.'),
      row('event-play','Play Event track',[['Enter'],['Space']],'Space plays when a racer is focused. Enter toggles the focused racer; other buttons keep their own action.')
    ]},
    {id:'replay',title:'Replay & spectator',note:'Spectator movement requires the spectator camera. Keys are remappable.',rows:[]},
    {id:'editor',title:'Track editor',note:'While editing a track. Keys are remappable.',rows:[]},
    {id:'access',title:'Menus & touch',note:'Use the controls on the screen you have open.',rows:[
      row('help-search','Search this Help',[['Ctrl','F']],'While Help is open, focus its control search instead of searching racers.'),
      row('focus-next','Move focus',[['Tab'],['Shift','Tab']],'Tab moves forward; Shift + Tab moves backward.'),
      row('focus-activate','Activate focused button',[['Enter'],['Space']]),
      row('dialog-close','Close / go back',[['Esc']],'Close the top dialog or return from a menu.'),
      row('touch-drive','Touch driving',[['On-screen buttons']],'Use the displayed driving buttons; adjust touch controls in Settings.'),
      row('change-bindings','Change game keys',[['Settings','Controls']],'Custom bindings replace the driving, replay and editor defaults.',{sequence:true})
    ]}
  ];
  for(const [action,id,group,title,defaults,description] of nativeRows) {
    let supplied = getBindings?.(action,id);
    if(supplied===undefined&&bindings instanceof Map) supplied=bindings.has(action)?bindings.get(action):bindings.get(id);
    else if(supplied===undefined&&bindings&&typeof bindings==='object') supplied=Object.hasOwn(bindings,action)?bindings[action]:Object.hasOwn(bindings,id)?bindings[id]:undefined;
    const current=supplied===undefined?defaults:supplied;
    const codes=(Array.isArray(current)?current:current==null?[]:[current]).filter(code=>typeof code==='string'&&code.length);
    const keys=[...new Set(codes)].map(code=>[keyLabel(code)]);
    const custom=supplied!==undefined&&JSON.stringify(codes)!==JSON.stringify(defaults.filter(Boolean));
    groups.find(item=>item.id===group).rows.push(row(action,title,keys,description,{binding:action,bindingId:id,custom,defaultBinding:supplied===undefined,aliases:codes}));
  }
  const initial=groups.findIndex(group=>group.id===initialGroup);
  if(initial>=0){for(const group of groups)group.open=group.id===initialGroup;groups.unshift(...groups.splice(initial,1));}
  return groups;
}

const normalize = value => String(value??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
const searchable = (group,item) => normalize([group.title,group.note,item.title,item.description,item.binding,...item.keys.flat(),...(item.aliases||[])].join(' '));

/** All query words must match a row's keys, action or screen context. No regex or HTML. */
export function searchHelpControls(groups,query='',groupId='all') {
  const tokens=normalize(query).split(' ').filter(Boolean);
  return groups.filter(group=>groupId==='all'||group.id===groupId).map(group=>({...group,rows:group.rows.filter(item=>tokens.every(token=>searchable(group,item).includes(token)))})).filter(group=>group.rows.length);
}

export function helpKeyMatches(label,event) {
  const code=String(event.code||''),key=String(event.key||'');
  const shown=keyLabel(code),digit=/^(?:Digit|Numpad)(\d)$/.exec(code)?.[1];
  if(label==='+ / -')return ['Equal','Minus','NumpadAdd','NumpadSubtract'].includes(code)||['+','-','_'].includes(key);
  const range=/^([1-9])-([1-9])(?:, 0)?$/.exec(label);
  if(range&&digit)return Number(digit)>=Number(range[1])&&Number(digit)<=Number(range[2])||digit==='0'&&label.endsWith(', 0');
  if(['Shift','Ctrl','Alt','Meta'].includes(label))return key===(label==='Ctrl'?'Control':label);
  return label===shown||! /^[A-Za-z0-9]$/.test(label)&&label===key||label==='Esc'&&key==='Escape';
}

function keycaps(item) {
  if(!item.keys.length)return '<span class="hc-unbound">Not bound</span>';
  return item.keys.map(chord=>`<span class="hc-chord">${chord.map(key=>`<kbd data-hc-key="${escape(key)}">${escape(key)}</kbd>`).join('<span class="hc-plus" aria-hidden="true">+</span><span class="hc-sr-only"> plus </span>')}</span>`).join(`<span class="hc-key-separator">${item.sequence?'then':'or'}</span>`);
}

let serial=0;
/** HTML fragment, not a modal. The host owns opening, closing and its focus trap.
 * release: {number,version,revision,preparedAt,commit,commitConfirmed,notes:string[]}. Use RELEASE_INFO from release-info.mjs.
 * installedCommit + verifiedReleasePointer/verifiedSiteCommitMetadata follow releaseUpdateAge's trust contract.
 * verifiedReleaseCommitAt must come explicitly from the parent's local RELEASE_INFO import.
 * Existing data-help-action hooks: profile, filters, ghost-shortcut. No callback or network needed.
 */
export function renderHelpControls(options={}) {
  const prefix=String(options.idPrefix||'pt-help-'+(++serial)).replace(/[^a-zA-Z0-9_-]/g,'-');
  const groups=createHelpControlGroups(options),total=groups.reduce((sum,group)=>sum+group.rows.length,0);
  const release=options.release||{};
  const metadata=[['Game version',release.version],['Client revision',release.revision],['Commit',release.commitConfirmed===true&&/^[a-f0-9]{7,40}$/i.test(String(release.commit||''))?release.commit:null]].filter(([,value])=>value!==undefined&&value!==null&&String(value).trim()!=='');
  const notes=(Array.isArray(release.notes)?release.notes:[]).slice(0,8).filter(note=>typeof note==='string'&&note.slice(0,1024).trim()).slice(0,4).map(note=>{
    const compact=note.slice(0,1024).trim().replace(/\s+/g,' ');
    return compact.length>220?compact.slice(0,217).trimEnd()+'...':compact;
  });
  const hasRelease=release.number!==undefined||metadata.length>0||notes.length>0;
  const prepared=parseReleasePreparedAt(release.preparedAt);
  if(options.installedReleaseCommittedAt!==undefined)options={...options,verifiedReleaseCommitAt:options.installedReleaseCommittedAt};
  const age=releaseUpdateAge(release,{...options,document:options.document||globalThis.document});
  const ageCommit=/^[a-f0-9]{40}$/.test(options.installedCommit||'')?options.installedCommit:'';
  const preparedLabel=prepared===null?'Not recorded':new Date(prepared).toLocaleString(undefined,{year:'numeric',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  return `<section class="pt-help-controls" data-help-controls aria-labelledby="${prefix}-title">
    <header class="hc-header"><h2 id="${prefix}-title">Help &amp; controls</h2>${hasRelease?`<div class="hc-view-switch" role="group" aria-label="Help view"><button type="button" data-hc-view="controls" aria-pressed="true" aria-controls="${prefix}-controls">Controls</button><button type="button" data-hc-view="release" aria-pressed="false" aria-controls="${prefix}-release">Release</button></div>`:''}</header>
    <div id="${prefix}-controls" data-hc-panel="controls">
      <div class="hc-toolbar"><div class="hc-search"><label for="${prefix}-search">Find a control</label><div class="hc-search-field"><span class="hc-search-icon" aria-hidden="true"></span><input id="${prefix}-search" type="search" data-hc-search placeholder="Action, key or screen" autocomplete="off" spellcheck="false" aria-controls="${prefix}-results" aria-describedby="${prefix}-hint"><button type="button" data-hc-clear aria-label="Clear control search">Clear</button></div><p id="${prefix}-hint">Keys light up outside text fields. Remap in Settings &gt; Controls.</p></div>
      <div class="hc-topic-picker"><label for="${prefix}-topic">Topic</label><select id="${prefix}-topic" data-hc-topic-select aria-controls="${prefix}-results"><option value="all">All controls</option>${groups.map(group=>`<option value="${escape(group.id)}">${escape(group.title)}</option>`).join('')}</select></div></div>
      <div class="hc-layout">
      <div class="hc-results" id="${prefix}-results"><div class="hc-results-head hc-sr-only"><h3 data-hc-results-title>All controls</h3><p role="status" aria-live="polite" aria-atomic="true" data-hc-status>${total} controls</p></div><div class="hc-empty" data-hc-empty hidden><h3>No matching controls</h3><p>Try an action, key or screen name.</p><button type="button" data-hc-reset>Show all controls</button></div>
      ${groups.map(group=>`<details class="hc-group" data-hc-group="${escape(group.id)}"${group.open?' open':''}><summary><span class="hc-summary-copy"><strong>${escape(group.title)}</strong><small>${escape(group.note)}</small></span><span class="hc-count" data-hc-group-count>${group.rows.length}</span><span class="hc-chevron" aria-hidden="true"></span></summary><dl>${group.rows.map(item=>`<div class="hc-row" data-hc-row="${escape(item.id)}" data-hc-search-text="${escape(searchable(group,item))}"><dt><span>${escape(item.title)}</span>${item.custom?'<span class="hc-custom">Custom</span>':''}${item.description?`<small>${escape(item.description)}</small>`:''}${item.id==='overall-search'?'<details class="hc-query-guide"><summary>More filters</summary><p>Fields: score/rp, rank, playtime, tracks, wins, weight, players, pbs, official, community, average, podium.</p><p>Playtime defaults to hours; h/m/s/d/w supported. Missing data is excluded.</p></details>':''}</dt><dd class="hc-keycaps">${keycaps(item)}</dd></div>`).join('')}</dl>${group.id==='ghosts'?'<div class="hc-group-footer"><button type="button" data-help-action="ghost-shortcut">Set up your ghost shortcut <span aria-hidden="true">&gt;</span></button></div>':''}</details>`).join('')}
      <p class="hc-default-note">${options.bindings||options.getBindings?'Your saved game keys are shown. Unchanged actions use defaults.':'Default game keys shown. Custom bindings take priority.'}</p></div></div>
      <details class="hc-essentials"><summary><strong>Ranked essentials</strong><span>Scores, profiles &amp; filters</span><span class="hc-chevron" aria-hidden="true"></span></summary><div class="hc-briefing"><section><h3>Know your score</h3><p>Lower Overall RP is better. Higher Event and Casual RP is better. A checkmark marks a verified replay.</p></section><section><h3>Find your next improvement</h3><p>Your profile combines saved results and local practice.</p><button type="button" data-help-action="profile">Your profile <span aria-hidden="true">&gt;</span></button></section><section><h3>Choose your field</h3><p>Normal filters choose which racers appear. Smart scoring recalculates supported group rankings, not lifetime Event RP.</p><button type="button" data-help-action="filters">Open Filters <span aria-hidden="true">&gt;</span></button></section></div></details>
    </div>
    ${hasRelease?`<section class="hc-release" id="${prefix}-release" data-hc-panel="release" aria-labelledby="${prefix}-release-title" hidden><h3 id="${prefix}-release-title">${release.number===undefined?'Current Release':'PolyTrack Ranked - Update '+escape(release.number)}</h3><section class="hc-release-age" aria-label="Release age"><p class="hc-eyebrow">${escape((age.label||'Publication time').toUpperCase())}</p><p class="hc-age-value" data-hc-release-age data-release-at="${escape(age.dateTime)}" data-release-source="${escape(age.source)}" data-release-commit="${ageCommit}" data-release-fixed="${options.verifiedReleaseCommitAt!==undefined}" title="${escape(age.title)}">${escape(age.label&&age.text.startsWith(age.label+' ')?age.text.slice(age.label.length+1):age.text)}</p></section>${notes.length?`<h4>What changed</h4><ul>${notes.map(note=>`<li>${escape(note)}</li>`).join('')}</ul>`:''}<p class="hc-release-note">Hover over the age for your local date and time.</p>${metadata.length?`<details class="hc-release-technical"><summary>Developer details</summary><dl class="hc-release-meta">${metadata.map(([label,value])=>`<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl><p>Prepared ${escape(preparedLabel)}. This is not a deployment timestamp.</p></details>`:''}</section>`:''}
    <footer class="hc-credits"><p>Track ratings &amp; difficulty gradings: <strong>Window Cleaner</strong>.</p></footer>
  </section>`;
}

const bindingsByRoot=new WeakMap();
const keyboardGuards=new WeakMap();
function guardHelpKeyboard(doc, binding) {
  let state=keyboardGuards.get(doc);
  if(!state){
    const view=doc.defaultView,bindings=new Set(),held=new Set();
    const current=event=>[...bindings].reverse().find(item=>item.accepts(event));
    const disposeIfIdle=()=>{
      if(bindings.size||held.size)return;
      view.removeEventListener('keydown',down,true);view.removeEventListener('keyup',up,true);view.removeEventListener('blur',blur);
      keyboardGuards.delete(doc);
    };
    const down=event=>{
      const item=current(event);if(!item)return;
      held.add(event.code||event.key);
      item.down(event);
      // Help processes its own keys before shielding earlier document/native handlers.
      // Escape and Tab must still reach the parent's close/focus-trap boundary.
      if(event.cancelBubble||!['Escape','Tab'].includes(event.key))event.stopImmediatePropagation();
    };
    const up=event=>{
      const suppress=Boolean(current(event))||held.has(event.code||event.key);
      for(const item of bindings)item.up(event);
      held.delete(event.code||event.key);
      if(suppress)event.stopImmediatePropagation();
      disposeIfIdle();
    };
    const blur=()=>{held.clear();for(const item of bindings)item.blur();disposeIfIdle();};
    state={bindings,disposeIfIdle};keyboardGuards.set(doc,state);
    view.addEventListener('keydown',down,true);view.addEventListener('keyup',up,true);view.addEventListener('blur',blur);
  }
  state.bindings.add(binding);
  return ()=>{state.bindings.delete(binding);state.disposeIfIdle();};
}
/** Bind a rendered fragment (or its host). Returns an idempotent cleanup function.
 * Uses local DOM events; key highlights never dispatch gameplay actions or fetch data.
 */
export function bindHelpControls(root) {
  const host=root?.matches?.('[data-help-controls]')?root:root?.querySelector?.('[data-help-controls]');
  if(!host)return ()=>{};
  bindingsByRoot.get(host)?.();
  const input=host.querySelector('[data-hc-search]'),status=host.querySelector('[data-hc-status]');
  const title=host.querySelector('[data-hc-results-title]'),empty=host.querySelector('[data-hc-empty]');
  const topicSelect=host.querySelector('[data-hc-topic-select]'),views=[...host.querySelectorAll('[data-hc-view]')];
  const viewSwitch=views[0]?.parentElement;
  const groups=[...host.querySelectorAll('[data-hc-group]')].map(node=>({node,rows:[...node.querySelectorAll('[data-hc-row]')],count:node.querySelector('[data-hc-group-count]')}));
  let topic='all',snapshot=null,active=true;
  const keyScope=host.closest('[role="dialog"]')||host,doc=host.ownerDocument,view=doc.defaultView;
  const ageNode=host.querySelector('[data-hc-release-age]');
  let ageTimer=null,ageSuspended=false;
  function updateAge(){
    if(ageTimer!==null)view.clearTimeout(ageTimer);ageTimer=null;
    if(!active||ageSuspended||!ageNode||!host.isConnected||!host.getClientRects().length)return;
    // The renderer selected this public timestamp from already-verified context.
    const publication=ageNode.dataset.releaseFixed==='true'?null:releaseUpdateAge({},{document:doc,installedCommit:ageNode.dataset.releaseCommit||undefined});
    const age=publication?.source==='updated'?publication:formatReleaseUpdateAge(ageNode.dataset.releaseAt,ageNode.dataset.releaseSource);
    ageNode.textContent=age.label&&age.text.startsWith(age.label+' ')?age.text.slice(age.label.length+1):age.text;
    ageNode.title=age.title;
    ageNode.closest('.hc-release-age').querySelector('.hc-eyebrow').textContent=(age.label||'Publication time').toUpperCase();
    if(!doc.hidden&&!ageNode.closest('[hidden]')&&age.nextUpdateMs!==null)ageTimer=view.setTimeout(updateAge,age.nextUpdateMs);
  }
  function visibilityChanged(){releaseKeys();updateAge();}
  function suspendAge(){ageSuspended=true;if(ageTimer!==null)view.clearTimeout(ageTimer);ageTimer=null;}
  function resumeAge(){ageSuspended=false;updateAge();}
  const pressed=new Map();
  const releaseKeys=()=>{for(const caps of pressed.values())for(const cap of caps)cap.classList.remove('is-pressed');pressed.clear();};
  function showKey(event){
    if(!active||!host.getClientRects().length||event.isComposing||event.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))return;
    const dialog=event.target.closest?.('[role="dialog"],dialog');
    if(dialog&&dialog!==keyScope)return;
    const id=event.code||event.key;if(pressed.has(id))return;
    const caps=[...host.querySelectorAll('[data-hc-key]')].filter(cap=>cap.getClientRects().length&&helpKeyMatches(cap.dataset.hcKey,event));
    for(const cap of caps)cap.classList.add('is-pressed');
    if(caps.length)pressed.set(id,caps);
  }
  function hideKey(event){const id=event.code||event.key,caps=pressed.get(id)||[];pressed.delete(id);for(const cap of caps)if(![...pressed.values()].some(other=>other.includes(cap)))cap.classList.remove('is-pressed');}
  function leaveScope(event){if(!keyScope.contains(event.relatedTarget))releaseKeys();}
  function filter() {
    releaseKeys();
    const tokens=normalize(input.value).split(' ').filter(Boolean),filtering=tokens.length>0||topic!=='all';
    if(filtering&&!snapshot)snapshot=new Map(groups.map(({node})=>[node,node.open]));
    let count=0;
    for(const group of groups) {
      let visible=0;
      for(const item of group.rows) {
        item.hidden=!(topic==='all'||group.node.dataset.hcGroup===topic)||!tokens.every(token=>item.dataset.hcSearchText.includes(token));
        if(!item.hidden)visible++;
      }
      group.node.hidden=visible===0;group.count.textContent=String(visible);count+=visible;
      if(filtering)group.node.open=visible>0;
      else if(snapshot)group.node.open=snapshot.get(group.node);
    }
    if(!filtering)snapshot=null;
    empty.hidden=count>0;
    status.textContent=count+' '+(count===1?'control':'controls')+(tokens.length?' found':'');
    title.parentElement.classList.toggle('hc-sr-only',!filtering);
    topicSelect.value=topic;
    title.textContent=topicSelect.selectedOptions[0]?.textContent||'All controls';
    host.querySelector('[data-hc-clear]').disabled=!input.value;
  }
  function showView(name) {
    releaseKeys();
    for(const panel of host.querySelectorAll('[data-hc-panel]'))panel.hidden=panel.dataset.hcPanel!==name;
    for(const toggle of views)toggle.setAttribute('aria-pressed',String(toggle.dataset.hcView===name));
    updateAge();
  }
  function click(event) {
    const button=event.target.closest?.('button');
    if(!button||!host.contains(button)&&!views.includes(button))return;
    if(button.hasAttribute('data-hc-clear')){input.value='';filter();input.focus();}
    else if(button.hasAttribute('data-hc-reset')){topic='all';input.value='';filter();input.focus();}
    else if(button.hasAttribute('data-hc-view'))showView(button.dataset.hcView);
  }
  function keydown(event) {
    // The host still owns Escape-to-close and the modal Tab loop. Never prevent text input.
    if(!event.isComposing&&!event.altKey&&!event.shiftKey&&(event.ctrlKey||event.metaKey)&&(event.code==='KeyF'||event.key.toLowerCase()==='f')) {
      showView('controls');input.focus();input.select();event.preventDefault();event.stopPropagation();return;
    }
    if(event.key==='Escape') {
      if(event.target===input&&input.value){input.value='';filter();event.preventDefault();event.stopPropagation();}
      return;
    }
    if(!event.ctrlKey&&!event.metaKey&&!event.altKey&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) {
      const list=views.includes(event.target)?views:null;
      if(list){
        const index=list.indexOf(event.target),next=event.key==='Home'?0:event.key==='End'?list.length-1:(index+(['ArrowLeft','ArrowUp'].includes(event.key)?list.length-1:1))%list.length;
        list[next].focus();event.preventDefault();
      }
    }
    // Bubble through the outer modal trap on Tab; contain gameplay shortcuts otherwise.
    if(event.key!=='Tab')event.stopPropagation();
  }
  const stopKeyboard=guardHelpKeyboard(doc,{
    accepts:event=>{
      if(!active||!host.getClientRects().length)return false;
      const dialog=event.target.closest?.('[role="dialog"],dialog');
      return !dialog||dialog===keyScope;
    },
    down:event=>{showKey(event);keydown(event);},up:hideKey,blur:releaseKeys
  });
  keyScope.addEventListener('focusout',leaveScope);view?.addEventListener('blur',releaseKeys);
  doc.addEventListener('visibilitychange',visibilityChanged);view?.addEventListener('focus',updateAge);
  doc.addEventListener('polytrack-release-publication',updateAge);
  view?.addEventListener('pagehide',suspendAge);view?.addEventListener('pageshow',resumeAge);
  const selectTopic=()=>{topic=topicSelect.value;filter();};
  topicSelect.addEventListener('change',selectTopic);
  const searchInput=event=>{if(event.target===input)filter();};
  const detachedViewClick=event=>{if(!host.contains(viewSwitch))click(event);};
  host.addEventListener('input',searchInput);host.addEventListener('click',click);
  viewSwitch?.addEventListener('click',detachedViewClick);
  filter();updateAge();
  const cleanup=()=>{
    if(!active)return;active=false;releaseKeys();
    stopKeyboard();keyScope.removeEventListener('focusout',leaveScope);view?.removeEventListener('blur',releaseKeys);
    doc.removeEventListener('visibilitychange',visibilityChanged);view?.removeEventListener('focus',updateAge);
    doc.removeEventListener('polytrack-release-publication',updateAge);
    view?.removeEventListener('pagehide',suspendAge);view?.removeEventListener('pageshow',resumeAge);
    topicSelect.removeEventListener('change',selectTopic);
    if(ageTimer!==null)view.clearTimeout(ageTimer);ageTimer=null;
    host.removeEventListener('input',searchInput);host.removeEventListener('click',click);
    viewSwitch?.removeEventListener('click',detachedViewClick);
    if(bindingsByRoot.get(host)===cleanup)bindingsByRoot.delete(host);
  };
  bindingsByRoot.set(host,cleanup);return cleanup;
}
