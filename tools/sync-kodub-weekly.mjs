import {mkdir,writeFile,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {KODUB_ROOT,validateWeekly,assetPath,boundedBytes,validateAsset} from '../events/kodub-schema.mjs';

const directory = new URL('../events/kodub/',import.meta.url);
const headers = {Origin:'https://app-polytrack.kodub.com',Referer:'https://app-polytrack.kodub.com/'};
async function download(url,limit) {
  return boundedBytes(await fetch(url,{headers,redirect:'error',signal:AbortSignal.timeout(15000)}),limit);
}
const metadata = JSON.parse(new TextDecoder().decode(await download(KODUB_ROOT+'?version=0.6.3',16384)));
const current = validateWeekly(metadata);
if (!current) throw Error('No unexpired Kodub selection; previous capture left intact');
const assets = [];
for (const [field,type] of [['trackUrl','track'],['thumbnailUrl','image'],['coverUrl','image']]) {
  if (field === 'coverUrl' && current[field] === null) continue;
  assetPath(current[field],type);
  const bytes=validateAsset(await download(current[field]+'?version=0.6.3',2*1024*1024),type);
  const digest=createHash('sha256').update(bytes).digest('hex');
  const name='assets/'+digest+(type==='track'?'.track':'.webp');
  assets.push([name,bytes]);current[field]=name;
}
await mkdir(new URL('assets/',directory),{recursive:true});
for (const [name,bytes] of assets) await writeFile(new URL(name,directory),bytes);
// Publish the pointer only after every referenced asset has been downloaded and checked.
await writeFile(new URL('current.json.tmp',directory),JSON.stringify({serverTime:metadata.serverTime,current},null,2)+'\n');
await rename(new URL('current.json.tmp',directory),new URL('current.json',directory));
console.log('Captured '+current.name+' until '+current.endTime+' in '+fileURLToPath(directory));

