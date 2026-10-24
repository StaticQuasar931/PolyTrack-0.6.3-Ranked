import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function pushPublicCapture({branch=process.env.DEFAULT_BRANCH,run=execFileSync}={}){
  if(typeof branch!=='string'||!/^\w[\w./-]*$/.test(branch))throw Error('A valid default branch is required');
  const options={stdio:'inherit',env:{...process.env,GIT_TERMINAL_PROMPT:'0',GIT_EDITOR:'true',GIT_SEQUENCE_EDITOR:'true'}};
  const git=args=>run('git',args,options);
  git(['check-ref-format','--branch',branch]);
  git(['diff','--quiet']);git(['diff','--cached','--quiet']);
  for(let attempt=0;attempt<3;attempt++){
    try{git(['push','origin','HEAD:refs/heads/'+branch]);return {attempts:attempt+1};}
    catch(error){
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

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))pushPublicCapture();
