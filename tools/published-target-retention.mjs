import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {decodeSnapshot,MAX_FILE_BYTES,MAX_DECODED_BYTES} from './snapshot-package.mjs';
import {readPrivateSnapshotIndex} from './private-snapshot-index.mjs';
import {readLedger,ledgerBinding,ledgerKey} from './native-verification-ledger.mjs';
import {assertTrustedPublishedEventTotalsBaseline} from './published-event-totals-baseline.mjs';
import {nativeTargetTrackIds} from './native-target-filter.mjs';
import {reconstructOmittedBoards} from './update-public-snapshot.mjs';
import {readCapturedNormalLedgerRows} from './public-snapshot-backup.mjs';

const live=new WeakMap(),hash=b=>createHash('sha256').update(b).digest('hex');
const demand=(ok,message)=>{if(!ok)throw Error('Published target retention: '+message);};
// Bound I/O, retain source order, and drain every admitted read before rejecting.
export async function retentionMap16(values,task){
 demand(Array.isArray(values)&&typeof task==='function','invalid bounded read task');
 const results=new Array(values.length),errors=new Map();let next=0,stopped=false;
 await Promise.all(Array.from({length:Math.min(16,values.length)},async()=>{
  while(!stopped&&next<values.length){const index=next++;
   try{results[index]=await task(values[index],index);}catch(error){errors.set(index,error);stopped=true;}
  }
 }));
 if(errors.size)throw errors.get(Math.min(...errors.keys()));
 return results;
}
async function bytes(root,name,limit=MAX_DECODED_BYTES){
 demand(/^[A-Za-z0-9._/-]+$/.test(name)&&name.split('/').every(p=>p&&p!=='.'&&p!=='..'),'unsafe path');
 let file=root;for(const part of name.split('/')){file=path.join(file,part);const stat=await fs.lstat(file);
  demand(!stat.isSymbolicLink(),'symlink input');}
 const stat=await fs.stat(file);demand(stat.isFile()&&stat.size<=limit,'unsafe input size');
 const value=await fs.readFile(file);demand(value.length===stat.size,'input changed');return value;
}
async function sourcePins(data){
 demand(JSON.parse(await bytes(data.root,'snapshot-current.json',2048)).currentdir===data.currentdir,'source generation changed');
 demand(hash(await readPrivateSnapshotIndex(path.join(data.root,data.currentdir,'index.json')))===data.pins.indexSha256,'source index changed');
 demand(JSON.parse(await bytes(data.root,'verification-ledger-current.json',2048)).manifestHash===data.pins.ledgerManifestHash,'source ledger changed');
 readLedger({root:path.join(data.root,'verification-ledger'),expectedManifestHash:data.pins.ledgerManifestHash});
}

/** Retains publisher-authenticated bytes, never authorizes an old witness under a new policy.
 * No serialized token, private checkpoint or caller-supplied byte hash is admitted.
 */
export async function loadPublishedTargetRetention({root,directory,pins,targetTrackIds,publishedBaseline,targetScope='events'}={}){
 const baseline=assertTrustedPublishedEventTotalsBaseline(publishedBaseline);
 const tracks=nativeTargetTrackIds('events',targetTrackIds);demand(tracks,'explicit target tracks required');
 demand(path.isAbsolute(root||'')&&path.isAbsolute(directory||''),'absolute source paths required');
 demand(pins?.generation===baseline.provenance.generation&&pins.indexSha256===baseline.provenance.indexSha256,'baseline cohort mismatch');
 const data={root,currentdir:baseline.provenance.currentdir,pins:structuredClone(pins),baseline,tracks,
  protected:new Map(),initial:new Map(),allowed:new Set(),periods:new Set(),manifest:null,normalTracks:new Set(),preserveKeys:new Set(),oldNormalRows:new Map()};
 await sourcePins(data);
 const ledger=readLedger({root:path.join(root,'verification-ledger'),expectedManifestHash:pins.ledgerManifestHash});
 demand(ledger.entries.length===pins.ledgerEntries,'source ledger count mismatch');
 data.entries=structuredClone(ledger.entries);
 for(const {board}of baseline.boards)if(tracks.includes(board.period.trackId))data.periods.add(board.id);
 const index=JSON.parse(await readPrivateSnapshotIndex(path.join(root,data.currentdir,'index.json'))),paging=new Map();
 const isPagingPath=name=>/^(?:snapshot-paging\.json|overall-manifest\.json|(?:track-manifests|track-pages|overall-pages)\/)/.test(name);
 // Proof files are not rehydrated as authority. Each selected payload is independently authenticated.
 const records=Object.entries(index.files).filter(([name])=>isPagingPath(name)||name==='manifest.json'||name==='event-totals.json'||
  /^(?:tracks|canonical|recordings|events|event-replays|event-playbacks|native-event-source)\//.test(name));
 const checked=await retentionMap16(records,async([name,record])=>{
  demand(/^[a-f0-9]{64}$/.test(record.sha256||'')&&record.path===record.sha256+'.bin'&&
   Number.isSafeInteger(record.decodedBytes)&&record.decodedBytes<=MAX_DECODED_BYTES,'invalid source record');
  const encoded=await bytes(root,data.currentdir+'/'+record.path,MAX_FILE_BYTES);demand(hash(encoded)===record.sha256,'source payload hash mismatch');
  const decoded=Buffer.from(await decodeSnapshot(encoded));demand(decoded.length===record.decodedBytes,'source payload size mismatch');
  demand((await bytes(directory,name)).equals(decoded),'staging differs from published source: '+name);
  const event=/^(?:events|event-replays|event-playbacks)\/([^/.]+)/.exec(name),target=event&&data.periods.has(event[1]);
  let targetKey;
  if(target&&/^event-(?:replays|playbacks)\//.test(name)){
   const raw=JSON.parse(decoded);targetKey=ledgerKey(ledgerBinding({...raw,lane:'event',frames:raw.frames??raw.timeMs,uploadId:raw.uploadId??null}));
  }
  return {name,pin:hash(decoded),paging:isPagingPath(name)?{decoded,value:JSON.parse(decoded)}:null,
   manifest:name==='manifest.json'?JSON.parse(decoded):null,targetKey,
   protect:name!=='manifest.json'&&name!=='event-totals.json'&&!target&&name!=='events/permanent-rolling-hills.json'};
 });
 for(const item of checked){
  data.initial.set(item.name,item.pin);
  if(item.paging)paging.set(item.name,item.paging);
  if(item.manifest)data.manifest=item.manifest;
  if(item.protect)data.protected.set(item.name,item.pin);
  if(item.targetKey)data.allowed.add(item.targetKey);
 }
 demand(data.manifest?.nativeVerificationLedger?.manifestHash===pins.ledgerManifestHash,'published manifest ledger mismatch');
 // Reuse the hydrator's catalog/count/order/bounds checks against freshly authenticated pages.
 for(const reconstructed of reconstructOmittedBoards(index,paging))if(reconstructed.logicalPath.startsWith('tracks/')){
  demand((await bytes(directory,reconstructed.logicalPath,128*1024*1024)).equals(reconstructed.decoded),'page-bound normal reconstruction mismatch');
  data.protected.set(reconstructed.logicalPath,hash(reconstructed.decoded));data.initial.set(reconstructed.logicalPath,hash(reconstructed.decoded));
 }
 for(const record of Object.values(data.manifest.tracks||{}))if(record.path)demand(data.protected.has(record.path),'unindexed normal board requires separate retention review');
 if(targetScope==='all')for(const id of tracks)if(data.manifest.tracks?.[id]?.path)data.normalTracks.add(id);
 demand(tracks.every(id=>baseline.boards.some(({board})=>board.period.trackId===id)||data.normalTracks.has(id)),'unpublished target track');
 if(data.normalTracks.size){
  const sources=await readCapturedNormalLedgerRows({directory,allowMissingCanonical:true}),old=new Set(data.entries.map(row=>row.key));
  for(const id of data.normalTracks){
   const logical='tracks/'+id+'.json',board=JSON.parse(await bytes(directory,logical,128*1024*1024));
   data.protected.delete(logical);
   const preserved=[];
   for(const source of sources.filter(row=>row.trackId===id)){
    const key=ledgerKey(ledgerBinding(source,'normal')),row=board.entries.find(row=>row.accountId===source.accountId);
    demand(row&&row.timeMs===source.timeMs&&row.replayHash===source.replayHash&&row.uploadId===source.uploadId,'normal row binding changed');
    if(row.runVerified===true||old.has(key)){data.preserveKeys.add(key);preserved.push(structuredClone(row));continue;}
    const canonical='canonical/'+id+'/'+source.accountId+'.json',recording='recordings/'+source.uploadId+'.json';
    demand(data.initial.has(canonical)&&data.initial.has(recording),'normal target requires published canonical and replay');
    const raw=JSON.parse(await bytes(directory,recording));
    demand(raw.frames===source.frames&&raw.replayHash===source.replayHash&&typeof raw.recording==='string'&&hash(raw.recording)===source.replayHash,'normal target replay binding changed');
    data.allowed.add(key);data.protected.delete(canonical);data.protected.delete(recording);
   }
   data.oldNormalRows.set(id,preserved);
  }
 }
 demand(data.allowed.size>0,'no exact target media');
 await sourcePins(data);
 const receipt=Object.freeze({kind:'published-target-byte-retention-v1',publishedBaseline:Object.freeze({...pins}),
  targetTrackIds:tracks,targetPeriodIds:Object.freeze([...data.periods].sort()),normalTargetTrackIds:Object.freeze([...data.normalTracks].sort()),allowedNewKeys:data.allowed.size,
  retainedFiles:data.protected.size,retainedLedgerEntries:ledger.entries.length,
  sourcePolicyFingerprint:data.manifest.nativeVerificationLedger.policyFingerprint,oldWitnessCompatibilityGranted:false});
 live.set(receipt,data);return receipt;
}

export async function assertPublishedTargetRetention(token,{directory,ledger,targetTrackIds,publishedBaseline,initial=false}={}){
 const data=live.get(token);demand(data,'live retention capability required');
 demand(publishedBaseline===data.baseline&&isDeepStrictEqual(nativeTargetTrackIds('events',targetTrackIds),data.tracks),'retention scope mismatch');
 await sourcePins(data);
 const current=new Map(ledger.entries.map(entry=>[entry.key,entry]));demand(current.size===ledger.entries.length,'duplicate ledger entries');
 for(const entry of data.entries)demand(isDeepStrictEqual(current.get(entry.key),entry),'previous ledger entry changed or deleted');
 const old=new Set(data.entries.map(entry=>entry.key));
 for(const entry of ledger.entries)if(!old.has(entry.key))demand(data.allowed.has(entry.key)&&data.tracks.includes(entry.binding.trackId),'out-of-target ledger admission');
 await retentionMap16([...(initial?data.initial:data.protected)],async([name,pin])=>{
  demand(hash(await bytes(directory,name,name.startsWith('tracks/')?128*1024*1024:MAX_DECODED_BYTES))===pin,'retained bytes changed: '+name);
 });
 const manifest=JSON.parse(await bytes(directory,'manifest.json'));
 for(const [id,record]of Object.entries(data.manifest.tracks||{}))if(!data.normalTracks.has(id))demand(isDeepStrictEqual(manifest.tracks?.[id],record),'normal manifest changed');
 const proofFields=['accountId','timeMs','frames','uploadId','replayHash','runVerified','verified','verifiedState','verificationStatus','integrityVerified','verifiedAt','nativeLedgerKey','nativeLedgerManifestHash','needsReview','reviewHold','excluded'];
 for(const [id,rows]of data.oldNormalRows){
  const board=JSON.parse(await bytes(directory,'tracks/'+id+'.json',128*1024*1024));
  for(const row of rows){const retained=board.entries.find(value=>value.accountId===row.accountId);
   demand(retained&&proofFields.every(field=>isDeepStrictEqual(retained[field],row[field])),'previous normal proof changed');}
 }
 for(const [id,record]of Object.entries(data.manifest.events||{}))if(id!=='permanent-rolling-hills'&&!data.periods.has(id))
  demand(isDeepStrictEqual(manifest.events?.[id],record),'non-target event manifest changed');
 await sourcePins(data);
 return token;
}

export function publishedNormalRetentionSelection(token){
 const data=live.get(token);demand(data,'live retention capability required');
 return {targetTrackIds:[...data.normalTracks],preservePublishedKeys:new Set(data.preserveKeys)};
}

export function assertPublishedTargetJobs(token,jobs){
 const data=live.get(token);demand(data,'live retention capability required');
 const old=new Set(data.entries.map(row=>row.key)),expected=new Set([...data.allowed].filter(key=>!old.has(key)));
 const actual=new Set(jobs.map(job=>ledgerKey(ledgerBinding(job))));
 demand(actual.size===jobs.length&&actual.size===expected.size&&[...actual].every(key=>expected.has(key)),
  'native target inventory differs from exact published pending bindings');
}
