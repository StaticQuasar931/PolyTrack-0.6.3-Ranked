import {validateWeekly} from './kodub-schema.mjs';

function localSelection(value, base, now) {
  const current = validateWeekly(value,now);
  if (!current) return null;
  for (const [field,ext] of [['trackUrl','track'],['thumbnailUrl','webp'],['coverUrl','webp']]) {
    if (field === 'coverUrl' && current[field] === null) continue;
    if (!new RegExp('^assets/[a-f0-9]{64}\\.'+ext+'$').test(current[field])) throw Error('Invalid local weekly asset');
    current[field] = new URL(current[field],base).href;
  }
  return current;
}
export async function loadKodubWeekly({baseUrl,brokerUrl,fetcher=fetch,now=Date.now()}) {
  const base = new URL('./kodub/',baseUrl);
  let local = null;
  try {
    const response = await fetcher(new URL('current.json',base),{cache:'no-store',signal:AbortSignal.timeout(4000)});
    if (response.ok) local = localSelection(await response.json(),base,now);
  } catch { /* The live feed can recover a missing or expired local copy. */ }
  if (brokerUrl) try {
    const url = new URL('/v1/kodub-weekly',brokerUrl);
    const response = await fetcher(url,{signal:AbortSignal.timeout(8000)});
    if (!response.ok) throw Error('Kodub feed unavailable');
    const current = validateWeekly(await response.json(),now);
    if (current) for (const [field,kind] of [['trackUrl','track'],['thumbnailUrl','image'],['coverUrl','image']]) {
      if (field === 'coverUrl' && current[field] === null) continue;
      const asset = new URL(current[field]);
      if (asset.origin !== url.origin || asset.search || asset.hash || asset.username || asset.password ||
          !new RegExp('^/v1/kodub-weekly/'+kind+'/[a-f0-9]{64}$').test(asset.pathname)) throw Error('Invalid mirrored asset');
    }
    // Use committed assets only when the live selection exactly matches the capture.
    const same = current && local && ['trackId','endTime','lastModified','name','author','environment'].every(k=>current[k]===local[k]);
    return {serverTime:new Date(now).toISOString(),current:same?local:current};
  } catch { /* A transient upstream failure must not hide an unexpired capture. */ }
  return {serverTime:new Date(now).toISOString(),current:local};
}

export function combineKodubCard(document, group, selection, now=Date.now()) {
  const card = document.querySelector('.track-selection-ui .track.track-of-the-week:not(.sq-kodub-weekly)') || document.querySelector('.track-selection-ui .sq-kodub-weekly');
  if(!group)return;
  const unavailable=group.querySelector('.sq-kodub-unavailable');
  if(unavailable){
    const valid=selection&&now<Date.parse(selection.endTime);
    unavailable.hidden=!!(valid&&card);
    unavailable.querySelector('small').textContent=valid?'Loading weekly selection...':'No current track available. Reload to retry.';
  }
  if(!card)return;
  if (!selection || now >= Date.parse(selection.endTime)) { card.hidden=true; return; }
  const identity=selection.trackId+'@'+selection.endTime;
  if(card.dataset.kodubIdentity && card.dataset.kodubIdentity!==identity){card.hidden=true;return;}
  for(const old of group.querySelectorAll('.sq-kodub-weekly'))if(old!==card)old.remove();
  card.dataset.kodubIdentity=identity;
  card.hidden=false;
  if (card.parentElement !== group) {
    const section=card.parentElement;
    const heading=group.querySelector(':scope > .sq-featured-heading');
    if(heading)heading.after(card);else group.prepend(card);
    if (section.querySelector('.group-title')) section.hidden=true;
  }
  card.classList.add('sq-kodub-weekly');
  const button=card.querySelector(':scope > button');
  if (button && !button.querySelector('.sq-kodub-label')) {
    const label=document.createElement('small');label.className='sq-kodub-label';label.textContent='WEEKLY SPOTLIGHT';
    button.prepend(label);
    const cycle=document.createElement('small');cycle.className='sq-kodub-cycle';cycle.textContent="Separate Kodub weekly reset";button.querySelector('.track-of-the-week-info')?.append(cycle);
  }
}
