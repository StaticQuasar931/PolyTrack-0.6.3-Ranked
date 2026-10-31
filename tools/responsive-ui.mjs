import {installMobileFullscreen} from './mobile-fullscreen.mjs';
// Only UI overlays consume these measurements. Canvas size and game input stay native.
import {installCompactRankedLayout} from './compact-ranked-layout.mjs?v=183';
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

// Reserve native footer slots without impersonating the asynchronously created filter button.
export function installNativeTrackFooterReservation({document=globalThis.document}={}){
  if(!document?.head||document.getElementById('sq-native-footer-reservation'))return;
  const style=document.createElement('style');style.id='sq-native-footer-reservation';
  const footer='html body .track-info-ui .leaderboard-ui:not(.sq-event-board) > .button-wrapper:not(:has(> [data-personal-filter-button])):has(> .back):has(> .only-verified):has(> .icon-button.first)';
  style.textContent=`
    ${footer}{display:grid!important;grid-template-columns:minmax(126px,1fr) 96px minmax(170px,1.25fr) 48px!important;grid-template-rows:minmax(48px,auto);align-items:stretch;gap:8px!important;width:min(100%,540px);min-width:0;min-height:60px!important;height:auto!important;padding:6px 0!important;box-sizing:border-box;flex:0 0 auto!important;align-self:center;overflow:visible!important}
    ${footer}>button{width:100%;min-width:0!important;max-width:100%;min-height:48px!important;margin:0!important;padding:8px 12px!important;box-sizing:border-box;float:none!important;line-height:1.15!important;white-space:nowrap!important}
    ${footer}::before{content:"";visibility:hidden;grid-column:2;grid-row:1;min-width:0;min-height:48px}
    ${footer}>.back{grid-column:1;grid-row:1}
    ${footer}>.only-verified{display:flex!important;grid-column:3;grid-row:1;align-items:center;justify-content:center;gap:6px}
    ${footer}>.icon-button.first{grid-column:4;grid-row:1;min-width:48px!important}
    ${footer}>.only-verified img{width:22px!important;height:22px!important;max-width:22px!important;max-height:22px!important;margin:0!important;object-fit:contain}
    @media(max-width:650px) and (orientation:landscape){
      ${footer}{grid-template-columns:minmax(48px,1fr) minmax(48px,1fr) minmax(62px,1.2fr) 44px!important;gap:4px!important;min-height:48px!important;padding:0!important}
      ${footer}>button{min-height:44px!important;padding:3px!important;font-size:12px!important;line-height:1!important;white-space:normal!important;overflow-wrap:anywhere}
      ${footer}::before{min-height:44px}
      ${footer}>.icon-button.first{min-width:44px!important}
      ${footer}>.only-verified{gap:3px}
      ${footer}>.only-verified img{width:16px!important;height:16px!important;max-width:16px!important;max-height:16px!important}
    }
    @media(max-width:600px) and (orientation:portrait){
      ${footer}{grid-template-columns:minmax(88px,1fr) minmax(80px,.9fr) 48px!important;grid-template-rows:minmax(44px,auto) minmax(44px,auto);min-height:94px!important}
      ${footer}>.icon-button.first{grid-column:3;grid-row:1}
      ${footer}>.only-verified{grid-column:1 / -1;grid-row:2}
    }
    @media(max-width:600px) and (max-height:650px) and (orientation:portrait){
      ${footer}{grid-template-rows:44px 44px!important;min-height:96px!important;padding:0!important}
      ${footer}>button{min-height:44px!important;height:44px!important;padding-block:4px!important}
      ${footer}::before{min-height:44px}
    }
    @media(min-width:390px) and (max-width:600px) and (orientation:portrait){
      ${footer}{grid-template-columns:minmax(58px,1fr) minmax(58px,.9fr) minmax(112px,1.4fr) 44px!important;grid-template-rows:44px!important;gap:4px!important;min-height:52px!important;padding:4px 0!important}
      ${footer}>button{height:44px!important;min-height:44px!important;padding:4px!important;font-size:14px!important}
      ${footer}::before{min-height:44px!important}
      ${footer}>.only-verified{grid-column:3;grid-row:1}
      ${footer}>.icon-button.first{grid-column:4;grid-row:1;min-width:44px!important}
    }
  `;
  document.head.appendChild(style);
}

if(typeof document!=='undefined'&&typeof window!=='undefined'){
  const start=()=>{installNativeTrackFooterReservation({document});installResponsiveViewport({document,window,container:document.querySelector('[data-polytrack-container]')||undefined});installCompactRankedLayout({document,window});installMobileFullscreen({document,window});};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
}
