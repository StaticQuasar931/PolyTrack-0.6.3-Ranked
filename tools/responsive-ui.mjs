import {installMobileFullscreen} from './mobile-fullscreen.mjs';
// Only UI overlays consume these measurements. Canvas size and game input stay native.
import {installCompactRankedLayout} from './compact-ranked-layout.mjs?v=181';
export function availableViewport({document,window,container}){
  const html=document.documentElement,visual=window.visualViewport;
  const rootWidth=html.clientWidth||window.innerWidth,rootHeight=html.clientHeight||window.innerHeight;
  let left=Math.max(0,visual?.offsetLeft||0),top=Math.max(0,visual?.offsetTop||0);
  let right=Math.min(rootWidth,left+(visual?.width||rootWidth)),bottom=Math.min(rootHeight,top+(visual?.height||rootHeight));
  const bounds=container?.getBoundingClientRect?.();
  if(bounds?.width>0&&bounds?.height>0){
    left=Math.max(left,bounds.left??0);top=Math.max(top,bounds.top??0);
    right=Math.min(right,bounds.right??((bounds.left||0)+bounds.width));
    bottom=Math.min(bottom,bounds.bottom??((bounds.top||0)+bounds.height));
  }
  return {width:Math.max(1,Math.round(right-left)),height:Math.max(1,Math.round(bottom-top)),left:Math.round(left),top:Math.round(top)};
}
export function installResponsiveViewport({document=globalThis.document,window=globalThis.window,container}={}){
  if(!document?.documentElement||!window)return ()=>{};
  const html=document.documentElement;
  let frame=0,last='',disposed=false;
  const update=()=>{
    frame=0;if(disposed)return;
    const viewport=window.visualViewport;
    const {width,height,top,left}=availableViewport({document,window,container});
    const signature=[width,height,top,left].join(':');if(signature===last)return;last=signature;
    html.style.setProperty('--sq-available-width',width+'px');
    html.style.setProperty('--sq-available-height',height+'px');
    html.style.setProperty('--sq-visible-top',top+'px');
    html.style.setProperty('--sq-visible-left',left+'px');
    html.dataset.sqSpace=height<460?'short':width<700?'narrow':height<700?'compact':'roomy';
    if(typeof window.CustomEvent==='function')document.dispatchEvent(new window.CustomEvent('sq-viewport-changed',{detail:{width,height,top,left}}));
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
  document.addEventListener('webkitfullscreenchange',schedule);
  document.addEventListener('visibilitychange',schedule);
  window.screen?.orientation?.addEventListener('change',schedule);
  // Safari can settle the layout viewport after its first orientation event.
  const observer=typeof window.ResizeObserver==='function'?new window.ResizeObserver(schedule):null;
  observer?.observe(container||html);update();
  return ()=>{
    disposed=true;if(frame)window.cancelAnimationFrame(frame);observer?.disconnect();
    for(const event of events)window.removeEventListener(event,schedule);
    window.visualViewport?.removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('scroll',schedule);
    document.removeEventListener('fullscreenchange',schedule);
    document.removeEventListener('webkitfullscreenchange',schedule);
    document.removeEventListener('visibilitychange',schedule);
    window.screen?.orientation?.removeEventListener('change',schedule);
  };
}

if(typeof document!=='undefined'&&typeof window!=='undefined'){
  const start=()=>{installResponsiveViewport({document,window,container:document.querySelector('[data-polytrack-container]')||undefined});installCompactRankedLayout({document,window});installMobileFullscreen({document,window});};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
}
