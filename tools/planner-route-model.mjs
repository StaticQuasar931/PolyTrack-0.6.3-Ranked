const positive=value=>typeof value==='number'&&Number.isFinite(value)&&value>0?value:0;
const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
const clamp=(n,lo,hi)=>Math.max(lo,Math.min(hi,n));

export function plannerPracticeEvidence(row,coverage=null){
  const activeMs=row?.activeTimeVersion===2?Math.max(0,positive(row.activeMs)-positive(row.legacyActiveMs)):0;
  const movingMs=Math.min(activeMs,positive(row?.movingMs));
  const motionObservedMs=positive(row?.motionObservedMs);
  const attempts=count(row?.attempts),finishes=count(row?.finishes);
  const coverageFraction=typeof coverage?.coverageFraction==='number'&&Number.isFinite(coverage.coverageFraction)
    ?clamp(coverage.coverageFraction,0,1):null;
  const base={activeMs,movingMs,motionObservedMs,attempts,finishes,coverageFraction,
    source:'device-local observations only',abilityProbability:null,factor:1,calibrated:false,
    note:'No sufficiently supported local practice estimate; absence is not evidence of ability.'};
  if(activeMs<60000||attempts<3||motionObservedMs<30000||movingMs<10000||finishes<1)return base;
  const completionRatio=Math.min(1,finishes/attempts);
  const recent=(Array.isArray(row?.recentFinishes)?row.recentFinishes:[])
    .filter(r=>positive(r?.timeMs)&&r.timingNote!==true).slice(-8);
  let improvementTrend=0;
  if(recent.length>=4){
    const half=Math.floor(recent.length/2),average=rs=>rs.reduce((n,r)=>n+r.timeMs,0)/rs.length;
    const first=average(recent.slice(0,half)),last=average(recent.slice(-half));
    improvementTrend=clamp((first-last)/first,-.1,.1);
  }
  // This is a bounded ordering hint, not a forecast of success or time needed.
  const support=Math.min(1,attempts/12,movingMs/180000);
  const confidence=support*(coverageFraction===null?.5:.5+.5*coverageFraction);
  const adjustment=.28*(.65-completionRatio)-1.4*improvementTrend;
  return {...base,completionRatio,improvementTrend,calibrated:true,
    factor:clamp(1+adjustment*confidence,.75,1.25),
    note:'Bounded local hint from active moving practice and observed finishes; partial device history, not lifetime ability.'};
}

export function plannerEaseEstimate(action,snapshot,accountId,practiceRow=null,coverage=null){
  const practice=plannerPracticeEvidence(practiceRow,coverage);
  const unknown={known:false,effortScore:null,practice,gapMs:null,relativeGap:null,
    reason:'A matching complete placement field is unavailable; no personal ease is invented.'};
  if(!action?.currentRank||!Array.isArray(snapshot?.entries)||snapshot.complete!==true||
    snapshot.totalEntriesExact===false||!Number.isSafeInteger(snapshot.totalEntries)||snapshot.totalEntries!==snapshot.entries.length)return unknown;
  const sourceAt=Math.max(positive(snapshot.serverUpdatedAt),positive(snapshot.updatedAt));
  if(positive(action.cachedAt)>sourceAt)return unknown;
  const rows=snapshot.entries,ids=rows.map(r=>String(r.accountId||r.userId||''));
  if(ids.some(id=>!id)||new Set(ids).size!==ids.length||rows.some(r=>!positive(r.timeMs)))return unknown;
  const own=rows.find(r=>String(r.accountId||r.userId||'')===String(accountId));
  const current=positive(own?.timeMs);
  if(!current||positive(action.timeMs)&&action.timeMs!==current)return unknown;
  if(!Number.isSafeInteger(action.targetRank)||action.targetRank<1)return unknown;
  const target=rows.filter(r=>String(r.accountId||r.userId||'')!==String(accountId))
    .sort((a,b)=>a.timeMs-b.timeMs)[action.targetRank-1];
  const targetTime=positive(target?.timeMs);
  if(!targetTime||targetTime>=current)return unknown;
  const field=rows.map(r=>r.timeMs).sort((a,b)=>a-b);
  const gaps=field.slice(1).map((time,i)=>time-field[i]).sort((a,b)=>a-b),middle=Math.floor(gaps.length/2);
  const spacing=field.length>=3?(gaps.length%2?gaps[middle]:(gaps[middle-1]+gaps[middle])/2):null;
  const relativeGap=(current-targetTime)/current;
  const fieldEffort=relativeGap/Math.max(.005,spacing===null?0:spacing/current);
  return {known:true,gapMs:current-targetTime,relativeGap,targetTime,fieldSpacingMs:spacing,
    fieldEffort,effortScore:fieldEffort*practice.factor,practice,
    reason:'Relative target gap adjusted by a bounded device-local practice hint, not success odds.'};
}

export function plannerBenefitEaseScore(action,maximumBenefit){
  const benefit=positive(action?.value),effort=action?.ease?.effortScore;
  if(!benefit||!positive(maximumBenefit)||!Number.isFinite(effort)||effort<0)return null;
  return Math.pow(Math.min(1,benefit/maximumBenefit),.4)/Math.pow(1+effort,.75);
}

export function orderPlannerRoutes(rival,personal,limit=8,sort='impact'){
  const actions=[...(rival||[]),...(personal||[])].filter(a=>a?.trackId);
  const maximum=Math.max(0,...actions.map(a=>positive(a.value)));
  const effort=a=>Number.isFinite(a?.ease?.effortScore)&&a.ease.effortScore>=0?a.ease.effortScore:null;
  const value=a=>positive(a.value),practice=a=>positive(a.practice?.factor)||1;
  const compare=(a,b)=>{
    if(sort==='training'){
      const played=Number(Boolean(b.currentRank))-Number(Boolean(a.currentRank));if(played)return played;
      const focus=practice(b)-practice(a);if(focus)return focus;
    }
    if(sort==='practice'){const delta=value(b)*practice(b)-value(a)*practice(a);if(delta)return delta;}
    if(['ease','training','benefit-ease'].includes(sort)){
      const left=effort(a),right=effort(b);
      if((left===null)!==(right===null))return left===null?1:-1;
      if(left!==null){
        if(sort==='benefit-ease'){
          const delta=(plannerBenefitEaseScore(b,maximum)??-1)-(plannerBenefitEaseScore(a,maximum)??-1);
          if(delta)return delta;
        }else if(left!==right)return left-right;
      }
    }
    return value(b)-value(a)||(positive(b.weight)-positive(a.weight))||String(a.trackId).localeCompare(String(b.trackId));
  };
  const unique=new Map();for(const action of actions){const previous=unique.get(action.trackId);if(!previous||compare(action,previous)<0)unique.set(action.trackId,action);}
  return [...unique.values()].sort(compare).slice(0,Number.isSafeInteger(limit)&&limit>=0?limit:8);
}
