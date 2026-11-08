const HASH=/^[a-f0-9]{64}$/,PERIOD=/^[A-Za-z0-9_-]{1,64}$/,MAX_ROWS=10000,MAX_TIME=300000;
const FLAGS=['needsReview','reviewHold','excluded','unscored'];
const STATES=['status','verificationStatus','validationState','verifiedState'];
const PROOFS=['verified','runVerified','physicsVerified','replayIntegrityVerified','integrityVerified','eventRpEligible'];
const restricted=row=>FLAGS.some(key=>row?.[key]===true)||[...STATES,'reason'].some(key=>
  typeof row?.[key]==='string'&&/held|hold|review|excluded|rejected|mismatch|unavailable_final|expired/i.test(row[key]));
const time=value=>Number.isSafeInteger(value)&&value>0&&value<=MAX_TIME;
const score=value=>typeof value==='number'?value:typeof value==='string'&&/^\d+$/.test(value)?Number(value):null;
const model=(status,extra={})=>Object.freeze({status,text:{awarded:'',none:'No event result',pending:'ERP pending',held:'ERP held',unavailable:'ERP unavailable'}[status],
  verified:status==='awarded',score:null,relation:null,separate:false,eventTimeMs:null,eventPbText:null,pairedText:null,
  hasPending:false,pendingTimeMs:null,title:'No valid published event award is available. Normal PB verification does not establish Event RP.',...extra});

// Presentation only. The caller supplies an already trusted published snapshot;
// this helper does not validate physics, create proof, or calculate event points.
export function publishedEventAwardPresentation(row){
  if(!row||typeof row!=='object')return model('unavailable');
  if(restricted(row))return model('held',{title:'This event result is held or excluded. No ERP is attributed to this result.'});
  if(row.pending===true&&row.verified===false&&row.eventRpEligible===false&&row.verificationStatus==='waiting')
    return model('pending',{title:'This Event PB is waiting for verification. It has no awarded ERP yet.'});
  const positive=PROOFS.some(key=>row[key]===true)||row.verifiedState===1||row.verificationStatus==='verified'||row.status==='verified';
  const contradicted=row.pending===true||PROOFS.some(key=>row[key]===false)||row.verifiedState===0||
    STATES.some(key=>row[key]!==undefined&&!(key==='verifiedState'&&row[key]===1)&&row[key]!=='verified');
  const value=score(row.rp);
  if(!positive||contradicted||!Number.isSafeInteger(value)||value<0)return model('unavailable');
  return model('awarded',{score:value,text:value+' ERP',title:'Published Event RP for this verified Event PB. This is not lifetime or filtered group ERP.'});
}

function validPeriod(period){
  return PERIOD.test(period?.id||'')&&HASH.test(period?.trackId||'')&&Number.isSafeInteger(period.startsAt)&&
    period.startsAt>0&&Number.isSafeInteger(period.endsAt)&&period.endsAt>period.startsAt;
}
function rowMatchesPeriod(row,period){
  return HASH.test(row?.accountId||'')&&time(row.timeMs)&&
    (row.trackId===undefined||row.trackId===period.trackId)&&(row.periodId===undefined||row.periodId===period.id)&&
    (row.submittedAt===undefined||Number.isSafeInteger(row.submittedAt)&&row.submittedAt>=period.startsAt&&row.submittedAt<period.endsAt);
}
function waitingPlayback(row,period){
  return rowMatchesPeriod(row,period)&&HASH.test(row.runId||'')&&HASH.test(row.replayHash||'')&&
    Number.isSafeInteger(row.submittedAt)&&row.source==='pending-event-playback'&&
    publishedEventAwardPresentation(row).status==='pending';
}
function pair(award,row,normalRow,formatTime,pendingRows=[]){
  const normalTime=normalRow.timeMs??normalRow.frames??normalRow.raceTimeFrames;
  const exact=normalTime===row.timeMs&&HASH.test(normalRow.replayHash||'')&&row.replayHash===normalRow.replayHash;
  let formatted=null;
  if(!exact&&typeof formatTime==='function'){
    try{const value=formatTime(row.timeMs);if(typeof value==='string'&&value.trim())formatted=value;}catch{}
  }
  const eventPbText=exact?null:formatted?'Event PB '+formatted:'Separate Event PB';
  const title=award.status==='awarded'?(exact?'Published Event RP matches this PB by account, track, event, time and replay hash.':
    'Published Event RP belongs to the separate Event PB'+(formatted?' '+formatted:'')+', not to the ordinary leaderboard run.'):
    award.title+(exact?'':' This is a separate Event PB'+(formatted?' '+formatted:'')+', not the ordinary leaderboard time.');
  return model(award.status,{...award,relation:exact?'exact':'separate',separate:!exact,eventTimeMs:row.timeMs,eventPbText,
    pairedText:eventPbText?'Event PB \u00b7 '+award.text:award.text,
    hasPending:pendingRows.length>0,pendingTimeMs:pendingRows.length?Math.min(...pendingRows.map(value=>value.timeMs)):null,
    title:title+(award.status==='awarded'&&pendingRows.length?' A waiting event run does not replace this published award.':'')});
}

export function eventAwardPresentation({board,period=board?.period,normalRow,trackId=period?.trackId,formatTime}={}){
  const accountId=normalRow?.accountId||normalRow?.userId,normalTime=normalRow?.timeMs??normalRow?.frames??normalRow?.raceTimeFrames;
  if(!validPeriod(period)||trackId!==period.trackId||!HASH.test(accountId||'')||!Number.isSafeInteger(normalTime)||normalTime<=0||
    normalRow.accountId!==undefined&&normalRow.userId!==undefined&&normalRow.accountId!==normalRow.userId||
    normalRow.trackId!==undefined&&normalRow.trackId!==trackId||normalRow.periodId!==undefined&&normalRow.periodId!==period.id||
    !board||!validPeriod(board.period)||['id','trackId','startsAt','endsAt','kind'].some(key=>board.period[key]!==period[key])||
    board.id!==undefined&&board.id!==period.id||!Array.isArray(board.entries)||board.entries.length>MAX_ROWS||
    board.pendingPlaybacks!==undefined&&(!Array.isArray(board.pendingPlaybacks)||board.pendingPlaybacks.length>MAX_ROWS))return model('unavailable');
  const seen=new Set();
  for(const row of board.entries){
    if(!rowMatchesPeriod(row,period)||seen.has(row.accountId))return model('unavailable');
    seen.add(row.accountId);
  }
  const pendingRows=(board.pendingPlaybacks||[]).filter(row=>row?.accountId===accountId);
  if(pendingRows.some(row=>!rowMatchesPeriod(row,period)))return model('unavailable');
  const waiting=pendingRows.filter(row=>waitingPlayback(row,period));
  const published=board.entries.find(row=>row.accountId===accountId);
  if(published)return pair(publishedEventAwardPresentation(published),published,normalRow,formatTime,waiting);
  const blocked=pendingRows.find(restricted);
  if(blocked)return pair(publishedEventAwardPresentation(blocked),blocked,normalRow,formatTime);
  if(waiting.length){const best=waiting.reduce((a,b)=>b.timeMs<a.timeMs?b:a);return pair(publishedEventAwardPresentation(best),best,normalRow,formatTime,waiting);}
  if(pendingRows.length)return model('unavailable');
  const complete=(board.complete===true||board.sourceComplete===true)&&board.complete!==false&&board.sourceComplete!==false&&
    Number.isSafeInteger(board.totalEntries)&&board.totalEntries===board.entries.length;
  return complete?model('none',{title:'This complete published event snapshot has no award or waiting Event PB for this account. A verified normal PB alone does not earn ERP.'}):model('unavailable');
}
