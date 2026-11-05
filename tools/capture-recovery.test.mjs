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
