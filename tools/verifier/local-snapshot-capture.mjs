import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {verifyLocalSnapshot,writeLocalVerificationReceipt} from './local-snapshot-verification.mjs';
import {ledgerBinding,ledgerKey} from '../native-verification-ledger.mjs';
import {loadWeeklyTrustedTrack} from './weekly-track.mjs';

const require=createRequire(import.meta.url),{checkJob}=require('./replay.cjs');
const HASH=/^[a-f0-9]{64}$/,SHA=/^[a-f0-9]{40}$/,PERIOD=/^[A-Za-z0-9_-]{1,64}$/;
const digest=value=>createHash('sha256').update(value).digest('hex');
const demand=(value,message)=>{if(!value)throw Error('Captured native input: '+message);};
const positive=value=>Number.isSafeInteger(value)&&value>0;
const within=(root,file)=>file===root||file.startsWith(root+path.sep);
function holdFields(...sources) {
  const output={};
  for(const row of sources) {
    for(const key of ['needsReview','reviewHold','excluded','unscored'])if(row?.[key]===true)output[key]=true;
    for(const key of ['status','verificationStatus','validationState','verifiedState','reason']) {
      if(typeof row?.[key]==='string'&&/(?:held|hold|review|excluded|rejected|mismatch|unavailable_final)/.test(row[key]))output[key]=row[key];
    }
  }
  return output;
}

/** Current captured boards plus exact retained bytes. Missing payloads are
 * explicit coverage gaps; a present but differently bound payload is fatal.
 * No directory-wide Git scan, timestamp guessing, network or authority mutation.
 */
export async function loadCapturedNativeJobs({directory,allowExtendedLocal=false}={}) {
  demand(typeof directory==='string'&&path.isAbsolute(directory),'absolute capture directory required');
  const stat=await fs.lstat(directory);
  demand(stat.isDirectory()&&!stat.isSymbolicLink(),'unsafe capture directory');
  directory=await fs.realpath(directory);
  const files=new Map(),missingFiles=new Set(),gaps=[],jobs=[],normalBoards=[],eventBoards=[],canonicalRows=[],recordings=[];
  let knownBindings=0;
  async function read(relative,{optional=false}={}) {
    demand(/^[A-Za-z0-9_./-]+\.json$/.test(relative)&&!relative.split('/').includes('..'),'unsafe captured path');
    const file=path.join(directory,relative);
    let info;
    try{info=await fs.lstat(file);}catch(error){if(error.code==='ENOENT'&&optional){missingFiles.add(relative);return null;}throw error;}
    demand(info.isFile()&&!info.isSymbolicLink()&&info.size<=2*1024*1024&&within(directory,await fs.realpath(file)),'unsafe/oversized captured file');
    const bytes=await fs.readFile(file);files.set(relative,digest(bytes));return JSON.parse(bytes);
  }
  const manifest=await read('manifest.json');
  demand(manifest&&typeof manifest.tracks==='object'&&!Array.isArray(manifest.tracks),'source manifest tracks required');
  function add(value,raw,source) {
    demand(typeof value.replay==='string'&&digest(value.replay)===value.replayHash,'source replay hash mismatch: '+source);
    ledgerBinding(value);
    if(allowExtendedLocal) {
      try{checkJob(value);}catch{
        try{checkJob(value,'extended-local');value.resourceProfile='extended-local';}catch{/* Retain unsupported input for an unavailable decision. */}
      }
    }
    jobs.push(value);canonicalRows.push({...value,replay:undefined});
    // The event publication validators require these public presentation fields
    // from the retained envelope. They are not part of jobs or ledger proofs.
    const presentation=value.lane==='event'?Object.fromEntries(['name','carStyle'].filter(key=>typeof raw[key]==='string').map(key=>[key,raw[key]])):{};
    recordings.push({...value,...presentation,...holdFields(raw)});
  }
  for(const [trackId,record]of Object.entries(manifest.tracks)) {
    demand(HASH.test(trackId),'invalid track manifest identity');
    if(!record?.path){gaps.push({kind:'track-board-unavailable',trackId});continue;}
    demand(record.path===`tracks/${trackId}.json`,'track manifest path');
    const board=await read(record.path);
    demand(board?.trackId===trackId&&Array.isArray(board.entries)&&board.entries.length<=10000,'invalid captured track board');
    normalBoards.push(board);
    for(const row of board.entries) {
      knownBindings++;
      const accountId=row.accountId||row.userId,uploadId=row.uploadId??row.id;
      demand(HASH.test(accountId||'')&&positive(uploadId)&&positive(row.timeMs),'normal source identity');
      const canonicalPath=`canonical/${trackId}/${accountId}.json`,recordingPath=`recordings/${uploadId}.json`;
      const canonical=await read(canonicalPath,{optional:true}),raw=await read(recordingPath,{optional:true});
      if(!canonical||!raw){gaps.push({kind:'normal-replay-unavailable',trackId,accountId,uploadId});continue;}
      const frames=canonical.frames??canonical.raceTimeFrames??canonical.timeMs;
      demand(canonical.accountId===accountId&&canonical.trackId===trackId&&canonical.uploadId===uploadId&&canonical.timeMs===row.timeMs&&
        raw.accountId===accountId&&raw.trackId===trackId&&raw.frames===frames&&
        (raw.uploadId===undefined||raw.uploadId===uploadId)&&(raw.timeMs===undefined||raw.timeMs===row.timeMs)&&
        HASH.test(canonical.replayHash||'')&&raw.replayHash===canonical.replayHash&&
        (row.replayHash===undefined||row.replayHash===canonical.replayHash)&&
        (row.frames===undefined||row.frames===frames)&&(row.raceTimeFrames===undefined||row.raceTimeFrames===frames),
        'normal current/canonical/recording binding mismatch');
      add({lane:'normal',kind:'normal',source:recordingPath,accountId,trackId,timeMs:row.timeMs,frames,uploadId,replayHash:canonical.replayHash,
        replay:raw.recording,resultId:accountId+'_'+trackId,
        ...(canonical.ingestedAt!==undefined?{ingestedAt:canonical.ingestedAt}:raw.ingestedAt!==undefined?{ingestedAt:raw.ingestedAt}:{}),
        ...holdFields(row,canonical,raw)},raw,recordingPath);
    }
  }
  for(const [periodId,record]of Object.entries(manifest.events||{})) {
    demand(PERIOD.test(periodId)&&record?.path===`events/${periodId}.json`,'event manifest identity/path');
    const board=await read(record.path);eventBoards.push(board);
    if(periodId==='permanent-rolling-hills')continue;
    demand(board?.id===periodId&&board.period?.id===periodId&&HASH.test(board.period.trackId||'')&&Array.isArray(board.entries),'event source board binding');
    for(const [rows,pending]of [[board.entries,false],[board.pendingPlaybacks||[],true]])for(const row of rows) {
      knownBindings++;
      demand(HASH.test(row.accountId||'')&&positive(row.timeMs),'event source identity');
      const relative=pending?`event-playbacks/${periodId}/${row.runId}.json`:`event-replays/${periodId}/${row.accountId}.json`;
      if(pending)demand(HASH.test(row.runId||'')&&row.pending===true&&row.verified===false&&row.eventRpEligible===false,'pending source is not a waiting playback');
      const raw=await read(relative,{optional:true});
      if(!raw){gaps.push({kind:'event-replay-unavailable',periodId,accountId:row.accountId,...(pending?{runId:row.runId}:{})});continue;}
      demand(raw.periodId===periodId&&raw.accountId===row.accountId&&raw.trackId===board.period.trackId&&raw.timeMs===row.timeMs&&
        raw.frames===row.timeMs&&HASH.test(raw.runId||'')&&HASH.test(raw.replayHash||'')&&
        (row.runId===undefined||row.runId===raw.runId)&&(row.replayHash===undefined||row.replayHash===raw.replayHash)&&
        (!pending||raw.pending===true&&raw.verified===false&&raw.eventRpEligible===false&&raw.submittedAt===row.submittedAt),
        'event retained binding mismatch');
      add({lane:'event',kind:pending?'event-pending':'event',source:relative,accountId:row.accountId,trackId:raw.trackId,periodId,runId:raw.runId,timeMs:row.timeMs,
        frames:raw.frames,uploadId:raw.uploadId??null,replayHash:raw.replayHash,replay:raw.replay,resultId:raw.runId,
        ...(row.submittedAt!==undefined?{submittedAt:row.submittedAt}:{}),
        ...(raw.ingestedAt!==undefined?{ingestedAt:raw.ingestedAt}:{}),
        ...holdFields(row,raw)},raw,relative);
    }
  }
  demand(jobs.length<=100000&&new Set(jobs.map(value=>ledgerKey(ledgerBinding(value)))).size===jobs.length,'duplicate/oversized captured inventory');
  const fileBindings=[...files].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([file,sha256])=>({file,sha256}));
  return {directory,jobs,normalBoards,eventBoards,canonicalRows,recordings,fileBindings,
    missingFiles:[...missingFiles].sort(),captureSha256:digest(JSON.stringify(fileBindings)),coverage:{scope:'current-captured-board-bindings',knownBindings,
      availableBindings:jobs.length,missingBindings:knownBindings-jobs.length,unavailableBoards:gaps.filter(value=>value.kind==='track-board-unavailable').length,
      complete:gaps.length===0,gaps}};
}

export async function defaultCapturedReviewFactory({jobs,sourceBinding,policy,previouslyAccepted=[]}) {
  const {createCapturedControlReview}=await import('./captured-controls.mjs');
  return createCapturedControlReview({allJobs:jobs,sourceBinding,policy,previouslyAccepted});
}

/** The updater calls this only after source capture/replay export. Default review
 * is Hegel's full-inventory policy, never batch/top-ten or implicit approval.
 */
export async function verifyCapturedSnapshot({root,directory,ledgerRoot,expectedManifestHash,sourceCommit,
  allowExtendedLocal=false,reviewFactory=defaultCapturedReviewFactory,review,...options}={}) {
  demand(SHA.test(sourceCommit||''),'explicit pinned source commit required');
  const inputs=await loadCapturedNativeJobs({directory,allowExtendedLocal});
  const sourceBinding={sourceCommit,captureSha256:inputs.captureSha256};
  let reviewer;
  const currentReview=review || (async context=>{
    reviewer ||= await reviewFactory({jobs:context.allJobs,sourceBinding:Object.freeze({...sourceBinding}),policy:context.policy});
    demand(typeof reviewer==='function','captured-controls review capability required');
    return reviewer(context);
  });
  const verification=await verifyLocalSnapshot({...options,root,jobs:inputs.jobs,sourceBinding,ledgerRoot,expectedManifestHash,
    trustedTracks:options.trustedTracks || loadWeeklyTrustedTrack(root,inputs.jobs),review:currentReview});
  for(const binding of inputs.fileBindings) {
    demand(digest(await fs.readFile(path.join(inputs.directory,binding.file)))===binding.sha256,'source changed during native verification');
  }
  for(const relative of inputs.missingFiles) {
    const exists=await fs.lstat(path.join(inputs.directory,relative)).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
    demand(!exists,'source materialized during native verification');
  }
  return {verification:{...verification,sourceCoverage:inputs.coverage},inputs};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const args=process.argv.slice(2),options={root:path.resolve(fileURLToPath(new URL('../..',import.meta.url)))};
  let report;
  for(let index=0;index<args.length;index++) {
    const key=args[index];
    if(key==='--allow-extended-local'){options.allowExtendedLocal=true;continue;}
    const value=args[++index];demand(typeof value==='string','missing CLI value');
    if(key==='--directory')options.directory=path.resolve(value);
    else if(key==='--ledger-root')options.ledgerRoot=path.resolve(value);
    else if(key==='--source-commit')options.sourceCommit=value;
    else if(key==='--ledger-manifest-hash')options.expectedManifestHash=value==='none'?null:value;
    else if(key==='--report')report=path.resolve(value);
    else throw Error('Unknown captured verification option');
  }
  demand(report&&options.directory&&options.ledgerRoot&&options.expectedManifestHash!==undefined,'Explicit directory, ledger root/hash, source commit and private report required');
  const result=await verifyCapturedSnapshot(options);
  await writeLocalVerificationReceipt(report,result.verification);
  console.log(JSON.stringify({complete:result.verification.complete,counts:result.verification.counts,
    sourceCoverage:result.verification.sourceCoverage,ledgerManifestHash:result.verification.ledgerManifestHash}));
}
