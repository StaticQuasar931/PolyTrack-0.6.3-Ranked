import fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function backupInventory(directory){
 const root=await fs.realpath(directory),files={};let total=0,count=0;
 async function walk(relative=''){for(const entry of (await fs.readdir(path.join(root,relative),{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
  if(entry.isSymbolicLink())throw Error('Source backup symlink forbidden');const name=relative?relative+'/'+entry.name:entry.name;
  if(entry.isDirectory())await walk(name);else{if(!entry.isFile()||!name.endsWith('.json')||name.split('/').some(s=>!s||s==='.'||s==='..')||!/^[A-Za-z0-9._/-]+$/.test(name))throw Error('Invalid source backup file');
   const stat=await fs.stat(path.join(root,name));if(stat.size>16*1024*1024||(total+=stat.size)>256*1024*1024||++count>60000)throw Error('Source backup inventory bound exceeded');
   files[name]={bytes:stat.size,sha256:sha(await fs.readFile(path.join(root,name)))};
  }
 }}await walk();return {schemaVersion:1,files,totalBytes:total};
}
export async function reuseCompletedWorkerBackup({directory,receipt}){
 const binding=receipt.reuseWorkerBackup;if(!binding||binding.sourceCommit!==receipt.priorFailure?.sourceCommit)throw Error('Exact source backup reuse binding required');
 const read=async(field)=>{const item=binding[field];if(!item||!path.isAbsolute(item.file||'')||!/^[a-f0-9]{64}$/.test(item.sha256||''))throw Error('Invalid source backup evidence');const bytes=await fs.readFile(item.file);if(sha(bytes)!==item.sha256)throw Error('Source backup evidence changed');return bytes;};
 const failed=JSON.parse(await read('failure'));if(failed.status!=='failed'||failed.sourceCommit!==binding.sourceCommit)throw Error('Prior source capture not terminal');
 const log=(await read('log')).toString('utf8');const records=log.split(/\r?\n/).filter(x=>x.startsWith('{')).map(x=>{try{return JSON.parse(x);}catch{return{};}});
 const completed=records.find(x=>x.publicSnapshotBackup?.fullSourceChecks)?.publicSnapshotBackup;
 const operations=records.find(x=>x.fullSnapshotOperations)?.fullSnapshotOperations;
 const diagnostic=JSON.parse(await read('diagnostic'));
 if(!completed||completed.fullSourceChecks.known!==completed.fullSourceChecks.confirmed+completed.fullSourceChecks.unavailable||!operations||operations.stopped||operations.documentWrites!==0||diagnostic.reason!=='baseline_exceeds_10000'||diagnostic.rows!==0||diagnostic.pages!==0||diagnostic.sourceCalls!==0)throw Error('Completed backup or zero-query failure evidence missing');
 const expected=JSON.parse(await read('inventory')),actual=await backupInventory(directory);
 if(JSON.stringify(actual)!==JSON.stringify(expected))throw Error('Captured source backup inventory changed');
 const manifest=JSON.parse(await fs.readFile(path.join(directory,'manifest.json'),'utf8'));
 if(manifest.deferred===true||!manifest.tracks||!manifest.events)throw Error('Invalid completed backup manifest');
 const catalogBytes=await read('catalog');const catalog=JSON.parse(catalogBytes);if(!Array.isArray(catalog.periods))throw Error('Captured event catalog missing');
 return {manifest,summary:completed,operations,catalogBytes,authority:false};
}
