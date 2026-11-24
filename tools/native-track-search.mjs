const {completeTrackShortcutTutorial}=await import(new URL('./track-shortcut-progress.mjs'+new URL(import.meta.url).search,import.meta.url).href);
const searchModuleUrl=new URL('./search-text.mjs',import.meta.url);
searchModuleUrl.search=new URL(import.meta.url).search;
const {normalizeSearchText,searchMatches,searchAliases}=await import(searchModuleUrl.href);

export function enhanceNativeTrackSearch({document,metadata=[]}={}){
  const byName=new Map(metadata.map(row=>[normalizeSearchText(row.name),row]));
  const images=metadata.filter(row=>typeof row.thumbnail==='string');
  const selector='.track-selection-ui .search-bar-container input';
  const labelled=new WeakSet(),nativeMatches=new WeakMap(),watchedPanes=new WeakSet();let tutorialCleanup=null,previousPane=null,previousTab=null,frame=0,paneObserver=null;
  const describe=tile=>{
    const name=tile.querySelector('.track-title p')?.textContent||tile.querySelector('.track-title')?.textContent||'';
    const thumbnail=tile.querySelector('img.thumbnail');
    const image=thumbnail?.getAttribute('src')||'';
    const row=images.find(item=>image.endsWith(item.thumbnail))||byName.get(normalizeSearchText(name));
    const aliases=tile.classList.contains('sq-permanent-track')?['Rolling Hills Racer','Rolling Hills Raceway','RHR',...searchAliases(name)]:searchAliases(name);
    const primary=row?.plainName||aliases.find(value=>/^[\x20-\x7e]+$/.test(value))||name.normalize('NFKC');
    const label=[primary,row?.author?'by '+row.author:''].filter(Boolean).join('. ');
    tile.setAttribute('aria-label',label);
    tile.querySelector('button')?.setAttribute('aria-label',label);
    if(thumbnail)thumbnail.alt=primary+' track preview';
    labelled.add(tile);
    return {name,row,aliases};
  };
  const decorate=()=>{
    for(const tile of document.querySelectorAll('.track-selection-ui .track'))if(!labelled.has(tile))describe(tile);
    for(const pane of document.querySelectorAll('.track-selection-ui .tracks-container'))if(paneObserver&&!watchedPanes.has(pane)){
      paneObserver.observe(pane,{attributes:true,attributeFilter:['class']});watchedPanes.add(pane);
    }
    for(const nav of document.querySelectorAll('.track-selection-ui .community-track-versions')){
      nav.setAttribute('aria-keyshortcuts','Shift+ArrowLeft Shift+ArrowRight');
      nav.title='Shift+Left or Shift+Right to change community versions';
    }
    for(const input of document.querySelectorAll(selector)){
      input.setAttribute('aria-label','Search tracks or authors');
      input.title='Plain letters also match decorative fonts and accented names. Community: Enter opens an exact match; outside the search box use 1-9, ? for this list, or ! for any loaded track.';
    }
  };
  const capture=event=>{
    if(!event.target.matches?.(selector))return;
    const menu=event.target.closest('.track-selection-ui');
    previousPane=menu.querySelector('.tracks-container.open');
    previousTab=menu.querySelector('.image-button-container>button.selected');
  };
  const apply=(input,{nativeFiltered=false,restorePane=false}={})=>{
    const menu=input.closest('.track-selection-ui'),query=input.value;if(!menu)return;
    const groups=new Set(),officialPane=menu.querySelector('.tracks-container'),matchesByTile=new Map();
    for(const tile of menu.querySelectorAll('.track')){
      const {name,row,aliases}=describe(tile);
      if(nativeFiltered)nativeMatches.set(tile,{query,match:tile.style.display!=='none'});
      const evidence=nativeMatches.get(tile);
      matchesByTile.set(tile,!query.trim()||evidence?.query===query&&evidence.match||searchMatches(query,name,row?.plainName,row?.name,row?.author,...aliases));
    }
    const relaxOfficial=!!query.trim()&&officialPane&&![...matchesByTile].some(([tile,match])=>officialPane.contains(tile)&&match);
    for(const [tile,match]of matchesByTile){
      tile.style.display=match||relaxOfficial&&officialPane.contains(tile)?'':'none';groups.add(tile.parentElement);
    }
    for(const group of groups){
      if(group?.classList.contains('tracks-container'))continue;
      group.style.display=[...group.querySelectorAll('.track')].some(tile=>tile.style.display!=='none')?'':'none';
    }
    if(restorePane&&previousPane?.isConnected&&previousTab?.isConnected&&!previousPane.classList.contains('open'))previousTab.click();
  };
  const bubble=event=>{if(event.target.matches?.(selector))apply(event.target,{nativeFiltered:true,restorePane:true});};
  const tabClick=event=>{
    const button=event.target.closest?.('.track-selection-ui .image-button-container>button');
    if(button){const input=button.closest('.track-selection-ui').querySelector('.search-bar-container input');if(input)apply(input);}
  };
  const blocked=()=>[...document.querySelectorAll('#overallLeaderboardPanel, .sq-events-overlay, .sq-extra-overlay, .track-info-ui')]
    .some(node=>node.getClientRects().length&&!node.closest('[hidden],[inert],.hidden'));
  const activeCommunity=()=>[...document.querySelectorAll('.track-selection-ui .tracks-container.open')]
    .find(pane=>pane.querySelector('.community-track-versions')&&pane.getClientRects().length&&!pane.closest('[hidden],[inert],.hidden'));
  const trackButtons=(root,visible)=>[...root.querySelectorAll('.track')]
    .filter(tile=>!tile.closest('[hidden],[inert],.sq-kodub-weekly')&&(!visible||tile.getClientRects().length))
    .map(tile=>tile.querySelector(':scope > button:not(:disabled)'))
    .filter(button=>button&&(!visible||button.getClientRects().length));
  const watchTutorial=name=>{
    tutorialCleanup?.();
    const expected=normalizeSearchText(name),view=document.defaultView;
    if(!expected||!view?.MutationObserver)return;
    const finish=()=>{
      observer.disconnect();
      view.clearTimeout(timer);
      tutorialCleanup=null;
    };
    const observer=new view.MutationObserver(()=>{
      const opened=[...document.querySelectorAll('.track-info-ui:not(.hidden)')].find(node=>
        node.getClientRects().length&&normalizeSearchText(node.textContent).includes(expected));
      if(!opened)return;
      try{completeTrackShortcutTutorial(view.localStorage);}catch{}
      finish();
    });
    const timer=view.setTimeout(finish,5000);
    tutorialCleanup=finish;
    observer.observe(document.body,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','hidden']});
  };
  const communitySearchKeys=event=>{
    if(event.defaultPrevented||event.repeat||event.isComposing||event.altKey||event.ctrlKey||event.metaKey)return;
    const target=event.target;
    const inSearch=target?.matches?.(selector);
    if(!inSearch&&(target?.closest?.('input,textarea,select,[role="textbox"],[role="combobox"]')||target?.isContentEditable))return;
    const enter=event.key==='Enter'&&!event.shiftKey;
    const slot=!event.shiftKey&&/^[1-9]$/.test(event.key)?Number(event.key)-1:null;
    const randomHere=event.key==='?',randomAll=event.key==='!';
    if(inSearch?!enter:slot===null&&!randomHere&&!randomAll&&!/^\p{L}$/u.test(event.key)&&event.key!=='/')return;
    if(blocked())return;
    const pane=activeCommunity(),input=pane?.closest('.track-selection-ui')?.querySelector('.search-bar-container input');
    if(!input?.getClientRects().length||input.disabled||(inSearch&&target!==input))return;
    if(!inSearch&&(slot!==null||randomHere||randomAll)){
      const choices=trackButtons(randomAll?pane.closest('.track-selection-ui'):pane,!randomAll);
      const button=slot!==null?choices[slot]:choices[Math.floor(Math.random()*choices.length)];
      if(!button)return;
      event.preventDefault();event.stopPropagation();
      button.click();
      return;
    }
    if(enter){
      const query=normalizeSearchText(input.value);
      if(!query)return;
      const matches=[];
      for(const tile of pane.querySelectorAll('.track')){
        if(!tile.getClientRects().length||tile.closest('[hidden],[inert]'))continue;
        const {name,row,aliases}=describe(tile);
        if(![name,row?.name,row?.plainName,...aliases].some(value=>normalizeSearchText(value)===query))continue;
        const button=tile.querySelector('button:not(:disabled)');
        if(button?.getClientRects().length)matches.push({button,name});
      }
      if(matches.length!==1)return;
      event.preventDefault();event.stopPropagation();
      watchTutorial(matches[0].name);
      matches[0].button.click();
      return;
    }
    event.preventDefault();event.stopPropagation();
    input.focus({preventScroll:true});
    if(event.key==='/'){input.select();return;}
    input.value=event.key;
    input.dispatchEvent(new document.defaultView.Event('input',{bubbles:true}));
  };
  const communityVersionKeys=event=>{
    if(event.defaultPrevented||event.repeat||!event.shiftKey||event.altKey||event.ctrlKey||event.metaKey||
      !['ArrowLeft','ArrowRight'].includes(event.key))return;
    const target=event.target;
    if(target?.matches?.('input,textarea,select')||target?.isContentEditable||
      blocked())return;
    const nav=activeCommunity()?.querySelector('.community-track-versions');
    if(!nav)return;
    const buttons=[...nav.querySelectorAll('button:not(:disabled)')].filter(button=>button.getClientRects().length);
    const current=buttons.findIndex(button=>button.classList.contains('selected'));
    if(current<0||buttons.length<2)return;
    const next=buttons[(current+(event.key==='ArrowRight'?1:buttons.length-1))%buttons.length];
    event.preventDefault();event.stopPropagation();
    const moveFocus=nav.contains(document.activeElement);
    next.click();
    if(moveFocus&&next.isConnected)next.focus({preventScroll:true});
  };
  const view=document.defaultView;
  const refresh=()=>{
    if(frame)return;
    frame=view.requestAnimationFrame(()=>{frame=0;decorate();for(const input of document.querySelectorAll(selector))apply(input);});
  };
  paneObserver=view?.MutationObserver?new view.MutationObserver(refresh):null;
  const observer=view?.MutationObserver?new view.MutationObserver(records=>{
    if(!records.some(record=>[...record.addedNodes].some(node=>node.nodeType===1&&(node.matches?.('.track-selection-ui,.track')||node.querySelector?.('.track-selection-ui,.track')))))return;
    refresh();
  }):null;
  observer?.observe(document.body,{childList:true,subtree:true});
  decorate();document.addEventListener('input',capture,true);document.addEventListener('input',bubble);document.addEventListener('click',tabClick);
  document.addEventListener('keydown',communitySearchKeys,true);
  document.addEventListener('keydown',communityVersionKeys,true);
  return {apply,dispose(){tutorialCleanup?.();document.removeEventListener('keydown',communitySearchKeys,true);document.removeEventListener('keydown',communityVersionKeys,true);observer?.disconnect();paneObserver?.disconnect();if(frame)view.cancelAnimationFrame(frame);document.removeEventListener('input',capture,true);document.removeEventListener('input',bubble);document.removeEventListener('click',tabClick);}};
}
