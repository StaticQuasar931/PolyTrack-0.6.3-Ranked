import {PRIVATE_SNAPSHOT_INDEX_BYTES} from './private-snapshot-index.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {hydrateStaging} from './update-public-snapshot.mjs';
import {readLedger} from './native-verification-ledger.mjs';
import {nativeLedgerPublicationFiles,withPublishedOfflineVerification} from './verifier/local-snapshot-verification.mjs';
import {prepareNativeSnapshotCapture,runNativeSnapshotPhase,verifyNativeSnapshotPhase} from './native-snapshot-phase.mjs';
import {loadTrustedPublishedEventTotalsBaseline} from './published-event-totals-baseline.mjs';
import {cloneBounded} from './bounded-clone.mjs';
import {validateOfflineNativeRuntime} from './offline-native-runtime.mjs';

export const PUBLIC_76_VERIFICATION_BASELINE=Object.freeze({generation:76,
  indexSha256:'7d0e1d6ee6c7e8d3ad5b698caf86090ed81b2a7811c715b932c4f7065e5eabaf',
  ledgerManifestHash:'a86d51ba15142520fd9f0eb8fd4bb0338df7f8efecfe7824ee084b479eee323d',ledgerEntries:4358});
const HASH=/^[a-f0-9]{64}$/;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const demand=(value,message)=>{if(!value)throw Error('Public offline verification: '+message);};
const inside=(root,file)=>{const rel=path.relative(root,file);return !rel||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
async function read(root,name,limit=16*1024*1024){
  const file=path.join(root,name),stat=await fs.lstat(file);
  demand(stat.isFile()&&!stat.isSymbolicLink()&&stat.size<=limit,'unsafe public input');
  const bytes=await fs.readFile(file);demand(bytes.length===stat.size,'public input changed');return bytes;
}

/** No CLI, live source acquisition, credential inputs, private checkpoint inputs,
 * or automatic publication. Preparing does no physics. verify() is one-shot;
 * its returned live capability can retry compilation, but receipts cannot.
 * Generic callers must supply independently trusted publication pins.
 * sourceCommit identifies tested implementation code, not the capture publication
 * commit. Publication data is bound independently by publishedBaseline.
 */
export async function preparePublishedOfflineVerification(options={},capabilities={}){
  const allowed=['root','runDirectory','sourceCommit','publishedBaseline','maxJobs','maxRuntimeMs','mode','finishDeadlineMs','packagingReserveMs'];
  demand(Object.keys(options).every(key=>allowed.includes(key)),'unknown option (no checkpoint or ledger override accepted)');
  let {root,runDirectory,sourceCommit,publishedBaseline,maxJobs=512,maxRuntimeMs=480000,mode='capture-compatible',
    finishDeadlineMs,packagingReserveMs=900000}=options;
  demand(['capture-compatible','postpublication-offline'].includes(mode),'unknown verification mode');
  const postpublication=mode==='postpublication-offline';
  demand(postpublication?Number.isSafeInteger(finishDeadlineMs)&&finishDeadlineMs>0&&packagingReserveMs===900000:
    !Object.hasOwn(options,'finishDeadlineMs')&&!Object.hasOwn(options,'packagingReserveMs'),'explicit postpublication deadline policy required');
  demand(path.isAbsolute(root||'')&&path.isAbsolute(runDirectory||'')&&/^[a-f0-9]{40}$/.test(sourceCommit||''),'absolute roots and tested commit required');
  demand(Number.isSafeInteger(maxJobs)&&maxJobs>0&&maxJobs<=10000&&Number.isSafeInteger(maxRuntimeMs)&&
    maxRuntimeMs>60000&&maxRuntimeMs<=(postpublication?5400000:1500000),'bounded native budget required');
  const pins=structuredClone(publishedBaseline);
  demand(pins&&Object.keys(pins).sort().join('|')==='generation|indexSha256|ledgerEntries|ledgerManifestHash'&&
    Number.isSafeInteger(pins.generation)&&pins.generation>0&&HASH.test(pins.indexSha256||'')&&
    HASH.test(pins.ledgerManifestHash||'')&&Number.isSafeInteger(pins.ledgerEntries)&&pins.ledgerEntries>=0,'independent public pins required');
  const rootStat=await fs.lstat(root);demand(rootStat.isDirectory()&&!rootStat.isSymbolicLink(),'unsafe publication root');
  root=await fs.realpath(root);
  runDirectory=path.join(await fs.realpath(path.dirname(runDirectory)),path.basename(runDirectory));
  demand(!inside(root,runDirectory)&&!inside(runDirectory,root),'run directory must be disjoint from the publication root');
  const {hydrate=hydrateStaging,prepare=prepareNativeSnapshotCapture,preflightPhase=runNativeSnapshotPhase,
    verifyPhase=verifyNativeSnapshotPhase,loadTotals=loadTrustedPublishedEventTotalsBaseline,
    validateRuntime=validateOfflineNativeRuntime,now=Date.now}=capabilities;
  demand(typeof now==='function','invalid verification clock');
  const runtime=await validateRuntime({root});
  async function checkPins(){
    const pointer=JSON.parse(await read(root,'snapshot-current.json',2048));
    demand(pointer.currentdir==='public-snapshots'+pins.generation,'public generation changed');
    demand(sha(await read(root,pointer.currentdir+'/index.json',PRIVATE_SNAPSHOT_INDEX_BYTES))===pins.indexSha256,'public index changed');
    const ledgerPointer=JSON.parse(await read(root,'verification-ledger-current.json',2048));
    demand(ledgerPointer.manifestHash===pins.ledgerManifestHash,'public ledger changed');
    const files=await nativeLedgerPublicationFiles(root);
    const ledger=readLedger({root:path.join(root,'verification-ledger'),expectedManifestHash:pins.ledgerManifestHash});
    demand(ledger.entries.length===pins.ledgerEntries,'public ledger entry count changed');return files;
  }
  const files=await checkPins();
  await fs.mkdir(runDirectory,{mode:0o700});
  const directory=path.join(runDirectory,'candidate');
  await hydrate(root,directory);
  await fs.mkdir(path.join(runDirectory,'verification-ledger/shards'),{recursive:true});
  for(const file of files){const target=path.join(runDirectory,file);await fs.mkdir(path.dirname(target),{recursive:true});await fs.copyFile(path.join(root,file),target,fs.constants.COPYFILE_EXCL);}
  readLedger({root:path.join(runDirectory,'verification-ledger'),expectedManifestHash:pins.ledgerManifestHash});
  const publishedEventTotalsBaseline=await loadTotals({root,expectedGeneration:pins.generation,expectedIndexSha256:pins.indexSha256});
  const captureContext=await prepare({root,directory});
  // Exercise scoring, events, profiles and local CAS using ONLY old public
  // proofs before asking for any new native work. Never publish to source root.
  const preflightDirectory=path.join(runDirectory,'preflight-candidate');
  await cloneBounded({source:directory,destination:preflightDirectory});
  const preflight=await preflightPhase({root,publicationRoot:runDirectory,directory:preflightDirectory,sourceCommit,captureContext,
    publishedEventTotalsBaseline,reuseOnly:true});
  demand(preflight.backendReads===0&&preflight.backendWrites===0&&preflight.counts?.nativeDispatched===0&&
    preflight.ledgerManifestHash===pins.ledgerManifestHash&&HASH.test(preflight.sourceBinding?.captureSha256||'')&&
    HASH.test(preflight.scoringPreflight?.sourceSha256||''),'stored-public preflight changed proof authority or omitted source pins');
  await checkPins();
  demand(path.dirname(preflightDirectory)===runDirectory,'unsafe preflight cleanup');
  await fs.rm(preflightDirectory,{recursive:true,force:true});
  const receipt={schemaVersion:1,kind:'prepared-public-offline-verification',authority:false,sourceCommit,
    publishedBaseline:pins,maxJobs,maxRuntimeMs,mode,...(postpublication?{finishDeadlineMs,packagingReserveMs}:{}),runtime,preflight,backendReads:0,backendWrites:0};
  await fs.writeFile(path.join(runDirectory,'prepared.json'),JSON.stringify(receipt)+'\n',{flag:'wx',mode:0o600,flush:true});
  let started=false;
  return Object.freeze({receipt:structuredClone(receipt),directory,
    verify:async()=>{
      demand(!started,'fresh verification already requested');started=true;
      demand(JSON.stringify(await validateRuntime({root}))===JSON.stringify(runtime),'native runtime changed after preparation');
      await checkPins();
      const local=JSON.parse(await read(runDirectory,'verification-ledger-current.json',2048));
      demand(local.manifestHash===pins.ledgerManifestHash,'prepared ledger changed');
      let completionCalls=0,completionBytes,completionWrite,completionError;
      const nativeCompleted=async receipt=>{
        try{
          demand(++completionCalls===1,'native completion receipt repeated');
          demand(receipt&&typeof receipt==='object'&&!Array.isArray(receipt),'invalid native completion receipt');
          completionBytes=JSON.stringify(receipt)+'\n';
          completionWrite=fs.writeFile(path.join(runDirectory,'verified.json'),completionBytes,{flag:'wx',mode:0o600,flush:true});
          await completionWrite;
        }catch(error){completionError=error;throw error;}
      };
      let verified,terminal;
      const effectiveRuntime=postpublication?Math.min(maxRuntimeMs,finishDeadlineMs-now()-packagingReserveMs):maxRuntimeMs;
      demand(!postpublication||effectiveRuntime>60000,'no native time remains before packaging reserve');
      const run=async()=>{verified=await verifyPhase({root,publicationRoot:runDirectory,directory,sourceCommit,captureContext,
        publishedEventTotalsBaseline,maxJobs,maxRuntimeMs:effectiveRuntime,expectedCaptureSha256:preflight.sourceBinding.captureSha256,
        expectedScoringSha256:preflight.scoringPreflight.sourceSha256,nativeCompleted});return verified;};
      try{
        if(postpublication){
          const result=await withPublishedOfflineVerification({root,publishedBaseline:pins,sourceCommit,
            captureSha256:preflight.sourceBinding.captureSha256,finishDeadlineMs,packagingReserveMs,now},run);
          verified=result.value;terminal=result.terminal;
        }else verified=await run();
      }
      catch(error){await completionWrite?.catch(()=>{});if(verified)await verified.dispose();throw error;}
      let terminalReceipt=null,terminalBytes;
      try{
        if(completionWrite)await completionWrite;
        if(completionError)throw completionError;
        // Trusted adapters may omit the callback; real native completion persists
        // before phase rename/cleanup can fail, without granting recovery authority.
        if(completionCalls===0)await nativeCompleted(verified.receipt);
        demand(completionBytes===JSON.stringify(verified.receipt)+'\n','native completion receipt differs from returned receipt');
        if(postpublication){
          const returned=verified.receipt;
          demand(returned.kind==='completed-in-process-native-verification'&&returned.authority===false&&
            returned.verificationComplete===terminal.complete&&terminal.boundedTerminalPass===true,
            'fresh bounded terminal phase receipt required');
          for(const key of ['sourceBinding','previousLedgerManifestHash','ledgerManifestHash','counts','decisions',
            'engineDigest','verifierFingerprint','policySha256'])
            demand(isDeepStrictEqual(returned[key],terminal[key]),'terminal native receipt binding differs: '+key);
          demand(returned.previousLedgerManifestHash===pins.ledgerManifestHash,'terminal public ledger binding changed');
          demand(typeof returned.sourceCoverage?.complete==='boolean','terminal source coverage required');
          terminalReceipt={schemaVersion:1,kind:'published-offline-bounded-terminal-pass',authority:false,
            mode,publishedBaseline:pins,sourceCommit,sourceBinding:terminal.sourceBinding,
            nativeReceiptSha256:sha(completionBytes),ledgerManifestHash:terminal.ledgerManifestHash,
            boundedTerminalPass:true,verificationCoverageComplete:terminal.complete,
            sourceCoverageComplete:returned.sourceCoverage.complete,
            coverageComplete:terminal.complete&&returned.sourceCoverage.complete,compilationEligible:true,
            ledgerProvenKeys:terminal.ledgerProvenKeys,counts:terminal.counts,
            budget:terminal.budget,pendingRowsRetained:true,nativeNegativeOutcomesDurable:false};
          terminalBytes=JSON.stringify(terminalReceipt)+'\n';
          await fs.writeFile(path.join(runDirectory,'terminal-pass.json'),terminalBytes,{flag:'wx',mode:0o600,flush:true});
        }
      }
      catch(error){await verified.dispose();throw error;}
      return Object.freeze({...verified,...(postpublication?{compilationEligible:true,terminalReceipt:structuredClone(terminalReceipt)}:{}),
        compile:async()=>{
          await checkPins();
          if(postpublication){
            demand(now()<finishDeadlineMs,'absolute finish deadline reached before compilation');
            demand((await read(runDirectory,'verified.json',Buffer.byteLength(completionBytes))).toString()===completionBytes&&
              (await read(runDirectory,'terminal-pass.json',Buffer.byteLength(terminalBytes))).toString()===terminalBytes,
              'fresh terminal receipt changed');
          }
          const compiled=await verified.compile();
          if(postpublication){
            demand(compiled?.compilationComplete===true&&compiled.backendReads===0&&compiled.backendWrites===0&&
              isDeepStrictEqual(compiled.sourceBinding,terminalReceipt.sourceBinding)&&compiled.ledgerManifestHash===terminalReceipt.ledgerManifestHash,
              'clean bound compilation completion required');
            demand(compiled.verificationCoverageComplete===terminalReceipt.verificationCoverageComplete&&
              compiled.sourceCoverageComplete===terminalReceipt.sourceCoverageComplete&&
              compiled.sourceCoverage?.complete===terminalReceipt.sourceCoverageComplete&&
              compiled.coverageComplete===terminalReceipt.coverageComplete&&compiled.complete===terminalReceipt.coverageComplete,
              'compiled coverage differs from the bounded terminal receipt');
            await checkPins();
          }
          return compiled;
        }});
    }});
}

export function preparePublic76OfflineVerification(options={},capabilities){
  demand(!Object.hasOwn(options,'publishedBaseline'),'public 76 pins cannot be overridden');
  return preparePublishedOfflineVerification({...options,publishedBaseline:PUBLIC_76_VERIFICATION_BASELINE},capabilities);
}
