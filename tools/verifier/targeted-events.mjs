import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {compatibleEventEngine} from '../../workers/ranked/src/event-engine-compatibility.js';
import {VERIFIER_ENGINE_DIGEST,VERIFIER_VERSION} from '../../workers/ranked/src/verification.js';

export function selectCompatibilityProbe(periodIds,periods,pendingRows) {
  const pending=new Set([...pendingRows].map(row=>row?.periodId));
  const available=periodIds.filter(id=>{const period=periods.get(id);
    return pending.has(id)&&period?.verifierVersion===VERIFIER_VERSION&&compatibleEventEngine(period.engineDigest);});
  return available.find(id=>periods.get(id).engineDigest===VERIFIER_ENGINE_DIGEST)||available[0]||null;
}

export function targetedEventPlan(periodIds, maxJobs = 12) {
  if (!Array.isArray(periodIds) || !periodIds.length || periodIds.length > 3 ||
      new Set(periodIds).size !== periodIds.length || periodIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)))
    throw Error('Select one to three exact period IDs');
  if (!Number.isInteger(maxJobs) || maxJobs < 1 || maxJobs > 12) throw Error('Job limit must be 1..12');
  // Include the coordinator's conservative intake/discovery reserves, although both are local here.
  const batches = Math.ceil(maxJobs / 4);
  return {periodIds:[...periodIds],maxJobs,batches,maxHttpRequests:Math.max(209,1+136*batches),
    maxDocumentReadAttempts:Math.min(252,89*batches),intake:false,archive:false,normalQueue:false};
}

export function eventBatchReadReserve(jobSlots) {
  if(!Number.isInteger(jobSlots)||jobSlots<1||jobSlots>4)throw Error('Event batch slots must be 1..4');
  // Lease <=16, period reread 1, and per job: review metadata 1 + completion <=16 + optional finding 1.
  return 17+18*jobSlots;
}

export function guardedEventFetch(fetchImpl, plan) {
  let httpRequests = 0, documentReadAttempts = 0, halted = false, publicReadURL = null;
  const base = 'https://firestore.googleapis.com/v1/projects/polytrack-052/databases/(default)/documents';
  const fetch = async (input, init = {}) => {
    const url = new URL(input), method = init.method || 'GET';
    const oauth = url.href === 'https://oauth2.googleapis.com/token' && method === 'POST';
    const publicRead = publicReadURL !== null && url.href === publicReadURL && method === 'GET';
    const read = url.origin === 'https://firestore.googleapis.com' && url.href.startsWith(base+'/') &&
      /^\/[^/]+\/[^/]+$/.test(url.pathname.slice(new URL(base).pathname.length)) && method === 'GET' &&
      [...url.searchParams.keys()].every(key => key === 'transaction');
    const transaction = method === 'POST' && [':beginTransaction',':commit',':rollback'].some(route=>url.href===base+route);
    if (halted) throw Error('Targeted event transport halted after quota error');
    if (!oauth && !read && !transaction && !publicRead) throw Error('Targeted event transport rejects queries and unrelated hosts');
    const readCost = publicRead ? 2 : read ? 1 : 0;
    if (httpRequests >= plan.maxHttpRequests || documentReadAttempts + readCost > plan.maxDocumentReadAttempts)
      throw Error('Targeted event budget exhausted');
    httpRequests++;documentReadAttempts += readCost;
    const response = await fetchImpl(input, init);
    let quota = response.status === 429;
    if (!response.ok && !quota) {
      const body = await response.clone().json().catch(()=>null);
      quota = body?.error?.status === 'RESOURCE_EXHAUSTED' || /quota|resource.exhausted/i.test(body?.error?.message||'');
    }
    if (quota) {
      halted = true;
      throw Object.assign(Error('Targeted event quota stop'),{code:'EVENT_QUOTA_STOP',status:response.status});
    }
    return response;
  };
  return {fetch,stats:()=>({httpRequests,documentReadAttempts,halted}),
    allowCompatibilityRead:(periodId,runId)=>{
      if(publicReadURL!==null||!plan.periodIds?.includes(periodId)||!/^[a-f0-9]{64}$/.test(runId))throw Error('Invalid compatibility read');
      publicReadURL='https://polytrack-ranked-worker.staticquasar931.workers.dev/v1/events/'+periodId+'/playbacks/'+runId;
      return publicReadURL;
    },
    canSpend:(count,jobSlots=4)=>!halted&&plan.maxHttpRequests-httpRequests>=count &&
      plan.maxDocumentReadAttempts-documentReadAttempts>=eventBatchReadReserve(jobSlots)};
}

export async function runTargetedEvents({root,periodIds,maxJobs=12,execute=false,approvePublication=false,
  credentialFile,output,fetchImpl=globalThis.fetch}={}) {
  const plan=targetedEventPlan(periodIds,maxJobs);
  if(!execute)return {mode:'plan',...plan};
  if(approvePublication!==true)throw Error('Explicit publication approval required');
  if(!path.isAbsolute(root||'')||!path.isAbsolute(credentialFile||'')||!path.isAbsolute(output||''))
    throw Error('Absolute root, credential file and private output required');
  const relative=path.relative(path.resolve(root),path.resolve(output));
  if(!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))throw Error('Output must be outside repository');
  const source=name=>pathToFileURL(path.join(root,name)).href;
  const {validateEnginePin}=await import(source('tools/verifier/run.mjs'));
  await validateEnginePin();
  const {connect}=await import(source('tools/verifier/firestore.mjs'));
  const {eventRuntime}=await import(source('workers/ranked/src/events-runtime.js'));
  const {runEventCoordinator}=await import(source('tools/verifier/events.mjs'));
  const {verifyBatch}=await import(source('tools/verifier/verify.cjs'));
  const {createSimilarityReviewer}=await import(source('tools/verifier/similarity.mjs'));
  const {reviewInboxWrite}=await import(source('tools/verifier/review-inbox.mjs'));
  const {VERIFIER_ENGINE_DIGEST,VERIFIER_VERSION}=await import(source('workers/ranked/src/verification.js'));
  const {compatibleEventEngine}=await import(source('workers/ranked/src/event-engine-compatibility.js'));
  const guard=guardedEventFetch(fetchImpl,plan),originalFetch=globalThis.fetch;
  const summary={mode:'execute',startedAt:new Date().toISOString(),plan,jobs:[],before:[],after:[]};
  let db;
  try {
    globalThis.fetch=guard.fetch;
    db=await connect(await fs.readFile(credentialFile,'utf8'));
    const pendingNames=new Map(),periods=new Map();
    for(const periodId of periodIds){
      const period=(await db.get('0.6.2_event_periods',periodId))?.data;
      if(!period||period.verifierVersion!==VERIFIER_VERSION||!compatibleEventEngine(period.engineDigest))
        throw Error('Worker period/proof compatibility must be resolved before publication');
      periods.set(periodId,period);
      const queue=(await db.get('0.6.2_event_queues',periodId))?.data;
      const board=(await db.get('0.6.2_event_public',periodId))?.data;
      if(!queue||!board)throw Error('Missing selected period queue/board');
      for(const row of board.pendingPlaybacks||[])pendingNames.set(row.runId,{...row,periodId});
      summary.before.push({periodId,verified:board.entries?.length||0,pending:queue.slots?.length||0,
        pendingRuns:(queue.slots||[]).map(slot=>({runId:slot.runId,name:pendingNames.get(slot.runId)?.name||null,timeMs:slot.timeMs}))});
    }
    const currentPeriod=selectCompatibilityProbe(periodIds,periods,pendingNames.values());
    if(!currentPeriod)throw Error('No compatible pending period for deployed compatibility check');
    const check=[...pendingNames.values()].find(row=>row.periodId===currentPeriod);
    const response=await guard.fetch(guard.allowCompatibilityRead(currentPeriod,check.runId),{
      headers:{Origin:'https://staticquasar931.github.io',Accept:'application/json'},redirect:'error',signal:AbortSignal.timeout(10000)});
    const payload=await response.json();
    if(!response.ok||payload.periodId!==currentPeriod||payload.runId!==check.runId||payload.trackId!==periods.get(currentPeriod).trackId)
      throw Error('Deployed Worker did not accept the selected compatible period binding; stop before publication');
    summary.compatibility={engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION,
      currentPeriod,probedPeriodEngine:periods.get(currentPeriod).engineDigest,publicPlaybackStatus:response.status,periodDigests:Object.fromEntries([...periods].map(([id,p])=>[id,p.engineDigest]))};
    const runtime=eventRuntime((route,init)=>db.call(route,init?.body?JSON.parse(init.body):undefined));
    const metadata=new Map();let activePeriod;
    const processBatch=runtime.service.processBatch.bind(runtime.service);
    runtime.service={...runtime.service,processBatch:async(periodId,...args)=>{
      activePeriod=periodId;return processBatch(periodId,...args);
    }};
    const review=createSimilarityReviewer(root);
    summary.result=await runEventCoordinator(runtime,root,{limit:maxJobs,
      consumeInbox:async()=>({consumed:0}),
      readWork:async()=>({periodIds:[...periodIds],archiveId:null}),
      verifyBatch:async(directory,jobs,trustedTracks)=>{
        if(summary.jobs.length+jobs.length>maxJobs)throw Error('Native job ceiling');
        for(const job of jobs){
          const run=(await db.get('0.6.2_event_runs',job.resultId))?.data;
          if(!run||run.periodId!==activePeriod||run.trackId!==job.trackId||run.timeMs!==job.timeMs||
            run.replayHash!==job.replayHash||!/^[a-f0-9]{64}$/.test(run.accountId||''))throw Error('Leased run metadata mismatch');
          metadata.set(job.resultId,{accountId:run.accountId,name:run.name||null,receivedAt:run.receivedAt,periodId:activePeriod});
        }
        const results=await verifyBatch(directory,jobs,trustedTracks);
        for(const result of results)if(result.status==='verified'&&
          (result.reason!=='native_exact_finish'||result.deterministic!==true||result.engineDigest!==VERIFIER_ENGINE_DIGEST))
          throw Error('Exact deterministic native proof required');
        for(const result of results)summary.jobs.push({periodId:activePeriod,resultId:result.resultId,
          ...metadata.get(result.resultId),trackId:result.trackId,timeMs:result.timeMs,replayHash:result.replayHash,
          nativeStatus:result.status,nativeReason:result.reason,nativeCompletedAt:new Date().toISOString(),
          engineDigest:result.engineDigest,trackContentHash:result.binding?.trackContentHash,verifierFingerprint:result.binding?.verifierFingerprint});
        await fs.writeFile(output,JSON.stringify({...summary,...guard.stats()},null,2)+'\n');
        return results;
      },
      reviewSimilarity:async(jobs,results)=>{
        await review(jobs.map(job=>({...job,...metadata.get(job.resultId)})),results);
        for(const result of results){const row=summary.jobs.find(row=>row.resultId===result.resultId);
          Object.assign(row,{reviewedStatus:result.status,reviewedReason:result.reason});}
      },canSpend:count=>guard.canSpend(count,Math.min(4,Math.max(1,maxJobs-summary.jobs.length))),
      writeFinding:async(periodId,job,verdict,evidence)=>{
        const auditId=createHash('sha256').update(JSON.stringify(['event-review-v1',periodId,
          job.runId||job.resultId,job.trackId,job.timeMs,job.replayHash])).digest('hex');
        const write=await reviewInboxWrite(db,auditId,{...job,periodId},verdict,evidence);
        if(!write)return false;
        await db.call(':commit',{writes:[write]});return true;
      },
    });
    for(const periodId of periodIds){
      if(guard.stats().documentReadAttempts+2>plan.maxDocumentReadAttempts||guard.stats().httpRequests+2>plan.maxHttpRequests)break;
      const queue=(await db.get('0.6.2_event_queues',periodId))?.data;
      const board=(await db.get('0.6.2_event_public',periodId))?.data;
      summary.after.push({periodId,verified:board?.entries?.length||0,pending:queue?.slots?.length||0,
        pendingRuns:(queue?.slots||[]).map(slot=>({runId:slot.runId,name:pendingNames.get(slot.runId)?.name||null,timeMs:slot.timeMs}))});
    }
    summary.publicationCounts={};
    for(const result of summary.result.results){
      summary.publicationCounts[result.status]=(summary.publicationCounts[result.status]||0)+1;
      const row=summary.jobs.find(row=>row.resultId===result.resultId);if(row)row.publication=result;
    }
  } catch(error) {
    summary.error={message:String(error.message).slice(0,300),status:error.status||null,code:error.code||null};
    summary.outcome='stopped; earlier atomic publications may have committed; do not replay blindly';
  } finally {
    globalThis.fetch=originalFetch;
    Object.assign(summary,guard.stats(),{completedAt:new Date().toISOString(),firestoreHttpRequests:db?.requests()||0,
      firestoreEstimatedDocumentReads:db?.estimatedDocumentReads()||0,firestoreReturnedDocuments:db?.returnedDocuments()||0});
    await fs.writeFile(output,JSON.stringify(summary,null,2)+'\n');
  }
  return summary;
}

async function main() {
  const args=process.argv.slice(2),options={periodIds:[]};
  for(let i=0;i<args.length;i++){
    const key=args[i];
    if(key==='--execute')options.execute=true;
    else if(key==='--approve-publication')options.approvePublication=true;
    else if(key==='--period')options.periodIds.push(args[++i]);
    else if(key==='--max-jobs')options.maxJobs=Number(args[++i]);
    else if(key==='--root')options.root=args[++i];
    else if(key==='--credential-file')options.credentialFile=args[++i];
    else if(key==='--output')options.output=args[++i];
    else throw Error('Unknown argument '+key);
  }
  console.log(JSON.stringify(await runTargetedEvents(options),null,2));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(error=>{console.error(error.message);process.exitCode=1;});
