const MEASUREMENT_ID='G-QXB7CHLEDT';
const installations=new WeakMap();
const fields={
  fs_reads_est:['firestore','knownReadEstimate'],fs_writes_est:['firestore','knownWriteEstimate'],
  fs_unknown_reads:['firestore','unknownReadOperations'],fs_unknown_writes:['firestore','unknownWriteOperations'],
  worker_ops:['worker','operations'],snapshot_ops:['snapshot','operations'],cache_ops:['cache','operations']
};
const bounded=value=>Number.isSafeInteger(value)&&value>=0?Math.min(value,1e9):null;
function sample(readUsage){
  try {
    const usage=readUsage();
    if(usage?.version!==1||!Number.isSafeInteger(usage.startedAt)||usage.startedAt<0)return null;
    const counts={};
    for(const [name,[source,key]] of Object.entries(fields)){
      const value=bounded(usage.buckets?.[source]?.[key]);
      if(value===null)return null;
      counts[name]=value;
    }
    return {startedAt:usage.startedAt,counts};
  }catch{return null;}
}

// Best-effort deltas from the existing local observer, never a billing meter.
// No document identities, data, URLs or persistent identifiers are accepted.
export function installUsageAnalytics({document=globalThis.document,window=globalThis.window,revision,
  readUsage,now=Date.now,setInterval:schedule=globalThis.setInterval,clearInterval:unschedule=globalThis.clearInterval}={}){
  if(!document||!window||typeof readUsage!=='function'||!Number.isSafeInteger(revision)||revision<0||
    window.__polytrackAnalyticsAllowed!==true||!['github','google_embed'].includes(window.__polytrackAnalyticsDeployment))return ()=>{};
  if(installations.has(document))return installations.get(document);
  const installedAt=now();
  let baseline=sample(readUsage),lastAt=installedAt,lastSent=-Infinity,sent=0,disposed=false;
  const flush=()=>{
    if(disposed||sent>=128||typeof window.gtag!=='function')return false;
    const at=now();if(!Number.isFinite(at)||at<lastAt||at-lastSent<60000)return false;
    const current=sample(readUsage);if(!current)return false;
    if(!baseline){
      if(current.startedAt<installedAt){baseline=current;lastAt=at;return false;}
      baseline={startedAt:current.startedAt,counts:Object.fromEntries(Object.keys(fields).map(name=>[name,0]))};
    }
    if(baseline.startedAt!==current.startedAt){baseline=current;lastAt=at;return false;}
    const delta={};
    for(const name of Object.keys(fields)){
      if(current.counts[name]<baseline.counts[name]){baseline=current;lastAt=at;return false;}
      delta[name]=current.counts[name]-baseline.counts[name];
    }
    if(!Object.values(delta).some(value=>value>0))return false;
    try {
      window.gtag('event','polytrack_client_usage',{send_to:MEASUREMENT_ID,event_schema:1,usage_scope:'client_observed',
        client_revision:revision,deployment_group:window.__polytrackAnalyticsDeployment,
        interval_seconds:Math.min(86400,Math.max(0,Math.round((at-lastAt)/1000))),...delta});
    }catch{return false;}
    baseline=current;lastAt=at;lastSent=at;sent++;return true;
  };
  const hidden=()=>{if(document.visibilityState==='hidden')flush();};
  const timer=schedule(flush,15*60*1000);
  document.addEventListener('visibilitychange',hidden);window.addEventListener('pagehide',flush);
  const dispose=()=>{if(disposed)return;disposed=true;unschedule(timer);document.removeEventListener('visibilitychange',hidden);window.removeEventListener('pagehide',flush);installations.delete(document);};
  installations.set(document,dispose);return dispose;
}
