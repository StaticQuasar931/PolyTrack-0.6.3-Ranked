import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {decodeSnapshot} from './snapshot-package.mjs';
import {eventReplayCoverage} from './event-replay-coverage.mjs';

export async function auditSnapshotEventReplays({root=path.resolve(import.meta.dirname,'..'),snapshotDirectory}={}){
  const name=snapshotDirectory||((await fs.readFile(path.join(root,'index.html'),'utf8')).match(/content="\.\/(public-snapshots\d+)\/"/)||[])[1];
  if(!/^public-snapshots\d+$/.test(name||''))throw Error('Expected a local public snapshot directory');
  const directory=path.join(root,name),index=JSON.parse(await fs.readFile(path.join(directory,'index.json'),'utf8'));
  const read=async logical=>{
    const file=index.files?.[logical];if(!file)return null;
    if(!/^[a-f0-9]{64}\.bin$/.test(file.path||''))throw Error('Invalid local snapshot blob');
    return JSON.parse(Buffer.from(await decodeSnapshot(await fs.readFile(path.join(directory,file.path)))).toString());
  };
  const boards=[];
  for(const key of Object.keys(index.files||{}).filter(key=>/^events\/[^/]+\.json$/.test(key)))boards.push(await read(key));
  return {snapshot:name,...await eventReplayCoverage(boards,read)};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  if(process.argv.length>3)throw Error('Usage: node tools/audit-event-replays.mjs [public-snapshotsN]');
  console.log(JSON.stringify(await auditSnapshotEventReplays({snapshotDirectory:process.argv[2]}),null,2));
}
