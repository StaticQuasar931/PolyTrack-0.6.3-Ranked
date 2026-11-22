import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash,randomUUID} from 'node:crypto';
import {resolveLocalCaptureContext,localOvernightCapturePlan,OVERNIGHT_SNAPSHOT as OLD} from './overnight-snapshot-plan.mjs';
import {runLocalOvernightCapture,validateReplacementContext} from './local-overnight-capture.mjs';
import {acquireOvernightCaptureClaim} from './overnight-capture-claim.mjs';
import {createFullSnapshotReadFence} from './full-snapshot-read-fence.mjs';
import {aggregationCount,freshCountQuote} from './fresh-capture-count-quote.mjs';

const NOW=Date.now(),source='a'.repeat(40),runId='12345678-1234-4123-8123-123456789abc';
function receipt(){
  const start=NOW-1000,date=new Date(start).toISOString().slice(0,10),baseline={generation:88,indexSha256:'b'.repeat(64)};
  return {ready:true,targetDate:date,execution:'local',oneOffAuthority:'firestore',testedCommit:source,captureOnly:true,
    claimTag:'polytrack-fresh-'+date+'-'+runId,scheduledCaptureAt:new Date(start).toISOString(),replayDocumentLimit:1000,
    freshCapturePlan:{version:1,runId,start,latestCaptureStart:NOW+600000,deadline:NOW+7200000},
    freshAuthorization:{id:runId,requestedBy:'user',sourceCommit:source,authorizedAt:NOW-2000,
      publicationMode:'capture-first',automaticRetry:false,baseline},
    priorAccounting:{directDocumentReadReservations:0,workerRequests:0},
    fullSnapshotPolicy:{canonicalDocumentLimit:30000,profileDocumentLimit:5000,publishedBaseline:baseline},
    sourceCountQuote:{version:1,sourceCommit:source,baseline,canonicalCollection:'0.6.2_race_results',profileCollection:'0.6.2_profiles_public',
      profileSince:1794648142767,profileQueryReadTime:new Date(NOW-10000).toISOString(),preflightReadReservations:27,
      canonicalResponse:[{result:{readTime:new Date(NOW-10000).toISOString(),aggregateFields:{n:{integerValue:'25131'}}}}],
      profileResponse:[{result:{readTime:new Date(NOW-10000).toISOString(),aggregateFields:{n:{integerValue:'185'}}}}],evidence:{sha256:'d'.repeat(64)}},
    quotaAdmission:{approvedBy:'user',sourceCommit:source,runId,checkedAt:NOW-500,expiresAt:NOW+1800000,
      remainingDirectReservations:35973,remainingWorkerRequests:1024,playerReadReserve:3000,perRunReadLimit:33000,
      documentWriteLimit:0,evidence:{sha256:'c'.repeat(64)}}};
}

test('fresh plan resolves new date/source/baseline/claim with zero carried usage',()=>{
  const r=receipt(),p=resolveLocalCaptureContext({receipt:r,now:NOW});
  assert.equal(p.fresh,true);assert.equal(p.priorDirectReservations,0);assert.equal(p.priorWorkerRequests,0);
  assert.notEqual(p.claimTag,OLD.claimTag);assert.equal(p.deadline,r.freshCapturePlan.deadline);
  assert.equal(p.combinedReadLimit,33000);assert.equal(p.frozenCountQuote.plannedReadReservations,28711);
  assert.equal(p.jobTimeoutMinutes,50);assert.equal(localOvernightCapturePlan({receipt:r,now:NOW}).mode,'firestore');
  const fence=createFullSnapshotReadFence({initialDirectReservations:p.priorDirectReservations,initialWorkerRequests:p.priorWorkerRequests,
    fetchImpl:()=>assert.fail('No real I/O')});assert.equal(fence.report().directDocumentReadReservations,0);
});

test('count quote preserves exact result timestamp and rejects separate profile point',()=>{
 const r=receipt(),t=r.sourceCountQuote.profileQueryReadTime;
 assert.equal(aggregationCount(r.sourceCountQuote.canonicalResponse).readTime,t);
 r.sourceCountQuote.profileResponse[0].result.readTime=new Date(NOW-9000).toISOString();
 assert.throws(()=>freshCountQuote({receipt:r,now:NOW}),/exact canonical/);
 const q=receipt();q.sourceCountQuote.canonicalResponse[0].readTime='2026-11-16T00:23:43.675147Z';
 assert.throws(()=>freshCountQuote({receipt:q,now:NOW}),/conflicting/);
 for(const mutate of [r=>r.sourceCountQuote.profileQueryReadTime='bad',r=>r.sourceCountQuote.profileSince=0,
  r=>r.sourceCountQuote.canonicalResponse[0].result.aggregateFields.n.integerValue='30000',
  r=>r.quotaAdmission.perRunReadLimit=28710,r=>r.quotaAdmission.perRunReadLimit=33001,
  r=>r.quotaAdmission.playerReadReserve=2999,r=>r.quotaAdmission.remainingDirectReservations=35972]){
  const r=receipt();mutate(r);assert.throws(()=>resolveLocalCaptureContext({receipt:r,now:NOW}));
 }
});

test('fresh window/source/auth/quota failures reject without capabilities',()=>{
  const mutations=[r=>r.ready=false,r=>r.captureOnly=false,r=>r.freshAuthorization.requestedBy='automatic',
    r=>r.freshAuthorization.automaticRetry=true,r=>r.freshAuthorization.sourceCommit='d'.repeat(40),
    r=>r.freshAuthorization.baseline={generation:81,indexSha256:'b'.repeat(64)},r=>r.claimTag=OLD.claimTag,
    r=>r.priorAccounting.directDocumentReadReservations=26338,r=>r.priorAccounting.workerRequests=89,
    r=>r.quotaAdmission.remainingDirectReservations=29999,r=>r.quotaAdmission.remainingWorkerRequests=1023,
    r=>r.quotaAdmission.documentWriteLimit=1,r=>r.quotaAdmission.expiresAt=NOW,
    r=>r.quotaAdmission.sourceCommit='d'.repeat(40),r=>r.quotaAdmission.runId=randomUUID(),
    r=>r.freshCapturePlan.deadline=NOW+1000,r=>r.targetDate='2026-11-14'];
  for(const mutate of mutations){const r=receipt();mutate(r);assert.throws(()=>resolveLocalCaptureContext({receipt:r,now:NOW}));}
  for(const now of [NOW-1001,NOW+600000,NaN])assert.throws(()=>resolveLocalCaptureContext({receipt:receipt(),now}));
  for(const key of ['replacementAuthorization','priorFailure','priorCompletion','capturedCanonicalPages','capturedProfiles','reuseWorkerBackup']){
    const r=receipt();r[key]={};assert.throws(()=>resolveLocalCaptureContext({receipt:r,now:NOW}),/historical/);
  }
});

test('fresh local orchestration uses fresh deadline and capture-only postconditions',async()=>{
  const calls=[],r=receipt(),options={receipt:r,now:()=>NOW,inspect:async()=>({head:source,complete:true,active:false}),
    preflight:async()=>calls.push('preflight'),acquireGuard:async()=>true,claim:async()=>true,
    revalidateAdmission:async()=>calls.push('readmission'),authenticate:async()=>calls.push('auth'),
    capture:async()=>{calls.push('capture');return {published:true,generation:89,directory:'public-snapshots89',
      nativeVerification:{backendReads:0,backendWrites:0,reuseOnly:true,counts:{nativeDispatched:0,newProofs:0}}};},
    publish:async()=>{calls.push('publish');return {publicationCommit:'d'.repeat(40)};},record:async()=>{}};
  assert.equal((await runLocalOvernightCapture(options)).status,'complete');
  assert.deepEqual(calls,['preflight','readmission','auth','capture','publish']);
  for(const admission of [{head:'d'.repeat(40),complete:true},{head:source,claimed:true,complete:true},
    {head:source,complete:false},{head:source,complete:true,active:true}]){
    calls.length=0;assert.notEqual((await runLocalOvernightCapture({...options,inspect:async()=>admission})).status,'complete');
    assert.deepEqual(calls,[]);
  }
  await assert.rejects(runLocalOvernightCapture({...options,capture:async()=>({published:true,nativeVerification:{backendReads:0,backendWrites:0,
    reuseOnly:false,counts:{nativeDispatched:1,newProofs:1}}})}),/Capture-only/);
});

test('fresh claim is source-bound and one-shot with an injected transport',async()=>{
  const r=receipt(),ref='refs/tags/'+r.claimTag;let claimed=false,calls=0;
  const fetchImpl=async(url,options)=>{calls++;assert.equal(options.redirect,'error');
    if(options.method==='POST'){assert.deepEqual(JSON.parse(options.body),{ref,sha:source});
      if(claimed)return {status:422};claimed=true;return {status:201,json:async()=>({ref,object:{sha:source}})};}
    return {status:200,json:async()=>({ref,object:{sha:source}})};};
  const options={repository:'StaticQuasar931/PolyTrack-0.6.3-Ranked',sourceCommit:source,token:'synthetic',receipt:r,now:NOW,fetchImpl};
  assert.equal((await acquireOvernightCaptureClaim(options)).acquired,true);
  assert.equal((await acquireOvernightCaptureClaim(options)).acquired,false);assert.equal(calls,3);
  await assert.rejects(acquireOvernightCaptureClaim({...options,sourceCommit:'d'.repeat(40)}),/source/);assert.equal(calls,3);
});

test('fresh namespace and hash-pinned quota evidence verified locally before launch',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'fresh-capture-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const r=receipt();r.workspace=path.join(root,'workspace');await fs.mkdir(r.workspace);
  const directory=path.join(root,r.targetDate,'fresh-capture-'+runId);await fs.mkdir(directory,{recursive:true});
  r.replacementDirectory=path.resolve(directory).replace(/\\/g,'/');
  const file=path.join(root,'quota-evidence.json'),bytes=Buffer.from('operator-approved remaining budget evidence');
  await fs.writeFile(file,bytes);r.quotaAdmission.evidence={file,sha256:createHash('sha256').update(bytes).digest('hex')};
  const countFile=path.join(root,'count-evidence.json'),inline={...r.sourceCountQuote};delete inline.evidence;
  const countBytes=Buffer.from(JSON.stringify(inline));await fs.writeFile(countFile,countBytes);
  r.sourceCountQuote.evidence={file:countFile,sha256:createHash('sha256').update(countBytes).digest('hex')};
  assert.deepEqual(await validateReplacementContext(r,{directory}),{priorDirectReservations:0,priorWorkerRequests:0});
  await fs.writeFile(file,'changed');await assert.rejects(validateReplacementContext(r,{directory}),/changed/);
  await assert.rejects(validateReplacementContext(r,{directory:root}),/distinct/);
});

test('frozen Nov14 path cannot use fresh counters without fresh authorization',()=>{
  const r=receipt();delete r.freshCapturePlan;
  assert.throws(()=>localOvernightCapturePlan({receipt:r,now:NOW}));
  assert.equal(OLD.priorDirectReservations,26338);assert.equal(OLD.priorWorkerRequests,89);
});

test('both runtime entry points resolve fresh authority and check local prerequisites before credentials',async()=>{
  const parent=await fs.readFile(new URL('./local-overnight-capture.mjs',import.meta.url),'utf8');
  const main=parent.slice(parent.indexOf('async function main()'));
  assert.ok(main.indexOf('const N=resolveLocalCaptureContext')<main.indexOf("git(['credential','fill']"));
  assert.ok(main.indexOf('await assertLocalStagingBase')<main.indexOf("git(['credential','fill']"));
  assert.ok(main.includes('...(N.fresh?{receipt}:{})'));
  const worker=await fs.readFile(new URL('./local-capture-worker.mjs',import.meta.url),'utf8');
  const capture=worker.slice(worker.indexOf('export async function captureLocalSource'));
  assert.ok(capture.indexOf('const N=resolveLocalCaptureContext')<capture.indexOf('createFullSnapshotReadFence'));
  assert.ok(capture.indexOf('await validateReplacementContext')<capture.indexOf('await assertLocalCaptureOwner'));
  assert.ok(capture.includes('initialDirectReservations:N.priorDirectReservations,initialWorkerRequests:N.priorWorkerRequests'));
});

test('expanded full scan still rejects today’s budget and leaves ordinary limits unchanged',()=>{
  const r=receipt();
  r.fullSnapshotPolicy.canonicalDocumentLimit=35000;
  r.sourceCountQuote.canonicalResponse[0].result.aggregateFields.n.integerValue='32366';
  r.sourceCountQuote.profileResponse[0].result.aggregateFields.n.integerValue='1703';
  r.sourceCountQuote.preflightReadReservations=35;
  r.quotaAdmission.perRunReadLimit=37607;
  r.quotaAdmission.remainingDirectReservations=32000;
  assert.throws(()=>resolveLocalCaptureContext({receipt:r,now:NOW}),/quota admission/);
  r.quotaAdmission.remainingDirectReservations=45000;
  const plan=resolveLocalCaptureContext({receipt:r,now:NOW});
  assert.equal(plan.expandedFullCapture,true);
  assert.equal(plan.frozenCountQuote.plannedReadReservations,37607);
  assert.throws(()=>createFullSnapshotReadFence({combinedReadLimit:plan.combinedReadLimit}));
  assert.equal(createFullSnapshotReadFence({combinedReadLimit:plan.combinedReadLimit,expandedFullCapture:plan.expandedFullCapture}).report().combinedReadLimit,37607);
});
