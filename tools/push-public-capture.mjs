import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync} from 'node:fs';

export function pushPublicCapture({branch=process.env.DEFAULT_BRANCH,sourceCommit=process.env.SNAPSHOT_NATIVE_SOURCE_COMMIT,preserveCohort=false,run=execFileSync}={}){
  if(typeof branch!=='string'||!/^\w[\w./-]*$/.test(branch))throw Error('A valid default branch is required');
  if(sourceCommit!==undefined&&!/^[a-f0-9]{40}$/.test(sourceCommit))throw Error('Invalid snapshot-native source commit');
  if(typeof preserveCohort!=='boolean')throw Error('Invalid retained-proof publication mode');
  const options={stdio:'inherit',env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_EDITOR:'true',GIT_SEQUENCE_EDITOR:'true'}};
  const git=args=>run('git',args,options);
  git(['check-ref-format','--branch',branch]);
  git(['diff','--quiet']);git(['diff','--cached','--quiet']);
  if(sourceCommit){
    const parent=String(run('git',['rev-parse','HEAD^'],{...options,stdio:'pipe',encoding:'utf8'})).trim();
    if(parent!==sourceCommit)throw Error('Snapshot-native candidate no longer has its checked source parent');
  }
  for(let attempt=0;attempt<3;attempt++){
    try{git(['push','origin','HEAD:refs/heads/'+branch]);return {attempts:attempt+1};}
    catch(error){
      // Proofs and their derived package were checked together against this source.
      // A rebase could change physics, review holds, or inputs without recompiling.
      if(sourceCommit||preserveCohort)throw Error('Snapshot-native publication deferred after push failure; preserve the candidate and revalidate against current main before publishing',{cause:error});
      if(attempt===2)throw Error('Capture push failed after three attempts; rerun the workflow',{cause:error});
      git(['fetch','--no-tags','origin','refs/heads/'+branch]);
      try{git(['rebase','FETCH_HEAD']);}
      catch(conflict){
        try{git(['rebase','--abort']);}catch{}
        throw Error('Concurrent capture changes conflict; rerun the workflow without force-pushing',{cause:conflict});
      }
    }
  }
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))
  pushPublicCapture({preserveCohort:existsSync(path.resolve('verification-ledger-current.json'))});
