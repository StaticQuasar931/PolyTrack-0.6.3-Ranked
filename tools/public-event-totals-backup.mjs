import fs from 'node:fs/promises';
import path from 'node:path';
import {publicDisplayName} from './public-display-name.mjs';
import {decode} from './verifier/firestore.mjs';
import {publicOverallBackup} from './public-snapshot-backup.mjs';
import {assemblePublishedSnapshotPages} from './published-snapshot-pages.mjs';
import {PublicBackupDeferredError} from './public-backup-fetch.mjs';
import {createWorkerCaptureFetch} from './worker-capture-fetch.mjs';
import {buildEventRpHighlights,EVENT_HIGHLIGHT_LIMITS} from './event-rp-highlights.mjs';

export function publicEventTotals(value,{capturedBoards=[]}={}){
  if(!Number.isSafeInteger(value?.updatedAt)||value.updatedAt<0||!Array.isArray(value.entries)||value.entries.length>10000||value.entries.length>200&&!(value.paginatedSource===true&&value.complete===true&&value.totalEntries===value.entries.length))throw Error('Invalid public event totals');
  const seen=new Set();
  const entries=value.entries.map(row=>{
    const accountId=row.accountId||row.userId;
    if(!/^[a-f0-9]{64}$/.test(accountId)||seen.has(accountId))throw Error('Invalid event total identity');
    seen.add(accountId);
    const identity=publicOverallBackup({updatedAt:0,entries:[{...row,userId:accountId}],trackSummaries:[]}).snapshot.entries[0];
    const result={accountId,name:publicDisplayName(row.name)};
    for(const key of ['countryCode','carStyle','carId','carColors','profileCosmetics','identityUpdatedAt','accountCreatedAt','badges'])if(identity[key]!==undefined)result[key]=identity[key];
    for(const key of ['rank','rp','events','finiteEventRp','rollingHillsRunAgeMs','rollingHillsEventRpContribution','permanentRollingHillsRp','rollingHillsTimeMs']){
      if(row[key]!=null){if(!Number.isFinite(row[key])||row[key]<0)throw Error('Invalid public event metric');result[key]=row[key];}
    }
    return result;
  });
  const highlights=buildEventRpHighlights({totalsRows:entries,boards:capturedBoards});
  for(const row of entries)if(highlights.get(row.accountId)?.length)row.eventHighlights=highlights.get(row.accountId);
  return {updatedAt:value.updatedAt,entries,...(typeof value.complete==='boolean'?{complete:value.complete}:{}),...(Number.isSafeInteger(value.totalEntries)?{totalEntries:value.totalEntries}:{})};
}

// Only already-captured local board files are eligible; never fetch missing boards.
async function readCapturedEventBoards(directory){
  let manifest;
  try{manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'));}catch{return [];}
  const records=manifest?.events;
  if(!records||typeof records!=='object'||Array.isArray(records))return [];
  const entries=Object.entries(records);
  if(entries.length>EVENT_HIGHLIGHT_LIMITS.boards)return [];
  const boards=new Map();let rows=0;
  for(const [id,record] of entries){
    if(!/^[a-zA-Z0-9_-]{1,128}$/.test(id)||record?.path!==`events/${id}.json`)continue;
    try{
      const file=path.join(directory,record.path),stat=await fs.lstat(file);
      if(!stat.isFile()||stat.size>8*1024*1024)continue;
      const board=JSON.parse(await fs.readFile(file,'utf8'));
      if(!Array.isArray(board?.entries)||board.entries.length>EVENT_HIGHLIGHT_LIMITS.rowsPerBoard)continue;
      rows+=board.entries.length;
      if(rows>EVENT_HIGHLIGHT_LIMITS.totalRows)return [];
      boards.set(id,board);
    }catch{/* Missing/corrupt optional captures cannot trigger network recovery. */}
  }
  return boards;
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

export async function capturePublicEventTotals({directory,fetchImpl=createWorkerCaptureFetch(),log=()=>{},now=Date.now,capturedBoards}){
  const request=(...args)=>totalsNetworkRead(()=>fetchImpl(...args));
  try{
    const response=await request('https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/events/totals',{headers:{Accept:'application/json',Origin:'https://staticquasar931.github.io'},signal:AbortSignal.timeout(10000)});
    // Public Firestore totals are backend-only. Never retry a Worker denial there.
    const raw=await totalsJson(response);
    const source=raw.fields?Object.fromEntries(Object.entries(raw.fields).map(([key,value])=>[key,decode(value)])):raw;
    let pageRequests=0;
    const full=await assemblePublishedSnapshotPages(source,{fetchPage:async(page,generation)=>{pageRequests++;return totalsJson(await request('https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/events/totals/page?generation='+encodeURIComponent(generation)+'&page='+page,{headers:{Accept:'application/json',Origin:'https://staticquasar931.github.io'},signal:AbortSignal.timeout(12000)}));}});
    const value=publicEventTotals(full,{capturedBoards:capturedBoards??await readCapturedEventBoards(directory)});
    if(full.complete!==undefined&&full.complete!==true||full.sourceComplete!==undefined&&full.sourceComplete!==true||full.totalEntries!==undefined&&full.totalEntries!==value.entries.length)throw Error('Incomplete or invalid public event totals coverage');
    const checkedAt=now();
    if(!Number.isSafeInteger(checkedAt)||checkedAt<=0||checkedAt<value.updatedAt)throw Error('Invalid event totals confirmation time');
    value.capturedAt=new Date(checkedAt).toISOString();
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
