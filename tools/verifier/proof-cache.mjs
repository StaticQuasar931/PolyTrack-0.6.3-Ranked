import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {checkJob,sha256,LIMITS}=require('./replay.cjs');
const {partitionTrustedTracks}=require('./kodub-track.cjs');
const HASH=/^[a-f0-9]{64}$/;

// Reuse physics only. Callers must still review clones and publish through current CAS ownership checks.
export function createCachedVerifier({root,verify,engineDigest,verifierFingerprint,maxEntries=1024,maxBytes=64*1024*1024}={}) {
  if(!Number.isInteger(maxEntries)||maxEntries<1||maxEntries>20000||!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>64*1024*1024)throw Error('Invalid proof cache bounds');
  const staticHashes=new Map();
  try{
    const geometry=JSON.parse(fs.readFileSync(path.join(root,'tools/verifier/track-geometry.json'),'utf8'));
    const manifest=JSON.parse(fs.readFileSync(path.join(root,'tools/verifier/engine-manifest.json'),'utf8'));
    const catalog=JSON.parse(fs.readFileSync(path.join(root,'extra-tracks/catalog.json'),'utf8'));
    for(const row of catalog)if(manifest.engineDigest===engineDigest&&HASH.test(row.trackId||'')&&manifest.tracks?.[row.trackPath])staticHashes.set(row.trackId,manifest.tracks[row.trackPath]);
    for(const row of geometry.tracks||[])if(manifest.engineDigest===engineDigest&&manifest.tracks?.[row.name]===row.hash)staticHashes.set(row.id,row.hash);
  }catch{}
  const cache=new Map();let bytes=0,hits=0,misses=0;
  const context=(jobs,tracks=[])=>{
    const partition=partitionTrustedTracks(tracks,new Set(jobs.map(job=>job.trackId)));
    const hashes=new Map(staticHashes);for(const id of partition.rejected.keys())hashes.delete(id);
    for(const t of partition.accepted)hashes.set(t.expectedId,t.hash);
    return hashes;
  };
  const keyFor=(job,hashes)=>{
    try{checkJob(job);}catch{return null;}
    const hash=hashes.get(job.trackId);if(!HASH.test(hash||''))return null;
    return JSON.stringify([engineDigest,verifierFingerprint,'standard',job.trackId,hash,job.timeMs,job.replayHash]);
  };
  const put=(job,result,hashes)=>{
    const key=keyFor(job,hashes),b=result?.binding;
    if(!key||!result||result.status!=='verified'||result.reason!=='native_exact_finish'||result.deterministic!==true||
      result.resultId!==job.resultId||result.trackId!==job.trackId||result.timeMs!==job.timeMs||result.replayHash!==job.replayHash||
      result.engineDigest!==engineDigest||result.trackContentHash!==hashes.get(job.trackId)||
      b?.resultId!==job.resultId||b.trackId!==job.trackId||b.nativeTrackId!==job.trackId||b.timeMs!==job.timeMs||
      b.replayHash!==job.replayHash||b.actualReplayHash!==sha256(job.replay)||b.trackContentHash!==hashes.get(job.trackId)||
      b.engineDigest!==engineDigest||b.verifierFingerprint!==verifierFingerprint||b.verifierVersion!=='polytrack-native-bounded-v1'||
      (b.resourceProfile||'standard')!=='standard')return;
    if(cache.has(key))return;
    const proof={status:'verified',reason:'native_exact_finish',deterministic:true,trackGeometry:result.trackGeometry??null,
      geometryPolicy:result.geometryPolicy??null,binding:structuredClone(b)};
    const size=Buffer.byteLength(job.replay)+Buffer.byteLength(JSON.stringify(proof));
    if(size>maxBytes)return;
    while(cache.size>=maxEntries||bytes+size>maxBytes){const first=cache.keys().next().value;bytes-=cache.get(first).size;cache.delete(first);}
    cache.set(key,{replay:job.replay,proof,size});bytes+=size;
  };
  const rebind=(entry,job)=>{
    const proof=structuredClone(entry.proof),binding={...proof.binding,resultId:job.resultId};
    const fingerprint=sha256(JSON.stringify(binding));
    return {...proof,resultId:job.resultId,trackId:job.trackId,timeMs:job.timeMs,replayHash:job.replayHash,
      engineDigest,engineFingerprint:engineDigest,trackContentHash:binding.trackContentHash,binding,
      boundInputFingerprint:fingerprint,boundinputfingerprint:fingerprint};
  };
  const cached=async(directory,jobs,tracks=[])=>{
    if(!Array.isArray(jobs)||jobs.length>LIMITS.jobs)throw Error('Invalid cache batch');
    const hashes=context(jobs,tracks),results=new Array(jobs.length),missing=[];
    for(let i=0;i<jobs.length;i++){const key=keyFor(jobs[i],hashes),entry=key&&cache.get(key);
      if(entry&&entry.replay===jobs[i].replay){hits++;results[i]=rebind(entry,jobs[i]);}else{misses++;missing.push(i);}}
    if(missing.length){const selected=missing.map(i=>jobs[i]),ids=new Set(selected.map(j=>j.trackId));
      const fresh=await verify(directory,selected,tracks.filter(t=>ids.has(t.trackId)));
      if(!Array.isArray(fresh)||fresh.length!==selected.length||new Set(fresh.map(r=>r?.resultId)).size!==selected.length)throw Error('Incomplete verifier result set');
      for(const i of missing){const result=fresh.find(r=>r?.resultId===jobs[i].resultId);if(!result)throw Error('Unknown cached verifier result');results[i]=result;put(jobs[i],result,hashes);}}
    return results;
  };
  cached.seed=(jobs,results,tracks=[])=>{const hashes=context(jobs,tracks);for(const job of jobs)put(job,results.find(r=>r?.resultId===job.resultId),hashes);};
  cached.exportEntries=()=>[...cache.values()].map(entry=>{
    const b=entry.proof.binding,job={resultId:b.resultId,trackId:b.trackId,timeMs:b.timeMs,replayHash:b.replayHash,replay:entry.replay};
    return {job,result:rebind(entry,job)};
  });
  cached.stats=()=>({hits,misses,entries:cache.size,bytes});
  return cached;
}

// This only supplies bytes to an already hydrated current job, never a queue key or proof.
export function snapshotReplayFor(job,source) {
  const c=source?.canonical;
  if(!c||!Number.isSafeInteger(job?.uploadId)||job.uploadId<0||source.accountId!==job.accountId||source.trackId!==job.trackId||source.timeMs!==job.timeMs||
    c.uploadId!==job.uploadId||c.replayHash!==job.replayHash||source.replayHash!==job.replayHash||
    typeof source.replay!=='string'||source.replay.length>LIMITS.replayCharacters||sha256(source.replay)!==job.replayHash)return null;
  return source.replay;
}
