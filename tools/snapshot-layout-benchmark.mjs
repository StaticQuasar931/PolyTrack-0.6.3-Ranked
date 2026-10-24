
import fs from 'node:fs/promises';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const pointer=JSON.parse(await fs.readFile(path.join(root,'snapshot-current.json'),'utf8'));
const base=path.join(root,pointer.currentdir),index=JSON.parse(await fs.readFile(path.join(base,'index.json'),'utf8'));
const measurements={};
for(const file of ['index.json','bootstrap-index.json','bootstrap-fast.json']){
 try{const bytes=await fs.readFile(path.join(base,file));measurements[file]={bytes:bytes.length,gzipBytes:gzipSync(bytes,{level:9}).length};}catch(error){if(error.code!=='ENOENT')throw error;}
}
const shards=[];for(const file of await fs.readdir(path.join(base,'lookup-shards')).catch(error=>error.code==='ENOENT'?[]:Promise.reject(error))){const bytes=await fs.readFile(path.join(base,'lookup-shards',file));shards.push({bytes:bytes.length,gzipBytes:gzipSync(bytes,{level:9}).length});}
shards.sort((a,b)=>a.bytes-b.bytes);
const median=shards[Math.floor(shards.length/2)]||null;
const transferMs=(bytes,mbps)=>Math.round(bytes*8/mbps/1000);
console.log(JSON.stringify({generation:index.generation,logicalFiles:Object.keys(index.files).length,measurements,shards:{count:shards.length,median,maximum:shards.at(-1)||null},
 theoreticalLookupTransferMs:median?[1,10].map(mbps=>({mbps,legacyIndex:transferMs(measurements['index.json'].gzipBytes,mbps),medianShard:transferMs(median.gzipBytes,mbps)})):[],
 caveats:'Local byte measurements only. gzip size approximates hosting compression, not measured network traffic. Transfer estimates exclude latency, headers, CPU and caching. Lookup savings are not whole-game speedups. Firebase requests: zero.'},null,2));
