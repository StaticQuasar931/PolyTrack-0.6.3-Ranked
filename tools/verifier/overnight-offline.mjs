import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
export const sha=value=>createHash('sha256').update(value).digest('hex');
export const AUDIT_REVIEW_LIMITS=Object.freeze({maxRuntimeMs:120000,maxPairs:2000000});
export function auditSummary(report){
  return ['## Saved controls audit: '+(report.complete?'bounded coverage complete':'INCOMPLETE / NOT AN ALL-CLEAR'),
    `Payload scan complete: ${report.scanComplete===true}. Evidence coverage complete: ${report.evidenceCoverageComplete===true}.`,
    `Reviewer stop: ${report.reviewCoverage?.stop||'none reported'}. Findings: ${report.reviewCoverage?.findings??'unknown'}.`,
    `Current-board available bindings: ${report.inventoryCount??'unknown'}. Missing bindings: ${report.coverage?.missingBindings??'unknown'}.`,
    `Unreferenced retained payloads: ${report.payloadAudit?.unreferenced??'unknown'}; these may be legitimate history, not misconduct.`,
    report.error?`Execution error: ${String(report.error).split('\n')[0]}`:'',
    'Findings are review-only signals, not proof of cheating. Missing coverage is not approval. See uploaded JSON for invalid records, track-level coverage and policy limits.'].filter(Boolean).join('\n\n')+'\n';
}
const RHR='fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
export function config(env=process.env){
  const c={implementation:env.EXPECTED_SOURCE_COMMIT,publication:env.SNAPSHOT_SOURCE_COMMIT,indexSha256:env.SNAPSHOT_INDEX_SHA256,generation:Number(env.SNAPSHOT_GENERATION),seed:env.SAMPLE_SEED||'polytrack-overnight-v1',workers:env.VERIFIER_NATIVE_WORKERS||'1'};
  assert(/^[a-f0-9]{40}$/.test(c.implementation||'')&&/^[a-f0-9]{40}$/.test(c.publication||''),'exact commits required');
  assert(/^[a-f0-9]{64}$/.test(c.indexSha256||'')&&c.generation===91,'exact snapshot91 index required');
  assert(['1','2'].includes(c.workers)&&/^[a-zA-Z0-9_.-]{1,80}$/.test(c.seed),'invalid workers or seed');
  assert(!env.VERIFIER_WALL_MS&&!env.VERIFIER_CPU_MS&&!env.VERIFIER_CHROMIUM_PATH,'no native limit or executable overrides');
  assert((env.GITHUB_RUN_ATTEMPT||'1')==='1','no automatic rerun budget reset');return c;
}
export function selectSample(jobs,seed,count=256,weeklyTrackId){
  const ordered=[...jobs].sort((a,b)=>sha(seed+'|'+a.resultId+'|'+a.replayHash).localeCompare(sha(seed+'|'+b.resultId+'|'+b.replayHash)));
  const chosen=[],seen=new Set();
  const take=(rows,n)=>{for(const job of rows){if(n<=0||chosen.length===count)break;if(seen.has(job.resultId))continue;seen.add(job.resultId);chosen.push(job);n--;}};
  if(weeklyTrackId)take(ordered.filter(j=>j.trackId===weeklyTrackId),32);
  take(ordered.filter(j=>j.lane==='event'),64);take(ordered.filter(j=>j.trackId===RHR),64);
  const tracks=new Map();for(const j of ordered){if(!tracks.has(j.trackId))tracks.set(j.trackId,[]);tracks.get(j.trackId).push(j);}
  while(chosen.length<count){const before=chosen.length;for(const rows of tracks.values())take(rows.filter(j=>!seen.has(j.resultId)),1);if(chosen.length===before)break;}
  assert.equal(chosen.length,count,'insufficient distinct admitted sample');return chosen;
}
export function normalize(values){return values.map(({resultId,trackId,timeMs,replayHash,status,reason,deterministic,trackContentHash,engineDigest,trackGeometry,geometryPolicy,binding,boundInputFingerprint})=>({resultId,trackId,timeMs,replayHash,status,reason,deterministic,trackContentHash,engineDigest,trackGeometry,geometryPolicy,binding,boundInputFingerprint}));}
export function ledgerEligible(jobs,ledger,policy,applyLedgerToBoard){
  const groups=new Map();for(const job of jobs){const key=job.lane==='event'?'event:'+job.periodId:'normal';if(!groups.has(key))groups.set(key,[]);groups.get(key).push(job);}
  const eligible=new Set();for(const rows of groups.values()){
    const lane=rows[0].lane,board={entries:rows,...(lane==='event'?{periodId:rows[0].periodId}:{})};
    const applied=applyLedgerToBoard({board,ledger,canonicalRows:rows,recordings:rows,policy,lane});
    for(const row of applied.board.entries)if(row.integrityVerified===true&&row.nativeLedgerKey)eligible.add(row.resultId);
  }
  return eligible;
}
export function compareReports(a,b){
  assert.equal(a.sampleSha256,b.sampleSha256);assert.deepEqual(a.pins,b.pins);assert.equal(a.fingerprint,b.fingerprint);
  assert(a.complete&&b.complete);for(const r of [...a.repeats,...b.repeats]){assert.equal(r.outcomes.length,256);assert(r.outcomes.every(v=>v.status==='verified'));assert.deepEqual(r.outcomes,a.repeats[0].outcomes);}
  const median=r=>(r.repeats[0].elapsedMs+r.repeats[1].elapsedMs)/2;
  return {authority:false,exactOutcomesAndBindingsEqual:true,oneMedianMs:median(a),twoMedianMs:median(b),repeatedlyFaster:b.repeats.every(r=>r.elapsedMs<Math.min(...a.repeats.map(x=>x.elapsedMs))),defaultWorkers:1};
}
export async function main(mode,root,output){
  root=path.resolve(root);output=path.resolve(output);assert(!output.startsWith(root+path.sep),'reports must be outside checkout');
  await fs.mkdir(output,{recursive:true});const write=(name,value)=>fs.writeFile(path.join(output,name),JSON.stringify(value,null,2)+'\n');
  const report={authority:false,complete:false,mode,backendReads:0,backendWrites:0,limitations:[]};await write('progress.json',report);
  try{
    if(mode==='compare'){
      const a=JSON.parse(await fs.readFile(path.join(root,'native-1/report.json'))),b=JSON.parse(await fs.readFile(path.join(root,'native-2/report.json')));
      await write('comparison.json',compareReports(a,b));report.complete=true;return;
    }
    const c=config();report.pins=c;
    for(const key of Object.keys(process.env))if(/^(FIREBASE_|GOOGLE_APPLICATION_CREDENTIALS$|GOOGLE_ACCESS_TOKEN$)/i.test(key))delete process.env[key];
    globalThis.fetch=()=>{throw Error('Offline reports forbid fetch');};
    const git=args=>execFileSync('git',args,{cwd:root,encoding:'utf8',maxBuffer:32*1024*1024}).trim();
    assert.equal(git(['rev-parse','HEAD']),c.implementation,'implementation pin changed');
    const indexBytes=await fs.readFile(path.join(root,'public-snapshots91/index.json'));
    assert.equal(sha(indexBytes),c.indexSha256);assert.equal(sha(execFileSync('git',['show',c.publication+':public-snapshots91/index.json'],{cwd:root,maxBuffer:32*1024*1024})),c.indexSha256);
    assert.equal(JSON.parse(await fs.readFile(path.join(root,'snapshot-current.json'))).currentdir,'public-snapshots91');
    const index=JSON.parse(indexBytes);const importRoot=name=>import(pathToFileURL(path.join(root,name)));
    const {hydrateStaging}=await importRoot('tools/update-public-snapshot.mjs');
    const {loadCapturedNativeJobs}=await importRoot('tools/verifier/local-snapshot-capture.mjs');
    const hydrated=path.join(output,'hydrated');await hydrateStaging(root,hydrated);
    const inventory=await loadCapturedNativeJobs({directory:hydrated,allowExtendedLocal:true});
    report.coverage=inventory.coverage;report.inventoryCount=inventory.jobs.length;await write('progress.json',report);
    if(mode==='audit'){
      const keys=Object.keys(index.files).filter(k=>/^(recordings|event-replays|event-playbacks)\//.test(k));let checked=0;const invalid=[],unreferenced=[];
      const referenced=new Set(inventory.jobs.map(j=>j.source));
      for(const key of keys){
        const raw=JSON.parse(await fs.readFile(path.join(hydrated,key)));const replay=raw.recording??raw.replay;
        if(typeof replay!=='string'||sha(replay)!==raw.replayHash||!(/^[a-f0-9]{64}$/).test(raw.accountId||'')||!(/^[a-f0-9]{64}$/).test(raw.trackId||''))invalid.push(key);
        if(!referenced.has(key))unreferenced.push(key);checked++;
        if(checked%1000===0)await write('payload-progress.json',{checked,total:keys.length,invalid:invalid.length,authority:false});
      }
      await write('payload-audit.json',{checked,total:keys.length,invalid,unreferenced,authority:false});
      report.scanComplete=checked===keys.length;report.payloadAudit={checked,total:keys.length,invalid:invalid.length,unreferenced:unreferenced.length};
      const policy={reviewPolicyVersions:['snapshot-controls-v1']};
      const {createCapturedControlReview}=await importRoot('tools/verifier/captured-controls.mjs');
      const reviewer=createCapturedControlReview({allJobs:inventory.jobs,sourceBinding:{sourceCommit:c.implementation,captureSha256:inventory.captureSha256},policy,limits:AUDIT_REVIEW_LIMITS});
      report.reviewCoverage=await reviewer.inspect();report.payloadAudit={checked,total:keys.length,invalid:invalid.length,unreferenced:unreferenced.length};
      await write('controls-coverage.json',report.reviewCoverage);const artifact=await reviewer.artifact();await write('controls-findings.json',artifact);
      report.scanComplete=checked===keys.length;report.evidenceCoverageComplete=inventory.coverage.complete&&unreferenced.length===0&&artifact.coverage.complete;
      report.complete=report.scanComplete&&invalid.length===0&&report.evidenceCoverageComplete;
      report.limitations=['Review-only evidence, not cheating accusations or native proofs.','Existing clone/near-tie/segment candidate policy and bounded defaults; not exhaustive TAS detection.','All retained payloads checked for hashes and basic identity. Near-clone review covers current-board hydrated jobs only; unreferenced payloads listed separately.'];
    }else{
      assert.equal(mode,'benchmark');const require=createRequire(path.join(root,'tools/verifier/package.json'));
      const {readLedger,applyLedgerToBoard}=await importRoot('tools/native-verification-ledger.mjs');
      const {buildNativeVerificationPolicy}=await importRoot('tools/native-verification-policy.mjs');
      const pointer=JSON.parse(await fs.readFile(path.join(root,'verification-ledger-current.json')));
      assert.deepEqual(pointer,JSON.parse(execFileSync('git',['show',c.publication+':verification-ledger-current.json'],{cwd:root})));
      const ledger=readLedger({root:path.join(root,'verification-ledger'),expectedManifestHash:pointer.manifestHash});
      const policy=buildNativeVerificationPolicy({root,jobs:inventory.jobs,entries:ledger.entries});
      const eligible=ledgerEligible(inventory.jobs,ledger,policy,applyLedgerToBoard);
      const {checkJob}=require('./replay.cjs');const admitted=inventory.jobs.filter(j=>{try{checkJob(j);return eligible.has(j.resultId)&&policy.knownTrackIds.includes(j.trackId)&&j.resourceProfile!=='extended-local';}catch{return false;}});
      const weekly=JSON.parse(await fs.readFile(path.join(root,'events/kodub/current.json'))).current.trackId;
      assert(admitted.filter(j=>j.trackId===weekly).length>=4,'four current-weekly verified bindings required');
      const sample=selectSample(admitted,c.seed,256,weekly);report.sampleSha256=sha(JSON.stringify(sample.map(({replay,...j})=>j)));report.pins={...c,workers:undefined};
      report.admission={inventory:inventory.jobs.length,eligible:admitted.length,ledgerManifestHash:pointer.manifestHash,ledgerEntries:ledger.entries.length,weeklyTrackId:weekly,weeklySelected:sample.filter(j=>j.trackId===weekly).length};
      await write('sample.json',{sampleSha256:report.sampleSha256,jobs:sample.map(({replay,...j})=>j)});
      const {verifyLocalNativeBatch}=await importRoot('tools/verifier/local-snapshot-verification.mjs');const {loadWeeklyTrustedTrack}=await importRoot('tools/verifier/weekly-track.mjs');
      const native=require('./verify.cjs');report.fingerprint=native.verifierFingerprint;report.repeats=[];
      const absoluteDeadline=performance.now()+105*60000;
      for(let repeat=0;repeat<2;repeat++){
        const began=performance.now(),outcomes=[];
        for(let offset=0;offset<sample.length;offset+=16){
          assert(performance.now()<absoluteDeadline-60000,'aggregate benchmark deadline');const jobs=sample.slice(offset,offset+16);
          const batch=normalize(await verifyLocalNativeBatch(root,jobs,loadWeeklyTrustedTrack(root,jobs),{deadline:absoluteDeadline}));outcomes.push(...batch);
          await write(`repeat-${repeat+1}-batch-${offset/16+1}.json`,{authority:false,repeat,completed:outcomes.length,elapsedMs:Math.round(performance.now()-began),outcomes});
          assert(batch.length===jobs.length&&batch.every(v=>v.status==='verified'),'unavailable/mismatch: no retry');
          if(repeat)assert.deepEqual(batch,report.repeats[0].outcomes.slice(offset,offset+jobs.length));
        }
        report.repeats.push({elapsedMs:Math.round(performance.now()-began),outcomes});await write('report.json',report);
        assert(outcomes.every(v=>v.status==='verified'),'unavailable/mismatch: no retry');if(repeat)assert.deepEqual(outcomes,report.repeats[0].outcomes);
      }
      report.complete=true;
    }
  }catch(error){report.error=String(error.stack||error);throw error;}
  finally{
    await write('report.json',report);
    if(mode==='audit'&&process.env.GITHUB_STEP_SUMMARY)await fs.appendFile(process.env.GITHUB_STEP_SUMMARY,auditSummary(report));
  }
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main(...process.argv.slice(2));
