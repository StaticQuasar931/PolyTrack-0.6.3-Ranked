// Adapt our server-owned weekly event to PolyTrack 0.6.3's native weekly API.
// Only committed local assets are allowed. Cloud metadata cannot inject URLs.
export function weeklyNativeResponse(catalog, trackInfo, baseUrl, now = Date.now()) {
  const empty = {serverTime:new Date(now).toISOString(),current:null};
  const active = (Array.isArray(catalog?.periods) ? catalog.periods : []).filter(p =>
    p?.kind === 'weekly' && p.enabled !== false && !p.archived &&
    Number.isSafeInteger(p.startsAt) && Number.isSafeInteger(p.endsAt) && p.startsAt <= now && now < p.endsAt);
  if (active.length !== 1) return empty;
  const period = active[0], track = trackInfo(period.trackId);
  if (!track || track.id !== period.trackId || track.retired || ![0,1,2].includes(track.environment) ||
      !/^tracks\/(official|community)\/[a-z0-9_]+\.track$/i.test(track.trackUrl || '') ||
      !/^tracks\/(official|community)\/thumbnails\/[a-z0-9_]+\.png$/i.test(track.thumbnail || '')) return empty;
  return {serverTime:empty.serverTime,current:{trackId:track.id,name:track.name,author:null,lastModified:null,
    environment:track.environment,thumbnailUrl:new URL(track.thumbnail,baseUrl).href,coverUrl:null,
    trackUrl:new URL(track.trackUrl,baseUrl).href,endTime:new Date(period.endsAt).toISOString()}};
}

export function installWeeklyEventNavigation(document, getSelection, openEvent) {
  const handler = event => {
    const button = event.target.closest?.('.track-selection-ui .track.track-of-the-week > button');
    if (!button) return;
    event.preventDefault(); event.stopImmediatePropagation();
    const selection = getSelection();
    if (!selection || Date.now() >= selection.endsAt) return;
    if (button.dataset.eventOpening === 'true') return;
    button.dataset.eventOpening = 'true'; button.setAttribute('aria-busy','true');
    Promise.resolve().then(() => openEvent({kind:'weekly',trackId:selection.trackId})).catch(() => {
      button.title = 'Event unavailable. Try again when connected.';
    }).finally(() => {delete button.dataset.eventOpening;button.removeAttribute('aria-busy');});
  };
  const sync=()=>{
    const button=document.querySelector('.track-selection-ui .track.track-of-the-week > button');
    if(!button)return;
    const pb=button.querySelector('.personal-best');if(pb)pb.hidden=true;
    if(!button.querySelector('[data-weekly-event-note]')){
      const note=document.createElement('div');note.dataset.weeklyEventNote='';
      note.textContent='Weekly Event · Earn Event RP';
      (button.querySelector('.track-of-the-week-info')||button).append(note);
    }
    button.title='Open weekly event results. Event PBs are separate from normal PBs.';
  };
  let pending=false;const observer=new MutationObserver(()=>{if(pending)return;pending=true;requestAnimationFrame(()=>{pending=false;sync();});});
  observer.observe(document.body,{childList:true,subtree:true});sync();
  document.addEventListener('click',handler,true);
  return () => {observer.disconnect();document.removeEventListener('click',handler,true);};
}
