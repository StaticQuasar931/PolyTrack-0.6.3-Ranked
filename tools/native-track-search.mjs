const searchModuleUrl=new URL('./search-text.mjs',import.meta.url);
searchModuleUrl.search=new URL(import.meta.url).search;
const {normalizeSearchText,searchMatches,searchAliases}=await import(searchModuleUrl.href);

export function enhanceNativeTrackSearch({document,metadata=[]}={}){
  const byName=new Map(metadata.map(row=>[normalizeSearchText(row.name),row]));
  const images=metadata.filter(row=>typeof row.thumbnail==='string');
  const selector='.track-selection-ui .search-bar-container input';
  const labelled=new WeakSet();let previousPane=null,previousTab=null,frame=0;
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
  const apply=input=>{
    const menu=input.closest('.track-selection-ui'),query=input.value;if(!menu)return;
    const groups=new Set();
    for(const tile of menu.querySelectorAll('.track')){
      const {name,row,aliases}=describe(tile);
      const nativeMatch=tile.style.display!=='none';
      const matches=!query.trim()||nativeMatch||searchMatches(query,name,row?.plainName,row?.name,row?.author,...aliases);
      tile.style.display=matches?'':'none';groups.add(tile.parentElement);
    }
    for(const group of groups){
      if(group?.classList.contains('tracks-container'))continue;
      group.style.display=[...group.querySelectorAll('.track')].some(tile=>tile.style.display!=='none')?'':'none';
    }
    if(previousPane&&previousTab&&[...previousPane.querySelectorAll('.track')].some(tile=>tile.style.display!=='none')&&!previousPane.classList.contains('open'))previousTab.click();
  };
  const bubble=event=>{if(event.target.matches?.(selector))apply(event.target);};
  const view=document.defaultView;
  const observer=view?.MutationObserver?new view.MutationObserver(records=>{
    if(frame||!records.some(record=>[...record.addedNodes].some(node=>node.nodeType===1&&(node.matches?.('.track-selection-ui,.track')||node.querySelector?.('.track-selection-ui,.track')))))return;
    frame=view.requestAnimationFrame(()=>{frame=0;decorate();});
  }):null;
  observer?.observe(document.body,{childList:true,subtree:true});
  decorate();document.addEventListener('input',capture,true);document.addEventListener('input',bubble);
  return {apply,dispose(){observer?.disconnect();if(frame)view.cancelAnimationFrame(frame);document.removeEventListener('input',capture,true);document.removeEventListener('input',bubble);}};
}
