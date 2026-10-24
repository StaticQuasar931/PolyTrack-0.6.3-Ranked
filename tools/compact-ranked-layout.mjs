export function compactRankedMode(width,height){
  if(width>700 && (height>500 || width>1100))return 'desktop';
  return width>=560 && width>height?'landscape':'portrait';
}

export function installCompactRankedLayout({document=globalThis.document,window=globalThis.window}={}){
  if(!document?.documentElement||!window)return ()=>{};
  let active=null,frame=0,disposed=false;
  function attach(footer){
    const drawer=document.createElement('div');
    drawer.id='overallMobileTools';drawer.className='overall-mobile-drawer';drawer.hidden=true;
    drawer.setAttribute('role','region');drawer.setAttribute('aria-label','More ranking tools');
    const toggle=document.createElement('button');
    toggle.type='button';toggle.className='overall-mobile-tools';toggle.textContent='More';toggle.hidden=true;
    toggle.setAttribute('aria-controls',drawer.id);toggle.setAttribute('aria-expanded','false');
    toggle.setAttribute('aria-label','More ranking tools, snapshot status, quick rankings and challenges');
    const moved=[...footer.querySelectorAll('.overall-challenge-stack,.overall-field-summary,.overall-freshness,.leaderboard-arcade,.overall-track-scope')]
      .map(node=>{const marker=document.createTextNode('');node.parentNode.insertBefore(marker,node);return {node,marker};});
    footer.append(toggle,drawer);
    let mode='desktop';
    const close=(focus=false)=>{drawer.hidden=true;toggle.setAttribute('aria-expanded','false');toggle.textContent='More';if(focus&&!toggle.hidden)toggle.focus();};
    const click=()=>{const open=drawer.hidden;drawer.hidden=!open;toggle.setAttribute('aria-expanded',String(open));toggle.textContent=open?'Less':'More';};
    toggle.addEventListener('click',click);
    return {footer,update(next){
      if(next===mode)return;mode=next;close();
      if(mode==='desktop'){
        for(const {node,marker}of moved)marker.parentNode?.insertBefore(node,marker);
        delete footer.dataset.mobileAxis;toggle.hidden=true;
      }else{
        for(const {node}of moved)drawer.append(node);
        footer.dataset.mobileAxis=mode;toggle.hidden=false;
      }
    },close,targetInside:target=>footer.contains(target),isOpen:()=>!drawer.hidden,
    destroy(){close();for(const {node,marker}of moved){marker.parentNode?.insertBefore(node,marker);marker.remove();}
      toggle.removeEventListener('click',click);toggle.remove();drawer.remove();delete footer.dataset.mobileAxis;}};
  }
  const update=()=>{
    frame=0;if(disposed)return;
    const footer=document.getElementById('overallDailyGrid');
    if(active?.footer!==footer){active?.destroy();active=footer?attach(footer):null;}
    const width=parseFloat(document.documentElement.style.getPropertyValue('--sq-available-width'))||window.visualViewport?.width||window.innerWidth;
    const height=parseFloat(document.documentElement.style.getPropertyValue('--sq-available-height'))||window.visualViewport?.height||window.innerHeight;
    active?.update(compactRankedMode(width,height));
  };
  const schedule=()=>{if(!frame&&!disposed)frame=window.requestAnimationFrame(update);};
  const observer=typeof window.MutationObserver==='function'?new window.MutationObserver(records=>{
    if(records.some(record=>[...record.addedNodes,...record.removedNodes].some(node=>node.nodeType===1&&
      (node.id==='overallLeaderboardPanel'||node.id==='overallDailyGrid'||node.querySelector?.('#overallDailyGrid')))))schedule();
  }):null;
  observer?.observe(document.documentElement,{childList:true,subtree:true});
  const outside=event=>{if(active?.isOpen()&&!active.targetInside(event.target))active.close();};
  const key=event=>{if(event.key==='Escape'&&active?.isOpen()){active.close(true);event.preventDefault();event.stopImmediatePropagation();}};
  window.addEventListener('resize',schedule,{passive:true});window.visualViewport?.addEventListener('resize',schedule,{passive:true});
  document.addEventListener('sq-viewport-changed',schedule);
  document.addEventListener('pointerdown',outside,true);document.addEventListener('keydown',key,true);update();
  return ()=>{disposed=true;if(frame)window.cancelAnimationFrame(frame);observer?.disconnect();active?.destroy();
    window.removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('resize',schedule);
    document.removeEventListener('sq-viewport-changed',schedule);
    document.removeEventListener('pointerdown',outside,true);document.removeEventListener('keydown',key,true);};
}
