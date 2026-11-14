import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,createHash,randomBytes,publicEncrypt,privateDecrypt,createCipheriv,createDecipheriv,constants} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import {encryptCaptureRecovery,restoreCaptureRecovery,validateRecoveryRecipient,inventoryCaptureRecovery} from './capture-recovery.mjs';
const pair=generateKeyPairSync('rsa',{modulusLength:2048}),recipientPublicKey=pair.publicKey.export({type:'spki',format:'pem'}),privateKey=pair.privateKey.export({type:'pkcs8',format:'pem'}),sourceCommit='a'.repeat(40);
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-recovery-'));t.after(()=>{assert.equal(path.dirname(path.resolve(root)),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith('capture-recovery-'));return fs.rm(root,{recursive:true,force:true});});const directory=path.join(root,'stage');await fs.mkdir(directory);await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify({fixture:'private replay data'}));return {root,directory,outputFile:path.join(root,'recovery.ptenc'),recipientPublicKey,sourceCommit};}
const sha=data=>createHash('sha256').update(data).digest('hex');
function plaintext(archive){
 const length=archive.readUInt32BE(8),encoded=archive.subarray(12,12+length),header=JSON.parse(encoded);
 const secret=privateDecrypt({key:privateKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},Buffer.from(header.wrappedKey,'base64'));
 try{const decipher=createDecipheriv('aes-256-gcm',secret,Buffer.from(header.iv,'base64'));decipher.setAAD(encoded);decipher.setAuthTag(archive.subarray(-16));
  return gunzipSync(Buffer.concat([decipher.update(archive.subarray(12+length,-16)),decipher.final()]));
 }finally{secret.fill(0);}
}
function legacyArchive(text){
 const secret=randomBytes(32),iv=randomBytes(12);
 try{
  const header=Buffer.from(JSON.stringify({schemaVersion:1,sourceCommit,attempt:'repair-2',phase:'pre-native',recipientFingerprint:sha(pair.publicKey.export({type:'spki',format:'der'})),
   wrappedKey:publicEncrypt({key:recipientPublicKey,oaepHash:'sha256',padding:constants.RSA_PKCS1_OAEP_PADDING},secret).toString('base64'),iv:iv.toString('base64')}));
  const length=Buffer.alloc(4);length.writeUInt32BE(header.length);
  const cipher=createCipheriv('aes-256-gcm',secret,iv);cipher.setAAD(header);
  return Buffer.concat([Buffer.from('PTREC01\n'),length,header,cipher.update(gzipSync(text)),cipher.final(),cipher.getAuthTag()]);
 }finally{secret.fill(0);}
}
function virtualFiles(directory,count,{size=()=>0,failRead=-1,longNames=false}={}){
 const names=Array.from({length:count},(_,i)=>(longNames?'x'.repeat(490):'row-')+String(i).padStart(6,'0')+'.json');
 const ids=new Map(names.map((name,i)=>[name,i]));
 const metrics={opens:0,active:0,maxActive:0,activeBytes:0,maxBytes:0};
 const info=(i,folder=false)=>({size:folder?0:size(i),dev:1,ino:folder?0:i+1,isDirectory:()=>folder,isFile:()=>!folder,isSymbolicLink:()=>false});
 const io={realpath:async()=>directory,readdir:async()=>names.slice(),lstat:async file=>file===directory?info(0,true):info(ids.get(path.basename(file))),open:async file=>{
  const i=ids.get(path.basename(file)),length=size(i);metrics.opens++;metrics.active++;metrics.activeBytes+=length;
  metrics.maxActive=Math.max(metrics.maxActive,metrics.active);metrics.maxBytes=Math.max(metrics.maxBytes,metrics.activeBytes);
  return {stat:async()=>info(i),read:async(buffer,offset,wanted,position)=>{await new Promise(resolve=>setImmediate(resolve));if(i===failRead)throw Error('fixture read failure');const bytesRead=Math.max(0,Math.min(wanted,length-position));buffer.fill(0,offset,offset+bytesRead);return {bytesRead};},close:async()=>{metrics.active--;metrics.activeBytes-=length;}};
 }};
 return {io,metrics,names};
}
test('encrypted checkpoint roundtrips offline, excludes plaintext and pins source/digest/recipient',async t=>{
 const f=await fixture(t),report=await encryptCaptureRecovery(f),bytes=await fs.readFile(f.outputFile);
 assert(!bytes.includes(Buffer.from('private replay data')));
 const destination=path.join(f.root,'restored');assert.equal((await restoreCaptureRecovery({inputFile:f.outputFile,destination,privateKey,expectedSha256:report.ciphertextSha256,sourceCommit})).files,1);
 assert.equal(await fs.readFile(path.join(destination,'manifest.json'),'utf8'),await fs.readFile(path.join(f.directory,'manifest.json'),'utf8'));
 await assert.rejects(restoreCaptureRecovery({inputFile:f.outputFile,destination,privateKey,expectedSha256:report.ciphertextSha256,sourceCommit:'b'.repeat(40)}),/source mismatch/);
 await assert.rejects(restoreCaptureRecovery({inputFile:f.outputFile,destination,privateKey,expectedSha256:'0'.repeat(64),sourceCommit}),/digest mismatch/);
 bytes[bytes.length-20]^=1;await fs.writeFile(f.outputFile,bytes);
 await assert.rejects(restoreCaptureRecovery({inputFile:f.outputFile,destination:path.join(f.root,'tampered'),privateKey,expectedSha256:report.ciphertextSha256,sourceCommit}));
 const tampered=path.join(f.root,'authenticated-failure');
 await assert.rejects(restoreCaptureRecovery({inputFile:f.outputFile,destination:tampered,privateKey,expectedSha256:createHash('sha256').update(bytes).digest('hex'),sourceCommit}),/authenticate|authentication/i);
 await assert.rejects(fs.stat(tampered),e=>e.code==='ENOENT');
});
test('private keys, credentials, links and existing outputs fail before publishing a checkpoint',async t=>{
 assert.throws(()=>validateRecoveryRecipient(privateKey),/Public/);
 const f=await fixture(t);await fs.writeFile(path.join(f.directory,'credentials.json'),'secret');await assert.rejects(encryptCaptureRecovery(f),/boundary/);
 await assert.rejects(fs.stat(f.outputFile),e=>e.code==='ENOENT');await fs.unlink(path.join(f.directory,'credentials.json'));
 await encryptCaptureRecovery(f);await assert.rejects(encryptCaptureRecovery(f),e=>e.code==='EEXIST');
});

for(const attempt of ['routine-capture','overnight-capture'])test(attempt+' has an explicit authenticated tag and source/phase-bound offline roundtrip',async t=>{
 const f=await fixture(t),report=await encryptCaptureRecovery({...f,attempt,phase:'failure-state'});
 const destination=path.join(f.root,'restored'),options={inputFile:f.outputFile,destination,privateKey,expectedSha256:report.ciphertextSha256,sourceCommit,attempt,expectedPhase:'failure-state'};
 assert.equal((await restoreCaptureRecovery(options)).attempt,attempt);
 assert.equal(await fs.readFile(path.join(destination,'manifest.json'),'utf8'),await fs.readFile(path.join(f.directory,'manifest.json'),'utf8'));
 await assert.rejects(restoreCaptureRecovery({...options,destination:path.join(f.root,'wrong-attempt'),attempt:'repair-2'}),/source mismatch/);
 await assert.rejects(restoreCaptureRecovery({...options,destination:path.join(f.root,'wrong-phase'),expectedPhase:'pre-native'}),/phase mismatch/);
 for(const attempt of ['repair-1','routine','../routine-capture','overnight-capture-extra'])
  await assert.rejects(encryptCaptureRecovery({...f,outputFile:path.join(f.root,'invalid.ptenc'),attempt}),/source binding/);
});

test('completed proof recovery requires exact independent source and manifest expectations, never grants authority',async t=>{
 const f=await fixture(t),sourceBinding={sourceCommit,captureSha256:'b'.repeat(64)},ledgerManifestHash='c'.repeat(64),attempt='overnight-capture';
 const report=await encryptCaptureRecovery({...f,attempt,phase:'native-proofs',sourceBinding,ledgerManifestHash});
 assert.deepEqual(report.sourceBinding,sourceBinding);assert.equal(report.ledgerManifestHash,ledgerManifestHash);assert.equal(report.authority,false);
 const options={inputFile:f.outputFile,privateKey,expectedSha256:report.ciphertextSha256,sourceCommit,attempt,expectedPhase:'native-proofs',
  expectedSourceBinding:sourceBinding,expectedLedgerManifestHash:ledgerManifestHash};
 const destination=path.join(f.root,'proof-restored'),restored=await restoreCaptureRecovery({...options,destination});
 assert.equal(restored.authority,false);assert.deepEqual(restored.sourceBinding,sourceBinding);assert.equal(restored.ledgerManifestHash,ledgerManifestHash);
 for(const patch of [{expectedSourceBinding:null},{expectedLedgerManifestHash:null},{expectedSourceBinding:{...sourceBinding,captureSha256:'d'.repeat(64)}},
  {expectedLedgerManifestHash:'e'.repeat(64)}])
  await assert.rejects(restoreCaptureRecovery({...options,destination:path.join(f.root,'wrong-proof'),...patch}),/proof.*binding/i);
 for(const patch of [{sourceBinding:{...sourceBinding,sourceCommit:'f'.repeat(40)}},{sourceBinding:{...sourceBinding,authority:true}},
  {ledgerManifestHash:'bad'},{phase:'pre-native'}])
  await assert.rejects(encryptCaptureRecovery({...f,outputFile:path.join(f.root,'invalid-proof.ptenc'),attempt,phase:'native-proofs',sourceBinding,ledgerManifestHash,...patch}),/proof.*binding/i);
});

test('default repair-2 header remains compatible and raw private files stay forbidden for all attempt tags',async t=>{
 const f=await fixture(t),report=await encryptCaptureRecovery(f),bytes=await fs.readFile(f.outputFile);
 const start=12,header=JSON.parse(bytes.subarray(start,start+bytes.readUInt32BE(8)));
 assert.equal(header.attempt,'repair-2');assert.equal(header.phase,'pre-native');
 assert.deepEqual(Object.keys(header).sort(),['schemaVersion','sourceCommit','attempt','phase','recipientFingerprint','wrappedKey','iv'].sort());
 assert.equal((await restoreCaptureRecovery({inputFile:f.outputFile,destination:path.join(f.root,'old-default'),privateKey,expectedSha256:report.ciphertextSha256,sourceCommit})).attempt,'repair-2');
 for(const filename of ['private-key.pem','service-account.json','.env.json']){
  await fs.writeFile(path.join(f.directory,filename),'must remain local');
  for(const attempt of ['repair-2','routine-capture','overnight-capture'])
   await assert.rejects(encryptCaptureRecovery({...f,outputFile:path.join(f.root,'unsafe.ptenc'),attempt}),/boundary/);
  await fs.unlink(path.join(f.directory,filename));
 }
 const existing=await fs.readFile(f.outputFile);await assert.rejects(encryptCaptureRecovery(f),error=>error.code==='EEXIST');
 assert((await fs.readFile(f.outputFile)).equals(existing));
 await assert.rejects(encryptCaptureRecovery({...f,outputFile:path.join(f.directory,'nested.ptenc')}),/outside/);
});

test('real 50001 microfiles encrypt and authenticate with every file retained',{timeout:240000},async t=>{
 const f=await fixture(t);
 const start=performance.now();
 for(let group=0;group<100;group++)await fs.mkdir(path.join(f.directory,'group-'+String(group).padStart(3,'0')));
 let next=0;
 const writers=await Promise.allSettled(Array.from({length:32},async()=>{while(next<50000){t.signal.throwIfAborted();const i=next++;
  await fs.writeFile(path.join(f.directory,'group-'+String(Math.floor(i/500)).padStart(3,'0'),`row-${String(i).padStart(5,'0')}.json`),'{}');
 }}));
 const failure=writers.find(result=>result.status==='rejected');if(failure)throw failure.reason;
 const created=performance.now();
 const report=await encryptCaptureRecovery(f);
 const encrypted=performance.now();assert.equal(report.files,50001);
 const archive=await fs.readFile(f.outputFile);assert.equal(sha(archive),report.ciphertextSha256);
 const lines=plaintext(archive).toString('utf8').trimEnd().split('\n'),manifest=JSON.parse(lines.shift());
 assert.equal(manifest.entries.length,50001);assert.equal(lines.length,50001);
 let bytes=0;for(let i=0;i<lines.length;i++){const record=JSON.parse(lines[i]),data=Buffer.from(record.data,'base64'),entry=manifest.entries[i];
  assert.equal(record.path,entry.path);assert.equal(data.length,entry.bytes);assert.equal(sha(data),entry.sha256);bytes+=data.length;
 }
 assert.equal(bytes,report.sourceBytes);assert.equal(bytes,manifest.bytes);
 assert(manifest.entries.some(entry=>entry.path==='group-099/row-49999.json'));
 t.diagnostic(JSON.stringify({files:report.files,sourceBytes:report.sourceBytes,ciphertextBytes:report.bytes,createMs:Math.round(created-start),encryptMs:Math.round(encrypted-created),validateMs:Math.round(performance.now()-encrypted)}));
});

test('exactly 100000 virtual files validate with at most four readers',async()=>{
 const directory=path.join(os.tmpdir(),'virtual-recovery'),v=virtualFiles(directory,100000);
 const inventory=await inventoryCaptureRecovery(directory,{filesystem:v.io});
 assert.equal(inventory.entries.length,100000);assert.equal(inventory.bytes,0);assert.equal(v.metrics.opens,100000);
 assert.equal(v.metrics.maxActive,4);assert.equal(v.metrics.active,0);assert.equal(inventory.entries.at(-1).sha256,sha(Buffer.alloc(0)));
});

test('100001 files reject before content reads or encryption output creation',async t=>{
 const f=await fixture(t),v=virtualFiles(f.directory,100001);
 const original={realpath:fs.realpath,lstat:fs.lstat,readdir:fs.readdir,open:fs.open};let opens=0;
 try{
  t.mock.method(fs,'realpath',v.io.realpath);t.mock.method(fs,'lstat',v.io.lstat);t.mock.method(fs,'readdir',v.io.readdir);
  t.mock.method(fs,'open',async()=>{opens++;assert.fail('Over-cap capture must not open content or output');});
  await assert.rejects(encryptCaptureRecovery(f),/safe boundary/);assert.equal(opens,0);
 }finally{for(const [name,value]of Object.entries(original))fs[name]=value;}
 await assert.rejects(fs.stat(f.outputFile),error=>error.code==='ENOENT');
});

test('per-file aggregate path and decoded-envelope bounds reject before content reads',async()=>{
 const directory=path.join(os.tmpdir(),'virtual-recovery');
 for(const options of [{count:1,size:()=>16*1024*1024+1},{count:17,size:()=>16*1024*1024},
  {count:50000,size:i=>i<16?16*1024*1024:0,longNames:true}]){
  const v=virtualFiles(directory,options.count,options);
  await assert.rejects(inventoryCaptureRecovery(directory,{filesystem:v.io}),/boundary/);assert.equal(v.metrics.opens,0);
 }
 const v=virtualFiles(directory,1);v.io.readdir=async()=>['x'.repeat(507)+'.json'];
 await assert.rejects(inventoryCaptureRecovery(directory,{filesystem:v.io}),/boundary/);assert.equal(v.metrics.opens,0);
});

test('root Overall 32 MiB exception roundtrips; overflow and non-root large files reject',async t=>{
 const f=await fixture(t),large=path.join(f.directory,'overall.json');
 const file=await fs.open(large,'w');await file.truncate(32*1024*1024);await file.close();
 const report=await encryptCaptureRecovery(f),destination=path.join(f.root,'large-restored');
 await restoreCaptureRecovery({inputFile:f.outputFile,destination,privateKey,expectedSha256:report.ciphertextSha256,sourceCommit});
 assert.equal((await fs.stat(path.join(destination,'overall.json'))).size,32*1024*1024);
 assert.equal(sha(await fs.readFile(path.join(destination,'overall.json'))),sha(await fs.readFile(large)));
 for(const [name,size]of [['overall.json',32*1024*1024+1],['other.json',16*1024*1024+1],['nested/overall.json',16*1024*1024+1],['Overall.json',16*1024*1024+1]]){
  if(name!=='overall.json')await fs.unlink(large).catch(e=>{if(e.code!=='ENOENT')throw e;});
  const target=path.join(f.directory,name);await fs.mkdir(path.dirname(target),{recursive:true});
  const handle=await fs.open(target,'w');await handle.truncate(size);await handle.close();
  await assert.rejects(inventoryCaptureRecovery(f.directory),/safe boundary/);await fs.unlink(target);
  const entry={path:name,bytes:size,sha256:'0'.repeat(64)};
  const archive=legacyArchive(JSON.stringify({entries:[entry],bytes:size})+'\n'+JSON.stringify({path:name,data:''})+'\n');
  const inputFile=path.join(f.root,'invalid.ptenc');await fs.writeFile(inputFile,archive);
  const output=path.join(f.root,'invalid-restored');
  await assert.rejects(restoreCaptureRecovery({inputFile,destination:output,privateKey,expectedSha256:sha(archive),sourceCommit}),/Unsafe recovered path/);
  await assert.rejects(fs.stat(output),e=>e.code==='ENOENT');
 }
});

test('large Overall reads alone without raising ordinary read-ahead or hanging',async()=>{
 const directory=path.join(os.tmpdir(),'virtual-large-overall'),v=virtualFiles(directory,3,{size:i=>i===0?32*1024*1024:1});
 const translate=file=>path.basename(file)==='overall.json'?path.join(directory,v.names[0]):file;
 const stat=v.io.lstat,open=v.io.open;
 v.io.readdir=async()=>['overall.json',...v.names.slice(1)];
 v.io.lstat=file=>stat(translate(file));v.io.open=file=>open(translate(file));
 const result=await inventoryCaptureRecovery(directory,{filesystem:v.io});
 assert.equal(result.entries.length,3);assert.equal(v.metrics.maxBytes,32*1024*1024);
 assert.equal(v.metrics.active,0);assert.equal(v.metrics.opens,3);
});

test('read-ahead limits file buffers to 16 MiB and drains readers after failure',async()=>{
 const directory=path.join(os.tmpdir(),'virtual-recovery');
 const v=virtualFiles(directory,8,{size:i=>i%2===0?16*1024*1024:1});
 await inventoryCaptureRecovery(directory,{filesystem:v.io});assert(v.metrics.maxBytes<=16*1024*1024);assert.equal(v.metrics.active,0);
 const bad=virtualFiles(directory,12,{size:()=>2,failRead:1});
 await assert.rejects(inventoryCaptureRecovery(directory,{filesystem:bad.io}),/fixture read failure/);
 assert.equal(bad.metrics.active,0);assert(bad.metrics.opens<=5);assert(bad.metrics.maxActive<=4);
});

test('streamed records preserve legacy plaintext exactly across base64 chunk boundaries',async t=>{
 const f=await fixture(t);await fs.mkdir(path.join(f.directory,'nested'));
 const inputs=[['manifest.json',await fs.readFile(path.join(f.directory,'manifest.json'))],['nested/binary.bin',randomBytes(48*1024*3+2)],['nested/empty.json',Buffer.alloc(0)]];
 for(const [name,data]of inputs.slice(1))await fs.writeFile(path.join(f.directory,...name.split('/')),data);
 const entries=inputs.map(([name,data])=>({path:name,bytes:data.length,sha256:sha(data)})),bytes=inputs.reduce((n,[,data])=>n+data.length,0);
 const expected=JSON.stringify({entries,bytes})+'\n'+inputs.map(([name,data])=>JSON.stringify({path:name,data:data.toString('base64')})+'\n').join('');
 const report=await encryptCaptureRecovery(f);assert.equal(plaintext(await fs.readFile(f.outputFile)).toString(),expected);
 const old=legacyArchive(expected),inputFile=path.join(f.root,'legacy.ptenc');await fs.writeFile(inputFile,old);
 const destination=path.join(f.root,'legacy-restored');assert.equal((await restoreCaptureRecovery({inputFile,destination,privateKey,expectedSha256:sha(old),sourceCommit})).files,3);
 for(const [name,data]of inputs)assert((await fs.readFile(path.join(destination,...name.split('/')))).equals(data));
 assert.equal(report.files,3);
});

test('all records validate before restore creates any files and inventory remains bounded',async t=>{
 const f=await fixture(t),data=Buffer.from('{}'),entry={path:'first.json',bytes:data.length,sha256:sha(data)};
 for(const [label,entries,records,bytes]of [
  ['late-corruption',[entry,{...entry,path:'last.json'}],[{path:entry.path,data:data.toString('base64')},{path:'last.json',data:'eA=='}],4],
  ['duplicate',[entry,entry],[{path:entry.path,data:data.toString('base64')},{path:entry.path,data:data.toString('base64')}],4],
  ['missing',[entry],[],2],['over-cap',Array(100001).fill(entry),[],200002]
 ]){
  const archive=legacyArchive(JSON.stringify({entries,bytes})+'\n'+records.map(r=>JSON.stringify(r)+'\n').join(''));
  const inputFile=path.join(f.root,label+'.ptenc'),destination=path.join(f.root,label);await fs.writeFile(inputFile,archive);
  await assert.rejects(restoreCaptureRecovery({inputFile,destination,privateKey,expectedSha256:sha(archive),sourceCommit}));
  await assert.rejects(fs.stat(destination),error=>error.code==='ENOENT');
 }
});

test('same-size mutation between inventory and encryption fails without retaining an archive',async t=>{
 const f=await fixture(t),target=path.join(f.directory,'manifest.json'),originalOpen=fs.open,old=await fs.readFile(target);let reads=0;
 try{
  t.mock.method(fs,'open',async(file,...args)=>{if(file===target&&++reads===2)await fs.writeFile(target,Buffer.alloc(old.length,120));return originalOpen(file,...args);});
  await assert.rejects(encryptCaptureRecovery(f),/changed during encryption/);
 }finally{fs.open=originalOpen;}
 await assert.rejects(fs.stat(f.outputFile),error=>error.code==='ENOENT');
});

test('directory links and symlink roots are refused by recovery inventory',async t=>{
 const f=await fixture(t),link=path.join(f.directory,'linked');
 await fs.symlink(f.root,link,process.platform==='win32'?'junction':'dir');
 await assert.rejects(inventoryCaptureRecovery(f.directory),/links/);
 await assert.rejects(inventoryCaptureRecovery(link),/Unsafe recovery directory/);
});

test('an archive beyond the existing restore byte limit cannot receive a completion result',async t=>{
 const f=await fixture(t),original=fs.lstat;
 try{
  t.mock.method(fs,'lstat',async(file,...args)=>{const stat=await original(file,...args);if(file===f.outputFile)stat.size=256*1024*1024+1;return stat;});
  await assert.rejects(encryptCaptureRecovery(f),/archive exceeds safe boundary/);
 }finally{fs.lstat=original;}
 await assert.rejects(fs.stat(f.outputFile),error=>error.code==='ENOENT');
});
