import fs from 'node:fs/promises';
import path from 'node:path';
import {inflateSync} from 'node:zlib';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const require=createRequire(import.meta.url);
const {decodePacked}=require('./verifier/kodub-track.cjs')._internals;
export function publicTrackMetadata(code){
  const match=/^PolyTrack[12]([A-Za-z0-9]+)$/.exec(code.trim());
  if(!match)throw Error('Unsupported public track code');
  const inner=inflateSync(decodePacked(match[1],262144,'metadata_size'),{maxOutputLength:4*1024*1024});
  const data=inflateSync(decodePacked(inner.toString('ascii'),2*1024*1024,'metadata_size'),{maxOutputLength:16*1024*1024});
  const nameLength=data[0],authorOffset=1+nameLength,authorLength=data[authorOffset];
  if(!Number.isInteger(authorLength)||authorOffset+1+authorLength>data.length)throw Error('Invalid public track metadata');
  const decode=new TextDecoder('utf-8',{fatal:true});
  return {name:decode.decode(data.subarray(1,authorOffset)),author:decode.decode(data.subarray(authorOffset+1,authorOffset+1+authorLength))};
}
export async function buildTrackSearchMetadata(root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')){
  const catalog=JSON.parse(await fs.readFile(path.join(root,'tracks/catalog.json'),'utf8')).tracks;
  const rows=[];
  for(const track of catalog){
    if(!/^tracks\/(official|community)\/[A-Za-z0-9_-]+\.track$/.test(track.trackUrl))throw Error('Unsafe built-in track path');
    const code=await fs.readFile(path.join(root,track.trackUrl),'utf8');
    rows.push({...publicTrackMetadata(code),thumbnail:track.thumbnail,plainName:track.name});
  }
  await fs.writeFile(path.join(root,'tracks/search-metadata.json'),JSON.stringify(rows)+'\n');
  return rows.length;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))console.log('Search metadata:',await buildTrackSearchMetadata(),'built-in tracks');
