export const OPPONENT_PRESET_KEY='polytrack-opponent-shortcut-v1';
const modes=new Set(['accounts','filters','places','relative','recent','percentile']);
const idOf=row=>String(row?.accountId||row?.userId||row?.publicId||'');
const validId=id=>/^[A-Za-z0-9_.:-]{1,128}$/.test(id);
const timeOf=row=>Number(row?.timeMs??row?.frames??row?.raceTimeFrames??0);
const clamp=(value,min,max,fallback)=>Number.isFinite(Number(value))?Math.min(max,Math.max(min,Number(value))):fallback;
const list=(value,min,max)=>[...new Set((Array.isArray(value)?value:[]).filter(Number.isSafeInteger).filter(n=>n>=min&&n<=max))].slice(0,10);
export function shortcutCode(value){
 return /^(?:Shift\+)?Key[BFGJKLNOQUVXYZ]$/.test(value||'')?value:'';
}
export function normalizeOpponentPreset(value={}){
 return {version:1,enabled:value.enabled!==false,key:shortcutCode(value.key)||'KeyG',
  mode:modes.has(value.mode)?value.mode:'relative',limit:Math.round(clamp(value.limit,1,10,10)),
  accounts:[...new Set((Array.isArray(value.accounts)?value.accounts:[]).filter(validId))].slice(0,10),
  places:list(value.places,1,1000000),relative:list(value.relative,-1000000,1000000).length?list(value.relative,-1000000,1000000):[-2,-1,1,2],
  percentileMin:clamp(value.percentileMin,0,100,0),percentileMax:clamp(value.percentileMax,0,100,10),
  after:Number.isSafeInteger(value.after)&&value.after>0?value.after:0,
  before:Number.isSafeInteger(value.before)&&value.before>0?value.before:0,includeSelf:value.includeSelf===true};
}
export function loadOpponentPreset(storage){try{return normalizeOpponentPreset(JSON.parse(storage?.getItem(OPPONENT_PRESET_KEY)||'{}'));}catch{return normalizeOpponentPreset();}}
export function saveOpponentPreset(storage,value){const preset=normalizeOpponentPreset(value);storage.setItem(OPPONENT_PRESET_KEY,JSON.stringify(preset));return preset;}
export function opponentShortcutMatches(event,preset){return preset.enabled&&shortcutCode(preset.key)===(event.shiftKey?'Shift+':'')+event.code&&!event.repeat&&!event.altKey&&!event.ctrlKey&&!event.metaKey;}
export function opponentShortcutLabel(value){return shortcutCode(value).replace('Key','')||'G';}
export function opponentRunAt(row){
 for(const key of ['pbAt','runAt','createdAt','timestamp']){const n=Number(row?.[key]);if(Number.isSafeInteger(n)&&n>0&&n<=8640000000000000)return n;}
 const upload=Number(row?.uploadId??row?.id);return Number.isSafeInteger(upload)&&upload>=1e14?Math.floor(upload/1000):0;
}
export function opponentRecordingId(row){const n=Number(row?.uploadId??row?.id);return Number.isSafeInteger(n)&&n>0?n:null;}
export function selectOpponentRows(input,value,{selfId='',complete=false,totalEntries,filteredIds=[]}={}){
 const preset=normalizeOpponentPreset(value),seen=new Set();
 const rows=(Array.isArray(input)?input:[]).filter(row=>validId(idOf(row))&&Number.isFinite(timeOf(row))&&timeOf(row)>0)
  .slice().sort((a,b)=>timeOf(a)-timeOf(b))
  .filter(row=>{const id=idOf(row);if(seen.has(id))return false;seen.add(id);return true;});
 const exact=complete===true&&(!Number.isSafeInteger(totalEntries)||totalEntries===rows.length);
 if(['places','relative','percentile'].includes(preset.mode)&&!exact)return {rows:[],reason:'Full saved standings are needed for place-based selection.',missing:0,complete:false};
 // Native placement is row-indexed; stable sorting keeps the supplied tie order.
 const placed=rows.map((row,index)=>({row,rank:index+1}));
 const mine=placed.find(item=>idOf(item.row)===selfId),filtered=new Set(filteredIds);
 if(preset.mode==='relative'&&!mine)return {rows:[],reason:'You need a saved finish on this track to choose nearby racers.',missing:0,complete:exact};
 if(preset.mode==='percentile'&&preset.percentileMin>preset.percentileMax)return {rows:[],reason:'The percentile start must be below the end.',missing:0,complete:exact};
 let chosen=placed.filter(item=>preset.includeSelf||idOf(item.row)!==selfId);
 if(preset.mode==='accounts')chosen=chosen.filter(item=>preset.accounts.includes(idOf(item.row))).sort((a,b)=>preset.accounts.indexOf(idOf(a.row))-preset.accounts.indexOf(idOf(b.row)));
 else if(preset.mode==='filters')chosen=chosen.filter(item=>filtered.has(idOf(item.row)));
 else if(preset.mode==='places')chosen=chosen.filter(item=>preset.places.includes(item.rank));
 else if(preset.mode==='relative'){const wanted=new Set(preset.relative.map(offset=>mine.rank+offset));chosen=chosen.filter(item=>wanted.has(item.rank));}
 else if(preset.mode==='percentile')chosen=chosen.filter(item=>{const percent=rows.length<=1?0:100*(item.rank-1)/(rows.length-1);return percent>=preset.percentileMin&&percent<=preset.percentileMax;});
 else if(preset.mode==='recent')chosen=chosen.filter(item=>opponentRunAt(item.row)>0&&(!preset.after||opponentRunAt(item.row)>=preset.after)&&(!preset.before||opponentRunAt(item.row)<preset.before)).sort((a,b)=>opponentRunAt(b.row)-opponentRunAt(a.row)||a.rank-b.rank);
 const missing=preset.mode==='accounts'?preset.accounts.filter(id=>!rows.some(row=>idOf(row)===id)).length:0;
 const playable=chosen.filter(item=>opponentRecordingId(item.row)!==null).slice(0,preset.limit).map(item=>({...item.row,selectionRank:item.rank}));
 return {rows:playable,missing,complete:exact,reason:playable.length?'':chosen.length?'Matching runs have no saved replay.':'No saved runs match this shortcut.'};
}

export function openOpponentPresetDialog({document=globalThis.document,storage=globalThis.localStorage,getProfiles=()=>[],renderRacer=()=>'',onRenderRacers=()=>{},onRun=null,onSave=()=>{},returnFocus=document.activeElement}={}){
 document.getElementById('polytrackOpponentPresetDialog')?.close();
 const dialog=document.createElement('dialog');dialog.id='polytrackOpponentPresetDialog';dialog.className='sq-opponent-preset';
 dialog.setAttribute('aria-labelledby','sqOpponentTitle');
 dialog.innerHTML='<header><div><small>PERSONAL LEADERBOARD</small><h2 id="sqOpponentTitle">Ghost shortcut</h2></div><button type="button" data-close aria-label="Close ghost shortcut">Close</button></header><main><p class="sq-opponent-intro">Your racing group, one key away. Select up to 10 saved replays on the open track.</p><section class="sq-opponent-card"><h3>1. Set your shortcut</h3><div class="sq-opponent-form"><label>Shortcut key<input data-key readonly aria-label="Press a key for the ghost shortcut"></label><label>Choose by<select data-mode><option value="relative">Around my place</option><option value="accounts">Chosen racers</option><option value="filters">My saved filters</option><option value="places">Exact places</option><option value="recent">Most recent PBs</option><option value="percentile">Percentile range</option></select></label><label>Maximum ghosts<input data-limit type="number" min="1" max="10" inputmode="numeric"></label><label class="sq-opponent-check"><input data-enabled type="checkbox">Enable shortcut</label></div><small>Click the key field and press a letter, optionally with Shift.</small></section><section class="sq-opponent-card" data-fields><h3>2. Choose your ghosts</h3><div data-for="accounts"><label>Find a racer<input data-search aria-controls="sqOpponentResults" aria-describedby="sqOpponentSearchHelp" type="search" placeholder="Search saved racers" autocomplete="off"></label><div class="sq-opponent-picker-heading"><b data-count></b><small>Click a racer to add or remove</small></div><div data-picked aria-label="Selected racers"></div><small id="sqOpponentSearchHelp">Search saved racers by name or public ID. Arrow keys move between results; Enter or Space toggles a racer.</small><div id="sqOpponentResults" data-results class="sq-opponent-results" role="group" aria-label="Racers"></div><p data-results-status role="status" aria-live="polite"></p></div><div data-for="places"><label>Places<input data-places placeholder="1, 3, 5" inputmode="numeric"></label></div><div data-for="relative"><label>Places from me<input data-relative placeholder="-2, -1, 1, 2"></label><small>Negative = ahead. Positive = behind.</small></div><div data-for="recent"><div class="sq-opponent-form"><label>From (local date)<input type="date" data-after></label><label>Through (local date)<input type="date" data-before></label></div><small>Undated runs are skipped.</small></div><div data-for="percentile"><div class="sq-opponent-form"><label>From %<input data-min type="number" min="0" max="100" step="0.1"></label><label>To %<input data-max type="number" min="0" max="100" step="0.1"></label></div><small>0% is first place; 100% is last.</small></div><div data-for="filters"><p>Uses your saved filter rules without changing whether filters are on.</p></div></section><label class="sq-opponent-check"><input data-self type="checkbox">Include my own replay when it matches</label><p role="status" aria-live="polite" data-status></p></main><footer><small>Saved on this device. Filters stay unchanged.</small><div><button type="button" data-save>Save shortcut</button><button type="button" data-run>Save and select now</button></div></footer>';
 if(!document.getElementById('sqOpponentStyle')){const style=document.createElement('style');style.id='sqOpponentStyle';style.textContent="\n.sq-opponent-preset{box-sizing:border-box;width:min(860px,calc(100vw - 24px));max-width:none;max-height:calc(100dvh - 24px);padding:0;margin:auto;overflow:hidden;border:2px solid #5278c2;color:#f5f7ff;background:linear-gradient(145deg,#294277,#101c39 50%,#0d1730);box-shadow:0 24px 90px #0009;font:18px/1.45 ForcedSquare,Arial,sans-serif}\n.sq-opponent-preset[open]{display:flex;flex-direction:column}.sq-opponent-preset::backdrop{background:#040814df}.sq-opponent-preset *{box-sizing:border-box}.sq-opponent-preset [hidden]{display:none!important}\n.sq-opponent-preset header,.sq-opponent-preset footer{flex:none;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:16px 22px;background:#080f227a}.sq-opponent-preset header{border-bottom:1px solid #aac3f440}.sq-opponent-preset h2{margin:0;font-size:32px;line-height:1.2}.sq-opponent-preset h3{margin:0 0 12px;font-size:21px}.sq-opponent-preset header small{font-size:12px;letter-spacing:.14em;color:#86a9f0}.sq-opponent-preset main{min-height:0;overflow:auto;overscroll-behavior:contain;padding:18px 22px;scrollbar-color:#5278c2 #16264b}.sq-opponent-intro{margin:0 0 18px;color:#b9c8e6}.sq-opponent-card{padding:16px;margin-bottom:14px;border:1px solid #87a7e76b;background:linear-gradient(135deg,#253b6cc7,#152448d1)}\n.sq-opponent-form{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.sq-opponent-preset label{display:flex;min-width:0;flex-direction:column;gap:6px;margin:0 0 12px;font-size:16px}.sq-opponent-preset .sq-opponent-check{flex-direction:row;align-items:center;gap:10px}.sq-opponent-preset input:not([type=checkbox]),.sq-opponent-preset select{box-sizing:border-box;width:100%;min-width:0;min-height:44px;background:#0d1934;border:1px solid #5877b4;border-radius:0;color:#fff;padding:9px 11px;font:inherit}.sq-opponent-preset input[type=checkbox]{width:20px;height:20px;accent-color:#54f09a}.sq-opponent-preset input[data-key]{color:#54f09a;font-size:22px;cursor:pointer}.sq-opponent-preset input::placeholder{color:#98a9cc}\n.sq-opponent-preset button{min-height:44px;max-width:100%;padding:9px 14px;border:1px solid #5877b4;border-radius:0;color:#f5f7ff;background:#223b70;font:inherit;cursor:pointer;transform:none}.sq-opponent-preset button:hover{background:#34599b}.sq-opponent-preset button:disabled{opacity:.55;cursor:not-allowed}.sq-opponent-preset :is(button,input,select):focus-visible{outline:3px solid #8ce7ff;outline-offset:2px}.sq-opponent-preset small{display:block;font-size:14px;color:#b9c8e6}.sq-opponent-preset footer{border-top:1px solid #aac3f440;flex-wrap:wrap}.sq-opponent-preset footer>div{display:flex;gap:8px;flex-wrap:wrap}.sq-opponent-preset [data-save]{border-color:#54f09a;background:#215b49}.sq-opponent-preset [data-status]{margin:8px 0 0;color:#86e9ff;overflow-wrap:anywhere}.sq-opponent-preset [data-status]:empty{display:none}.sq-opponent-preset [data-status][data-error=true]{color:#ffb7aa}\n.sq-opponent-picker-heading{display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin:12px 0 8px}.sq-opponent-preset [data-picked]{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px}.sq-opponent-preset [data-picked] button{display:flex;align-items:center;gap:6px;font-size:14px;padding:5px 8px;background:#122650;overflow-wrap:anywhere}.sq-opponent-results{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;max-height:280px;overflow:auto;padding:4px;margin-top:8px;scrollbar-color:#5278c2 #16264b}.sq-opponent-results .sq-opponent-racer{display:grid;grid-template-columns:64px minmax(0,1fr) auto;align-items:center;gap:10px;text-align:left;padding:8px;min-height:78px}.sq-opponent-racer[aria-pressed=true]{border-color:#54f09a;background:#193d42;box-shadow:inset 3px 0 #54f09a}.sq-opponent-racer-name{overflow-wrap:anywhere;min-width:0}.sq-opponent-racer-mark{font-size:13px;color:#8ce7ff}.sq-opponent-preview{position:relative;display:grid;place-items:center;width:64px;height:54px;overflow:hidden;background:#0b1730;color:#54f09a}.sq-opponent-preview .overall-car-model{position:relative;display:block;width:64px;height:54px;inset:auto;transform:none;margin:0}.sq-opponent-preview img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain}.sq-opponent-preview img:not(.show){display:none}.sq-opponent-preset [data-results-status]{font-size:14px;color:#b9c8e6;margin:6px 0 0}\n@media(max-width:560px){.sq-opponent-preset{width:calc(100vw - 12px);max-height:calc(100dvh - 12px)}.sq-opponent-preset header,.sq-opponent-preset footer{padding:12px}.sq-opponent-preset main{padding:12px}.sq-opponent-preset h2{font-size:27px}.sq-opponent-card{padding:12px}.sq-opponent-form,.sq-opponent-results{grid-template-columns:1fr}.sq-opponent-preset footer>div{width:100%}.sq-opponent-preset footer button{flex:1}.sq-opponent-preset footer small{font-size:12px}}\n@media(min-width:701px){.sq-opponent-preset main{display:grid;grid-template-columns:220px minmax(0,1fr);gap:14px;align-content:start}.sq-opponent-preset .sq-opponent-intro{grid-column:1/-1;margin-bottom:0}.sq-opponent-preset main>.sq-opponent-card:first-of-type{grid-column:1;grid-row:2/4;align-self:start;margin:0}.sq-opponent-preset main>.sq-opponent-card:first-of-type .sq-opponent-form{grid-template-columns:1fr;gap:0}.sq-opponent-preset [data-fields]{grid-column:2;margin:0}.sq-opponent-preset main>.sq-opponent-check{grid-column:2;margin:0}.sq-opponent-preset [data-status]{grid-column:1/-1}.sq-opponent-preset .sq-opponent-results{grid-template-columns:1fr}}";document.head.append(style);}
 const query=s=>dialog.querySelector(s),preset=loadOpponentPreset(storage),selected=new Set(preset.accounts),status=query('[data-status]');
 const date=value=>{if(!value)return '';const d=new Date(value);return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
 query('[data-key]').value=opponentShortcutLabel(preset.key);query('[data-mode]').value=preset.mode;query('[data-limit]').value=preset.limit;query('[data-enabled]').checked=preset.enabled;query('[data-self]').checked=preset.includeSelf;
 query('[data-places]').value=preset.places.join(', ');query('[data-relative]').value=preset.relative.join(', ');query('[data-min]').value=preset.percentileMin;query('[data-max]').value=preset.percentileMax;query('[data-after]').value=date(preset.after);query('[data-before]').value=date(preset.before?preset.before-1:0);
 let key=preset.key;
 const tell=(text,error=false)=>{status.textContent=text;status.dataset.error=String(error);};
 const profiles=()=>{const map=new Map();for(const row of getProfiles()||[])if(validId(idOf(row)))map.set(idOf(row),{...map.get(idOf(row)),...row});return map;};
 const name=(id,map)=>String(map.get(id)?.name||map.get(id)?.nickname||id);
 const renderUsers=(focusId='')=>{
  const map=profiles(),picked=query('[data-picked]'),results=query('[data-results]');picked.replaceChildren();results.replaceChildren();
  query('[data-count]').textContent=selected.size+' / 10 racers selected';
  for(const id of selected){const button=document.createElement('button');button.type='button';button.textContent=name(id,map)+' \u00d7';button.setAttribute('aria-label','Remove '+name(id,map));button.onclick=()=>{selected.delete(id);renderUsers();query('[data-search]').focus();tell(name(id,map)+' removed.');};picked.append(button);}
  const term=query('[data-search]').value.trim().toLocaleLowerCase();
  const rows=[...map].filter(([id,row])=>!term||id.toLowerCase().includes(term)||String(row.name||row.nickname||'').toLocaleLowerCase().includes(term)).slice(0,24);
  const publicId=query('[data-search]').value.trim(),manual=Boolean(term&&!rows.length&&validId(publicId));
  if(manual)rows.push([publicId,{accountId:publicId}]);
  // Names and IDs are always text. Only the existing trusted car renderer supplies markup.
  for(const [id,row] of rows){
   const button=document.createElement('button');button.type='button';button.className='sq-opponent-racer';button.dataset.racerId=id;button.title=id;
   button.setAttribute('aria-pressed',String(selected.has(id)));button.setAttribute('aria-label',name(id,map)+(selected.has(id)?', selected. Remove racer':', add racer'));
   const preview=document.createElement('span');preview.className='sq-opponent-preview';preview.setAttribute('aria-hidden','true');
   const markup=map.has(id)?renderRacer(row):'';if(markup)preview.innerHTML=String(markup);else preview.textContent=name(id,map).slice(0,2).toUpperCase();
   const label=document.createElement('span');label.className='sq-opponent-racer-name';label.textContent=name(id,map);
   const mark=document.createElement('span');mark.className='sq-opponent-racer-mark';mark.textContent=selected.has(id)?'Selected':'Add';button.append(preview,label,mark);
   button.onclick=()=>{if(selected.has(id))selected.delete(id);else if(selected.size<10)selected.add(id);else{tell('10 racers selected. Remove one before adding another.',true);return;}renderUsers(id);tell(name(id,map)+(selected.has(id)?' selected.':' removed.'));};results.append(button);
  }
  query('[data-results-status]').textContent=manual?'Public ID not in the saved directory. Its replay must be available on the track.':rows.length?rows.length+' saved racers shown'+(rows.length===24?'. Refine your search for more.':'.'):term?'No saved racers match. Try another name or public ID.':'No racers in the saved directory yet.';
  onRenderRacers(results);
  if(focusId)Array.from(results.children).find(button=>button.dataset.racerId===focusId)?.focus();
 };
 query('[data-search]').addEventListener('keydown',event=>{if(event.key==='ArrowDown'){event.preventDefault();query('[data-results]').firstElementChild?.focus();}});
 query('[data-results]').addEventListener('keydown',event=>{
  const buttons=Array.from(query('[data-results]').children),index=buttons.indexOf(document.activeElement);if(index<0)return;
  let next=index;if(event.key==='ArrowDown'||event.key==='ArrowRight')next=Math.min(index+1,buttons.length-1);else if(event.key==='ArrowUp'||event.key==='ArrowLeft')next=Math.max(0,index-1);else if(event.key==='Home')next=0;else if(event.key==='End')next=buttons.length-1;else return;
  event.preventDefault();buttons[next]?.focus();
 });
 const show=()=>{for(const section of dialog.querySelectorAll('[data-for]'))section.hidden=section.dataset.for!==query('[data-mode]').value;if(query('[data-mode]').value==='accounts')onRenderRacers(query('[data-results]'));};
 query('[data-key]').addEventListener('keydown',event=>{if(event.key==='Tab'||event.key==='Escape')return;event.preventDefault();event.stopPropagation();const next=shortcutCode((event.shiftKey?'Shift+':'')+event.code);if(next&&!event.ctrlKey&&!event.altKey&&!event.metaKey){key=next;query('[data-key]').value=opponentShortcutLabel(next);tell('');}else tell('Choose B, F, G, J, K, L, N, O, Q, U, V, X, Y or Z, optionally with Shift.',true);});
 query('[data-search]').addEventListener('input',renderUsers);query('[data-mode]').addEventListener('change',show);
 const parseList=(selector,negative)=>{const raw=query(selector).value.trim();if(!raw)return [];const parts=raw.split(/[\s,]+/);if(parts.length>10||parts.some(part=>!new RegExp(negative?'^-?\\d+$':'^\\d+$').test(part)))throw Error('Enter up to 10 whole numbers separated by commas.');const values=parts.map(Number);if(values.some(n=>!Number.isSafeInteger(n)||Math.abs(n)>1000000||(!negative&&n<1)))throw Error('Places must be whole numbers from 1 to 1,000,000.');return values;};
 const save=()=>{
  const mode=query('[data-mode]').value,changes={};
  if(mode==='accounts'){
   if(!selected.size)throw Error('Choose at least one racer.');
   changes.accounts=[...selected];
  }else if(mode==='places'){
   changes.places=parseList('[data-places]',false);
   if(!changes.places.length)throw Error('Choose at least one place.');
  }else if(mode==='relative'){
   changes.relative=parseList('[data-relative]',true);
   if(!changes.relative.length)throw Error('Enter places ahead of or behind you.');
  }else if(mode==='recent'){
   changes.after=query('[data-after]').value?new Date(query('[data-after]').value+'T00:00:00').getTime():0;
   const end=query('[data-before]').value?new Date(query('[data-before]').value+'T00:00:00'):null;
   if(end)end.setDate(end.getDate()+1);
   changes.before=end?.getTime()||0;
   if(changes.after&&changes.before&&changes.after>=changes.before)throw Error('The start date must be before the end date.');
  }else if(mode==='percentile'){
   changes.percentileMin=Number(query('[data-min]').value);changes.percentileMax=Number(query('[data-max]').value);
   if(!Number.isFinite(changes.percentileMin)||!Number.isFinite(changes.percentileMax)||changes.percentileMin<0||changes.percentileMax>100||changes.percentileMin>changes.percentileMax)throw Error('Choose a percentile range from 0 to 100.');
  }
  const limit=Number(query('[data-limit]').value);
  if(!Number.isInteger(limit)||limit<1||limit>10)throw Error('Choose from 1 to 10 ghosts.');
  // Inactive modes retain their last valid saved values, never hidden invalid drafts.
  const saved=saveOpponentPreset(storage,{...preset,...changes,enabled:query('[data-enabled]').checked,key,mode,limit,includeSelf:query('[data-self]').checked});
  Object.assign(preset,saved);onSave(saved);return saved;
 };
 query('[data-save]').onclick=()=>{try{save();tell('Shortcut saved.');}catch(error){tell(error.message||'Could not save this shortcut.',true);}};
 query('[data-run]').disabled=typeof onRun!=='function';query('[data-run]').title=typeof onRun==='function'?'Select matching ghosts on this track':'Open a track leaderboard to select ghosts now';query('[data-run]').onclick=async()=>{try{const saved=save();await onRun(saved);dialog.close();}catch(error){tell(error.message||'Ghosts could not be selected.',true);}};
 query('[data-close]').onclick=()=>dialog.close();dialog.addEventListener('keydown',event=>event.stopPropagation());dialog.addEventListener('keyup',event=>event.stopPropagation());dialog.addEventListener('close',()=>{dialog.remove();if(returnFocus?.isConnected&&!returnFocus.disabled)returnFocus.focus({preventScroll:true});});
 document.body.append(dialog);show();dialog.showModal();renderUsers();query('[data-key]').focus();return dialog;
}
