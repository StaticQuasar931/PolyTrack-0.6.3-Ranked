import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {decodeSnapshot,MAX_DECODED_BYTES} from './snapshot-package.mjs';
import {readPrivateSnapshotIndex} from './private-snapshot-index.mjs';

const ID=/^[a-f0-9]{64}$/;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const trackPath=/^track-manifests\/([a-f0-9]{64})\.json$/;
const racer=row=>row.userId??row.accountId;
const result=row=>JSON.stringify([row.accountId,row.uploadId,row.timeMs,row.replayHash]);
const trackSet=index=>new Set(Object.keys(index.files).map(name=>trackPath.exec(name)?.[1]).filter(Boolean));

function additions(before,after,key,validate) {
  const identitySet=rows=>{
    const ids=new Set();
    for(const row of rows){
      if(!validate(row))throw Error('Invalid snapshot notice row');
      const id=key(row);
      if(ids.has(id))throw Error('Duplicate snapshot notice row');
      ids.add(id);
    }
    return ids;
  };
  const previous=identitySet(before);
  return [...identitySet(after)].filter(key=>!previous.has(key)).length;
}

export function countNewSnapshotRacers(before,after){
  return additions(before,after,racer,row=>ID.test(racer(row)||''));
}
export function countNewSnapshotResults(before,after){
  return additions(before,after,result,row=>ID.test(row.accountId||'')&&Number.isSafeInteger(row.uploadId)&&row.uploadId>0&&
    Number.isSafeInteger(row.timeMs)&&row.timeMs>0&&ID.test(row.replayHash||''));
}

async function entries(pkg,track){
  const manifest=await pkg.read(track?'track-manifests/'+track+'.json':'overall-manifest.json');
  if(!Number.isSafeInteger(manifest?.pageCount)||manifest.pageCount<0||manifest.pageCount>1024||
      !Number.isSafeInteger(manifest.publishedEntries)||manifest.publishedEntries>100000)throw Error('Invalid snapshot notice manifest');
  const rows=[];
  for(let page=1;page<=manifest.pageCount;page++){
    const data=await pkg.read((track?'track-pages/'+track+'/':'overall-pages/')+page+'.json');
    if(data?.pageNumber!==page||!Array.isArray(data.entries)||data.entries.length>100||track&&data.trackId!==track)
      throw Error('Invalid snapshot notice page');
    rows.push(...data.entries);
  }
  if(rows.length!==manifest.publishedEntries)throw Error('Snapshot notice page count differs');
  return rows;
}

// Compare only public, published cohorts. Cosmetic and ranking changes do not
// make a replay new, and losing a row does not cancel an unrelated addition.
export async function compareSnapshotAdditions(previous,current){
  const baseGeneration=previous.index.generation,generation=current.index.generation;
  if(!Number.isSafeInteger(baseGeneration)||baseGeneration<1||!Number.isSafeInteger(generation)||generation<=baseGeneration)
    throw Error('Invalid snapshot notice generations');
  const oldTracks=trackSet(previous.index), newTracks=trackSet(current.index);
  if(oldTracks.size>1024||newTracks.size>1024)throw Error('Oversized snapshot notice track catalog');
  const [oldRacers,newRacers]=await Promise.all([entries(previous),entries(current)]);
  const out={generation,baseGeneration,racers:countNewSnapshotRacers(oldRacers,newRacers),boards:0,results:0};
  for(const track of newTracks){
    if(!oldTracks.has(track)){out.boards++;out.results+=countNewSnapshotResults([],await entries(current,track));continue;}
    const monolith='tracks/'+track+'.json';
    if(current.index.files[monolith]?.sha256&&current.index.files[monolith].sha256===previous.index.files[monolith]?.sha256)continue;
    const [oldRuns,newRuns]=await Promise.all([entries(previous,track),entries(current,track)]);
    out.results+=countNewSnapshotResults(oldRuns,newRuns);
  }
  return out;
}

export function snapshotNoticePackage(index,readBytes){
  if(index?.schemaVersion!==1||index.encoding!=='gzip-xor-a7-v1'||!index.files)throw Error('Invalid snapshot notice index');
  return {index,read:async logical=>{
    const entry=index.files[logical];
    if(!ID.test(entry?.sha256||'')||entry.path!==entry.sha256+'.bin'||
        !Number.isSafeInteger(entry.decodedBytes)||entry.decodedBytes<2||entry.decodedBytes>MAX_DECODED_BYTES)
      throw Error('Invalid snapshot notice payload');
    const bytes=await readBytes(entry.path);
    if(sha(bytes)!==entry.sha256)throw Error('Snapshot notice hash mismatch');
    const decoded=Buffer.from(await decodeSnapshot(bytes));
    if(decoded.length!==entry.decodedBytes)throw Error('Invalid snapshot notice payload size');
    return JSON.parse(decoded);
  }};
}

export async function comparePublishedSnapshotAdditions(root,previous,current){
  const open=async name=>{
    if(!/^public-snapshots[1-9]\d*$/.test(name||''))throw Error('Invalid snapshot notice directory');
    const directory=path.join(root,name),index=JSON.parse(await readPrivateSnapshotIndex(path.join(directory,'index.json')));
    if(index.generation!==Number(name.slice(16)))throw Error('Invalid snapshot notice generation');
    return snapshotNoticePackage(index,file=>fs.readFile(path.join(directory,file)));
  };
  const [before,after]=await Promise.all([open(previous),open(current)]);
  return compareSnapshotAdditions(before,after);
}
