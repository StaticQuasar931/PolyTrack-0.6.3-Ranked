const searchModuleUrl=new URL('./search-text.mjs',import.meta.url);
searchModuleUrl.search=new URL(import.meta.url).search;
const {normalizeSearchText,searchMatches,searchAliases}=await import(searchModuleUrl.href);

export function enhanceNativeTrackSearch({document,metadata=[]}={}){
  const byName=new Map(metadata.map(row=>[normalizeSearchText(row.name),row]));
  const images=metadata.filter(row=>typeof row.thumbnail==='string');
  const selector='.track-selection-ui .search-bar-container input';
  const labelled=new WeakSet(),nativeMatches=new WeakMap(),watchedPanes=new WeakSet();let previousPane=null,previousTab=null,frame=0,paneObserver=null;
  const describe=tile=>{
    const name=tile.querySelector('.track-title p')?.textContent||tile.querySelector('.track-title')?.textContent||'';
    const thumbnail=tile.querySelector('img.thumbnail');
    const image=thumbnail?.getAttribute('src')||'';
    const row=images.find(item=>image.endsWith(item.thumbnail))||byName.get(normalizeSearchText(name));
    const aliases=searchAliases(name);
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
    for(const input of document.querySelectorAll(selector)){
      input.setAttribute('aria-label','Search tracks or authors, including plain-text names');
      input.title='Plain letters also match decorative fonts and accented names.';
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
  return {apply,dispose(){observer?.disconnect();paneObserver?.disconnect();if(frame)view.cancelAnimationFrame(frame);document.removeEventListener('input',capture,true);document.removeEventListener('input',bubble);document.removeEventListener('click',tabClick);}};
}
