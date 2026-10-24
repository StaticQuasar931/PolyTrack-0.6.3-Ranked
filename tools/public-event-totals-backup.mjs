import fs from 'node:fs/promises';
import path from 'node:path';
import {publicDisplayName} from './public-display-name.mjs';
import {decode} from './verifier/firestore.mjs';
import {publicOverallBackup} from './public-snapshot-backup.mjs';
import {assemblePublishedSnapshotPages} from './published-snapshot-pages.mjs';
import {PublicBackupDeferredError} from './public-backup-fetch.mjs';

export function publicEventTotals(value){
  if(!Number.isSafeInteger(value?.updatedAt)||value.updatedAt<0||!Array.isArray(value.entries)||value.entries.length>10000||value.entries.length>200&&!(value.paginatedSource===true&&value.complete===true&&value.totalEntries===value.entries.length))throw Error('Invalid public event totals');
  const seen=new Set();
  const entries=value.entries.map(row=>{
    const accountId=row.accountId||row.userId;
    if(!/^[a-f0-9]{64}$/.test(accountId)||seen.has(accountId))throw Error('Invalid event total identity');
    seen.add(accountId);
    const identity=publicOverallBackup({updatedAt:0,entries:[{...row,userId:accountId}],trackSummaries:[]}).snapshot.entries[0];
    const result={accountId,name:publicDisplayName(row.name)};
    for(const key of ['countryCode','carStyle','carId','carColors','profileCosmetics','identityUpdatedAt','accountCreatedAt','badges'])if(identity[key]!==undefined)result[key]=identity[key];
    for(const key of ['rank','rp','events','rollingHillsRunAgeMs','rollingHillsEventRpContribution','permanentRollingHillsRp','rollingHillsTimeMs']){
      if(row[key]!=null){if(!Number.isFinite(row[key])||row[key]<0)throw Error('Invalid public event metric');result[key]=row[key];}
    }
    return result;
  });
  return {updatedAt:value.updatedAt,entries,...(typeof value.complete==='boolean'?{complete:value.complete}:{}),...(Number.isSafeInteger(value.totalEntries)?{totalEntries:value.totalEntries}:{})};
}

async function totalsNetworkRead(work){
  try{return await work();}
  catch(error){
    if(!(['AbortError','TimeoutError'].includes(error?.name)||error instanceof TypeError&&['fetch failed','terminated'].includes(error.message)))throw error;
    throw new PublicBackupDeferredError('Event totals network request interrupted');
  }
}

async function totalsJson(response){
  if([408,429,500,502,503,504].includes(response.status))throw new PublicBackupDeferredError('Event totals service temporarily unavailable',response.status);
  if(!response.ok)throw Error('Event totals unavailable: '+response.status);
  if(Number(response.headers?.get('content-length')||0)>2*1024*1024)throw Error('Event totals too large');
  const text=await totalsNetworkRead(()=>response.text());
  if(Buffer.byteLength(text)>2*1024*1024)throw Error('Event totals too large');
  return JSON.parse(text);
}

export async function capturePublicEventTotals({directory,fetchImpl=fetch,log=()=>{}}){
  const request=(...args)=>totalsNetworkRead(()=>fetchImpl(...args));
  try{
    const response=await request('https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/events/totals',{headers:{Accept:'application/json',Origin:'https://staticquasar931.github.io'},signal:AbortSignal.timeout(10000)});
    // Public Firestore totals are backend-only. Never retry a Worker denial there.
    const raw=await totalsJson(response);
    const source=raw.fields?Object.fromEntries(Object.entries(raw.fields).map(([key,value])=>[key,decode(value)])):raw;
    let pageRequests=0;
    const full=await assemblePublishedSnapshotPages(source,{fetchPage:async(page,generation)=>{pageRequests++;return totalsJson(await request('https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/events/totals/page?generation='+encodeURIComponent(generation)+'&page='+page,{headers:{Accept:'application/json',Origin:'https://staticquasar931.github.io'},signal:AbortSignal.timeout(12000)}));}});
    const value=publicEventTotals(full);
    if(full.complete!==undefined&&full.complete!==true||full.sourceComplete!==undefined&&full.sourceComplete!==true||full.totalEntries!==undefined&&full.totalEntries!==value.entries.length)throw Error('Incomplete or invalid public event totals coverage');
    await fs.mkdir(directory,{recursive:true});
    const target=path.join(directory,'event-totals.json'),temporary=target+'.'+process.pid+'.tmp';
    await fs.writeFile(temporary,JSON.stringify(value)+'\n');await fs.rename(temporary,target);
    return {deferred:false,entries:value.entries.length,updatedAt:value.updatedAt,pageRequests};
  }catch(error){
    if(!(error instanceof PublicBackupDeferredError))throw error;
    const result={deferred:true,reason:error.message,status:error.status,previousPreserved:true};
    log(JSON.stringify({eventTotalsBackup:result}));return result;
  }
}
