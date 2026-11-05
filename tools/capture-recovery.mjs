import fs from 'node:fs/promises';
import path from 'node:path';
import {createReadStream,createWriteStream} from 'node:fs';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip,gunzipSync} from 'node:zlib';
import {createHash,createPublicKey,createPrivateKey,publicEncrypt,privateDecrypt,randomBytes,createCipheriv,createDecipheriv,constants} from 'node:crypto';

const MAGIC=Buffer.from('PTREC01\n'),MAX_BYTES=256*1024*1024,MAX_FILES=30000,MAX_FILE=16*1024*1024;
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
function identity(sourceCommit,attempt){if(!/^[a-f0-9]{40}$/.test(sourceCommit||'')||attempt!=='repair-2')throw Error('Invalid recovery source binding');}
async function inventory(directory){
 const root=await fs.realpath(directory),stat=await fs.lstat(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unsafe recovery directory');
 const entries=[];let bytes=0;
 async function visit(folder,relative=''){
  for(const name of (await fs.readdir(folder)).sort()){
   const file=path.join(folder,name),logical=relative?relative+'/'+name:name,info=await fs.lstat(file);
   if(info.isSymbolicLink())throw Error('Recovery refuses links');
   if(info.isDirectory())await visit(file,logical);
   else{
    if(!info.isFile()||!safe(logical)||info.size>MAX_FILE||entries.length>=MAX_FILES||(bytes+=info.size)>MAX_BYTES)throw Error('Recovery source exceeds safe boundary');
    const data=await fs.readFile(file);if(data.length!==info.size)throw Error('Recovery source changed');
    entries.push({path:logical,bytes:data.length,sha256:hash(data)});
   }
  }
 }
 await visit(root);return {root,entries,bytes};
}
export async function encryptCaptureRecovery({directory,outputFile,recipientPublicKey,sourceCommit,attempt='repair-2',phase='pre-native'}={}){
 identity(sourceCommit,attempt);if(!['pre-native','failure-state'].includes(phase)||!path.isAbsolute(outputFile||''))throw Error('Invalid recovery output');
 const recipient=validateRecoveryRecipient(recipientPublicKey),source=await inventory(directory);
 if(outputFile.startsWith(source.root+path.sep))throw Error('Recovery output must be outside captured source');
 const secret=randomBytes(32),iv=randomBytes(12);
 const header=Buffer.from(JSON.stringify({schemaVersion:1,sourceCommit,attempt,phase,recipientFingerprint:hash(recipient.export({type:'spki',format:'der'})),
  wrappedKey:publicEncrypt({key:recipient,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},secret).toString('base64'),iv:iv.toString('base64')}));
 const length=Buffer.alloc(4);length.writeUInt32BE(header.length);const cipher=createCipheriv('aes-256-gcm',secret,iv);cipher.setAAD(header);
 const output=await fs.open(outputFile,'wx',0o600);await output.write(Buffer.concat([MAGIC,length,header]));await output.close();
 async function* records(){
  yield JSON.stringify({entries:source.entries,bytes:source.bytes})+'\n';
  for(const entry of source.entries){const data=await fs.readFile(path.join(source.root,...entry.path.split('/')));
   if(data.length!==entry.bytes||hash(data)!==entry.sha256)throw Error('Recovery source changed during encryption');
   yield JSON.stringify({path:entry.path,data:data.toString('base64')})+'\n';
  }
 }
 try{
  await pipeline(Readable.from(records()),createGzip({level:6}),cipher,createWriteStream(outputFile,{flags:'a'}));
  await fs.appendFile(outputFile,cipher.getAuthTag());
 }catch(error){await fs.rm(outputFile,{force:true});throw error;}finally{secret.fill(0);}
 const digest=createHash('sha256');for await(const chunk of createReadStream(outputFile))digest.update(chunk);
 return {sourceCommit,attempt,phase,files:source.entries.length,sourceBytes:source.bytes,ciphertextSha256:digest.digest('hex'),bytes:(await fs.stat(outputFile)).size};
}
export async function restoreCaptureRecovery({inputFile,destination,privateKey,expectedSha256,sourceCommit,attempt='repair-2'}={}){
 identity(sourceCommit,attempt);if(!/^[a-f0-9]{64}$/.test(expectedSha256||'')||!path.isAbsolute(destination||''))throw Error('Expected recovery digest and new destination required');
 const info=await fs.lstat(inputFile);if(!info.isFile()||info.isSymbolicLink()||info.size>MAX_BYTES)throw Error('Unsafe recovery archive');
 const bytes=await fs.readFile(inputFile);if(hash(bytes)!==expectedSha256||!bytes.subarray(0,MAGIC.length).equals(MAGIC))throw Error('Recovery ciphertext digest mismatch');
 const start=MAGIC.length+4,length=bytes.readUInt32BE(MAGIC.length);if(length>8192||length<1||bytes.length<start+length+17)throw Error('Invalid recovery header');
 const encoded=bytes.subarray(start,start+length),header=JSON.parse(encoded);if(header.schemaVersion!==1||header.sourceCommit!==sourceCommit||header.attempt!==attempt)throw Error('Recovery source mismatch');
 const key=createPrivateKey(privateKey);if(hash(createPublicKey(key).export({type:'spki',format:'der'}))!==header.recipientFingerprint)throw Error('Recovery recipient mismatch');
 const secret=privateDecrypt({key,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(header.wrappedKey,'base64'));
 const decipher=createDecipheriv('aes-256-gcm',secret,Buffer.from(header.iv,'base64'));decipher.setAAD(encoded);decipher.setAuthTag(bytes.subarray(-16));
 let decoded;try{decoded=gunzipSync(Buffer.concat([decipher.update(bytes.subarray(start+length,-16)),decipher.final()]),{maxOutputLength:Math.ceil(MAX_BYTES*1.5)});}finally{secret.fill(0);}
 const lines=decoded.toString('utf8').trimEnd().split('\n'),manifest=JSON.parse(lines.shift());
 if(!Array.isArray(manifest.entries)||manifest.entries.length>MAX_FILES||lines.length!==manifest.entries.length||!Number.isSafeInteger(manifest.bytes)||manifest.bytes<0||manifest.bytes>MAX_BYTES)throw Error('Invalid recovery inventory');
 const names=new Set();let total=0;const records=[];
 for(let i=0;i<lines.length;i++){
  const entry=manifest.entries[i],record=JSON.parse(lines[i]);
  if(!safe(entry.path)||names.has(entry.path)||record.path!==entry.path||!Number.isSafeInteger(entry.bytes)||entry.bytes<0||entry.bytes>MAX_FILE)throw Error('Unsafe recovered path');
  if(typeof record.data!=='string')throw Error('Invalid recovery content');
  const data=Buffer.from(record.data,'base64');if(data.toString('base64')!==record.data||data.length!==entry.bytes||hash(data)!==entry.sha256||(total+=data.length)>MAX_BYTES)throw Error('Recovered content mismatch');
  names.add(entry.path);records.push({path:entry.path,data});
 }
 if(total!==manifest.bytes)throw Error('Recovery byte count mismatch');
 await fs.mkdir(destination); // Never overwrite an existing workspace.
 for(const record of records){const target=path.join(destination,...record.path.split('/'));await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,record.data,{flag:'wx',mode:0o600});}
 return {sourceCommit,attempt,files:records.length,bytes:total,phase:header.phase};
}
