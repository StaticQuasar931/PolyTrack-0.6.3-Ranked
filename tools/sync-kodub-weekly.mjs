import {mkdir,writeFile,rename,readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {KODUB_ROOT,validateWeekly,assetPath,boundedBytes,validateAsset} from '../events/kodub-schema.mjs';
import {mergeKodubHistory} from '../events/kodub-history.mjs';

const directory = new URL('../events/kodub/',import.meta.url);
const headers = {Origin:'https://app-polytrack.kodub.com',Referer:'https://app-polytrack.kodub.com/'};
const TRUSTED_LIMIT = 520;
const TRACK_LIMIT = 262144;
const TRUSTED_PATH = /^assets\/([a-f0-9]{64})\.track$/;

export async function mergeTrustedTrackHistory(history,candidates,readAsset) {
  const records = new Map();
  const consider = async (trackId,assetPath) => {
    if (!/^[a-f0-9]{64}$/.test(trackId || '')) return;
    const match = TRUSTED_PATH.exec(assetPath || '');
    if (!match) return;
    try {
      const bytes = await readAsset(assetPath);
      if (!bytes.length || bytes.length > TRACK_LIMIT || createHash('sha256').update(bytes).digest('hex') !== match[1]) return;
      records.set(`${trackId}:${match[1]}`, {trackId,codeHash:match[1],assetPath});
    } catch {}
  };
  for (const entry of Array.isArray(history) ? history.slice(-TRUSTED_LIMIT) : []) {
    if (entry?.assetPath === `assets/${entry?.codeHash}.track`) await consider(entry.trackId,entry.assetPath);
  }
  for (const candidate of candidates) {
    await consider(candidate?.trackId,candidate?.trackUrl);
  }
  return [...records.values()].slice(-TRUSTED_LIMIT);
}

async function download(url,limit) {
  return boundedBytes(await fetch(url,{headers,redirect:'error',signal:AbortSignal.timeout(15000)}),limit);
}
async function syncKodubWeekly() {
const metadata = JSON.parse(new TextDecoder().decode(await download(KODUB_ROOT+'?version=0.6.3',16384)));
const current = validateWeekly(metadata);
if (!current) throw Error('No unexpired Kodub selection; previous capture left intact');
const readJson=async name=>{try{return JSON.parse(await readFile(new URL(name,directory),'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const previous=(await readJson('current.json'))?.current;
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
const history=mergeKodubHistory(await readJson('history.json'),(await readJson('current.json'))?.current,current);
const trustedHistory=await mergeTrustedTrackHistory(await readJson('trusted-tracks.json'),[previous,current],asset=>readFile(new URL(asset,directory)));
await writeFile(new URL('trusted-tracks.json.tmp',directory),JSON.stringify(trustedHistory,null,2)+'\n');
await rename(new URL('trusted-tracks.json.tmp',directory),new URL('trusted-tracks.json',directory));
await writeFile(new URL('history.json.tmp',directory),JSON.stringify(history,null,2)+'\n');
await rename(new URL('history.json.tmp',directory),new URL('history.json',directory));
// Publish the pointer only after every referenced asset has been downloaded and checked.
await writeFile(new URL('current.json.tmp',directory),JSON.stringify({serverTime:metadata.serverTime,current},null,2)+'\n');
await rename(new URL('current.json.tmp',directory),new URL('current.json',directory));
console.log('Captured '+current.name+' until '+current.endTime+' in '+fileURLToPath(directory));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await syncKodubWeekly();

