import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {encryptCaptureRecovery,validateRecoveryRecipient} from './capture-recovery.mjs';

const names=Object.freeze({'pre-native':'capture','failure-state':'failure','native-proofs':'proofs'});
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const demand=(ok,message)=>{if(!ok)throw Error('Local capture checkpoint: '+message);};
const basePath='local-reports/snapshot-staging-base.json';
const safeCodes=new Set(['EACCES','EPERM','EEXIST','ENOENT','ENOSPC','EIO','EROFS','EMFILE','ENFILE']);
const failureCode=error=>safeCodes.has(error?.code)?error.code:'CHECKPOINT_FAILED';

async function privateDirectory(directory){
  demand(path.isAbsolute(directory||''),'absolute private directory required');
  const stat=await fs.lstat(directory);
  demand(stat.isDirectory()&&!stat.isSymbolicLink(),'unsafe private directory');
  return fs.realpath(directory);
}
// Resolve existing ancestors too: admission may precede staging creation.
async function canonicalPath(file){
  try{return await fs.realpath(file);}catch(error){
    if(error.code!=='ENOENT')throw error;
    const parent=path.dirname(file);if(parent===file)throw error;
    return path.join(await canonicalPath(parent),path.basename(file));
  }
}
function within(directory,root){
  const relative=path.relative(root,directory);
  return relative===''||(!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep));
}
async function absent(file){
  try{await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
  const error=Error('Local capture checkpoint: reserved output already exists');error.code='EEXIST';throw error;
}
async function stagingBase(root){
  const file=path.join(root,basePath);
  let stat;
  try{stat=await fs.lstat(file);}catch(error){if(error.code==='ENOENT')return {path:basePath,present:false};throw error;}
  demand(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=2048,'unsafe staging base');
  const bytes=await fs.readFile(file);demand(bytes.length<=2048,'oversized staging base');
  const value=JSON.parse(bytes);
  demand(value?.schemaVersion===1&&Number.isSafeInteger(value.generation)&&value.generation>0,'invalid staging base');
  return {path:basePath,present:true,schemaVersion:1,generation:value.generation,sha256:hash(bytes),bytes:bytes.length};
}

// Parent admission may call this before claiming. Only an owned probe is removed.
export async function preflightLocalCaptureCheckpoints({workspace,directory,recoveryPublicKeyFile}={}){
  demand(path.isAbsolute(workspace||'')&&path.isAbsolute(recoveryPublicKeyFile||''),'absolute preflight paths required');
  const target=await privateDirectory(directory),staging=await canonicalPath(path.resolve(workspace,'local-reports/snapshot-staging'));
  demand(!within(target,staging),'outputs must be outside staging');
  const stat=await fs.lstat(recoveryPublicKeyFile);
  demand(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=6144,'unsafe public recipient file');
  const recipientPublicKey=await fs.readFile(recoveryPublicKeyFile,'utf8');validateRecoveryRecipient(recipientPublicKey);
  for(const name of [...Object.values(names),'timeout']){
    await absent(path.join(target,name+'.ptenc'));await absent(path.join(target,name+'.receipt.json'));
  }
  await absent(path.join(target,'native-complete.receipt.json'));
  await absent(path.join(target,'verification-completed.json'));
  await absent(path.join(target,'verification-completed.receipt.json'));
  const probe=path.join(target,'.checkpoint-preflight-'+randomUUID());
  const handle=await fs.open(probe,'wx',0o600);
  try{await handle.writeFile('checkpoint preflight\n');await handle.sync();}
  finally{try{await handle.close();}finally{await fs.unlink(probe);}}
  return {recipientPublicKey};
}

function encryptionReceipt(result,{sourceCommit,phase,sourceBinding,ledgerManifestHash}){
  demand(result?.sourceCommit===sourceCommit&&result.attempt==='overnight-capture'&&result.phase===phase&&
    /^[a-f0-9]{64}$/.test(result.ciphertextSha256||'')&&
    ['files','sourceBytes','bytes'].every(key=>Number.isSafeInteger(result[key])&&result[key]>=0),'invalid encryption result');
  if(phase==='native-proofs')demand(isDeepStrictEqual(result.sourceBinding,sourceBinding)&&
    result.ledgerManifestHash===ledgerManifestHash&&result.authority===false,'encryption proof binding mismatch');
  return {sourceCommit,attempt:result.attempt,phase,ciphertextSha256:result.ciphertextSha256,
    files:result.files,sourceBytes:result.sourceBytes,bytes:result.bytes,
    sourceBinding:sourceBinding??null,ledgerManifestHash:ledgerManifestHash??null};
}

async function writeReceipt(handle,value){
  const bytes=Buffer.from(JSON.stringify(value)+'\n');await handle.truncate(0);
  let offset=0;
  while(offset<bytes.length){
    const {bytesWritten}=await handle.write(bytes,offset,bytes.length-offset,offset);
    demand(bytesWritten>0,'receipt write made no progress');offset+=bytesWritten;
  }
  await handle.sync();
}

export function createLocalCaptureCheckpoint({root,directory,recipientPublicKey,sourceCommit,encrypt=encryptCaptureRecovery}={}){
  demand(path.isAbsolute(root||'')&&path.isAbsolute(directory||'')&&/^[a-f0-9]{40}$/.test(sourceCommit||''),'pinned checkpoint context required');
  validateRecoveryRecipient(recipientPublicKey);demand(typeof encrypt==='function','encryption capability required');
  return async ({directory:source,sourceCommit:callbackCommit=sourceCommit,phase='pre-native',sourceBinding=null,ledgerManifestHash=null}={})=>{
    demand(Object.hasOwn(names,phase)&&callbackCommit===sourceCommit&&path.isAbsolute(source||''),'invalid checkpoint callback binding');
    if(phase==='native-proofs')demand(sourceBinding?.sourceCommit===sourceCommit&&
      Object.keys(sourceBinding).sort().join('|')==='captureSha256|sourceCommit'&&
      /^[a-f0-9]{64}$/.test(sourceBinding.captureSha256||'')&&/^[a-f0-9]{64}$/.test(ledgerManifestHash||''),'invalid proof callback binding');
    else demand(sourceBinding===null&&ledgerManifestHash===null,'unexpected proof callback binding');
    const target=await privateDirectory(directory),sourceRoot=await fs.realpath(source);
    demand(!within(target,sourceRoot),'outputs must be outside captured source');
    const name=names[phase],outputFile=path.join(target,name+'.ptenc'),receiptFile=path.join(target,name+'.receipt.json');
    await absent(outputFile);
    // Reserve the receipt before encryption; a duplicate call cannot replace evidence.
    const handle=await fs.open(receiptFile,'wx',0o600);
    let base=null,encryption=null,operation='staging-base',primaryError;
    const metadata={schemaVersion:1,kind:'private-capture-checkpoint',authority:false,
      archive:name+'.ptenc',sourceCommit,attempt:'overnight-capture',phase,sourceBinding,ledgerManifestHash};
    try{
      base=await stagingBase(root);operation='encryption';
      const result=await encrypt({directory:source,outputFile,recipientPublicKey,sourceCommit,attempt:'overnight-capture',phase,
        ...(phase==='native-proofs'?{sourceBinding,ledgerManifestHash}:{})});
      encryption=encryptionReceipt(result,{sourceCommit,phase,sourceBinding,ledgerManifestHash});operation='staging-base-recheck';
      demand(isDeepStrictEqual(base,await stagingBase(root)),'staging base changed during encryption');
      operation='receipt';
      await writeReceipt(handle,{...metadata,status:'complete',stagingBase:base,encryption});
      return result;
    }catch(error){
      primaryError=error;
      try{
        await writeReceipt(handle,{...metadata,status:'failed',stagingBase:base,encryption,
          failure:{operation,code:failureCode(error)}});
      }catch{
        console.error('Local capture checkpoint failure receipt could not be persisted.');
      }
      throw error;
    }finally{
      try{await handle.close();}catch(error){
        if(!primaryError)throw error;
        console.error('Local capture checkpoint receipt close failed.');
      }
    }
  };
}

// Secondary recovery failure must be visible, but must not replace the capture error.
export async function retainLocalCaptureFailure({staging,sourceCommit,checkpoint}){
  try{
    const exists=await fs.lstat(staging).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
    if(exists)await checkpoint({directory:staging,sourceCommit,phase:'failure-state'});
  }catch{
    console.error('Local capture recovery checkpoint failed; original capture error preserved.');
  }
}

const nativeCountFields=Object.freeze(['known','verified','held','excluded','mismatch','unavailable','unprocessed',
  'reusedPhysics','nativeDispatched','nativeBatches','sourceJobs','targets','serverAccepted']);

// This wraps the updater's existing capability, never a second invocation or a
// restore/import path. A returned phase can still have complete:false.
export function createLocalNativePhaseReceipt({root,directory,owner,testedCommit,nativePhase}={}){
  demand(path.isAbsolute(root||'')&&path.isAbsolute(directory||'')&&/^[a-f0-9-]{36}$/.test(owner||'')&&
    /^[a-f0-9]{40}$/.test(testedCommit||'')&&typeof nativePhase==='function','invalid native receipt context');
  const absoluteRoot=path.resolve(root),staging=path.join(absoluteRoot,'local-reports/snapshot-staging');
  return async options=>{
    demand(path.isAbsolute(options?.root||'')&&path.resolve(options.root)===absoluteRoot&&
      path.isAbsolute(options.directory||'')&&path.resolve(options.directory)===staging&&options.sourceCommit===testedCommit&&
      options.reuseOnly===false,'invalid native receipt invocation');
    const target=await privateDirectory(directory),source=await fs.realpath(staging);
    demand(!within(target,source),'native receipt must be outside staging');
    const file=path.join(target,'native-complete.receipt.json');await absent(file);
    const result=await nativePhase(options);
    demand(result?.schemaVersion===1&&result.authority==='snapshot-native'&&
      result.backendReads===0&&result.backendWrites===0&&typeof result.complete==='boolean','invalid native receipt result/usage');
    const binding=result.sourceBinding;
    demand(binding&&Object.keys(binding).sort().join('|')==='captureSha256|sourceCommit'&&
      binding.sourceCommit===testedCommit&&/^[a-f0-9]{64}$/.test(binding.captureSha256||'')&&
      /^[a-f0-9]{64}$/.test(result.ledgerManifestHash||''),'invalid native receipt source binding');
    const counts=result.counts;
    demand(counts&&typeof counts==='object'&&!Array.isArray(counts)&&
      Object.keys(counts).length===nativeCountFields.length&&nativeCountFields.every(key=>
        Object.hasOwn(counts,key)&&Number.isSafeInteger(counts[key])&&counts[key]>=0),'invalid native receipt counts');
    demand(!result.complete||(counts.unavailable===0&&counts.unprocessed===0),'native completion contradicts counts');
    const receipt={schemaVersion:1,kind:'private-native-phase-completion',owner,testedCommit,
      sourceBinding:{sourceCommit:binding.sourceCommit,captureSha256:binding.captureSha256},
      ledgerManifestHash:result.ledgerManifestHash,backendReads:0,backendWrites:0,
      counts:Object.fromEntries(nativeCountFields.map(key=>[key,counts[key]])),complete:result.complete};
    const handle=await fs.open(file,'wx',0o600);
    try{await writeReceipt(handle,receipt);await handle.close();}
    catch(error){
      await handle.close().catch(()=>{console.error('Failed native completion receipt handle could not be closed.');});
      await fs.unlink(file).catch(()=>{console.error('Failed native completion receipt could not be removed.');});
      throw error;
    }
    return result;
  };
}
