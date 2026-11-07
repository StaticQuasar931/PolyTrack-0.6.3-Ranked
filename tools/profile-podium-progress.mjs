const integer=value=>Number.isSafeInteger(value)&&value>=0;
export function profilePodiumProgress(entry,finishes,{isEligible=()=>false,trackName=id=>id}={}){
 const medals=entry?.medals||{},known=['gold','silver','bronze'].every(k=>integer(medals[k]));
 if(!known)return{kind:'unknown',label:'Podiums',detail:'Counts not available in this snapshot'};
 if(medals.gold+medals.silver+medals.bronze>0)return{kind:'earned',label:'Eligible podiums'};
 const candidates=(finishes||[]).filter(f=>Number.isSafeInteger(f.rank)&&f.rank>0&&Number.isSafeInteger(f.fieldSize)&&f.fieldSize>=Math.max(5,f.rank)&&isEligible(f.trackId,f.fieldSize));
 const waiting=candidates.filter(f=>f.rank<=3&&(f.runVerified===false||f.verificationStatus==='pending'||f.localPending===true)).sort((a,b)=>a.rank-b.rank||String(a.trackId).localeCompare(String(b.trackId)))[0];
 if(waiting)return{kind:'pending',label:waiting.localPending?'Podium PB saved locally':'Podium verification',trackId:waiting.trackId,detail:trackName(waiting.trackId)+' · #'+waiting.rank+(waiting.localPending?' · sync pending':' · not verified yet')};
 const target=candidates.filter(f=>f.rank>3).sort((a,b)=>a.rank-b.rank||b.fieldSize-a.fieldSize||String(a.trackId).localeCompare(String(b.trackId)))[0];
 if(target)return{kind:'target',label:'Next podium',trackId:target.trackId,detail:trackName(target.trackId)+' · #'+target.rank+' to top 3'};
 return{kind:'first',label:'Your first podium',detail:'Aim for top 3 on a ranked track with 5+ racers'};
}
