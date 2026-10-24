import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {decodeSnapshot} from './snapshot-package.mjs';
import {preparePublicRecordingPlayback} from './public-replay-playback.mjs';
import {enrichPublicEventDates} from './public-event-dates.mjs';
const sha=value=>createHash('sha256').update(value).digest('hex');
const HASH=/^[a-f0-9]{64}$/;
export async function repairSavedReplayBindings({root,output,includePendingPublicPlayback=false}){
 root=await fs.realpath(root);output=path.resolve(output);
 if(output===root||output.startsWith(root+path.sep))throw Error('Repair output must be outside source repository');
 const pointerBytes=await fs.readFile(path.join(root,'snapshot-current.json')),pointer=JSON.parse(pointerBytes);
 if(!/^public-snapshots[1-9]\d*$/.test(pointer.currentdir||''))throw Error('Invalid pointer');
 const generation=await fs.realpath(path.join(root,pointer.currentdir));
 if(path.dirname(generation)!==root)throw Error('Snapshot escapes source repository');
 const indexBytes=await fs.readFile(path.join(generation,'index.json')),index=JSON.parse(indexBytes);
 if(index.generation!==Number(pointer.currentdir.slice(16))||index.encoding!=='gzip-xor-a7-v1')throw Error('Invalid generation');
 const cache=new Map(),files=[],gaps=[],assets=[];
 async function read(logical){
  if(cache.has(logical))return cache.get(logical);
  const item=index.files[logical];if(!item)return null;
  if(!HASH.test(item.sha256||'')||item.path!==item.sha256+'.bin'||!Number.isSafeInteger(item.decodedBytes)||item.decodedBytes<1||item.decodedBytes>2097152)throw Error('Invalid index binding');
  const file=path.join(generation,item.path),stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2097152)throw Error('Invalid asset');
  const bytes=await fs.readFile(file);if(sha(bytes)!==item.sha256)throw Error('Asset hash mismatch');
  const decoded=await decodeSnapshot(bytes);if(decoded.length!==item.decodedBytes)throw Error('Asset length mismatch');
  const value=JSON.parse(Buffer.from(decoded).toString());cache.set(logical,value);return value;
 }
 async function write(logical,value,source){
  const bytes=JSON.stringify(value)+'\n',destination=path.join(output,logical);
  await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,bytes,{flag:'wx'});
  files.push({path:logical,sha256:sha(bytes),source});
 }
 for(const logical of Object.keys(index.files).filter(k=>/^(recordings|event-replays)\//.test(k))){
  const row=await read(logical),recording=row.recording??row.replay;
  if(typeof recording==='string'&&HASH.test(row.accountId||'')&&HASH.test(row.trackId||'')&&sha(recording)===row.replayHash)assets.push({logical,row,recording});
 }
 let normalRows=0,eventRows=0,dateRowsEnriched=0,pendingRepairs=0,verifiedRepairs=0;
 for(const logical of Object.keys(index.files).filter(k=>/^tracks\/[a-f0-9]{64}\.json$/.test(k))){
  const board=await read(logical);if(!Array.isArray(board.entries)||board.trackId!==logical.slice(7,-5))throw Error('Invalid board');
  for(const entry of board.entries){
   normalRows++;
   const key=`canonical/${board.trackId}/${entry.accountId}.json`,prior=await read(key);
   if(prior&&prior.uploadId===entry.uploadId&&prior.replayHash===entry.replayHash&&prior.timeMs===entry.timeMs)continue;
   const pending=entry.runVerified===false&&entry.verified===false&&entry.integrityVerified===true&&entry.verifiedState===0;
   if(pending&&!includePendingPublicPlayback){gaps.push({trackId:board.trackId,accountId:entry.accountId,uploadId:entry.uploadId,reason:'pending_export_not_enabled'});continue;}
   const source=assets.find(a=>a.row.accountId===entry.accountId&&a.row.trackId===board.trackId&&a.row.frames===entry.frames&&a.row.replayHash===entry.replayHash);
   if(!source){gaps.push({trackId:board.trackId,accountId:entry.accountId,uploadId:entry.uploadId,replayHash:entry.replayHash,name:entry.name,timeMs:entry.timeMs,reason:'exact_public_bytes_unavailable'});continue;}
   const row={recording:source.recording,frames:entry.frames,accountId:entry.accountId,trackId:board.trackId,replayHash:entry.replayHash,carStyle:source.row.carStyle||'',verifiedState:pending?0:source.row.verifiedState??1};
   try{await preparePublicRecordingPlayback(row,entry,{allowPending:includePendingPublicPlayback});}catch{gaps.push({trackId:board.trackId,accountId:entry.accountId,reason:'playback_binding_or_structure_rejected'});continue;}
   const metadata=Object.fromEntries(['accountId','trackId','uploadId','frames','raceTimeFrames','timeMs','replayHash','name','nickname','countryCode','carStyle','createdAt','pbAt'].filter(k=>Object.hasOwn(entry,k)).map(k=>[k,entry[k]]));
   const canonical={...metadata,updatedAt:board.updatedAt,verified:!pending,runVerified:!pending,integrityVerified:true,verifiedState:pending?0:1};
   if(pending){Object.assign(row,{playbackPending:true,verificationStatus:'pending',eventRpEligible:false});Object.assign(canonical,{playbackPending:true,verificationStatus:'pending',eventRpEligible:false});}
   row.updatedAt=board.updatedAt;
   await write(key,canonical,source.logical);await write(`recordings/${entry.uploadId}.json`,row,source.logical);
   if(pending)pendingRepairs++;else verifiedRepairs++;
  }
 }
 for(const logical of Object.keys(index.files).filter(k=>/^events\/[^/]+\.json$/.test(k))){
  const board=await read(logical);eventRows+=(board.entries||[]).length;
  const replays=assets.filter(a=>a.logical.startsWith('event-replays/')&&a.row.periodId===board.id).map(a=>a.row);
  const enriched=enrichPublicEventDates(board,replays);
  dateRowsEnriched+=enriched.entries.filter((r,i)=>JSON.stringify(r)!==JSON.stringify(board.entries[i])).length;
  if(JSON.stringify(enriched)!==JSON.stringify(board))await write(logical,enriched,'exact saved public event replay metadata');
 }
 const manifest={schema:'offline-public-replay-repair-v1',generation:pointer.currentdir,pointerSha256:sha(pointerBytes),indexSha256:sha(indexBytes),networkRequests:0,verificationAttempts:0,publications:0,pendingRepairs,verifiedRepairs,normalRows,eventRows,dateRowsEnriched,files,gaps,
  limitations:['Private repair output only; not a native proof or a deployed snapshot.','Do not merge across changed source bindings/generation.','Enable pending public playback only after explicit workflow/privacy review.']};
 await write('repair-manifest.json',manifest,'offline source');return manifest;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const arg=name=>{const i=process.argv.indexOf(name);return i<0?undefined:process.argv[i+1];};
 const result=await repairSavedReplayBindings({root:arg('--root'),output:arg('--output'),includePendingPublicPlayback:process.argv.includes('--include-pending-public-playback')});
 console.log(JSON.stringify({pendingRepairs:result.pendingRepairs,verifiedRepairs:result.verifiedRepairs,dateRowsEnriched:result.dateRowsEnriched,gaps:result.gaps.length,networkRequests:0}));
}
