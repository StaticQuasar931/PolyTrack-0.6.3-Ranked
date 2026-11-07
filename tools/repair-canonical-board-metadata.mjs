import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
import {canonicalBoardMetadata} from './full-canonical-capture.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const demand=(ok,message)=>{if(!ok)throw Error('Canonical metadata repair: '+message)};
export async function repairCapturedBoardMetadata({directory,expectedRepairs}={}){
 demand(path.isAbsolute(directory||'')&&Number.isSafeInteger(expectedRepairs)&&expectedRepairs>=0&&expectedRepairs<=512,'explicit repair boundary required');
 const read=async name=>JSON.parse(await fs.readFile(path.join(directory,name),'utf8'));
 const manifest=await read('manifest.json'),capture=await read('full-canonical-capture.json'),changes=[];
 demand(capture.complete===true&&capture.imported===true&&capture.documentWrites===0,'complete read-only canonical source required');
 for(const[id,record]of Object.entries(manifest.tracks)){
  if(!record.path)continue;demand(/^[a-f0-9]{64}$/.test(id)&&record.path===`tracks/${id}.json`,'invalid board path');
  const bytes=await fs.readFile(path.join(directory,record.path)),board=JSON.parse(bytes);
  if(board.algorithmVersion!==undefined&&board.schemaVersion!==undefined&&board.revision!==undefined&&board.sourceRevision!==undefined)continue;
  demand(['algorithmVersion','schemaVersion','revision','sourceRevision'].every(key=>board[key]===undefined),'partial or unsupported metadata');
  demand(record.sha256===sha(bytes)&&board.trackId===id&&Array.isArray(board.entries)&&record.fullCanonicalCapture?.complete===true&&record.fullCanonicalCapture.source==='firestore-full-canonical'&&record.fullCanonicalCapture.fullScanReadPoint===capture.fullScanReadPoint&&board.updatedAt===Date.parse(capture.fullScanReadPoint),'unbound canonical board');
  const repaired=Buffer.from(JSON.stringify(canonicalBoardMetadata(board))+'\n');
  changes.push({path:record.path,trackId:id,beforeSha256:sha(bytes),afterSha256:sha(repaired),bytes:repaired,rows:board.entries.length});
 }
 demand(changes.length===expectedRepairs,'unexpected repair count');
 for(const item of changes){await fs.writeFile(path.join(directory,item.path),item.bytes);Object.assign(manifest.tracks[item.trackId],{sha256:item.afterSha256,bytes:item.bytes.length,revision:1});}
 if(changes.length)await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(manifest)+'\n');
 return {kind:'canonical-scoring-metadata-only',boards:changes.length,rowValuesChanged:0,verificationChanges:0,backendReads:0,backendWrites:0,changes:changes.map(({bytes,...item})=>item)};
}
