import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ledgerBinding,ledgerKey} from './native-verification-ledger.mjs';

const RAW='verification-completed.json', ENVELOPE='verification-completed.receipt.json';
const MAX_BYTES=16*1024*1024, MAX_DECISIONS=100000, GUARD_BYTES=64*1024;
const COUNT_FIELDS=['known','verified','held','excluded','mismatch','unavailable','unprocessed','reusedPhysics','nativeDispatched','nativeBatches'];
const STATUSES=['verified','held','excluded','mismatch','unavailable','unprocessed'];
const HASH=/^[a-f0-9]{64}$/;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const demand=(ok,message)=>{if(!ok){const e=Error('Local native verification completion: '+message);e.code='LOCAL_NATIVE_COMPLETION_INVALID';throw e;}};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const nonnegative=v=>Number.isSafeInteger(v)&&v>=0;
const sameFile=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
const within=(target,root)=>{const rel=path.relative(root,target);return rel===''||!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep);};
const safeCodes=new Set(['EACCES','EPERM','EEXIST','ENOENT','ENOSPC','EIO','EROFS','EMFILE','ENFILE','LOCAL_NATIVE_COMPLETION_INVALID']);
function sanitized(error){const e=Error('Local native verification completion failed; preserve owned evidence.');e.code=safeCodes.has(error?.code)?error.code:'LOCAL_NATIVE_COMPLETION_FAILED';return e;}

async function canonical(file){try{return await fs.realpath(file);}catch(e){if(e.code!=='ENOENT')throw e;const parent=path.dirname(file);if(parent===file)throw e;return path.join(await canonical(parent),path.basename(file));}}
async function targetDirectory(root,directory){
  const stat=await fs.lstat(directory);demand(stat.isDirectory()&&!stat.isSymbolicLink(),'unsafe output directory');
  const target=await fs.realpath(directory),workspace=await fs.realpath(root),staging=await canonical(path.join(workspace,'local-reports/snapshot-staging'));
  demand(!within(target,staging),'outputs must be outside staging');return {target,stat};
}
async function guard(target,owner,sourceCommit){
  const file=path.join(target,'running.json'),stat=await fs.lstat(file);
  demand(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=GUARD_BYTES,'unsafe running guard');
  const handle=await fs.open(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try{
    const opened=await handle.stat();demand(opened.isFile()&&sameFile(stat,opened)&&opened.size<=GUARD_BYTES,'running guard replaced');
    const buffer=Buffer.alloc(GUARD_BYTES+1);let length=0;
    while(length<buffer.length){const {bytesRead}=await handle.read(buffer,length,buffer.length-length,length);if(!bytesRead)break;length+=bytesRead;}
    demand(length<=GUARD_BYTES,'oversized running guard');const bytes=buffer.subarray(0,length);
    const value=JSON.parse(bytes);demand(value.owner===owner&&value.testedCommit===sourceCommit,'running guard owner/source mismatch');
    const after=await fs.lstat(file);demand(!after.isSymbolicLink()&&sameFile(opened,after),'running guard replaced');
    return {stat:opened,sha256:sha(bytes)};
  }finally{await handle.close();}
}
async function assertOwned(file,handle){const s=await fs.lstat(file),h=await handle.stat();demand(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&sameFile(s,h),'owned output replaced');}
async function writeAll(handle,bytes){
  let offset=0;
  while(offset<bytes.length){const result=await handle.write(bytes,offset,bytes.length-offset,offset);demand(result.bytesWritten>0&&result.bytesWritten<=bytes.length-offset,'write made no progress');offset+=result.bytesWritten;}
  await handle.truncate(bytes.length);await handle.sync();
}
const json=value=>Buffer.from(JSON.stringify(value)+'\n');
function binding(value,sourceCommit){
  demand(object(value)&&value.sourceCommit===sourceCommit&&HASH.test(value.captureSha256||''),'source binding mismatch');
  return {sourceCommit,captureSha256:value.captureSha256};
}
function whitelist(raw,sourceCommit,maxJobs){
  demand(object(raw)&&raw.schemaVersion===1&&raw.kind==='completed-in-process-native-verification'&&raw.authority===false,'invalid raw receipt kind/authority');
  const sourceBinding=binding(raw.sourceBinding,sourceCommit);
  demand(HASH.test(raw.ledgerManifestHash||''),'invalid ledger manifest hash');
  demand(object(raw.counts)&&Object.keys(raw.counts).length===COUNT_FIELDS.length&&COUNT_FIELDS.every(k=>Object.hasOwn(raw.counts,k)&&nonnegative(raw.counts[k])),'invalid ten-field counts');
  const counts=Object.fromEntries(COUNT_FIELDS.map(k=>[k,raw.counts[k]]));
  demand(counts.known<=MAX_DECISIONS&&STATUSES.reduce((n,k)=>n+counts[k],0)===counts.known,'decision count sum mismatch');
  demand(counts.nativeDispatched<=maxJobs&&counts.nativeDispatched<=counts.known&&counts.reusedPhysics<=counts.known&&counts.nativeBatches<=counts.nativeDispatched,'native dispatch budget exceeded');
  demand(typeof raw.verificationComplete==='boolean'&&raw.verificationComplete===(counts.unavailable===0&&counts.unprocessed===0),'dishonest verification completeness');
  demand(Array.isArray(raw.decisions)&&raw.decisions.length===counts.known&&raw.decisions.length<=MAX_DECISIONS,'decision coverage mismatch');
  const seen=new Set(),totals=Object.fromEntries(STATUSES.map(k=>[k,0]));
  const decisions=raw.decisions.map(row=>{
    demand(object(row)&&HASH.test(row.key||'')&&!seen.has(row.key)&&STATUSES.includes(row.status),'invalid or duplicate decision');
    const cleanBinding=ledgerBinding(row.binding);demand(ledgerKey(cleanBinding)===row.key,'decision key/binding mismatch');
    demand(typeof row.reason==='string'&&row.reason.length<=128&&!/[\u0000-\u001f]/.test(row.reason),'invalid decision reason');
    seen.add(row.key);totals[row.status]++;return {key:row.key,binding:cleanBinding,status:row.status,reason:row.reason};
  });
  demand(STATUSES.every(k=>totals[k]===counts[k]),'decision status totals mismatch');
  const result={schemaVersion:1,authority:false,kind:raw.kind,sourceBinding,ledgerManifestHash:raw.ledgerManifestHash,counts,decisions,verificationComplete:raw.verificationComplete};
  for(const key of ['previousLedgerManifestHash','engineDigest','verifierFingerprint','policySha256'])if(raw[key]!==undefined){demand(HASH.test(raw[key]),'invalid receipt digest');result[key]=raw[key];}
  // Recovery pointer only: never copy arbitrary checkpoint contents or promote it.
  if(raw.privateProofCheckpoint===null)result.privateProofCheckpoint=null;
  else if(raw.privateProofCheckpoint!==undefined){
    const v=raw.privateProofCheckpoint;
    demand(object(v)&&v.schemaVersion===1&&v.kind==='private-native-proof-checkpoint'&&v.authority===false&&path.isAbsolute(v.directory||'')&&v.directory.length<=4096&&!/[\u0000-\u001f]/.test(v.directory)&&v.ledgerManifestHash===result.ledgerManifestHash,'invalid private proof checkpoint pointer');
    result.privateProofCheckpoint={directory:v.directory,schemaVersion:1,kind:v.kind,authority:false,sourceBinding:binding(v.sourceBinding,sourceCommit),ledgerManifestHash:v.ledgerManifestHash};
    demand(result.privateProofCheckpoint.sourceBinding.captureSha256===sourceBinding.captureSha256,'checkpoint capture mismatch');
    for(const k of ['previousLedgerManifestHash','evidenceSha256'])if(v[k]!==undefined){demand(HASH.test(v[k]),'invalid checkpoint digest');result.privateProofCheckpoint[k]=v[k];}
    if(v.evidenceFile!==undefined){demand(v.evidenceFile==='verification.json','invalid checkpoint evidence file');result.privateProofCheckpoint.evidenceFile=v.evidenceFile;}
  }
  // Scheduling/coverage/compilation diagnostics are not needed for this durable
  // boundary. Only the explicit identity/count/decision/digest schema is stored.
  return result;
}

export function createLocalNativeVerificationCompletion({root,directory,owner,sourceCommit,maxJobs=10000}={}){
  demand(path.isAbsolute(root||'')&&path.isAbsolute(directory||'')&&/^[a-f0-9-]{36}$/.test(owner||'')&&/^[a-f0-9]{40}$/.test(sourceCommit||'')&&Number.isSafeInteger(maxJobs)&&maxJobs>0&&maxJobs<=10000,'invalid completion context');
  let used=false;
  return async rawNativeReceipt=>{
    demand(!used,'completion callback already consumed');used=true;
    let envelopeHandle,rawHandle,rawFile,envelopeFile,target,originalGuard,dirStat,metadata={schemaVersion:1,kind:'private-native-verification-completion',authority:false,owner,testedCommit:sourceCommit,rawNativeReceipt:RAW};
    const recheck=async()=>{
      const directoryNow=await targetDirectory(root,directory);demand(directoryNow.target===target&&sameFile(dirStat,directoryNow.stat),'output directory changed');
      const current=await guard(target,owner,sourceCommit);demand(sameFile(originalGuard.stat,current.stat)&&originalGuard.sha256===current.sha256,'running guard changed');
    };
    try{
      ({target,stat:dirStat}=await targetDirectory(root,directory));originalGuard=await guard(target,owner,sourceCommit);
      envelopeFile=path.join(target,ENVELOPE);rawFile=path.join(target,RAW);
      // Exclusive envelope admission comes first, including for invalid input.
      envelopeHandle=await fs.open(envelopeFile,'wx',0o600);
      await writeAll(envelopeHandle,json({...metadata,status:'pending'}));
      const receipt=whitelist(rawNativeReceipt,sourceCommit,maxJobs),bytes=json(receipt);
      demand(bytes.length<=MAX_BYTES,'raw receipt exceeds 16 MiB');
      metadata={...metadata,sourceBinding:receipt.sourceBinding,ledgerManifestHash:receipt.ledgerManifestHash,sha256:sha(bytes)};
      await recheck();await assertOwned(envelopeFile,envelopeHandle);
      rawHandle=await fs.open(rawFile,'wx',0o600);
      await writeAll(rawHandle,bytes);await assertOwned(rawFile,rawHandle);
      await recheck();await assertOwned(envelopeFile,envelopeHandle);
      await writeAll(envelopeHandle,json({...metadata,status:'complete'}));
      await recheck();await assertOwned(envelopeFile,envelopeHandle);
      await assertOwned(rawFile,rawHandle);await rawHandle.close();rawHandle=null;
      await envelopeHandle.close();envelopeHandle=null;
      return {...metadata,status:'complete'};
    }catch(error){
      const safe=sanitized(error);
      if(envelopeHandle){try{await assertOwned(envelopeFile,envelopeHandle);await writeAll(envelopeHandle,json({...metadata,status:'failed',failure:{code:safe.code}}));}catch{console.error('Local native verification completion failure receipt could not be persisted.');}}
      throw safe;
    }finally{
      for(const handle of [rawHandle,envelopeHandle])if(handle)await handle.close().catch(()=>{console.error('Local native verification completion handle close failed.');});
    }
  };
}
