import {installMobileFullscreen} from './mobile-fullscreen.mjs';
// Only UI overlays consume these measurements. Canvas size and game input stay native.
import {installCompactRankedLayout} from './compact-ranked-layout.mjs';
export function installResponsiveViewport({document=globalThis.document,window=globalThis.window,container}={}){
  if(!document?.documentElement||!window)return ()=>{};
  const html=document.documentElement;
  let frame=0,last='',disposed=false;
  const update=()=>{
    frame=0;if(disposed)return;
    const bounds=container?.getBoundingClientRect?.();
    const viewport=window.visualViewport;
    const width=Math.max(1,Math.round(Math.min(bounds?.width||html.clientWidth||window.innerWidth,viewport?.width||window.innerWidth)));
    const height=Math.max(1,Math.round(Math.min(bounds?.height||html.clientHeight||window.innerHeight,viewport?.height||window.innerHeight)));
    const top=Math.max(0,Math.round(bounds?.top||0),Math.round(viewport?.offsetTop||0));
    const left=Math.max(0,Math.round(bounds?.left||0),Math.round(viewport?.offsetLeft||0));
    const signature=[width,height,top,left].join(':');if(signature===last)return;last=signature;
    html.style.setProperty('--sq-available-width',width+'px');
    html.style.setProperty('--sq-available-height',height+'px');
    html.style.setProperty('--sq-visible-top',top+'px');
    html.style.setProperty('--sq-visible-left',left+'px');
    html.dataset.sqSpace=height<460?'short':width<700?'narrow':height<700?'compact':'roomy';
    const focused=document.activeElement;
    if(viewport&&viewport.height<window.innerHeight*.75&&focused?.matches?.('input,textarea,select')&&focused.closest?.('#overallProfilePopup,#overallFilterPanel,.settings-menu-ui,[role="dialog"]')){
      focused.scrollIntoView?.({block:'nearest',inline:'nearest',behavior:'instant'});
    }
  };
  const schedule=()=>{if(!frame&&!disposed)frame=window.requestAnimationFrame(update);};
  const events=['resize','orientationchange','pageshow'];
  for(const event of events)window.addEventListener(event,schedule,{passive:true});
  window.visualViewport?.addEventListener('resize',schedule,{passive:true});
  window.visualViewport?.addEventListener('scroll',schedule,{passive:true});
  document.addEventListener('fullscreenchange',schedule);
  const observer=container&&typeof window.ResizeObserver==='function'?new window.ResizeObserver(schedule):null;
  observer?.observe(container);update();
  return ()=>{
    disposed=true;if(frame)window.cancelAnimationFrame(frame);observer?.disconnect();
    for(const event of events)window.removeEventListener(event,schedule);
    window.visualViewport?.removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('scroll',schedule);
    document.removeEventListener('fullscreenchange',schedule);
  };
}

if(typeof document!=='undefined'&&typeof window!=='undefined'){
  const start=()=>{installResponsiveViewport({document,window,container:document.querySelector('[data-polytrack-container]')||undefined});installCompactRankedLayout({document,window});installMobileFullscreen({document,window});};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
}
