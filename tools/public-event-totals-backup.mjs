import fs from 'node:fs/promises';
import path from 'node:path';
import {publicDisplayName} from './public-display-name.mjs';
import {decode} from './verifier/firestore.mjs';

export function publicEventTotals(value){
  if(!Number.isSafeInteger(value?.updatedAt)||value.updatedAt<0||!Array.isArray(value.entries)||value.entries.length>200)throw Error('Invalid public event totals');
  const seen=new Set();
  const entries=value.entries.map(row=>{
    const accountId=row.accountId||row.userId;
    if(!/^[a-f0-9]{64}$/.test(accountId)||seen.has(accountId))throw Error('Invalid event total identity');
    seen.add(accountId);
    const result={accountId,name:publicDisplayName(row.name)};
    for(const key of ['rank','rp','events','rollingHillsRunAgeMs','rollingHillsEventRpContribution','permanentRollingHillsRp','rollingHillsTimeMs']){
      if(row[key]!=null){if(!Number.isFinite(row[key])||row[key]<0)throw Error('Invalid public event metric');result[key]=row[key];}
    }
    return result;
  });
  return {updatedAt:value.updatedAt,entries,...(typeof value.complete==='boolean'?{complete:value.complete}:{}),...(Number.isSafeInteger(value.totalEntries)?{totalEntries:value.totalEntries}:{})};
}

export async function capturePublicEventTotals({directory,fetchImpl=fetch,log=()=>{}}){
  try{
    const response=await fetchImpl('https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/events/totals',{headers:{Accept:'application/json'},signal:AbortSignal.timeout(10000)});
    let result=response;
    if(response.status===403||response.status===404)result=await fetchImpl('https://firestore.googleapis.com/v1/projects/polytrack-052/databases/(default)/documents/0.6.2_event_public/totals?mask.fieldPaths=entries&mask.fieldPaths=updatedAt&mask.fieldPaths=complete&mask.fieldPaths=totalEntries',{signal:AbortSignal.timeout(10000)});
    if(!result.ok)throw Error('Event totals unavailable: '+result.status);
    const text=await result.text();if(Buffer.byteLength(text)>2*1024*1024)throw Error('Event totals too large');
    const raw=JSON.parse(text);
    const value=publicEventTotals(raw.fields?Object.fromEntries(Object.entries(raw.fields).map(([key,value])=>[key,decode(value)])):raw);
    await fs.mkdir(directory,{recursive:true});
    const target=path.join(directory,'event-totals.json'),temporary=target+'.'+process.pid+'.tmp';
    await fs.writeFile(temporary,JSON.stringify(value)+'\n');await fs.rename(temporary,target);
    return {entries:value.entries.length,updatedAt:value.updatedAt};
  }catch(error){log(JSON.stringify({eventTotalsBackup:{deferred:true,reason:error.message,previousPreserved:true}}));return {deferred:true};}
}
