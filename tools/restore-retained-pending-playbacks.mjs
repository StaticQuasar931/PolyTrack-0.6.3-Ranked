import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
import {decodeSnapshot} from './snapshot-package.mjs';import {eventReplayCoverage} from './event-replay-coverage.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function restoreRetainedPendingPlaybacks({root,directory,expectedIndexSha256=null}={}){
 if(!path.isAbsolute(root||'')||!path.isAbsolute(directory||''))throw Error('Explicit pending replay recovery paths required');
 let index=null,packageDirectory;const restored=[];let boards=0;
 async function retainedIndex(){
  if(index)return index;
  const pointer=JSON.parse(await fs.readFile(path.join(root,'snapshot-current.json'),'utf8'));
  if(!/^public-snapshots[1-9]\d*$/.test(pointer.currentdir))throw Error('Invalid retained public package');
  packageDirectory=path.join(root,pointer.currentdir);const bytes=await fs.readFile(path.join(packageDirectory,'index.json'));
  if(expectedIndexSha256!==null&&sha(bytes)!==expectedIndexSha256)throw Error('Retained public index changed');
  index=JSON.parse(bytes);return index;
 }
 for(const folder of ['events','archives']){
  let names;try{names=await fs.readdir(path.join(directory,folder))}catch(error){if(error.code==='ENOENT')continue;throw error;}
  for(const name of names){
   if(!/^[A-Za-z0-9_-]+\.json$/.test(name)||++boards>1024)throw Error('Retained replay board boundary');
   const board=JSON.parse(await fs.readFile(path.join(directory,folder,name),'utf8'));
   if(!Array.isArray(board.pendingPlaybacks)||!board.pendingPlaybacks.length)continue;
   if(!/^[A-Za-z0-9_-]{1,64}$/.test(board.period?.id||''))throw Error('Invalid retained pending period');
   for(const row of board.pendingPlaybacks){
    if(!/^[a-f0-9]{64}$/.test(row.runId||''))throw Error('Invalid retained pending run');
    const logical=`event-playbacks/${board.period.id}/${row.runId}.json`,target=path.join(directory,logical);
    const present=await fs.lstat(target).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;});if(present)continue;
    const entry=(await retainedIndex()).files?.[logical];if(!entry||entry.path!==entry.sha256+'.bin'||!/^[a-f0-9]{64}$/.test(entry.sha256)||restored.length>=2000)throw Error('Required pending replay absent from retained public package');
    const encoded=await fs.readFile(path.join(packageDirectory,entry.path));if(sha(encoded)!==entry.sha256)throw Error('Retained pending replay hash mismatch');
    const decoded=Buffer.from(await decodeSnapshot(encoded));if(decoded.length!==entry.decodedBytes)throw Error('Retained pending replay byte mismatch');
    const value=JSON.parse(decoded),coverage=await eventReplayCoverage([{...board,entries:[],pendingPlaybacks:[row]}],async relative=>{if(relative!==logical)throw Error('Unexpected pending replay request');return value;});
    if(!coverage.complete)throw Error('Retained pending replay binding mismatch');
    await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,decoded,{flag:'wx',mode:0o600});
    restored.push({path:logical,sha256:sha(decoded),sourcePayloadSha256:entry.sha256});
   }
  }
 }
 return{restored:restored.length,files:restored,backendReads:0,backendWrites:0,verificationChanges:0};
}
