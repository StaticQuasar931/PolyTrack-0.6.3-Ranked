// Pure saved-data planner. This module never reads storage or starts requests.
export function savedEventPlannerRoutes(catalog, boards, permanent, best, accountId, rivalId, at) {
  const integer=(n,min,max)=>Number.isSafeInteger(n)&&n>=min&&n<=max;
  const time=n=>integer(n,1,300000);
  const rolling='fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
  const routes=[],missing=[];let dataAvailable=false;
  if(typeof accountId!=='string'||!accountId||!Number.isSafeInteger(at)||at<0)
    return Object.assign(routes,{dataAvailable,missing,benefitReference:0});
  const seen=new Set();
  const candidates=(Array.isArray(catalog?.periods)?catalog.periods:[]).slice(0,120)
    .filter(p=>p&&['daily','weekly','kodub'].includes(p.kind)&&p.enabled!==false&&p.archived!==true&&
      integer(p.startsAt,0,Number.MAX_SAFE_INTEGER)&&integer(p.endsAt,1,Number.MAX_SAFE_INTEGER)&&p.startsAt<=at&&at<p.endsAt);
  if(permanent)candidates.push({...permanent,id:'permanent-rolling-hills',kind:'permanent'});
  for(const candidate of candidates){
    const isPermanent=candidate.kind==='permanent',id=candidate.id;
    if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,64}$/.test(id)||seen.has(id))continue;
    seen.add(id);
    const board=isPermanent?permanent:boards?.[id],p=board?.period;
    const reject=()=>missing.push(id);
    if(!board||board.archived===true||!Array.isArray(board.entries)||board.entries.length>10000||
      !integer(board.updatedAt,0,Number.MAX_SAFE_INTEGER)||board.complete===true&&
      board.totalEntries!==undefined&&board.totalEntries!==board.entries.length){reject();continue;}
    if(isPermanent){
      if(board.id!==id||board.kind!=='permanent'||board.trackId!==rolling||board.maxRp!==1001||board.complete!==true||
        board.scoreVersion!=='rolling-hills-live-verified-v1'||!time(board.targetMs)||
        !integer(board.sourceRevision,1,Number.MAX_SAFE_INTEGER)||!board.entries.length||
        Math.min(...board.entries.map(r=>r?.timeMs))!==board.targetMs){reject();continue;}
    }else if(!p||['id','kind','trackId','startsAt','endsAt','maxRp'].some(k=>p[k]!==candidate[k])||
      p.scheduleOnly===true||p.enabled===false||p.archived===true||board.id!==undefined&&board.id!==id||
      candidate.targetMs!=null&&candidate.targetMs!==p.targetMs||
      candidate.scoringVersion!=null&&candidate.scoringVersion!==p.scoringVersion){reject();continue;}
    const period=isPermanent?{...board,entries:undefined}:p;
    const cap=period.maxRp;
    if(!/^[a-f0-9]{64}$/.test(period.trackId||'')||!integer(cap,1,isPermanent?1001:1000)){reject();continue;}
    const rows=board.entries,ids=rows.map(r=>r?.accountId);
    if(ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length||
      rows.some(r=>!time(r.timeMs)||r.pending===true||r.verified===false||r.eventRpEligible===false||r.verificationStatus==='waiting'||
        r.rp!==undefined&&!integer(r.rp,0,cap))){reject();continue;}
    const own=rows.find(r=>r.accountId===accountId),rival=rows.find(r=>r.accountId===rivalId);
    const complete=board.complete!==false&&(board.complete===true||board.totalEntries===rows.length);
    if(!own&&!complete){reject();continue;}
    // Do not infer a withheld target or an unknown scoring version.
    const version=isPermanent?'time-ratio-v1':period.scoringVersion;
    const calculable=time(period.targetMs)&&['time-ratio-v1','time-gap-v2'].includes(version);
    const score=t=>version==='time-gap-v2'
      ?Math.max(1,Math.min(cap,Math.round(cap/(1+Math.exp(8*(t/period.targetMs-1)-Math.log(4))))))
      :Math.min(cap,Number(BigInt(cap)*BigInt(period.targetMs)/BigInt(t)));
    if(calculable&&rows.some(r=>r.rp!==undefined&&r.rp!==score(r.timeMs))){reject();continue;}
    const currentRp=own?(integer(own.rp,0,cap)?own.rp:calculable?score(own.timeMs):null):0;
    if(currentRp===null){reject();continue;}
    let targetTime=null,targetRp=null,minimumTime=null;
    if(calculable){
      // Search integer milliseconds, including rounding boundaries, in at most 19 steps.
      const fastestThreshold=points=>{
        if(score(1)<points)return null;
        let lo=1,hi=300000;
        while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(score(mid)>=points)lo=mid;else hi=mid-1;}
        return lo;
      };
      targetTime=period.targetMs;targetRp=score(targetTime);
      if(targetRp<=currentRp){targetTime=fastestThreshold(cap);targetRp=targetTime===null?null:score(targetTime);}
      minimumTime=fastestThreshold(currentRp+1);
    }else{
      const observed=rows.filter(r=>integer(r.rp,0,cap)&&r.rp>currentRp&&(!own||r.timeMs<own.timeMs))
        .sort((a,b)=>b.rp-a.rp||b.timeMs-a.timeMs)[0];
      if(observed){targetTime=observed.timeMs;targetRp=observed.rp;}
    }
    if(currentRp>=cap){dataAvailable=true;continue;}
    if(targetTime===null||targetRp===null||targetRp<=currentRp){reject();continue;}
    dataAvailable=true;
    const local=best?.[id+'_'+accountId];
    routes.push({period,trackId:period.trackId,currentTime:own?.timeMs||null,currentRp,targetTime,targetRp,
      minimumTime,gain:targetRp-currentRp,localTime:time(local?.timeMs)?local.timeMs:null,
      rivalRp:rival?(integer(rival.rp,0,cap)?rival.rp:calculable?score(rival.timeMs):null):null,
      savedAt:board.updatedAt,observedTarget:!calculable});
  }
  const benefitReference=Math.max(0,...routes.map(r=>r.gain));
  return Object.assign(routes.map(r=>({...r,benefitReference})).sort((a,b)=>b.gain-a.gain||
    (a.period.endsAt||Number.MAX_SAFE_INTEGER)-(b.period.endsAt||Number.MAX_SAFE_INTEGER)||a.period.id.localeCompare(b.period.id)),
  {dataAvailable,missing,benefitReference});
}
