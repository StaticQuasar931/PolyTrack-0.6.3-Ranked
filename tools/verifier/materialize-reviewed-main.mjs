import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assets from './assets.cjs';

const REVIEWED_SOURCE='8b51f8deb8f6c18235b32ec6986d769083eca7b7';
const BUNDLE='main.bundle.js';
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const digest=bytes=>hash(assets.canonicalBytes(BUNDLE,bytes));

// Only replace a pristine checkout bundle with the manifest-pinned verifier.
export function materializeReviewedMain(root, mode) {
  if(!path.isAbsolute(root)||!['install','restore'].includes(mode))throw Error('Expected an absolute disposable checkout and explicit mode');
  root=fs.realpathSync(root);
  const git=(...args)=>execFileSync('git',args,{cwd:root,maxBuffer:16*1024*1024});
  if(fs.realpathSync(git('rev-parse','--show-toplevel').toString().trim())!==root)throw Error('Expected checkout root');
  const manifest=JSON.parse(fs.readFileSync(path.join(root,'tools/verifier/engine-manifest.json'),'utf8'));
  if(hash(JSON.stringify(manifest.files))!==manifest.engineDigest)throw Error('Invalid reviewed engine manifest');
  const reviewed=git('show',REVIEWED_SOURCE+':'+BUNDLE), reviewedHash=digest(reviewed);
  if(reviewedHash!==manifest.files[BUNDLE])throw Error('Reviewed bundle does not match pinned engine');
  const original=git('show','HEAD:'+BUNDLE), originalHash=digest(original);
  const target=path.join(root,BUNDLE);
  if(!fs.lstatSync(target).isFile())throw Error('Expected regular checkout bundle');
  const wanted=mode==='install'?reviewed:original;
  const current=fs.readFileSync(target);
  if(current.equals(wanted))return {mode,changed:false,source:REVIEWED_SOURCE};
  const from=mode==='install'?originalHash:reviewedHash;
  if(digest(current)!==from)throw Error('Refusing to overwrite an unexpected checkout bundle');
  const temp=fs.mkdtempSync(path.join(root,'.reviewed-main-'));
  try{
    const staged=path.join(temp,BUNDLE);
    fs.writeFileSync(staged,wanted,{flag:'wx'});
    fs.renameSync(staged,target);
  }finally{
    fs.rmSync(path.join(temp,BUNDLE),{force:true});
    fs.rmdirSync(temp);
  }
  return {mode,changed:true,source:REVIEWED_SOURCE};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const mode={'--disposable-worktree':'install','--restore-disposable-worktree':'restore'}[process.argv[2]];
  if(process.argv.length!==4||!mode)throw Error('Usage: materialize-reviewed-main.mjs [--disposable-worktree|--restore-disposable-worktree] ABSOLUTE_ROOT');
  console.log(JSON.stringify(materializeReviewedMain(process.argv[3],mode)));
}
