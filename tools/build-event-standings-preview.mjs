import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {sourceBoundEventPlacement} from '../events/client.mjs';
const ROOT=fileURLToPath(new URL('../',import.meta.url));
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const demand=(value,message)=>{if(!value)throw Error(message);};
export function selectEventStandingsPreview(boards,{directory,omittedCount=0,maxBytes=1048576}={}){
  const selected=[],counts=new Map();
  const sorted=[...boards].sort((a,b)=>b.period.endsAt-a.period.endsAt||a.period.id.localeCompare(b.period.id));
  const total=boards.length+omittedCount;
  const artifact=rows=>({schemaVersion:1,directory,omittedCount:total-rows.length,boards:rows});
  demand(Buffer.byteLength(JSON.stringify(artifact([]))+'\n')<=maxBytes,'Preview budget too small');
  for(const board of sorted){
    const kind=board.period.kind,count=counts.get(kind)||0;
    if(count>=4)continue;
    counts.set(kind,count+1);
    const next=[...selected,board];
    if(Buffer.byteLength(JSON.stringify(artifact(next))+'\n')<=maxBytes)selected.push(board);
  }
  return artifact(selected);
}
export async function buildEventStandingsPreview(root=ROOT){
  const pointer=await fs.readFile(path.join(root,'snapshot-current.json'));
  const directory=JSON.parse(pointer).currentdir;
  demand(/^public-snapshots[1-9][0-9]*$/.test(directory||''),'Invalid directory');
  const indexBytes=await fs.readFile(path.join(root,directory,'index.json'));
  demand(indexBytes.length<=64*1024*1024,'Index oversized');
  const index=JSON.parse(indexBytes);
  demand(index.schemaVersion===1&&index.generation===Number(directory.slice(16))&&index.encoding==='gzip-xor-a7-v1'&&index.files&&typeof index.files==='object'&&!Array.isArray(index.files),'Invalid index');
  const boards=[],skipped=[];
  for(const [logical,descriptor]of Object.entries(index.files||{}).sort(([a],[b])=>a.localeCompare(b))){
    if(!/^events\/(?:d_[0-9]{8}|w_[0-9]{8}|kodub_[0-9]+)\.json$/.test(logical))continue;
    demand(/^[a-f0-9]{64}\.bin$/.test(descriptor.path||'')&&/^[a-f0-9]{64}$/.test(descriptor.sha256||'')&&descriptor.path===descriptor.sha256+'.bin'&&Number.isSafeInteger(descriptor.decodedBytes)&&descriptor.decodedBytes>0&&descriptor.decodedBytes<=2*1024*1024,'Invalid event descriptor');
    const encoded=await fs.readFile(path.join(root,directory,descriptor.path));
    demand(encoded.length<=2*1024*1024&&hash(encoded)===descriptor.sha256,'Event digest mismatch');
    const bytes=gunzipSync(Buffer.from(encoded).map(byte=>byte^0xa7),{maxOutputLength:descriptor.decodedBytes});
    demand(bytes.length===descriptor.decodedBytes,'Event decoded size mismatch');
    const board=JSON.parse(bytes),period=board.period;
    if(logical!==`events/${period?.id}.json`||!['daily','weekly','kodub'].includes(period?.kind)||!Array.isArray(board.entries)||board.entries.length>10000||board.complete!==true||board.sourceComplete===false||board.ranksExact===false||board.totalEntriesExact===false||board.publicationPending===true||board.pagination?.hasMore===true||board.totalEntries!==board.entries.length||!Number.isSafeInteger(board.updatedAt)||board.updatedAt<0||
      !/^[a-f0-9]{64}$/.test(period?.trackId||'')||!Number.isSafeInteger(period.startsAt)||!Number.isSafeInteger(period.endsAt)||period.endsAt<=period.startsAt||
      board.entries.length&&!sourceBoundEventPlacement(board,period,board.entries[0].accountId,board.entries[0].timeMs)){
      skipped.push(logical);continue;
    }
    const {id,kind,trackId,startsAt,endsAt}=period;
    boards.push({period:{id,kind,trackId,startsAt,endsAt},updatedAt:board.updatedAt,fieldSize:board.entries.length,rows:board.entries.map(row=>[row.accountId,row.timeMs,row.rank])});
  }
  demand((await fs.readFile(path.join(root,'snapshot-current.json'))).equals(pointer)&&(await fs.readFile(path.join(root,directory,'index.json'))).equals(indexBytes),'Snapshot changed during build');
  const artifact=selectEventStandingsPreview(boards,{directory,omittedCount:skipped.length});const bytes=JSON.stringify(artifact)+'\n';
  const output=path.join(root,'events/standings-preview.json');let existing=null;
  try{existing=await fs.readFile(output,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
  if(existing!==bytes)await fs.writeFile(output,bytes);
  return {directory,omittedCount:artifact.omittedCount,boards:artifact.boards.length,rows:artifact.boards.reduce((n,b)=>n+b.rows.length,0),bytes:Buffer.byteLength(bytes),skipped};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log(JSON.stringify(await buildEventStandingsPreview()));
