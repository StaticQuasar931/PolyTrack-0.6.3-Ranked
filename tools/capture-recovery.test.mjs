import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {generateKeyPairSync,createHash} from 'node:crypto';
import {encryptCaptureRecovery,restoreCaptureRecovery,validateRecoveryRecipient} from './capture-recovery.mjs';
const pair=generateKeyPairSync('rsa',{modulusLength:2048}),recipientPublicKey=pair.publicKey.export({type:'spki',format:'pem'}),privateKey=pair.privateKey.export({type:'pkcs8',format:'pem'}),sourceCommit='a'.repeat(40);
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'capture-recovery-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));const directory=path.join(root,'stage');await fs.mkdir(directory);await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify({fixture:'private replay data'}));return {root,directory,outputFile:path.join(root,'recovery.ptenc'),recipientPublicKey,sourceCommit};}
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
