import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {publicEventPlaybackForPublication} from './public-event-playback.mjs';

const HASH=/^[a-f0-9]{64}$/,ID=/^[A-Za-z0-9_-]{1,64}$/;
const demand=(ok,message)=>{if(!ok)throw Error('Local playback cache: '+message);};
async function directory(value){
  demand(path.isAbsolute(value||''),'absolute directory required');
  const stat=await fs.lstat(value);demand(stat.isDirectory()&&!stat.isSymbolicLink(),'unsafe directory');
  return fs.realpath(value);
}
async function read(root,relative,limit){
  const file=path.join(root,relative),stat=await fs.lstat(file);
  demand(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=limit,'unsafe or oversized file');
  demand((await fs.realpath(file)).startsWith(root+path.sep),'file escaped directory');
  const bytes=await fs.readFile(file);demand(bytes.length<=limit,'file grew beyond bound');
  return {bytes,value:JSON.parse(bytes.toString('utf8'))};
}

// Payload reuse only. The current board supplies the exact waiting binding;
// neither cached bytes nor their source directory supply a physics verdict.
export async function seedLocalEventPlaybacks({directory:target,cacheDirectory}={}){
  const root=await directory(target),cache=await directory(cacheDirectory);
  demand(root!==cache,'source and destination must differ');
  const manifestFile=path.join(root,'manifest.json'),original=await read(root,'manifest.json',2*1024*1024);
  const manifest=original.value;
  demand(manifest?.schemaVersion===1&&manifest.events&&typeof manifest.events==='object'&&!Array.isArray(manifest.events),'invalid manifest');
  const records=Object.entries(manifest.events);demand(records.length<=1024,'board limit');
  const copies=[],created=[];let inspected=0,bytes=0,reused=0,rejected=0;
  let temporary;
  try{
    for(const [id,record]of records){
      demand(ID.test(id)&&record?.path===`events/${id}.json`,'invalid event path');
      const {value:board}=await read(root,record.path,2*1024*1024);
      demand(board.id===id&&Array.isArray(board.pendingPlaybacks??[]),'invalid board');
      if(!board.pendingPlaybacks?.length)continue;
      demand(board.period?.id===id&&HASH.test(board.period.trackId||''),'invalid board binding');
      for(const entry of board.pendingPlaybacks||[]){
        demand(++inspected<=2000,'pending row limit');
        if(!HASH.test(entry.runId||'')||!HASH.test(entry.replayHash||'')){rejected++;continue;}
        const relative=`event-playbacks/${id}/${entry.runId}.json`,file=path.join(root,relative);
        if(await fs.lstat(file).then(()=>true,e=>{if(e.code==='ENOENT')return false;throw e;}))continue;
        let saved;
        try{
          saved=await read(cache,relative,70*1024);
          const projected=await publicEventPlaybackForPublication(saved.value,{periodId:id,trackId:board.period.trackId,entry});
          demand(isDeepStrictEqual(projected,saved.value),'non-public cached fields');
        }catch{rejected++;continue;}
        demand(bytes+saved.bytes.length<=8*1024*1024,'payload byte limit');bytes+=saved.bytes.length;
        copies.push({relative,file,bytes:saved.bytes,metadata:{path:relative,periodId:id,runId:entry.runId,
          accountId:entry.accountId,timeMs:entry.timeMs,replayHash:entry.replayHash}});
      }
    }
    if(!copies.length)return {inspected,reused,rejected,bytes,backendReads:0,backendWrites:0};
    manifest.eventPlaybacks={...manifest.eventPlaybacks};
    for(const copy of copies){
      let folder=root;
      for(const part of copy.relative.split('/').slice(0,-1)){
        folder=path.join(folder,part);await fs.mkdir(folder).catch(e=>{if(e.code!=='EEXIST')throw e;});
        const stat=await fs.lstat(folder);
        demand(stat.isDirectory()&&!stat.isSymbolicLink()&&(await fs.realpath(folder)).startsWith(root+path.sep),'unsafe output directory');
      }
      await fs.writeFile(copy.file,copy.bytes,{flag:'wx',mode:0o600});created.push(copy.file);
      manifest.eventPlaybacks[copy.relative]=copy.metadata;reused++;
    }
    demand((await fs.readFile(manifestFile)).equals(original.bytes),'manifest changed during reuse');
    temporary=path.join(root,'.playback-cache-'+randomUUID()+'.tmp');
    await fs.writeFile(temporary,JSON.stringify(manifest)+'\n',{flag:'wx',mode:0o600});
    await fs.rename(temporary,manifestFile);temporary=null;
    return {inspected,reused,rejected,bytes,backendReads:0,backendWrites:0};
  }catch(error){
    for(const file of created)await fs.unlink(file).catch(()=>{});
    if(temporary)await fs.unlink(temporary).catch(()=>{});
    throw error;
  }
}
