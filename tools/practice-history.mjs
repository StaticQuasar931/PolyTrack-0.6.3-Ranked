export const PRACTICE_KEY='polytrack-practice-history-v1';
const HASH=/^[a-f0-9]{64}$/;
const MAX_TRACKS=1024,MAX_ACCOUNTS=4;
export const HUNT_IDLE_MS=300000;
const LIMIT=315576000000;
const observedFields=['observedStartedAt','focusedMs','hiddenMs','pausedMs','progressingMs','movingMs','motionObservedMs','stationaryMs','idleMs','unobservedGapMs','longestHuntMs','biggestObservedImprovementMs','biggestPbImprovementMs','trackedBestMs','lastObservedFinishMs','lastObservedFinishAt'];
const bounded=n=>Number.isFinite(n)&&n>=0?Math.min(LIMIT,n):0;
const timestamp=(value,at)=>Number.isFinite(value)&&value>=0&&value!==LIMIT&&value<=at?value:0;
function cleanHunt(value,at){return value&&Number.isFinite(value.startedAt)&&value.startedAt>=0&&value.startedAt<=at&&Number.isFinite(value.lastMovingAt)&&value.lastMovingAt>=value.startedAt&&value.lastMovingAt<=at?{startedAt:value.startedAt,lastMovingAt:value.lastMovingAt,movingMs:bounded(value.movingMs)}:null;}
function cleanPlacement(value,at){return value&&Number.isSafeInteger(value.rank)&&value.rank>0&&Number.isSafeInteger(value.total)&&value.total>=value.rank&&value.exact===true&&value.complete===true&&value.authoritative===true&&Number.isFinite(value.timeMs)&&value.timeMs>0&&Number.isFinite(value.finishedAt)&&value.finishedAt>=0&&Number.isFinite(value.at)&&value.at>=value.finishedAt&&value.at<=at?{rank:value.rank,total:value.total,at:value.at,timeMs:value.timeMs,finishedAt:value.finishedAt,exact:true,complete:true,authoritative:true}:null;}
export function createPracticeHistory({storage,now=Date.now,onChange=()=>{}}={}){
 let data={version:1,accounts:{},coverage:{}},dirty=false,revision=0,lastSave=0;
 const listeners=new Set();
 try{
  const value=JSON.parse(storage?.getItem(PRACTICE_KEY)||'null');
  if(value?.version===1&&value.accounts&&typeof value.accounts==='object'){
   for(const [account,tracks] of Object.entries(value.accounts).filter(([id])=>HASH.test(id)).slice(0,MAX_ACCOUNTS)){
    if(!tracks||typeof tracks!=='object'||Array.isArray(tracks))continue;
    data.accounts[account]={};
    for(const [id,row] of Object.entries(tracks).filter(([id,row])=>HASH.test(id)&&row&&typeof row==='object').slice(0,MAX_TRACKS)){
     const clean={};for(const field of ['activeMs','simulatedMs','trackingStartedAt','legacyActiveMs','improvedMs','sincePbMs','attempts','finishes','pbs','restarts','restartsSincePb','respawns','lastPlayedAt','lastPbAt','bestMs','furthestCheckpoint'])clean[field]=field.endsWith('At')?timestamp(row[field],now()):bounded(row[field]);
     // Earlier active totals used different sampling rules; preserve, never reconstruct them.
     clean.activeTimeVersion=2;
     clean.legacyActiveMs=row.activeTimeVersion===2?Math.min(clean.activeMs,clean.legacyActiveMs):clean.activeMs;
     // Old loaders capped epoch dates at the duration limit. Their true dates are lost.
     clean.recentFinishes=Array.isArray(row.recentFinishes)?row.recentFinishes.slice(-8).filter(r=>r&&Number.isFinite(r.timeMs)&&r.timeMs>0&&r.timeMs<=LIMIT).map(r=>({at:r.at===LIMIT?0:timestamp(r.at,now()),timeMs:r.timeMs,practiceMs:bounded(r.practiceMs),timingNote:r.timingNote===true})):[];
     clean.observationVersion=row.observationVersion===1?1:0;
     for(const field of observedFields)clean[field]=field.endsWith('At')?timestamp(row[field],now()):bounded(row[field]);
     clean.hunt=cleanHunt(row.hunt,now());
     clean.firstPlacement=cleanPlacement(row.firstPlacement,now());
     clean.restartBuckets=Array.from({length:4},(_,index)=>Math.min(1e9,Math.max(0,Number(row.restartBuckets?.[index])||0)));
     data.accounts[account][id]=clean;
    }
   }
   for(const [id,row] of Object.entries(value.coverage||{}).filter(([id,row])=>HASH.test(id)&&row&&typeof row==='object').slice(0,MAX_ACCOUNTS)){
    data.coverage[id]={};for(const key of ['startedAt','baselinePlaytimeMs','knownPlaytimeMs','observedVisibleMs'])data.coverage[id][key]=key==='startedAt'?timestamp(row[key],now()):bounded(row[key]);
   }
   dirty=JSON.stringify(data)!==JSON.stringify(value);
  }
 }catch{}
 const safe=n=>Number.isFinite(n)&&n>=0?n:0;
 function entry(accountId,trackId){
  if(!HASH.test(accountId)||!HASH.test(trackId))return null;
  const accounts=data.accounts;
  if(!Object.hasOwn(accounts,accountId))accounts[accountId]={};
  while(Object.keys(accounts).length>MAX_ACCOUNTS)delete accounts[Object.keys(accounts).find(id=>id!==accountId)];
  const tracks=accounts[accountId];
  if(!Object.hasOwn(tracks,trackId))tracks[trackId]={activeTimeVersion:2,activeMs:0,simulatedMs:0,trackingStartedAt:0,legacyActiveMs:0,improvedMs:0,recentFinishes:[],sincePbMs:0,attempts:0,finishes:0,pbs:0,restarts:0,restartsSincePb:0,respawns:0,lastPlayedAt:0,lastPbAt:0,bestMs:0,restartBuckets:[0,0,0,0],furthestCheckpoint:0};
  while(Object.keys(tracks).length>MAX_TRACKS){const oldest=Object.keys(tracks).filter(id=>id!==trackId).sort((a,b)=>safe(tracks[a].lastPlayedAt)-safe(tracks[b].lastPlayedAt))[0];delete tracks[oldest];}
  const row=tracks[trackId];
  for(const field of observedFields)if(!Number.isFinite(row[field]))row[field]=0;
  row.observationVersion=row.observationVersion===1?1:0;
  row.hunt??=null;row.firstPlacement??=null;
  return row;
 }
 function changed(){dirty=true;revision++;try{onChange(revision);}catch{}for(const listener of listeners)try{listener(revision);}catch{}}
 function flush(force=false){if(!dirty||!force&&now()-lastSave<30000)return false;lastSave=now();try{storage?.setItem(PRACTICE_KEY,JSON.stringify(data));dirty=false;return true;}catch{return false;}}
 function begin(accountId,trackId,baselineMs=0){
  const row=entry(accountId,trackId);if(!row)return null;
  
  if(Number.isFinite(baselineMs)&&baselineMs>0)observeBest(accountId,trackId,baselineMs);
  // Track selection breaks continuity even if the new track is never driven.
  for(const [id,other] of Object.entries(data.accounts[accountId]))if(id!==trackId&&other.hunt){other.hunt=null;changed();}
  if(row.hunt&&(now()-row.hunt.lastMovingAt>HUNT_IDLE_MS||now()<row.hunt.lastMovingAt)){row.hunt=null;changed();}
  let ended=false,elapsed=0,started=false;
  const isCurrent=()=>data.accounts[accountId]?.[trackId]===row;
  function observe(wallMs,evidence={}){
   if(ended||!isCurrent())return;
   const wall=bounded(wallMs);if(!wall)return;
   row.observationVersion=1;if(!row.observedStartedAt)row.observedStartedAt=now();
   if(row.hunt&&(now()-row.hunt.lastMovingAt>HUNT_IDLE_MS||now()<row.hunt.lastMovingAt))row.hunt=null;
   if(evidence.gap===true||wall>2500){row.unobservedGapMs=bounded(row.unobservedGapMs+wall);changed();return;}
   const delta=Math.min(2500,wall),focused=evidence.visible===true&&evidence.paused!==true;
   const field=evidence.visible!==true?'hiddenMs':evidence.paused===true?'pausedMs':'focusedMs';
   row[field]=bounded(row[field]+delta);
   if(focused){
    const progressing=evidence.progressing===true;
    const progress=progressing?Math.min(delta,Number.isFinite(evidence.progressingMs)?bounded(evidence.progressingMs):delta):0;
    row.progressingMs=bounded(row.progressingMs+progress);
    row.idleMs=bounded(row.idleMs+delta-progress);
    if(typeof evidence.moving==='boolean')row.motionObservedMs=bounded(row.motionObservedMs+delta);
    if(progressing&&evidence.moving===false)row.stationaryMs=bounded(row.stationaryMs+progress);
    if(progress>0&&evidence.moving===true){
     row.movingMs=bounded(row.movingMs+progress);
     if(!row.hunt)row.hunt={startedAt:now(),lastMovingAt:now(),movingMs:0};
     row.hunt.lastMovingAt=now();row.hunt.movingMs=bounded(row.hunt.movingMs+progress);
     row.longestHuntMs=Math.max(row.longestHuntMs,row.hunt.movingMs);
    }
   }
   changed();flush();
  }
  function start(){if(started)return;started=true;if(!row.trackingStartedAt)row.trackingStartedAt=now();row.attempts=safe(row.attempts)+1;row.lastPlayedAt=now();changed();}
  return {
   observe,isCurrent,
   tick(deltaMs,checkpoint=0,wallDeltaMs=deltaMs,correction={}){
    if(ended||!isCurrent())return;
    const current=Math.min(2500,safe(wallDeltaMs));
    // Only the observer's bounded prior idle spans may be reclassified as catch-up.
    const recovered=Math.min(2500,safe(correction.catchUpMs),safe(row.idleMs));
    const delta=current+recovered;if(!delta)return;start();
    row.activeMs=bounded(safe(row.activeMs)+delta);row.simulatedMs=bounded(safe(row.simulatedMs)+Math.min(2500+recovered,safe(deltaMs)));
    row.sincePbMs=bounded(safe(row.sincePbMs)+delta);row.lastPlayedAt=now();
    row.furthestCheckpoint=Math.max(safe(row.furthestCheckpoint),Math.min(10000,safe(checkpoint)));elapsed+=delta;
    row.idleMs-=recovered;row.progressingMs=bounded(row.progressingMs+recovered);
    const moving=Math.min(recovered,safe(correction.catchUpMovingMs));
    const stationary=Math.min(recovered-moving,safe(correction.catchUpStationaryMs));
    row.movingMs=bounded(row.movingMs+moving);row.stationaryMs=bounded(row.stationaryMs+stationary);
    if(moving>0){if(!row.hunt)row.hunt={startedAt:now(),lastMovingAt:now(),movingMs:0};row.hunt.lastMovingAt=now();row.hunt.movingMs=bounded(row.hunt.movingMs+moving);row.longestHuntMs=Math.max(row.longestHuntMs,row.hunt.movingMs);}
    changed();flush();
   },
   respawn(atMs){if(ended||!isCurrent()||atMs<=0)return;row.respawns=safe(row.respawns)+1;changed();},
   finish(timeMs,evidence={}){if(ended||!isCurrent()||!Number.isFinite(timeMs)||timeMs<=0||timeMs>LIMIT)return;start();ended=true;row.finishes=safe(row.finishes)+1;row.lastPlayedAt=now();
    row.observationVersion=1;if(!row.observedStartedAt)row.observedStartedAt=now();
    row.trackedBestMs=row.trackedBestMs?Math.min(row.trackedBestMs,timeMs):timeMs;
    row.lastObservedFinishMs=timeMs;row.lastObservedFinishAt=now();
    const timingNote=evidence.reliable===true&&elapsed>=60000&&elapsed>timeMs*3;
    row.recentFinishes=Array.isArray(row.recentFinishes)?row.recentFinishes:[];row.recentFinishes.push({at:now(),timeMs,practiceMs:Math.round(elapsed),timingNote});row.recentFinishes=row.recentFinishes.slice(-8);
    if(!row.bestMs||timeMs<row.bestMs){if(row.bestMs>timeMs){const gain=row.bestMs-timeMs;row.improvedMs=safe(row.improvedMs)+gain;row.biggestObservedImprovementMs=Math.max(row.biggestObservedImprovementMs,gain);row.biggestPbImprovementMs=Math.max(row.biggestPbImprovementMs,gain);}row.bestMs=timeMs;row.pbs=safe(row.pbs)+1;row.lastPbAt=now();row.sincePbMs=0;row.restartsSincePb=0;}changed();flush(true);return {timeMs,finishedAt:row.lastObservedFinishAt};},
   restart(atMs){if(ended||!isCurrent())return;ended=true;if(atMs>0||elapsed>0){start();row.restarts=safe(row.restarts)+1;row.restartsSincePb=safe(row.restartsSincePb)+1;const index=atMs<5000?0:atMs<15000?1:atMs<30000?2:3;row.restartBuckets=Array.isArray(row.restartBuckets)&&row.restartBuckets.length===4?row.restartBuckets:[0,0,0,0];row.restartBuckets[index]++;changed();}},
   leave(){ended=true;flush(true);}
  };
 }
 function observeCoverage(accountId,totalPlaytimeMs,visibleMs=0){
  if(!HASH.test(accountId))return;
  const total=bounded(totalPlaytimeMs);let row=data.coverage[accountId];
  if(!row)row=data.coverage[accountId]={startedAt:now(),baselinePlaytimeMs:Math.max(0,total-Math.min(120000,safe(visibleMs))),knownPlaytimeMs:total,observedVisibleMs:0};
  row.observedVisibleMs=bounded(row.observedVisibleMs+Math.min(120000,safe(visibleMs)));row.knownPlaytimeMs=bounded(Math.max(row.knownPlaytimeMs,total,row.baselinePlaytimeMs+row.observedVisibleMs));
  while(Object.keys(data.coverage).length>MAX_ACCOUNTS)delete data.coverage[Object.keys(data.coverage).find(id=>id!==accountId)];changed();
 }
 // Explicit callbacks only: never derive rank from a partial leaderboard page.
 function observePlacement(accountId,trackId,evidence={}){
  const placement=cleanPlacement(evidence,now());
  if(!placement)return false;const row=data.accounts[accountId]?.[trackId];
  if(!row||row.firstPlacement||!row.trackedBestMs||placement.timeMs!==row.lastObservedFinishMs||placement.finishedAt!==row.lastObservedFinishAt)return false;
  row.firstPlacement=placement;changed();flush(true);return true;
 }
 function observeBest(accountId,trackId,timeMs){
  if(!Number.isFinite(timeMs)||timeMs<=0||timeMs>LIMIT)return false;
  const row=entry(accountId,trackId);if(!row||row.bestMs&&timeMs>=row.bestMs)return false;
  if(row.bestMs)row.biggestObservedImprovementMs=Math.max(row.biggestObservedImprovementMs,row.bestMs-timeMs);
  row.bestMs=timeMs;changed();return true;
 }
 function list(accountId){return Object.entries(data.accounts[accountId]||{}).filter(([,r])=>r.attempts>0||r.finishes>0||r.activeMs>0).map(([trackId,row])=>({trackId,...JSON.parse(JSON.stringify(row))}));}
 function coverage(accountId){const row=data.coverage[accountId];return row?{...row,version:2,coverageFraction:row.knownPlaytimeMs>0?Math.min(1,row.observedVisibleMs/row.knownPlaytimeMs):0}:null;}
 return {begin,flush,list,coverage,observeCoverage,observePlacement,observeBest,subscribe(listener){if(typeof listener!=='function')return ()=>{};listeners.add(listener);return ()=>listeners.delete(listener);},get revision(){return revision;},get(accountId,trackId){const row=data.accounts?.[accountId]?.[trackId];return row?JSON.parse(JSON.stringify(row)):null;},clear(accountId){if(Object.hasOwn(data.accounts,accountId)||Object.hasOwn(data.coverage,accountId)){delete data.accounts[accountId];delete data.coverage[accountId];changed();flush(true);}}};
}
export function practiceAdvice(row,at=Date.now(),{otherTracks=[]}={}){
 if(!row||row.attempts<3||row.activeMs<60000)return {factor:1,text:''};
 const dated=Number.isFinite(row.lastPlayedAt)&&row.lastPlayedAt>0&&row.lastPlayedAt<=at;
 const age=dated?at-row.lastPlayedAt:0,days=Math.floor(age/86400000);
 const improvedElsewhere=otherTracks.filter(other=>other.trackId!==row.trackId&&other.improvedMs>0&&other.lastPbAt>row.lastPlayedAt).length;
 if(days>=3&&improvedElsewhere>=3)return {factor:1.1,text:`${improvedElsewhere} other tracks improved since your last visit; worth revisiting`};
 if(days>=7)return {factor:1.1,text:`Last practised ${days} days ago`};
 const recent=(row.recentFinishes||[]).filter(run=>run.timeMs>0&&run.at>0&&run.at<=at&&run.at>at-7*86400000).slice(-8);
 if(recent.length===8){const average=rows=>rows.reduce((sum,run)=>sum+run.timeMs,0)/rows.length;const first=average(recent.slice(0,4)),last=average(recent.slice(4));if(last<first*.99)return {factor:1.08,text:'Recent finishes are improving (8 local finishes)'};}
 if(row.sincePbMs>=900000&&row.restartsSincePb>=10)return {factor:.9,text:'15+ minutes since a PB; consider a different route'};
 if(row.pbs>=2&&row.activeMs>=180000)return {factor:1.05,text:`${row.pbs} PBs in ${Math.round(row.activeMs/60000)} minutes of practice`};
 return {factor:1,text:`${Math.round(row.activeMs/60000)} min practice · ${row.finishes} finishes · ${row.restarts} restarts`};
}
