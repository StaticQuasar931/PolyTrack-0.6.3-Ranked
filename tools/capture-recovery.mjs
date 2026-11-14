import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadStream,createWriteStream} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip,gunzipSync} from 'node:zlib';
import {createHash,createPublicKey,createPrivateKey,publicEncrypt,privateDecrypt,randomBytes,createCipheriv,createDecipheriv,constants} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';

const MAGIC=Buffer.from('PTREC01\n'),MAX_BYTES=256*1024*1024,MAX_FILES=100000,MAX_FILE=16*1024*1024;
const fileLimit=logical=>logical==='overall.json'?32*1024*1024:MAX_FILE;
const MAX_DECODED=Math.ceil(MAX_BYTES*1.5),READ_AHEAD=4,READ_BYTES=MAX_FILE,PACK_BYTES=64*1024,BASE64_BYTES=48*1024;
const hash=value=>createHash('sha256').update(value).digest('hex');
const safe=relative=>typeof relative==='string'&&relative.length<512&&/^[A-Za-z0-9_./-]+$/.test(relative)&&
 !relative.startsWith('/')&&!relative.split('/').some(part=>!part||part==='.'||part==='..')&&
 !/(?:^|\/)(?:\.env[^/]*|node_modules|\.git|\.wrangler)|credential|service.account|private.key|\.(?:pem|p12|key)$/i.test(relative)&&/\.(?:json|bin)$/.test(relative);
export function validateRecoveryRecipient(value){
 if(typeof value!=='string'||value.length>6144||!value.startsWith('-----BEGIN PUBLIC KEY-----')||value.includes('PRIVATE'))throw Error('Public recovery recipient required');
 const key=createPublicKey(value);
 if(key.asymmetricKeyType!=='rsa'||key.asymmetricKeyDetails.modulusLength<2048||key.asymmetricKeyDetails.modulusLength>4096)throw Error('Invalid recovery recipient');
 return key;
}
const ATTEMPTS=new Set(['repair-2','routine-capture','overnight-capture']);
function identity(sourceCommit,attempt){if(!/^[a-f0-9]{40}$/.test(sourceCommit||'')||!ATTEMPTS.has(attempt))throw Error('Invalid recovery source binding');}
function proofBinding(phase,sourceCommit,sourceBinding,ledgerManifestHash){
 if(!['pre-native','failure-state','native-proofs'].includes(phase))throw Error('Invalid recovery phase');
 if(phase==='native-proofs'){
  if(!sourceBinding||Object.keys(sourceBinding).sort().join('|')!=='captureSha256|sourceCommit'||sourceBinding.sourceCommit!==sourceCommit||
   !/^[a-f0-9]{64}$/.test(sourceBinding.captureSha256||'')||!/^[a-f0-9]{64}$/.test(ledgerManifestHash||''))throw Error('Invalid proof recovery binding');
 }else if(sourceBinding!=null||ledgerManifestHash!=null)throw Error('Unexpected proof recovery binding');
}
async function readEntry(root,entry,io){
 const file=path.join(root,...entry.path.split('/')),before=await io.lstat(file);
 if(before.isSymbolicLink()||!before.isFile())throw Error('Recovery refuses links or non-files');
 if(before.size!==entry.bytes)throw Error('Recovery source changed');
 const handle=await io.open(file,'r');
 try{
  const opened=await handle.stat();
  if(!opened.isFile()||opened.size!==entry.bytes||opened.dev!==before.dev||opened.ino!==before.ino)throw Error('Recovery source changed');
  const data=Buffer.alloc(entry.bytes);let offset=0;
  while(offset<data.length){
   const {bytesRead}=await handle.read(data,offset,data.length-offset,offset);
   if(!bytesRead)throw Error('Recovery source changed');offset+=bytesRead;
  }
  if((await handle.read(Buffer.alloc(1),0,1,offset)).bytesRead)throw Error('Recovery source changed');
  return data;
 }finally{await handle.close();}
}

// Ordinary read-ahead stays at 16 MiB; the sole root Overall exception reads alone.
async function* readEntries(root,entries,io=fs){
 const pending=[];let next=0,bytes=0;
 try{
  while(next<entries.length||pending.length){
   while(next<entries.length&&pending.length<READ_AHEAD&&(bytes+entries[next].bytes<=READ_BYTES||pending.length===0)){
    const entry=entries[next++];bytes+=entry.bytes;
    const result=readEntry(root,entry,io).then(data=>({data}),error=>({error}));
    pending.push({entry,result});
   }
   const {entry,result}=pending.shift(),value=await result;
   if(value.error)throw value.error;
   yield {entry,data:value.data};bytes-=entry.bytes;
  }
 }finally{await Promise.all(pending.map(item=>item.result));}
}

// The injected filesystem is for bounded offline fixtures, not a configurable limit.
export async function inventoryCaptureRecovery(directory,{filesystem:io=fs}={}){
 const root=await io.realpath(directory),stat=await io.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unsafe recovery directory');
 const entries=[];let bytes=0;
 async function visit(folder,relative=''){
  for(const name of (await io.readdir(folder)).sort()){
   const file=path.join(folder,name),logical=relative?relative+'/'+name:name,info=await io.lstat(file);
   if(info.isSymbolicLink())throw Error('Recovery refuses links');
   if(info.isDirectory())await visit(file,logical);
   else{
    if(!info.isFile()||!safe(logical)||info.size>fileLimit(logical)||entries.length>=MAX_FILES||(bytes+=info.size)>MAX_BYTES)throw Error('Recovery source exceeds safe boundary');
    entries.push({path:logical,bytes:info.size,sha256:'0'.repeat(64)});
   }
  }
 }
 await visit(root);
 // Fail metadata limits before opening source contents or creating any archive.
 let plaintextBytes=Buffer.byteLength('{"entries":[],"bytes":'+bytes+'}\n');
 for(let i=0;i<entries.length;i++){
  const entry=entries[i];
  plaintextBytes+=Buffer.byteLength(JSON.stringify(entry))+(i?1:0)+
   Buffer.byteLength('{"path":'+JSON.stringify(entry.path)+',"data":""}\n')+4*Math.ceil(entry.bytes/3);
 }
 if(plaintextBytes>MAX_DECODED)throw Error('Recovery source exceeds decoded boundary');
 for await(const {entry,data}of readEntries(root,entries,io))entry.sha256=hash(data);
 return {root,entries,bytes};
}

async function* recordParts(source){
 yield '{"entries":[';
 for(let i=0;i<source.entries.length;i++)yield (i?',':'')+JSON.stringify(source.entries[i]);
 yield '],"bytes":'+source.bytes+'}\n';
 for await(const {entry,data}of readEntries(source.root,source.entries)){
  if(hash(data)!==entry.sha256)throw Error('Recovery source changed during encryption');
  yield '{"path":'+JSON.stringify(entry.path)+',"data":"';
  for(let offset=0;offset<data.length;offset+=BASE64_BYTES)yield data.subarray(offset,offset+BASE64_BYTES).toString('base64');
  yield '"}\n';
 }
}
async function* packedRecords(source){
 let parts=[],bytes=0;
 for await(const part of recordParts(source)){
  if(bytes&&bytes+part.length>PACK_BYTES){yield Buffer.from(parts.join(''));parts=[];bytes=0;}
  parts.push(part);bytes+=part.length;
 }
 if(bytes)yield Buffer.from(parts.join(''));
}
function* recoveryLines(decoded,start=0){
 let end=decoded.length;
 while(end>start&&[9,10,11,12,13,32].includes(decoded[end-1]))end--;
 while(start<end){
  const newline=decoded.indexOf(10,start),stop=newline<0?end:Math.min(newline,end);
  yield decoded.subarray(start,stop);start=stop+1;
 }
}
export async function encryptCaptureRecovery({directory,outputFile,recipientPublicKey,sourceCommit,attempt='repair-2',phase='pre-native',sourceBinding=null,ledgerManifestHash=null}={}){
 identity(sourceCommit,attempt);proofBinding(phase,sourceCommit,sourceBinding,ledgerManifestHash);
 if(!path.isAbsolute(outputFile||''))throw Error('Invalid recovery output');
 const recipient=validateRecoveryRecipient(recipientPublicKey),source=await inventoryCaptureRecovery(directory);
 const target=path.join(await fs.realpath(path.dirname(outputFile)),path.basename(outputFile));
 if(target===source.root||target.startsWith(source.root+path.sep))throw Error('Recovery output must be outside captured source');
 const secret=randomBytes(32),iv=randomBytes(12);
 const header=Buffer.from(JSON.stringify({schemaVersion:1,sourceCommit,attempt,phase,recipientFingerprint:hash(recipient.export({type:'spki',format:'der'})),
  wrappedKey:publicEncrypt({key:recipient,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},secret).toString('base64'),iv:iv.toString('base64'),
  ...(phase==='native-proofs'?{sourceBinding,ledgerManifestHash}:{})}));
 const length=Buffer.alloc(4);length.writeUInt32BE(header.length);const cipher=createCipheriv('aes-256-gcm',secret,iv);cipher.setAAD(header);
 let created=false;
 try{
  const output=await fs.open(target,'wx',0o600);created=true;
  try{await output.write(Buffer.concat([MAGIC,length,header]));}finally{await output.close();}
  await pipeline(Readable.from(packedRecords(source),{objectMode:false,highWaterMark:PACK_BYTES}),createGzip({level:6}),cipher,createWriteStream(target,{flags:'a'}));
  await fs.appendFile(target,cipher.getAuthTag());
  const archived=await fs.lstat(target);
  if(!archived.isFile()||archived.isSymbolicLink()||archived.size>MAX_BYTES)throw Error('Recovery archive exceeds safe boundary');
 }catch(error){if(created)await fs.rm(target,{force:true});throw error;}finally{secret.fill(0);}
 const digest=createHash('sha256');for await(const chunk of createReadStream(target))digest.update(chunk);
 return {sourceCommit,attempt,phase,files:source.entries.length,sourceBytes:source.bytes,ciphertextSha256:digest.digest('hex'),bytes:(await fs.stat(target)).size,
  ...(phase==='native-proofs'?{sourceBinding,ledgerManifestHash,authority:false}:{})};
}
export async function restoreCaptureRecovery({inputFile,destination,privateKey,expectedSha256,sourceCommit,attempt='repair-2',expectedPhase=null,expectedSourceBinding=null,expectedLedgerManifestHash=null}={}){
 identity(sourceCommit,attempt);if(!/^[a-f0-9]{64}$/.test(expectedSha256||'')||!path.isAbsolute(destination||''))throw Error('Expected recovery digest and new destination required');
 const info=await fs.lstat(inputFile);if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_BYTES)throw Error('Unsafe recovery archive');
 const bytes=await fs.readFile(inputFile);if(hash(bytes)!==expectedSha256||!bytes.subarray(0,MAGIC.length).equals(MAGIC))throw Error('Recovery ciphertext digest mismatch');
 const start=MAGIC.length+4,length=bytes.readUInt32BE(MAGIC.length);if(length>8192||length<1||bytes.length<start+length+17)throw Error('Invalid recovery header');
 const encoded=bytes.subarray(start,start+length),header=JSON.parse(encoded);if(header.schemaVersion!==1||header.sourceCommit!==sourceCommit||header.attempt!==attempt)throw Error('Recovery source mismatch');
 proofBinding(header.phase,sourceCommit,header.sourceBinding,header.ledgerManifestHash);
 if(expectedPhase!==null&&header.phase!==expectedPhase)throw Error('Recovery phase mismatch');
 if(header.phase==='native-proofs'){
  proofBinding(header.phase,sourceCommit,expectedSourceBinding,expectedLedgerManifestHash);
  if(!isDeepStrictEqual(header.sourceBinding,expectedSourceBinding)||header.ledgerManifestHash!==expectedLedgerManifestHash)throw Error('Recovery proof binding mismatch');
 }else if(expectedSourceBinding!==null||expectedLedgerManifestHash!==null)throw Error('Unexpected proof recovery expectation');
 const key=createPrivateKey(privateKey);if(hash(createPublicKey(key).export({type:'spki',format:'der'}))!==header.recipientFingerprint)throw Error('Recovery recipient mismatch');
 const secret=privateDecrypt({key,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(header.wrappedKey,'base64'));
 const decipher=createDecipheriv('aes-256-gcm',secret,Buffer.from(header.iv,'base64'));decipher.setAAD(encoded);decipher.setAuthTag(bytes.subarray(-16));
 let decoded;try{decoded=gunzipSync(Buffer.concat([decipher.update(bytes.subarray(start+length,-16)),decipher.final()]),{maxOutputLength:MAX_DECODED});}finally{secret.fill(0);}
 const lines=recoveryLines(decoded),first=lines.next(),manifest=JSON.parse(first.value?.toString('utf8'));
 if(!Array.isArray(manifest?.entries)||manifest.entries.length>MAX_FILES||!Number.isSafeInteger(manifest.bytes)||manifest.bytes<0||manifest.bytes>MAX_BYTES)throw Error('Invalid recovery inventory');
 const recordsStart=first.value.length+1,names=new Set();let total=0,count=0;
 for(const line of lines){
  if(count>=manifest.entries.length)throw Error('Invalid recovery inventory');
  const entry=manifest.entries[count++],record=JSON.parse(line.toString('utf8'));
  if(!entry||!safe(entry.path)||names.has(entry.path)||record?.path!==entry.path||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||entry.bytes>fileLimit(entry.path))throw Error('Unsafe recovered path');
  if(typeof record.data!=='string')throw Error('Invalid recovery content');
  const data=Buffer.from(record.data,'base64');if(data.toString('base64')!==record.data||data.length!==entry.bytes||hash(data)!==entry.sha256||(total+=data.length)>MAX_BYTES)throw Error('Recovered content mismatch');
  names.add(entry.path);
 }
 if(count!==manifest.entries.length)throw Error('Invalid recovery inventory');
 if(total!==manifest.bytes)throw Error('Recovery byte count mismatch');
 names.clear();
 await fs.mkdir(destination); // Never overwrite an existing workspace.
 // Validate every record before creating output, but retain no decoded file buffers.
 const directories=new Set([destination]);
 for(const line of recoveryLines(decoded,recordsStart)){
  const record=JSON.parse(line.toString('utf8')),target=path.join(destination,...record.path.split('/')),parent=path.dirname(target);
  if(!directories.has(parent)){await fs.mkdir(parent,{recursive:true});directories.add(parent);}
  await fs.writeFile(target,Buffer.from(record.data,'base64'),{flag:'wx',mode:0o600});
 }
 return {sourceCommit,attempt,files:count,bytes:total,phase:header.phase,
  ...(header.phase==='native-proofs'?{sourceBinding:header.sourceBinding,ledgerManifestHash:header.ledgerManifestHash,authority:false}:{})};
}
