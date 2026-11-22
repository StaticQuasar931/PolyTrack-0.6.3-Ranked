import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {decodeSnapshot,MAX_DECODED_BYTES} from './snapshot-package.mjs';
import {readPrivateSnapshotIndex} from './private-snapshot-index.mjs';
import {rankTrustedTrackEntries} from '../workers/ranked/src/index.js';

const HASH=/^[a-f0-9]{64}$/;
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const validCount=(x,max)=>Number.isSafeInteger(x)&&x>0&&x<=max;
const readJson=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const sameRun=(a,b)=>a?.accountId===b.accountId&&a.trackId===b.trackId&&a.uploadId===b.uploadId&&
  a.timeMs===b.timeMs&&(a.frames??a.raceTimeFrames)===(b.frames??b.raceTimeFrames)&&a.replayHash===b.replayHash;

async function hasFile(file){
  try{
    const st=await fs.lstat(file);
    if(!st.isFile()||st.isSymbolicLink())throw Error('Invalid staged replay file');
    return true;
  }catch(error){if(error.code==='ENOENT')return false;throw error;}
}

async function openPublishedFiles(root){
  const {currentdir}=await readJson(path.join(root,'snapshot-current.json'));
  if(!/^public-snapshots[1-9]\d*$/.test(currentdir||''))throw Error('Invalid replay recovery pointer');
  const directory=path.join(root,currentdir);
  const index=JSON.parse(await readPrivateSnapshotIndex(path.join(directory,'index.json')));
  if(index?.schemaVersion!==1||index.generation!==Number(currentdir.slice(16))||index.encoding!=='gzip-xor-a7-v1')throw Error('Invalid replay recovery index');
  return async logical=>{
    const rec=index.files?.[logical];
    if(!rec)return null;
    if(!HASH.test(rec.sha256||'')||rec.path!==rec.sha256+'.bin'||!validCount(rec.decodedBytes,MAX_DECODED_BYTES))
      throw Error('Invalid published replay recovery record');
    const file=path.join(directory,rec.path);
    if(!await hasFile(file))throw Error('Published replay recovery payload missing');
    const bytes=await fs.readFile(file);
    if(digest(bytes)!==rec.sha256)throw Error('Published replay recovery payload changed');
    const decoded=Buffer.from(await decodeSnapshot(bytes));
    if(decoded.length!==rec.decodedBytes)throw Error('Published replay recovery size changed');
    return {decoded,data:JSON.parse(decoded)};
  };
}

export async function deferMissingNormalReplayRows({root,directory}={}){
  const manifestPath=path.join(directory,'manifest.json'),manifest=await readJson(manifestPath);
  const tracks=Object.entries(manifest.tracks||{});
  if(tracks.length>1024)throw Error('Invalid replay recovery track count');
  const report={restored:0,deferred:0,boards:0,backendReads:0,backendWrites:0};
  const writes=new Map();
  let published=null,total=0;
  for(const [trackId,record] of tracks){
    if(!record?.path)continue;
    if(!HASH.test(trackId)||record.path!=='tracks/'+trackId+'.json')throw Error('Invalid replay recovery track path');
    const file=path.join(directory,record.path),board=await readJson(file);
    if(board.trackId!==trackId||!Array.isArray(board.entries)||board.entries.length>10000||(total+=board.entries.length)>100000)
      throw Error('Invalid replay recovery board');
    const missing=[];
    for(const row of board.entries){
      if(!HASH.test(row.accountId||'')||row.trackId!==trackId||!validCount(row.uploadId,Number.MAX_SAFE_INTEGER)||
          !validCount(row.timeMs,Number.MAX_SAFE_INTEGER)||!validCount(row.frames??row.raceTimeFrames,4000000)||!HASH.test(row.replayHash||''))
        throw Error('Invalid replay recovery run binding');
      const canonical='canonical/'+trackId+'/'+row.accountId+'.json',recording='recordings/'+row.uploadId+'.json';
      const canonicalPresent=await hasFile(path.join(directory,canonical)),recordingPresent=await hasFile(path.join(directory,recording));
      if(canonicalPresent&&recordingPresent)continue;
      published??=await openPublishedFiles(root);
      const old=await published(canonical);
      if(sameRun(old?.data,row)){
        const media=await published(recording);
        if(!media||media.data.accountId!==row.accountId||media.data.trackId!==trackId||
            media.data.frames!==(row.frames??row.raceTimeFrames)||media.data.replayHash!==row.replayHash||
            typeof media.data.recording!=='string'||digest(media.data.recording)!==row.replayHash)
          throw Error('Exact previously published replay is unavailable');
        if(!canonicalPresent)writes.set(path.join(directory,canonical),old.decoded);
        if(!recordingPresent)writes.set(path.join(directory,recording),media.decoded);
        report.restored++;
      }else{
        missing.push(row);
      }
    }
    if(!missing.length)continue;
    if(board.complete!==true||board.sourceComplete===false||board.totalEntriesExact===false||board.ranksExact===false||
        board.totalEntries!==board.entries.length)throw Error('Cannot defer recording rows on an incomplete board');
    const remove=new Set(missing),entries=rankTrustedTrackEntries(board.entries.filter(row=>!remove.has(row)),trackId);
    const next={...board,entries,totalEntries:entries.length};
    for(const key of ['count','publishedEntries'])if(Object.hasOwn(next,key))next[key]=entries.length;
    delete next.pagination;delete next.paginatedSource;
    const bytes=Buffer.from(JSON.stringify(next)+'\n');
    writes.set(file,bytes);
    const current={...record,sha256:digest(bytes)};
    delete current.nativeLedgerOverlay;
    delete current.fullCanonicalCapture;
    manifest.tracks[trackId]=current;
    report.boards++;report.deferred+=missing.length;
  }
  if(report.deferred){
    manifest.deferredMissingNormalReplays={rows:report.deferred,boards:report.boards};
    writes.set(manifestPath,Buffer.from(JSON.stringify(manifest,null,2)+'\n'));
  }
  for(const [file,bytes] of writes){
    await fs.mkdir(path.dirname(file),{recursive:true});
    const pending=file+'.replay-repair-'+process.pid+'.tmp';
    await fs.writeFile(pending,bytes,{flag:'wx'});
    await fs.rename(pending,file);
  }
  return report;
}
