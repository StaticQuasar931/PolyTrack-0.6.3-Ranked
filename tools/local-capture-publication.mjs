import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {buildSnapshotLookupShards,MAX_FILE_BYTES} from './snapshot-package.mjs';
const HASH=/^[a-f0-9]{64}$/,sha=value=>createHash('sha256').update(value).digest('hex');

export async function assertLocalSource({workspace,sourceCommit,runnerFile}){
  const git=args=>execFileSync('git',args,{cwd:workspace,encoding:'utf8',stdio:['ignore','pipe','pipe']});
  if(git(['rev-parse','HEAD']).trim()!==sourceCommit||git(['diff','--name-only','HEAD']).trim())throw Error('Isolated source is not clean and tested');
  const realRunner=await fs.realpath(runnerFile),expected=await fs.realpath(path.join(workspace,'tools/local-overnight-capture.mjs'));
  if((process.platform==='win32'?realRunner.toLowerCase():realRunner)!==(process.platform==='win32'?expected.toLowerCase():expected))
    throw Error('Execute the runner inside the tested isolated workspace');
  for(const file of ['tools/local-overnight-capture.mjs','tools/local-capture-worker.mjs','tools/local-capture-publication.mjs','tools/local-capture-process.mjs',
    'tools/local-capture-git.mjs','tools/local-publication-argv.mjs','tools/local-capture-checkpoint.mjs','tools/local-playback-cache.mjs','tools/local-archive-replay-repair.mjs']){
    const committed=git(['show',sourceCommit+':'+file]).replace(/\r\n?/g,'\n');
    if((await fs.readFile(path.join(workspace,file),'utf8')).replace(/\r\n?/g,'\n')!==committed)throw Error('Runner implementation is not in the tested commit');
  }
  if(git(['ls-files','--others','--exclude-standard','-z']).split('\0').filter(Boolean).some(file=>!file.startsWith('local-reports/')))
    throw Error('Unexpected untracked file in isolated workspace');
}

export async function validateSnapshotPayloads({folder,items,readFile=fs.readFile,lstat=fs.lstat}){
  const payloads=new Map();
  // Validate every logical binding before scheduling any physical payload reads.
  for(const item of items){
    if(!HASH.test(item?.sha256||'')||item.path!==item.sha256+'.bin')throw Error('Invalid package payload inventory');
    payloads.set(item.path,item.sha256);
  }
  const unique=[...payloads];let cursor=0,stopped=false,failure;
  async function worker(){
    while(!stopped){
      const index=cursor++;if(index>=unique.length)return;
      const [relative,digest]=unique[index],file=path.join(folder,relative);
      try{
        const stat=await lstat(file);
        if(stat.isSymbolicLink())throw Error('Package cannot contain symlinks');
        if(!stat.isFile())throw Error('Unexpected package entry');
        if(stat.size>MAX_FILE_BYTES)throw Error('Package payload exceeds encoded size limit');
        if(stopped)return;
        const bytes=await readFile(file);
        if(bytes.byteLength>MAX_FILE_BYTES)throw Error('Package payload exceeds encoded size limit');
        if(sha(bytes)!==digest)throw Error('Package payload changed');
      }catch(error){if(!stopped){stopped=true;failure=error;}}
    }
  }
  // Workers absorb errors so all in-flight operations settle before rejection.
  await Promise.all(Array.from({length:Math.min(8,unique.length)},worker));
  if(stopped)throw failure;
  return [...payloads.keys()];
}

export async function snapshotPublicationFiles({root,directory}){
  if(! /^public-snapshots[1-9][0-9]*$/.test(directory||''))throw Error('Invalid publication directory');
  const folder=path.join(root,directory),index=JSON.parse(await fs.readFile(path.join(folder,'index.json'),'utf8'));
  if(index.schemaVersion!==1||index.generation!==Number(directory.slice(16))||!index.files||Array.isArray(index.files))throw Error('Invalid package index');
  const expected=new Set(['index.json']);
  for(const relative of await validateSnapshotPayloads({folder,items:Object.values(index.files)}))expected.add(relative);
  if(index.files['snapshot-paging.json']){expected.add('bootstrap-index.json');expected.add('bootstrap-fast.json');}
  if(index.lookupShardsVersion===1)for(const bucket of buildSnapshotLookupShards(index).keys())expected.add('lookup-shards/'+bucket+'.json');
  const actual=new Set();
  async function walk(base=''){
    for(const entry of await fs.readdir(path.join(folder,base),{withFileTypes:true})){
      const relative=base?base+'/'+entry.name:entry.name;
      if(entry.isSymbolicLink())throw Error('Package cannot contain symlinks');
      if(entry.isDirectory()){
        if(relative!=='lookup-shards')throw Error('Unexpected package directory');await walk(relative);
      }else if(entry.isFile())actual.add(relative);else throw Error('Unexpected package entry');
    }
  }
  await walk();
  if(actual.size!==expected.size||[...actual].some(file=>!expected.has(file)))throw Error('Package contains missing or unreferenced artifacts');
  return [...expected].sort().map(file=>directory+'/'+file);
}
