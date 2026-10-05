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
export function eventRunDate(row,at=Date.now()){
  const stamp=[row?.submittedAt,row?.receivedAt,row?.pbAt].find(value=>Number.isSafeInteger(value)&&value>0&&value<=at);
  if(!stamp)return {label:'Date unavailable',title:'This saved result has no run date.'};
  const seconds=Math.floor((at-stamp)/1000),minutes=Math.floor(seconds/60),hours=Math.floor(minutes/60),days=Math.floor(hours/24);
  return {label:days?days+' day'+(days===1?'':'s')+' ago':hours?hours+' hour'+(hours===1?'':'s')+' ago':minutes?minutes+' min ago':'Just now',title:new Date(stamp).toLocaleString()};
}
export function liveTimedEventPeriods(periods,at=Date.now()){
  const unique=new Map();
  for(const period of (Array.isArray(periods)?periods:[]))if(period?.id&&period.id!==PERMANENT_ROLLING.id&&period.kind!=='permanent'&&period.enabled!==false&&!period.archived&&period.startsAt<=at&&period.endsAt>at&&!unique.has(period.id))unique.set(period.id,period);
  const order={kodub:0,weekly:1,daily:2};
  return [...unique.values()].sort((a,b)=>(order[a.kind]??3)-(order[b.kind]??3)||a.endsAt-b.endsAt||String(a.id).localeCompare(String(b.id)));
}
export function eventCatalogFreshUntil(periods,at=Date.now(),maxAge=300000){
  const age=Number.isSafeInteger(maxAge)&&maxAge>0?maxAge:300000;
  let nextBoundary=Infinity;
  for(const period of Array.isArray(periods)?periods:[]){
    if(!period?.id||period.id===PERMANENT_ROLLING.id||period.kind==='permanent'||period.enabled===false||period.archived===true)continue;
    for(const boundary of [period.startsAt,period.endsAt])if(Number.isSafeInteger(boundary)&&boundary>at)nextBoundary=Math.min(nextBoundary,boundary);
  }
  return Math.min(at+age,nextBoundary);
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
export function eventOrdinal(rank){
  if(!Number.isSafeInteger(rank)||rank<=0)return '';
  const mod100=rank%100,suffix=mod100>=11&&mod100<=13?'th':({1:'st',2:'nd',3:'rd'}[rank%10]||'th');
  return `${rank}${suffix}`;
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
    const wrapper=nav.parentElement;wrapper.classList.add('sq-events-layout-pending');
    section=document.createElement('section');section.className='sq-featured-events sq-event-track-group';
    section.setAttribute('aria-label','Events');
    const heading=document.createElement('h2');heading.className='sq-featured-heading';heading.textContent='Events';section.append(heading);
    const unavailable=document.createElement('div');unavailable.className='sq-kodub-unavailable';unavailable.textContent="Kodub's Track of the Week";
    const note=document.createElement('small');note.textContent='Loading weekly selection...';unavailable.append(note);section.append(unavailable);
    nav.before(section);
    requestAnimationFrame(()=>wrapper.classList.remove('sq-events-layout-pending'));
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
export function handleEventCarIntersections(view,entries,renderCachedCar){
  for(const entry of entries){
    const button=entry.target;
    if(!entry.isIntersecting)continue;
    view.hiddenCarRowsReobserved?.delete(button);
    const style=view.carStyles.get(button);
    if(!style){view.carObserver?.unobserve(button);continue;}
    if(renderCachedCar(button,style))view.deferredCarRows.delete(button);
    else view.deferredCarRows.add(button);
  }
}
export function retryDeferredEventCarRenders(view,renderCachedCar){
  for(const button of view.deferredCarRows){
    if(!button.isConnected||!view.board.contains(button)){view.carObserver?.unobserve(button);view.deferredCarRows.delete(button);continue;}
    if(typeof button.getClientRects==='function'&&!button.getClientRects().length){
      view.hiddenCarRowsReobserved||=new WeakSet();
      if(!view.hiddenCarRowsReobserved.has(button)){view.hiddenCarRowsReobserved.add(button);view.carObserver?.unobserve?.(button);view.carObserver?.observe?.(button);}
      continue;
    }
    view.hiddenCarRowsReobserved?.delete(button);
    const style=view.carStyles.get(button);
    if(style&&renderCachedCar(button,style))view.deferredCarRows.delete(button);
  }
}
export function installEvents(bridge){
  const sessions=createEventSession();let capture=null,catalog=read(STORE,{periods:[],archives:[]}),catalogAt=0,catalogFreshUntil=0,fetching=null,flushing=false,retryAt=0,dialog=null,returnFocus=null,selected=null,requestId=0,entryRequest=0;
  let statusText='',latestFinish=null,permanent=read(STORE+'-permanent',null),permanentAt=0,permanentFetching=null;
  const cache=new Map(),snapshotFetching=new Map(),knownPeriods=new Map();let lastInline='';let bestRecords=read(BEST,{}),hasPending=read(QUEUE,[]).length>0;
  const now=()=>Date.now();
  const activePeriods=()=>liveTimedEventPeriods(catalog.periods,now());
  const livePeriods=activePeriods;
  const info=id=>{const p=[...knownPeriods.values(),...(catalog.periods||[]),...(catalog.archives||[])].find(p=>p.trackId===id&&p.trackName);return p?{...bridge.trackInfo(id),name:p.trackName}:bridge.trackInfo(id);};
  const periodName=period=>eventTrackName(period,info);
  const time=ms=>Number.isFinite(ms)&&ms>0?bridge.formatTime(ms):'No event time';
  const localBest=period=>bestRecords[period.id+'_'+bridge.accountId()];
  const displayName=row=>bridge.displayName?.(row.accountId,row.name)||row.name||'Racer';
  const reset=p=>new Intl.DateTimeFormat(undefined,{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(p.endsAt)+' Local';
  function storeCatalog(value){if(!value||!Array.isArray(value.periods))throw Error('Event catalog is unavailable.');catalog=value;cacheWrite(STORE,value);catalogAt=now();catalogFreshUntil=eventCatalogFreshUntil(value.periods,catalogAt);return value;}
  async function loadPermanent(){
    if(typeof bridge.readPermanent!=='function')return permanent;
    if(permanentFetching)return permanentFetching;
    if(now()-permanentAt<300000)return permanent;
    permanentAt=now();permanentFetching=bridge.readPermanent().then(value=>{
      if(value?.id!=='permanent-rolling-hills'||value.complete!==true||!Array.isArray(value.entries)||value.maxRp!==1001)throw Error('Incomplete permanent event standings');
      if(!permanent||value.sourceRevision>=permanent.sourceRevision){permanent=value;cacheWrite(STORE+'-permanent',value);}
      return permanent;
    }).catch(()=>permanent).finally(()=>{permanentFetching=null;tick();});
    return permanentFetching;
  }
  async function loadCatalog(force=false){
    if(fetching)return fetching;if(!force&&catalogAt&&now()<catalogFreshUntil)return catalog;
    fetching=bridge.readCatalog().then(storeCatalog).catch(error=>{catalogAt=now();catalogFreshUntil=eventCatalogFreshUntil(catalog.periods,catalogAt);if(!catalog.periods?.length)throw error;return catalog;}).finally(()=>{fetching=null;tick();});
    return fetching;
  }
  async function snapshot(period,force=false){
    const valid=value=>value&&Array.isArray(value.entries)&&value.period?.id===period.id&&value.period.trackId===period.trackId&&value.period.kind===period.kind&&Number.isSafeInteger(value.updatedAt)&&value.updatedAt>=0;
    const candidate=cache.get(period.id)||read(STORE+'-'+period.id,null),saved=valid(candidate)?candidate:null;
    if(!force&&saved&&now()-saved.fetchedAt<120000)return saved;
    if(snapshotFetching.has(period.id))return snapshotFetching.get(period.id);
    const confirmSchedulePeriod=value=>{
      const confirmed=value.period,index=(catalog.periods||[]).findIndex(item=>item.id===confirmed.id&&item.scheduleOnly===true&&item.trackId===confirmed.trackId&&item.kind===confirmed.kind);
      if(index<0)return;
      const enriched={...catalog.periods[index],...confirmed,scheduleOnly:false};
      knownPeriods.set(enriched.id,enriched);
      catalog={...catalog,periods:catalog.periods.map((item,i)=>i===index?enriched:item)};
      cacheWrite(STORE,catalog);catalogAt=now();catalogFreshUntil=eventCatalogFreshUntil(catalog.periods,catalogAt);
    };
    const pending=(async()=>{
      try{const value=await bridge.readSnapshot(period.id);if(!valid(value))throw Error('Invalid event snapshot');confirmSchedulePeriod(value);const current=cache.get(period.id)||saved;if(valid(current)&&current.updatedAt>value.updatedAt)return current;const next={...value,fetchedAt:now(),saved:false};cache.set(period.id,next);cacheWrite(STORE+'-'+period.id,next);return next;}
      catch(error){if(saved){const fallback={...saved,saved:true};cache.set(period.id,fallback);return fallback;}throw error;}
      finally{if(snapshotFetching.get(period.id)===pending)snapshotFetching.delete(period.id);}
    })();
    snapshotFetching.set(period.id,pending);
    return pending;
  }
  function message(text){statusText=text;for(const status of document.querySelectorAll('.sq-event-status,.sq-event-inline-status'))if(status.textContent!==text)status.textContent=text;}
  async function flush(){
    if(!hasPending||flushing||now()<retryAt||navigator.onLine===false)return;
    flushing=true;
    try{
      for(const run of read(QUEUE,[])){
        if(run.accountId!==bridge.accountId())continue;
        if(now()>=run.endsAt){message('An offline event run missed the closing time. Your normal PB is unchanged.');write(QUEUE,read(QUEUE,[]).filter(row=>row.attemptId!==run.attemptId));continue;}
        try{await bridge.submit(run);write(QUEUE,read(QUEUE,[]).filter(row=>row.attemptId!==run.attemptId));message('Event PB submitted. Waiting for replay verification.');cache.delete(run.periodId);ownReceiptAt.delete(run.periodId+'_'+run.accountId);ownReceipts.delete(run.periodId+'_'+run.accountId);}
        catch(error){retryAt=now()+60000;message('Event PB saved on this device. Cloud submission will retry.');break;}
      }
    }finally{hasPending=read(QUEUE,[]).length>0;flushing=false;}
  }
  function captured(run){
    const eventRun=sessions.finish(run);if(!eventRun)return;
    latestFinish=eventRun;
    const best=bestRecords,key=eventRun.periodId+'_'+eventRun.accountId;
    if(best[key]&&best[key].timeMs<=eventRun.timeMs)return;
    ownReceiptAt.delete(key);
    ownReceipts.delete(key);
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
    archiveIntent=null;if(direct)close();
    shell();selected=period;body('<p role="status">Opening event...</p><p>You can cancel with Close. Your saved PBs are unchanged.</p>');message('Preparing event racing.');
    const attempt=++entryRequest,accountId=bridge.accountId();
    let timer;
    try{if(now()>=period.endsAt)throw Error('This event has ended.');await Promise.race([bridge.ready(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Event preparation timed out. Close and try again.')),12000);})]);if(attempt!==entryRequest||accountId!==bridge.accountId()||!dialog||selected?.id!==period.id)return false;ensureCapture();eventIntent=sessions.enter(period,bridge.accountId());close();message('Opening event track...');nativeOpenPermit=true;try{await bridge.openTrack(period.trackId);}finally{nativeOpenPermit=false;}tick();void refreshNativeEventData(period,sessions.current());return true;}
    catch(error){if(attempt===entryRequest||eventIntent?.periodId===period.id){sessions.leave();eventIntent=null;shell();message(error.message);body('<p>The event track could not be opened. Your saved records are unchanged.</p>');}return false;}finally{clearTimeout(timer);}
  }
  async function openEvent({kind,trackId}={}){
    archiveIntent=null;sessions.leave();eventIntent=null;tick();
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
    dialog.addEventListener('click',e=>{if(e.target===dialog||e.target.closest('[data-event-close]'))return close();if(e.target.closest('[data-event-home]'))void open();if(e.target.closest('[data-event-totals]'))void totals();if(e.target.closest('[data-event-archives]'))void archives();if(e.target.closest('[data-event-month-go]'))void archives(dialog.querySelector('[data-event-month]').value);if(e.target.closest('[data-event-permanent]'))return void openPermanent();const card=e.target.closest('[data-event-id]');if(card){const period=knownPeriods.get(card.dataset.eventId)||[...(catalog.periods||[]),...(catalog.archives||[])].find(p=>p.id===card.dataset.eventId);if(period){if(period.scheduleOnly)void openPeriod(period);else if(period.startsAt<=now()&&period.endsAt>now())void race(period,{direct:true});else void openPeriod(period);}}if(e.target.closest('[data-event-race]')&&selected)void race(selected);if(e.target.closest('[data-event-refresh]')&&selected&&now()<selected.endsAt)void openPeriod(selected,true);if(e.target.closest('[data-event-practice]')&&selected)void practice(selected);});
    dialog.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}if(e.key==='Tab'){const buttons=[...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled])')].filter(e=>e.getClientRects().length);const first=buttons[0],last=buttons.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
    dialog.querySelector('[data-event-close]').focus();
  }
  const body=html=>{if(!dialog)return;const main=dialog.querySelector('main');const restore=main.contains(document.activeElement);main.innerHTML=html;if(restore)dialog.querySelector('[data-event-close]').focus({preventScroll:true});};
  function displayedRecordPlacement(period,own,board,filterResult){
    const settings=readEventPlacementSettings();
    if(settings.enabled&&own&&filterResult?.active&&filterResult.groupGrading)return {rank:own.groupRank,fieldSize:filterResult.rows.length,knownFieldSize:filterResult.rows.length,provisional:board?.complete!==true,policy:settings.policy};
    return settings.enabled&&own?eventRecordPlacement({board,period,accountId:bridge.accountId(),timeMs:own.timeMs,policy:settings.policy}):null;
  }
  function recordMarkup(period){
    if(period?.scheduleOnly){const own=localBest(period);return own?'<time>'+time(own.timeMs)+'</time><small>Awaiting server status</small>':'<small>Awaiting server assignment</small>';}
    const {rows,board,filterResult,sourceOwn}=eventDisplayRows(period),shown=rows.find(row=>row.accountId===bridge.accountId()),own=shown||sourceOwn;
    if(!own)return 'No record';
    const presentation=shown?eventPlacementPresentation(displayedRecordPlacement(period,own,board,filterResult)):null;
    return '<time>'+time(own.timeMs)+'</time>'+(presentation?'<span class="'+presentation.className+'" title="'+presentation.title+'" aria-label="'+presentation.ariaLabel+'">'+presentation.text+'</span>':own.pending?' <small>Pending</small>':'');
  }
  function cards(periods){periods.forEach(p=>knownPeriods.set(p.id,p));return periods.map(p=>`<button type="button" class="sq-event-card" data-event-id="${escape(p.id)}" data-event-kind="${escape(p.kind)}"><span class="sq-event-thumb">${bridge.thumbnail(p.trackId)}</span><div class="sq-event-record">${recordMarkup(p)}</div><span><small>${escape(p.kind==='daily'?'DAILY EVENT':p.kind==='weekly'?'WEEKLY EVENT':p.kind==='kodub'?'KODUB WEEKLY':p.label||'EVENT')}</small><strong>${escape(periodName(p))}</strong><span>Up to ${Number(p.maxRp)||0} Event RP</span>${p.scheduleOnly?'<small>Awaiting official server assignment</small>':''}${Number.isInteger(p.entrantLimit)?`<small>Up to ${p.entrantLimit} racers</small>`:''}<small>${now()<p.endsAt?'Ends':'Ended'} ${escape(reset(p))}</small></span></button>`).join('');}
  function permanentCard(loading=false){
    const counts=archivePeriodCounts(PERMANENT_ROLLING,permanent),own=counts.verifiedEntries.find(row=>row.accountId===bridge.accountId());
    const record=own?'<time>'+time(own.timeMs)+'</time><small>'+Math.round(Number(own.rp)||0)+' Event RP</small>':loading?'<small>Loading verified record...</small>':'No verified record';
    return `<button type="button" class="sq-event-card sq-event-permanent" data-event-permanent><span class="sq-event-thumb">${bridge.thumbnail(ROLLING_TRACK_ID)}</span><div class="sq-event-record">${record}</div><span><small>PERMANENT EVENT</small><strong>Rolling Hills Racer</strong><span>Normal RP + up to 1001 Event RP</span><small>No reset</small></span></button>`;
  }
  function selectView(view){entryRequest++;message('');for(const button of dialog.querySelectorAll('nav button'))button.setAttribute('aria-pressed',String(button.hasAttribute('data-event-'+view)));}
  async function open(){shell();selectView('home');selected=null;const token=++requestId;body('<p>Loading events...</p>');try{await loadCatalog();if(!dialog||token!==requestId)return;body('<p>Race through an event card to set an event time. Daily and weekly event PBs can also improve normal PBs. Kodub weekly earns Event RP only. Rolling Hills earns both through its normal verified PB. Use one racer profile per event.</p><div class="sq-event-cards">'+cards(livePeriods())+permanentCard(true)+'</div>');message('Event RP is separate from Overall RP.');void loadPermanent().then(()=>{if(!dialog||token!==requestId||!dialog.querySelector('[data-event-permanent]'))return;const active=document.activeElement;if(active?.closest('[data-event-permanent]'))return;const holder=document.createElement('div');holder.innerHTML=permanentCard(false);dialog.querySelector('[data-event-permanent]')?.replaceWith(holder.firstElementChild);}).catch(()=>{});}catch{if(token===requestId){body('<p>Events are unavailable. Normal racing and your saved PBs still work.</p>');}}}
  function receiptText(receipt,local,period){
    if(period&&Date.now()>=period.endsAt+(period.graceMs||0)&&receipt?.status==='waiting')return 'This event closed before the run could be scored.';
    if(local&&(local.timeMs<receipt?.timeMs||local.attemptId&&receipt?.attemptId!==local.attemptId&&(!receipt||local.timeMs<=receipt.timeMs)))return 'Event PB saved on this device. Waiting for its cloud status.';
    if(!receipt)return local?'Event PB saved on this device. Waiting for its cloud status.':'';
    const labels={waiting:'Waiting for replay verification.',verified:receipt.eventImproved===true?'Run verified. Event PB saved.':receipt.eventImproved===false?'Run verified. Event points unchanged.':'Run verified.',no_improvement:'An equal or faster event PB is already saved.',mismatch:'Replay did not match the submitted time. No points were added.',unavailable_final:'Verification could not finish. No points were added for this run.',expired:'This event closed before the run could be scored.',event_admission_capacity:'This event reached its submission limit. Your normal PB is safe.',event_entrant_capacity:'This event is full. Your normal PB is safe.',event_submit_rate:'This attempt arrived too soon after another run. No points were added.',events_disabled:'Event submissions are paused.'};
    return labels[receipt.status==='rejected'?receipt.reason:receipt.status]||'This submission could not be scored. Your normal PB is safe.';
  }
  function rows(entries){return entries.map(row=>`<li><img class="sq-event-result-verified" src="images/state_verified.svg" alt="Verified"><b>#${Number(row.rank)||''}</b><span>${escape(displayName(row))}${row.accountId===bridge.accountId()?' <strong class="sq-event-you">YOU</strong>':''}</span><time>${time(row.timeMs)}</time><strong>${Number(row.groupRp??row.rp)||0} ${row.groupRp!=null?'Group ERP':'RP'}</strong></li>`).join('');}
  async function openPermanent(){
    shell();selectView('home');selected=PERMANENT_ROLLING;const token=++requestId;body('<p>Loading permanent standings...</p>');
    await loadPermanent();if(!dialog||token!==requestId)return;
    if(!permanent){body('<p>Permanent event standings are unavailable. Normal Rolling Hills racing still works.</p>');return;}
    const counts=archivePeriodCounts(PERMANENT_ROLLING,permanent),leader=counts.winner?` · Current leader ${escape(displayName(counts.winner))} ${time(counts.winner.timeMs)}`:'';
    body(`<div class="sq-event-heading"><span class="sq-event-thumb">${bridge.thumbnail(ROLLING_TRACK_ID)}</span><div><h3>Rolling Hills Racer</h3><p>Permanent event · No reset</p><p>${counts.racers} ${counts.racers===1?'racer':'racers'}${leader}</p></div></div><div class="sq-event-actions"><button class="button" type="button" data-event-practice>Race track</button></div><p>Verified Rolling Hills personal bests earn normal RP and Event RP.</p><ol class="sq-event-results sq-event-verified-results">${rows(counts.verifiedEntries)||'<li>No verified event times yet.</li>'}</ol>`);
    message('Rolling Hills uses the normal track and leaderboard.');
  }
  async function openPeriod(period,force=false){
    if(period?.scheduleOnly)return race(period,{direct:true});
    shell();const closed=now()>=period.endsAt;selectView(closed?'archives':'home');selected=period;const token=++requestId;body('<p>Loading event standings...</p>');
    try{
      const board=await snapshot(period,force&&!closed),receipt=await readReceipt(period.id,bridge.accountId(),force&&!closed);
      if(!dialog||token!==requestId)return;
      period=board.period;selected=period;ownReceipts.set(period.id+'_'+bridge.accountId(),receipt);
      const local=localBest(period),published=board.entries.find(row=>row.accountId===bridge.accountId());
      const submitted=receipt&&['waiting','verified'].includes(receipt.status)&&Number.isSafeInteger(receipt.timeMs)&&receipt.timeMs>0?receipt:null;
      const provisional=local&&(!submitted||local.timeMs<=submitted.timeMs)?local:submitted;
      const isLocal=provisional&&(!published||provisional.timeMs<published.timeMs),best=isLocal?provisional:published;
      const actions=closed?'<button class="button" type="button" data-event-practice>Practice track</button>':'<button class="button" type="button" data-event-race>Race event</button><button class="button" type="button" data-event-refresh>Refresh standings</button>';
      const counts=closed?archivePeriodCounts(period,board):null,rawStandings=counts?counts.verifiedEntries:board.entries;
      const filtered=bridge.filterRows?.(rawStandings,{trackId:period.trackId,event:true,maxRp:period.maxRp,complete:board.complete===true}),standings=filtered?.rows||rawStandings;
      const winner=counts?.winner?` · Winner ${escape(displayName(counts.winner))} ${time(counts.winner.timeMs)}`:'';
      const archiveMeta=counts?`<p>${counts.racers} ${counts.racers===1?'racer':'racers'}${winner}</p>`:'';
      body(`<div class="sq-event-heading"><span class="sq-event-thumb">${bridge.thumbnail(period.trackId)}</span><div><h3>${escape(periodName(period))}</h3><p>${escape(reset(period))} · ${closed?'Closed':'Open'}</p>${archiveMeta}<p>Your event PB: <b>${time(best?.timeMs)}</b> ${best?(isLocal?(provisional===local?'(saved on this device)':'(submitted)'):'(published)'):''}</p></div></div><div class="sq-event-actions">${actions}</div>${receiptText(receipt,local,period)?`<p class="sq-event-receipt" role="status">${escape(receiptText(receipt,local,period))}</p>`:''}<p class="${board.saved?'sq-event-saved':''}">${board.saved?'Saved standings':board.archived?'Final standings':closed?'Finalizing standings':'Published standings'} · Only verified event runs earn points.</p><ol class="sq-event-results sq-event-verified-results">${rows(standings)||'<li>No verified event times yet.</li>'}</ol>`);
      message((filtered?.active?'Personal filters are active. ':'')+(closed?'Final standings. Practice runs do not submit to the expired event.':'Only verified event runs earn Event RP.'));
      bridge.filterButton?.(dialog.querySelector('.sq-event-actions'));
    }catch{if(token===requestId)body('<p>Event standings are unavailable. Please try again later.</p>');}
  }
  async function practice(period){
    if(period.kind==='kodub'||period.kind==='custom')return importArchived(period);
    const saved=cache.get(period.id)||read(STORE+'-'+period.id,null);
    if(!saved||!Array.isArray(saved.entries)){message('Archived standings are not loaded. Reopen the archive card and try again.');return;}
    openArchivedTrack(period,saved);
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
      await bridge.prepareArchive?.();if(!dialog||token!==requestId)return;
      body('');
      mountArchiveView(dialog.querySelector('main'),{periods,month:value,formatTime:time,accountId:bridge.accountId(),snapshots:cache,
        resolveName:periodName,loadSnapshot:period=>snapshot(period,false),onMonthChange:month=>void archives(month),
        onOpenPeriod:(period,snapshot)=>void openArchivedTrack(period,snapshot),renderThumbnail:period=>{const node=document.createElement('span');node.innerHTML=bridge.thumbnail(period.trackId);return node;}});
    }catch{if(token===requestId)body('<p>Past events are unavailable. Please try again.</p>');}
  }
  let nativeView=null,eventIntent=null,archiveIntent=null;
  async function openArchivedTrack(period,saved){
    if(period?.kind==='kodub'||period?.kind==='custom')return importArchived(period);
    const snapshot=saved||cache.get(period?.id)||read(STORE+'-'+period?.id,null);
    if(!period?.id||!period.trackId||!snapshot||!Array.isArray(snapshot.entries)||snapshot.period?.id&&snapshot.period.id!==period.id||snapshot.period?.trackId&&snapshot.period.trackId!==period.trackId){message('Archived standings are not loaded or do not match this track. Reopen the archive card and try again.');return false;}
    entryRequest++;sessions.leave();eventIntent=null;archiveIntent={archive:true,period,periodId:period.id,trackId:period.trackId,accountId:bridge.accountId(),snapshot};knownPeriods.set(period.id,period);close();message('Opening archived track for normal practice.');
    nativeOpenPermit=true;try{await bridge.openTrack(period.trackId);}catch(error){archiveIntent=null;message(error?.message||'Archived track could not be opened.');return false;}finally{nativeOpenPermit=false;}
    tick();return true;
  }
  let launching=false,nativeOpenPermit=false,nativePlayPermit=false,selectedGhost=null,replayRequest=0,topSelectionToken=0,eventTopPrefixUntil=0,eventTopHeld=false,eventDigitBoard=null;const selectedGhosts=new Map(),pendingGhosts=new Map(),replayCache=new Map(),preparedGhosts=new Map(),preparedOwnGhosts=new Map(),replayFailures=new Map(),eventDigitsHeld=new Map(),eventDigitsConsumed=new Set();
  let replayRowsLoaded=false,replayRowsRaw=null,replayRowsCache=[];
  const carImages=new Map(),validatedCarStyles=new Map();let profileStyles=new Map(),profilesAt=0,rendering=0;const renderQueue=[];
  function validCachedCarStyle(style){
    if(validatedCarStyles.has(style))return validatedCarStyles.get(style);
    let valid=false;
    try{const value=bridge.require()?.(8724)?.A.deserializeSafe(style);valid=!!value&&value.serialize()===style;}catch{}
    validatedCarStyles.set(style,valid);if(validatedCarStyles.size>256)validatedCarStyles.delete(validatedCarStyles.keys().next().value);
    return valid;
  }
  function cachedCarStyle(row,period){
    if(!profilesAt||now()-profilesAt>=120000){profilesAt=now();profileStyles=new Map();const saved=read(PROFILE_CACHE,null);for(const entry of (Array.isArray(saved?.entries)?saved.entries:[]).slice(0,1000))profileStyles.set(entry.accountId||entry.userId,entry.carStyle);}
    const candidates=[window.__polytrackCarStyleByUser062?.[row.accountId],row.carStyle,row.accountId===bridge.accountId()?localBest(period)?.carStyle:null,profileStyles.get(row.accountId)];
    for(const value of candidates){if(typeof value!=='string'||!value||value.length>256)continue;if(validCachedCarStyle(value))return value;}
    return '';
  }
  const imageSource=value=>typeof value==='string'?value:value?.src||value?.url||value?.dataUrl||'';
  const safeImage=src=>typeof src==='string'&&/^(data:image\/(png|webp|jpeg);base64,|blob:)/.test(src);
  async function renderCar(job){
    const style=job.style;
    // Thumbnail generation is CPU-heavy in the native bundle. Keep it off the
    // replay-selection input frame and skip work after the event view closes.
    const idle=await new Promise(resolve=>{
      if(typeof requestIdleCallback==='function'){
        let handle;
        const limit=setTimeout(()=>{if(typeof cancelIdleCallback==='function')cancelIdleCallback(handle);resolve(false);},3000);
        handle=requestIdleCallback(()=>{clearTimeout(limit);resolve(true);});
      }else setTimeout(()=>resolve(true),48);
    });
    if(!idle)return '';
    const view=job.view;
    if(nativeView!==view||!view.board.isConnected)return '';
    let renderButton=null;
    for(const subscriber of job.subscribers){
      if(!subscriber.isConnected||!view.board.contains(subscriber)){job.subscribers.delete(subscriber);continue;}
      if(typeof subscriber.getClientRects!=='function'||subscriber.getClientRects().length){renderButton=subscriber;break;}
    }
    if(!renderButton)return '';
    const bounded=async invoke=>{let timer;try{return await Promise.race([Promise.resolve().then(invoke),new Promise(resolve=>{timer=setTimeout(()=>resolve(''),1500);})]);}catch{return '';}finally{clearTimeout(timer);}};
    if(typeof window.BT==='function'){const src=imageSource(await bounded(()=>window.BT(style,'')));if(safeImage(src))return src;}
    return imageSource(await bounded(()=>{const require=bridge.require(),value=require?.(8724)?.A.deserializeSafe(style),render=require?.(3787)?.F;return value&&typeof render==='function'?render(value,{addCancelCallback(){}},null):'';}));
  }
  let drainingRenders=false;
  function drainRenders(){
    if(drainingRenders)return;drainingRenders=true;
    try{
      while(true){
        while(rendering<1&&renderQueue.length){const job=renderQueue.shift();if(nativeView!==job.view||!job.view.board.isConnected){if(carImages.get(job.style)===job)carImages.delete(job.style);job.resolve('');job.subscribers.clear();job.button=null;job.view=null;job.resolve=null;job.promise=null;continue;}rendering++;void renderCar(job).then(src=>{if(carImages.get(job.style)===job){if(safeImage(src))carImages.set(job.style,src);else carImages.delete(job.style);}job.resolve(src);job.subscribers.clear();job.button=null;job.view=null;job.resolve=null;job.promise=null;}).finally(()=>{rendering--;drainRenders();});}
        const view=nativeView;if(!view?.deferredCarRows.size||renderQueue.length>=12)break;
        const before=renderQueue.length;
        retryDeferredEventCarRenders(view,(button,style)=>renderCachedCar(button,style,false));
        if(renderQueue.length===before)break;
      }
    }finally{drainingRenders=false;}
  }
  function localReplayRows(){
    let raw;try{raw=localStorage.getItem(REPLAYS);}catch{return [];}
    if(raw?.length>600000){replayRowsLoaded=true;replayRowsRaw=null;replayRowsCache=[];return replayRowsCache;}
    if(!replayRowsLoaded||raw!==replayRowsRaw){
      replayRowsLoaded=true;replayRowsRaw=raw;
      try{const parsed=raw===null?[]:JSON.parse(raw);replayRowsCache=Array.isArray(parsed)?parsed:[];}catch{replayRowsCache=[];}
    }
    return replayRowsCache;
  }
  function getOwnReplay(periodId){
    const period=knownPeriods.get(periodId)||(catalog.periods||[]).find(p=>p.id===periodId),accountId=bridge.accountId();if(!period)return null;
    const best=localBest(period),row=localReplayRows().slice(0,8).find(row=>row&&typeof row==='object'&&row.periodId===periodId&&row.accountId===accountId&&row.trackId===period.trackId);
    if(!best||!row||typeof row.attemptId!=='string'||!row.attemptId.length||row.attemptId.length>128||row.attemptId!==best.attemptId||row.timeMs!==best.timeMs||row.frames!==row.timeMs||!Number.isSafeInteger(row.frames)||row.frames<1||row.frames>300000||typeof row.replay!=='string'||!row.replay.length||row.replay.length>65536||!/^[A-Za-z0-9_-]+$/.test(row.replay)||typeof row.carStyle!=='string'||row.carStyle.length>256)return null;
    const shown=eventDisplayRows(period).rows.find(entry=>entry.accountId===accountId);if(shown&&shown.timeMs<row.timeMs)return null;
    const receipt=ownReceipts.get(periodId+'_'+accountId);if(receipt?.attemptId===row.attemptId&&['mismatch','unavailable_final','expired','rejected'].includes(receipt.status))return null;
    return Object.freeze({...row,source:'local-event-recording'});
  }
  function renderCachedCar(button,style,drain=true){
    const image=button.querySelector('.image-container img');
    let label=button.querySelector('.sq-event-car-unavailable');if(!label){label=document.createElement('small');label.className='sq-event-car-unavailable';image.after(label);}label.textContent='Car unavailable';label.hidden=false;image.hidden=true;
    image.alt='Car unavailable';image.title='No cached car available';
    if(!style)return;
    image.alt='Loading cached car';image.title='Cached profile car, not an event replay';label.textContent='Loading car';
    const applyImage=(src,view)=>{
      if(!button.isConnected)return;
      if(!safeImage(src)){
        if(view===nativeView&&view?.board?.contains(button)&&typeof button.getClientRects==='function'&&!button.getClientRects().length){image.alt='Loading cached car';label.textContent='Loading car';view.deferredCarRows.add(button);return;}
        image.alt='Car unavailable';label.textContent='Car unavailable';return;
      }
      view?.carObserver?.unobserve(button);view?.deferredCarRows?.delete(button);
      image.onload=()=>{image.hidden=false;label.hidden=true;};
      image.onerror=()=>{image.alt='Car unavailable';image.hidden=true;label.hidden=false;label.textContent='Car unavailable';};
      image.src=src;image.alt='Cached profile car';
    };
    let cached=carImages.get(style);
    if(typeof cached==='string'){applyImage(cached,nativeView);return true;}
    let job=cached;if(job&&job.view!==nativeView)job=null;
    if(!job){if(renderQueue.length>=12){image.alt='Loading cached car';label.textContent='Loading car';return false;}let resolve;const promise=new Promise(done=>{resolve=done;});job={style,button,view:nativeView,subscribers:new Set(),resolve,promise};renderQueue.push(job);carImages.set(style,job);if(carImages.size>200){const oldest=[...carImages].find(([,candidate])=>typeof candidate==='string');if(oldest)carImages.delete(oldest[0]);}if(drain)drainRenders();}
    job.subscribers.add(button);
    const view=job.view;void job.promise.then(src=>applyImage(src,view));
    return true;
  }
  const replayContextActive=session=>session?.archive===true?archiveIntent===session&&bridge.accountId()===session.accountId:sessions.current()===session&&bridge.accountId()===session.accountId;
  async function selectReplay(period,row,{silent=false}={}){
    const session=sessions.current()||archiveIntent,viewer=bridge.accountId();if(!session||session.periodId!==period.id||typeof bridge.readReplay!=='function')return;
    const pendingSelection=pendingGhosts.get(row.accountId);
    if(pendingSelection?.periodId===period.id&&pendingSelection.accountId===viewer&&pendingSelection.targetTimeMs===row.timeMs&&pendingSelection.targetPending===!!row.pending&&pendingSelection.targetRunId===(row.runId||null)){
      ++topSelectionToken;++replayRequest;pendingGhosts.delete(row.accountId);if(!silent)message('Event ghost selection cancelled.');tick();return false;
    }
    const previous=selectedGhosts.get(row.accountId);
    if(previous?.periodId===period.id&&previous.accountId===viewer&&previous.targetTimeMs===row.timeMs&&previous.targetPending===!!row.pending&&previous.targetRunId===(row.runId||null)){
      ++topSelectionToken;++replayRequest;pendingGhosts.delete(row.accountId);selectedGhosts.delete(row.accountId);selectedGhost=[...selectedGhosts.values()].at(-1)||null;if(!silent){message('Event ghost unselected.');tick();}return false;
    }
    ++topSelectionToken;const token=++replayRequest;for(const [id,target] of pendingGhosts)if(target.groupToken)pendingGhosts.delete(id);const pending={periodId:period.id,accountId:viewer,targetAccountId:row.accountId,targetTimeMs:row.timeMs,targetPending:!!row.pending,targetRunId:row.runId||null};pendingGhosts.set(row.accountId,pending);if(!silent){message('Loading event replay...');tick();}
    const key=period.id+'_'+row.accountId+'_'+row.timeMs+'_'+(row.runId||'verified'),failureKey=key+'_'+viewer;
    try{
      const failure=replayFailure(failureKey);if(failure)throw Error(failure);
      let payload=replayCache.get(key);if(!payload)payload=await bridge.readReplay(period.id,row.accountId,row.pending?row.runId:null);
      if(pendingGhosts.get(row.accountId)!==pending)return;
      if(!replayContextActive(session)){pendingGhosts.delete(row.accountId);tick();return;}
      const ghostKey=key+'_'+viewer;
      let ghost=preparedGhosts.get(ghostKey);
      if(!ghost){ghost=await preparePublishedEventGhost({require:bridge.require(),row:payload,period,entry:row,viewer});preparedGhosts.set(ghostKey,ghost);if(preparedGhosts.size>16)preparedGhosts.delete(preparedGhosts.keys().next().value);}
      if(pendingGhosts.get(row.accountId)!==pending)return;
      if(!replayContextActive(session)){pendingGhosts.delete(row.accountId);tick();return;}
      replayFailures.delete(failureKey);if(replayCache.size>=16)replayCache.delete(replayCache.keys().next().value);replayCache.set(key,payload);
      const selection={periodId:period.id,accountId:viewer,targetAccountId:row.accountId,targetTimeMs:row.timeMs,targetPending:!!row.pending,targetRunId:row.runId||null,ghost};
      if(token===replayRequest)selectedGhost=selection;
      if(selectedGhosts.size>=10&&!selectedGhosts.has(row.accountId))selectedGhosts.delete(selectedGhosts.keys().next().value);
      selectedGhosts.set(row.accountId,selection);pendingGhosts.delete(row.accountId);
      if(!silent){if(token===replayRequest)message(session.archive?'Archived replay selected. Use Watch to view it.':'Replay ready: '+displayName(row)+(row.pending?' (unverified)':'')+'. Play to race this ghost.');tick();}
      return true;
    }catch(error){if(pendingGhosts.get(row.accountId)===pending){rememberReplayFailure(failureKey,error);pendingGhosts.delete(row.accountId);if(!silent&&replayContextActive(session)){if(token===replayRequest)message(error.message||'Event replay unavailable.');tick();}}return false;}
  }
  function clearEventGhostSelection(periodId,accountId,{render=true}={}){
    ++topSelectionToken;++replayRequest;
    for(const [id,row] of selectedGhosts)if(row.periodId===periodId&&row.accountId===accountId)selectedGhosts.delete(id);
    for(const [id,row] of pendingGhosts)if(row.periodId===periodId&&row.accountId===accountId)pendingGhosts.delete(id);
    selectedGhost=[...selectedGhosts.values()].at(-1)||null;
    if(render)tick();
  }
  function replayFailure(key){
    const failure=replayFailures.get(key);if(!failure)return null;
    if(failure.until>now())return failure.message;
    replayFailures.delete(key);return null;
  }
  function rememberReplayFailure(key,error){
    replayFailures.delete(key);replayFailures.set(key,{message:error?.message||'Event replay unavailable. Please try again later.',until:now()+5*60*1000});
    if(replayFailures.size>32)replayFailures.delete(replayFailures.keys().next().value);
  }
  async function selectEventRows(first,last,fromTop=false,explicitRows=null){
    const view=nativeView,session=sessions.current()||archiveIntent,accountId=bridge.accountId();
    if(!view||!session||session.periodId!==view.periodId||session.accountId!==accountId)return;
    const period=view.period||knownPeriods.get(view.periodId)||(catalog.periods||[]).find(row=>row.id===view.periodId);if(!period)return;
    const offset=fromTop?0:view.page*20,sourceRows=(view.archive?archivePeriodCounts(period,view.snapshot).verifiedEntries:eventDisplayRows(period).rows).filter(row=>!view.onlyVerified||!row.pending);
    const chosen=(explicitRows||sourceRows.slice(offset+first-1,offset+last)).slice(0,10).filter(row=>(!row.pending||/^[a-f0-9]{64}$/.test(row.runId||''))&&typeof bridge.readReplay==='function');
    const active=[...selectedGhosts.values()].filter(row=>row.periodId===period.id&&row.accountId===accountId);
    const same=chosen.length>0&&active.length===chosen.length&&chosen.every(row=>{const selected=selectedGhosts.get(row.accountId);return selected?.periodId===period.id&&selected.accountId===accountId&&selected.targetTimeMs===row.timeMs&&selected.targetRunId===(row.runId||null)&&selected.targetPending===!!row.pending;});
    const pendingActive=[...pendingGhosts.values()].filter(row=>row.periodId===period.id&&row.accountId===accountId),groupToken=pendingActive[0]?.groupToken;
    const pendingSame=chosen.length>0&&Number.isSafeInteger(groupToken)&&pendingActive.length===chosen.length&&chosen.every(row=>{const pending=pendingGhosts.get(row.accountId);return pending?.groupToken===groupToken&&pending.targetTimeMs===row.timeMs&&pending.targetRunId===(row.runId||null)&&pending.targetPending===!!row.pending;});
    if(fromTop)view.page=0;
    clearEventGhostSelection(period.id,accountId,{render:false});
    if(same||pendingSame){message('Event ghosts unselected.');tick();return;}
    if(!chosen.length){message('No playable replays in these places.');tick();return;}
    const token=++topSelectionToken,requestToken=++replayRequest;
    for(const row of chosen)pendingGhosts.set(row.accountId,{periodId:period.id,accountId,targetAccountId:row.accountId,targetTimeMs:row.timeMs,targetPending:!!row.pending,targetRunId:row.runId||null,groupToken:token});
    message(`Loading up to ${chosen.length} event replays...`);
    tick();
    const prepared=await Promise.all(chosen.map(async row=>{
      const pending=pendingGhosts.get(row.accountId);
      try{
        const key=period.id+'_'+row.accountId+'_'+row.timeMs+'_'+(row.runId||'verified');
        const failureKey=key+'_'+accountId,failure=replayFailure(failureKey);if(failure)throw Error(failure);
        let payload=replayCache.get(key);if(!payload)payload=await bridge.readReplay(period.id,row.accountId,row.pending?row.runId:null);
        if(token!==topSelectionToken||requestToken!==replayRequest||pendingGhosts.get(row.accountId)!==pending||!replayContextActive(session))return null;
        const ghostKey=key+'_'+accountId;let ghost=preparedGhosts.get(ghostKey);
        if(!ghost){ghost=await preparePublishedEventGhost({require:bridge.require(),row:payload,period,entry:row,viewer:accountId});preparedGhosts.set(ghostKey,ghost);if(preparedGhosts.size>16)preparedGhosts.delete(preparedGhosts.keys().next().value);}
        if(token!==topSelectionToken||requestToken!==replayRequest||pendingGhosts.get(row.accountId)!==pending||!replayContextActive(session))return null;
        replayFailures.delete(failureKey);if(replayCache.size>=16)replayCache.delete(replayCache.keys().next().value);replayCache.set(key,payload);
        return {row,ghost};
      }catch(error){if(token===topSelectionToken&&requestToken===replayRequest&&pendingGhosts.get(row.accountId)===pending)rememberReplayFailure(period.id+'_'+row.accountId+'_'+row.timeMs+'_'+(row.runId||'verified')+'_'+accountId,error);return null;}
    }));
    if(token!==topSelectionToken||requestToken!==replayRequest)return;
    if(!replayContextActive(session)){for(const row of chosen)if(pendingGhosts.get(row.accountId)?.groupToken===token)pendingGhosts.delete(row.accountId);tick();return;}
    const ready=prepared.filter(Boolean);
    for(const {row,ghost} of ready){
      const selection={periodId:period.id,accountId,targetAccountId:row.accountId,targetTimeMs:row.timeMs,targetPending:!!row.pending,targetRunId:row.runId||null,ghost};
      if(selectedGhosts.size>=10&&!selectedGhosts.has(row.accountId))selectedGhosts.delete(selectedGhosts.keys().next().value);
      selectedGhosts.set(row.accountId,selection);selectedGhost=selection;
    }
    for(const row of chosen)if(pendingGhosts.get(row.accountId)?.groupToken===token)pendingGhosts.delete(row.accountId);
    message(chosen.length?`${ready.length} of ${chosen.length} ${fromTop?'top ':''}event ghosts ready. Play to race them.`:'No playable replays in these places.');
    tick();
  }
  function selectTopEventRows(count){return selectEventRows(1,count,true);}
  function selectEventRange(first,last){return selectEventRows(first,last,false);}
  function selectEventYouGroup(){
    const view=nativeView;if(!view)return;
    const rows=(view.archive?archivePeriodCounts(view.period,view.snapshot).verifiedEntries:eventDisplayRows(view.period).rows).filter(row=>!view.onlyVerified||!row.pending);
    const chosen=rows.slice(0,9),mine=rows.find(row=>row.accountId===bridge.accountId());
    if(mine&&!chosen.some(row=>row.accountId===mine.accountId))chosen.push(mine);else if(rows[9])chosen.push(rows[9]);
    return selectEventRows(1,10,true,chosen);
  }
  function raceGhosts(session){
    const period=knownPeriods.get(session.periodId);
    if(period){const allowed=new Set(eventDisplayRows(period).rows.map(row=>row.accountId));for(const [id,row] of selectedGhosts)if(row.periodId===session.periodId&&!allowed.has(id))selectedGhosts.delete(id);}
    const replay=bridge.supportsEventGhost?.()?getOwnReplay(session.periodId):null;let ownGhost=null;
    if(replay){
      const key=session.periodId+'_'+session.accountId,best=bestRecords[key],cached=preparedOwnGhosts.get(key);
      if(cached&&cached.trackId===session.trackId&&cached.attemptId===replay.attemptId&&cached.timeMs===replay.timeMs&&cached.frames===replay.frames&&cached.replay===replay.replay&&cached.carStyle===replay.carStyle&&cached.bestAttemptId===best?.attemptId&&cached.bestTimeMs===best?.timeMs)ownGhost=cached.ghost;
      else try{
        ownGhost=prepareOwnEventGhost({require:bridge.require(),row:replay,session,best});
        preparedOwnGhosts.delete(key);preparedOwnGhosts.set(key,{trackId:session.trackId,attemptId:replay.attemptId,timeMs:replay.timeMs,frames:replay.frames,replay:replay.replay,carStyle:replay.carStyle,bestAttemptId:best?.attemptId,bestTimeMs:best?.timeMs,ghost:ownGhost});
        if(preparedOwnGhosts.size>8)preparedOwnGhosts.delete(preparedOwnGhosts.keys().next().value);
      }catch{preparedOwnGhosts.delete(key);}
    }
    const selected=[...selectedGhosts.values()].filter(row=>row.periodId===session.periodId&&row.accountId===session.accountId).map(row=>row.ghost);
    const selectedSelf=selected.find(row=>row.isSelf);if(selectedSelf)ownGhost=selectedSelf;
    return {ownGhost,opponents:selected.filter(row=>!row.isSelf)};
  }
  function resumeRace(trackId,invokeNative){
    if(!eventIntent&&!sessions.current())return false;
    const session=sessions.current();
    if(!session||session.trackId!==trackId||session.accountId!==bridge.accountId()){message('This event replay cannot start a race after its event closes or racer changes.');return true;}
    try{bridge.startEventRace({...session,...raceGhosts(session)},invokeNative,()=>sessions.current()===session&&bridge.accountId()===session.accountId);}catch{message('Event race could not resume safely. Reopen Events.');}
    return true;
  }
  function watchEvent(){
    const session=sessions.current()||archiveIntent;if(!session||session.accountId!==bridge.accountId())return;
    if([...pendingGhosts.values()].some(row=>row.periodId===session.periodId&&row.accountId===session.accountId)){message('Selected replays are still loading. Wait or unselect them before watching.');return;}
    const ghosts=session.archive?[...selectedGhosts.values()].filter(row=>row.periodId===session.periodId&&row.accountId===session.accountId).map(row=>row.ghost):(()=>{const {ownGhost,opponents}=raceGhosts(session);return [...(ownGhost?[ownGhost]:[]),...opponents];})();
    if(!ghosts.length){message(session.archive?'Select an archived replay first.':'Select an event replay first, or set a local event PB.');return;}
    try{bridge.watchEvent?.(session,ghosts);}catch(error){message(error.message||'Event replay could not open.');}
  }
  async function playEvent(){
    const session=sessions.current();if(!session||now()>=session.endsAt||session.accountId!==bridge.accountId()){message('This event is no longer open for this racer. Reopen Events to continue.');return;}if(launching)return;
    if([...pendingGhosts.values()].some(row=>row.periodId===session.periodId&&row.accountId===session.accountId)){message('Selected replays are still loading. Wait or unselect them before playing.');return;}
    if(typeof bridge.startEventRace!=='function'){message('Event Play is unavailable: safe event race launch is not connected. Normal PB ghosts will not be used.');return;}
    const replay=getOwnReplay(session.periodId),{ownGhost,opponents}=raceGhosts(session);
    const current=()=>sessions.current()===session&&bridge.accountId()===session.accountId&&(!ownGhost||[...selectedGhosts.values()].some(row=>row.ghost===ownGhost)||replay&&getOwnReplay(session.periodId)?.attemptId===replay.attemptId&&getOwnReplay(session.periodId)?.timeMs===replay.timeMs);
    launching=true;message(opponents.length?`Starting with ${opponents.length} selected event ghost${opponents.length===1?'':'s'}...`:ownGhost?'Starting with your event PB ghost...':'Starting event race...');
    try{await bridge.startEventRace({...session,ownGhost,opponents},()=>{
      if(sessions.current()!==session||bridge.accountId()!==session.accountId)throw Error('Event launch context changed');
      const play=nativeView?.root.querySelector('.side-panel button.play');if(!play)throw Error('Native Play is unavailable');
      nativePlayPermit=true;try{play.click();}finally{nativePlayPermit=false;}
    },current);}
    catch{if(sessions.current()===session)message('Event race could not start safely. No normal PB ghost was loaded.');}
    finally{launching=false;}
  }
  const ownReceipts=new Map(),ownReceiptAt=new Map();
  async function readReceipt(periodId,accountId,force=false){
    const key=periodId+'_'+accountId;
    if(!force&&ownReceiptAt.has(key)&&now()-ownReceiptAt.get(key)<15000)return ownReceipts.get(key);
    const receipt=await bridge.readOwnStatus?.(periodId,accountId).catch(()=>null)??null;
    ownReceipts.set(key,receipt);ownReceiptAt.set(key,now());
    return receipt;
  }
  function clearNativeView(){
    if(!nativeView)return;
    nativeView.carObserver?.disconnect();nativeView.deferredCarRows?.clear();if(nativeView.contextMenuHandler)nativeView.board.removeEventListener('contextmenu',nativeView.contextMenuHandler);
    nativeView.board.replaceChildren(nativeView.nativeMarkup);
    nativeView.board.classList.remove('sq-event-board');
    if(nativeView.nativeDisplay.value)nativeView.board.style.setProperty('display',nativeView.nativeDisplay.value,nativeView.nativeDisplay.priority);else nativeView.board.style.removeProperty('display');
    if(nativeView.nativeTitle)nativeView.board.title=nativeView.nativeTitle;else nativeView.board.removeAttribute('title');
    nativeView.pb?.remove();nativeView.pbTitle?.remove();
    if(nativeView.watch)nativeView.watch.disabled=nativeView.watchDisabled;
    nativeView.opponentsNote?.remove();
    nativeView=null;
  }
  async function refreshNativeEventData(period,session){
    const accountId=bridge.accountId();
    try{await snapshot(period);await readReceipt(period.id,accountId);if(!session||!replayContextActive(session))return;if(nativeView)nativeView.signature='';syncNativeBoard(session);}
    catch{if(sessions.current()===session)message('Event standings are unavailable. Local event finishes still save.');}
  }
  function eventDisplayRows(period){
    const accountId=bridge.accountId();
    const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
    const board=cache.get(period.id)||read(STORE+'-'+period.id,null);
    const validBoard=board?.period?.id===period.id&&board.period.trackId===period.trackId&&Array.isArray(board.entries);
    const entries=validBoard?board.entries:[];
    const rows=entries.map(row=>({...row,pending:false}));
    const pending=validBoard?(board.pendingPlaybacks||board.playbacks):null;
    for(const replay of (Array.isArray(pending)?pending:[])){
      if(!isHash(replay?.accountId)||replay.verificationStatus!=='waiting'||replay.pending===false||replay.verified===true||replay.eventRpEligible===true||replay.source&&replay.source!=='pending-event-playback'||!isHash(replay.runId)||!Number.isSafeInteger(replay.timeMs)||replay.timeMs<=0)continue;
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
    let rank=0;for(let index=0;index<rows.length;index++){if(!index||rows[index].timeMs!==rows[index-1].timeMs)rank=index+1;rows[index].rank=rank;}
    const filtered=bridge.filterRows?.(rows,{trackId:period.trackId,event:true,maxRp:period.maxRp,complete:board?.complete===true});
    return {rows:filtered?.rows||rows,board,filterResult:filtered,sourceOwn:rows.find(row=>row.accountId===accountId)};
  }
  function syncNativeArchiveBoard(view){
    const {period,snapshot}=view;
    const archived=archivePeriodCounts(period,snapshot).verifiedEntries;
    if(view.watch)view.watch.disabled=typeof bridge.watchEvent!=='function'||![...selectedGhosts.values()].some(row=>row.periodId===period.id&&row.accountId===view.accountId);
    const rows=archived.map((row,index)=>({...row,name:displayName(row),rank:Number.isSafeInteger(row.rank)&&row.rank>0?row.rank:index+1,pending:false}));
    const signature=JSON.stringify([snapshot.updatedAt,rows.map(row=>[row.accountId,row.rank,row.timeMs,row.name,row.rp])]);
    for(const button of view.board.querySelectorAll(':scope > .container > button.main')){const selected=selectedGhosts.get(button.dataset.eventAccountId),pending=pendingGhosts.get(button.dataset.eventAccountId),matches=row=>row?.periodId===period.id&&row.accountId===view.accountId&&row.targetTimeMs===Number(button.dataset.eventTime);const active=matches(selected),busy=matches(pending);button.classList.toggle('selected',!!(active||busy));button.classList.toggle('pending-selection',!!busy);button.setAttribute('aria-pressed',String(!!(active||busy)));button.setAttribute('aria-busy',String(!!busy));}
    if(signature===view.signature)return;
    view.signature=signature;view.board.querySelector('h3').textContent=eventName(period.kind)+' archive';
    view.board.querySelector('.total-players').textContent=rows.length+' archived '+(rows.length===1?'racer':'racers');
    const container=view.board.querySelector('.container');container.replaceChildren();
    const count=Math.max(1,Math.ceil(rows.length/20));view.page=Math.min(view.page,count-1);
    for(const row of rows.slice(view.page*20,view.page*20+20)){
      const button=document.createElement('button');button.type='button';button.className='button main';button.dataset.eventAccountId=row.accountId;button.dataset.eventTime=String(row.timeMs);button.dataset.eventRunId=row.runId||'';button.dataset.eventPending='false';const playable=typeof bridge.readReplay==='function';button.tabIndex=playable?0:-1;button.setAttribute('aria-disabled',String(!playable));button.setAttribute('aria-pressed','false');button.setAttribute('aria-busy','false');button.title=playable?'Select this archived replay. It will not submit an event result.':'Archived replay selection is unavailable.';if(playable)button.onclick=()=>void selectReplay(period,row);
      button.innerHTML='<div class="image-container"><img class="show" src="images/car_thumbnail_placeholder.png"></div><img class="checkmark" src="images/checkmark.svg" alt=""><div class="left"><p class="position"></p><p class="event-time"></p></div><div class="right"><div class="name-container"><span class="name"></span></div><p class="verified-state verified"></p></div>';
      const position=button.querySelector('.position'),ordinal=eventOrdinal(row.rank);position.append(document.createTextNode(String(row.rank)));if(ordinal){const suffix=document.createElement('span');suffix.className='sq-event-ordinal-suffix';suffix.textContent=ordinal.slice(String(row.rank).length);position.append(suffix);}
      button.querySelector('.event-time').textContent=time(row.timeMs);button.querySelector('.name').textContent=row.name||'Racer';
      const state=button.querySelector('.verified-state'),stamp=eventRunDate(row,now());state.textContent='Archived verified result';state.title=stamp.title;const actions=event=>{if(typeof bridge.racerActions!=='function')return;event.preventDefault();event.stopPropagation();const rect=button.getBoundingClientRect();bridge.racerActions(row,{clientX:event.clientX||rect.left+rect.width/2,clientY:event.clientY||rect.top+rect.height/2});};button.oncontextmenu=actions;button.onkeydown=event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10')actions(event);};
      const points=document.createElement('span');points.className='sq-event-earned-rp';points.textContent=Math.round(Number(row.groupRp??row.rp)||0)+' RP';points.title='Archived Event RP';button.querySelector('.right').append(points);container.append(button);
    }
    if(!rows.length){const empty=document.createElement('p');empty.className='error-message';empty.textContent='No verified archived times were recorded.';container.append(empty);}
    const pages=view.board.querySelector('.pages');pages.replaceChildren();
    for(let page=0;page<count;page++){const button=document.createElement('button');button.type='button';button.className='button page'+(page===view.page?' selected':'');button.textContent=String(page+1);button.disabled=page===view.page;button.onclick=()=>{view.page=page;view.signature='';syncNativeArchiveBoard(view);};pages.append(button);}
  }
  function syncNativeBoard(session){
    const root=document.querySelector('.track-info-ui');
    if(!session||!root){clearNativeView();return;}
    const period=session.period||knownPeriods.get(session.periodId)||(catalog.periods||[]).find(p=>p.id===session.periodId);
    if(!period)return;
    const accountId=bridge.accountId();
    if(accountId!==session.accountId){clearNativeView();return;}
    if(nativeView&&(nativeView.root!==root||nativeView.periodId!==period.id||nativeView.accountId!==accountId))clearNativeView();
    if(!nativeView){
      const original=root.querySelector(':scope > .leaderboard-ui:not(.sq-event-board)');
      if(!original)return;
      if(statusText==='Opening event track...')message('');
      const archiveMode=session.archive===true,nativeBack=original.querySelector('button.back'),nativeDisplay={value:original.style.getPropertyValue('display'),priority:original.style.getPropertyPriority('display')},nativeTitle=original.getAttribute('title');
      const nativeMarkup=document.createDocumentFragment();while(original.firstChild)nativeMarkup.append(original.firstChild);
      const board=original;board.classList.add('sq-event-board');
      board.title=archiveMode?'Frozen archived standings. Practice runs are not submitted.':'A number toggles one event ghost. T then a number selects the top group. Hold two numbers for a range. C clears ghosts.';
      board.style.setProperty('display','flex','important');
      board.innerHTML='<h2>'+ (archiveMode?'Archived event leaderboard':'Leaderboard') +'</h2><h3></h3><div class="total-players"></div><div class="container"></div><div class="pages"></div><div class="button-wrapper"><button type="button" class="button back"><img class="button-icon" src="images/back.svg" alt=""> Back</button>'+(archiveMode?'':'<button type="button" class="button only-verified disabled" aria-pressed="false" title="Show only verified event runs">Only verified<img src="images/state_verified.svg" alt=""></button><button type="button" class="button icon-button sq-event-refresh" aria-label="Refresh event standings" title="Refresh event standings"><img class="button-icon" src="images/refresh.svg" alt=""></button>')+'</div>';
      const buttonWrapper=board.querySelector('.button-wrapper');
      if(!archiveMode){bridge.filterButton?.(buttonWrapper);const findMe=document.createElement('button');findMe.type='button';findMe.className='button icon-button first sq-event-find-me';findMe.title='Find your event result';findMe.setAttribute('aria-label','Find your event result');findMe.innerHTML='<img class="button-icon" src="images/pin.svg" alt="">';buttonWrapper.append(findMe);}
      const side=root.querySelector('.side-panel'),watch=side?.querySelector('button.watch'),opponents=side?.querySelector('.opponents-container');let pbTitle=null,pb=null,opponentsNote=null;
      if(!archiveMode){pbTitle=document.createElement('div');pbTitle.className='personal-best-title sq-event-personal-title';pbTitle.textContent='Event personal best';pb=document.createElement('div');pb.className='personal-best sq-event-personal';pb.style.setProperty('display','block','important');const normalPb=side?.querySelector('.personal-best-title');if(normalPb)normalPb.before(pbTitle,pb);opponentsNote=document.createElement('div');opponentsNote.className='opponents-container sq-event-opponents';opponentsNote.textContent='Event ghosts are not available. Normal PB ghosts are not used.';opponents?.after(opponentsNote);}
      const contextMenuHandler=archiveMode?null:event=>event.stopPropagation();
      const view=nativeView={root,board,nativeMarkup,nativeBack,nativeDisplay,nativeTitle,pb,pbTitle,watch,watchDisabled:watch?.disabled,opponents,opponentsNote,period,periodId:period.id,accountId,page:0,onlyVerified:false,signature:'',carStyles:new WeakMap(),archive:archiveMode,snapshot:session.snapshot,contextMenuHandler};
      view.deferredCarRows=new Set();
      if(!archiveMode){if(typeof IntersectionObserver==='function')view.carObserver=new IntersectionObserver(entries=>handleEventCarIntersections(view,entries,renderCachedCar),{root:board.querySelector('.container'),rootMargin:'50px'});board.addEventListener('contextmenu',contextMenuHandler);
        const verified=buttonWrapper.querySelector('.only-verified');verified.onclick=()=>{view.onlyVerified=!view.onlyVerified;verified.classList.toggle('disabled',!view.onlyVerified);verified.setAttribute('aria-pressed',String(view.onlyVerified));view.page=0;view.signature='';view.quickSignature='';syncNativeBoard(session);};
        const findMe=buttonWrapper.querySelector('.sq-event-find-me');findMe.onclick=()=>{const index=eventDisplayRows(period).rows.filter(row=>!view.onlyVerified||!row.pending).findIndex(row=>row.accountId===accountId);if(index<0){message(view.onlyVerified?'Your run is not verified yet. Turn off Only verified to see it.':'Your event result is not in these loaded standings.');return;}view.page=Math.floor(index/20);view.signature='';view.quickSignature='';syncNativeBoard(session);const mine=board.querySelector('button.main.self');mine?.scrollIntoView({block:'nearest'});mine?.focus({preventScroll:true});};
        board.querySelector('.sq-event-refresh').onclick=async()=>{const button=board.querySelector('.sq-event-refresh');button.disabled=true;profilesAt=0;try{await snapshot(period,true);await readReceipt(period.id,accountId,true);if(nativeView!==view||bridge.accountId()!==accountId||sessions.current()!==session)return;view.signature='';syncNativeBoard(session);}catch{if(nativeView===view)message('Event standings could not refresh. Your saved event PB is unchanged.');}finally{button.disabled=false;}};
      }
      board.querySelector('.back').onclick=()=>{entryRequest++;sessions.leave();eventIntent=null;if(view.archive)archiveIntent=null;tick();nativeBack?.click();refreshAfterNativeReturn();};
    }
    const view=nativeView;
    if(view.archive){syncNativeArchiveBoard(view);return;}
    const quickBoard=cache.get(period.id);
    if(quickBoard&&view.signature){
      const quickLocal=localBest(period),quickReceipt=ownReceipts.get(period.id+'_'+accountId);
      const selection=[...selectedGhosts.values()].filter(row=>row.periodId===period.id&&row.accountId===accountId).map(row=>[row.targetRunId,row.targetTimeMs,row.targetPending]);
      const pendingSelection=[...pendingGhosts.values()].filter(row=>row.periodId===period.id&&row.accountId===accountId).map(row=>[row.targetAccountId,row.targetRunId,row.targetTimeMs,row.targetPending,row.groupToken||0]);
      const quickSignature=JSON.stringify([bridge.filterRevision?.(),quickBoard.updatedAt,quickBoard.saved,quickLocal?.attemptId,quickLocal?.timeMs,quickReceipt?.attemptId,quickReceipt?.status,quickReceipt?.timeMs,view.page,view.onlyVerified,Math.floor(now()/120000),selection,pendingSelection]);
      if(quickSignature===view.quickSignature)return;
      view.quickSignature=quickSignature;
    }
    const activeGhosts=[...selectedGhosts.values()].filter(row=>row.periodId===period.id&&row.accountId===accountId);
    if(view.watch)view.watch.disabled=typeof bridge.watchEvent!=='function'||!(getOwnReplay(period.id)||activeGhosts.length);
    const opponentsText=activeGhosts.length?`${activeGhosts.length} event ghost${activeGhosts.length===1?'':'s'} selected`:bridge.supportsEventGhost?.()&&getOwnReplay(period.id)?'Play uses your event PB ghost. Select published racers to add their replays.':'Select published racers to load event ghosts. Normal PB ghosts are not used.';
    if(view.opponentsNote.textContent!==opponentsText)view.opponentsNote.textContent=opponentsText;

    const display=eventDisplayRows(period),{board,filterResult}=display,mine=display.rows.find(row=>row.accountId===accountId),rows=display.rows.filter(row=>!view.onlyVerified||!row.pending);
    if(filterResult?.active){const visible=new Set(rows.map(row=>row.accountId));for(const [id,row] of selectedGhosts)if(row.periodId===period.id&&!visible.has(id))selectedGhosts.delete(id);}
    let place=displayedRecordPlacement(period,mine,board);
    if(mine?.pending&&place===null)place={rank:mine.rank,fieldSize:null,knownFieldSize:rows.length,provisional:true,policy:'all'};
    if(mine&&filterResult?.active&&filterResult.groupGrading)place={rank:mine.groupRank,fieldSize:display.rows.length,knownFieldSize:display.rows.length,provisional:board?.complete!==true,policy:'all'};
    const placement=eventPlacementPresentation(place);
    const receipt=ownReceipts.get(period.id+'_'+accountId);const statusDescription=receipt?receiptText(receipt,localBest(period),period):statusText;
    // Selection changes do not alter standings. Avoid revalidating every car
    // style and serializing whole result objects on each input/menu tick.
    const signature=JSON.stringify([bridge.filterRevision?.(),period.id,board?.updatedAt,board?.saved,Math.floor(now()/120000),view.page,view.onlyVerified,placement,rows.map(row=>[row.accountId,row.rank,row.timeMs,row.runId,row.pending,row.rp,row.name,row.carStyle,row.submittedAt])]);
    if(signature===view.signature){
      for(const button of view.board.querySelectorAll(':scope > .container > button.main')){
        const selectedRow=selectedGhosts.get(button.dataset.eventAccountId);
        const matches=row=>row?.periodId===period.id&&row.accountId===accountId&&row.targetTimeMs===Number(button.dataset.eventTime)&&row.targetRunId===(button.dataset.eventRunId||null)&&row.targetPending===(button.dataset.eventPending==='true');
        const pending=matches(pendingGhosts.get(button.dataset.eventAccountId)),selected=matches(selectedRow);
        if(button.classList.contains('selected')!==(selected||pending))button.classList.toggle('selected',selected||pending);
        if(button.classList.contains('pending-selection')!==pending)button.classList.toggle('pending-selection',pending);
        if(button.getAttribute('aria-pressed')!==String(selected||pending))button.setAttribute('aria-pressed',String(selected||pending));
        if(button.getAttribute('aria-busy')!==String(pending))button.setAttribute('aria-busy',String(pending));
      }
      const status=view.board.querySelector('.sq-event-inline-status');
      if(status&&status.textContent!==statusDescription)status.textContent=statusDescription;
      return;
    }
    view.signature=signature;
    const styles=rows.map(row=>cachedCarStyle(row,period));
    view.board.querySelector('h3').textContent=eventName(period.kind)+' event · '+periodName(period);
    view.board.querySelector('.total-players').textContent=rows.length+(rows.length===1?' racer':' racers')+(view.onlyVerified?' · verified only':'')+(filterResult?.active?' - personal filters':'')+(board?.saved?' - saved standings':'');
    const count=Math.max(1,Math.ceil(rows.length/20));view.page=Math.min(view.page,count-1);
     const container=view.board.querySelector('.container');view.carObserver?.disconnect();view.deferredCarRows.clear();container.replaceChildren();
    for(const [index,row] of rows.slice(view.page*20,view.page*20+20).entries()){
      const button=document.createElement('button');button.type='button';button.className='button main'+(row.accountId===accountId?' self':'');button.dataset.eventAccountId=row.accountId;button.dataset.eventTime=String(row.timeMs);button.dataset.eventRunId=row.runId||'';button.dataset.eventPending=String(!!row.pending);const playable=(!row.pending||/^[a-f0-9]{64}$/.test(row.runId||''))&&typeof bridge.readReplay==='function';button.tabIndex=playable?0:-1;button.setAttribute('aria-disabled',String(!playable));if(playable)button.onclick=()=>void selectReplay(period,row);
      const selectedRow=selectedGhosts.get(row.accountId),pendingRow=pendingGhosts.get(row.accountId),matches=target=>target?.periodId===period.id&&target.accountId===accountId&&target.targetTimeMs===row.timeMs&&target.targetRunId===(row.runId||null)&&target.targetPending===!!row.pending,selected=matches(selectedRow),pending=matches(pendingRow);
      button.classList.toggle('selected',!!(selected||pending));button.classList.toggle('pending-selection',!!pending);button.setAttribute('aria-pressed',String(!!(selected||pending)));button.setAttribute('aria-busy',String(!!pending));
      button.title=pending?'Loading and validating event replay...':row.pending?'Watch unverified recording. It earns no points until verified.':'Load this verified event PB replay. Older recordings may be unavailable.';
      button.innerHTML='<div class="image-container"><img class="show" src="images/car_thumbnail_placeholder.png"></div><img class="checkmark" src="images/checkmark.svg" alt=""><div class="left"><p class="position"></p><p class="event-time"></p></div><div class="right"><div class="name-container"><span class="name"></span></div><p class="verified-state"></p></div>';
      const position=button.querySelector('.position'),ordinal=eventOrdinal(row.rank);position.append(document.createTextNode(Number.isSafeInteger(row.rank)?String(row.rank):'--'));if(ordinal){const suffix=document.createElement('span');suffix.className='sq-event-ordinal-suffix';suffix.textContent=ordinal.slice(String(row.rank).length);position.append(suffix);}button.querySelector('.event-time').textContent=time(row.timeMs);button.querySelector('.name').textContent=row.name||'Racer';
      if(row.accountId===accountId){const self=document.createElement('span');self.className='self';self.textContent=' (You)';button.querySelector('.name-container').append(self);}
      const state=button.querySelector('.verified-state'),date=eventRunDate(row,now());state.dataset.sqRunStatus=row.pending?'unchecked':'verified';state.classList.add(row.pending?'pending':'verified');state.textContent=date.label+(row.pending?(row.unscored?' · Not scored':' · Waiting'):'');state.title=date.title;
      if(!row.pending){const points=document.createElement('span');points.className='sq-event-earned-rp';points.textContent=Math.round(Number(row.groupRp??row.rp)||0)+(row.groupRp!=null?' Group ERP':' ERP');points.title=row.groupRp!=null?'Filtered group Event RP':'Verified Event RP';button.querySelector('.right').append(points);}
      const actions=event=>{if(typeof bridge.racerActions!=='function')return;event.preventDefault();event.stopPropagation();const rect=button.getBoundingClientRect();bridge.racerActions(row,{clientX:event.clientX||rect.left+rect.width/2,clientY:event.clientY||rect.top+rect.height/2});};
      button.oncontextmenu=actions;button.onkeydown=event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10')actions(event);};
      const stateIcon=document.createElement('img');stateIcon.className='sq-event-verification-icon';stateIcon.src=row.pending?'images/state_pending.svg':'images/state_verified.svg';stateIcon.alt=row.pending?'Unverified recording':'Verified replay';button.querySelector('.verified-state').append(stateIcon);container.append(button);
      bridge.decorateRacer?.(button,row);
      const style=styles[view.page*20+index];
      if(style&&view.carObserver){view.carStyles.set(button,style);view.carObserver.observe(button);}
      else if(style){view.carStyles.set(button,style);if(!renderCachedCar(button,style))view.deferredCarRows.add(button);}
      else renderCachedCar(button,style);
    }
    if(!rows.length){const empty=document.createElement('p');empty.className='error-message';empty.textContent=view.onlyVerified?'No verified event times yet. Turn off Only verified to see waiting runs.':'No event times yet. Play to set your event PB.';container.append(empty);}
    const status=document.createElement('p');status.className='sq-event-inline-status';status.setAttribute('role','status');status.textContent=statusDescription;container.append(status);
    bridge.filterNotice?.(view.board,filterResult);
    const pages=view.board.querySelector('.pages');pages.replaceChildren();
    for(let page=0;page<count;page++){const button=document.createElement('button');button.type='button';button.className='button page'+(page===view.page?' selected':'');button.textContent=String(page+1);button.onclick=()=>{view.page=page;view.signature='';syncNativeBoard(session);};pages.append(button);}
    view.pb.replaceChildren();
    for(const [icon,text] of [['timer',mine?time(mine.timeMs):'---'],['trophy',placement?.text||(mine?.pending?(mine.unscored?'Not scored':'Waiting'):'---')]]){const line=document.createElement('div'),image=document.createElement('img');image.src='images/'+icon+'.svg';if(icon==='trophy'&&placement){const badge=document.createElement('span');badge.className=placement.className;badge.title=placement.title;badge.setAttribute('aria-label',placement.ariaLabel);badge.textContent=text;line.append(image,badge);}else line.append(image,document.createTextNode(text));view.pb.append(line);}
  }

  function syncFinishPlace(){
    const root=document.querySelector('.time-announcer-ui'),session=sessions.current()||eventIntent;
    if(!root||!latestFinish||!session||latestFinish.periodId!==session.periodId||latestFinish.accountId!==bridge.accountId())return;
    const board=cache.get(session.periodId)||read(STORE+'-'+session.periodId,null);
    let place=eventFinishPlace({board,periodId:session.periodId,trackId:latestFinish.trackId, ...latestFinish});
    const period=knownPeriods.get(session.periodId);
    if(period){const display=eventDisplayRows(period),mine=display.rows.find(row=>row.accountId===session.accountId);if(display.filterResult?.active){if(!mine)place=null;else if(display.filterResult.groupGrading)place={rank:mine.groupRank,fieldSize:display.rows.length,provisional:board?.complete!==true};}}
    root.querySelector('.sq-event-finish-place')?.remove();
    const current=root.querySelector('.current'),position=current?.querySelector('.position');
    if(!position)return;
    const text=place?eventOrdinal(place.rank):'';
    if(position.textContent!==text)position.textContent=text;
    if(current.classList.contains('show-position')!==!!place)current.classList.toggle('show-position',!!place);
    const detail=place?'Event place '+place.rank+(place.fieldSize===null?'':` of ${place.fieldSize}`)+(place.provisional?' (provisional)':''):'';
    if(position.title!==detail)position.title=detail;
  }
  function tick({cachedOnly=false}={}){
    syncFinishPlace();
    if(!cachedOnly)void flush();
    const view=nativeView,at=now();
    if(view&&!view.carObserver&&view.deferredCarRows.size&&at>=(view.nextDeferredCarRetryAt||0)){
      view.nextDeferredCarRetryAt=at+250;
      retryDeferredEventCarRenders(view,(button,style)=>renderCachedCar(button,style,false));
      drainRenders();
    }
    const ranked=document.getElementById('overallLeaderboardPanel');
    if(!cachedOnly&&ranked?.getClientRects().length&&getComputedStyle(ranked).display!=='none')void loadCatalog().catch(()=>{});
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
        const text=p?'Up to 700 Event RP':'Normal play available · event scoring unavailable';if(reward.textContent!==text)reward.textContent=text;
        const pb=infoNode.querySelector('.personal-best');if(pb&&p){const html=recordMarkup(p);if(pb.dataset.eventRecord!==html){pb.dataset.eventRecord=html;pb.innerHTML=html;}}
      }
    }
    if(!cachedOnly&&group?.getClientRects().length){void loadCatalog().catch(()=>{});void loadPermanent();}
    const permanentNote=group?.querySelector('.sq-permanent-note');
    if(permanentNote){
      const own=permanent?.entries?.find(row=>row.accountId===bridge.accountId());
      const elapsed=own?.runAt?Math.max(0,now()-own.runAt):null;
      const age=elapsed===null?'':elapsed<60000?' / just now':elapsed<3600000?' / '+Math.floor(elapsed/60000)+'m ago':elapsed<86400000?' / '+Math.floor(elapsed/3600000)+'h ago':' / '+Math.floor(elapsed/86400000)+'d ago';
      const text=own?'Normal RP + '+Math.round(Number(own.rp)||0)+' / 1001 Event RP'+age:'Normal RP + up to 1001 Event RP / No reset';
      if(permanentNote.textContent!==text)permanentNote.textContent=text;
      const title='Both rewards use your normal physics-verified personal best. Event RP follows the fastest verified Rolling Hills time; repeated runs do not stack.';
      if(permanentNote.title!==title)permanentNote.title=title;
    }
    if(group&&!group.querySelector('.sq-events-entry')){const button=document.createElement('button');button.type='button';button.className='button sq-events-entry';button.textContent='Event standings';button.setAttribute('aria-label','Event standings');button.addEventListener('click',e=>{e.stopPropagation();void open();});group.append(button);}
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
      const scheduleState=fetching?'loading':'unavailable';
      if(row.dataset.periods!==scheduleState){
        row.dataset.periods=scheduleState;row.replaceChildren();
        for(const kind of ['weekly','daily']){const button=document.createElement('button');button.className='button sq-event-card';button.type='button';button.dataset.eventKind=kind;
          button.innerHTML='<span class="sq-event-thumb" aria-hidden="true"></span><div class="sq-event-record">No record</div><span><small>'+eventName(kind)+' event</small><strong>'+(fetching?'Loading track...':'Schedule unavailable')+'</strong><span>Up to '+(kind==='weekly'?500:100)+' Event RP</span><small>'+(fetching?'Loading saved schedule':'Open Events to retry')+'</small></span>';button.onclick=()=>void open();row.append(button);}
      }
    }
    const session=sessions.current()||eventIntent;if(document.body.classList.contains('sq-event-active')!==!!session)document.body.classList.toggle('sq-event-active',!!session);
    syncNativeBoard(session||archiveIntent);
  }
  document.addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.repeat||event.ctrlKey||event.altKey||event.metaKey||!nativeView?.board?.getClientRects().length||dialog||document.querySelector('.sq-extra-overlay:not([hidden])'))return;
    const target=event.target;
    if(['INPUT','TEXTAREA','SELECT'].includes(target?.tagName)||target?.isContentEditable)return;
    if((event.key==='Enter'||event.key===' ')&&target?.closest?.('button,a[href],[role="button"]'))return;
    const board=nativeView.board,rows=[...board.querySelectorAll(':scope > .container > button.main')];
    if(eventDigitBoard!==board){eventDigitBoard=board;eventDigitsHeld.clear();eventDigitsConsumed.clear();eventTopPrefixUntil=0;eventTopHeld=false;}
    const pages=[...board.querySelectorAll(':scope > .pages > button.page')];
    const code=String(event.code||'').match(/^(?:Digit|Numpad)([0-9])$/);
    const digit=code?Number(code[1])||10:/^[0-9]$/.test(event.key)?Number(event.key)||10:null;
    let action=null;
    if(event.shiftKey&&digit){++topSelectionToken;action=pages[digit-1];}
    else if(!event.shiftKey&&digit){
      const identity=/^(?:Digit|Numpad)[0-9]$/.test(event.code||'')?event.code:'digit-'+String(event.key);
      eventDigitsHeld.set(identity,digit);
      const held=[...new Set(eventDigitsHeld.values())];
      if(held.length>=2){
        eventTopPrefixUntil=0;
        for(const id of eventDigitsHeld.keys())eventDigitsConsumed.add(id);
        void selectEventRange(Math.min(...held),Math.max(...held));
      }
      event.preventDefault();event.stopImmediatePropagation();return;
    }
    else if(event.key==='t'||event.key==='T'){eventTopHeld=true;eventTopPrefixUntil=Date.now()+2500;event.preventDefault();event.stopImmediatePropagation();return;}
    else if(event.key==='c'||event.key==='C'){event.preventDefault();event.stopImmediatePropagation();clearEventGhostSelection(nativeView.periodId,bridge.accountId());message('Event ghosts unselected.');return;}
    else if(!event.shiftKey&&(event.key==='='||event.key==='Backspace')){event.preventDefault();event.stopImmediatePropagation();void selectEventYouGroup();return;}
    else if(!event.shiftKey&&event.key==='-'){
      const period=nativeView.period,ranked=eventDisplayRows(period).rows.filter(row=>!nativeView.onlyVerified||!row.pending),at=ranked.findIndex(row=>row.accountId===bridge.accountId());
      if(at>0){event.preventDefault();event.stopImmediatePropagation();void selectReplay(period,ranked[at-1]);}return;
    }
    else if(['ArrowLeft','a','A','ArrowRight','d','D'].includes(event.key)){
      ++topSelectionToken;
      const current=pages.findIndex(button=>button.classList.contains('selected'));
      action=pages[current+(['ArrowLeft','a','A'].includes(event.key)?-1:1)];
    }else if(event.key==='Enter'||event.key===' '){action=nativeView.root.querySelector('.side-panel button.play');}
    if(!action||action.disabled||action.getAttribute('aria-disabled')==='true')return;
    event.preventDefault();event.stopImmediatePropagation();action.click();
  },true);
  document.addEventListener('keyup',event=>{
    const key=String(event.key||'').toLowerCase();
    if(key==='t'&&eventTopHeld){eventTopHeld=false;event.preventDefault();event.stopImmediatePropagation();return;}
    const identity=/^(?:Digit|Numpad)[0-9]$/.test(event.code||'')?event.code:'digit-'+String(event.key);
    if(!eventDigitsHeld.has(identity))return;
    const digit=eventDigitsHeld.get(identity),chord=eventDigitsConsumed.delete(identity),board=eventDigitBoard;
    eventDigitsHeld.delete(identity);
    if(board===nativeView?.board&&board?.getClientRects().length&&!dialog&&!chord){
      if(eventTopHeld||Date.now()<eventTopPrefixUntil)void selectTopEventRows(digit);
      else{const row=board.querySelectorAll(':scope > .container > button.main')[digit-1];if(row?.getAttribute('aria-disabled')!=='true')row?.click();}
      eventTopPrefixUntil=0;
    }
    event.preventDefault();event.stopImmediatePropagation();
  },true);
  window.addEventListener('blur',()=>{eventDigitsHeld.clear();eventDigitsConsumed.clear();eventTopHeld=false;eventTopPrefixUntil=0;});
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
    if(button.matches('.track-info-ui .side-panel button.play')&&(nativeView&&!nativeView.archive||eventIntent||sessions.current())&&!nativePlayPermit){e.preventDefault();e.stopImmediatePropagation();void playEvent();return;}
    if(button.closest('.sq-events-overlay,.sq-event-inline,.sq-event-board,.sq-events-entry,.sq-event-track-buttons'))return;
    if(e.isTrusted&&(button.querySelector('.track-title')||/^(Back|Exit|Multiplayer)$/.test(button.textContent.trim()))){entryRequest++;sessions.leave();eventIntent=null;archiveIntent=null;tick();if(/^(Back|Exit)$/.test(button.textContent.trim()))refreshAfterNativeReturn();}
  },true);
  const refreshFromCachedState=()=>{if(document.visibilityState==='visible')tick({cachedOnly:true});};
  const refreshAfterNativeReturn=()=>{
    const render=()=>tick({cachedOnly:true});
    if(typeof requestAnimationFrame==='function')requestAnimationFrame(()=>{render();requestAnimationFrame(render);});else setTimeout(render,0);
    setTimeout(render,180);
  };
  document.addEventListener('visibilitychange',refreshFromCachedState);
  window.addEventListener('pageshow',refreshFromCachedState);
  window.addEventListener('online',()=>void flush());
  window.addEventListener('storage',event=>{if(event.key===QUEUE){hasPending=read(QUEUE,[]).length>0;void flush();}if(event.key===PROFILE_CACHE)profilesAt=0;if(event.key===BEST){bestRecords=read(BEST,{});lastInline='';}});
  window.addEventListener('pt-personal-filters-changed',()=>{
    if(nativeView&&!nativeView.archive){nativeView.signature='';nativeView.quickSignature='';syncNativeBoard(sessions.current()||eventIntent||archiveIntent);}
    const list=dialog?.querySelector('.sq-event-results');
    if(selected&&list){const board=cache.get(selected.id)||read(STORE+'-'+selected.id,null);if(board){const raw=now()>=selected.endsAt?archivePeriodCounts(selected,board).verifiedEntries:board.entries||[];const filtered=bridge.filterRows?.(raw,{trackId:selected.trackId,event:true,maxRp:selected.maxRp,complete:board.complete===true});list.innerHTML=rows(filtered?.rows||raw)||'<li>No racers match these filters.</li>';message(filtered?.active?'Personal filters are active.':'Published standings.');}}
  });
  return {isEntered:trackId=>sessions.current()?.trackId===trackId,featuredSection:()=>ensureFeaturedSection(document),open,openEvent,totals,tick,flush,getOwnReplay,resumeRace,refreshCatalog:loadCatalog,leave(){entryRequest++;sessions.leave();eventIntent=null;archiveIntent=null;tick();}};
}
