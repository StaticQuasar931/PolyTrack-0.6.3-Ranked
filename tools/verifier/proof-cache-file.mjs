import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadWeeklyTrustedTrack} from './weekly-track.mjs';
const MAX_BYTES=72*1024*1024;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
function privatePath(file,root){
  if(typeof file!=='string'||!path.isAbsolute(file))throw Error('Proof cache path must be absolute');
  const target=path.join(fs.realpathSync(path.dirname(file)),path.basename(file)),rel=path.relative(fs.realpathSync(root),target);
  if(!rel||!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep))throw Error('Proof cache must be outside repository');
  return target;
}
export function loadPrivateProofCache(cache,{file,sha256,root,engineDigest,verifierFingerprint}={}){
  if(!file){if(sha256)throw Error('Proof cache digest requires an input file');return;}
  if(!/^[a-f0-9]{64}$/.test(sha256||''))throw Error('Proof cache requires an independently trusted SHA256');
  const target=privatePath(file,root),stat=fs.lstatSync(target);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>MAX_BYTES)throw Error('Invalid proof cache file');
  const bytes=fs.readFileSync(target);if(hash(bytes)!==sha256)throw Error('Proof cache SHA256 mismatch');
  const value=JSON.parse(bytes.toString('utf8'));
  if(value.schema!=='polytrack-private-proof-cache-v1'||value.engineDigest!==engineDigest||value.verifierFingerprint!==verifierFingerprint||
    !Array.isArray(value.entries)||value.entries.length>1024)throw Error('Proof cache context mismatch');
  const jobs=value.entries.map(e=>e.job),results=value.entries.map(e=>e.result);
  if(jobs.some(job=>!job||typeof job!=='object')||results.some(result=>!result||typeof result!=='object'))throw Error('Invalid proof cache entries');
  // Track descriptors come only from the checked local registry, never from the cache file.
  for(let i=0;i<jobs.length;i+=16){const selected=jobs.slice(i,i+16);cache.seed(selected,results.slice(i,i+16),loadWeeklyTrustedTrack(root,selected));}
}
export function writePrivateProofCache(cache,{file,root,engineDigest,verifierFingerprint}={}){
  if(!file)return null;
  const bytes=Buffer.from(JSON.stringify({schema:'polytrack-private-proof-cache-v1',engineDigest,verifierFingerprint,entries:cache.exportEntries()})+'\n');
  if(bytes.length>MAX_BYTES)throw Error('Proof cache file limit');
  const fd=fs.openSync(privatePath(file,root),'wx',0o600);
  try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  return {sha256:hash(bytes),entries:cache.stats().entries,bytes:bytes.length};
}
