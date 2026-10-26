import {normalizeControlUsage} from './control-usage.mjs';
export const INSIGHTS_KEY='polytrack-local-insights-v1';
const hash=value=>/^[a-f0-9]{64}$/.test(value||'');
const count=value=>Number.isFinite(value)&&value>=0?Math.min(1e12,value):0;
const sources=new Set(['planner','profile','leaderboard','event','selection','unknown']);
const LATENCY_CAP_MS=30000;
const usageSources=['snapshot','cache','firestore','worker'];
const usageFields=['operations','knownReadEstimate','knownWriteEstimate','unknownReadOperations','unknownWriteOperations','durationSamples','durationMs'];
function normalizeClientUsage(value,at){
 if(value?.version!==1||!Number.isSafeInteger(value.startedAt)||value.startedAt<0||value.startedAt>at)return null;
 const buckets={};
 for(const source of usageSources){
  const raw=value.buckets?.[source]||{},row=Object.fromEntries(usageFields.map(key=>[key,key==='durationMs'?count(raw[key]):Math.floor(count(raw[key]))]));
  row.durationSamples=Math.min(row.operations,row.durationSamples);
  for(const key of ['unknownReadOperations','unknownWriteOperations'])row[key]=Math.min(row.operations,row[key]);
  if(source!=='firestore'){
   row.knownReadEstimate=row.knownWriteEstimate=0;
   row.unknownReadOperations=row.unknownWriteOperations=source==='worker'?row.operations:0;
  }
  buckets[source]=row;
 }
 return {version:1,startedAt:value.startedAt,buckets};
}
export function summarizeClientUsage(value,at=Date.now()){
 const usage=normalizeClientUsage(value,at);
 const billed={reads:null,writes:null,cost:null};
 const scope='Instrumented operations on this browser device only; not account-wide or billed Firebase metrics';
 if(!usage)return {available:false,scope,billed,estimatedDocuments:null,reason:'No explicit usage instrumentation recorded; HTTP/latency counts are not document reads'};
 const sum=key=>Object.values(usage.buckets).reduce((n,row)=>n+row[key],0),elapsedMs=Math.max(0,at-usage.startedAt);
 const round2=value=>Math.round(value*100)/100;
 return {available:true,scope,billed,startedAt:usage.startedAt,elapsedMs:Math.round(elapsedMs),
  observedOperations:Object.fromEntries(usageSources.map(source=>[source,usage.buckets[source].operations])),
  estimatedDocuments:{reads:sum('knownReadEstimate'),writes:sum('knownWriteEstimate'),unknownReadOperations:sum('unknownReadOperations'),unknownWriteOperations:sum('unknownWriteOperations')},
  elapsedAverages:{knownEstimatedReadsPerHour:elapsedMs?round2(sum('knownReadEstimate')*3600000/elapsedMs):null,knownEstimatedWritesPerHour:elapsedMs?round2(sum('knownWriteEstimate')*3600000/elapsedMs):null},
  observedOperationTiming:{samples:sum('durationSamples'),totalMs:Math.round(sum('durationMs')),averageMs:sum('durationSamples')?Math.round(sum('durationMs')/sum('durationSamples')):null},
  limitations:'Snapshot/cache operations contribute zero Firebase documents. Worker backend fanout is unknown. Known estimates omit uninstrumented operations, hidden retries, listeners and rule/index charges; request durations may overlap.'};
}
export function createLocalInsights({storage,now=Date.now,revision=0}={}){
 const timestamp=value=>Number.isFinite(value)&&value>0?Math.min(now(),value):0;
 let data={version:1,startedAt:now(),revisions:[],tracks:{},transitions:{},metrics:{},actions:{},controls:{}},dirty=false,lastSave=0,lastTrack='',intent=null,away=false;
 try{const saved=JSON.parse(storage?.getItem(INSIGHTS_KEY)||'null');if(saved?.version===1){
  data.startedAt=timestamp(saved.startedAt)||now();
  data.controls=normalizeControlUsage(saved.controls);
  const usage=normalizeClientUsage(saved.clientUsage,now());if(usage)data.clientUsage=usage;
  data.revisions=(saved.revisions||[]).slice(-32).filter(r=>Number.isSafeInteger(r.revision)&&r.revision>=0).map(r=>({revision:r.revision,firstAt:timestamp(r.firstAt),lastAt:timestamp(r.lastAt),visits:count(r.visits),visibleMs:count(r.visibleMs)}));
  for(const [id,row] of Object.entries(saved.tracks||{}).filter(([id])=>hash(id)).slice(-256))data.tracks[id]={plays:count(row.plays),lastAt:timestamp(row.lastAt),sources:Object.fromEntries([...sources].map(s=>[s,count(row.sources?.[s])]))};
  for(const [key,value] of Object.entries(saved.transitions||{}).filter(([key])=>/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(key)).slice(-512))data.transitions[key]=count(value);
  for(const [key,row] of Object.entries(saved.metrics||{}).filter(([key])=>/^[A-Z0-9_-]{1,32}$/.test(key)).slice(0,32))data.metrics[key]={count:count(row.count),totalMs:count(row.totalMs),maxMs:Math.min(LATENCY_CAP_MS,count(row.maxMs)),over5s:count(row.over5s),over30s:count(row.over30s)};
  for(const [key,value] of Object.entries(saved.actions||{}).filter(([key])=>/^[a-z-]{1,32}$/.test(key)).slice(0,32))data.actions[key]=count(value);
 }}catch{}
 const rev=data.revisions.find(r=>r.revision===revision);if(rev){rev.lastAt=now();rev.visits++;}else data.revisions.push({revision,firstAt:now(),lastAt:now(),visits:1,visibleMs:0});data.revisions=data.revisions.slice(-32);dirty=true;
 function flush(force=false){if(!dirty||!force&&now()-lastSave<30000)return;lastSave=now();try{storage?.setItem(INSIGHTS_KEY,JSON.stringify(data));dirty=false;}catch{}}
 function action(name){if(!/^[a-z-]{1,32}$/.test(name)||!Object.hasOwn(data.actions,name)&&Object.keys(data.actions).length>=32)return;data.actions[name]=count(data.actions[name])+1;dirty=true;flush();}
 function navigate(trackId,source='unknown'){if(!hash(trackId))return;source=sources.has(source)?source:'unknown';intent={trackId,source,at:now()};action(source+'-track-click');}
 function play(trackId,sourceHint='selection'){if(!hash(trackId))return;const source=intent?.trackId===trackId&&now()-intent.at<120000?intent.source:sources.has(sourceHint)?sourceHint:'selection';intent=null;
  // Repeated resets of the same track are attempts, not new navigation visits.
  if(trackId===lastTrack&&!away)return;away=false;
  if(lastTrack&&lastTrack!==trackId){const key=lastTrack+':'+trackId;data.transitions[key]=count(data.transitions[key])+1;while(Object.keys(data.transitions).length>512)delete data.transitions[Object.keys(data.transitions)[0]];}
  lastTrack=trackId;const row=data.tracks[trackId]||(data.tracks[trackId]={plays:0,lastAt:0,sources:{}});row.plays++;row.lastAt=now();row.sources[source]=count(row.sources[source])+1;
  while(Object.keys(data.tracks).length>256)delete data.tracks[Object.keys(data.tracks).filter(id=>id!==trackId).sort((a,b)=>data.tracks[a].lastAt-data.tracks[b].lastAt)[0]];dirty=true;flush();return true;
 }
 function measure(code,durationMs){if(!/^[A-Z0-9_-]{1,32}$/.test(code)||!Number.isFinite(durationMs)||durationMs<0||!Object.hasOwn(data.metrics,code)&&Object.keys(data.metrics).length>=32)return;const m=data.metrics[code]||(data.metrics[code]={count:0,totalMs:0,maxMs:0,over5s:0,over30s:0});const bounded=Math.min(durationMs,LATENCY_CAP_MS);m.count=count(m.count+1);m.totalMs=count(m.totalMs+bounded);m.maxMs=Math.max(m.maxMs,bounded);if(durationMs>5000)m.over5s=count(m.over5s+1);if(durationMs>LATENCY_CAP_MS)m.over30s=count(m.over30s+1);dirty=true;flush();}
 function predict(trackId){const rows=Object.entries(data.transitions).filter(([key])=>key.startsWith(trackId+':')).map(([key,n])=>({trackId:key.slice(65),count:n})).sort((a,b)=>b.count-a.count);const total=rows.reduce((n,r)=>n+r.count,0),best=rows[0];return best&&total>=5&&best.count>=4&&best.count/total>=.75?{trackId:best.trackId,confidence:best.count/total,observations:total}:null;}
 function report(){return JSON.parse(JSON.stringify({...data,latencyCapMs:LATENCY_CAP_MS,metrics:Object.fromEntries(Object.entries(data.metrics).map(([key,m])=>[key,{...m,averageMs:m.count?Math.round(m.totalMs/m.count):0,over5sPercent:m.count?Math.round(10000*m.over5s/m.count)/100:0,over30sPercent:m.count?Math.round(10000*m.over30s/m.count)/100:0}]))}));}
 function control(menu,name){
  if(!/^[a-z-]{1,24}$/.test(menu)||!/^[a-z0-9-]{1,40}$/.test(name))return;
  const normalized=normalizeControlUsage({[menu]:{[name]:1}});if(!normalized[menu])return;
  const row=data.controls[menu]||{};
  if(!Object.hasOwn(row,name)&&(Object.keys(row).length>=64||Object.values(data.controls).reduce((n,r)=>n+Object.keys(r).length,0)>=256))return;
  row[name]=Math.min(1e9,(row[name]||0)+1);data.controls[menu]=row;dirty=true;flush();
 }
 function observeUsage({source,reads,writes,durationMs}={}){
  if(!usageSources.includes(source)||[reads,writes].some(value=>value!==undefined&&value!==null&&(!Number.isSafeInteger(value)||value<0||value>1e9))||durationMs!==undefined&&(!Number.isFinite(durationMs)||durationMs<0))return false;
  if(source!=='firestore'&&[reads,writes].some(value=>value!==undefined&&value!==null&&value!==0))return false;
  data.clientUsage??=normalizeClientUsage({version:1,startedAt:now()},now());
  const row=data.clientUsage.buckets[source];row.operations=count(row.operations+1);
  for(const [value,known,unknown] of [[reads,'knownReadEstimate','unknownReadOperations'],[writes,'knownWriteEstimate','unknownWriteOperations']]){
   if(source==='worker'||source==='firestore'&&value==null)row[unknown]=count(row[unknown]+1);
   else if(source==='firestore')row[known]=count(row[known]+value);
  }
  if(durationMs!==undefined){row.durationSamples=count(row.durationSamples+1);row.durationMs=count(row.durationMs+durationMs);}
  dirty=true;flush();return true;
 }
 return {action,control,navigate,play,measure,predict,report,flush,observeUsage,observeVisible(ms){const row=data.revisions.find(r=>r.revision===revision);if(row){row.visibleMs=count(row.visibleMs)+Math.min(120000,count(ms));row.lastAt=now();dirty=true;flush();}},leave(){away=true;intent=null;}};
}
