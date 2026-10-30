import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {loadSnapshotAuditInputs} from './snapshot-audit.mjs';
import {loadWeeklyTrustedTrack} from './weekly-track.mjs';
import {verifiedTrackCounts} from './runner.mjs';
import {decodeSnapshot} from '../snapshot-package.mjs';
const require=createRequire(import.meta.url),{checkJob}=require('./replay.cjs');
const {partitionTrustedTracks}=require('./kodub-track.cjs');
const ROOT=fileURLToPath(new URL('../..',import.meta.url));
const count=(object,key)=>{object[key]=(object[key]||0)+1;};

export function summarizeSnapshotReadiness(audit,{staticTracks=[],trustedTracks=[],eventPeriods=[]}={}) {
  const assets=new Map(staticTracks.map(t=>[t.id,{kind:'pinned-static',hash:t.hash}]));
  for(let i=0;i<trustedTracks.length;i+=16){
    const chunk=trustedTracks.slice(i,i+16),p=partitionTrustedTracks(chunk,new Set(chunk.map(t=>t.trackId)));
    for(const t of p.accepted)assets.set(t.expectedId,{kind:'checked-kodub',hash:t.hash});
    for(const [id,reason]of p.rejected)assets.set(id,{kind:'rejected-kodub',reason});
  }
  const tracks=new Map(),issueCounts={};
  for(const issue of audit.issues)count(issueCounts,issue.kind);
  for(const job of [...audit.jobs,...audit.pendingJobs]){
    const row=tracks.get(job.trackId)||{trackId:job.trackId,asset:assets.get(job.trackId)||{kind:'unmapped-trusted-identity'},
      jobs:0,kinds:{},bindings:{},inputReasons:{},periodIds:[]};
    row.jobs++;count(row.kinds,job.kind);count(row.bindings,job.bindingStatus);
    if(job.periodId&&!row.periodIds.includes(job.periodId))row.periodIds.push(job.periodId);
    try{checkJob(job);count(row.inputReasons,'input_valid');}catch(error){count(row.inputReasons,error.reason||'input_validation_failed');}
    tracks.set(job.trackId,row);
  }
  const names=new Map(verifiedTrackCounts(Object.fromEntries([...tracks.keys()].map(id=>[id,1]))).map(t=>[t.trackId,t.trackName]));
  const totals={jobs:0,inputValid:0,unmappedIdentityJobs:0,rejectedAssetJobs:0};
  for(const row of tracks.values()){
    row.name=names.get(row.trackId)||row.trackId;row.periodIds.sort();totals.jobs+=row.jobs;totals.inputValid+=row.inputReasons.input_valid||0;
    if(row.asset.kind==='unmapped-trusted-identity')totals.unmappedIdentityJobs+=row.jobs;
    if(row.asset.kind==='rejected-kodub')totals.rejectedAssetJobs+=row.jobs;
  }
  return {schema:'polytrack-offline-readiness-v1',offlineOnly:true,publicationAuthorized:false,nativeSimulationPerformed:false,
    manifest:audit.manifest,coverage:audit.coverage,issueCounts,totals,eventPeriods,
    tracks:[...tracks.values()].sort((a,b)=>a.trackId.localeCompare(b.trackId))};
}

export async function inspectSnapshotReadiness({root=ROOT,report}={}) {
  const audit=await loadSnapshotAuditInputs({root});
  const geometry=JSON.parse(await fs.readFile(path.join(root,'tools/verifier/track-geometry.json'),'utf8'));
  const manifest=JSON.parse(await fs.readFile(path.join(root,'tools/verifier/engine-manifest.json'),'utf8'));
  const catalog=JSON.parse(await fs.readFile(path.join(root,'extra-tracks/catalog.json'),'utf8'));
  const staticTracks=[...geometry.tracks.filter(t=>manifest.tracks[t.name]===t.hash),
    ...catalog.filter(t=>manifest.tracks[t.trackPath]).map(t=>({id:t.trackId,hash:manifest.tracks[t.trackPath]}))];
  const index=JSON.parse(await fs.readFile(path.join(audit.snapshotDir,'index.json'),'utf8')),eventPeriods=[];
  for(const [logical,item]of Object.entries(index.files))if(/^events\/[^/]+\.json$/.test(logical)){
    const board=JSON.parse(Buffer.from(await decodeSnapshot(await fs.readFile(path.join(audit.snapshotDir,item.path)))).toString('utf8'));
    eventPeriods.push({id:board.id,trackId:board.period?.trackId||board.trackId||null,kind:board.period?.kind||board.kind||null,
      archived:board.archived===true,entries:board.entries?.length||0,pending:board.pendingPlaybacks?.length||0,
      endsAt:board.period?.endsAt||null});
  }
  const result=summarizeSnapshotReadiness(audit,{staticTracks,
    trustedTracks:loadWeeklyTrustedTrack(root,[...audit.jobs,...audit.pendingJobs]),eventPeriods});
  if(report){
    if(!path.isAbsolute(report))throw Error('Readiness report must be an absolute private path');
    const target=path.join(await fs.realpath(path.dirname(report)),path.basename(report)),rel=path.relative(await fs.realpath(root),target);
    if(!rel||!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep))throw Error('Readiness report must be outside repository');
    await fs.writeFile(target,JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
  }
  return result;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  if(process.argv.length!==4||process.argv[2]!=='--report')throw Error('Usage: node snapshot-readiness.mjs --report <absolute-private-json>');
  const result=await inspectSnapshotReadiness({report:process.argv[3]});
  console.log(JSON.stringify({generation:result.manifest.generation,coverage:result.coverage,totals:result.totals,
    issueCounts:result.issueCounts,tracks:result.tracks.length,eventPeriods:result.eventPeriods.length}));
}
