const MEASUREMENT_ID='G-QXB7CHLEDT';
const installations=new WeakMap();
const reportBudgets=new WeakMap();
const fields={
  fs_reads_est:['firestore','knownReadEstimate'],fs_writes_est:['firestore','knownWriteEstimate'],
  fs_unknown_reads:['firestore','unknownReadOperations'],fs_unknown_writes:['firestore','unknownWriteOperations'],
  worker_ops:['worker','operations'],snapshot_ops:['snapshot','operations'],cache_ops:['cache','operations']
};
const counter=value=>Number.isSafeInteger(value)&&value>=0?value:null;
function sample(readUsage,at){
  try {
    const usage=readUsage();
    if(usage?.version!==1||!Number.isSafeInteger(usage.startedAt)||usage.startedAt<0||usage.startedAt>at)return null;
    const counts={};
    for(const [name,[source,key]] of Object.entries(fields)){
      const value=counter(usage.buckets?.[source]?.[key]);
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
  const deploymentGroup=window.__polytrackAnalyticsDeployment;
  const clock=()=>{try{const at=now();return Number.isSafeInteger(at)&&at>=0?at:null;}catch{return null;}};
  const installedAt=clock();if(installedAt===null)return ()=>{};
  // Keep only an in-memory page budget across cleanup/reinstallation, not an ID.
  let budget=reportBudgets.get(document);
  if(!budget){budget={sent:0,lastSent:-Infinity};reportBudgets.set(document,budget);}
  let baseline=sample(readUsage,installedAt),lastAt=installedAt,disposed=false,timer=null,consentPaused=false;
  const flush=()=>{
    try {
      if(disposed||budget.sent>=128)return false;
      if(window.__polytrackAnalyticsAllowed!==true){consentPaused=true;baseline=null;return false;}
      const at=clock();if(at===null||at<lastAt)return false;
      // The resume boundary is unknown. Discard the entire unobserved interval.
      if(consentPaused){baseline=sample(readUsage,at);lastAt=at;consentPaused=false;return false;}
      if(typeof window.gtag!=='function'||at-budget.lastSent<60000)return false;
      const current=sample(readUsage,at);if(!current)return false;
      if(!baseline||baseline.startedAt!==current.startedAt){
        // Only a new observer since the last accepted sample can start at zero.
        // Late/restored historical counters must be baselined, never resent.
        if(current.startedAt<lastAt||baseline&&current.startedAt<=baseline.startedAt){baseline=current;lastAt=at;return false;}
        baseline={startedAt:current.startedAt,counts:Object.fromEntries(Object.keys(fields).map(name=>[name,0]))};
      }
      const delta={};
      for(const name of Object.keys(fields)){
        if(current.counts[name]<baseline.counts[name]){baseline=current;lastAt=at;return false;}
        // Bound the interval, not cumulative counters: large histories still advance.
        delta[name]=Math.min(1e9,current.counts[name]-baseline.counts[name]);
      }
      if(!Object.values(delta).some(value=>value>0))return false;
      window.gtag('event','polytrack_client_usage',{send_to:MEASUREMENT_ID,event_schema:1,usage_scope:'client_observed',
        client_revision:revision,deployment_group:deploymentGroup,
        interval_seconds:Math.min(86400,Math.max(0,Math.round((at-lastAt)/1000))),...delta});
      baseline=current;lastAt=at;budget.lastSent=at;budget.sent++;return true;
    }catch{return false;}
  };
  const hidden=()=>{if(document.visibilityState==='hidden')flush();};
  const dispose=()=>{
    if(disposed)return;disposed=true;
    try{if(timer!==null)unschedule(timer);}catch{/* Optional timer cleanup. */}
    document.removeEventListener('visibilitychange',hidden);window.removeEventListener('pagehide',flush);installations.delete(document);
  };
  try{
    document.addEventListener('visibilitychange',hidden);window.addEventListener('pagehide',flush);
    timer=schedule(flush,15*60*1000);
  }catch{dispose();return dispose;}
  installations.set(document,dispose);return dispose;
}
