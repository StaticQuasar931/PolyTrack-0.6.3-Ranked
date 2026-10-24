const menus=['filters','ghost-shortcut','diagnostics','extra-tracks','help','practice','profile','rankings','event','track','settings','garage','editor','multiplayer','pause','driving','home'];
const menuSelectors=[['ghost-shortcut','#polytrackOpponentPresetDialog'],['diagnostics','#polytrackDeveloperDialog'],['filters','.pt-group-filter-menu'],['extra-tracks','.sq-extra-overlay'],['help','#overallHelpPopup'],['practice','.polytrack-practice-profile'],['profile','#overallProfilePopup'],['rankings','#overallLeaderboardPanel'],['event','.sq-events-dialog'],['track','.track-info-ui'],['settings','.settings-menu-ui'],['garage','.customization-ui'],['editor','.editor-ui'],['multiplayer','.multiplayer-ui'],['pause','.pause-screen-ui']];
const knownIds={injectedRankingsBtn:'open-rankings',overallHelpBtn:'help',closeOverallLeaderboard:'close',overallFindMeBtn:'find-me',overallNextPage:'next-page',overallPrevPage:'previous-page',overallPageJump:'page-number',overallCategorySelect:'ranking-category',overallFreshness:'refresh',overallProfileClose:'close-profile',overallHelpClose:'close-help'};
const textActions=new Set(['play','watch','back','close','help','settings','filters','apply filters','pause filters','resume filters','quick reset','save shortcut','save and select now','ghost shortcut','grid','list','reset filters','my favorites','curated only','official only','import','export','search','clear','cancel','save','download json','copy json','practice history','route planner','multiplayer','customize','editor','fullscreen','music: on','music: off']);
const safe=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,40);
const visible=node=>!!node&&!node.hidden&&node.getClientRects().length>0&&node.ownerDocument?.defaultView?.getComputedStyle(node).visibility!=='hidden';
export function controlUsageMenu(target,document=globalThis.document){
 for(const [menu,selector] of menuSelectors){const root=target?.closest?.(selector);if(root)return menu;}
 for(const [menu,selector] of menuSelectors){const root=document?.querySelector?.(selector);if(visible(root))return menu;}
 if(visible(document?.querySelector?.('.game-ui'))&&!visible(document?.querySelector?.('.menu-ui')))return 'driving';
 return 'home';
}
export function controlUsageName(node){
 if(!node)return '';
 if(knownIds[node.id])return knownIds[node.id];
 for(const [selector,name] of [['[data-pp-sort]','sort'],['[data-pp-direction]','sort-direction'],['[data-pp-search]','search'],['[data-pp-track-id]','open-track'],['[data-places]','selection-places'],['[data-relative]','selection-offsets'],['[data-search]','racer-search']])if(node.matches?.(selector))return name;
 if(node.matches?.('[data-pp-view]')&&['grid','list'].includes(node.dataset?.ppView))return 'view-'+node.dataset.ppView;
 if(['source','tag','catalog-level','progress','review-status','sort','quality','reviewed-difficulty','reviewer-votes'].includes(node.dataset?.sqControl))return 'filter-'+node.dataset.sqControl;
 const setting=node.closest?.('.setting');
 const settingLabel=setting?.querySelector?.(':scope > p,:scope > label')?.textContent?.trim();
 if(settingLabel)return 'setting-'+safe(settingLabel).slice(0,32);
 if(node.matches?.('.fm-nav-button'))return 'section-'+safe(node.dataset.section);
 if(node.matches?.('[data-planner-filter]'))return 'planner-filter-'+safe(node.dataset.plannerFilter);
 for(const [selector,name] of [['[data-mode]','selection-rule'],['[data-key]','shortcut-key'],['[data-limit]','ghost-limit'],['[data-min]','percentile-from'],['[data-max]','percentile-to'],['[data-after]','date-from'],['[data-before]','date-to'],['[data-self]','include-self'],['[data-enabled]','enable-shortcut']])if(node.matches?.(selector))return name;
 if(node.matches?.('.leaderboard-ui .container > button.main'))return 'toggle-ghost';
 if(node.matches?.('.overall-entry[data-userid]'))return 'open-profile';
 if(node.matches?.('[data-track-id],[data-practice-track],.track-selection-ui .track > button'))return 'open-track';
 if(node.matches?.('[data-leaderboard-shortcut]'))return 'quick-ranking-'+safe(node.dataset.leaderboardShortcut);
 if(node.matches?.('.page'))return 'page-number';
 if(node.matches?.('[data-personal-filter-button]'))return 'open-filters';
 if(node.matches?.('[data-direction]'))return 'sort-direction';
 if(node.matches?.('[data-sort]'))return 'sort';
 if(node.matches?.('[data-review-rating],[data-rating]'))return 'quality-rating';
 if(node.matches?.('[data-review-difficulty],[data-difficulty]'))return 'difficulty-rating';
 if(node.matches?.('[data-preset-section]'))return 'shortcut-section';
 const type=String(node.type||'').toLowerCase();
 if(type==='password'||type==='email'||node.matches?.('[autocomplete=current-password],[autocomplete=new-password]'))return '';
 if(node.tagName==='SELECT')return 'choose-option';
 if(type==='checkbox')return 'toggle-option';
 if(type==='range')return 'adjust-slider';
 if(type==='search')return 'search';
 if(type==='number')return 'change-number';
 const label=String(node.getAttribute?.('aria-label')||node.textContent||'').trim().toLowerCase();
 if(textActions.has(label))return safe(label);
 const icon=node.querySelector?.('img')?.getAttribute('src')||'';
 const iconName=icon.match(/(?:^|\/)(play|back|settings|help|pin|customize|multiplayer|editor|import|export|search|preview|fullscreen|music_on|music_off)\.svg(?:\?|$)/)?.[1];
 if(iconName)return safe(iconName);
 return node.tagName==='A'?'open-link':node.tagName==='SUMMARY'?'expand-details':node.tagName==='INPUT'?'edit-field':'activate-button';
}
export function normalizeControlUsage(value){
 const out={};let total=0;
 for(const menu of menus){const input=value?.[menu];if(!input||typeof input!=='object'||Array.isArray(input))continue;const entries=Object.entries(input).filter(([name,count])=>/^[a-z0-9-]{1,40}$/.test(name)&&Number.isSafeInteger(count)&&count>0).slice(0,64);for(const [name,count] of entries){if(total>=256)break;(out[menu]||={})[name]=Math.min(1e9,count);total++;}}
 return out;
}
export function installControlUsage({document=globalThis.document,record=()=>{},menuOf=target=>controlUsageMenu(target,document)}={}){
 const click=event=>{if(event.isTrusted===false)return;const target=event.target?.closest?.('button,a,summary');if(!target||target.disabled)return;const control=controlUsageName(target);if(control)record(menuOf(target),control);};
 const change=event=>{if(event.isTrusted===false)return;const target=event.target;if(!target?.matches?.('input,select')||target.disabled)return;const control=controlUsageName(target);if(control)record(menuOf(target),control);};
 const key=event=>{if(event.isTrusted===false||event.repeat||event.altKey||event.ctrlKey||event.metaKey||event.target?.closest?.('input,textarea,select,[contenteditable=true]'))return;const menu=menuOf(event.target),code=event.code;if(!/^(?:Key[A-Z]|Digit[0-9]|Numpad[0-9]|Arrow(?:Up|Down|Left|Right)|Enter|Escape|Space|Backspace|Equal|Minus|Slash|Period|Comma|Tab)$/.test(code||''))return;queueMicrotask(()=>{if(event.defaultPrevented||menu==='driving')record(menu,'key-'+(event.shiftKey?'shift-':'')+safe(code));});};
 document.addEventListener('click',click,true);document.addEventListener('change',change,true);document.addEventListener('keydown',key,true);
 return ()=>{document.removeEventListener('click',click,true);document.removeEventListener('change',change,true);document.removeEventListener('keydown',key,true);};
}
