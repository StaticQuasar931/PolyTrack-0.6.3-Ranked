import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadPrivateProofCache,writePrivateProofCache} from './proof-cache-file.mjs';
test('private cache requires external digest, current context and outside-repo path',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'proof-file-')),file=path.join(dir,'cache.json'),root=process.cwd();
  const context={file,root,engineDigest:'e'.repeat(64),verifierFingerprint:'f'.repeat(64)};
  const cache={exportEntries:()=>[],stats:()=>({entries:0}),seed:()=>assert.fail('empty')};
  try{
    const saved=writePrivateProofCache(cache,context);assert.equal(saved.entries,0);
    assert.throws(()=>loadPrivateProofCache(cache,context),/trusted SHA256/);
    assert.throws(()=>loadPrivateProofCache(cache,{...context,sha256:'0'.repeat(64)}),/mismatch/);
    assert.doesNotThrow(()=>loadPrivateProofCache(cache,{...context,sha256:saved.sha256}));
    assert.throws(()=>loadPrivateProofCache(cache,{...context,sha256:saved.sha256,verifierFingerprint:'0'.repeat(64)}),/context mismatch/);
    assert.throws(()=>writePrivateProofCache(cache,{...context,file:path.join(root,'cache.json')}),/outside/);
    assert.throws(()=>writePrivateProofCache(cache,context),/EEXIST/);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
