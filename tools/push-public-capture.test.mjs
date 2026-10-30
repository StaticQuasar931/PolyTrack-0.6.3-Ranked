import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,writeFileSync}from'node:fs';
import os from'node:os';import path from'node:path';import{execFileSync}from'node:child_process';
import{pushPublicCapture}from'./push-public-capture.mjs';
test('invalid branches and dirty captures fail before a push',()=>{
 let calls=[];assert.throws(()=>pushPublicCapture({branch:'--bad',run:(_,args)=>calls.push(args)}));assert.equal(calls.length,0);
 assert.throws(()=>pushPublicCapture({branch:'main',run:(_,args)=>{calls.push(args);if(args[0]==='diff')throw Error('dirty');}}));
 assert(!calls.some(args=>args[0]==='push'));
});
test('retries are bounded and never force-push',()=>{
 const calls=[];assert.throws(()=>pushPublicCapture({branch:'main',run:(_,args)=>{calls.push(args);if(args[0]==='push')throw Error('remote moved');}}));
 assert.equal(calls.filter(args=>args[0]==='push').length,3);assert(!calls.flat().some(arg=>arg.includes('force')));
});
test('a rebase conflict aborts rather than overwriting published files',()=>{
 const calls=[];assert.throws(()=>pushPublicCapture({branch:'main',run:(_,args)=>{calls.push(args);if(args[0]==='push'||args[0]==='rebase'&&args[1]!=='--abort')throw Error('conflict');}}),/conflict/);
 assert(calls.some(args=>args[0]==='rebase'&&args[1]==='--abort'));
 assert.equal(calls.filter(args=>args[0]==='push').length,1);
});
test('snapshot-native publication never rebases proof decisions onto different source',()=>{
 const sourceCommit='a'.repeat(40),calls=[];
 assert.throws(()=>pushPublicCapture({branch:'main',sourceCommit,run:(_,args)=>{
  calls.push(args);if(args[0]==='rev-parse')return sourceCommit+'\n';if(args[0]==='push')throw Error('remote moved');
 }}),/Snapshot-native publication deferred/);
 assert.equal(calls.filter(args=>args[0]==='push').length,1);
 assert.equal(calls.filter(args=>['fetch','rebase'].includes(args[0])).length,0);
});
test('snapshot-native publication requires the exact checked source parent',()=>{
 const calls=[];
 assert.throws(()=>pushPublicCapture({branch:'main',sourceCommit:'a'.repeat(40),run:(_,args)=>{
  calls.push(args);if(args[0]==='rev-parse')return 'b'.repeat(40);
 }}),/checked source parent/);
 assert.equal(calls.some(args=>args[0]==='push'),false);
 assert.throws(()=>pushPublicCapture({branch:'main',sourceCommit:'main',run:()=>assert.fail('no Git call')}),/Invalid snapshot-native/);
});

test('retained-proof snapshots never rebase even for a legacy catalog caller without a source environment pin',()=>{
 const calls=[];
 assert.throws(()=>pushPublicCapture({branch:'main',preserveCohort:true,run:(_,args)=>{
  calls.push(args);if(args[0]==='push')throw Error('remote moved');
 }}),/preserve the candidate/);
 assert.equal(calls.filter(args=>args[0]==='push').length,1);
 assert.equal(calls.some(args=>['fetch','rebase'].includes(args[0])),false);
});
test('two captures starting at one revision preserve both updates in a local bare remote',()=>{
 const temp=mkdtempSync(path.join(os.tmpdir(),'polytrack-capture-push-'));
 const config=path.join(temp,'empty.gitconfig');writeFileSync(config,'');
 const git=(cwd,...args)=>execFileSync('git',['-c','safe.directory='+cwd,...args],{cwd,stdio:'pipe',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:config}});
 const remote=path.join(temp,'remote.git');git(temp,'init','--bare','--initial-branch=main',remote);
 const a=path.join(temp,'a'),b=path.join(temp,'b');git(temp,'clone',remote,a);
 for(const repo of [a]){git(repo,'config','user.email','test@example.invalid');git(repo,'config','user.name','Capture Test');}
 writeFileSync(path.join(a,'base.txt'),'base\n');git(a,'add','.');git(a,'commit','-m','base');git(a,'push','origin','main');git(temp,'clone',remote,b);
 git(b,'config','user.email','test@example.invalid');git(b,'config','user.name','Capture Test');
 for(const [repo,name]of [[a,'catalog.txt'],[b,'weekly.txt']]){writeFileSync(path.join(repo,name),name+'\n');git(repo,'add','.');git(repo,'commit','-m',name);}
 const publish=repo=>pushPublicCapture({branch:'main',run:(_,args)=>git(repo,...args)});
 assert.equal(publish(a).attempts,1);assert.equal(publish(b).attempts,2);
 const contents=git(temp,'--git-dir='+remote,'ls-tree','--name-only','main').toString();assert.match(contents,/catalog.txt/);assert.match(contents,/weekly.txt/);
 // Temporary repositories are retained for diagnostics; no recursive deletion.
});
