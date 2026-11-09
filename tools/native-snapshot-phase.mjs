import {restoreRetainedPendingPlaybacks} from './restore-retained-pending-playbacks.mjs';
import {assertTrustedPublishedEventTotalsBaseline} from './published-event-totals-baseline.mjs';
import {publishedEventPairingTotals} from './published-event-pairing.mjs';
import {refreshCapturedEventHighlights} from './refresh-event-highlights.mjs';
import {LEGACY_ARCHIVE_REPLAY_EXCEPTIONS,annotateLegacyArchiveReplayBoard} from './legacy-archive-replay-exceptions.mjs';
import fs from 'node:fs/promises';
import {cloneBounded} from './bounded-clone.mjs';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {readLedger,writeLedger,ledgerBinding,ledgerKey,ledgerDisposition,applyLedgerToBoard} from './native-verification-ledger.mjs';
import {buildNativeVerificationPolicy} from './native-verification-policy.mjs';
import {readCapturedNormalLedgerRows,applyNativeLedgerToCapturedTracks,publicEventBackup} from './public-snapshot-backup.mjs';
import {createNativeEventBaseline,completeCapturedEmptyEventBoard,projectNativeEventSnapshot,projectRetainedEventVerifications,projectNativeEventTotals,reconcileNativeEventTotalsFromPublished,deriveCapturedNativeRollingHills,nativeEventSourceHash} from './native-event-snapshot.mjs';
import {rebuildSnapshotOverall} from './rebuild-snapshot-overall.mjs';
import {buildProfileSnapshotResults} from './build-profile-snapshot-results.mjs';
import {loadCapturedNativeJobs,defaultCapturedReviewFactory} from './verifier/local-snapshot-capture.mjs';
import {prioritizeNativeTargets} from './verifier/native-verification-priority.mjs';
import {verifyLocalSnapshot,nativeLedgerPublicationFiles,withOfflineVerification} from './verifier/local-snapshot-verification.mjs';
import {loadWeeklyTrustedTrack} from './verifier/weekly-track.mjs';
import {PERMANENT_ROLLING_HILLS} from '../workers/ranked/src/permanent-rolling-hills.js';

const HASH=/^[a-f0-9]{64}$/,SHA=/^[a-f0-9]{40}$/;
const sha=value=>createHash('sha256').update(value).digest('hex');
const demand=(value,message)=>{if(!value)throw Error('Native snapshot phase: '+message);};
const read=async(directory,file)=>JSON.parse(await fs.readFile(path.join(directory,file),'utf8'));
const optional=async(directory,file)=>{try{return await read(directory,file);}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const rootFor=(root,name)=>path.join(root,'local-reports',name);
async function json(directory,file,value){
  await atomicBytes(path.join(directory,file),Buffer.from(JSON.stringify(value)+'\n'));
}
async function atomicBytes(target,bytes){
  await fs.mkdir(path.dirname(target),{recursive:true});
  const temporary=target+'.'+randomUUID()+'.tmp';await fs.writeFile(temporary,bytes,{flag:'wx'});
  try{await fs.rename(temporary,target);}catch(error){await fs.rm(temporary,{force:true});throw error;}
}
async function optionalBytes(file){try{return await fs.readFile(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function publishCohort({root,directory,candidate,ledgerRoot,expectedManifestHash,manifestHash,publishPointer}){
  // One exclusive ledger lock covers CAS, pointer and candidate promotion. Keep
  // the old directory and exact metadata bytes until every promotion succeeds.
  const liveLedger=path.join(root,'verification-ledger'),pointerFile=path.join(root,'verification-ledger-current.json');
  const sibling=directory+'.native-next-'+randomUUID(),backup=directory+'.native-before-'+randomUUID();
  demand(path.dirname(sibling)===path.dirname(directory)&&path.dirname(backup)===path.dirname(directory),'unsafe cohort paths');
  demand(directory!==root&&!root.startsWith(directory+path.sep)&&directory!==path.parse(directory).root,'unsafe candidate target');
  const existed=await fs.lstat(liveLedger).then(stat=>{demand(stat.isDirectory()&&!stat.isSymbolicLink(),'unsafe live ledger');return true;},error=>{if(error.code==='ENOENT')return false;throw error;});
  const nextBytes=await fs.readFile(path.join(ledgerRoot,'manifest.json'));
  demand(sha(nextBytes)===manifestHash,'private ledger changed before publication');
  readLedger({root:ledgerRoot,expectedManifestHash:manifestHash});
  let lock,moved=false,installed=false,committed=false,previousManifest,previousPointer,shardsExisted=false,mutated=false;
  const added=[];
  try{
    // Move only the disposable private candidate, never the live directory.
    // A cross-volume runner retains the existing copy-and-swap fallback.
    demand(path.basename(path.dirname(candidate)).startsWith('polytrack-native-phase-')&&
      path.dirname(path.dirname(candidate))===os.tmpdir(),'unsafe private candidate move');
    try{await fs.rename(candidate,sibling);}
    catch(error){if(error.code!=='EXDEV')throw error;await fs.cp(candidate,sibling,{recursive:true,dereference:false,errorOnExist:true,force:false});}
    await fs.mkdir(liveLedger,{recursive:true});
    lock=await fs.open(path.join(liveLedger,'.writer.lock'),'wx');
    previousManifest=await optionalBytes(path.join(liveLedger,'manifest.json'));
    previousPointer=await optionalBytes(pointerFile);
    demand((previousManifest?sha(previousManifest):null)===expectedManifestHash,'root ledger CAS mismatch');
    demand((previousPointer?JSON.parse(previousPointer).manifestHash:null)===expectedManifestHash,'root pointer CAS mismatch');
    const shards=path.join(liveLedger,'shards');
    shardsExisted=await fs.lstat(shards).then(stat=>{demand(stat.isDirectory()&&!stat.isSymbolicLink(),'unsafe ledger shards');return true;},error=>{if(error.code==='ENOENT')return false;throw error;});
    await fs.mkdir(shards,{recursive:true});mutated=true;
    for(const shard of JSON.parse(nextBytes).shards){
      const file=path.join(shards,shard.hash+'.json'),bytes=await fs.readFile(path.join(ledgerRoot,'shards',shard.hash+'.json'));
      const previous=await optionalBytes(file);
      if(previous)demand(previous.equals(bytes),'immutable ledger shard conflict');
      else{added.push(file);await fs.writeFile(file,bytes,{flag:'wx'});}
    }
    await atomicBytes(path.join(liveLedger,'manifest.json'),nextBytes);
    await publishPointer({root,pointer:{schemaVersion:1,directory:'verification-ledger',manifestHash}});
    await fs.rename(directory,backup);moved=true;
    await fs.rename(sibling,directory);installed=true;committed=true;
  }catch(error){
    if(moved){
      if(installed)await fs.rm(directory,{recursive:true,force:true});
      await fs.rename(backup,directory);moved=false;
    }
    if(mutated){
      if(previousManifest)await atomicBytes(path.join(liveLedger,'manifest.json'),previousManifest);
      else await fs.rm(path.join(liveLedger,'manifest.json'),{force:true});
      if(previousPointer)await atomicBytes(pointerFile,previousPointer);
      else await fs.rm(pointerFile,{force:true});
      for(const file of added)await fs.rm(file,{force:true});
      if(!shardsExisted)await fs.rmdir(path.join(liveLedger,'shards'));
    }
    throw error;
  }finally{
    if(lock){await lock.close();await fs.unlink(path.join(liveLedger,'.writer.lock'));}
    if(!existed&&!committed)await fs.rmdir(liveLedger).catch(error=>{if(!['ENOENT','ENOTEMPTY','EEXIST'].includes(error.code))throw error;});
    await fs.rm(sibling,{recursive:true,force:true});
    // Cleanup after a successful swap cannot turn it into a failed publication.
    if(committed)await fs.rm(backup,{recursive:true,force:true}).catch(()=>{});
  }
}
async function privateRoot(){return fs.mkdtemp(path.join(os.tmpdir(),'polytrack-native-phase-'));}
async function removePrivate(directory){
  demand(path.dirname(directory)===os.tmpdir()&&path.basename(directory).startsWith('polytrack-native-phase-'),'unsafe private cleanup');
  await fs.rm(directory,{recursive:true,force:true});
}
async function copyLedger(ledgerRoot,destination,manifestHash){
  readLedger({root:ledgerRoot,expectedManifestHash:manifestHash});
  const bytes=await fs.readFile(path.join(ledgerRoot,'manifest.json'));demand(sha(bytes)===manifestHash,'ledger changed while cloning');
  const manifest=JSON.parse(bytes);await fs.mkdir(path.join(destination,'shards'),{recursive:true});
  for(const shard of manifest.shards)await fs.copyFile(path.join(ledgerRoot,'shards',shard.hash+'.json'),path.join(destination,'shards',shard.hash+'.json'));
  await fs.writeFile(path.join(destination,'manifest.json'),bytes);
  readLedger({root:destination,expectedManifestHash:manifestHash});
}

// Recovery evidence is private data, never a publication pointer or proof admission.
async function retainCompletedProofs({root,ledgerRoot,sourceBinding,manifestHash,previousManifestHash,evidence=null}){
  let parent=root;
  for(const name of ['local-reports','native-proof-checkpoints']){
    parent=path.join(parent,name);await fs.mkdir(parent,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});
    const stat=await fs.lstat(parent);demand(stat.isDirectory()&&!stat.isSymbolicLink(),'unsafe private proof checkpoint parent');
  }
  const directory=await fs.mkdtemp(path.join(parent,'completed-'));
  try{
    await copyLedger(ledgerRoot,path.join(directory,'ledger'),manifestHash);
    // Flush the copied immutable ledger before the receipt makes this boundary
    // discoverable. This is recovery evidence, not an admission/resume API.
    const copied=JSON.parse(await fs.readFile(path.join(directory,'ledger/manifest.json'),'utf8'));
    for(const name of [...copied.shards.map(shard=>'shards/'+shard.hash+'.json'),'manifest.json']){
      const handle=await fs.open(path.join(directory,'ledger',name),'r+');try{await handle.sync();}finally{await handle.close();}
    }
    let evidenceSha256=null;
    if(evidence){
      const bytes=Buffer.from(JSON.stringify(evidence)+'\n');evidenceSha256=sha(bytes);
      await fs.writeFile(path.join(directory,'verification.json'),bytes,{flag:'wx',mode:0o600,flush:true});
    }
    const receipt={schemaVersion:1,kind:'private-native-proof-checkpoint',authority:false,
      sourceBinding,ledgerManifestHash:manifestHash,previousLedgerManifestHash:previousManifestHash,
      ...(evidenceSha256?{evidenceFile:'verification.json',evidenceSha256}:{})};
    await fs.writeFile(path.join(directory,'receipt.json'),JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600,flush:true});
    return {directory,...receipt};
  }catch(error){await fs.rm(directory,{recursive:true,force:true});throw error;}
}

/** Before capture: local authority/context only, never credentials or transport. */
export async function prepareNativeSnapshotCapture({root,directory,buildPolicy=buildNativeVerificationPolicy}={}){
  demand(path.isAbsolute(root||'')&&path.isAbsolute(directory||''),'explicit absolute context paths required');
  const manifest=await read(directory,'manifest.json'),pointer=await optional(root,'verification-ledger-current.json');
  let ledger,ledgerRoot,bootstrapRoot;
  if(pointer){
    await nativeLedgerPublicationFiles(root);ledgerRoot=path.join(root,'verification-ledger');
    ledger=readLedger({root:ledgerRoot,expectedManifestHash:pointer.manifestHash});
  }else{
    demand(!manifest.nativeVerificationLedger,'snapshot authority has no pinned root ledger');
    demand(!await optional(path.join(root,'verification-ledger'),'manifest.json'),'orphan root ledger is not a trust anchor');
    bootstrapRoot=await privateRoot();ledgerRoot=path.join(bootstrapRoot,'ledger');
    ledger=writeLedger({root:ledgerRoot,entries:[],expectedManifestHash:null});
  }
  const canonicalRows=await readCapturedNormalLedgerRows({directory,allowMissingCanonical:true});
  const policy=await buildPolicy({root,jobs:canonicalRows,entries:ledger.entries});
  const eventSources=new Map(),eventSourcePins=manifest.nativeEventSources||{},retainedNativeEntries={},retainedJobs=[],overlaidSourceHashes={};
  // Public-safe, Node-consumed source projections travel inside the immutable
  // snapshot, not an ignored local cache. No full/private Worker periods here.
  const cache=path.join(directory,'native-event-source');
  for(const [id,pin]of Object.entries(eventSourcePins)){
    demand(HASH.test(pin),'invalid event source companion pin');
    const file=path.join(cache,pin+'.json');let bytes;
    try{bytes=await fs.readFile(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    demand(bytes.length<=2*1024*1024&&sha(bytes)===pin,'event source companion hash mismatch');
    const value=JSON.parse(bytes);demand(Object.keys(value).sort().join('|')==='board|schemaVersion'&&value.schemaVersion===1&&value.board?.id===id&&
      !value.board.nativeEventOverlay&&isDeepStrictEqual(value.board,publicEventBackup(value.board,id)),'event source companion identity/schema');
    eventSources.set(id,value.board);
  }
  // Only a previously compiled package supplies retained native admissions.
  // A new ledger can also match raw legacy rows whose dates were never exported.
  for(const [id,record]of Object.entries(manifest.nativeVerificationLedger?manifest.events||{}:{})){
    if(id==='permanent-rolling-hills')continue;
    const sourceBytes=await fs.readFile(path.join(directory,record.path)),previousBoard=JSON.parse(sourceBytes);
    if(previousBoard.nativeEventOverlay)overlaidSourceHashes[id]=nativeEventSourceHash(publicEventBackup(previousBoard,id));
    const media=[],previousRows=[...(previousBoard.entries||[]).map(row=>({row,pending:false})),
      ...(previousBoard.pendingPlaybacks||[]).map(row=>({row,pending:true}))];
    for(const {row,pending} of previousRows){
      if(!HASH.test(row.runId||'')||!HASH.test(row.replayHash||'')||!Number.isSafeInteger(row.submittedAt))continue;
      const relative=pending?`event-playbacks/${id}/${row.runId}.json`:`event-replays/${id}/${row.accountId}.json`,raw=await optional(directory,relative);
      if(!raw)continue;
      const job={lane:'event',kind:pending?'event-pending':'event',source:relative,accountId:row.accountId,trackId:previousBoard.period.trackId,
        periodId:id,runId:row.runId,timeMs:row.timeMs,frames:row.timeMs,uploadId:raw.uploadId??null,replayHash:row.replayHash,
        replay:raw.replay,submittedAt:row.submittedAt,resultId:row.runId};
      const entry=ledger.entries.find(value=>value.key===ledgerKey(ledgerBinding(job)));
      if(!entry||ledgerDisposition(entry)!=='verified')continue;
      if(pending)demand(row.pending===true&&row.verified===false&&row.eventRpEligible===false&&
        raw.pending===true&&raw.verified===false&&raw.eventRpEligible===false&&raw.submittedAt===row.submittedAt,
        'protected retained pending status/date mismatch');
      demand(raw.periodId===id&&raw.trackId===job.trackId&&raw.accountId===job.accountId&&raw.runId===job.runId&&
        raw.timeMs===job.timeMs&&raw.frames===job.frames&&raw.replayHash===job.replayHash&&sha(raw.replay)===job.replayHash,
        'protected retained event binding mismatch');
      const submittedAt=raw.submittedAt??raw.runCreatedAt;
      demand(submittedAt===row.submittedAt,'protected retained event submission date mismatch');
      const retained={...raw,submittedAt,uploadId:job.uploadId};
      const gate=applyLedgerToBoard({board:{periodId:id,trackId:job.trackId,entries:[{...row,...ledgerBinding(job)}]},
        ledger,policy,canonicalRows:[job],recordings:[{...raw,...job,replay:raw.replay}],lane:'event'});
      if(gate.report.verified!==1)continue;
      media.push(retained);retainedJobs.push(job);
    }
    // Missing/incompatible media must defer a protected native admission, never erase it.
    const hasNative=previousRows.some(({row})=>ledger.entries.some(entry=>entry.binding.lane==='event'&&entry.binding.periodId===id&&
      entry.binding.accountId===row.accountId&&entry.binding.timeMs===row.timeMs&&
      (row.runId===undefined||entry.binding.runId===row.runId)));
    if(media.length||hasNative)retainedNativeEntries[id]={previousBoard,recordings:media,expectedSourceHash:sha(sourceBytes),sourceBytes};
  }
  return {ledger,ledgerRoot,policy,canonicalRows,rootManifestHash:pointer?.manifestHash??null,
    bootstrapRoot,eventSources,eventSourcePins,sourceManifest:manifest,retainedNativeEntries,retainedJobs,overlaidSourceHashes};
}

async function compileEvents({root,directory,inputs,ledger,policy,captureContext,publishedEventTotalsBaseline=null}){
  const manifest=await read(directory,'manifest.json'),serverTotals=await optional(directory,'event-totals.json');
  const periods=inputs.eventBoards.filter(board=>board.id!=='permanent-rolling-hills');
  if(!serverTotals){demand(periods.length===0,'event totals source unavailable');return {periods:0,ready:true};}
  const baseline=publishedEventTotalsBaseline===null?null:assertTrustedPublishedEventTotalsBaseline(publishedEventTotalsBaseline);
  // An offline public-package retry can pair projections with the exact branded
  // published totals. Never strip an overlay or pretend it is a Worker capture.
  const exactPublished=baseline!==null&&isDeepStrictEqual(serverTotals,baseline.totals);
  demand(!serverTotals.nativeEventOverlay||exactPublished,'fresh pristine or exact trusted published totals required');
  const pairingTotals=exactPublished?publishedEventPairingTotals(baseline,serverTotals):serverTotals;
  const projections=[],pins={},cache=path.join(directory,'native-event-source');
  for(const captured of periods){
    if(LEGACY_ARCHIVE_REPLAY_EXCEPTIONS.some(pin=>pin.periodId===captured.id)){
      const board=annotateLegacyArchiveReplayBoard({sourcePath:'events/'+captured.id+'.json',board:captured});
      demand(board.entries.some(row=>row.replayUnavailable===true),'legacy archive source changed');
      projections.push({board,promotedReplays:[],totalsEligible:false});
      continue;
    }
    const projected=publicEventBackup(captured,captured.id);
    const cachedOverlay=captureContext.overlaidSourceHashes?.[captured.id]===nativeEventSourceHash(projected);
    const source=captured.nativeEventOverlay||cachedOverlay?captureContext.eventSources.get(captured.id):captured;
    demand(source&&!source.nativeEventOverlay,'pristine event source companion unavailable: '+captured.id);
    // Public projection is the only companion payload; full Worker periods and
    // raw exports/credentials never enter the companion cache or public package.
    const projectedSource=publicEventBackup(source,source.id);
    const board=completeCapturedEmptyEventBoard({serverBoard:projectedSource,checkedAt:manifest.events[source.id]?.checkedAt})||projectedSource;
    const dependencies={ledger,policy,canonicalRows:inputs.canonicalRows.filter(value=>value.lane==='event'),recordings:inputs.recordings.filter(value=>value.lane==='event')};
    const exact=board.complete===true&&board.totalEntries===board.entries.length&&board.sourceComplete!==false;
    const projection=exact?await projectNativeEventSnapshot({...dependencies,
      baseline:createNativeEventBaseline({serverBoard:board,serverTotals:pairingTotals,expectedSourceHash:nativeEventSourceHash(board)}),
      retainedNativeEntries:captureContext.retainedNativeEntries?.[captured.id]}):await projectRetainedEventVerifications({...dependencies,
      serverBoard:board,expectedSourceHash:nativeEventSourceHash(board)});
    demand(projection.ready!==false,'approved event payload unavailable: '+captured.id);projections.push(projection);
    const bytes=Buffer.from(JSON.stringify({schemaVersion:1,board})+'\n'),pin=sha(bytes);
    await fs.mkdir(cache,{recursive:true});await fs.writeFile(path.join(cache,pin+'.json'),bytes,{mode:0o600});pins[board.id]=pin;
  }
  const rollingId=PERMANENT_ROLLING_HILLS.trackId;
  const rolling=await optional(directory,`tracks/${rollingId}.json`);
  demand(rolling,'complete Rolling Hills normal board required for event totals');
  const capturedRollingBoard=deriveCapturedNativeRollingHills({board:rolling,expectedSourceHash:nativeEventSourceHash(rolling)});
  const usePublished=exactPublished||baseline!==null&&serverTotals.updatedAt<baseline.totals.updatedAt;
  const dependencies={serverTotals:pairingTotals,projections:projections.filter(value=>value.totalsEligible!==false),capturedRollingBoard};
  const combined=usePublished?reconcileNativeEventTotalsFromPublished({...dependencies,projections,publishedBaseline:baseline}):projectNativeEventTotals(dependencies);
  for(const projection of combined.publicationProjections||projections){
    const board=projection.board,id=board.id;
    if(usePublished&&projection.totalsEligible===false&&board.nativeEventOverlay){
      const oldPin=captureContext.eventSourcePins?.[id],source=captureContext.eventSources.get(id);
      demand(HASH.test(oldPin||'')&&source&&nativeEventSourceHash(source)===board.nativeEventOverlay.baselineDigest,'retained published event source companion unavailable: '+id);
      const previousBytes=await fs.readFile(path.join(cache,oldPin+'.json'));
      demand(sha(previousBytes)===oldPin,'retained published event source companion changed: '+id);pins[id]=oldPin;
    }
    await json(directory,`events/${id}.json`,board);
    manifest.events[id]={...manifest.events[id],path:'events/'+id+'.json',updatedAt:board.updatedAt};
    for(const replay of projection.promotedReplays){
      const relative=`event-replays/${id}/${replay.accountId}.json`;
      await json(directory,relative,replay);manifest.eventReplays||={};
      manifest.eventReplays[relative]={path:relative,periodId:id,accountId:replay.accountId,timeMs:replay.timeMs,replayHash:replay.replayHash};
    }
  }
  await json(directory,'event-totals.json',combined.totals);
  await json(directory,'events/permanent-rolling-hills.json',combined.rollingBoard);
  manifest.nativeEventSources=pins;await json(directory,'manifest.json',manifest);
  await restoreRetainedPendingPlaybacks({root,directory});
  await refreshCapturedEventHighlights(directory);
  for(const file of await fs.readdir(cache)){
    demand(/^[a-f0-9]{64}\.json$/.test(file),'unknown file in public event-source namespace');
    if(!Object.values(pins).includes(file.slice(0,-5)))await fs.unlink(path.join(cache,file));
  }
  return {periods:projections.length,ready:true};
}

/** Post-export-only production phase. No source capture, backend verdict writes
 * or publication is performed here. Parent packs/commits only after return.
 */
export async function runNativeSnapshotPhase(options={}){
  return options.reuseOnly===true
    ?withOfflineVerification(()=>runNativeSnapshotPhaseImpl(options))
    :runNativeSnapshotPhaseImpl(options);
}

/** A live-process capability, not a serialized receipt/checkpoint admission API.
 * The caller must dispose it. Failed compilation may retry the same attestations;
 * successful compilation, concurrent calls and use after disposal are rejected.
 */
export async function verifyNativeSnapshotPhase(options={}){
  demand(options.reuseOnly!==true,'fresh verification required for a retry capability');
  return runNativeSnapshotPhaseImpl(options,true);
}

async function runNativeSnapshotPhaseImpl({root,directory,sourceCommit,maxJobs=512,maxRuntimeMs=480000,reuseOnly=false,publicationRoot=root,
  expectedCaptureSha256=null,expectedScoringSha256=null,
  verify,now=Date.now,captureContext,publishedEventTotalsBaseline=null,buildPolicy=buildNativeVerificationPolicy,reviewFactory=defaultCapturedReviewFactory,
  validateEngine,applyNormal=applyNativeLedgerToCapturedTracks,eventCompiler=compileEvents,
  rebuild=rebuildSnapshotOverall,preflight=rebuildSnapshotOverall,buildProfiles=buildProfileSnapshotResults,proofCheckpoint=null,progressCheckpoint=null,nativeCompleted=null,
  publishPointer=({root,pointer})=>json(root,'verification-ledger-current.json',pointer)}={},verificationOnly=false){
  demand(path.isAbsolute(root||'')&&path.isAbsolute(directory||'')&&SHA.test(sourceCommit||''),'pinned absolute phase source required');
  demand(path.isAbsolute(publicationRoot||''),'absolute local publication root required');
  demand(typeof reuseOnly==='boolean','explicit stored-proof mode required');
  demand(proofCheckpoint===null||typeof proofCheckpoint==='function','invalid proof checkpoint capability');
  demand(progressCheckpoint===null||typeof progressCheckpoint==='function','invalid progress checkpoint capability');
  demand(nativeCompleted===null||typeof nativeCompleted==='function'&&!reuseOnly,'invalid native completion capability');
  demand(typeof preflight==='function','read-only scoring preflight required');
  demand((expectedCaptureSha256===null||HASH.test(expectedCaptureSha256))&&(expectedScoringSha256===null||HASH.test(expectedScoringSha256)),'invalid prepared source pins');
  const timings={};
  const timed=async(name,task)=>{const start=performance.now();try{return await task();}finally{timings[name]=Math.round(performance.now()-start);}};
  const context=captureContext||await prepareNativeSnapshotCapture({root,directory,buildPolicy});
  const temporary=await privateRoot(),candidate=path.join(temporary,'candidate'),ledgerRoot=path.join(temporary,'ledger');
  let retained=false;
  try{
    await timed('copyMs',()=>cloneBounded({source:directory,destination:candidate}));
    const scoringPreflight=await timed('scoringPreflightMs',()=>preflight({directory:candidate,now,validateOnly:true}));
    demand(expectedScoringSha256===null||scoringPreflight.sourceSha256===expectedScoringSha256,'scoring inputs changed since preparation');
    await copyLedger(context.ledgerRoot,ledgerRoot,context.ledger.manifestHash);
    const inputs=await timed('hydrateMs',()=>loadCapturedNativeJobs({directory:candidate,allowExtendedLocal:true}));
    const totalsInput=await optional(candidate,'event-totals.json');
    if(totalsInput?.nativeEventOverlay){
      const published=publishedEventTotalsBaseline&&assertTrustedPublishedEventTotalsBaseline(publishedEventTotalsBaseline);
      demand(published&&isDeepStrictEqual(totalsInput,published.totals),'exact trusted published totals required before native work');
    }
    const freshJobs=inputs.jobs.slice(),knownKeys=new Set(freshJobs.map(job=>ledgerKey(ledgerBinding(job))));
    for(const job of context.retainedJobs||[])if(!knownKeys.has(ledgerKey(ledgerBinding(job)))){
      inputs.jobs.push(job);inputs.canonicalRows.push({...job});inputs.recordings.push({...job});knownKeys.add(ledgerKey(ledgerBinding(job)));
    }
    const retainedPins=Object.entries(context.retainedNativeEntries||{}).map(([periodId,value])=>({periodId,sha256:value.expectedSourceHash}));
    if(retainedPins.length)inputs.captureSha256=sha(JSON.stringify({captured:inputs.captureSha256,retained:retainedPins.sort((a,b)=>a.periodId<b.periodId?-1:1)}));
    demand(expectedCaptureSha256===null||inputs.captureSha256===expectedCaptureSha256,'capture inputs changed since preparation');
    const canonicalRows=await readCapturedNormalLedgerRows({directory:candidate,allowMissingCanonical:true});
    const original=new Map(canonicalRows.map(value=>[ledgerKey(ledgerBinding(value,'normal')),value]));
    const entries=new Map(context.ledger.entries.map(value=>[value.key,value])),accepted=new Set();
    for(const job of inputs.jobs){
      const key=ledgerKey(ledgerBinding(job));
      if(job.lane==='normal'){
        const status=original.get(key)?.sourceBoardStatus;
        if(status?.runVerified===true&&status.integrityVerified===true)accepted.add(key);
      }else if(inputs.eventBoards.some(board=>board.id===job.periodId&&board.entries.some(row=>row.accountId===job.accountId&&row.timeMs===job.timeMs&&
        (row.runId===undefined||row.runId===job.runId)&&row.needsReview!==true&&row.reviewHold!==true)))accepted.add(key);
    }
    const priority=prioritizeNativeTargets({jobs:inputs.jobs.filter(job=>{const key=ledgerKey(ledgerBinding(job));return !accepted.has(key)||entries.has(key);}),
      eventBoards:inputs.eventBoards,canonicalRows,policy:context.policy,entries:context.ledger.entries,now:now()});
    const targets=priority.jobs;
    const binding={sourceCommit,captureSha256:inputs.captureSha256};let reviewer;
    const review=async value=>{
      reviewer||=await reviewFactory({jobs:value.allJobs,sourceBinding:binding,policy:value.policy,
        previouslyAccepted:inputs.jobs.filter(job=>accepted.has(ledgerKey(ledgerBinding(job)))).map(job=>({binding:ledgerBinding(job),sourceBinding:binding,accepted:true}))});
      return reviewer(value);
    };
    review.prepare=async value=>{
      reviewer=await reviewFactory({jobs:value.allJobs,sourceBinding:binding,policy:value.policy,
        previouslyAccepted:inputs.jobs.filter(job=>accepted.has(ledgerKey(ledgerBinding(job)))).map(job=>({binding:ledgerBinding(job),sourceBinding:binding,accepted:true}))});
      demand(typeof reviewer==='function','captured-controls review capability required');
      if(reviewer.inspect){
        const coverage=await timed('reviewPreparationMs',()=>reviewer.inspect());
        demand(!coverage?.stop,'full-inventory controls preflight stopped: '+coverage?.stop);
      }
    };
    let progressCount=0,progressAt=0,progressHash=context.ledger.manifestHash;
    const saveProgress=async value=>{
      if(!progressCheckpoint||value.ledgerManifestHash===progressHash||progressCount>=16||progressCount&&now()-progressAt<120000)return;
      const checkpoint=await retainCompletedProofs({root:publicationRoot,ledgerRoot,sourceBinding:binding,
        manifestHash:value.ledgerManifestHash,previousManifestHash:context.rootManifestHash,
        evidence:{schemaVersion:1,authority:false,kind:'private-native-phase-evidence',phase:'verification-in-progress',complete:false,sourceBinding:binding,processed:value.processed,total:value.total,nativeDispatched:value.nativeDispatched,ledgerManifestHash:value.ledgerManifestHash,scoringPreflight,sourceCoverage:inputs.coverage}});
      await progressCheckpoint({...checkpoint,sequence:++progressCount});progressAt=now();progressHash=value.ledgerManifestHash;
    };
    let verification;
    try{
      verification=reuseOnly?{ledger:context.ledger,ledgerManifestHash:context.ledger.manifestHash,
        complete:true,decisions:[],counts:{storedProofs:context.ledger.entries.length,nativeDispatched:0,newProofs:0}}
        :await timed('verificationMs',()=>verifyLocalSnapshot({root,jobs:targets,allJobs:inputs.jobs,sourceBinding:binding,ledgerRoot,
        expectedManifestHash:context.ledger.manifestHash,buildPolicy,review,verify,validateEngine,
        trustedTracks:loadWeeklyTrustedTrack(root,inputs.jobs),maxJobs,maxRuntimeMs,now,onProgress:saveProgress}));
    }catch(error){
      // Only completed, validated batches reach this private ledger. Its hash
      // identifies recovery evidence, never a new publication trust anchor.
      try{
        const bytes=await optionalBytes(path.join(ledgerRoot,'manifest.json'));
        const manifestHash=bytes&&sha(bytes);
        if(manifestHash&&manifestHash!==context.ledger.manifestHash){
          const checkpoint=await retainCompletedProofs({root:publicationRoot,ledgerRoot,sourceBinding:binding,
            manifestHash,previousManifestHash:context.rootManifestHash,
            evidence:{schemaVersion:1,authority:false,kind:'private-native-phase-evidence',phase:'verification-interrupted',
              complete:false,sourceBinding:binding,ledgerManifestHash:manifestHash,scoringPreflight,sourceCoverage:inputs.coverage,timings}});
          if(proofCheckpoint)await proofCheckpoint(checkpoint);
        }
      }catch{/* Recovery must not replace the original verification failure. */}
      throw error;
    }
    let privateProofCheckpoint=null;
    if(verification.ledgerManifestHash!==context.ledger.manifestHash){
      const {ledger,authority,...outcome}=verification;
      privateProofCheckpoint=await retainCompletedProofs({root:publicationRoot,ledgerRoot,sourceBinding:binding,
        manifestHash:verification.ledgerManifestHash,previousManifestHash:context.rootManifestHash,
        evidence:{...outcome,authority:false,kind:'private-native-phase-evidence',scoringPreflight,
          sourceCoverage:inputs.coverage,timings}});
    }
    const receipt={schemaVersion:1,authority:false,kind:'completed-in-process-native-verification',
      sourceBinding:binding,ledgerManifestHash:verification.ledgerManifestHash,
      previousLedgerManifestHash:context.rootManifestHash,counts:verification.counts,
      decisions:verification.decisions,engineDigest:verification.engineDigest,verifierFingerprint:verification.verifierFingerprint,
      policySha256:verification.policySha256,
      verificationComplete:verification.complete,priority:priority.counts,sourceCoverage:inputs.coverage,scoringPreflight,privateProofCheckpoint};
    if(nativeCompleted)await nativeCompleted(structuredClone(receipt));
    if(privateProofCheckpoint&&proofCheckpoint)await proofCheckpoint(privateProofCheckpoint);
    let compiling=false,compiled=false,disposed=false;
    const source=path.join(temporary,'verified-source');
    if(verificationOnly)await fs.rename(candidate,source);
    const compile=async()=>{
    demand(!compiling&&!compiled&&!disposed,'verification capability is busy, consumed or disposed');
    compiling=true;
    try{
    if(verificationOnly)await cloneBounded({source,destination:candidate});
    const policy=await buildPolicy({root,jobs:inputs.jobs,entries:verification.ledger.entries});
    // Existing approvals not covered by current review cannot sneak back in via
    // a generic ledger applier. Restrict those tracks, retaining server baselines.
    const protectedKeys=new Set([...(context.retainedJobs||[]).map(job=>ledgerKey(ledgerBinding(job))),...accepted]);
    const deferred=new Set(verification.decisions.filter(value=>['unprocessed','unavailable'].includes(value.status)&&entries.has(value.key)&&!protectedKeys.has(value.key))
      .map(value=>value.binding.trackId));
    const publicationPolicy=structuredClone(policy);
    for(const trackId of deferred){delete publicationPolicy.trackContentHashes[trackId];delete publicationPolicy.trackGeometries[trackId];}
    const normal=await applyNormal({directory:candidate,ledger:verification.ledger,ledgerRoot,policy:publicationPolicy,
      canonicalRows,rebuildDerived:false,now:now()});
    const events=await eventCompiler({root,directory:candidate,inputs,ledger:verification.ledger,policy:publicationPolicy,captureContext:context,publishedEventTotalsBaseline,now});
    const overall=await rebuild({directory:candidate,now});await buildProfiles(candidate);
    demand(events.ready!==false,'event compilation incomplete');
    // Confirm local root authority did not change while the private phase ran.
    const current=await optional(publicationRoot,'verification-ledger-current.json');
    demand((current?.manifestHash??null)===context.rootManifestHash,'root ledger changed during native phase');
    await publishCohort({root:publicationRoot,directory,candidate,ledgerRoot,expectedManifestHash:context.rootManifestHash,
      manifestHash:verification.ledgerManifestHash,publishPointer});
    compiled=true;
    return {schemaVersion:1,authority:reuseOnly?'stored-proof-overlay':'snapshot-native',backendReads:0,backendWrites:0,
      complete:verification.complete&&inputs.coverage.complete,ledgerManifestHash:verification.ledgerManifestHash,
      sourceBinding:binding,counts:{...verification.counts,sourceJobs:inputs.jobs.length,targets:targets.length,serverAccepted:accepted.size},
      sourceCoverage:inputs.coverage,priority:priority.counts,scoringPreflight,timings,normal,events,overall,privateProofCheckpoint};
    }finally{
      compiling=false;
      if(verificationOnly){
        demand(path.dirname(candidate)===temporary,'unsafe retry candidate cleanup');
        await fs.rm(candidate,{recursive:true,force:true});
      }
    }
    };
    if(verificationOnly){
      retained=true;
      return Object.freeze({receipt:structuredClone(receipt),compile:()=>withOfflineVerification(compile),
        dispose:async()=>{
          demand(!compiling,'verification capability is busy');
          if(disposed)return;disposed=true;
          await removePrivate(temporary);if(context.bootstrapRoot)await removePrivate(context.bootstrapRoot);
        }});
    }
    return await compile();
  }finally{
    if(!retained){
      await removePrivate(temporary);
      if(context.bootstrapRoot)await removePrivate(context.bootstrapRoot);
    }
  }
}
