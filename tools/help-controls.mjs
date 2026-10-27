// Native action names and IDs mirror main.bundle.js: defaultKeyBindings / module 3277.
const nativeRows = [
  ['VehicleAccelerate',0,'driving','Accelerate',['KeyW','ArrowUp'],'Build speed.'],
  ['VehicleTurnRight',1,'driving','Steer right',['KeyD','ArrowRight'],''],
  ['VehicleBrake',2,'driving','Brake / reverse',['KeyS','ArrowDown'],'Slow down; reverse when stopped.'],
  ['VehicleTurnLeft',3,'driving','Steer left',['KeyA','ArrowLeft'],''],
  ['VehicleCheckpointReset',4,'driving','Reset to checkpoint',['KeyR','Enter'],'Return to the last checkpoint.'],
  ['VehicleStartReset',5,'driving','Restart track',['KeyT','Backspace'],'Start a new attempt from the beginning.'],
  ['VehicleCockpitCamera',6,'driving','Cockpit camera',['KeyC','KeyM'],'Switch the driving camera.'],
  ['ToggleUI',7,'driving','Race UI',['KeyH',null],'Show or hide the race interface.'],
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
  ['ToggleFpsCounter',24,'driving','FPS counter',['Equal',null],'Show or hide frame-rate information.'],
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
export function createHelpControlGroups({bindings,getBindings,ghostShortcut='G'}={}) {
  const groups = [
    {id:'driving',title:'Driving',note:'In a race. Remappable in Settings > Controls.',open:true,rows:[]},
    {id:'menus',title:'Main menu',note:'From the main menu, outside text fields.',rows:[
      row('menu-play','Play',[['P'],['Space']]),row('menu-rankings','Rankings',[['R']]),
      row('menu-garage','Garage',[['G']]),row('menu-settings','Settings',[['S']]),
      row('menu-multiplayer','Multiplayer',[['M']]),row('menu-editor','Track editor',[['E']]),
      row('menu-community','Community',[['C']]),row('menu-help','Help',[['H']]),
      row('menu-number','Open menu button',[['1-9']],'The number follows the visible button order.')
    ]},
    {id:'rankings',title:'Rankings & pages',note:'On the open ranking, board or archive.',rows:[
      row('quick-ranking','Quick Ranking',[['1-4']],'Open that saved Quick Ranking in Ranked.'),
      row('page-previous','Previous page',[['Left'],['A']],'Rankings, track boards, Extra Tracks and archives.'),
      row('page-next','Next page',[['Right'],['D']],'Rankings, track boards, Extra Tracks and archives.'),
      row('page-jump','Go to page',[['Shift','1-9, 0']],'0 means page 10.'),
      row('page-offset','Move by several pages',[['Shift','+'],['Shift','-']],'Ranked only. Hold Shift, press + or -, then a number. 0 = ten pages.'),
      row('page-field','Type a page',[['Enter']],'Enter a page number in the page field, then confirm.'),
      row('filters-toggle','Pause / resume filters',[['Right-click']],'On the Ranked Filters button.'),
      row('category-move','Move through categories',[['Up'],['Down'],['Home'],['End']],'While the ranking-category menu is open.'),
      row('category-select','Choose / close category',[['Enter'],['Esc']],'Enter selects; Escape closes the category menu.')
    ]},
    {id:'tracks',title:'Track browsing',note:'In track selection or Extra Tracks.',rows:[
      row('track-tabs','Switch track tab',[['Left'],['Right']],'Cycle Official, Community and Custom.'),
      row('track-tab-direct','Open a track tab',[['Shift','1-3']],'1 = Official; 2 = Community; 3 = Custom.'),
      row('summer-track','Open Summer track',[['1-9'],['0']],'Official tracks only. 0 opens Summer 10, when present.'),
      row('season-track','Choose a season track',[['S'],['W'],['D']],'Official tracks only. Summer / Winter / Desert, then 1-9 or 0 within 1.5 seconds.'),
      row('extra-rate','Rate an Extra Track',[['1-9'],['0']],'Open its review menu. 0 = 10. Focus Difficulty to rate difficulty.'),
      row('extra-search','Apply Extra Tracks search',[['Enter']],'While the search field is focused.')
    ]},
    {id:'ghosts',title:'Ghosts & track boards',note:'On a normal track leaderboard, not an Event board.',rows:[
      row('ghost-group','Saved ghost group',ghostShortcut?[String(ghostShortcut).split('+').map(keyLabel)]:[],'Choose the shortcut and group in Filters > Ghost shortcut.',{custom:ghostShortcut!=='G'&&ghostShortcut!=='KeyG'}),
      row('ghost-row','Toggle a ghost',[['1-9'],['0']],'Select a visible racer row. 0 = row 10. Clicking a racer works too.'),
      row('ghost-range','Select a range',[['Two numbers']],'Hold two row numbers together to select the rows between them.'),
      row('ghost-top','Select leading racers',[['T'],['1-9, 0']],'Hold T or press a number within 2.5 seconds. 0 = ten racers.',{sequence:true}),
      row('ghost-clear','Clear selections',[['C']]),
      row('ghost-leading','Leaders + your ghost',[['='],['Backspace']],'Select leading racers and your ghost when visible. = can fill the tenth slot.'),
      row('ghost-ahead','Racer ahead',[['-']],'Toggle the visible racer immediately above you.'),
      row('ghost-play','Play track',[['Enter'],['Space']],'Outside text fields. A focused button keeps its own action.')
    ]},
    {id:'events',title:'Event ghosts',note:'On an Event track board. Only available Event replays can be selected.',rows:[
      row('event-ghost-row','Toggle Event ghost',[['1-9'],['0']],'Select a visible Event racer. 0 = row 10. Clicking the row works too.'),
      row('event-ghost-range','Select Event ghost range',[['Two numbers']],'Hold two row numbers together to select the rows between them.'),
      row('event-ghost-top','Select leading Event ghosts',[['T'],['1-9, 0']],'Hold T or press a number within 2.5 seconds. 0 = ten racers.',{sequence:true}),
      row('event-ghost-clear','Clear Event ghosts',[['C']],'Clear selected and pending Event ghosts.'),
      row('event-ghost-you','Event leaders + your ghost',[['='],['Backspace']],'Top nine + your Event ghost; otherwise top ten.'),
      row('event-ghost-ahead','Event racer ahead',[['-']],'Toggle the racer immediately above your Event PB.'),
      row('event-page','Go to Event page',[['Shift','1-9, 0']],'0 means page 10.'),
      row('event-page-previous','Previous Event page',[['Left'],['A']]),
      row('event-page-next','Next Event page',[['Right'],['D']]),
      row('event-play','Play Event track',[['Enter'],['Space']],'A focused button keeps its normal action.')
    ]},
    {id:'replay',title:'Replay & spectator',note:'Spectator movement requires the spectator camera. Keys are remappable.',rows:[]},
    {id:'editor',title:'Track editor',note:'While editing a track. Keys are remappable.',rows:[]},
    {id:'access',title:'Menus & touch',note:'Use the controls on the screen you have open.',rows:[
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
  return groups;
}

const normalize = value => String(value??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/\s+/g,' ').trim();
const searchable = (group,item) => normalize([group.title,group.note,item.title,item.description,item.binding,...item.keys.flat(),...(item.aliases||[])].join(' '));

/** All query words must match a row's keys, action or screen context. No regex or HTML. */
export function searchHelpControls(groups,query='',groupId='all') {
  const tokens=normalize(query).split(' ').filter(Boolean);
  return groups.filter(group=>groupId==='all'||group.id===groupId).map(group=>({...group,rows:group.rows.filter(item=>tokens.every(token=>searchable(group,item).includes(token)))})).filter(group=>group.rows.length);
}

function keycaps(item) {
  if(!item.keys.length)return '<span class="hc-unbound">Not bound</span>';
  return item.keys.map(chord=>`<span class="hc-chord">${chord.map(key=>`<kbd>${escape(key)}</kbd>`).join('<span class="hc-plus" aria-hidden="true">+</span><span class="hc-sr-only"> plus </span>')}</span>`).join(`<span class="hc-key-separator">${item.sequence?'then':'or'}</span>`);
}

let serial=0;
/** HTML fragment, not a modal. The host owns opening, closing and its focus trap.
 * release: {version,revision,commit,commitConfirmed,notes:string[]}. Commit is opt-in confirmed metadata.
 * Existing data-help-action hooks: profile, filters, ghost-shortcut. No callback or network needed.
 */
export function renderHelpControls(options={}) {
  const prefix=String(options.idPrefix||'pt-help-'+(++serial)).replace(/[^a-zA-Z0-9_-]/g,'-');
  const groups=createHelpControlGroups(options),total=groups.reduce((sum,group)=>sum+group.rows.length,0);
  const release=options.release||{};
  const metadata=[['Game version',release.version],['Client revision',release.revision],['Commit',release.commitConfirmed===true?release.commit:null]].filter(([,value])=>value!==undefined&&value!==null&&String(value).trim()!=='');
  const notes=Array.isArray(release.notes)?release.notes.filter(note=>typeof note==='string'&&note.trim()):[];
  const hasRelease=metadata.length>0||notes.length>0;
  return `<section class="pt-help-controls" data-help-controls aria-labelledby="${prefix}-title">
    <header class="hc-header"><h2 id="${prefix}-title">Help &amp; controls</h2>${hasRelease?`<div class="hc-view-switch" role="group" aria-label="Help view"><button type="button" data-hc-view="controls" aria-pressed="true" aria-controls="${prefix}-controls">Controls</button><button type="button" data-hc-view="release" aria-pressed="false" aria-controls="${prefix}-release">Release info</button></div>`:''}</header>
    <div id="${prefix}-controls" data-hc-panel="controls">
      <div class="hc-search"><label for="${prefix}-search">Find a control</label><div class="hc-search-field"><span class="hc-search-icon" aria-hidden="true"></span><input id="${prefix}-search" type="search" data-hc-search placeholder="Try checkpoint, ghosts or Shift" autocomplete="off" spellcheck="false" aria-controls="${prefix}-results" aria-describedby="${prefix}-hint"><button type="button" data-hc-clear aria-label="Clear control search">Clear</button></div><p id="${prefix}-hint">Keys apply to the open screen. Game bindings can be changed in Settings &gt; Controls.</p></div>
      <div class="hc-layout"><nav class="hc-topics" aria-label="Control topics"><p class="hc-eyebrow">BROWSE BY SCREEN</p><button type="button" data-hc-topic="all" aria-pressed="true" aria-controls="${prefix}-results"><span>All controls</span><span class="hc-count">${total}</span></button>${groups.map(group=>`<button type="button" data-hc-topic="${escape(group.id)}" aria-pressed="false" aria-controls="${prefix}-results"><span>${escape(group.title)}</span><span class="hc-count">${group.rows.length}</span></button>`).join('')}</nav>
      <div class="hc-results" id="${prefix}-results"><div class="hc-results-head"><h3 data-hc-results-title>All controls</h3><p role="status" aria-live="polite" aria-atomic="true" data-hc-status>${total} controls</p></div><div class="hc-empty" data-hc-empty hidden><h3>No matching controls</h3><p>Try an action, key or screen name.</p><button type="button" data-hc-reset>Show all controls</button></div>
      ${groups.map((group,index)=>`<details class="hc-group" data-hc-group="${escape(group.id)}"${group.open?' open':''}><summary><span class="hc-section-number" aria-hidden="true">${String(index+1).padStart(2,'0')}</span><span class="hc-summary-copy"><strong>${escape(group.title)}</strong><small>${escape(group.note)}</small></span><span class="hc-count" data-hc-group-count>${group.rows.length}</span><span class="hc-chevron" aria-hidden="true"></span></summary><dl>${group.rows.map(item=>`<div class="hc-row" data-hc-row="${escape(item.id)}" data-hc-search-text="${escape(searchable(group,item))}"><dt><span>${escape(item.title)}</span>${item.custom?'<span class="hc-custom">Custom</span>':''}${item.description?`<small>${escape(item.description)}</small>`:''}</dt><dd class="hc-keycaps">${keycaps(item)}</dd></div>`).join('')}</dl>${group.id==='ghosts'?'<div class="hc-group-footer"><button type="button" data-help-action="ghost-shortcut">Set up your ghost shortcut <span aria-hidden="true">&gt;</span></button></div>':''}</details>`).join('')}
      <p class="hc-default-note">${options.bindings||options.getBindings?'Supplied game bindings are shown; any missing actions use their defaults.':'Driving, replay and editor keys shown here are defaults. Your custom game bindings take priority.'}</p></div></div>
      <details class="hc-essentials"><summary><strong>Ranked essentials</strong><span>Scores, profiles &amp; filters</span><span class="hc-chevron" aria-hidden="true"></span></summary><div class="hc-briefing"><section><h3>Know your score</h3><p>Lower Overall RP is better. Higher Event and Casual RP is better. A checkmark marks a verified replay.</p></section><section><h3>Find your next improvement</h3><p>Your profile combines saved results and local practice.</p><button type="button" data-help-action="profile">Your profile <span aria-hidden="true">&gt;</span></button></section><section><h3>Choose your field</h3><p>Normal filters hide racers. Smart filters calculate a separate group score.</p><button type="button" data-help-action="filters">Open Filters <span aria-hidden="true">&gt;</span></button></section></div></details>
    </div>
    ${hasRelease?`<section class="hc-release" id="${prefix}-release" data-hc-panel="release" aria-labelledby="${prefix}-release-title" hidden><p class="hc-eyebrow">BUILD INFORMATION</p><h3 id="${prefix}-release-title">Your current release</h3>${metadata.length?`<dl class="hc-release-meta">${metadata.map(([label,value])=>`<div><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join('')}</dl>`:''}${notes.length?`<h4>In this release</h4><ul>${notes.map(note=>`<li>${escape(note)}</li>`).join('')}</ul>`:''}<p class="hc-release-note">Build details supplied by the game. No online check is performed here.</p></section>`:''}
    <footer class="hc-credits"><p>Track ratings &amp; difficulty gradings: <strong>Window Cleaner</strong>.</p></footer>
  </section>`;
}

const bindingsByRoot=new WeakMap();
/** Bind a rendered fragment (or its host). Returns an idempotent cleanup function.
 * Uses only local DOM events; no document listeners, storage, fetching or game hotkeys.
 */
export function bindHelpControls(root) {
  const host=root?.matches?.('[data-help-controls]')?root:root?.querySelector?.('[data-help-controls]');
  if(!host)return ()=>{};
  bindingsByRoot.get(host)?.();
  const input=host.querySelector('[data-hc-search]'),status=host.querySelector('[data-hc-status]');
  const title=host.querySelector('[data-hc-results-title]'),empty=host.querySelector('[data-hc-empty]');
  const topics=[...host.querySelectorAll('[data-hc-topic]')],views=[...host.querySelectorAll('[data-hc-view]')];
  const groups=[...host.querySelectorAll('[data-hc-group]')].map(node=>({node,rows:[...node.querySelectorAll('[data-hc-row]')],count:node.querySelector('[data-hc-group-count]')}));
  let topic='all',snapshot=null,active=true;
  function filter() {
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
    title.textContent=topics.find(button=>button.dataset.hcTopic===topic)?.querySelector('span')?.textContent||'All controls';
    for(const button of topics)button.setAttribute('aria-pressed',String(button.dataset.hcTopic===topic));
    host.querySelector('[data-hc-clear]').disabled=!input.value;
  }
  function click(event) {
    const button=event.target.closest?.('button');
    if(!button||!host.contains(button))return;
    if(button.hasAttribute('data-hc-clear')){input.value='';filter();input.focus();}
    else if(button.hasAttribute('data-hc-reset')){topic='all';input.value='';filter();input.focus();}
    else if(button.hasAttribute('data-hc-topic')){topic=button.dataset.hcTopic;filter();}
    else if(button.hasAttribute('data-hc-view')) {
      const view=button.dataset.hcView;
      for(const panel of host.querySelectorAll('[data-hc-panel]'))panel.hidden=panel.dataset.hcPanel!==view;
      for(const toggle of views)toggle.setAttribute('aria-pressed',String(toggle===button));
    }
  }
  function keydown(event) {
    // The host still owns Escape-to-close and the modal Tab loop. Never prevent text input.
    if(event.key==='Escape') {
      if(event.target===input&&input.value){input.value='';filter();event.preventDefault();event.stopPropagation();}
      return;
    }
    if(!event.ctrlKey&&!event.metaKey&&!event.altKey&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)) {
      const list=topics.includes(event.target)?topics:views.includes(event.target)?views:null;
      if(list){
        const index=list.indexOf(event.target),next=event.key==='Home'?0:event.key==='End'?list.length-1:(index+(['ArrowLeft','ArrowUp'].includes(event.key)?list.length-1:1))%list.length;
        list[next].focus();event.preventDefault();
      }
    }
    // Bubble through the outer modal trap on Tab; contain gameplay shortcuts otherwise.
    if(event.key!=='Tab')event.stopPropagation();
  }
  host.addEventListener('input',filter);host.addEventListener('click',click);host.addEventListener('keydown',keydown);
  filter();
  const cleanup=()=>{
    if(!active)return;active=false;
    host.removeEventListener('input',filter);host.removeEventListener('click',click);host.removeEventListener('keydown',keydown);
    if(bindingsByRoot.get(host)===cleanup)bindingsByRoot.delete(host);
  };
  bindingsByRoot.set(host,cleanup);return cleanup;
}
