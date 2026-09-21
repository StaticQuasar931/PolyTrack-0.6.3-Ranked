import {archivePeriodCounts,catalogArchivePeriods,mountArchiveView} from './archive-view.mjs';
import {preparePublishedEventGhost} from './public-replay.mjs';
import {eventFinishPlace} from './placement.mjs';
import {createEventSession,keepEventBest} from './session.mjs';
import {installNativeLocalBinding} from './native-binding.mjs';
import {installFinishCapture} from './native-finish.mjs';
import {prepareOwnEventGhost} from './native-replay.mjs';
const STORE='polytrack-062-events-v1',QUEUE=STORE+'-queue',BEST=STORE+'-best';
const REPLAYS=STORE+'-replays',PROFILE_CACHE='polytrack-0.6.2-s1-overall-snapshot-v5';
const ROLLING_TRACK_ID='fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
const PERMANENT_ROLLING=Object.freeze({id:'permanent-rolling-hills',kind:'permanent',trackId:ROLLING_TRACK_ID,trackName:'Rolling Hills Racer',maxRp:1001,permanent:true});
export function liveTimedEventPeriods(periods,at=Date.now()){
  const unique=new Map();
  for(const period of (Array.isArray(periods)?periods:[]))if(period?.id&&period.id!==PERMANENT_ROLLING.id&&period.kind!=='permanent'&&period.enabled!==false&&!period.archived&&period.startsAt<=at&&period.endsAt>at&&!unique.has(period.id))unique.set(period.id,period);
  const order={kodub:0,weekly:1,daily:2};
  return [...unique.values()].sort((a,b)=>(order[a.kind]??3)-(order[b.kind]??3)||a.endsAt-b.endsAt||String(a.id).localeCompare(String(b.id)));
}
const read=(key,fallback)=>{try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}};
const write=(key,value)=>localStorage.setItem(key,JSON.stringify(value));
const cacheWrite=(key,value)=>{try{write(key,value);}catch{/* Cache storage is optional; never discard a successful cloud read. */}};
const eventName=kind=>kind==='kodub'?'Kodub weekly':kind==='weekly'?'Weekly':kind==='daily'?'Daily':'Event';
const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const EVENT_RECORD_HASH=/^[a-f0-9]{64}$/,EVENT_RECORD_LIMIT=200;
export function readEventPlacementSettings(storage=globalThis.localStorage){
  try{return {enabled:storage?.getItem('polytrack-0.6.2-pb-podiums')!=='0',policy:storage?.getItem('polytrack-0.6.2-pb-podiums-verified-only')==='1'?'verified':'all'};}
  catch{return {enabled:true,policy:'all'};}
}
export function eventRecordPlacement({board,period,accountId,timeMs,policy='all'}={}){
  if(!EVENT_RECORD_HASH.test(accountId||'')||!Number.isSafeInteger(timeMs)||timeMs<=0||!board||board.period?.id!==period?.id||board.period?.trackId!==period?.trackId||!Number.isSafeInteger(board.updatedAt)||board.updatedAt<0||!Array.isArray(board.entries))return null;
  const declared=Number(period?.entrantLimit),limit=Number.isSafeInteger(declared)&&declared>0&&declared<=EVENT_RECORD_LIMIT?declared:EVENT_RECORD_LIMIT;
  if(board.entries.length>limit)return null;
  const published=[],accounts=new Set();
  for(const row of board.entries){
    if(!EVENT_RECORD_HASH.test(row?.accountId||'')||accounts.has(row.accountId)||!Number.isSafeInteger(row.timeMs)||row.timeMs<=0||!Number.isSafeInteger(row.rank)||row.rank<=0)return null;
    accounts.add(row.accountId);published.push({accountId:row.accountId,timeMs:row.timeMs,rank:row.rank,pending:false});
  }
  published.sort((a,b)=>a.timeMs-b.timeMs||a.accountId.localeCompare(b.accountId));
  let expectedRank=0;
  for(let index=0;index<published.length;index++){if(!index||published[index].timeMs!==published[index-1].timeMs)expectedRank=index+1;if(published[index].rank!==expectedRank)return null;}
  const byAccount=new Map(published.map(row=>[row.accountId,row]));
  if(policy!=='verified'){
    const pending=board.pendingPlaybacks??[];
    if(!Array.isArray(pending)||pending.length>limit)return null;
    const pendingAccounts=new Set(),runIds=new Set();
    for(const row of pending){
      if(!EVENT_RECORD_HASH.test(row?.accountId||'')||pendingAccounts.has(row.accountId)||!EVENT_RECORD_HASH.test(row.runId||'')||runIds.has(row.runId)||!Number.isSafeInteger(row.timeMs)||row.timeMs<=0||row.verificationStatus!=='waiting'||row.pending!==true||row.verified!==false||row.eventRpEligible!==false||row.source!=='pending-event-playback')return null;
      pendingAccounts.add(row.accountId);runIds.add(row.runId);const prior=byAccount.get(row.accountId);
      if(!prior||row.timeMs<prior.timeMs)byAccount.set(row.accountId,{accountId:row.accountId,timeMs:row.timeMs,pending:true});
    }
  }
  if(byAccount.size>limit)return null;
  const rows=[...byAccount.values()].sort((a,b)=>a.timeMs-b.timeMs||a.accountId.localeCompare(b.accountId));
  const own=rows.find(row=>row.accountId===accountId&&row.timeMs===timeMs);
  if(!own||policy==='verified'&&own.pending)return null;
  const rank=1+rows.filter(row=>row.timeMs<timeMs).length;
  return Object.freeze({rank,fieldSize:null,knownFieldSize:rows.length,provisional:rows.some(row=>row.pending),policy:policy==='verified'?'verified':'all'});
}
export function eventPlacementPresentation(place){
  if(!place||!Number.isSafeInteger(place.rank)||place.rank<=0)return null;
  const podium=['','gold','silver','bronze'][place.rank]||'';
  const title=(place.provisional?`Provisional event place #${place.rank} from verified and waiting snapshot records. `:`Verified event place #${place.rank}. `)+'Complete field size is unavailable.';
  return Object.freeze({text:`#${place.rank}${place.provisional?'*':''}`,className:'sq-event-place'+(podium?' '+podium:''),title,ariaLabel:title});
}
export function eventTrackName(period,lookup){
  const publicName=typeof period?.trackName==='string'?period.trackName.trim():'';
  let catalogName='';try{catalogName=String(lookup?.(period?.trackId)?.name||'').trim();}catch{}
  const label=typeof period?.label==='string'?period.label.trim():'';
  return publicName||catalogName||label||'Event track';
}
export function ensureFeaturedSection(document){
  const nav=document.querySelector('.track-selection-ui .community-track-versions');
  if(!nav)return null;
  let section=nav.parentElement.querySelector(':scope > .sq-featured-events');
  if(!section){
    section=document.createElement('section');section.className='sq-featured-events sq-event-track-group';
    section.setAttribute('aria-label','Events');
    const heading=document.createElement('h2');heading.className='sq-featured-heading';heading.textContent='Events';section.append(heading);
    const unavailable=document.createElement('div');unavailable.className='sq-kodub-unavailable';unavailable.textContent="Kodub's Track of the Week";
    const note=document.createElement('small');note.textContent='Loading weekly selection...';unavailable.append(note);section.append(unavailable);
    nav.before(section);
  }
  const rolling=document.querySelector('.track-selection-ui img[src*="rolling_hills_racer"]')?.closest('.track');
  if(rolling&&rolling.parentElement!==section){
    rolling.classList.add('sq-permanent-track');section.append(rolling);
    const note=document.createElement('small');note.className='sq-permanent-note';
    note.textContent='Normal RP + up to 1001 Event RP / No reset';rolling.querySelector(':scope > button')?.append(note);
  }
  const custom=[...nav.querySelectorAll('button')].find(button=>button.textContent.trim()==='StaticQuasar931');
  if(custom){
    // Retain the native node so existing track-launch lookups can still use it.
    if(custom.classList.contains('selected'))[...nav.querySelectorAll('button')].find(button=>button.textContent.trim()==='0.6.3')?.click();
    if(!custom.hidden)custom.hidden=true;if(custom.getAttribute('aria-hidden')!=='true')custom.setAttribute('aria-hidden','true');if(custom.tabIndex!==-1)custom.tabIndex=-1;
  }
  return section;
}
export function installEvents(bridge){
  const sessions=createEventSession();let capture=null,catalog=read(STORE,{periods:[],archives:[]}),catalogAt=0,fetching=null,flushing=false,retryAt=0,dialog=null,returnFocus=null,selected=null,requestId=0,entryRequest=0;
  let statusText='',latestFinish=null,permanent=read(STORE+'-permanent',null),permanentAt=0,permanentFetching=null;
  const cache=new Map(),knownPeriods=new Map();let lastInline='';let bestRecords=read(BEST,{}),hasPending=read(QUEUE,[]).length>0;
  const now=()=>Date.now();
  const activePeriods=()=>liveTimedEventPeriods(catalog.periods,now());
  const livePeriods=activePeriods;
  const info=id=>{const p=[...knownPeriods.values(),...(catalog.periods||[]),...(catalog.archives||[])].find(p=>p.trackId===id&&p.trackName);return p?{...bridge.trackInfo(id),name:p.trackName}:bridge.trackInfo(id);};
  const periodName=period=>eventTrackName(period,info);
  const time=ms=>Number.isFinite(ms)&&ms>0?bridge.formatTime(ms):'No event time';
  const localBest=period=>bestRecords[period.id+'_'+bridge.accountId()];
  const displayName=row=>bridge.displayName?.(row.accountId,row.name)||row.name||'Racer';
  const reset=p=>new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(p.endsAt)+' Local';
  function storeCatalog(value){if(!value||!Array.isArray(value.periods))throw Error('Event catalog is unavailable.');catalog=value;cacheWrite(STORE,value);catalogAt=now();return value;}
  async function loadPermanent(){
    if(typeof bridge.readPermanent!=='function')return permanent;
    if(permanentFetching)return permanentFetching;
    if(now()-permanentAt<120000)return permanent;
    permanentAt=now();permanentFetching=bridge.readPermanent().then(value=>{
      if(value?.id!=='permanent-rolling-hills'||value.complete!==true||!Array.isArray(value.entries)||value.maxRp!==1001)throw Error('Incomplete permanent event standings');
      if(!permanent||value.sourceRevision>=permanent.sourceRevision){permanent=value;cacheWrite(STORE+'-permanent',value);}
      return permanent;
    }).catch(()=>permanent).finally(()=>{permanentFetching=null;tick();});
    return permanentFetching;
  }
  async function loadCatalog(force=false){
    if(fetching)return fetching;if(!force&&catalogAt&&now()-catalogAt<120000)return catalog;
    fetching=bridge.readCatalog().then(storeCatalog).catch(error=>{catalogAt=now();if(!catalog.periods?.length)throw error;return catalog;}).finally(()=>fetching=null);
    return fetching;
  }
  async function snapshot(period,force=false){
    const valid=value=>value&&Array.isArray(value.entries)&&value.period?.id===period.id&&value.period.trackId===period.trackId&&value.period.kind===period.kind&&Number.isSafeInteger(value.updatedAt)&&value.updatedAt>=0;
    const candidate=cache.get(period.id)||read(STORE+'-'+period.id,null),saved=valid(candidate)?candidate:null;
    if(!force&&saved&&now()-saved.fetchedAt<120000)return saved;
    try{const value=await bridge.readSnapshot(period.id);if(!valid(value))throw Error('Invalid event snapshot');const current=cache.get(period.id)||saved;if(valid(current)&&current.updatedAt>value.updatedAt)return current;const next={...value,fetchedAt:now(),saved:false};cache.set(period.id,next);cacheWrite(STORE+'-'+period.id,next);return next;}
    catch(error){if(saved){const fallback={...saved,saved:true};cache.set(period.id,fallback);return fallback;}throw error;}
  }
  function message(text){statusText=text;for(const status of document.querySelectorAll('.sq-event-status,.sq-event-inline-status'))status.textContent=text;}
  async function flush(){
    if(!hasPending||flushing||now()<retryAt||navigator.onLine===false)return;
    flushing=true;
    try{
      for(const run of read(QUEUE,[])){
        if(run.accountId!==bridge.accountId())continue;
        if(now()>=run.endsAt){message('An offline event run missed the closing time. Your normal PB is unchanged.');write(QUEUE,read(QUEUE,[]).filter(row=>row.attemptId!==run.attemptId));continue;}
        try{await bridge.submit(run);write(QUEUE,read(QUEUE,[]).filter(row=>row.attemptId!==run.attemptId));message('Event PB submitted. Waiting for replay verification.');cache.delete(run.periodId);}
        catch(error){retryAt=now()+60000;message('Event PB saved on this device. Cloud submission will retry.');break;}
      }
    }finally{hasPending=read(QUEUE,[]).length>0;flushing=false;}
  }
  function captured(run){
    const eventRun=sessions.finish(run);if(!eventRun)return;
    latestFinish=eventRun;
    const best=bestRecords,key=eventRun.periodId+'_'+eventRun.accountId;
    if(best[key]&&best[key].timeMs<=eventRun.timeMs)return;
    write(QUEUE,keepEventBest(read(QUEUE,[]),eventRun));hasPending=true;
    best[key]={timeMs:eventRun.timeMs,attemptId:eventRun.attemptId,carStyle:eventRun.carStyle,at:now()};write(BEST,best);
    const replays=read(REPLAYS,[]);cacheWrite(REPLAYS,[{...eventRun,at:now()},...(Array.isArray(replays)?replays:[]).filter(row=>row.periodId!==eventRun.periodId||row.accountId!==eventRun.accountId)].slice(0,8));
    message('New event PB saved locally.');tick();void flush();
  }
  function ensureCapture(){
    if(capture)return;
    const require=bridge.require();if(!require)throw Error('The game is still loading. Try again.');
    const binding=installNativeLocalBinding({require,onError:()=>{if(sessions.current())message('Event recording is not ready. Reopen this event and restart the race.');}});
    try{capture=installFinishCapture({Car:binding.Car,bindCar:car=>{const context=binding.bindCar(car);if(context){latestFinish=null;sessions.bind(context);}return context;},validateFinish:binding.validateFinish,onFinish:captured,onError:()=>message('Event recording could not be captured. Your normal PB still saves.')});}
    catch(error){binding.stop();throw error;}
  }
  async function race(period,{direct=false}={}){
    if(direct)close();
    shell();selected=period;body('<p role="status">Opening event...</p><p>You can cancel with Close. Your saved PBs are unchanged.</p>');message('Preparing event racing.');
    const attempt=++entryRequest,accountId=bridge.accountId();
    let timer;
    try{if(now()>=period.endsAt)throw Error('This event has ended.');await Promise.race([bridge.ready(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Event preparation timed out. Close and try again.')),12000);})]);if(attempt!==entryRequest||accountId!==bridge.accountId()||!dialog||selected?.id!==period.id)return false;ensureCapture();eventIntent=sessions.enter(period,bridge.accountId());close();message('Opening event track...');nativeOpenPermit=true;try{bridge.openTrack(period.trackId);}finally{nativeOpenPermit=false;}tick();void refreshNativeEventData(period,sessions.current());return true;}
    catch(error){if(attempt===entryRequest)message(error.message);return false;}finally{clearTimeout(timer);}
  }
  async function openEvent({kind,trackId}={}){
    sessions.leave();eventIntent=null;tick();
    shell();selectView('home');selected=null;const token=++requestId;
    body('<p>Checking the live event assignment...</p>');
    try{
      if(!['daily','weekly','kodub'].includes(kind)||!/^[a-f0-9]{64}$/.test(trackId||''))throw Error('Invalid event assignment.');
      await loadCatalog();if(!dialog||token!==requestId)return false;
      const matches=activePeriods().filter(p=>p.kind===kind&&p.trackId===trackId);
      if(matches.length!==1){body('<p>No unique active '+escape(kind)+' event is assigned to this track. The featured track may differ from the live event.</p>');return false;}
      knownPeriods.set(matches[0].id,matches[0]);return await race(matches[0],{direct:true});
    }catch{if(dialog&&token===requestId)body('<p>The live event assignment could not be checked. No event race was opened.</p>');return false;}
  }
  function close(){entryRequest++;if(!dialog)return;dialog.remove();dialog=null;selected=null;requestId++;returnFocus?.isConnected&&returnFocus.focus({preventScroll:true});}
  function shell(){
    if(dialog)return;
    returnFocus=document.activeElement;dialog=document.createElement('div');dialog.className='sq-events-overlay';dialog.innerHTML='<section class="sq-events-dialog" role="dialog" aria-modal="true" aria-labelledby="sqEventsTitle"><header><h2 id="sqEventsTitle">Events</h2><button type="button" class="button" data-event-close>Close</button></header><nav><button type="button" class="button" data-event-home>Live events</button><button type="button" class="button" data-event-totals>Event RP</button><button type="button" class="button" data-event-archives>Past events</button></nav><p class="sq-event-status" role="status" aria-live="polite"></p><main></main></section>';document.body.append(dialog);
    dialog.addEventListener('click',e=>{if(e.target===dialog||e.target.closest('[data-event-close]'))return close();if(e.target.closest('[data-event-home]'))void open();if(e.target.closest('[data-event-totals]'))void totals();if(e.target.closest('[data-event-archives]'))void archives();if(e.target.closest('[data-event-month-go]'))void archives(dialog.querySelector('[data-event-month]').value);if(e.target.closest('[data-event-permanent]'))return void openPermanent();const card=e.target.closest('[data-event-id]');if(card){const period=knownPeriods.get(card.dataset.eventId)||[...(catalog.periods||[]),...(catalog.archives||[])].find(p=>p.id===card.dataset.eventId);if(period)void openPeriod(period);}if(e.target.closest('[data-event-race]')&&selected)void race(selected);if(e.target.closest('[data-event-refresh]')&&selected&&now()<selected.endsAt)void openPeriod(selected,true);if(e.target.closest('[data-event-practice]')&&selected)void practice(selected);});
    dialog.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}if(e.key==='Tab'){const buttons=[...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled])')].filter(e=>e.getClientRects().length);const first=buttons[0],last=buttons.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
    dialog.querySelector('[data-event-close]').focus();
  }
  const body=html=>{if(!dialog)return;const main=dialog.querySelector('main');const restore=main.contains(document.activeElement);main.innerHTML=html;if(restore)dialog.querySelector('[data-event-close]').focus({preventScroll:true});};
  function displayedRecordPlacement(period,own,board){
    const settings=readEventPlacementSettings();
    return settings.enabled&&own?eventRecordPlacement({board,period,accountId:bridge.accountId(),timeMs:own.timeMs,policy:settings.policy}):null;
  }
  function recordMarkup(period){
    const {rows,board}=eventDisplayRows(period),own=rows.find(row=>row.accountId===bridge.accountId());
    if(!own)return 'No record';
    const presentation=eventPlacementPresentation(displayedRecordPlacement(period,own,board));
    return '<time>'+time(own.timeMs)+'</time>'+(presentation?'<span class="'+presentation.className+'" title="'+presentation.title+'" aria-label="'+presentation.ariaLabel+'">'+presentation.text+'</span>':own.pending?' <small>Pending</small>':'');
  }
  function cards(periods){periods.forEach(p=>knownPeriods.set(p.id,p));return periods.map(p=>`<button type="button" class="sq-event-card" data-event-id="${escape(p.id)}" data-event-kind="${escape(p.kind)}"><span class="sq-event-thumb">${bridge.thumbnail(p.trackId)}</span><div class="sq-event-record">${recordMarkup(p)}</div><span><small>${escape(p.kind==='daily'?'DAILY EVENT':p.kind==='weekly'?'WEEKLY EVENT':p.kind==='kodub'?'KODUB WEEKLY':p.label||'EVENT')}</small><strong>${escape(periodName(p))}</strong><span>Up to ${Number(p.maxRp)||0} Event RP</span>${Number.isInteger(p.entrantLimit)?`<small>Up to ${p.entrantLimit} racers</small>`:''}<small>${now()<p.endsAt?'Ends':'Ended'} ${escape(reset(p))}</small></span></button>`).join('');}
  function permanentCard(){
    const counts=archivePeriodCounts(PERMANENT_ROLLING,permanent),own=counts.verifiedEntries.find(row=>row.accountId===bridge.accountId());
    const record=own?'<time>'+time(own.timeMs)+'</time><small>'+Number(own.rp||0)+' Event RP</small>':'No record';
    return `<button type="button" class="sq-event-card sq-event-permanent" data-event-permanent><span class="sq-event-thumb">${bridge.thumbnail(ROLLING_TRACK_ID)}</span><div class="sq-event-record">${record}</div><span><small>PERMANENT EVENT</small><strong>Rolling Hills Racer</strong><span>Normal RP + up to 1001 Event RP</span><small>No reset</small></span></button>`;
  }
  function selectView(view){entryRequest++;message('');for(const button of dialog.querySelectorAll('nav button'))button.setAttribute('aria-pressed',String(button.hasAttribute('data-event-'+view)));}
  async function open(){shell();selectView('home');selected=null;const token=++requestId;body('<p>Loading events...</p>');try{await Promise.all([loadCatalog(),loadPermanent()]);if(!dialog||token!==requestId)return;body('<p>Race through an event card to set an event time. Daily and weekly event PBs can also improve normal PBs. Kodub weekly earns Event RP only. Rolling Hills earns both through its normal verified PB. Use one racer profile per event.</p><div class="sq-event-cards">'+cards(livePeriods())+permanentCard()+'</div>');message('Event RP is separate from Overall RP.');}catch{if(token===requestId){body('<p>Events are unavailable. Normal racing and your saved PBs still work.</p>');}}}
  function receiptText(receipt,local,period){
    if(period&&Date.now()>=period.endsAt+(period.graceMs||0)&&receipt?.status==='waiting')return 'This event closed before the run could be scored.';
    if(local&&(local.timeMs<receipt?.timeMs||local.attemptId&&receipt?.attemptId!==local.attemptId&&(!receipt||local.timeMs<=receipt.timeMs)))return 'Event PB saved on this device. Waiting for its cloud status.';
    if(!receipt)return local?'Event PB saved on this device. Waiting for its cloud status.':'';
    const labels={waiting:'Waiting for replay verification.',verified:receipt.eventImproved===true?'Run verified. Event PB saved.':receipt.eventImproved===false?'Run verified. Event points unchanged.':'Run verified.',no_improvement:'An equal or faster event PB is already saved.',mismatch:'Replay did not match the submitted time. No points were added.',unavailable_final:'Verification could not finish. No points were added for this run.',expired:'This event closed before the run could be scored.',event_admission_capacity:'This event reached its submission limit. Your normal PB is safe.',event_entrant_capacity:'This event is full. Your normal PB is safe.',event_submit_rate:'This attempt arrived too soon after another run. No points were added.',events_disabled:'Event submissions are paused.'};
    return labels[receipt.status==='rejected'?receipt.reason:receipt.status]||'This submission could not be scored. Your normal PB is safe.';
  }
  function rows(entries){return entries.map(row=>`<li><b>#${Number(row.rank)||''}</b><span>${escape(displayName(row))}${row.accountId===bridge.accountId()?' <strong class="sq-event-you">YOU</strong>':''}</span><time>${time(row.timeMs)}</time><strong>${Number(row.rp)||0} RP</strong></li>`).join('');}
  async function openPermanent(){
    shell();selectView('home');selected=PERMANENT_ROLLING;const token=++requestId;body('<p>Loading permanent standings...</p>');
    await loadPermanent();if(!dialog||token!==requestId)return;
    if(!permanent){body('<p>Permanent event standings are unavailable. Normal Rolling Hills racing still works.</p>');return;}
    const counts=archivePeriodCounts(PERMANENT_ROLLING,permanent),leader=counts.winner?` · Current leader ${escape(displayName(counts.winner))} ${time(counts.winner.timeMs)}`:'';
    body(`<div class="sq-event-heading"><span class="sq-event-thumb">${bridge.thumbnail(ROLLING_TRACK_ID)}</span><div><h3>Rolling Hills Racer</h3><p>Permanent event · No reset</p><p>${counts.racers} ${counts.racers===1?'racer':'racers'}${leader}</p></div></div><div class="sq-event-actions"><button class="button" type="button" data-event-practice>Race track</button></div><p>Verified Rolling Hills personal bests earn normal RP and Event RP.</p><ol class="sq-event-results">${rows(counts.verifiedEntries)||'<li>No verified event times yet.</li>'}</ol>`);
    message('Rolling Hills uses the normal track and leaderboard.');
  }
  async function openPeriod(period,force=false){
    shell();const closed=now()>=period.endsAt;selectView(closed?'archives':'home');selected=period;const token=++requestId;body('<p>Loading event standings...</p>');
    try{
      const board=await snapshot(period,force&&!closed),receipt=await bridge.readOwnStatus?.(period.id,bridge.accountId()).catch(()=>null);
      if(!dialog||token!==requestId)return;
      period=board.period;selected=period;ownReceipts.set(period.id+'_'+bridge.accountId(),receipt);
      const local=localBest(period),published=board.entries.find(row=>row.accountId===bridge.accountId());
      const submitted=receipt&&['waiting','verified'].includes(receipt.status)&&Number.isSafeInteger(receipt.timeMs)&&receipt.timeMs>0?receipt:null;
      const provisional=local&&(!submitted||local.timeMs<=submitted.timeMs)?local:submitted;
      const isLocal=provisional&&(!published||provisional.timeMs<published.timeMs),best=isLocal?provisional:published;
      const actions=closed?'<button class="button" type="button" data-event-practice>Practice track</button>':'<button class="button" type="button" data-event-race>Race event</button><button class="button" type="button" data-event-refresh>Refresh standings</button>';
      const counts=closed?archivePeriodCounts(period,board):null,standings=counts?counts.verifiedEntries:board.entries;
      const winner=counts?.winner?` · Winner ${escape(displayName(counts.winner))} ${time(counts.winner.timeMs)}`:'';
      const archiveMeta=counts?`<p>${counts.racers} ${counts.racers===1?'racer':'racers'}${winner}</p>`:'';
      body(`<div class="sq-event-heading"><span class="sq-event-thumb">${bridge.thumbnail(period.trackId)}</span><div><h3>${escape(periodName(period))}</h3><p>${escape(reset(period))} · ${closed?'Closed':'Open'}</p>${archiveMeta}<p>Your event PB: <b>${time(best?.timeMs)}</b> ${best?(isLocal?(provisional===local?'(saved on this device)':'(submitted)'):'(published)'):''}</p></div></div><div class="sq-event-actions">${actions}</div>${receiptText(receipt,local,period)?`<p class="sq-event-receipt" role="status">${escape(receiptText(receipt,local,period))}</p>`:''}<p class="${board.saved?'sq-event-saved':''}">${board.saved?'Saved standings':board.archived?'Final standings':closed?'Finalizing standings':'Published standings'} · Only verified event runs earn points.</p><ol class="sq-event-results">${rows(standings)||'<li>No verified event times yet.</li>'}</ol>`);
      message(closed?'Final standings. Practice runs do not submit to the expired event.':'Only verified event runs earn Event RP.');
    }catch{if(token===requestId)body('<p>Event standings are unavailable. Please try again later.</p>');}
  }
  async function practice(period){
    if(period.kind==='kodub'||period.kind==='custom')return importArchived(period);
    entryRequest++;sessions.leave();eventIntent=null;close();message('Opening normal practice.');nativeOpenPermit=true;try{bridge.openTrack(period.trackId);}finally{nativeOpenPermit=false;}tick();
  }
  async function importArchived(period){
    const token=++requestId;message('Loading archived track for custom-track practice...');
    try{const code=await bridge.readArchivedTrack(period);if(token!==requestId||!dialog)return;close();bridge.importTrackCode(code);}
    catch(error){if(dialog)message(error.message||'Archived track could not be imported.');}
  }
  async function totals(){if(typeof bridge.openRankedEvents==='function'){close();await bridge.openRankedEvents();return;}shell();selectView('totals');selected=null;const token=++requestId;body('<p>Loading Event RP...</p>');try{let data;try{data=await bridge.readTotals();if(!Array.isArray(data?.entries))throw Error('Invalid standings');cacheWrite(STORE+'-totals',data);}catch(error){data=read(STORE+'-totals',null);if(!data)throw error;data={...data,saved:true};}if(!dialog||token!==requestId)return;body('<h3>Lifetime Event RP</h3><p>Top 200 racers</p>'+(data.saved?'<p class="sq-event-saved">Saved standings</p>':'')+'<p>Points earned across events. Faster event PBs replace earlier points; repeated runs do not stack.</p><ol class="sq-event-results">'+(data.entries||[]).map((row,i)=>`<li><b>#${row.rank||i+1}</b><span>${escape(row.name||'Racer')}</span><span>${Number(row.events)||0} events</span><strong>${Number(row.rp)||0} RP</strong></li>`).join('')+'</ol>'+(!data.entries.length?'<p>No Event RP earned yet. Try a live event.</p>':''));}catch{if(token===requestId)body('<p>Event RP is unavailable right now.</p>');}}
  async function archives(month=''){
    shell();selectView('archives');selected=null;const token=++requestId;body('<p>Loading past events...</p>');
    try{
      let periods;
      if(month){if(!/^\d{4}-\d{2}$/.test(month))throw Error('Choose a month');const key=STORE+'-archive-'+month;try{const data=await bridge.readArchiveMonth(month);if(!Array.isArray(data?.periods))throw Error('Invalid archive');periods=data.periods;cacheWrite(key,periods);}catch(error){periods=read(key,null);if(!periods)throw error;}}
      else{await loadCatalog();periods=catalogArchivePeriods(catalog,now());}
      if(!dialog||token!==requestId)return;
      const value=month||new Date().toISOString().slice(0,7);
      body('');
      mountArchiveView(dialog.querySelector('main'),{periods,month:value,formatTime:time,accountId:bridge.accountId(),snapshots:cache,
        resolveName:periodName,loadSnapshot:period=>snapshot(period,false),onMonthChange:month=>void archives(month),
        onOpenPeriod:period=>void openPeriod(period),renderThumbnail:period=>{const node=document.createElement('span');node.innerHTML=bridge.thumbnail(period.trackId);return node;}});
    }catch{if(token===requestId)body('<p>Past events are unavailable. Please try again.</p>');}
  }
  let nativeView=null,eventIntent=null;
  let launching=false,nativeOpenPermit=false,nativePlayPermit=false,selectedGhost=null,replayRequest=0;const replayCache=new Map();
  const carImages=new Map();let profileStyles=new Map(),profilesAt=0,rendering=0;const renderQueue=[];
  function cachedCarStyle(row,period){
    if(!profilesAt||now()-profilesAt>=120000){profilesAt=now();profileStyles=new Map();const saved=read(PROFILE_CACHE,null);for(const entry of (Array.isArray(saved?.entries)?saved.entries:[]).slice(0,1000))profileStyles.set(entry.accountId||entry.userId,entry.carStyle);}
    const candidates=[window.__polytrackCarStyleByUser062?.[row.accountId],row.carStyle,row.accountId===bridge.accountId()?localBest(period)?.carStyle:null,profileStyles.get(row.accountId)];
    for(const value of candidates){if(typeof value!=='string'||!value||value.length>256)continue;try{if(bridge.require()?.(8724)?.A.deserializeSafe(value)?.serialize()===value)return value;}catch{}}
    return '';
  }
  const imageSource=value=>typeof value==='string'?value:value?.src||value?.url||value?.dataUrl||'';
  const safeImage=src=>typeof src==='string'&&/^(data:image\/(png|webp|jpeg);base64,|blob:)/.test(src);
  async function renderCar(style){
    const bounded=async invoke=>{let timer;try{return await Promise.race([Promise.resolve().then(invoke),new Promise(resolve=>{timer=setTimeout(()=>resolve(''),1500);})]);}catch{return '';}finally{clearTimeout(timer);}};
    if(typeof window.BT==='function'){const src=imageSource(await bounded(()=>window.BT(style,'')));if(safeImage(src))return src;}
    return imageSource(await bounded(()=>{const require=bridge.require(),value=require?.(8724)?.A.deserializeSafe(style),render=require?.(3787)?.F;return value&&typeof render==='function'?render(value,{addCancelCallback(){}},null):'';}));
  }
  function drainRenders(){
    while(rendering<2&&renderQueue.length){const job=renderQueue.shift();rendering++;void renderCar(job.style).then(job.resolve).finally(()=>{rendering--;drainRenders();});}
  }
  function getOwnReplay(periodId){
    const period=knownPeriods.get(periodId)||(catalog.periods||[]).find(p=>p.id===periodId),accountId=bridge.accountId();if(!period)return null;
    const best=localBest(period),rows=read(REPLAYS,[]),row=(Array.isArray(rows)?rows.slice(0,8):[]).find(row=>row&&typeof row==='object'&&row.periodId===periodId&&row.accountId===accountId&&row.trackId===period.trackId);
    if(!best||!row||typeof row.attemptId!=='string'||!row.attemptId.length||row.attemptId.length>128||row.attemptId!==best.attemptId||row.timeMs!==best.timeMs||row.frames!==row.timeMs||!Number.isSafeInteger(row.frames)||row.frames<1||row.frames>300000||typeof row.replay!=='string'||!row.replay.length||row.replay.length>65536||!/^[A-Za-z0-9_-]+$/.test(row.replay)||typeof row.carStyle!=='string'||row.carStyle.length>256)return null;
    const shown=eventDisplayRows(period).rows.find(entry=>entry.accountId===accountId);if(shown&&shown.timeMs<row.timeMs)return null;
    const receipt=ownReceipts.get(periodId+'_'+accountId);if(receipt?.attemptId===row.attemptId&&['mismatch','unavailable_final','expired','rejected'].includes(receipt.status))return null;
    return Object.freeze({...row,source:'local-event-recording'});
  }
  function renderCachedCar(button,style){
    const image=button.querySelector('.image-container img');
    const label=document.createElement('small');label.className='sq-event-car-unavailable';label.textContent='Car unavailable';image.after(label);image.hidden=true;
    image.alt='Car unavailable';image.title='No cached car available';
    if(!style)return;
    image.alt='Loading cached car';image.title='Cached profile car, not an event replay';label.textContent='Loading car';
    let pending=carImages.get(style);
    if(!pending){if(renderQueue.length>=20){image.alt='Car unavailable';label.textContent='Car unavailable';return;}pending=new Promise(resolve=>{renderQueue.push({style,resolve});});carImages.set(style,pending);if(carImages.size>200)carImages.delete(carImages.keys().next().value);drainRenders();}
    void pending.then(src=>{
      if(!button.isConnected)return;
      if(!safeImage(src)){image.alt='Car unavailable';label.textContent='Car unavailable';return;}
      image.onload=()=>{image.hidden=false;label.hidden=true;};
      image.onerror=()=>{image.alt='Car unavailable';image.hidden=true;label.hidden=false;label.textContent='Car unavailable';};
      image.src=src;image.alt='Cached profile car';
    });
  }
  async function selectReplay(period,row){
    const session=sessions.current(),viewer=bridge.accountId();if(!session||session.periodId!==period.id||typeof bridge.readReplay!=='function')return;
    const token=++replayRequest;message('Loading event replay...');
    try{
      const key=period.id+'_'+row.accountId+'_'+row.timeMs+'_'+(row.runId||'verified');
      let payload=replayCache.get(key);if(!payload)payload=await bridge.readReplay(period.id,row.accountId,row.pending?row.runId:null);
      if(token!==replayRequest||sessions.current()!==session||bridge.accountId()!==viewer)return;
      const ghost=await preparePublishedEventGhost({require:bridge.require(),row:payload,period,entry:row,viewer});
      if(token!==replayRequest||sessions.current()!==session||bridge.accountId()!==viewer)return;
      if(replayCache.size>=8)replayCache.delete(replayCache.keys().next().value);replayCache.set(key,payload);
      selectedGhost={periodId:period.id,accountId:viewer,ghost};
      message('Replay ready: '+displayName(row)+(row.pending?' (unverified)':'')+'. Play to race this ghost.');
      if(nativeView)nativeView.signature='';tick();
    }catch(error){if(token===replayRequest&&sessions.current()===session&&bridge.accountId()===viewer)message(error.message||'Event replay unavailable.');}
  }
  function raceGhosts(session){
    const replay=bridge.supportsEventGhost?.()?getOwnReplay(session.periodId):null;let ownGhost=null;
    if(replay)try{ownGhost=prepareOwnEventGhost({require:bridge.require(),row:replay,session,best:bestRecords[session.periodId+'_'+session.accountId]});}catch{}
    const selected=selectedGhost?.periodId===session.periodId&&selectedGhost.accountId===session.accountId?selectedGhost.ghost:null;
    if(selected?.isSelf)ownGhost=selected;
    return {ownGhost,opponents:selected&&!selected.isSelf?[selected]:[]};
  }
  function resumeRace(trackId,invokeNative){
    if(!eventIntent&&!sessions.current())return false;
    const session=sessions.current();
    if(!session||session.trackId!==trackId||session.accountId!==bridge.accountId()){message('This event replay cannot start a race after its event closes or racer changes.');return true;}
    try{bridge.startEventRace({...session,...raceGhosts(session)},invokeNative,()=>sessions.current()===session&&bridge.accountId()===session.accountId);}catch{message('Event race could not resume safely. Reopen Events.');}
    return true;
  }
  function watchEvent(){
    const session=sessions.current();if(!session||session.accountId!==bridge.accountId())return;
    const {ownGhost,opponents}=raceGhosts(session),ghosts=[...(ownGhost?[ownGhost]:[]),...opponents];
    if(!ghosts.length){message('Select an event replay first, or set a local event PB.');return;}
    try{bridge.watchEvent?.(session,ghosts);}catch(error){message(error.message||'Event replay could not open.');}
  }
  async function playEvent(){
    const session=sessions.current();if(!session||now()>=session.endsAt||session.accountId!==bridge.accountId()){message('This event is no longer open for this racer. Reopen Events to continue.');return;}if(launching)return;
    if(typeof bridge.startEventRace!=='function'){message('Event Play is unavailable: safe event race launch is not connected. Normal PB ghosts will not be used.');return;}
    const replay=bridge.supportsEventGhost?.()?getOwnReplay(session.periodId):null;let ownGhost=null;
    if(replay)try{ownGhost=prepareOwnEventGhost({require:bridge.require(),row:replay,session,best:bestRecords[session.periodId+'_'+session.accountId]});}catch{message('Saved event replay cannot be played safely. Starting without a ghost.');}
    const opponent=selectedGhost?.periodId===session.periodId&&selectedGhost.accountId===session.accountId?selectedGhost.ghost:null;
    if(opponent?.isSelf)ownGhost=opponent;
    const opponents=opponent&&!opponent.isSelf?[opponent]:[];
    const current=()=>sessions.current()===session&&bridge.accountId()===session.accountId&&(!ownGhost||selectedGhost?.ghost===ownGhost||replay&&getOwnReplay(session.periodId)?.attemptId===replay.attemptId&&getOwnReplay(session.periodId)?.timeMs===replay.timeMs);
    launching=true;message(opponents.length?'Starting with the selected event ghost...':ownGhost?'Starting with your event PB ghost...':'Starting event race...');
    try{await bridge.startEventRace({...session,ownGhost,opponents},()=>{
      if(sessions.current()!==session||bridge.accountId()!==session.accountId)throw Error('Event launch context changed');
      const play=nativeView?.root.querySelector('.side-panel button.play');if(!play)throw Error('Native Play is unavailable');
      nativePlayPermit=true;try{play.click();}finally{nativePlayPermit=false;}
    },current);}
    catch{if(sessions.current()===session)message('Event race could not start safely. No normal PB ghost was loaded.');}
    finally{launching=false;}
  }
  const ownReceipts=new Map();
  function clearNativeView(){
    if(!nativeView)return;
    nativeView.board.remove();nativeView.pb.remove();nativeView.pbTitle.remove();
    if(nativeView.watch)nativeView.watch.disabled=nativeView.watchDisabled;
    nativeView.opponentsNote?.remove();
    nativeView=null;
  }
  async function refreshNativeEventData(period,session){
    const accountId=bridge.accountId();
    try{await snapshot(period);const receipt=await bridge.readOwnStatus?.(period.id,accountId).catch(()=>null);if(!session||sessions.current()!==session||bridge.accountId()!==accountId)return;ownReceipts.set(period.id+'_'+accountId,receipt);if(nativeView)nativeView.signature='';syncNativeBoard(session);}
    catch{if(sessions.current()===session)message('Event standings are unavailable. Local event finishes still save.');}
  }
  function eventDisplayRows(period){
    const accountId=bridge.accountId();
    const board=cache.get(period.id)||read(STORE+'-'+period.id,null);
    const validBoard=board?.period?.id===period.id&&board.period.trackId===period.trackId&&Array.isArray(board.entries);
    const entries=validBoard?board.entries:[];
    const rows=entries.map(row=>({...row,pending:false}));
    const pending=validBoard?(board.pendingPlaybacks||board.playbacks):null;
    for(const replay of (Array.isArray(pending)?pending:[])){
      if(replay.verificationStatus!=='waiting'||replay.verified===true||!/^[a-f0-9]{64}$/.test(replay.runId||'')||!Number.isSafeInteger(replay.timeMs)||replay.timeMs<=0)continue;
      const at=rows.findIndex(row=>row.accountId===replay.accountId);
      if(at>=0&&rows[at].timeMs<=replay.timeMs)continue;
      if(at>=0)rows.splice(at,1);
      rows.push({...replay,pending:true,rank:null,rp:0});
    }
    const local=localBest(period),receipt=ownReceipts.get(period.id+'_'+accountId);
    const remote=receipt&&['waiting','verified'].includes(receipt.status)&&Number.isSafeInteger(receipt.timeMs)&&receipt.timeMs>0?receipt:null;
    const rejectedLocal=local&&receipt?.attemptId===local.attemptId&&['mismatch','unavailable_final','expired','rejected'].includes(receipt.status);
    const provisional=!rejectedLocal&&local&&(!remote||local.timeMs<=remote.timeMs)?local:remote;
    const published=rows.find(row=>row.accountId===accountId);
    if(provisional&&(!published||provisional.timeMs<published.timeMs)){
      const at=rows.findIndex(row=>row.accountId===accountId);if(at>=0)rows.splice(at,1);
      const unscored=receipt?.attemptId===provisional.attemptId&&['mismatch','unavailable_final','expired','rejected'].includes(receipt?.status);
      rows.push({accountId,name:published?.name||'You',timeMs:provisional.timeMs,pending:true,unscored,rank:null});
    }
    for(const row of rows)row.name=displayName(row);
    rows.sort((a,b)=>a.timeMs-b.timeMs||String(a.accountId).localeCompare(String(b.accountId)));
    return {rows,board};
  }
  function syncNativeBoard(session){
    const root=document.querySelector('.track-info-ui');
    if(!session||!root){clearNativeView();return;}
    const period=knownPeriods.get(session.periodId)||(catalog.periods||[]).find(p=>p.id===session.periodId);
    if(!period)return;
    const accountId=bridge.accountId();
    if(accountId!==session.accountId){clearNativeView();return;}
    if(nativeView&&(nativeView.root!==root||nativeView.periodId!==period.id||nativeView.accountId!==accountId))clearNativeView();
    if(!nativeView){
      const original=root.querySelector(':scope > .leaderboard-ui:not(.sq-event-board)');
      if(!original)return;
      if(statusText==='Opening event track...')message('');
      const board=document.createElement('div');board.className='leaderboard-ui sq-event-board';
      // Keep the original instance alive for native disposal and its Back handler.
      board.style.setProperty('display','flex','important');
      board.innerHTML='<h2>Event leaderboard</h2><h3></h3><div class="total-players fade-in"></div><div class="container"></div><div class="pages"></div><div class="button-wrapper"><button type="button" class="button back"><img class="button-icon" src="images/back.svg"> Back</button><button type="button" class="button sq-event-refresh">Refresh</button></div>';
      original.after(board);
      const pbTitle=document.createElement('div');pbTitle.className='personal-best-title sq-event-personal-title';pbTitle.textContent='Event personal best';
      const pb=document.createElement('div');pb.className='personal-best sq-event-personal';pb.style.setProperty('display','block','important');
      const side=root.querySelector('.side-panel'),normalPb=side?.querySelector('.personal-best-title');
      if(normalPb){normalPb.before(pbTitle,pb);}
      const watch=side?.querySelector('button.watch'),opponents=side?.querySelector('.opponents-container');
      const opponentsNote=document.createElement('div');opponentsNote.className='opponents-container sq-event-opponents';opponentsNote.textContent='Event ghosts are not available. Normal PB ghosts are not used.';opponents?.after(opponentsNote);
      const view=nativeView={root,board,pb,pbTitle,watch,watchDisabled:watch?.disabled,opponents,opponentsNote,periodId:period.id,accountId,page:0,signature:''};
      board.addEventListener('contextmenu',event=>event.stopPropagation());
      board.querySelector('.back').onclick=()=>{const back=original.querySelector('button.back');entryRequest++;sessions.leave();eventIntent=null;tick();back?.click();};
      board.querySelector('.sq-event-refresh').onclick=async()=>{
        const button=board.querySelector('.sq-event-refresh');button.disabled=true;
        carImages.clear();profilesAt=0;
        try{await snapshot(period,true);const receipt=await bridge.readOwnStatus?.(period.id,accountId).catch(()=>null);if(nativeView!==view||bridge.accountId()!==accountId||sessions.current()!==session)return;ownReceipts.set(period.id+'_'+accountId,receipt);view.signature='';syncNativeBoard(session);}
        catch{if(nativeView===view)message('Event standings could not refresh. Your saved event PB is unchanged.');}
        finally{button.disabled=false;}
      };
    }
    const view=nativeView;
    if(view.watch)view.watch.disabled=typeof bridge.watchEvent!=='function'||!(getOwnReplay(period.id)||selectedGhost?.periodId===period.id&&selectedGhost.accountId===accountId);
    view.opponentsNote.textContent=selectedGhost?.periodId===period.id?'Selected ghost: '+selectedGhost.ghost.nickname:bridge.supportsEventGhost?.()&&getOwnReplay(period.id)?'Play uses your event PB ghost. Select a published racer to load their replay.':'Select a published racer to load an event ghost. Normal PB ghosts are not used.';

    const {rows,board}=eventDisplayRows(period),mine=rows.find(row=>row.accountId===accountId),placement=eventPlacementPresentation(displayedRecordPlacement(period,mine,board));
    const receipt=ownReceipts.get(period.id+'_'+accountId);const statusDescription=receipt?receiptText(receipt,localBest(period),period):statusText;
    const styles=rows.map(row=>cachedCarStyle(row,period));
    const signature=JSON.stringify([rows,styles,typeof window.BT,view.page,board?.saved,statusDescription,placement]);if(signature===view.signature)return;view.signature=signature;
    view.board.querySelector('h3').textContent=eventName(period.kind)+' event';
    view.board.querySelector('.total-players').textContent=rows.length+(rows.length===1?' racer':' racers')+(board?.saved?' - saved standings':'');
    const count=Math.max(1,Math.ceil(rows.length/20));view.page=Math.min(view.page,count-1);
    const container=view.board.querySelector('.container');container.replaceChildren();
    for(const row of rows.slice(view.page*20,view.page*20+20)){
      const button=document.createElement('button');button.type='button';button.className='button main'+(row.accountId===accountId?' self':'');button.dataset.eventAccountId=row.accountId;const playable=(!row.pending||/^[a-f0-9]{64}$/.test(row.runId||''))&&typeof bridge.readReplay==='function';button.tabIndex=playable?0:-1;button.setAttribute('aria-disabled',String(!playable));if(playable)button.onclick=()=>void selectReplay(period,row);
      button.title=row.pending?'Watch unverified recording. It earns no points until verified.':'Load this verified event PB replay. Older recordings may be unavailable.';
      button.innerHTML='<div class="image-container"><img class="show" src="images/car_thumbnail_placeholder.png"></div><div class="left"><p class="position"></p><p class="event-time"></p></div><div class="right"><div class="name-container"><span class="name"></span></div><p class="verified-state"></p></div>';
      button.querySelector('.position').textContent=row.pending?'--':String(row.rank||'--');button.querySelector('.event-time').textContent=time(row.timeMs);button.querySelector('.name').textContent=row.name||'Racer';
      if(row.accountId===accountId){const self=document.createElement('span');self.className='self';self.textContent=' (You)';button.querySelector('.name-container').append(self);}
      const state=button.querySelector('.verified-state');state.dataset.sqRunStatus=row.pending?'unchecked':'verified';state.classList.add(row.pending?'pending':'verified');state.textContent=row.pending?(row.unscored?'Not scored':'Waiting'):(Number(row.rp)||0)+' Event RP';
      const icon=document.createElement('img');icon.src=row.pending?'images/state_pending.svg':'images/state_verified.svg';state.append(icon);container.append(button);
      renderCachedCar(button,styles[rows.indexOf(row)]);
    }
    if(!rows.length){const empty=document.createElement('p');empty.className='error-message';empty.textContent='No event times yet. Play to set your event PB.';container.append(empty);}
    const status=document.createElement('p');status.className='sq-event-inline-status';status.setAttribute('role','status');status.textContent=statusDescription;container.append(status);
    const pages=view.board.querySelector('.pages');pages.replaceChildren();
    for(let page=0;page<count;page++){const button=document.createElement('button');button.type='button';button.className='button page'+(page===view.page?' selected':'');button.textContent=String(page+1);button.onclick=()=>{view.page=page;view.signature='';syncNativeBoard(session);};pages.append(button);}
    view.pb.replaceChildren();
    for(const [icon,text] of [['timer',mine?time(mine.timeMs):'---'],['trophy',placement?.text||(mine?.pending?(mine.unscored?'Not scored':'Waiting'):'---')]]){const line=document.createElement('div'),image=document.createElement('img');image.src='images/'+icon+'.svg';if(icon==='trophy'&&placement){const badge=document.createElement('span');badge.className=placement.className;badge.title=placement.title;badge.setAttribute('aria-label',placement.ariaLabel);badge.textContent=text;line.append(image,badge);}else line.append(image,document.createTextNode(text));view.pb.append(line);}
  }

  function syncFinishPlace(){
    const root=document.querySelector('.time-announcer-ui'),session=sessions.current()||eventIntent;
    if(!root||!latestFinish||!session||latestFinish.periodId!==session.periodId||latestFinish.accountId!==bridge.accountId())return;
    const board=cache.get(session.periodId)||read(STORE+'-'+session.periodId,null);
    const place=eventFinishPlace({board,...latestFinish});
    root.querySelector('.sq-event-finish-place')?.remove();
    const current=root.querySelector('.current'),position=current?.querySelector('.position');
    if(!position)return;
    const text=place?String(place.rank):'';
    if(position.textContent!==text)position.textContent=text;
    if(current.classList.contains('show-position')!==!!place)current.classList.toggle('show-position',!!place);
    const detail=place?'Event place '+place.rank+' of '+place.fieldSize+(place.provisional?' (provisional)':''):'';
    if(position.title!==detail)position.title=detail;
  }
  function tick(){
    syncFinishPlace();
    void flush();
    const ranked=document.getElementById('overallLeaderboardPanel');
    if(ranked?.getClientRects().length&&getComputedStyle(ranked).display!=='none')void loadCatalog().catch(()=>{});
    for(const [kind,selector] of [['weekly','.weekly-cup'],['daily','.daily-card']]){
      const card=ranked?.querySelector(selector),button=card?.querySelector('.competition-feature-button');if(!button)continue;
      const matches=activePeriods().filter(p=>p.kind===kind),period=matches.length===1?matches[0]:null;
      const signature=JSON.stringify([period?.id,period?.trackId,period?.endsAt,period?.maxRp]);if(button.dataset.eventBinding===signature)continue;button.dataset.eventBinding=signature;
      button.dataset.eventKind=kind;button.dataset.eventId=period?.id||'';button.removeAttribute('data-track-id');
      const kicker=kind==='weekly'?'WEEKLY EVENT':'DAILY EVENT';card.setAttribute('aria-label',kicker);button.setAttribute('aria-label',period?'Open '+kicker+': '+info(period.trackId).name:'Browse events: '+kicker+' unavailable');
      const put=(selector,text)=>{const node=button.querySelector(selector);if(node)node.textContent=text;};
      put('.competition-kicker',kicker);put('.competition-track-name',period?info(period.trackId).name:'No active event');put('.competition-result',period?'Up to '+(Number(period.maxRp)||0)+' Event RP':'Browse Events for availability');
      const image=button.querySelector('.competition-feature-image');if(image)image.innerHTML=period?bridge.thumbnail(period.trackId):'';
      const note=card.querySelector(':scope > small');if(note){
        if(period){const options={weekday:'short',hour:'2-digit',minute:'2-digit'},local=document.createElement('strong');local.textContent=new Intl.DateTimeFormat(undefined,options).format(period.endsAt)+' Local';note.replaceChildren(document.createTextNode(new Intl.DateTimeFormat(undefined,{...options,timeZone:'UTC'}).format(period.endsAt)+' UTC'),document.createElement('br'),local);}
        else note.textContent='Browse events for availability.';
      }
      button.removeAttribute('aria-disabled');if(period)knownPeriods.set(period.id,period);
    }
    const group=ensureFeaturedSection(document);
    const kodubCard=group?.querySelector('.sq-kodub-weekly'),kodubIdentity=kodubCard?.dataset.kodubIdentity;
    if(kodubCard&&kodubIdentity){
      const [trackId,endTime]=kodubIdentity.split('@'),p=activePeriods().find(p=>p.kind==='kodub'&&p.trackId===trackId&&p.endsAt===Date.parse(endTime));
      if(kodubCard.dataset.eventTrack!==trackId)kodubCard.dataset.eventTrack=trackId;if(kodubCard.dataset.eventId!==(p?.id||''))kodubCard.dataset.eventId=p?.id||'';
      const infoNode=kodubCard.querySelector('.track-of-the-week-info');
      if(infoNode){
        let reward=infoNode.querySelector('.sq-kodub-reward');if(!reward){reward=document.createElement('small');reward.className='sq-kodub-reward';infoNode.append(reward);}
        const text=p?'Up to 700 Event RP':'Event scoring awaiting official import';if(reward.textContent!==text)reward.textContent=text;
        const pb=infoNode.querySelector('.personal-best');if(pb){const html=p?recordMarkup(p):'No record';if(pb.dataset.eventRecord!==html){pb.dataset.eventRecord=html;pb.innerHTML=html;}}
      }
    }
    if(group?.getClientRects().length){void loadCatalog().catch(()=>{});void loadPermanent();}
    const permanentNote=group?.querySelector('.sq-permanent-note');
    if(permanentNote){
      const own=permanent?.entries?.find(row=>row.accountId===bridge.accountId());
      const elapsed=own?.runAt?Math.max(0,now()-own.runAt):null;
      const age=elapsed===null?'':elapsed<60000?' / just now':elapsed<3600000?' / '+Math.floor(elapsed/60000)+'m ago':elapsed<86400000?' / '+Math.floor(elapsed/3600000)+'h ago':' / '+Math.floor(elapsed/86400000)+'d ago';
      const text=own?'Normal RP + '+own.rp+' / 1001 Event RP'+age:'Normal RP + up to 1001 Event RP / No reset';
      if(permanentNote.textContent!==text)permanentNote.textContent=text;
      permanentNote.title='Both rewards use your normal physics-verified personal best. Event RP follows the fastest verified Rolling Hills time; repeated runs do not stack.';
    }
    if(group&&!group.querySelector('.sq-events-entry')){const button=document.createElement('button');button.type='button';button.className='button sq-events-entry';button.textContent='All results';button.setAttribute('aria-label','Browse events and past results');button.addEventListener('click',e=>{e.stopPropagation();void open();});group.append(button);}
    if(group&&activePeriods().length){
      let row=group.querySelector('.sq-event-track-buttons');if(!row){row=document.createElement('div');row.className='sq-event-track-buttons';group.append(row);}if(!row.dataset.bound){row.dataset.bound='true';row.addEventListener('click',e=>{const button=e.target.closest('[data-event-id]');if(button){e.stopPropagation();const p=activePeriods().find(p=>p.id===button.dataset.eventId);if(p)void race(p,{direct:true});}});}
      const featured=activePeriods().filter(p=>['weekly','daily'].includes(p.kind)).sort((a,b)=>['weekly','daily'].indexOf(a.kind)-['weekly','daily'].indexOf(b.kind));const signature=JSON.stringify(featured.map(p=>[p.id,p.trackId,p.endsAt,p.maxRp,recordMarkup(p),bridge.accountId()]));if(row.dataset.periods!==signature){row.dataset.periods=signature;row.innerHTML=cards(featured);
        for(const kind of ['weekly','daily'])if(!featured.some(p=>p.kind===kind)){
          const button=document.createElement('button');button.className='button sq-event-card';button.type='button';button.dataset.eventKind=kind;
          button.innerHTML='<strong>'+eventName(kind)+' event</strong><small>No active event available</small>';button.onclick=()=>void open();row.append(button);
        }}
    }else if(group){
      let row=group.querySelector('.sq-event-track-buttons');
      if(!row){row=document.createElement('div');row.className='sq-event-track-buttons';group.append(row);}
      if(row.dataset.periods!=='unavailable'){
        row.dataset.periods='unavailable';row.replaceChildren();
        for(const kind of ['weekly','daily']){const button=document.createElement('button');button.className='button sq-event-card';button.type='button';button.dataset.eventKind=kind;
          const title=document.createElement('strong');title.textContent=kind==='weekly'?'Weekly event':'Daily event';
          const note=document.createElement('small');note.textContent='No active event available';button.append(title,note);button.onclick=()=>void open();row.append(button);}
      }
    }
    const session=sessions.current()||eventIntent;if(document.body.classList.contains('sq-event-active')!==!!session)document.body.classList.toggle('sq-event-active',!!session);
    syncNativeBoard(session);
  }
  document.addEventListener('click',e=>{
    const button=e.target.closest?.('button');if(!button)return;
    if(button.closest('.sq-kodub-weekly')&&!nativeOpenPermit){
      const card=button.closest('.sq-kodub-weekly');
      const period=activePeriods().find(p=>p.id===card.dataset.eventId&&p.kind==='kodub');
      if(period){e.preventDefault();e.stopImmediatePropagation();void race(period,{direct:true});}
      else{entryRequest++;sessions.leave();eventIntent=null;tick();}
      return;
    }
    if(button.matches('#overallLeaderboardPanel .weekly-cup .competition-feature-button,#overallLeaderboardPanel .daily-card .competition-feature-button')){
      e.preventDefault();e.stopImmediatePropagation();const period=activePeriods().find(p=>p.id===button.dataset.eventId&&p.kind===button.dataset.eventKind);if(period)void race(period,{direct:true});else void open();return;
    }
    if(button.matches('.track-info-ui .side-panel button.watch')&&(nativeView||eventIntent||sessions.current())){e.preventDefault();e.stopImmediatePropagation();watchEvent();return;}
    if(button.matches('.track-info-ui .side-panel button.play')&&(nativeView||eventIntent||sessions.current())&&!nativePlayPermit){e.preventDefault();e.stopImmediatePropagation();void playEvent();return;}
    if(button.closest('.sq-events-overlay,.sq-event-inline,.sq-event-board,.sq-events-entry,.sq-event-track-buttons'))return;
    if(e.isTrusted&&(button.querySelector('.track-title')||/^(Back|Exit|Multiplayer)$/.test(button.textContent.trim()))){entryRequest++;sessions.leave();eventIntent=null;tick();}
  },true);
  window.addEventListener('online',()=>void flush());
  window.addEventListener('storage',event=>{if(event.key===QUEUE){hasPending=read(QUEUE,[]).length>0;void flush();}if(event.key===PROFILE_CACHE)profilesAt=0;if(event.key===BEST){bestRecords=read(BEST,{});lastInline='';}});
  return {featuredSection:()=>ensureFeaturedSection(document),open,openEvent,totals,tick,flush,getOwnReplay,resumeRace,refreshCatalog:loadCatalog,leave(){entryRequest++;sessions.leave();eventIntent=null;tick();}};
}
