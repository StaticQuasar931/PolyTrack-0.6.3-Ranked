// Opaque, read-only capability for one complete frozen canonical capture.
import fs from 'node:fs/promises';import path from 'node:path';import{createHash}from'node:crypto';
const sources=new WeakSet(),HASH=/^[a-f0-9]{64}$/;
const demand=(ok,message)=>{if(!ok)throw Error('Full canonical source: '+message);};
const sha=b=>createHash('sha256').update(b).digest('hex');
export const isFullCanonicalTrackSource=value=>sources.has(value);
export async function openFullCanonicalTrackSource({directory,report}={}){
 demand(path.isAbsolute(directory||''),'absolute directory required');
 const initial=await fs.lstat(directory);demand(initial.isDirectory()&&!initial.isSymbolicLink(),'unsafe source directory');
 const root=await fs.realpath(directory);const trackDirectory=await fs.lstat(path.join(root,'tracks'));demand(trackDirectory.isDirectory()&&!trackDirectory.isSymbolicLink(),'unsafe track directory');
 const read=async name=>{const p=path.join(root,name),s=await fs.lstat(p);demand(s.isFile()&&!s.isSymbolicLink()&&s.size<=8*1024*1024,'unsafe source file');return fs.readFile(p);};
 const saved=JSON.parse(await read('full-canonical-capture.json')),manifest=JSON.parse(await read('manifest.json'));
 demand(JSON.stringify(saved)===JSON.stringify(report),'report changed');
 const point=Date.parse(report?.fullScanReadPoint),f=manifest.fullCanonicalCapture;
 demand(report.complete===true&&report.imported===true&&report.fullScan===true&&report.scanInconsistency===false&&report.missingPriorCount===0&&Array.isArray(report.missingBoards)&&report.missingBoards.length===0&&Number.isSafeInteger(report.rows)&&report.rows>=0&&report.rows<=30000&&Number.isFinite(point),'incomplete capture');
 demand(f?.complete===true&&f.imported===true&&f.scanInconsistency===false&&f.fullScanReadPoint===report.fullScanReadPoint&&f.sourceRows===report.rows,'manifest/capture mismatch');
 const records=new Map();let rows=0;
 function validate(id,bytes){
  const r=records.get(id);demand(r&&Buffer.byteLength(bytes)===r.bytes&&sha(bytes)===r.sha256,'board bytes changed');
  const board=JSON.parse(bytes);demand(board.trackId===id&&board.complete===true&&board.sourceComplete===true&&board.totalEntriesExact===true&&board.ranksExact===true&&Array.isArray(board.entries)&&board.entries.length===r.count&&board.totalEntries===r.count&&Number.isSafeInteger(board.updatedAt)&&board.updatedAt<=point,'board coverage changed');
  const accounts=new Set();for(const row of board.entries){demand(HASH.test(row.accountId||'')&&row.trackId===id&&!accounts.has(row.accountId),'board identity changed');accounts.add(row.accountId);}
  return board;
 }
 for(const[id,r]of Object.entries(manifest.tracks||{})){
  if(!r.path)continue;
  demand(HASH.test(id)&&r.path==='tracks/'+id+'.json'&&HASH.test(r.sha256||'')&&Number.isSafeInteger(r.bytes)&&r.bytes>=1&&Number.isSafeInteger(r.count)&&r.count>=0&&r.count<=10000&&r.fullCanonicalCapture?.complete===true&&r.fullCanonicalCapture.fullScanReadPoint===report.fullScanReadPoint&&r.fullCanonicalCapture.sourceRows===r.count&&r.fullCanonicalCapture.retainedRows===0,'invalid track descriptor');
  records.set(id,structuredClone(r));demand(records.size<=1024,'track bound exceeded');validate(id,await read(r.path));rows+=r.count;
 }
 demand(rows===report.rows,'source row total changed');
 const value=Object.freeze({has:id=>records.has(id),validate,readPoint:report.fullScanReadPoint,checkedAt:point,rows,tracks:records.size});sources.add(value);return value;
}
