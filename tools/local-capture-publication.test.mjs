import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {assertLocalSource,snapshotPublicationFiles} from './local-capture-publication.mjs';

async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'local-publication-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
test('exact isolated source rejects uncommitted/untracked executables and an external runner',async t=>{
  const workspace=await fixture(t),git=args=>execFileSync('git',args,{cwd:workspace,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git(['init']);await fs.mkdir(path.join(workspace,'tools'));
  for(const name of ['local-overnight-capture','local-capture-worker','local-capture-publication','local-capture-process'])await fs.writeFile(path.join(workspace,'tools',name+'.mjs'),'// committed\n');
  git(['add','tools']);git(['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']);
  const sourceCommit=git(['rev-parse','HEAD']).trim(),runnerFile=path.join(workspace,'tools/local-overnight-capture.mjs');
  await assertLocalSource({workspace,sourceCommit,runnerFile});
  await fs.writeFile(path.join(workspace,'untracked.json'),'{}');await assert.rejects(assertLocalSource({workspace,sourceCommit,runnerFile}),/untracked/);
  await fs.unlink(path.join(workspace,'untracked.json'));
  const external=path.join(await fixture(t),'runner.mjs');await fs.writeFile(external,'// committed\n');
  await assert.rejects(assertLocalSource({workspace,sourceCommit,runnerFile:external}),/isolated workspace/);
  await fs.writeFile(runnerFile,'// modified\n');await assert.rejects(assertLocalSource({workspace,sourceCommit,runnerFile}),/clean and tested/);
});
test('snapshot publication admits only referenced hash-bound package artifacts',async t=>{
  const root=await fixture(t),directory='public-snapshots73',folder=path.join(root,directory),bytes=Buffer.from('encoded public data');
  await fs.mkdir(folder);const hash=createHash('sha256').update(bytes).digest('hex');
  await fs.writeFile(path.join(folder,hash+'.bin'),bytes);
  await fs.writeFile(path.join(folder,'index.json'),JSON.stringify({schemaVersion:1,generation:73,files:{'safe.json':{path:hash+'.bin',sha256:hash}}}));
  assert.deepEqual(await snapshotPublicationFiles({root,directory}),[directory+'/'+hash+'.bin',directory+'/index.json'].sort());
  await fs.writeFile(path.join(folder,'private.json'),'{}');await assert.rejects(snapshotPublicationFiles({root,directory}),/unreferenced/);
  await fs.unlink(path.join(folder,'private.json'));await fs.writeFile(path.join(folder,hash+'.bin'),'changed');await assert.rejects(snapshotPublicationFiles({root,directory}),/changed/);
});
test('publication inventory rejects path escapes, foreign generation and extra directories',async t=>{
  const root=await fixture(t);await assert.rejects(snapshotPublicationFiles({root,directory:'../outside'}),/directory/);
  await fs.mkdir(path.join(root,'public-snapshots73'));await fs.writeFile(path.join(root,'public-snapshots73/index.json'),JSON.stringify({schemaVersion:1,generation:74,files:{}}));
  await assert.rejects(snapshotPublicationFiles({root,directory:'public-snapshots73'}),/index/);
  await fs.writeFile(path.join(root,'public-snapshots73/index.json'),JSON.stringify({schemaVersion:1,generation:73,files:{}}));await fs.mkdir(path.join(root,'public-snapshots73/recovery'));
  await assert.rejects(snapshotPublicationFiles({root,directory:'public-snapshots73'}),/directory/);
});
