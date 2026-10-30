import {archivePeriodCounts,archiveSnapshotState,catalogArchivePeriods,mountArchiveView} from './archive-view.mjs?v=216';
import {readSavedArchiveTrack} from './archive-track.mjs?v=216';
import {preparePublishedEventGhost} from './public-replay.mjs';
import {getPlaybackWorkerBridge} from '../tools/playback-worker-bridge.mjs';
import {eventFinishPlace} from './placement.mjs';
import {createEventSession,keepEventBest,matchingEventRuns} from './session.mjs';
import {installNativeLocalBinding} from './native-binding.mjs?v=153';
import {installFinishCapture} from './native-finish.mjs';
import {prepareOwnEventGhost} from './native-replay.mjs';
import {confirmPartialReplaySelection} from '../tools/partial-replay-selection.mjs?v=216';
import {finishOrdinal} from '../tools/finish-presentation.mjs?v=216';
const STORE='polytrack-062-events-v1',QUEUE=STORE+'-queue',BEST=STORE+'-best';
const REPLAYS=STORE+'-replays',PROFILE_CACHE='polytrack-0.6.2-s1-overall-snapshot-v5';
const ROLLING_TRACK_ID='fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
const PERMANENT_ROLLING=Object.freeze({id:'permanent-rolling-hills',kind:'permanent',trackId:ROLLING_TRACK_ID,trackName:'Rolling Hills Racer',maxRp:1001,permanent:true});
export function eventResetLabel(period,locale){
  if(!Number.isSafeInteger(period?.endsAt)||period.endsAt<=0||period.endsAt>8640000000000000)return 'Reset date unavailable';
  return new Intl.DateTimeFormat(locale,{weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(period.endsAt)+' Local';
}
export function eventRewardLabel(period){
  const cap=period?.maxRp;
  return Number.isFinite(cap)&&cap>0?'Up to '+cap+' Event RP':'Event RP details unavailable';
}
export function eventRunDate(row,at=Date.now()){
  const stamp=eventDisplayRunAt(row,at);
  if(!stamp)return {label:'Date unavailable',title:'This saved result has no run date.'};
  const seconds=Math.floor((at-stamp)/1000),minutes=Math.floor(seconds/60),hours=Math.floor(minutes/60),days=Math.floor(hours/24);
  return {label:days?days+' day'+(days===1?'':'s')+' ago':hours?hours+' hour'+(hours===1?'':'s')+' ago':minutes?minutes+' min ago':'Just now',title:new Date(stamp).toLocaleString()};
}
export function eventVerificationLabel(row,pending=!!row?.pending,locale){
  const runAt=eventDisplayRunAt(row),verdictAt=!pending&&validEventTimestamp(row?.verifiedAt)?row.verifiedAt:null;
  const at=runAt||verdictAt;
  const prefix=runAt?!eventExactRunAt(row)&&!validEventTimestamp(row?.runAt)?'Received ':'':verdictAt?'Verification date ':'';
  const date=at?prefix+new Date(at).toLocaleString(locale,{year:'numeric',month:'2-digit',day:'2-digit',hour:'numeric',minute:'2-digit'}):'Date unavailable';
  return date+' - '+(pending?'Pending':'Verified');
}
export function eventExactRunAt(row,at=Date.now()){
  for(const field of ['runCreatedAt','pbAt','createdAt']){
    const value=Number(row?.[field]);
    if(Number.isSafeInteger(value)&&value>=946684800000&&value<=Math.min(at,8640000000000000))return value;
  }
  const uploadId=Number(row?.uploadId);
  if(Number.isSafeInteger(uploadId)&&uploadId>=946684800000000){
    const value=Math.floor(uploadId/1000);
    if(value<=Math.min(at,8640000000000000))return value;
  }
  return null;
}
function validEventTimestamp(value,at=Date.now()){
  return Number.isSafeInteger(value)&&value>=946684800000&&value<=Math.min(at,8640000000000000);
}
export function eventDisplayRunAt(row,at=Date.now()){
  return eventExactRunAt(row,at)||[row?.runAt,row?.submittedAt,row?.receivedAt].find(value=>validEventTimestamp(value,at))||null;
}
export function decorateEventRowPresentation(button,row,at=Date.now()){
  const position=button.querySelector('.left .position'),ordinal=eventOrdinal(row.rank);
  if(position&&ordinal){
    // Avoid the native suffix span/font, which can render "th" as an opaque glyph.
    position.textContent=ordinal;
    position.setAttribute('aria-label',ordinal);
    if(Number.isSafeInteger(row.originalRank)&&row.originalRank>0){
      position.dataset.sqOriginalRank=String(row.originalRank);
      position.title='Saved snapshot place #'+row.originalRank+(row.originalRank!==row.rank?'; visible field place #'+row.rank: '');
    }
  }
  const state=button.querySelector('.verified-state');
  if(!state)return;
  const verified=eventRowVerified(row);
  state.dataset.sqRunStatus=verified?'verified':'unchecked';
  state.classList?.toggle('verified',verified);state.classList?.toggle('pending',!verified);
  const icon=state.querySelector?.('img');
  if(icon){icon.src=verified?'images/state_verified.svg':'images/state_pending.svg';icon.alt=verified?'Verified replay':'Unverified recording';}
  const exact=eventExactRunAt(row,at);
  if(exact)state.dataset.sqPbAt=String(exact);else delete state.dataset.sqPbAt;
  const label=eventVerificationLabel(row,!verified);
  // The shared status decorator preserves this date, including its receipt-time qualifier.
  state.dataset.sqNativeDate=label.slice(0,label.lastIndexOf(' - '));
  const dateText=[...state.childNodes].find(node=>node.nodeType===3);
  if(dateText&&!eventDisplayRunAt(row,at)&&verified&&validEventTimestamp(row?.verifiedAt,at))dateText.textContent=state.dataset.sqNativeDate;
  if(!eventDisplayRunAt(row,at)&&(!verified||!validEventTimestamp(row?.verifiedAt,at))){
    const text=[...state.childNodes].find(node=>node.nodeType===3);
    if(text)text.textContent='Date unavailable';
  }
  state.title=label;state.setAttribute('aria-label',label);
}
export function eventStandingsLabel(board,at=Date.now(),failed=false){
  if(board?._publicBackup){
    const packageAt=Number(board._snapshotPackageAt)||0,changed=Number(board.updatedAt)||0;
    const age=value=>{const m=Math.max(0,Math.floor((at-value)/60000));return m<1?'less than 1m':m<60?m+'m':m<1440?Math.floor(m/60)+'h':Math.floor(m/1440)+'d';};
    return (failed||board._eventRefreshFailed?'Refresh failed. ':'')+'Snapshot package · '+(packageAt?age(packageAt)+' old':'age unknown')+(changed?' · Standings changed '+age(changed)+' ago':'');
  }
  const capture=board?._publicBackup&&Number(board._snapshotCapturedAt)>0?Number(board._snapshotCapturedAt):0;
  const stamp=capture||Number(board?.updatedAt)||0,seconds=stamp?Math.max(0,Math.floor((at-stamp)/1000)):null;
  const age=seconds===null?'':seconds<60?'just now':seconds<3600?Math.floor(seconds/60)+'m':seconds<86400?Math.floor(seconds/3600)+'h':Math.floor(seconds/86400)+'d';
  const source=board?._publicBackup?'Snapshot data':board?.saved?'Cached standings':board?.archived?'Final standings':'Published standings';
  const freshness=capture?(seconds<60?'less than 1m old':age+' old'):age?'updated '+age+(seconds<60?'':' ago'):'update time unavailable';
  return (failed||board?._eventRefreshFailed?'Refresh failed. ':'')+source+' · '+freshness;
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
const EVENT_RECORD_HASH=/^[a-f0-9]{64}$/,EVENT_RECORD_LIMIT=10000,EVENT_PENDING_LIMIT=512,EVENT_TIME_LIMIT=300000;
export function eventPendingRows(pending){
  if(!Array.isArray(pending)||pending.length>EVENT_PENDING_LIMIT)return [];
  const byAccount=new Map(),runIds=new Set();
  for(const row of pending){
    if(!EVENT_RECORD_HASH.test(row?.accountId||'')||!EVENT_RECORD_HASH.test(row.runId||'')||runIds.has(row.runId)||!Number.isSafeInteger(row.timeMs)||row.timeMs<=0||row.timeMs>EVENT_TIME_LIMIT||row.verificationStatus!=='waiting'||row.pending!==true||row.verified!==false||row.eventRpEligible!==false||row.source!=='pending-event-playback')continue;
    runIds.add(row.runId);
    const prior=byAccount.get(row.accountId);
    if(!prior||row.timeMs<prior.timeMs)byAccount.set(row.accountId,{...row,pending:true,rank:null,rp:0});
  }
  return [...byAccount.values()];
}
export function eventRowVerified(row){
  return !!row&&row.pending!==true&&row.needsReview!==true&&row.reviewHold!==true&&
    !['verified','runVerified','physicsVerified','replayIntegrityVerified','integrityVerified','eventRpEligible'].some(field=>row[field]===false)&&
    !['status','verificationStatus'].some(field=>row[field]!==undefined&&row[field]!=='verified');
}
export function eventVerifiedPendingMatch(board,candidate){
  const period=board?.period;
  if(!period?.id||!EVENT_RECORD_HASH.test(period.trackId||'')||!EVENT_RECORD_HASH.test(candidate?.accountId||'')||
    !EVENT_RECORD_HASH.test(candidate.replayHash||'')||!Number.isSafeInteger(candidate.timeMs)||
    candidate.periodId!==undefined&&candidate.periodId!==period.id||candidate.trackId!==undefined&&candidate.trackId!==period.trackId||
    ['needsReview','reviewHold','excluded','unscored'].some(key=>candidate[key]===true)||
    ['status','verificationStatus','reason'].some(key=>typeof candidate[key]==='string'&&/held|hold|review|rejected|mismatch|unavailable/.test(candidate[key])))return null;
  return (board.entries||[]).find(row=>row.accountId===candidate.accountId&&row.timeMs===candidate.timeMs&&
    row.replayHash===candidate.replayHash&&eventRowVerified(row)&&
    (row.physicsVerified===true&&row.replayIntegrityVerified===true||row.runVerified===true&&row.integrityVerified===true)&&
    (row.trackId===undefined||row.trackId===period.trackId)&&(row.periodId===undefined||row.periodId===period.id)&&
    (!candidate.runId||!row.runId||candidate.runId===row.runId))||null;
}
export async function eventLocalReplayBinding(local,period,accountId,retained){
  if(!local||!period?.id||!EVENT_RECORD_HASH.test(period.trackId||'')||!EVENT_RECORD_HASH.test(accountId||'')||
    !Array.isArray(retained)||retained.length>8)return null;
  const raw=retained.find(row=>row?.attemptId===local.attemptId&&row.timeMs===local.timeMs&&row.accountId===accountId&&
    row.periodId===period.id&&row.trackId===period.trackId);
  if(!raw||typeof local.attemptId!=='string'||!local.attemptId||raw.frames!==raw.timeMs||
    !Number.isSafeInteger(raw.timeMs)||raw.timeMs<1||raw.timeMs>EVENT_TIME_LIMIT||
    typeof raw.replay!=='string'||!raw.replay.length||raw.replay.length>65536||!/^[A-Za-z0-9_-]+$/.test(raw.replay)||
    !globalThis.crypto?.subtle)return null;
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(raw.replay));
  return {accountId,periodId:period.id,trackId:period.trackId,timeMs:raw.timeMs,attemptId:raw.attemptId,
    replayHash:Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('')};
}
export function eventPublishedPbCoversReceipt(receipt,local,period,published){
  const {board,accountId}=published||{};
  if(!EVENT_RECORD_HASH.test(accountId||'')||!period?.id||!period.trackId||!period.kind||
    board?.period?.id!==period.id||board.period.trackId!==period.trackId||board.period.kind!==period.kind||
    !Array.isArray(board.entries)||receipt&&!['waiting','expired','verified','no_improvement'].includes(receipt.status))return false;
  for(const candidate of [receipt,local])if(candidate){
    if(!Number.isSafeInteger(candidate.timeMs)||candidate.timeMs<=0||candidate.timeMs>EVENT_TIME_LIMIT||
      candidate.accountId!==undefined&&candidate.accountId!==accountId||
      candidate.periodId!==undefined&&candidate.periodId!==period.id||candidate.trackId!==undefined&&candidate.trackId!==period.trackId||
      candidate.needsReview===true||candidate.reviewHold===true||candidate.excluded===true||candidate.unscored===true||
      ['status','verificationStatus','reason','validationState'].some(field=>typeof candidate[field]==='string'&&
        /held|hold|review|rejected|mismatch|unavailable/.test(candidate[field])))return false;
  }
  const times=[local?.timeMs,receipt?.timeMs].filter(value=>Number.isSafeInteger(value)&&value>0&&value<=EVENT_TIME_LIMIT);
  if(!times.length)return false;
  const fastest=Math.min(...times);
  // This suppresses a stale PB note, not the verdict of any individual attempt.
  const exact=[local,receipt].find(candidate=>candidate?.timeMs===fastest);
  return board.entries.some(row=>row?.accountId===accountId&&eventRowVerified(row)&&
    (row.trackId===undefined||row.trackId===period.trackId)&&(row.periodId===undefined||row.periodId===period.id)&&
    Number.isSafeInteger(row.timeMs)&&row.timeMs>0&&(row.timeMs<fastest||row.timeMs===fastest&&
      eventVerifiedPendingMatch(board,{...exact,accountId})===row));
}
export function eventSnapshotRows(board,{onlyVerified=false,local=null,filterRows,context={}}={}){
  const byAccount=new Map();
  const add=(row,preferLocal=false)=>{
    if(!EVENT_RECORD_HASH.test(row?.accountId||'')||!Number.isSafeInteger(row.timeMs)||row.timeMs<=0||row.timeMs>EVENT_TIME_LIMIT||
      row.trackId!==undefined&&board?.period?.trackId!==row.trackId||row.periodId!==undefined&&board?.period?.id!==row.periodId||
      row.needsReview===true||row.reviewHold===true||
      ['status','verificationStatus'].some(field=>row[field]!==undefined&&!['verified','waiting','pending'].includes(row[field])))return;
    const pending=!eventRowVerified(row);
    if(onlyVerified&&pending)return;
    const prior=byAccount.get(row.accountId);
    if(!prior||row.timeMs<prior.timeMs||row.timeMs===prior.timeMs&&(prior.pending&&!pending||preferLocal&&
      EVENT_RECORD_HASH.test(prior.replayHash||'')&&EVENT_RECORD_HASH.test(row.replayHash||'')&&prior.replayHash!==row.replayHash))
      byAccount.set(row.accountId,{...row,pending,originalRank:Number.isSafeInteger(row.rank)&&row.rank>0?row.rank:null});
  };
  for(const row of Array.isArray(board?.entries)?board.entries:[])add(row);
  if(!onlyVerified)for(const row of eventPendingRows(board?.pendingPlaybacks))if(!eventVerifiedPendingMatch(board,row))add(row);
  if(local&&!onlyVerified&&!eventVerifiedPendingMatch(board,local)){
    // Equal times do not prove that a different local recording was verified.
    add(local,true);
  }
  const rankRows=values=>{
    const sorted=[...values].sort((a,b)=>a.timeMs-b.timeMs||a.accountId.localeCompare(b.accountId));
    let rank=0;
    return sorted.map((row,index)=>{if(!index||row.timeMs!==sorted[index-1].timeMs)rank=index+1;return {...row,rank,groupRank:rank};});
  };
  const sourceRows=rankRows(byAccount.values()).map(row=>({...row,globalRank:row.originalRank??row.rank}));
  const filtered=filterRows?.(sourceRows,context);
  const rows=rankRows(filtered?.rows||sourceRows);
  return {rows,sourceRows,filterResult:filtered?{...filtered,rows,filteredCount:rows.length}:null};
}
export function eventSnapshotFields(board,options={}){
  const all=eventSnapshotRows(board,{...options,onlyVerified:false});
  const verified=eventSnapshotRows(board,{...options,onlyVerified:true});
  const pending=all.rows.filter(row=>row.pending).length;
  return {all,verified,counts:{all:all.rows.length,verified:verified.rows.length,
    pending,verifiedInAll:all.rows.length-pending}};
}
export function eventPagination(rowCount,page=0){
  const size=Number.isSafeInteger(rowCount)&&rowCount>0?rowCount:0;
  const pageCount=Math.max(1,Math.ceil(size/20));
  const current=Math.max(0,Math.min(pageCount-1,Number.isSafeInteger(page)?page:0));
  const width=pageCount<1000?7:pageCount<100000?5:3;
  const start=Math.max(0,Math.min(current-Math.floor(width/2),pageCount-width));
  return {page:current,pageCount,offset:current*20,
    pages:Array.from({length:Math.min(width,pageCount)},(_,index)=>start+index)};
}
export function renderEventPagination(view,rowCount,render){
  const state=eventPagination(rowCount,view.page),pages=view.board.querySelector('.pages');
  view.page=state.page;view.pageCount=state.pageCount;
  view.changePage=page=>{
    const next=eventPagination(rowCount,page).page;
    if(next===view.page)return;
    view.page=next;view.signature='';render();
  };
  pages.replaceChildren();pages.setAttribute('aria-label','Event standings pages');
  const add=(page,text,label,numbered=false)=>{
    const button=pages.ownerDocument.createElement('button');
    button.type='button';button.className='button'+(numbered?' page':'')+(numbered&&page===view.page?' selected':'');
    button.textContent=text;button.setAttribute('aria-label',label);
    button.disabled=page<0||page>=state.pageCount||numbered&&page===view.page;
    if(numbered){button.dataset.eventPage=String(page+1);if(page===view.page)button.setAttribute('aria-current','page');}
    button.onclick=()=>view.changePage(page);pages.append(button);
  };
  add(state.page-1,'<','Previous event page');
  for(const page of state.pages)add(page,String(page+1),'Event page '+(page+1),true);
  add(state.page+1,'>','Next event page');
  return state;
}
export function eventFieldSummary(board,counts,onlyVerified=false){
  const loaded=board?.complete===false||board?.sourceComplete===false||board?.publicationPending===true||
    board?.pagination?.hasMore===true||Number.isSafeInteger(board?.totalEntries)&&board.totalEntries>(board.entries?.length||0);
  return (loaded?'Loaded: ':'')+(onlyVerified?counts.verified+' verified player'+(counts.verified===1?'':'s'):counts.all+' player'+(counts.all===1?'':'s')+' · '+counts.verifiedInAll+' verified');
}
export function retainEventSnapshotDates(board,prior,at=Date.now()){
  if(!prior||board?.period?.id!==prior.period?.id||board.period.trackId!==prior.period.trackId||board.period.kind!==prior.period.kind)return board;
  const previous=[...(prior.entries||[]),...eventPendingRows(prior.pendingPlaybacks)];
  const entries=(board.entries||[]).map(row=>{
    if(!row||typeof row!=='object')return row;
    const saved=previous.find(old=>old?.accountId===row.accountId&&old.timeMs===row.timeMs&&
      ((row.runId&&old.runId===row.runId)||(row.replayHash&&old.replayHash===row.replayHash))&&
      (!row.runId||!old.runId||row.runId===old.runId)&&(!row.replayHash||!old.replayHash||row.replayHash===old.replayHash));
    if(!saved)return row;
    const dates={};
    for(const field of ['runCreatedAt','pbAt','createdAt','runAt','submittedAt','receivedAt','verifiedAt'])
      if(!validEventTimestamp(row[field],at)&&validEventTimestamp(saved[field],at)&&
        (field!=='verifiedAt'||eventRowVerified(row)&&eventRowVerified(saved)))dates[field]=saved[field];
    if(!row.uploadId&&eventExactRunAt({uploadId:saved.uploadId},at))dates.uploadId=saved.uploadId;
    return {...row,...dates};
  });
  return {...board,entries};
}
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
    accounts.add(row.accountId);published.push({...row});
  }
  published.sort((a,b)=>a.timeMs-b.timeMs||a.accountId.localeCompare(b.accountId));
  let expectedRank=0;
  for(let index=0;index<published.length;index++){if(!index||published[index].timeMs!==published[index-1].timeMs)expectedRank=index+1;if(published[index].rank!==expectedRank)return null;}
  const byAccount=new Map(published.filter(row=>eventRowVerified(row)||policy!=='verified'&&row.needsReview!==true&&row.reviewHold!==true&&
    !['status','verificationStatus'].some(field=>row[field]!==undefined&&!['verified','waiting','pending'].includes(row[field])))
    .map(row=>[row.accountId,{...row,pending:!eventRowVerified(row)}]));
  if(policy!=='verified'){
    const pending=board.pendingPlaybacks??[];
    if(!Array.isArray(pending)||pending.length>EVENT_PENDING_LIMIT)return null;
    const runIds=new Set();
    for(const row of pending){
      if(!EVENT_RECORD_HASH.test(row?.accountId||'')||!EVENT_RECORD_HASH.test(row.runId||'')||runIds.has(row.runId)||!Number.isSafeInteger(row.timeMs)||row.timeMs<=0||row.timeMs>EVENT_TIME_LIMIT||row.verificationStatus!=='waiting'||row.pending!==true||row.verified!==false||row.eventRpEligible!==false||row.source!=='pending-event-playback')return null;
      runIds.add(row.runId);const prior=byAccount.get(row.accountId);
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
  const title=place.visibleField?`Visible event place #${place.rank} of ${place.knownFieldSize} loaded racers${place.provisional?' (provisional)':''}. `+
    (Number.isSafeInteger(place.originalRank)?`Saved snapshot place #${place.originalRank}. `:'')+'This is the filtered loaded field, not the complete event field.':
    (place.provisional?`Provisional event place #${place.rank} from verified and waiting snapshot records. `:`Verified event place #${place.rank}. `)+'Complete field size is unavailable.';
  return Object.freeze({text:`#${place.rank}${place.provisional?'*':''}`,className:'sq-event-place'+(podium?' '+podium:''),title,ariaLabel:title});
}
export function eventOrdinal(rank){
  const ordinal=finishOrdinal(rank);
  return ordinal?ordinal.number+ordinal.suffix:'';
}
export function eventOwnPlacementPresentation(place){
  const presentation=eventPlacementPresentation(place);
  if(!presentation)return null;
  const size=place.knownFieldSize,known=Number.isSafeInteger(size)&&size>=place.rank;
  const title=known?`${eventOrdinal(place.rank)} of ${size} loaded racers${place.provisional?' (provisional)':''}.`:presentation.title;
  return {...presentation,text:eventOrdinal(place.rank)+(known?' / '+size:'')+(place.provisional?'*':''),title,ariaLabel:title};
}
export function eventTrackName(period,lookup){
  const publicName=typeof period?.trackName==='string'?period.trackName.trim():'';
  let catalogName='';try{catalogName=String(lookup?.(period?.trackId)?.name||'').trim();}catch{}
  const label=typeof period?.label==='string'?period.label.trim():'';
  return publicName||catalogName||label||'Event track';
}
export function ensureFeaturedSection(document,selection=null){
  selection=selection||document.querySelector('.track-selection-ui');
  const nav=selection?.querySelector('.community-track-versions');
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
  const rolling=[...selection.querySelectorAll('img[src*="rolling_hills_racer"]')]
    .map(image=>image.closest('.track')).find(track=>track&&!track.closest('.sq-featured-events'));
  let featured=section.querySelector(':scope > .sq-permanent-track');
  if(!featured&&rolling){
    featured=rolling;
    featured.classList.add('sq-permanent-track');featured.dataset.sqPermanentFeatured='true';
    const featuredButton=featured.querySelector(':scope > button');
    section.__sqPermanentSourceGroup=featured.parentElement;
    section.append(featured);
    const note=document.createElement('small');note.className='sq-permanent-note';
    note.textContent='Normal RP + up to 1001 Event RP / No reset';featuredButton?.append(note);
  }
  const source=section.__sqPermanentSourceGroup;
  if(source?.parentElement===nav.parentElement&&source.matches('.community-track-group')){
    const groups=[...nav.parentElement.children].filter(node=>node.matches('.community-track-group'));
    const tabs=[...nav.querySelectorAll(':scope > button')],tab=tabs[groups.indexOf(source)];
    // Hide only the author group emptied by our promotion, never an unrelated tab.
    if(tab?.textContent.trim()==='StaticQuasar931'&&!source.querySelector('.track')){
      source.hidden=true;tab.dataset.sqFeaturedEmpty='true';tab.hidden=true;
      tab.style.setProperty('display','none','important');tab.setAttribute('aria-hidden','true');tab.tabIndex=-1;
      if(tab.classList.contains('selected')){
        const next=tabs.find(node=>node!==tab&&!node.hidden&&node.textContent.trim()==='0.6.3')||tabs.find(node=>node!==tab&&!node.hidden);
        next?.click();
      }
    }else if(tab?.dataset.sqFeaturedEmpty==='true'){
      source.hidden=false;tab.hidden=false;delete tab.dataset.sqFeaturedEmpty;
      tab.style.removeProperty('display');tab.removeAttribute('aria-hidden');tab.removeAttribute('tabindex');
    }
  }
  return section;
}
// The native formatter consumes Time.numberOfFrames, not a millisecond scalar.
function nativeEventRow(row,accountId,runAt){
  const verified=eventRowVerified(row);
  // These are native UI aliases only, not changes to snapshot proof or RP authority.
  return {...row,pending:!verified,runVerified:verified,verifiedState:verified?1:0,
    timeMs:{numberOfFrames:row.timeMs},isSelf:row.accountId===accountId,runAt};
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
  let boundaryTimer=null;
  let statusText='',latestFinish=null,permanent=read(STORE+'-permanent',null),permanentAt=0,permanentFetching=null;
  const cache=new Map(),snapshotFetching=new Map(),snapshotAttempts=new Map(),knownPeriods=new Map();let lastInline='';let bestRecords=read(BEST,{}),hasPending=read(QUEUE,[]).length>0;
  const now=()=>Date.now();
  const activePeriods=()=>liveTimedEventPeriods(catalog.periods,now());
  const livePeriods=activePeriods;
  const info=id=>{const p=[...knownPeriods.values(),...(catalog.periods||[]),...(catalog.archives||[])].find(p=>p.trackId===id&&p.trackName);return p?{...bridge.trackInfo(id),name:p.trackName}:bridge.trackInfo(id);};
  const periodName=period=>eventTrackName(period,info);
  const time=ms=>Number.isFinite(ms)&&ms>0?bridge.formatTime(ms):'No event time';
  const localHashRequests=new Map();
  const localBest=period=>{
    const accountId=bridge.accountId(),key=period.id+'_'+accountId,local=bestRecords[key];
    if(local&&!EVENT_RECORD_HASH.test(local.replayHash||'')&&localHashRequests.get(key)!==local.attemptId){
      const retained=read(REPLAYS,[]);
      if(Array.isArray(retained)&&retained.slice(0,8).some(row=>row?.attemptId===local.attemptId&&row.periodId===period.id&&row.accountId===accountId)){
        if(localHashRequests.size>=8)localHashRequests.delete(localHashRequests.keys().next().value);
        localHashRequests.set(key,local.attemptId);
        // Hash only retained local bytes, once per PB. This is identity, not proof.
        void eventLocalReplayBinding(local,period,accountId,retained.slice(0,8)).then(binding=>{
          if(!binding||bestRecords[key]?.attemptId!==binding.attemptId||bestRecords[key]?.timeMs!==binding.timeMs)return;
          bestRecords[key]={...bestRecords[key],...binding};cacheWrite(BEST,bestRecords);lastInline='';tick({cachedOnly:true});
        }).catch(()=>{});
      }
    }
    return local;
  };
  const displayName=row=>bridge.displayName?.(row.accountId,row.name,Number(row.identityUpdatedAt)||0)||row.name||'Racer';
  const reset=eventResetLabel;
  function storeCatalog(value){if(!value||!Array.isArray(value.periods))throw Error('Event catalog is unavailable.');catalog=value;cacheWrite(STORE,value);catalogAt=now();catalogFreshUntil=eventCatalogFreshUntil(value.periods,catalogAt);
    clearTimeout(boundaryTimer);
    const boundary=Math.min(...value.periods.flatMap(p=>p.enabled===false||p.archived?[]:[p.startsAt,p.endsAt]).filter(t=>Number.isSafeInteger(t)&&t>catalogAt));
    if(Number.isFinite(boundary))boundaryTimer=setTimeout(()=>void loadCatalog(true),Math.min(2147483647,Math.max(1,boundary-catalogAt+25)));
    return value;}
  async function loadPermanent(){
    if(typeof bridge.readPermanent!=='function')return permanent;
    if(permanentFetching)return permanentFetching;
    if(now()-permanentAt<300000)return permanent;
    permanentAt=now();permanentFetching=bridge.readPermanent().then(value=>{
      if(value?.id!=='permanent-rolling-hills'||value.kind!=='permanent'||value.trackId!==ROLLING_TRACK_ID||value.complete!==true||!Array.isArray(value.entries)||value.maxRp!==1001)throw Error('Incomplete permanent event standings');
      if(bridge.snapshotOnly?.()||!permanent||value.sourceRevision>=permanent.sourceRevision){permanent=value;cacheWrite(STORE+'-permanent',value);}
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
    const candidate=cache.get(period.id)||(!bridge.snapshotOnly?.()?read(STORE+'-'+period.id,null):null),saved=valid(candidate)?candidate:null;
    if(snapshotFetching.has(period.id))return snapshotFetching.get(period.id);
    if(period.archived===true||saved?.archived===true){
      if(cache.get(period.id)===saved&&saved?.archived===true)return saved;
      if(typeof bridge.readArchivedSnapshot!=='function')throw Error('Saved final archive is unavailable');
      const pending=Promise.resolve().then(()=>bridge.readArchivedSnapshot(period.id)).then(archived=>{
        // An ended catalog period is not evidence that its saved board is final.
        if(!valid(archived))throw Error('Invalid saved archive snapshot');
        const final={...archived,fetchedAt:now(),saved:false};
        cache.set(period.id,final);cacheWrite(STORE+'-'+period.id,final);
        return final;
      }).finally(()=>snapshotFetching.delete(period.id));
      snapshotFetching.set(period.id,pending);
      return pending;
    }
    // Browser storage can belong to an older package. Read this package once before reusing it.
    if(!force&&saved&&cache.get(period.id)===saved)return saved;
    const attempt=snapshotAttempts.get(period.id);
    if(attempt&&now()<attempt.nextAt&&(!force||!bridge.snapshotOnly?.())){if(saved)return saved;if(attempt.error)throw attempt.error;}
    const state={nextAt:now()+60000,error:null};snapshotAttempts.set(period.id,state);
    if(snapshotAttempts.size>128)snapshotAttempts.delete(snapshotAttempts.keys().next().value);
    const confirmSchedulePeriod=value=>{
      const confirmed=value.period,index=(catalog.periods||[]).findIndex(item=>item.id===confirmed.id&&item.scheduleOnly===true&&item.trackId===confirmed.trackId&&item.kind===confirmed.kind);
      if(index<0)return;
      const enriched={...catalog.periods[index],...confirmed,scheduleOnly:false};
      knownPeriods.set(enriched.id,enriched);
      catalog={...catalog,periods:catalog.periods.map((item,i)=>i===index?enriched:item)};
      cacheWrite(STORE,catalog);catalogAt=now();catalogFreshUntil=eventCatalogFreshUntil(catalog.periods,catalogAt);
    };
    let pending;pending=(async()=>{
      try{const value=await bridge.readSnapshot(period.id,{refresh:force});if(!valid(value))throw Error('Invalid event snapshot');if(value._eventRefreshFailed){state.error=Error('Event refresh failed');state.nextAt=now()+120000;}confirmSchedulePeriod(value);const current=cache.get(period.id)||saved;if(!bridge.snapshotOnly?.()&&valid(current)&&current.updatedAt>value.updatedAt)return current;const next={...retainEventSnapshotDates(value,current,now()),fetchedAt:now(),saved:false};cache.set(period.id,next);cacheWrite(STORE+'-'+period.id,next);return next;}
      catch(error){state.error=error;state.nextAt=now()+120000;if(saved){const fallback={...saved,saved:true};cache.set(period.id,fallback);return fallback;}throw error;}
      finally{if(snapshotFetching.get(period.id)===pending)snapshotFetching.delete(period.id);}
    })();
    snapshotFetching.set(period.id,pending);
    return pending;
  }
  function updateEventRefreshControl(){
    const button=dialog?.querySelector('[data-event-refresh]');if(!button||!selected)return;
    if(bridge.snapshotOnly?.()){button.disabled=true;button.textContent='Snapshot standings';button.title='Standings update with the published snapshot.';return;}
    const remaining=Math.max(0,Math.ceil(((snapshotAttempts.get(selected.id)?.nextAt||0)-now())/1000));
    button.disabled=remaining>0;
    const label=remaining?'Refresh in '+remaining+'s':'Refresh standings';
    if(button.textContent!==label)button.textContent=label;
    button.title=remaining?'Standings are saved. A short cooldown prevents repeated cloud requests.':'Check for newer event standings';
  }
  function message(text){statusText=text;for(const status of document.querySelectorAll('.sq-event-status,.sq-event-inline-status'))if(status.textContent!==text)status.textContent=text;}
  async function flush(){
    if(!hasPending||flushing||now()<retryAt||navigator.onLine===false)return;
    flushing=true;
    try{
      for(const run of read(QUEUE,[])){
        if(run.accountId!==bridge.accountId())continue;
        if(now()>=run.endsAt){message('An offline event run missed the closing time. Your normal PB is unchanged.');write(QUEUE,read(QUEUE,[]).filter(row=>row.attemptId!==run.attemptId));continue;}
        try{await bridge.submit(run);write(QUEUE,read(QUEUE,[]).filter(row=>row.attemptId!==run.attemptId));message('Event PB submitted. Waiting for replay verification.');cache.delete(run.periodId);invalidateReceipt(run.periodId+'_'+run.accountId);}
        catch(error){retryAt=now()+60000;message('Event PB saved on this device. Cloud submission will retry.');break;}
      }
    }finally{hasPending=read(QUEUE,[]).length>0;flushing=false;}
  }
  function captured(run){
    const at=now(),intent=sessions.current()||eventIntent;
    latestFinish=null;
    if(archiveIntent)return;
    const periods=[...(catalog.periods||[]),...(intent&&knownPeriods.has(intent.periodId)?[knownPeriods.get(intent.periodId)]:[])];
    const matches=matchingEventRuns(run,periods,bridge.accountId(),at);
    for(const eventRun of matches){
      const key=eventRun.periodId+'_'+eventRun.accountId,prior=bestRecords[key];
      if(intent?.periodId===eventRun.periodId)latestFinish={...eventRun,previousTimeMs:prior?.timeMs};
      if(prior&&prior.timeMs<=eventRun.timeMs)continue;
      invalidateReceipt(key);
      write(QUEUE,keepEventBest(read(QUEUE,[]),eventRun));hasPending=true;
      bestRecords[key]={accountId:eventRun.accountId,periodId:eventRun.periodId,trackId:eventRun.trackId,
        timeMs:eventRun.timeMs,attemptId:eventRun.attemptId,carStyle:eventRun.carStyle,at};
      write(BEST,bestRecords);
      const replays=read(REPLAYS,[]);
      cacheWrite(REPLAYS,[{...eventRun,at},...(Array.isArray(replays)?replays:[]).filter(row=>row.periodId!==eventRun.periodId||row.accountId!==eventRun.accountId)].slice(0,8));
    }
    if(matches.length){tick({cachedOnly:true});void flush();}
  }
  function ensureCapture(){
    if(capture)return;
    const require=bridge.require();if(!require)throw Error('The game is still loading. Try again.');
    const binding=installNativeLocalBinding({require,onError:()=>{if(sessions.current())message('Event recording is not ready. Reopen this event and restart the race.');}});
    try{capture=installFinishCapture({Car:binding.Car,bindCar:car=>{const context=binding.bindCar(car);if(context){latestFinish=null;sessions.bind(context);}return context;},shouldCapture:context=>context.accountId===bridge.accountId()&&activePeriods().some(period=>period.trackId===context.trackId),validateFinish:binding.validateFinish,onFinish:captured,onError:()=>message('Event recording could not be captured. Your normal PB still saves.')});}
    catch(error){binding.stop();throw error;}
  }
  async function race(period,{direct=false}={}){
    archiveIntent=null;if(direct)close();
    shell();selected=period;body('<p role="status">Opening event...</p><p>You can cancel with Close. Your saved PBs are unchanged.</p>');message('Preparing event racing.');
    const attempt=++entryRequest,accountId=bridge.accountId();
    let intent=null;
    try{
      if(now()>=period.endsAt)throw Error('This event has ended.');
      // Local capture/play do not require Firebase. Keep a cancellation checkpoint
      // before binding; the durable upload queue retries cloud submission later.
      await Promise.resolve();
      if(attempt!==entryRequest||accountId!==bridge.accountId()||!dialog||selected?.id!==period.id)return false;
      ensureCapture();
      if(attempt!==entryRequest||accountId!==bridge.accountId()||!dialog||selected?.id!==period.id)return false;
      intent=sessions.enter(period,accountId);eventIntent=intent;
      tick({cachedOnly:true});close();message('Opening event track...');
      const navigationRequest=entryRequest;
      nativeOpenPermit=true;
      let opened;
      try{opened=await bridge.openTrack(period.trackId);}finally{nativeOpenPermit=false;}
      if(navigationRequest!==entryRequest||accountId!==bridge.accountId()||sessions.current()!==intent||eventIntent!==intent){
        if(sessions.current()===intent&&eventIntent===intent){sessions.leave();eventIntent=null;tick({cachedOnly:true});}
        return false;
      }
      if(opened===false)throw Error('The event track could not open. Please try again.');
      tick();void refreshNativeEventData(period,intent);return true;
    }
    catch(error){const ownsIntent=!!intent&&sessions.current()===intent&&eventIntent===intent;if(ownsIntent){sessions.leave();eventIntent=null;}if((attempt===entryRequest||ownsIntent)&&accountId===bridge.accountId()){shell();message(error.message);body('<p>The event track could not be opened. Your saved records are unchanged.</p>');}return false;}
  }
  async function openEvent({kind,trackId}={}){
    archiveIntent=null;sessions.leave();eventIntent=null;tick();
    shell();selectView('home');selected=null;const token=++requestId;
    body('<p>Checking event availability...</p>');
    try{
      if(!['daily','weekly','kodub'].includes(kind)||!/^[a-f0-9]{64}$/.test(trackId||''))throw Error('Invalid event assignment.');
      await loadCatalog();if(!dialog||token!==requestId)return false;
      const matches=activePeriods().filter(p=>p.kind===kind&&p.trackId===trackId);
      if(matches.length!==1){body('<p>This '+escape(kind)+' event is unavailable for this track. No event race was opened.</p>');return false;}
      knownPeriods.set(matches[0].id,matches[0]);return await race(matches[0],{direct:true});
    }catch{if(dialog&&token===requestId)body('<p>Event availability could not be checked. Try again from Events. No event race was opened.</p>');return false;}
  }
  function close(){entryRequest++;if(!dialog)return;dialog.remove();dialog=null;selected=null;requestId++;returnFocus?.isConnected&&returnFocus.focus({preventScroll:true});}
  function shell(){
    if(dialog)return;
    returnFocus=document.activeElement;dialog=document.createElement('div');dialog.className='sq-events-overlay';dialog.innerHTML='<section class="sq-events-dialog" role="dialog" aria-modal="true" aria-labelledby="sqEventsTitle"><header><h2 id="sqEventsTitle">Events</h2><button type="button" class="button" data-event-close>Close</button></header><nav><button type="button" class="button" data-event-home>Live events</button><button type="button" class="button" data-event-totals>Event RP</button><button type="button" class="button" data-event-archives>Past events</button></nav><p class="sq-event-status" role="status" aria-live="polite"></p><main></main></section>';document.body.append(dialog);
    dialog.addEventListener('click',e=>{if(e.target===dialog||e.target.closest('[data-event-close]'))return close();if(e.target.closest('[data-event-home]'))void open();if(e.target.closest('[data-event-totals]'))void totals();if(e.target.closest('[data-event-archives]'))void archives();if(e.target.closest('[data-event-month-go]'))void archives(dialog.querySelector('[data-event-month]').value);if(e.target.closest('[data-event-permanent]'))return void openPermanent();const card=e.target.closest('[data-event-id]');if(card){const period=knownPeriods.get(card.dataset.eventId)||[...(catalog.periods||[]),...(catalog.archives||[])].find(p=>p.id===card.dataset.eventId);if(period){if(period.scheduleOnly)void openPeriod(period);else if(period.startsAt<=now()&&period.endsAt>now())void race(period,{direct:true});else void openPeriod(period);}}if(e.target.closest('[data-event-race]')&&selected)void race(selected);if(e.target.closest('[data-event-refresh]')&&selected&&now()<selected.endsAt)void openPeriod(selected,true);if(e.target.closest('[data-event-practice]')&&selected)void practice(selected);});
    dialog.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}if(e.key==='Tab'){const buttons=[...dialog.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled])')].filter(e=>e.getClientRects().length);const first=buttons[0],last=buttons.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first.focus();}}});
    dialog.querySelector('[data-event-close]').focus();
  }
  const body=html=>{if(!dialog)return;const main=dialog.querySelector('main');const restore=main.contains(document.activeElement);main.innerHTML=html;if(restore)dialog.querySelector('[data-event-close]').focus({preventScroll:true});};
  function displayedRecordPlacement(period,own,board,filterResult){
    const settings=readEventPlacementSettings();
    if(!settings.enabled||!own)return null;
    const display=eventDisplayRows(period,{onlyVerified:settings.policy==='verified'}),rows=display.rows;
    const mine=rows.find(row=>row.accountId===bridge.accountId()&&row.timeMs===own.timeMs);
    return mine?{rank:mine.rank,fieldSize:rows.length,knownFieldSize:rows.length,provisional:rows.some(row=>row.pending),
      policy:settings.policy,visibleField:true,originalRank:mine.originalRank}:null;
  }
  function recordMarkup(period){
    if(period?.scheduleOnly){const own=localBest(period);return own?'<time>'+time(own.timeMs)+'</time><small>Saved on this device</small>':'No event time';}
    const {rows,board,filterResult,sourceOwn}=eventDisplayRows(period),shown=rows.find(row=>row.accountId===bridge.accountId()),own=shown||sourceOwn;
    if(!own)return 'No record';
    const presentation=shown?eventOwnPlacementPresentation(displayedRecordPlacement(period,own,board,filterResult)):null;
    return '<time>'+time(own.timeMs)+'</time>'+(presentation?'<span class="'+presentation.className+'" title="'+presentation.title+'" aria-label="'+presentation.ariaLabel+'">'+presentation.text+'</span>':own.pending?' <small>Pending</small>':'');
  }
  function cardStandings(period){
    if(period.scheduleOnly)return '';
    const board=cache.get(period.id)||(!bridge.snapshotOnly?.()?read(STORE+'-'+period.id,null):null);
    if(!board)return '<small class="sq-event-card-summary">View standings and replays</small>';
    const entries=(Array.isArray(board.entries)?board.entries:[]).filter(row=>row&&row.pending!==true&&row.needsReview!==true&&row.reviewHold!==true&&
      !['verified','runVerified','physicsVerified','replayIntegrityVerified','integrityVerified','eventRpEligible'].some(field=>row[field]===false)&&
      !['status','verificationStatus'].some(field=>row[field]!==undefined&&row[field]!=='verified'));
    const pending=(Array.isArray(board.pendingPlaybacks)?board.pendingPlaybacks:[]).filter(row=>row?.pending===true&&row.verified===false&&row.verificationStatus==='waiting'&&row.source==='pending-event-playback'&&row.needsReview!==true&&row.reviewHold!==true);
    const loaded=new Set([...entries,...pending].map(row=>row.accountId)).size;
    const count=Number.isInteger(board.racerCount)?board.racerCount:Number.isInteger(board.entrantCount)?board.entrantCount:loaded;
    const leader=[...entries].sort((a,b)=>a.timeMs-b.timeMs)[0];
    const pointTotal=Number.isFinite(board.totalRp)?' · '+Math.round(board.totalRp)+' Event RP awarded':'';
    return '<small class="sq-event-card-summary">'+count+' '+(Number.isInteger(board.racerCount)||Number.isInteger(board.entrantCount)?'racers':'loaded racers')+' · '+entries.length+' verified'+pointTotal+'</small>'+
      (leader?'<small class="sq-event-card-leader">Leader: '+escape(displayName(leader))+' · '+time(leader.timeMs)+'</small>':'');
  }
  function cards(periods,{details=false}={}){periods.forEach(p=>knownPeriods.set(p.id,p));return periods.map(p=>`<button type="button" class="sq-event-card" data-event-id="${escape(p.id)}" data-event-kind="${escape(p.kind)}"><span class="sq-event-thumb">${bridge.thumbnail(p.trackId)}</span><div class="sq-event-record">${recordMarkup(p)}</div><span><small>${escape(p.kind==='daily'?'DAILY EVENT':p.kind==='weekly'?'WEEKLY EVENT':p.kind==='kodub'?'KODUB WEEKLY':p.label||'EVENT')}</small><strong>${escape(periodName(p))}</strong><span class="sq-event-card-details"><span class="sq-event-reward"${p.scheduleOnly?' title="Scheduled reward cap. Scoring and published standings await event service confirmation."':''}>${escape(eventRewardLabel(p))}</span>${details?cardStandings(p):''}${Number.isInteger(p.entrantLimit)?`<small class="sq-event-capacity">Up to ${p.entrantLimit} racers</small>`:''}<small class="sq-event-reset">${now()<p.endsAt?'Resets':'Ended'} ${escape(reset(p))}</small></span></span></button>`).join('');}
  function permanentCard(loading=false){
    const counts=archivePeriodCounts(PERMANENT_ROLLING,permanent),own=counts.verifiedEntries.find(row=>row.accountId===bridge.accountId());
    const record=own?'<time>'+time(own.timeMs)+'</time>'+ (Number.isFinite(own.rp)?'<small>'+Math.round(own.rp)+' Event RP</small>':''):loading?'<small>Loading verified record...</small>':'No verified record';
    const count=counts.racers===null?'':`<small>${counts.racers} ${counts.racers===1?'racer':'racers'} · ${counts.verified} verified</small>`;
    return `<button type="button" class="sq-event-card sq-event-permanent" data-event-permanent><span class="sq-event-thumb">${bridge.thumbnail(ROLLING_TRACK_ID)}</span><div class="sq-event-record">${record}</div><span><small>PERMANENT EVENT</small><strong>Rolling Hills Racer</strong><span class="sq-event-reward">Normal RP + up to 1001 Event RP</span>${count}<small>No reset</small></span></button>`;
  }
  function selectView(view){entryRequest++;message('');for(const button of dialog.querySelectorAll('nav button'))button.setAttribute('aria-pressed',String(button.hasAttribute('data-event-'+view)));}
  async function open(){shell();selectView('home');selected=null;const token=++requestId;body('<p>Loading events...</p>');try{await loadCatalog();if(!dialog||token!==requestId)return;body('<div class="sq-event-browser-heading"><h3>Live events</h3><p>Choose a track for standings, replays, or your next PB.</p></div><div class="sq-event-cards">'+cards(livePeriods().filter(p=>p.kind==='kodub'),{details:true})+permanentCard(true)+cards(livePeriods().filter(p=>p.kind!=='kodub').sort((a,b)=>['weekly','daily'].indexOf(a.kind)-['weekly','daily'].indexOf(b.kind)),{details:true})+'</div>');message(['Event RP is separate from Overall RP.',bridge.dataNotice?.()||''].filter(Boolean).join(' '));void loadPermanent().then(()=>{if(!dialog||token!==requestId||!dialog.querySelector('[data-event-permanent]'))return;const active=document.activeElement;if(active?.closest('[data-event-permanent]'))return;const holder=document.createElement('div');holder.innerHTML=permanentCard(false);dialog.querySelector('[data-event-permanent]')?.replaceWith(holder.firstElementChild);}).catch(()=>{});}catch{if(token===requestId){body('<p>Events are unavailable. Normal racing and your saved PBs still work.</p>');}}}
  function receiptText(receipt,local,period,published){
    if(published&&eventPublishedPbCoversReceipt(receipt,local,period,published))return '';
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
    shell();const accountId=bridge.accountId(),closed=now()>=period.endsAt;selectView(closed?'archives':'home');selected=period;const token=++requestId;body('<p role="status">Loading event standings...</p>');
    try{
      const board=await snapshot(period,force&&!closed);
      const receipt=board.archived===true||period.archived===true?null:await readReceipt(period.id,accountId);
      if(!dialog||token!==requestId||accountId!==bridge.accountId())return;
      period=board.period;selected=period;
      const local=localBest(period),published=board.entries.find(row=>row.accountId===bridge.accountId());
      const submitted=receipt&&['waiting','verified'].includes(receipt.status)&&Number.isSafeInteger(receipt.timeMs)&&receipt.timeMs>0?receipt:null;
      const provisional=local&&(!submitted||local.timeMs<=submitted.timeMs)?local:submitted;
      const isLocal=provisional&&(!published||provisional.timeMs<published.timeMs),best=isLocal?provisional:published;
      const actions=closed?'<button class="button" type="button" data-event-practice>Practice track</button>':'<button class="button" type="button" data-event-race>Race event</button><button class="button" type="button" data-event-refresh>Refresh standings</button>';
      const counts=closed?archivePeriodCounts(period,board):null,rawStandings=(counts?counts.verifiedEntries:board.entries).filter(eventRowVerified);
      const display=eventSnapshotRows({...board,entries:rawStandings,pendingPlaybacks:[]},{onlyVerified:true,filterRows:bridge.filterRows,context:{trackId:period.trackId,event:true,maxRp:period.maxRp,complete:board.complete===true}});
      const filtered=display.filterResult,standings=counts&&!filtered?.active?rawStandings:display.rows;
      const winner=counts?.winner?` · Winner ${escape(displayName(counts.winner))} ${time(counts.winner.timeMs)}`:'';
      const archiveMeta=counts?`<p>${counts.racers} ${counts.racers===1?'racer':'racers'}${winner}</p>`:'';
      const receiptNote=receiptText(receipt,local,period,{board,accountId});
      body(`<div class="sq-event-heading"><span class="sq-event-thumb">${bridge.thumbnail(period.trackId)}</span><div><h3>${escape(periodName(period))}</h3><p>${escape(reset(period))} · ${closed?'Closed':'Open'}</p>${archiveMeta}<p>Your event PB: <b>${time(best?.timeMs)}</b> ${best?(isLocal?(provisional===local?'(saved on this device)':'(submitted)'):'(published)'):''}</p></div></div><div class="sq-event-actions">${actions}</div>${receiptNote?`<p class="sq-event-receipt" role="status">${escape(receiptNote)}</p>`:''}<p class="${board.saved?'sq-event-saved':''}">${escape(eventStandingsLabel(board,now(),!!snapshotAttempts.get(period.id)?.error))}</p><ol class="sq-event-results sq-event-verified-results">${rows(standings)||'<li>No verified event times yet.</li>'}</ol>`);
      message((filtered?.active?'Personal filters are active. ':'')+(closed?(board.archived?'Final standings. ':'Finalizing standings. ')+'Practice runs do not submit to the expired event.':'Only verified event runs earn Event RP.'));
      bridge.filterButton?.(dialog.querySelector('.sq-event-actions'));updateEventRefreshControl();
    }catch{if(token===requestId)body('<p>Event standings are unavailable. Please try again later.</p>');}
  }
  async function practice(period){
    if(period.kind==='custom'||period.historyOnly)return importArchived(period);
    const saved=cache.get(period.id)||(!bridge.snapshotOnly?.()?read(STORE+'-'+period.id,null):null);
    if(!saved||!Array.isArray(saved.entries)){message('Archived standings are not loaded. Reopen the archive card and try again.');return;}
    openArchivedTrack(period,saved);
  }
  async function importArchived(period){
    const token=++requestId,owner=dialog;
    const current=()=>!!owner&&token===requestId&&dialog===owner;
    message('Loading archived track for custom-track practice...');
    try{
      const code=await (typeof bridge.readArchivedTrack==='function'?bridge.readArchivedTrack(period):readSavedArchiveTrack(period,{decode:value=>bridge.require()?.(9117)?.A?.fromExportString(value),isCurrent:current}));if(!current())return;
      const result=bridge.importTrackCode(code,current);
      const handedOff=result&&typeof result.then==='function'?await result:result;
      if(!current())return;
      if(handedOff===false)throw Error('Archived track could not be imported. Please try again.');
      returnFocus=null;close();
    }catch(error){if(current())message(error?.message||'Archived track could not be imported.');}
  }
  async function totals(){if(typeof bridge.openRankedEvents==='function'){close();await bridge.openRankedEvents();return;}shell();selectView('totals');selected=null;const token=++requestId;body('<p>Loading Event RP...</p>');try{let data;try{data=await bridge.readTotals();if(!Array.isArray(data?.entries))throw Error('Invalid standings');cacheWrite(STORE+'-totals',data);}catch(error){data=read(STORE+'-totals',null);if(!data)throw error;data={...data,saved:true};}if(!dialog||token!==requestId)return;body('<h3>Lifetime Event RP</h3><p>'+data.entries.length+' racers loaded</p>'+(data.saved?'<p class="sq-event-saved">Saved standings</p>':'')+'<p>Points earned across events. Faster event PBs replace earlier points; repeated runs do not stack.</p><ol class="sq-event-results">'+(data.entries||[]).map((row,i)=>`<li><b>#${row.rank||i+1}</b><span>${escape(row.name||'Racer')}</span><span>${Number(row.events)||0} events</span><strong>${Number(row.rp)||0} RP</strong></li>`).join('')+'</ol>'+(!data.entries.length?'<p>No Event RP earned yet. Try a live event.</p>':''));}catch{if(token===requestId)body('<p>Event RP is unavailable right now.</p>');}}
  async function archives(month=''){
    shell();selectView('archives');selected=null;const token=++requestId;body('<p>Loading past events...</p>');
    try{
      const savedCatalog=await bridge.readStaticArchiveCatalog?.(),source=savedCatalog&&Array.isArray(savedCatalog.archives)?savedCatalog:catalog;
      const periods=catalogArchivePeriods(source,now()).map(period=>({...period,archived:true}));
      if(!dialog||token!==requestId)return;
      await bridge.prepareArchive?.();if(!dialog||token!==requestId)return;
      body('');
      mountArchiveView(dialog.querySelector('main'),{periods,month,formatTime:time,accountId:bridge.accountId(),snapshots:cache,
        resolveName:periodName,loadSnapshot:period=>snapshot(period,false),
        onOpenPeriod:(period,snapshot)=>void openArchivedTrack(period,snapshot),onImportPeriod:period=>void importArchived(period),renderThumbnail:period=>{const node=document.createElement('span');node.innerHTML=bridge.thumbnail(period.trackId);return node;}});
    }catch{if(token===requestId)body('<p>Past events are unavailable. Please try again.</p>');}
  }
  let nativeView=null,eventIntent=null,archiveIntent=null,featuredSelection=null;
  function isTrackNavigationCurrent(trackId,accountId=bridge.accountId()){
    const context=sessions.current()||archiveIntent;
    return context?.trackId===trackId&&context.accountId===accountId&&bridge.accountId()===accountId;
  }
  async function openArchivedTrack(period,saved){
    if(period?.kind==='custom'||period?.historyOnly)return importArchived(period);
    let snapshot=saved||cache.get(period?.id)||read(STORE+'-'+period?.id,null);
    if(!snapshot){
      const owner=dialog,token=requestId;
      try{snapshot=await loadArchivedBoard(period);}catch{if(dialog===owner&&requestId===token)message('Final standings are unavailable. Use Import saved track for practice.');return false;}
      if(dialog!==owner||requestId!==token)return false;
    }
    if(!period?.id||!period.trackId||!period.kind||snapshot?.period?.id!==period.id||snapshot.period.trackId!==period.trackId||snapshot.period.kind!==period.kind||
      !['final','partial-final','non-final'].includes(archiveSnapshotState(period,snapshot))){message('Archived standings are not loaded or do not match this event and track. Reopen the archive card and try again.');return false;}
    entryRequest++;sessions.leave();eventIntent=null;archiveIntent={archive:true,period,periodId:period.id,trackId:period.trackId,accountId:bridge.accountId(),snapshot};knownPeriods.set(period.id,period);close();message('Opening archived track for normal practice.');
    const intent=archiveIntent;
    nativeOpenPermit=true;try{if(await bridge.openTrack(period.trackId)===false)throw Error('The archived track could not open. Please try again.');}catch(error){if(archiveIntent===intent&&bridge.accountId()===intent.accountId){archiveIntent=null;message(error?.message||'Archived track could not be opened.');}return false;}finally{nativeOpenPermit=false;}
    if(archiveIntent!==intent||bridge.accountId()!==intent.accountId)return false;
    tick();return true;
  }
  async function loadArchivedBoard(period){return snapshot(period,false);}
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
    const candidates=[bridge.racerIdentity?.(row)?.carStyle,window.__polytrackCarStyleByUser062?.[row.accountId],row.carStyle,row.accountId===bridge.accountId()?localBest(period)?.carStyle:null,profileStyles.get(row.accountId)];
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
    const shown=eventDisplayRows(period,{onlyVerified:nativeView?.onlyVerified===true}).rows.find(entry=>entry.accountId===accountId);if(shown&&shown.timeMs<row.timeMs)return null;
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
  function cancelPendingEventGroups(){
    // Individual actions invalidate the batch token, so release all its loading rows.
    for(const [id,target] of pendingGhosts)if(target.groupToken)pendingGhosts.delete(id);
  }
  async function selectReplay(period,row,{silent=false}={}){
    const session=sessions.current()||archiveIntent,viewer=bridge.accountId(),readReplay=session?.archive?bridge.readArchivedReplay:bridge.readReplay;
    if(!session||session.periodId!==period.id||typeof readReplay!=='function')return;
    const pendingSelection=pendingGhosts.get(row.accountId);
    if(pendingSelection?.periodId===period.id&&pendingSelection.accountId===viewer&&pendingSelection.targetTimeMs===row.timeMs&&pendingSelection.targetPending===!!row.pending&&pendingSelection.targetRunId===(row.runId||null)){
      ++topSelectionToken;++replayRequest;pendingGhosts.delete(row.accountId);cancelPendingEventGroups();if(!silent)message('Event ghost selection cancelled.');tick();return false;
    }
    const previous=selectedGhosts.get(row.accountId);
    if(previous?.periodId===period.id&&previous.accountId===viewer&&previous.targetTimeMs===row.timeMs&&previous.targetPending===!!row.pending&&previous.targetRunId===(row.runId||null)){
      ++topSelectionToken;++replayRequest;pendingGhosts.delete(row.accountId);cancelPendingEventGroups();selectedGhosts.delete(row.accountId);selectedGhost=[...selectedGhosts.values()].at(-1)||null;if(!silent){message('Event ghost unselected.');tick();}return false;
    }
    ++topSelectionToken;const token=++replayRequest;cancelPendingEventGroups();const pending={periodId:period.id,accountId:viewer,targetAccountId:row.accountId,targetTimeMs:row.timeMs,targetPending:!!row.pending,targetRunId:row.runId||null,targetReplayHash:row.replayHash||null};pendingGhosts.set(row.accountId,pending);if(!silent){message('Loading event replay...');tick();}
    const key=(session.archive?'archive:':'live:')+period.id+'_'+row.accountId+'_'+row.timeMs+'_'+(row.runId||'verified')+'_'+(row.replayHash||''),failureKey=key+'_'+viewer;
    try{
      const failure=replayFailure(failureKey);if(failure)throw Error(failure);
      let payload=replayCache.get(key);if(!payload)payload=await readReplay(period.id,row.accountId,row.pending?row.runId:null,{timeMs:row.timeMs,trackId:period.trackId,runId:row.runId||null,replayHash:row.replayHash});
      if(!payload)throw Error(session.archive?'Saved archived replay is unavailable.':'Saved event replay unavailable.');
      if(pendingGhosts.get(row.accountId)!==pending)return;
      if(!replayContextActive(session)){pendingGhosts.delete(row.accountId);tick();return;}
      const ghostKey=key+'_'+viewer;
      let ghost=preparedGhosts.get(ghostKey);
      if(!ghost){ghost=await preparePublishedEventGhost({require:bridge.require(),row:payload,period,entry:row,viewer});preparedGhosts.set(ghostKey,ghost);if(preparedGhosts.size>16)preparedGhosts.delete(preparedGhosts.keys().next().value);}
      if(pendingGhosts.get(row.accountId)!==pending)return;
      if(!replayContextActive(session)){pendingGhosts.delete(row.accountId);tick();return;}
      replayFailures.delete(failureKey);if(replayCache.size>=16)replayCache.delete(replayCache.keys().next().value);replayCache.set(key,payload);
      const selection={periodId:period.id,accountId:viewer,targetAccountId:row.accountId,targetTimeMs:row.timeMs,targetPending:!!row.pending,targetRunId:row.runId||null,targetReplayHash:row.replayHash||null,ghost};
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
    const delay=Number.isFinite(error?.retryAfterMs)?Math.max(60000,Math.min(900000,error.retryAfterMs)):60000;
    replayFailures.delete(key);replayFailures.set(key,{message:error?.message||'Event replay unavailable. Please try again later.',until:now()+delay});
    if(replayFailures.size>32)replayFailures.delete(replayFailures.keys().next().value);
  }
  async function selectEventRows(first,last,fromTop=false,explicitRows=null){
    const view=nativeView,session=sessions.current()||archiveIntent,accountId=bridge.accountId();
    if(!view||!session||session.periodId!==view.periodId||session.accountId!==accountId)return;
    const readReplay=session.archive?bridge.readArchivedReplay:bridge.readReplay;
    if(typeof readReplay!=='function'){message(session.archive?'Saved archived replay is unavailable.':'Saved event replay unavailable.');return;}
    const period=view.period||knownPeriods.get(view.periodId)||(catalog.periods||[]).find(row=>row.id===view.periodId);if(!period)return;
    const offset=fromTop?0:view.page*20,sourceRows=view.archive?view.visibleRows||archivePeriodCounts(period,view.snapshot).verifiedEntries:eventDisplayRows(period,{onlyVerified:view.onlyVerified}).rows;
    const chosen=(explicitRows||sourceRows.slice(offset+first-1,offset+last)).slice(0,10).map(row=>({...row}));
    const active=[...selectedGhosts.values()].filter(row=>row.periodId===period.id&&row.accountId===accountId);
    const same=chosen.length>0&&active.length===chosen.length&&chosen.every(row=>{const selected=selectedGhosts.get(row.accountId);return selected?.periodId===period.id&&selected.accountId===accountId&&selected.targetTimeMs===row.timeMs&&selected.targetRunId===(row.runId||null)&&selected.targetPending===!!row.pending;});
    const pendingActive=[...pendingGhosts.values()].filter(row=>row.periodId===period.id&&row.accountId===accountId),groupToken=pendingActive[0]?.groupToken;
    const pendingSame=chosen.length>0&&Number.isSafeInteger(groupToken)&&pendingActive.length===chosen.length&&chosen.every(row=>{const pending=pendingGhosts.get(row.accountId);return pending?.groupToken===groupToken&&pending.targetTimeMs===row.timeMs&&pending.targetRunId===(row.runId||null)&&pending.targetPending===!!row.pending;});
    if(fromTop)view.page=0;
    if(same||pendingSame){clearEventGhostSelection(period.id,accountId,{render:false});message('Event ghosts unselected.');tick();return;}
    for(const [id,row] of pendingGhosts)if(row.periodId===period.id&&row.accountId===accountId)pendingGhosts.delete(id);
    if(!chosen.length){message('No playable replays in these places.');tick();return;}
    const token=++topSelectionToken,requestToken=++replayRequest,page=view.page,trackId=period.trackId,onlyVerified=view.onlyVerified;
    const current=()=>{
      if(token!==topSelectionToken||requestToken!==replayRequest||nativeView!==view||view.page!==page||view.onlyVerified!==onlyVerified||period.trackId!==trackId||view.root&&!view.root.isConnected||!replayContextActive(session))return false;
      const latestRows=new Map((view.archive?view.visibleRows||archivePeriodCounts(period,view.snapshot).verifiedEntries:eventDisplayRows(period,{onlyVerified:view.onlyVerified}).rows).map(row=>[row.accountId,row]));
      return chosen.every(row=>{const latest=latestRows.get(row.accountId);return latest&&latest.timeMs===row.timeMs&&(latest.runId||null)===(row.runId||null)&&!!latest.pending===!!row.pending&&(latest.replayHash||null)===(row.replayHash||null);});
    };
    const release=()=>{for(const row of chosen)if(pendingGhosts.get(row.accountId)?.groupToken===token)pendingGhosts.delete(row.accountId);};
    for(const row of chosen)pendingGhosts.set(row.accountId,{periodId:period.id,accountId,targetAccountId:row.accountId,targetTimeMs:row.timeMs,targetPending:!!row.pending,targetRunId:row.runId||null,targetReplayHash:row.replayHash||null,groupToken:token});
    message(`Loading up to ${chosen.length} event replays...`);
    tick();
    const prepared=await Promise.all(chosen.map(async row=>{
      const pending=pendingGhosts.get(row.accountId);
      try{
        const key=(session.archive?'archive:':'live:')+period.id+'_'+row.accountId+'_'+row.timeMs+'_'+(row.runId||'verified')+'_'+(row.replayHash||'');
        const failureKey=key+'_'+accountId,failure=replayFailure(failureKey);if(failure)throw Error(failure);
        if(typeof readReplay!=='function'||row.pending&&!/^[a-f0-9]{64}$/.test(row.runId||''))throw Error('Saved event replay unavailable.');
        let payload=replayCache.get(key);if(!payload)payload=await readReplay(period.id,row.accountId,row.pending?row.runId:null,{timeMs:row.timeMs,trackId:period.trackId,runId:row.runId||null,replayHash:row.replayHash});
        if(!payload)throw Error(session.archive?'Saved archived replay is unavailable.':'Saved event replay unavailable.');
        if(token!==topSelectionToken||requestToken!==replayRequest||pendingGhosts.get(row.accountId)!==pending||!replayContextActive(session))return null;
        const ghostKey=key+'_'+accountId;let ghost=preparedGhosts.get(ghostKey);
        if(!ghost){ghost=await preparePublishedEventGhost({require:bridge.require(),row:payload,period,entry:row,viewer:accountId});preparedGhosts.set(ghostKey,ghost);if(preparedGhosts.size>16)preparedGhosts.delete(preparedGhosts.keys().next().value);}
        if(token!==topSelectionToken||requestToken!==replayRequest||pendingGhosts.get(row.accountId)!==pending||!replayContextActive(session))return null;
        replayFailures.delete(failureKey);if(replayCache.size>=16)replayCache.delete(replayCache.keys().next().value);replayCache.set(key,payload);
        return {row,ghost};
      }catch(error){if(token===topSelectionToken&&requestToken===replayRequest&&pendingGhosts.get(row.accountId)===pending)rememberReplayFailure((session.archive?'archive:':'live:')+period.id+'_'+row.accountId+'_'+row.timeMs+'_'+(row.runId||'verified')+'_'+(row.replayHash||'')+'_'+accountId,error);return null;}
    }));
    if(token!==topSelectionToken||requestToken!==replayRequest){release();tick();return;}
    if(!current()){release();tick();return;}
    const ready=prepared.filter(Boolean),failed=chosen.filter((_row,index)=>!prepared[index]).map(row=>({row}));
    if(!ready.length){release();message('Saved event replays unavailable or failed playback validation. Your selection is unchanged.');tick();return;}
    if(failed.length){
      let accepted=false;
      try{accepted=await confirmPartialReplaySelection({document,ready,failed,isCurrent:current,source:'event',returnFocus:document.activeElement});}catch{}
      if(!current()){release();tick();return;}
      if(accepted!==true){release();message('Event ghost selection cancelled. Your previous selection is unchanged.');tick();return;}
    }
    clearEventGhostSelection(period.id,accountId,{render:false});
    for(const {row,ghost} of ready){
      const selection={periodId:period.id,accountId,targetAccountId:row.accountId,targetTimeMs:row.timeMs,targetPending:!!row.pending,targetRunId:row.runId||null,targetReplayHash:row.replayHash||null,ghost};
      if(selectedGhosts.size>=10&&!selectedGhosts.has(row.accountId))selectedGhosts.delete(selectedGhosts.keys().next().value);
      selectedGhosts.set(row.accountId,selection);selectedGhost=selection;
    }
    for(const row of chosen)if(pendingGhosts.get(row.accountId)?.groupToken===token)pendingGhosts.delete(row.accountId);
    message(`${ready.length} of ${chosen.length} ${fromTop?'top ':''}event ghosts ready. ${session.archive?'Use Watch to view them.':'Play to race them.'}`);
    tick();
  }
  function selectTopEventRows(count){return selectEventRows(1,count,true);}
  function selectEventRange(first,last){return selectEventRows(first,last,false);}
  function selectEventYouGroup(){
    const view=nativeView;if(!view)return;
    const rows=view.archive?view.visibleRows||archivePeriodCounts(view.period,view.snapshot).verifiedEntries:eventDisplayRows(view.period,{onlyVerified:view.onlyVerified}).rows;
    const chosen=rows.slice(0,9),mine=rows.find(row=>row.accountId===bridge.accountId());
    if(mine&&!chosen.some(row=>row.accountId===mine.accountId))chosen.push(mine);else if(rows[9])chosen.push(rows[9]);
    return selectEventRows(1,10,true,chosen);
  }
  function raceGhosts(session,onlyVerified=false){
    const period=knownPeriods.get(session.periodId);
    if(period){const allowed=new Map(eventDisplayRows(period,{onlyVerified}).rows.map(row=>[row.accountId,row]));for(const [id,row] of selectedGhosts){const current=allowed.get(id);if(row.periodId===session.periodId&&(!current||row.targetTimeMs!==current.timeMs||row.targetRunId!==(current.runId||null)||row.targetPending!==!!current.pending||row.targetReplayHash!==(current.replayHash||null)))selectedGhosts.delete(id);}}
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
    try{bridge.startEventRace({...session,...raceGhosts(session,nativeView?.onlyVerified===true)},invokeNative,()=>sessions.current()===session&&bridge.accountId()===session.accountId);}catch{message('Event race could not resume safely. Reopen Events.');}
    return true;
  }
  function watchEvent(){
    const session=sessions.current()||archiveIntent;if(!session||session.accountId!==bridge.accountId())return;
    if([...pendingGhosts.values()].some(row=>row.periodId===session.periodId&&row.accountId===session.accountId)){message('Selected replays are still loading. Wait or unselect them before watching.');return;}
    if(watchEvent.pending?.isCurrent())return watchEvent.pending.work;
    const job={isCurrent:()=>false};watchEvent.pending=job;
    // Watch must not use raceGhosts: it prunes selections before consent and reuses parsed ghosts.
    const work=(async()=>{
      try{
        const view=nativeView,root=document.querySelector('.track-info-ui'),period=view?.period||knownPeriods.get(session.periodId),token=replayRequest,page=view?.page,filter=view?.onlyVerified;
        const nativeWatch=root?.__pt062EventWatch;
        if(!root?.isConnected||nativeWatch?.version!==1||nativeWatch.trackId!==session.trackId||period?.id!==session.periodId||period.trackId!==session.trackId)throw Error('Event replay context changed. Reopen this track.');
        const selections=[...selectedGhosts.values()].filter(row=>row.periodId===session.periodId&&row.accountId===session.accountId);
        const own=!session.archive&&selections.length<10&&!selections.some(row=>row.targetAccountId===session.accountId)&&bridge.supportsEventGhost?.()?getOwnReplay(session.periodId):null;
        const boardRows=()=>session.archive?view?.visibleRows||archivePeriodCounts(period,view?.snapshot||session.snapshot).verifiedEntries:eventDisplayRows(period,{onlyVerified:view?.onlyVerified===true}).rows;
        const binding=row=>JSON.stringify(row&&[row.accountId,row.timeMs,row.runId||null,!!row.pending,row.replayHash||null,row.name]);
        const entries=new Map(boardRows().map(row=>[row.accountId,{...row}]));
        const current=()=>watchEvent.pending===job&&replayContextActive(session)&&root.isConnected&&document.querySelector('.track-info-ui')===root&&root.__pt062EventWatch===nativeWatch&&nativeView===view&&view?.page===page&&view?.onlyVerified===filter&&replayRequest===token&&
          selections.length===[...selectedGhosts.values()].filter(row=>row.periodId===session.periodId&&row.accountId===session.accountId).length&&selections.every(row=>selectedGhosts.get(row.targetAccountId)===row)&&
          selections.every(row=>binding(boardRows().find(entry=>entry.accountId===row.targetAccountId))===binding(entries.get(row.targetAccountId)))&&(!own||JSON.stringify(getOwnReplay(session.periodId))===JSON.stringify(own));
        job.isCurrent=current;
        const candidates=selections.map(selection=>({selection,row:entries.get(selection.targetAccountId)||{name:selection.ghost?.nickname||'Racer'}}));
        if(own)candidates.unshift({own:true,row:{name:'Your event PB'},payload:own});
        if(!candidates.length){message(session.archive?'Select an archived replay first.':'Select an event replay first, or set a local event PB.');return;}
        const prepare=async item=>{
          if(item.own)return prepareOwnEventGhost({require:bridge.require(),row:item.payload,session,best:bestRecords[session.periodId+'_'+session.accountId]});
          const {selection,row}=item;
          if(row.accountId!==selection.targetAccountId||row.timeMs!==selection.targetTimeMs||(row.runId||null)!==selection.targetRunId||!!row.pending!==selection.targetPending||(row.replayHash||null)!==selection.targetReplayHash)throw Error('Selected replay no longer matches standings.');
          const key=(session.archive?'archive:':'live:')+period.id+'_'+row.accountId+'_'+row.timeMs+'_'+(row.runId||'verified')+'_'+(row.replayHash||'');
          if(!item.payload){
            const readReplay=session.archive?bridge.readArchivedReplay:bridge.readReplay;
            item.payload=replayCache.get(key)||await readReplay?.(period.id,row.accountId,row.pending?row.runId:null,{timeMs:row.timeMs,trackId:period.trackId,runId:row.runId||null,replayHash:row.replayHash});
          }
          if(!item.payload)throw Error('Saved event replay unavailable.');
          return preparePublishedEventGhost({require:bridge.require(),row:item.payload,period,entry:row,viewer:session.accountId});
        };
        message('Checking selected replays for Watch...');
        const checked=await Promise.all(candidates.map(async item=>{try{const ghost=await prepare(item);return {...item,ghost};}catch(error){return {...item,error};}}));
        if(!current())return;
        const ready=checked.filter(item=>!item.error),failed=checked.filter(item=>item.error);
        if(!ready.length){message('No selected replay is ready to watch. Your selection is unchanged.');return;}
        if(ready.length>10){message('Watch supports up to 10 replays. Unselect extras to continue.');return;}
        if(failed.length){
          const accepted=await confirmPartialReplaySelection({document,ready,failed,isCurrent:current,source:'event',mode:'watch',returnFocus:root.querySelector('.side-panel button.watch')});
          if(!current())return;
          if(accepted!==true){message('Watch cancelled. Your selection is unchanged.');return;}
          // Recheck bytes, binding and live engine after the user has considered the choice.
          for(const item of ready)item.ghost=await prepare(item);
        }
        if(!current())return;
        const ghosts=ready.map(item=>item.ghost);
        if(session.archive)nativeWatch.open(ghosts);
        else{if(typeof bridge.watchEvent!=='function')throw Error('Event Watch is unavailable.');bridge.watchEvent(session,ghosts);}
        // Remove only explicitly skipped selections, and only after the native handoff succeeds.
        for(const item of failed)if(item.selection&&selectedGhosts.get(item.selection.targetAccountId)===item.selection)selectedGhosts.delete(item.selection.targetAccountId);
        selectedGhost=[...selectedGhosts.values()].at(-1)||null;
      }catch(error){message(error.message||'Event replay could not open. Your selection is unchanged.');}
    })();
    job.work=work;
    void work.finally(()=>{if(watchEvent.pending===job)watchEvent.pending=null;});
    return work;
  }
  async function playEvent(){
    const session=sessions.current();if(!session||now()>=session.endsAt||session.accountId!==bridge.accountId()){message('This event is no longer open for this racer. Reopen Events to continue.');return;}if(launching)return;
    if([...pendingGhosts.values()].some(row=>row.periodId===session.periodId&&row.accountId===session.accountId)){message('Selected replays are still loading. Wait or unselect them before playing.');return;}
    if(typeof bridge.startEventRace!=='function'){message('Event Play is unavailable: safe event race launch is not connected. Normal PB ghosts will not be used.');return;}
    const root=nativeView?.root||document.querySelector('.track-info-ui');
    const nativeTrack=()=>root?.isConnected&&root===document.querySelector('.track-info-ui')&&root.__pt062EventWatch?.version===1&&root.__pt062EventWatch.trackId===session.trackId;
    if(!nativeTrack()){message('The event track is still opening. Please try Play again.');return;}
    const replay=getOwnReplay(session.periodId),{ownGhost,opponents}=raceGhosts(session,nativeView?.onlyVerified===true);
    const token=replayRequest,selections=[...selectedGhosts.values()].filter(row=>row.periodId===session.periodId&&row.accountId===session.accountId);
    const period=knownPeriods.get(session.periodId);
    const binding=row=>JSON.stringify(row&&[row.accountId,row.timeMs,row.runId||null,!!row.pending,row.replayHash||null]);
    const bindings=selections.map(selection=>binding(eventDisplayRows(period,{onlyVerified:nativeView?.onlyVerified===true}).rows.find(row=>row.accountId===selection.targetAccountId)));
    // Before dispatch, selections must stay exact. Native disposal may clear them after the click.
    let committed=false;
    const handoffCurrent=()=>sessions.current()===session&&bridge.accountId()===session.accountId&&now()<session.endsAt;
    const current=()=>handoffCurrent()&&replayRequest===token&&
      selections.length===[...selectedGhosts.values()].filter(row=>row.periodId===session.periodId&&row.accountId===session.accountId).length&&
      selections.every((selection,index)=>selectedGhosts.get(selection.targetAccountId)===selection&&binding(eventDisplayRows(period,{onlyVerified:nativeView?.onlyVerified===true}).rows.find(row=>row.accountId===selection.targetAccountId))===bindings[index])&&(!ownGhost||[...selectedGhosts.values()].some(row=>row.ghost===ownGhost)||replay&&getOwnReplay(session.periodId)?.attemptId===replay.attemptId&&getOwnReplay(session.periodId)?.timeMs===replay.timeMs);
    launching=true;message(opponents.length?`Starting with ${opponents.length} selected event ghost${opponents.length===1?'':'s'}...`:ownGhost?'Starting with your event PB ghost...':'Starting event race...');
    try{
      // A nested HTMLElement.click() is suppressed while its original click is dispatching.
      await Promise.resolve();
      if(!nativeTrack()||!current())throw Error('Event launch context changed');
      // Parsed ghosts outlive workers. Reauthorize only indexed inputs, using cached engine assets.
      const indexed=[ownGhost,...opponents].filter(ghost=>ghost?.requiredPlaybackEngine);
      if(indexed.length>11)throw Error('Too many indexed event ghosts');
      if(indexed.length){
        const workerBridge=getPlaybackWorkerBridge();if(!workerBridge)throw Error('Indexed event playback unavailable');
        const recordings=new Map(indexed.map(ghost=>[ghost.recording.serialize(),ghost.time.numberOfFrames]));
        await Promise.all([...recordings].map(([recording,frames])=>workerBridge.prepareEventRecording(recording,frames)));
      }
      if(!nativeTrack()||!current())throw Error('Event launch context changed');
      await bridge.startEventRace({...session,ownGhost,opponents},()=>{
        if(!nativeTrack()||!current())throw Error('Event launch context changed');
        const play=root.querySelector('.side-panel button.play');if(!play||play.disabled)throw Error('Native Play is unavailable');
        let dispatched=false;const observed=()=>{dispatched=true;committed=true;};
        play.addEventListener('click',observed,{once:true,capture:true});
        nativePlayPermit=true;try{play.click();}finally{nativePlayPermit=false;play.removeEventListener('click',observed,true);}
        if(!dispatched)throw Error('Native Play click was not dispatched');
      },()=>committed?handoffCurrent():current());
    }
    catch{if(sessions.current()===session)message('Event race could not start safely. No normal PB ghost was loaded.');}
    finally{launching=false;}
  }
  const ownReceipts=new Map(),ownReceiptAt=new Map(),ownReceiptRequests=new Map();
  function invalidateReceipt(key){
    ownReceiptAt.delete(key);ownReceipts.delete(key);ownReceiptRequests.delete(key);
  }
  async function readReceipt(periodId,accountId){
    const key=periodId+'_'+accountId;
    if(bridge.snapshotOnly?.())return ownReceipts.get(key)||null;
    if(ownReceiptRequests.has(key))return ownReceiptRequests.get(key);
    if(ownReceiptAt.has(key)&&now()-ownReceiptAt.get(key)<60000)return ownReceipts.get(key);
    const at=now();ownReceiptAt.set(key,at);
    let pending;pending=(async()=>{
      try{
        const receipt=await bridge.readOwnStatus?.(periodId,accountId)??null;
        // A newly submitted PB invalidates the old in-flight receipt too.
        if(ownReceiptAt.get(key)===at&&ownReceiptRequests.get(key)===pending)ownReceipts.set(key,receipt);
        return receipt;
      }catch{return ownReceipts.get(key)||null;}
      finally{if(ownReceiptRequests.get(key)===pending)ownReceiptRequests.delete(key);}
    })();
    ownReceiptRequests.set(key,pending);return pending;
  }
  function clearNativeView(){
    if(!nativeView)return;
    if(nativeView.footerClickGuard)nativeView.nativeButtonWrapper?.removeEventListener('click',nativeView.footerClickGuard,true);
    nativeView.carObserver?.disconnect();nativeView.deferredCarRows?.clear();if(nativeView.contextMenuHandler)nativeView.board.removeEventListener('contextmenu',nativeView.contextMenuHandler);
    if(nativeView.nativeButtonWrapper){
      nativeView.eventBack?.replaceWith(nativeView.nativeBack);
      for(const [button,original] of nativeView.nativeButtons){
        for(const name of button.getAttributeNames())button.removeAttribute(name);
        for(const {name,value} of original.clone.attributes)button.setAttribute(name,value);
        button.onclick=original.onclick;
        button.disabled=original.disabled;
      }
      for(const child of [...nativeView.nativeButtonWrapper.children])if(!nativeView.nativeButtons.has(child))child.remove();
      nativeView.buttonPlaceholder.replaceWith(nativeView.nativeButtonWrapper);
    }
    nativeView.board.replaceChildren(nativeView.nativeMarkup);
    nativeView.board.classList.remove('sq-event-board');
    if(nativeView.nativeDisplay.value)nativeView.board.style.setProperty('display',nativeView.nativeDisplay.value,nativeView.nativeDisplay.priority);else nativeView.board.style.removeProperty('display');
    if(nativeView.nativeTitle)nativeView.board.title=nativeView.nativeTitle;else nativeView.board.removeAttribute('title');
    nativeView.pb?.remove();nativeView.pbTitle?.remove();
    if(nativeView.watch)nativeView.watch.disabled=nativeView.watchDisabled;
    nativeView.opponentsNote?.remove();
    nativeView.root.classList.remove('sq-event-layout-ready');
    nativeView=null;
  }
  async function refreshNativeEventData(period,session){
    const accountId=bridge.accountId();
    try{await snapshot(period);await readReceipt(period.id,accountId);if(!session||!replayContextActive(session))return;if(nativeView)nativeView.signature='';syncNativeBoard(session);}
    catch{if(sessions.current()===session){message('Standings unavailable. Your event runs save locally.');if(nativeView)nativeView.signature='';syncNativeBoard(session);}}
  }
  function eventDisplayRows(period,{onlyVerified=false}={}){
    const accountId=bridge.accountId();
    const candidate=cache.get(period.id)||(!bridge.snapshotOnly?.()?read(STORE+'-'+period.id,null):null);
    const board=candidate?.period?.id===period.id&&candidate.period.trackId===period.trackId&&candidate.period.kind===period.kind&&Array.isArray(candidate.entries)?candidate:null;
    const local=localBest(period),receipt=ownReceipts.get(period.id+'_'+accountId);
    const remote=receipt&&['waiting','verified'].includes(receipt.status)&&Number.isSafeInteger(receipt.timeMs)&&receipt.timeMs>0?receipt:null;
    const rejectedLocal=local?.attemptId&&receipt?.attemptId===local.attemptId&&['mismatch','unavailable_final','expired','rejected'].includes(receipt.status);
    const provisional=!rejectedLocal&&local&&(!remote||local.timeMs<=remote.timeMs)?local:remote;
    const published=board?.entries.find(row=>row.accountId===accountId);
    const bound=provisional&&(provisional.accountId===undefined||provisional.accountId===accountId)&&
      (provisional.trackId===undefined||provisional.trackId===period.trackId)&&(provisional.periodId===undefined||provisional.periodId===period.id);
    const localRow=bound?{...provisional,accountId,name:published?.name||'You',pending:true,rank:null,
      ...(validEventTimestamp(provisional.at,now())?{runAt:provisional.at}:{}),
      unscored:receipt?.attemptId===provisional.attemptId&&['mismatch','unavailable_final','expired','rejected'].includes(receipt?.status)}:null;
    const fields=eventSnapshotFields(board,{local:localRow,filterRows:bridge.filterRows,
      context:{trackId:period.trackId,event:true,maxRp:period.maxRp,complete:board?.complete===true}});
    const display=onlyVerified?fields.verified:fields.all;
    for(const row of display.rows)row.name=displayName(row);
    return {...display,board,counts:fields.counts,sourceOwn:display.sourceRows.find(row=>row.accountId===accountId)};
  }
  function syncNativeArchiveBoard(view){
    const {period,snapshot}=view;
    const state=archiveSnapshotState(period,snapshot),bound=!!period.id&&!!period.trackId&&!!period.kind&&
      snapshot?.period?.id===period.id&&snapshot.period.trackId===period.trackId&&snapshot.period.kind===period.kind&&
      ['final','partial-final','non-final'].includes(state);
    const counts=archivePeriodCounts(period,bound?snapshot:null),archived=bound?counts.verifiedEntries:[];
    if(view.watch)view.watch.disabled=!bound||typeof bridge.watchEvent!=='function'||![...selectedGhosts.values()].some(row=>row.periodId===period.id&&row.accountId===view.accountId);
    const eligible=archived.filter(row=>row.needsReview!==true&&row.reviewHold!==true&&
      !['physicsVerified','replayIntegrityVerified','integrityVerified'].some(field=>row[field]===false));
    const savedRows=eligible.map(row=>{
      const saved=snapshot.entries.find(entry=>entry?.accountId===row.accountId&&entry.timeMs===row.timeMs);
      const originalRank=Number.isSafeInteger(saved?.rank)&&saved.rank>0?saved.rank:null;
      return {...row,name:displayName(row),rank:originalRank,originalRank,pending:false};
    });
    const filtered=bridge.filterRows?.(savedRows,{trackId:period.trackId,event:true,maxRp:period.maxRp,complete:state==='final'});
    let rows=filtered?.rows||savedRows;
    if(filtered?.active||bound&&eligible.length!==snapshot.entries.length){
      rows=[...rows].sort((a,b)=>a.timeMs-b.timeMs||String(a.accountId).localeCompare(String(b.accountId)));
      let rank=0;rows=rows.map((row,index)=>{if(!index||row.timeMs!==rows[index-1].timeMs)rank=index+1;return {...row,rank,groupRank:rank};});
    }
    view.visibleRows=rows;
    const paging=eventPagination(rows.length,view.page);view.page=paging.page;
    const source=snapshot?._publicBackup?'Snapshot data':snapshot?.saved?'Cached data':'Saved event data';
    const label=!bound?'Standings unavailable':state==='final'?'Frozen final event standings':state==='partial-final'?'Saved partial final event standings':'Saved non-final event standings';
    const description=!bound?'Saved standings do not match this event and track.':state==='final'
      ?'Frozen final event standings as saved. Practice uses the separate ordinary track leaderboard and does not change Event RP.'
      :state==='partial-final'?'Only part of the final event standings was saved. Missing ranks and Event RP are unknown.'
      :'Final standings are unavailable. These are saved event results, not final awards or the ordinary practice leaderboard.';
    const signature=JSON.stringify([bridge.identityRevision?.(),bridge.filterRevision?.(),view.page,snapshot?.updatedAt,state,bound,counts.racers,source,rows.map(row=>[row.accountId,row.rank,row.originalRank,row.timeMs,row.name,row.rp,row.submittedAt,row.receivedAt,row.runAt,row.verifiedAt,row.pbAt,row.runCreatedAt,row.createdAt,row.uploadId])]);
    for(const button of view.board.querySelectorAll(':scope > .container > button.main')){const selected=selectedGhosts.get(button.dataset.eventAccountId),pending=pendingGhosts.get(button.dataset.eventAccountId),matches=row=>row?.periodId===period.id&&row.accountId===view.accountId&&row.targetTimeMs===Number(button.dataset.eventTime);const active=matches(selected),busy=matches(pending);button.classList.toggle('selected',!!(active||busy));button.classList.toggle('pending-selection',!!busy);button.setAttribute('aria-pressed',String(!!(active||busy)));button.setAttribute('aria-busy',String(!!busy));}
    if(signature===view.signature)return;
    view.signature=signature;view.board.title=description;
    view.board.querySelector('h2').textContent=label;
    view.board.querySelector('h3').textContent=eventName(period.kind)+' archive';
    view.board.querySelector('h3').title=source+': '+description;
    view.board.querySelector('.total-players').textContent=rows.length+' saved result'+(rows.length===1?'':'s')+
      (counts.racers===null?'':' / '+counts.racers+' event entrant'+(counts.racers===1?'':'s'))+' | '+rows.length+' verified displayed | '+label+' | '+source+(filtered?.active?' | personal filters':'')+' | Page '+(view.page+1)+' of '+paging.pageCount;
    const container=view.board.querySelector('.container');container.replaceChildren();
    for(const row of rows.slice(view.page*20,view.page*20+20)){
      const renderer=view.board.__pt062EventRows;if(renderer?.version!==1)break;
      const runAt=eventDisplayRunAt(row,now());
      const button=renderer.render(container,nativeEventRow({...row,rank:row.rank??''},view.accountId,runAt||now()));button.type='button';button.dataset.eventAccountId=row.accountId;button.dataset.eventTime=String(row.timeMs);button.dataset.eventRunId=row.runId||'';button.dataset.eventPending='false';const playable=typeof bridge.readArchivedReplay==='function';button.tabIndex=playable?0:-1;button.setAttribute('aria-disabled',String(!playable));button.setAttribute('aria-pressed','false');button.setAttribute('aria-busy','false');button.title=playable?'Select this archived replay. It will not submit an event result.':'Saved archived replay is unavailable.';if(playable)button.onclick=()=>void selectReplay(period,row);
      button.querySelector('.left p:not(.position)').classList.add('event-time');
      const state=button.querySelector('.verified-state');decorateEventRowPresentation(button,row,now());
      if(row.rank===null){const position=button.querySelector('.left .position');position.textContent='Rank unavailable';position.title='No rank was saved for this event result.';}
      const actions=event=>{if(typeof bridge.racerActions!=='function')return;event.preventDefault();event.stopPropagation();const rect=button.getBoundingClientRect();bridge.racerActions(row,{clientX:event.clientX||rect.left+rect.width/2,clientY:event.clientY||rect.top+rect.height/2});};button.oncontextmenu=actions;button.onkeydown=event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10')actions(event);};
      const points=document.createElement('span');points.className='sq-event-earned-rp';
      const hasRp=Number.isSafeInteger(row.rp)&&row.rp>=0,isFinal=snapshot.archived===true;
      points.textContent=hasRp?row.rp+' ERP'+(isFinal?'':' (saved)'):'ERP unavailable';
      points.title=!hasRp?'No Event RP was saved for this result.':isFinal?'Event RP from saved final standings.':'Event RP from a non-final capture, not a final award.';
      state.prepend(points);bridge.decorateRacer?.(button,row);
    }
    if(!rows.length){const empty=document.createElement('p');empty.className='error-message';empty.textContent=!bound?description:state==='final'?'No verified results are present in the saved final standings.':'No verified results are present in this saved capture. Final results are not known.';container.append(empty);}
    renderEventPagination(view,rows.length,()=>syncNativeArchiveBoard(view));
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
      const board=original;board.classList.add('sq-event-board');root.classList.add('sq-event-layout-ready');
      document.getElementById('polytrackTrackFreshness')?.remove();
      board.title=archiveMode?'Frozen archived standings. Practice runs are not submitted.':'A number toggles one event ghost. T then a number selects the top group. Hold two numbers for a range. C clears ghosts.';
      board.style.setProperty('display','flex','important');
      board.append(nativeMarkup.cloneNode(true));
      board.querySelector('.total-players').classList.remove('fade-in');
      board.querySelector('h2').textContent=archiveMode?'Archived event leaderboard':'Event leaderboard';
      let buttonWrapper=board.querySelector('.button-wrapper'),nativeButtonWrapper=null,buttonPlaceholder=null,nativeButtons=null,eventBack=null;
      if(!archiveMode){
        nativeButtonWrapper=nativeMarkup.querySelector('.button-wrapper');
        if(nativeButtonWrapper){
          nativeButtons=new Map([...nativeButtonWrapper.children].map(button=>[button,{clone:button.cloneNode(true),onclick:button.onclick,disabled:button.disabled}]));
          eventBack=nativeBack.cloneNode(true);
          nativeBack.replaceWith(eventBack);
          buttonPlaceholder=document.createComment('native leaderboard controls');
          nativeButtonWrapper.replaceWith(buttonPlaceholder);
          buttonWrapper.replaceWith(nativeButtonWrapper);
          buttonWrapper=nativeButtonWrapper;
        }
      }
      if(archiveMode){buttonWrapper.querySelectorAll('button:not(.back)').forEach(button=>button.remove());bridge.filterButton?.(buttonWrapper);}
      else{
        const verified=buttonWrapper.querySelector('.only-verified');verified.classList.add('disabled');verified.setAttribute('aria-pressed','false');verified.title='Show only verified event runs';
        bridge.filterButton?.(buttonWrapper);const findMe=buttonWrapper.querySelector('.icon-button.first');findMe.disabled=false;findMe.classList.add('sq-event-find-me');findMe.title='Find your event result';findMe.setAttribute('aria-label','Find your event result');
        const refresh=document.createElement('button');refresh.type='button';refresh.className='button icon-button sq-event-refresh';refresh.setAttribute('aria-label','Refresh event standings');refresh.title='Refresh event standings';refresh.innerHTML='<img class="button-icon" src="images/refresh.svg" alt="">';board.querySelector('h2').append(refresh);
      }
      const side=root.querySelector('.side-panel'),watch=side?.querySelector('button.watch'),opponents=side?.querySelector('.opponents-container');let pbTitle=null,pb=null,opponentsNote=null;
      if(!archiveMode){pbTitle=document.createElement('div');pbTitle.className='personal-best-title sq-event-personal-title';pbTitle.textContent='Event personal best';pb=document.createElement('div');pb.className='personal-best sq-event-personal';pb.style.setProperty('display','block','important');const normalPb=side?.querySelector('.personal-best-title');if(normalPb)normalPb.before(pbTitle,pb);opponentsNote=document.createElement('div');opponentsNote.className='opponents-container sq-event-opponents';opponentsNote.textContent='Event ghosts are not available. Normal PB ghosts are not used.';opponents?.after(opponentsNote);}
      const contextMenuHandler=archiveMode?null:event=>event.stopPropagation();
      const view=nativeView={root,board,nativeMarkup,nativeButtonWrapper,buttonPlaceholder,nativeButtons,eventBack,nativeBack,nativeDisplay,nativeTitle,pb,pbTitle,watch,watchDisabled:watch?.disabled,opponents,opponentsNote,period,periodId:period.id,accountId,page:0,onlyVerified:false,signature:'',carStyles:new WeakMap(),archive:archiveMode,snapshot:session.snapshot,contextMenuHandler};
      view.deferredCarRows=new Set();
      if(!archiveMode){if(typeof IntersectionObserver==='function')view.carObserver=new IntersectionObserver(entries=>handleEventCarIntersections(view,entries,renderCachedCar),{root:board.querySelector('.container'),rootMargin:'50px'});board.addEventListener('contextmenu',contextMenuHandler);
        const verified=buttonWrapper.querySelector('.only-verified');verified.onclick=()=>{view.onlyVerified=!view.onlyVerified;verified.classList.toggle('disabled',!view.onlyVerified);verified.setAttribute('aria-pressed',String(view.onlyVerified));view.page=0;view.signature='';view.quickSignature='';syncNativeBoard(session);};
        const findMe=buttonWrapper.querySelector('.sq-event-find-me');findMe.onclick=()=>{const index=eventDisplayRows(period,{onlyVerified:view.onlyVerified}).rows.findIndex(row=>row.accountId===accountId);if(index<0){message(view.onlyVerified?'Your run is not verified yet. Turn off Only verified to see it.':'Your event result is not in these loaded standings.');return;}view.page=Math.floor(index/20);view.signature='';view.quickSignature='';syncNativeBoard(session);const mine=board.querySelector('button.main.self');mine?.scrollIntoView({block:'nearest'});mine?.focus({preventScroll:true});};
        board.querySelector('.sq-event-refresh').onclick=async()=>{const button=board.querySelector('.sq-event-refresh');button.disabled=true;profilesAt=0;try{await snapshot(period,true);await readReceipt(period.id,accountId,true);if(nativeView!==view||bridge.accountId()!==accountId||sessions.current()!==session)return;view.signature='';syncNativeBoard(session);}catch{if(nativeView===view)message('Event standings could not refresh. Your saved event PB is unchanged.');}finally{button.disabled=false;}};
      }
      if(!archiveMode&&nativeButtonWrapper){
        view.footerClickGuard=event=>{
          const button=event.target.closest?.('.only-verified,.sq-event-find-me');
          if(!button||!nativeButtonWrapper.contains(button)||nativeView!==view)return;
          event.preventDefault();event.stopImmediatePropagation();button.onclick?.call(button,event);
        };
        nativeButtonWrapper.addEventListener('click',view.footerClickGuard,true);
      }
      board.querySelector('.back').onclick=()=>{
        if(nativeView!==view||!board.isConnected||bridge.accountId()!==view.accountId)return;
        const request=++entryRequest;
        sessions.leave();eventIntent=null;if(view.archive)archiveIntent=null;
        tick();nativeBack?.click();restoreTrackSelectionAfterBack(request,view.accountId);
      };
    }
    const view=nativeView;
    if(view.archive){syncNativeArchiveBoard(view);return;}
    const quickBoard=cache.get(period.id);
    if(quickBoard&&view.signature){
      const quickLocal=localBest(period),quickReceipt=ownReceipts.get(period.id+'_'+accountId);
      const selection=[...selectedGhosts.values()].filter(row=>row.periodId===period.id&&row.accountId===accountId).map(row=>[row.targetRunId,row.targetTimeMs,row.targetPending]);
      const pendingSelection=[...pendingGhosts.values()].filter(row=>row.periodId===period.id&&row.accountId===accountId).map(row=>[row.targetAccountId,row.targetRunId,row.targetTimeMs,row.targetPending,row.groupToken||0]);
      const quickSignature=JSON.stringify([bridge.identityRevision?.(),bridge.filterRevision?.(),quickBoard.updatedAt,quickBoard.saved,
        quickLocal?.attemptId,quickLocal?.timeMs,quickLocal?.needsReview,quickLocal?.reviewHold,quickLocal?.excluded,quickLocal?.unscored,quickLocal?.status,quickLocal?.verificationStatus,quickLocal?.validationState,quickLocal?.reason,
        quickLocal?.replayHash,quickLocal?.trackId,quickLocal?.periodId,
        quickReceipt?.attemptId,quickReceipt?.status,quickReceipt?.timeMs,quickReceipt?.reason,quickReceipt?.needsReview,quickReceipt?.reviewHold,quickReceipt?.excluded,quickReceipt?.unscored,quickReceipt?.verificationStatus,quickReceipt?.validationState,
        quickReceipt?.replayHash,quickReceipt?.runId,
        view.page,view.onlyVerified,Math.floor(now()/120000),selection,pendingSelection]);
      if(quickBoard===view.quickBoard&&quickSignature===view.quickSignature)return;
      view.quickBoard=quickBoard;
      view.quickSignature=quickSignature;
    }
    const activeGhosts=[...selectedGhosts.values()].filter(row=>row.periodId===period.id&&row.accountId===accountId);
    if(view.watch)view.watch.disabled=typeof bridge.watchEvent!=='function'||!(getOwnReplay(period.id)||activeGhosts.length);
    const opponentsText=activeGhosts.length?`${activeGhosts.length} event ghost${activeGhosts.length===1?'':'s'} selected`:bridge.supportsEventGhost?.()&&getOwnReplay(period.id)?'Play uses your event PB ghost. Select published racers to add their replays.':'Select published racers to load event ghosts. Normal PB ghosts are not used.';
    if(view.opponentsNote.textContent!==opponentsText)view.opponentsNote.textContent=opponentsText;

    const display=eventDisplayRows(period,{onlyVerified:view.onlyVerified}),{board,filterResult,rows}=display,loading=!board&&!snapshotAttempts.get(period.id)?.error,mine=rows.find(row=>row.accountId===accountId);
    const paging=eventPagination(rows.length,view.page);view.page=paging.page;
    if(filterResult?.active){const visible=new Set(rows.map(row=>row.accountId));for(const [id,row] of selectedGhosts)if(row.periodId===period.id&&!visible.has(id))selectedGhosts.delete(id);}
    let place=displayedRecordPlacement(period,mine,board);
    if(mine?.pending&&place===null)place={rank:mine.rank,fieldSize:null,knownFieldSize:rows.length,provisional:true,policy:'all'};
    if(mine&&(view.onlyVerified||filterResult?.active)&&readEventPlacementSettings().enabled)place={rank:mine.rank,fieldSize:rows.length,knownFieldSize:rows.length,provisional:rows.some(row=>row.pending),policy:view.onlyVerified?'verified':'all',visibleField:true,originalRank:mine.originalRank};
    const placement=eventOwnPlacementPresentation(place);
    const receipt=ownReceipts.get(period.id+'_'+accountId),localRecord=localBest(period);
    const statusDescription=receipt||localRecord?receiptText(receipt,localRecord,period,{board,accountId}):statusText;
    // Selection changes do not alter standings. Avoid revalidating every car
    // style and serializing whole result objects on each input/menu tick.
    const signature=JSON.stringify([bridge.identityRevision?.(),bridge.filterRevision?.(),period.id,board?.updatedAt,board?.saved,board?._publicBackup,board?.complete,loading,Math.floor(now()/120000),view.page,view.onlyVerified,placement,rows.map(row=>[row.accountId,row.rank,row.originalRank,row.timeMs,row.runId,row.pending,row.rp,row.name,row.carStyle,row.submittedAt,row.receivedAt,row.runAt,row.verifiedAt,row.pbAt,row.runCreatedAt,row.createdAt,row.uploadId])]);
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
    const sourceLabel=!board?(loading?'Loading standings':'Standings unavailable'):board._publicBackup?'Snapshot data'+(board.complete===false?' · partial':''):board.saved?'Saved standings':'Published standings';
    view.board.querySelector('h3').title=sourceLabel;
    const total=view.board.querySelector('.total-players');
    total.textContent=(!board?sourceLabel:eventFieldSummary(board,display.counts,view.onlyVerified)+' · '+sourceLabel)+(filterResult?.active?' - personal filters':'')+(board?` · Page ${view.page+1} of ${paging.pageCount}`:'');
    const reportedEntrants=[board?.racerCount,board?.period?.racerCount].find(value=>Number.isSafeInteger(value)&&value>=0);
    total.title=(board?`All-PB field: ${display.counts.all} players, ${display.counts.verifiedInAll} verified, ${display.counts.pending} pending. Verified-only field: ${display.counts.verified} players. `:'')+
      (reportedEntrants!==undefined?'Reported event entrants: '+reportedEntrants+'. ':'')+
      'One best PB per racer in each field. A newer pending PB may replace an older verified PB in All, while verified-only retains the verified PB. Pages contain only loaded results.';
    total.setAttribute('aria-label',total.textContent+'. '+total.title);
     const container=view.board.querySelector('.container');container.setAttribute('aria-busy',String(loading));view.carObserver?.disconnect();view.deferredCarRows.clear();container.replaceChildren();
    for(const [index,row] of rows.slice(view.page*20,view.page*20+20).entries()){
      const renderer=view.board.__pt062EventRows;
      if(renderer?.version!==1){const error=document.createElement('p');error.className='error-message';error.textContent='Reload the game to load the native event leaderboard.';container.append(error);break;}
      const runAt=eventDisplayRunAt(row,now());
      const button=renderer.render(container,nativeEventRow(row,accountId,runAt||now()));button.type='button';button.dataset.eventAccountId=row.accountId;button.dataset.eventTime=String(row.timeMs);button.dataset.eventRunId=row.runId||'';button.dataset.eventPending=String(!!row.pending);const playable=(!row.pending||/^[a-f0-9]{64}$/.test(row.runId||''))&&typeof bridge.readReplay==='function';button.tabIndex=playable?0:-1;button.setAttribute('aria-disabled',String(!playable));if(playable)button.onclick=()=>void selectReplay(period,row);
      const selectedRow=selectedGhosts.get(row.accountId),pendingRow=pendingGhosts.get(row.accountId),matches=target=>target?.periodId===period.id&&target.accountId===accountId&&target.targetTimeMs===row.timeMs&&target.targetRunId===(row.runId||null)&&target.targetPending===!!row.pending,selected=matches(selectedRow),pending=matches(pendingRow);
      button.classList.toggle('selected',!!(selected||pending));button.classList.toggle('pending-selection',!!pending);button.setAttribute('aria-pressed',String(!!(selected||pending)));button.setAttribute('aria-busy',String(!!pending));
      button.title=pending?'Loading and validating event replay...':row.pending?'Watch unverified recording. It earns no points until verified.':'Load this verified event PB replay. Older recordings may be unavailable.';
      button.querySelector('.left p:not(.position)').classList.add('event-time');
      const state=button.querySelector('.verified-state');decorateEventRowPresentation(button,row,now());
      if(!row.pending){const points=document.createElement('span');points.className='sq-event-earned-rp';points.textContent=Math.round(Number(row.groupRp??row.rp)||0)+(row.groupRp!=null?' Group ERP':' ERP');points.title=row.groupRp!=null?'Filtered group Event RP':'Verified Event RP';state.prepend(points);}
      const actions=event=>{if(typeof bridge.racerActions!=='function')return;event.preventDefault();event.stopPropagation();const rect=button.getBoundingClientRect();bridge.racerActions(row,{clientX:event.clientX||rect.left+rect.width/2,clientY:event.clientY||rect.top+rect.height/2});};
      button.oncontextmenu=actions;button.onkeydown=event=>{if(event.key==='ContextMenu'||event.shiftKey&&event.key==='F10')actions(event);};
      const stateIcon=state.querySelector('img');stateIcon.classList.add('sq-event-verification-icon');stateIcon.alt=row.pending?'Unverified recording':'Verified replay';
      bridge.decorateRacer?.(button,row);
      const style=styles[view.page*20+index];
      if(style&&view.carObserver){view.carStyles.set(button,style);view.carObserver.observe(button);}
      else if(style){view.carStyles.set(button,style);if(!renderCachedCar(button,style))view.deferredCarRows.add(button);}
      else renderCachedCar(button,style);
    }
    if(!rows.length){const empty=document.createElement('p');empty.className='error-message';empty.textContent=!board?(loading?'Loading standings…':'Standings are not in the saved data yet.'):view.onlyVerified?'No verified times yet. Turn off Only verified to see waiting runs.':'No event times yet. Play to set your event PB.';if(loading){empty.classList.add('sq-event-loading');empty.setAttribute('role','status');}container.append(empty);}
    const status=document.createElement('p');status.className='sq-event-inline-status';status.setAttribute('role','status');status.textContent=statusDescription;container.append(status);
    bridge.filterNotice?.(view.board,filterResult);
    renderEventPagination(view,rows.length,()=>syncNativeBoard(session));
    view.pb.replaceChildren();
    for(const [icon,text] of [['timer',mine?time(mine.timeMs):'---'],['trophy',placement?.text||(mine?.pending?(mine.unscored?'Not scored':'Waiting'):'---')]]){const line=document.createElement('div'),image=document.createElement('img');image.src='images/'+icon+'.svg';if(icon==='trophy'&&placement){const badge=document.createElement('span');badge.className=placement.className;badge.title=placement.title;badge.setAttribute('aria-label',placement.ariaLabel);badge.textContent=text;line.append(image,badge);}else line.append(image,document.createTextNode(text));view.pb.append(line);}
  }

  function syncFinishPlace(){
    const root=document.querySelector('.time-announcer-ui'),session=sessions.current()||eventIntent;
    if(!root||!latestFinish||!session||latestFinish.periodId!==session.periodId||latestFinish.accountId!==bridge.accountId())return;
    const place=finishPlace(latestFinish);
    root.querySelector('.sq-event-finish-place')?.remove();
    const current=root.querySelector('.current'),position=current?.querySelector('.position');
    if(!position)return;
    const number=place?String(place.rank):'';
    const text=place?number.replace(/\B(?=(\d{3})+(?!\d))/g,'\u202f')+eventOrdinal(place.rank).slice(number.length):'';
    // Keep the native plain-text ordinal and its original ForcedSquare glyphs.
    if(position.textContent!==text||position.firstElementChild)position.textContent=text;
    if(current.classList.contains('show-position')!==!!place)current.classList.toggle('show-position',!!place);
    const detail=place?'Event place '+place.rank+(place.fieldSize===null?'':` of ${place.fieldSize}`)+(place.provisional?' (provisional)':''):'';
    if(position.title!==detail)position.title=detail;
  }
  function tick({cachedOnly=false}={}){
    syncFinishPlace();updateEventRefreshControl();
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
      const signature=JSON.stringify([period?.id,period?.trackId,period?.endsAt,period?.maxRp,period?.scheduleOnly]);if(button.dataset.eventBinding===signature)continue;button.dataset.eventBinding=signature;
      button.dataset.eventKind=kind;button.dataset.eventId=period?.id||'';button.removeAttribute('data-track-id');
      const kicker=kind==='weekly'?'WEEKLY EVENT':'DAILY EVENT';card.setAttribute('aria-label',kicker);button.setAttribute('aria-label',period?'Open '+kicker+': '+info(period.trackId).name:'Browse events: '+kicker+' unavailable');
      const put=(selector,text)=>{const node=button.querySelector(selector);if(node)node.textContent=text;};
      put('.competition-kicker',kicker);put('.competition-track-name',period?info(period.trackId).name:'No active event');put('.competition-result',period?eventRewardLabel(period):'Browse Events for availability');
      const result=button.querySelector('.competition-result');if(result){result.title=period?.scheduleOnly?'Practice follows the saved schedule. The server has not confirmed this event or its scoring. Event RP is not guaranteed.':'';result.setAttribute('aria-label',result.textContent+(result.title?'. '+result.title:''));}
      if(period?.scheduleOnly)button.setAttribute('aria-label','Practice '+kicker+': '+info(period.trackId).name+'. '+eventRewardLabel(period)+'. '+(result?.title||'Event RP is not guaranteed.'));
      const image=button.querySelector('.competition-feature-image');if(image)image.innerHTML=period?bridge.thumbnail(period.trackId):'';
      const note=card.querySelector(':scope > small');if(note){
        if(period){const local=document.createElement('strong');local.textContent=reset(period);note.replaceChildren(document.createTextNode('Resets'),document.createElement('br'),local);note.title='Event ends '+new Intl.DateTimeFormat(undefined,{dateStyle:'full',timeStyle:'long'}).format(period.endsAt);}
        else note.textContent='Browse events for availability.';
      }
      button.removeAttribute('aria-disabled');if(period)knownPeriods.set(period.id,period);
    }
    const group=ensureFeaturedSection(document,featuredSelection?.isConnected?featuredSelection:null);
    const kodubCard=group?.querySelector('.sq-kodub-weekly'),kodubIdentity=kodubCard?.dataset.kodubIdentity;
    if(kodubCard&&kodubIdentity){
      const [trackId,endTime]=kodubIdentity.split('@'),p=activePeriods().find(p=>p.kind==='kodub'&&p.trackId===trackId&&p.endsAt===Date.parse(endTime));
      if(kodubCard.dataset.eventTrack!==trackId)kodubCard.dataset.eventTrack=trackId;if(kodubCard.dataset.eventId!==(p?.id||''))kodubCard.dataset.eventId=p?.id||'';
      const infoNode=kodubCard.querySelector('.track-of-the-week-info');
      if(infoNode){
        let reward=infoNode.querySelector('.sq-kodub-reward');if(!reward){reward=document.createElement('small');reward.className='sq-kodub-reward';infoNode.append(reward);}
        const text=p?eventRewardLabel(p):'Results offline';if(reward.textContent!==text)reward.textContent=text;
        const title=p?.scheduleOnly?'Practice follows the saved schedule. The server has not confirmed this event or its scoring. Event RP is not guaranteed.':p?'Event RP uses scored event results.':'Event results could not be checked. No Event RP reward is confirmed.';
        if(reward.title!==title)reward.title=title;
        const label=text+'. '+title;if(reward.getAttribute('aria-label')!==label)reward.setAttribute('aria-label',label);
        // Leave the native normal PB intact; an event PB is a different record.
      }
    }
    if(!cachedOnly&&group?.getClientRects().length){void loadCatalog().catch(()=>{});void loadPermanent();}
    const permanentNote=group?.querySelector('.sq-permanent-note');
    if(permanentNote){
      const text='Normal RP + up to 1001 Event RP / No reset';
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
          button.innerHTML='<span class="sq-event-thumb" aria-hidden="true"></span><div class="sq-event-record">No record</div><span><small>'+eventName(kind)+' event</small><strong>'+(fetching?'Loading track...':'Events unavailable')+'</strong><span>Results offline</span><small>'+(fetching?'Checking event availability':'Open Events to retry')+'</small></span>';button.onclick=()=>void open();row.append(button);}
      }
    }
    const session=sessions.current()||eventIntent,activeChanged=document.body.classList.contains('sq-event-active')!==!!session;
    if(activeChanged)document.body.classList.toggle('sq-event-active',!!session);
    syncNativeBoard(session||archiveIntent);
    if(activeChanged)bridge.eventLayoutChanged?.();
  }
  document.addEventListener('keydown',event=>{
    if(event.defaultPrevented||event.repeat||event.ctrlKey||event.altKey||event.metaKey||!nativeView?.board?.getClientRects().length||dialog||document.querySelector('.sq-extra-overlay:not([hidden]),.sq-partial-replay-dialog[open]'))return;
    const target=event.target;
    if(['INPUT','TEXTAREA','SELECT'].includes(target?.tagName)||target?.isContentEditable)return;
    if((event.key==='Enter'||event.key===' ')&&target?.closest?.('button,a[href],[role="button"]'))return;
    const board=nativeView.board,rows=[...board.querySelectorAll(':scope > .container > button.main')];
    if(eventDigitBoard!==board){eventDigitBoard=board;eventDigitsHeld.clear();eventDigitsConsumed.clear();eventTopPrefixUntil=0;eventTopHeld=false;}
    const currentPage=nativeView.page+1;
    const navigation=bridge.pageNavigation?.(event,board,currentPage,nativeView.pageCount||1);
    if(navigation){
      ++topSelectionToken;
      event.preventDefault();event.stopImmediatePropagation();
      if(navigation.page)nativeView.changePage?.(navigation.page-1);
      return;
    }
    const code=String(event.code||'').match(/^(?:Digit|Numpad)([0-9])$/);
    const digit=code?Number(code[1])||10:/^[0-9]$/.test(event.key)?Number(event.key)||10:null;
    let action=null;
    if(event.shiftKey&&digit){++topSelectionToken;event.preventDefault();event.stopImmediatePropagation();nativeView.changePage?.(digit-1);return;}
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
      const period=nativeView.period,ranked=eventDisplayRows(period,{onlyVerified:nativeView.onlyVerified}).rows,at=ranked.findIndex(row=>row.accountId===bridge.accountId());
      if(at>0){event.preventDefault();event.stopImmediatePropagation();void selectReplay(period,ranked[at-1]);}return;
    }
    else if(['ArrowLeft','a','A','ArrowRight','d','D'].includes(event.key)){
      ++topSelectionToken;
      event.preventDefault();event.stopImmediatePropagation();
      nativeView.changePage?.(nativeView.page+(['ArrowLeft','a','A'].includes(event.key)?-1:1));return;
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
    if(board===nativeView?.board&&board?.getClientRects().length&&!dialog&&!chord&&!document.querySelector('.sq-partial-replay-dialog[open]')){
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
      // The spotlight is the normal track entry. Explicit Events navigation alone
      // selects event-only standings/ghosts; eligible normal finishes still submit.
      entryRequest++;sessions.leave();eventIntent=null;archiveIntent=null;tick({cachedOnly:true});
      return;
    }
    if(button.matches('#overallLeaderboardPanel .weekly-cup .competition-feature-button,#overallLeaderboardPanel .daily-card .competition-feature-button')){
      e.preventDefault();e.stopImmediatePropagation();const period=activePeriods().find(p=>p.id===button.dataset.eventId&&p.kind===button.dataset.eventKind);if(period)void race(period,{direct:true});else void open();return;
    }
    if(button.matches('.track-info-ui .side-panel button.watch')&&(nativeView||eventIntent||sessions.current())){e.preventDefault();e.stopImmediatePropagation();watchEvent();return;}
    if(button.matches('.track-info-ui .side-panel button.play')&&(nativeView&&!nativeView.archive||eventIntent||sessions.current())&&!nativePlayPermit){e.preventDefault();e.stopImmediatePropagation();void playEvent();return;}
    if(button.closest('.sq-events-overlay,.sq-event-inline,.sq-event-board,.sq-events-entry,.sq-event-track-buttons'))return;
    if(e.isTrusted&&(button.querySelector('.track-title')||/^(Back|Exit|Multiplayer)$/.test(button.textContent.trim()))){
      const request=++entryRequest,accountId=bridge.accountId();
      sessions.leave();eventIntent=null;archiveIntent=null;tick();
      // Capture runs before native navigation; restore only after its handlers finish.
      if(/^(Back|Exit)$/.test(button.textContent.trim()))setTimeout(()=>restoreTrackSelectionAfterBack(request,accountId),0);
    }
  },true);
  const refreshFromCachedState=()=>{if(document.visibilityState==='visible')tick({cachedOnly:true});};
  // Native refresh replaces its wrappers. Restore cached cards before the next paint,
  // rather than waiting for an idle tick or guessing the duration of navigation.
  const nativeMenuObserver=new MutationObserver(records=>{
    const rebuilt=records.some(record=>[...record.addedNodes].some(node=>node.nodeType===1&&
      (node.matches('.community-track-versions')||node.querySelector('.community-track-versions'))));
    if(rebuilt)tick({cachedOnly:true});
  });
  nativeMenuObserver.observe(document.body,{childList:true,subtree:true});
  const refreshAfterNativeReturn=()=>{
    const render=()=>tick({cachedOnly:true});
    if(typeof requestAnimationFrame==='function')requestAnimationFrame(()=>{render();requestAnimationFrame(render);});else setTimeout(render,0);
    setTimeout(render,180);
  };
  let restoredTrackSelectionRequest=-1;
  function restoreTrackSelectionAfterBack(request,accountId){
    if(request!==entryRequest||accountId!==bridge.accountId()||sessions.current()||eventIntent||archiveIntent||restoredTrackSelectionRequest===request)return;
    restoredTrackSelectionRequest=request;
    // The parent owns and consumes its saved return-context token. Never open a track here.
    try{bridge.restoreTrackSelection?.();}finally{refreshAfterNativeReturn();}
  }
  document.addEventListener('visibilitychange',refreshFromCachedState);
  window.addEventListener('pageshow',refreshFromCachedState);
  window.addEventListener('online',()=>void flush());
  window.addEventListener('storage',event=>{if(event.key===QUEUE){hasPending=read(QUEUE,[]).length>0;void flush();}if(event.key===PROFILE_CACHE)profilesAt=0;if(event.key===BEST){bestRecords=read(BEST,{});lastInline='';}});
  window.addEventListener('pt-personal-filters-changed',()=>{
    if(nativeView){nativeView.page=0;nativeView.signature='';nativeView.quickSignature='';syncNativeBoard(sessions.current()||eventIntent||archiveIntent);}
    const list=dialog?.querySelector('.sq-event-results');
    if(selected&&list){const board=cache.get(selected.id)||(!bridge.snapshotOnly?.()?read(STORE+'-'+selected.id,null):null);if(board){const display=eventSnapshotRows(board,{onlyVerified:true,filterRows:bridge.filterRows,context:{trackId:selected.trackId,event:true,maxRp:selected.maxRp,complete:board.complete===true}});list.innerHTML=rows(display.rows)||'<li>No racers match these filters.</li>';message(display.filterResult?.active?'Personal filters are active.':'Published standings.');}}
  });
  function finishPlace(run){
    const board=cache.get(run.periodId)||(!bridge.snapshotOnly?.()?read(STORE+'-'+run.periodId,null):null);
    let place=eventFinishPlace({board,...run});
    const period=knownPeriods.get(run.periodId);
    if(period){const display=eventDisplayRows(period);if(display.filterResult?.active){
      const mine=display.rows.find(row=>row.accountId===run.accountId);
      if(!mine)return null;
      place={rank:1+display.rows.filter(row=>row.accountId!==run.accountId&&row.timeMs<run.timeMs).length,fieldSize:display.rows.length,provisional:board?.complete!==true||display.rows.some(row=>row.pending)};
    }}
    return place;
  }
  function finishPositions(trackId,accountId,timeMs){
    const intent=sessions.current()||eventIntent;
    if(!intent||!latestFinish||latestFinish.periodId!==intent.periodId||latestFinish.trackId!==trackId||latestFinish.accountId!==accountId||timeMs!==undefined&&latestFinish.timeMs!==timeMs)return null;
    const next=finishPlace(latestFinish),prior=latestFinish.previousTimeMs?finishPlace({...latestFinish,timeMs:latestFinish.previousTimeMs}):null;
    if(!next)return null;
    return {newPosition:next.rank,previousPosition:prior?.rank||next.fieldSize||next.rank};
  }
  async function prepareCapture(){
    const catalogPromise=loadCatalog();
    // Practice observers must initialize before the protected native binding.
    await Promise.all([bridge.ready(),catalogPromise]);
    ensureCapture();
    tick({cachedOnly:true});
  }
  return {prepareCapture,captureReady:()=>!!capture,finishPositions,isTrackNavigationCurrent,isEntered:trackId=>sessions.current()?.trackId===trackId,featuredSection:selection=>{if(selection?.matches?.('.track-selection-ui'))featuredSelection=selection;return ensureFeaturedSection(document,selection);},open,openEvent,totals,tick,flush,getOwnReplay,resumeRace,refreshCatalog:loadCatalog,leave(){entryRequest++;sessions.leave();eventIntent=null;archiveIntent=null;tick();}};
}
