import {readPrivateSnapshotIndex} from './private-snapshot-index.mjs';
import {decodeSnapshot,MAX_DECODED_BYTES} from './snapshot-package.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {applyLedgerToBoard,ledgerBinding,ledgerKey,nativePolicyFingerprint} from './native-verification-ledger.mjs';
const pins=new WeakMap(),published=new Map(),hash=value=>createHash('sha256').update(value).digest('hex');
const fields=['runVerified','verified','verifiedState','verificationStatus','integrityVerified','nativeLedgerKey','nativeLedgerManifestHash','verifiedAt','playbackPending','needsReview','reviewHold','excluded','unscored','status','validationState','reason'];
// Called only by the decoder after checking the published index, payload hashes and sizes.
export function rememberPublishedHydration(root,files,generation){
 const boards=new Map();for(const file of files)if(/^tracks\/[a-f0-9]{64}\.json$/.test(file.logicalPath))boards.set(file.logicalPath,hash(file.decoded));
 published.set(path.resolve(root),{boards,generation});
}
async function publishedBoards(root){
 if(!root)return null;
 let pointer;try{pointer=JSON.parse(await fs.readFile(path.join(root,'snapshot-current.json'),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}
 const generation=pointer.currentdir;if(!/^public-snapshots[1-9][0-9]*$/.test(generation||''))throw Error('Invalid published cache source');
 const cached=published.get(path.resolve(root));if(cached?.generation===generation)return cached.boards;
 const directory=path.join(root,generation),index=JSON.parse(await readPrivateSnapshotIndex(path.join(directory,'index.json')));
 if(index.schemaVersion!==1||index.encoding!=='gzip-xor-a7-v1'||index.generation!==Number(generation.slice(16)))throw Error('Invalid published cache index');
 const files=[];for(const [logicalPath,item]of Object.entries(index.files||{})){
  if(!/^tracks\/[a-f0-9]{64}\.json$/.test(logicalPath))continue;
  if(files.length>=512||!/^[a-f0-9]{64}$/.test(item.sha256||'')||item.path!==item.sha256+'.bin'||!Number.isSafeInteger(item.decodedBytes)||item.decodedBytes<0||item.decodedBytes>MAX_DECODED_BYTES)throw Error('Invalid published board pin');
  const encoded=await fs.readFile(path.join(directory,item.path));if(hash(encoded)!==item.sha256)throw Error('Published board hash mismatch');
  const decoded=Buffer.from(await decodeSnapshot(encoded));if(decoded.length!==item.decodedBytes)throw Error('Published board size mismatch');
  files.push({logicalPath,decoded});
 }
 rememberPublishedHydration(root,files,generation);return published.get(path.resolve(root)).boards;
}
// This live capability retains existing derived bytes only. It grants no new proof or freshness.
export async function pinRetainedNativeBoards({context,directory,root}){
 const manifest=context.sourceManifest,ledger=context.ledger,trusted=await publishedBoards(root);
 if(!trusted)return 0;
 if(manifest?.nativeVerificationLedger?.manifestHash!==ledger?.manifestHash)return 0;
 const sources=new Map(context.canonicalRows.map(row=>[ledgerKey(ledgerBinding(row,'normal')),row])),boards=new Map();
 for(const [id,record]of Object.entries(manifest.tracks||{})){
  if(!/^[a-f0-9]{64}$/.test(id)||record?.path!=='tracks/'+id+'.json')continue;
  const bytes=await fs.readFile(path.join(directory,record.path));if(hash(bytes)!==record.sha256||trusted.get(record.path)!==hash(bytes))continue;
  const board=JSON.parse(bytes),rows=board.entries?.filter(row=>row.nativeLedgerKey)||[];if(!rows.length)continue;
  try{
   const canonical=[],recordings=[];
   for(const row of rows){
    const source=sources.get(row.nativeLedgerKey);if(!source||ledgerKey(ledgerBinding({...row,trackId:id,frames:row.frames??row.raceTimeFrames??source.frames},'normal'))!==row.nativeLedgerKey)throw Error('binding');
    const media=JSON.parse(await fs.readFile(path.join(directory,'recordings',source.uploadId+'.json'),'utf8'));
    canonical.push(source);recordings.push({...source,replay:media.recording??media.replay});
   }
   const checked=applyLedgerToBoard({board:{...board,entries:rows},ledger,policy:context.policy,canonicalRows:canonical,recordings,lane:'normal'});
   if(checked.report.skipped||checked.report.verified+checked.report.held+checked.report.excluded!==rows.length||
      checked.board.entries.some((row,i)=>fields.some(field=>row[field]!==rows[i][field])))continue;
   boards.set(id,hash(bytes));
  }catch{/* Missing, incompatible or differently bound evidence cannot retain a native derivative. */}
 }
 pins.set(context,{boards,ledger,manifestHash:ledger.manifestHash,policy:nativePolicyFingerprint(context.policy)});return boards.size;
}
export function retainedNativeBoardMatches({context,authority,board,bytes}){
 const pin=context&&pins.get(context);
 return Boolean(pin&&context.ledger===pin.ledger&&authority?.manifestHash===pin.manifestHash&&
  context.ledger.manifestHash===pin.manifestHash&&nativePolicyFingerprint(context.policy)===pin.policy&&
  pin.boards.get(board.trackId)===hash(bytes));
}
