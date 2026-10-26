import {COMPETITIVE_REVIEW_REASON, strongNearCloneEvidence, isCompetitiveReviewHold} from '../../workers/ranked/src/competitive-review.js';
import {inputRateEvidence} from './input-rate.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {compareInputSegment} from './segment-similarity.mjs';
import {readFileSync} from 'node:fs';
import {decodeSnapshot} from '../snapshot-package.mjs';
import {VERIFIER_ENGINE_DIGEST,VERIFIER_VERSION} from '../../workers/ranked/src/verification.js';
const {decodeReplay, sha256} = createRequire(import.meta.url)('./replay.cjs');
const evidenceByResult = new WeakMap();
const controlProofByResult = new WeakMap();
export const similarityEvidence = result => evidenceByResult.get(result);
export const verifiedControlProof = result => controlProofByResult.get(result);
let trackNames;

function catalogTrackName(trackId) {
  if (!trackNames) {
    trackNames = new Map();
    for (const file of ['../../tracks/catalog.json', '../../extra-tracks/catalog.json']) {
      try {
        const catalog = JSON.parse(readFileSync(new URL(file, import.meta.url), 'utf8'));
        for (const track of Array.isArray(catalog)?catalog:catalog.tracks||[]) {
          if (track.id) trackNames.set(track.id, track.name);
          if (track.trackId) trackNames.set(track.trackId, track.name);
        }
      } catch { /* Optional catalog failures only omit display names. */ }
    }
  }
  return trackNames.get(trackId) || null;
}

// Review evidence only: shared routes and practiced inputs are not proof of TAS.
export function compareControls(a, b, durationA, durationB) {
  const channels = controls => ['up','right','down','left','reset'].map(name => controls.lists[name]);
  a = {lists:channels(a)};
  b = {lists:channels(b)};
  const duration = Math.min(durationA, durationB);
  if (duration / Math.max(durationA, durationB) < .9) return null;
  const transitions = lists => lists.flatMap((list, channel) => list.filter(t => t <= duration).map(t => `${channel}:${t}`));
  const left = transitions(a.lists), right = transitions(b.lists);
  if (left.length < 20 || right.length < 20) return null;
  const rightSet = new Set(right);
  const transitionSimilarity = 2 * left.filter(t => rightSet.has(t)).length / (left.length + right.length);
  if (transitionSimilarity < .95) return null;
  const edges = [...new Set([0, duration, ...a.lists.flat(), ...b.lists.flat()].filter(t => t <= duration))].sort((x,y) => x-y);
  const positionsA = [0,0,0,0,0], positionsB = [0,0,0,0,0];
  let informativeMs = 0, matchedMs = 0;
  for (let i=0;i<edges.length-1;i++) {
    let stateA=0, stateB=0;
    for (let c=0;c<5;c++) {
      while (a.lists[c][positionsA[c]] <= edges[i]) positionsA[c]++;
      while (b.lists[c][positionsB[c]] <= edges[i]) positionsB[c]++;
      stateA |= (positionsA[c] % 2) << c;
      stateB |= (positionsB[c] % 2) << c;
    }
    // Ignore coasting/holding forward; otherwise simple tracks look cloned.
    if ((stateA | stateB) & 30) {
      const ms=edges[i+1]-edges[i]; informativeMs+=ms;
      if (stateA===stateB) matchedMs+=ms;
    }
  }
  if (informativeMs < 1000 || matchedMs/informativeMs < .95) return null;
  return {inputSimilarity: Number((matchedMs/informativeMs).toFixed(4)), transitionSimilarity: Number(transitionSimilarity.toFixed(4)), informativeMs};
}

function identicalInformativeInputs(a, b, duration) {
  const names=['up','right','down','left','reset'];
  if (!names.every(name => a.lists[name].length===b.lists[name].length && a.lists[name].every((tick,i)=>tick===b.lists[name][i]))) return null;
  return compareControls(a,b,duration,duration);
}

function jobResultId(job) { return job?.resultId || job?.runId; }
function submissionOrder(job) {
  for (const value of [job?.ingestedAt, job?.receivedAt]) {
    const at=value instanceof Date?value.getTime():typeof value==='number'?value:typeof value==='string'?Date.parse(value):
      typeof value?.__firestoreTimestamp==='string'?Date.parse(value.__firestoreTimestamp):NaN;
    if(Number.isSafeInteger(at)&&at>0)return at;
  }
  return Number.MAX_SAFE_INTEGER;
}

export function createSimilarityReviewer(root) {
  let packagePromise;
  const boards = new Map();
  async function snapshotPackage() {
    const pointer=JSON.parse(await fs.readFile(path.join(root,'snapshot-current.json'),'utf8'));
    if (!/^public-snapshots\d+$/.test(pointer.currentdir)) throw Error('Invalid snapshot directory');
    const dir=path.join(root,pointer.currentdir);
    const index=JSON.parse(await fs.readFile(path.join(dir,'index.json'),'utf8'));
    async function read(logical) {
      const item=index.files[logical];
      if (!item || !/^[a-f0-9]{64}\.bin$/.test(item.path)) return null;
      const bytes=await fs.readFile(path.join(dir,item.path));
      if (bytes.length>2*1024*1024 || createHash('sha256').update(bytes).digest('hex')!==item.sha256) throw Error('Invalid reference snapshot');
      return JSON.parse(Buffer.from(await decodeSnapshot(bytes)).toString('utf8'));
    }
    return {read, generation:pointer.currentdir};
  }
  async function references(trackId) {
    if (!boards.has(trackId)) {
      if(boards.size>=16) boards.delete(boards.keys().next().value);
      boards.set(trackId,(async()=>{
        const pkg=await (packagePromise ||= snapshotPackage());
        const board=await pkg.read(`tracks/${trackId}.json`);
        const entries=(board?.entries || []).filter(e=>e.runVerified===true && e.integrityVerified===true && /^[a-f0-9]{64}$/.test(e.accountId || '') && Number.isSafeInteger(e.timeMs) && e.timeMs>0).sort((a,b)=>a.timeMs-b.timeMs).slice(0,10);
        const refs=[];
        for(const entry of entries) {
          try {
            const recording=await pkg.read(`recordings/${entry.id}.json`);
            if(!recording || recording.trackId!==trackId || recording.accountId!==entry.accountId || recording.replayHash!==entry.replayHash || sha256(recording.recording)!==entry.replayHash) continue;
            refs.push({...entry, controls:decodeReplay(recording.recording,entry.timeMs), generation:pkg.generation, boardUpdatedAt:board.updatedAt});
          } catch { /* Missing/oversized historical recordings are not evidence. */ }
        }
        return refs;
      })().catch(()=>[]));
    }
    return boards.get(trackId);
  }
  return async function review(jobs, results) {
    const rows=[];
    const rowsByResult=new Map(),resultsById=new Map(results.map(item=>[item.resultId,item]));
    const buckets=new Map(), exactGroups=new Map();
    const validResult = (job,result) => result?.status==='verified' && result.engineDigest===VERIFIER_ENGINE_DIGEST &&
      (result.verifierVersion||result.binding?.verifierVersion)===VERIFIER_VERSION && result.trackId===job.trackId &&
      result.replayHash===job.replayHash && result.timeMs===job.timeMs;
    const bucketKey=(trackId,bucket)=>`${trackId}:${bucket}`;
    for(const job of jobs) {
      const result=resultsById.get(jobResultId(job));
      evidenceByResult.delete(result);
      controlProofByResult.delete(result);
      if(!result || !validResult(job,result) || !/^[a-f0-9]{64}$/.test(job.trackId) || !Number.isSafeInteger(job.timeMs)) continue;
      try {
        const controls=decodeReplay(job.replay,job.timeMs,result.binding?.resourceProfile || 'standard');
        const transitionCount=Object.values(controls.lists).reduce((sum,list)=>sum+list.length,0);
        const informative=compareControls(controls,controls,job.timeMs,job.timeMs);
        const signature=createHash('sha256').update(JSON.stringify(controls.lists)).digest('hex');
        controlProofByResult.set(result,{version:1,signature,transitions:transitionCount,informative:Boolean(informative)});
      const row={job,result,controls,comparisonAllowed:!job.correctionCandidate}; rows.push(row); rowsByResult.set(result,row);
        const bucket=Math.floor(job.timeMs/11), key=bucketKey(job.trackId,bucket);
        if(!buckets.has(key)) buckets.set(key,[]);
        buckets.get(key).push(row);
        const exactKey=`${job.trackId}:${job.timeMs}:${signature}`;
        if(!exactGroups.has(exactKey)) exactGroups.set(exactKey,[]);
        exactGroups.get(exactKey).push(row);
      } catch { /* Optional review must never change physics verification. */ }
    }
    const setEvidence=(row,ref,evidence,exact)=>{
      const {job,result}=row;
      evidenceByResult.set(result,{kind:exact?'identical_replay':'similar_top_inputs',version:1,...evidence,
        finishGapMs:Math.abs(job.timeMs-ref.timeMs),trackName:catalogTrackName(job.trackId),
        referenceAccountId:ref.accountId,referenceReplayHash:ref.replayHash,
        referenceRank:Number.isSafeInteger(ref.rank)?ref.rank:null,
        referenceSnapshot:ref.generation||'same_batch',
        referenceUpdatedAt:Number.isFinite(ref.boardUpdatedAt)?ref.boardUpdatedAt:null});
      if(exact){result.status='mismatch';result.reason='exact_duplicate_run';return;}
      const whole=compareControls(row.controls,ref.controls,job.timeMs,ref.timeMs);
      const segment=compareInputSegment(row.controls,ref.controls,job.timeMs,ref.timeMs);
      if(!whole || !segment)return;
      const ownOrder=submissionOrder(job),referenceOrder=submissionOrder(ref);
      const known=ownOrder!==Number.MAX_SAFE_INTEGER&&referenceOrder!==Number.MAX_SAFE_INTEGER;
      const chronology=known?(referenceOrder<ownOrder?'earlier_reference':referenceOrder>ownOrder?'later_reference':'unknown'):'unknown';
      const strong={...evidenceByResult.get(result),...whole,strongNearClone:true,policyVersion:'strong-near-clone-v1',
        segmentInputSimilarity:segment.inputSimilarity,segmentDurationMs:segment.endTickA-segment.startTickA,
        comparedDurationMs:Math.min(job.timeMs,ref.timeMs),matchedChanges:segment.matchedChanges,
        distinctSteeringChannels:segment.distinctSteeringChannels,offsetTicks:segment.offsetTicks,chronology};
      if(!strongNearCloneEvidence(strong))return;
      evidenceByResult.set(result,strong);
      // Unknown ownership can defer a new candidate, never revoke an accepted original.
      if(chronology==='earlier_reference'||chronology==='unknown'&&job.previouslyAccepted!==true){
        result.status='unavailable';result.reason=COMPETITIVE_REVIEW_REASON;
      }
    };
    for(const group of exactGroups.values()) {
      const candidates=group.filter(row=>row.comparisonAllowed&&verifiedControlProof(row.result)?.informative)
        .sort((a,b)=>submissionOrder(a.job)-submissionOrder(b.job)||String(jobResultId(a.job)).localeCompare(String(jobResultId(b.job))));
      if(candidates.length<2||new Set(candidates.map(row=>row.job.accountId)).size<2) continue;
      const firstByAccount=new Map();
      for(const row of candidates)if(!firstByAccount.has(row.job.accountId))firstByAccount.set(row.job.accountId,row);
      for(const row of candidates){
        const ownOrder=submissionOrder(firstByAccount.get(row.job.accountId).job);
        const peers=[...firstByAccount.values()].filter(other=>other.job.accountId!==row.job.accountId);
        const earlier=peers.find(other=>submissionOrder(other.job)<ownOrder&&ownOrder!==Number.MAX_SAFE_INTEGER);
        const ambiguous=ownOrder===Number.MAX_SAFE_INTEGER||peers.some(other=>
          submissionOrder(other.job)===Number.MAX_SAFE_INTEGER||submissionOrder(other.job)===ownOrder);
        if(!earlier&&!ambiguous)continue;
        const ref=earlier||peers[0],evidence=compareControls(row.controls,ref.controls,row.job.timeMs,ref.job.timeMs);
        if(!evidence)continue;
        setEvidence(row,{...ref.job,replayHash:ref.job.replayHash},evidence,true);
        // IDs cannot establish submission order; only a definitely earlier other account can.
        if(!earlier){row.result.status='unavailable';row.result.reason='identical_replay_pending_manual_review';}
      }
    }
    for (const result of results) {
      if(result.status!=='verified' || similarityEvidence(result)) continue;
      const row=rowsByResult.get(result);
      if(!row || !row.comparisonAllowed) continue;
      try {
        const {job,controls}=row;
        const ownProof=verifiedControlProof(result);
        const slotReference=(job.verifiedControlReferences||[]).find(ref=>ref.accountId!==job.accountId&&
          ref.timeMs===job.timeMs&&ref.informative===true&&ref.signature===ownProof?.signature);
        if(slotReference&&ownProof?.informative) {
          setEvidence(row,{...slotReference,generation:'verified_queue_slot'},
            {inputSimilarity:1,transitionSimilarity:1,informativeMs:compareControls(controls,controls,job.timeMs,job.timeMs).informativeMs},true);
          continue;
        }
        const nearby=[];
        const bucket=Math.floor(job.timeMs/11);
        for(let offset=-1;offset<=1&&nearby.length<10;offset++) for(const candidate of buckets.get(bucketKey(job.trackId,bucket+offset))||[]) {
          if(candidate!==row && (candidate.result.status==='verified'||isCompetitiveReviewHold(candidate.result)) && candidate.job.accountId!==job.accountId && Math.abs(candidate.job.timeMs-job.timeMs)<=10) nearby.push(candidate);
          if(nearby.length>=10) break;
        }
        // A copied opening can survive a deliberately slower finish. Keep this
        // local comparison bounded to ten same-track references, with near ties first.
        for(const candidate of rows) {
          if(nearby.length>=10)break;
          if(candidate!==row&&(candidate.result.status==='verified'||isCompetitiveReviewHold(candidate.result))&&candidate.job.trackId===job.trackId&&candidate.job.accountId!==job.accountId&&!nearby.includes(candidate))nearby.push(candidate);
        }
        for(const candidate of nearby.slice(0,10)) {
          const evidence=(Math.abs(job.timeMs-candidate.job.timeMs)<=10?compareControls(controls,candidate.controls,job.timeMs,candidate.job.timeMs):null)
            || compareInputSegment(controls,candidate.controls,job.timeMs,candidate.job.timeMs);
          if(evidence) {
            setEvidence(row,{...candidate.job,controls:candidate.controls,generation:'same_batch'},evidence,false);
            break;
          }
        }
        if(similarityEvidence(result)) continue;
        for(const ref of (await references(job.trackId)).filter(item=>item.accountId!==job.accountId)) {
          const exact=job.timeMs===ref.timeMs?identicalInformativeInputs(controls,ref.controls,job.timeMs):null;
          const evidence=exact || (Math.abs(job.timeMs-ref.timeMs)<=10?compareControls(controls,ref.controls,job.timeMs,ref.timeMs):null)
            || compareInputSegment(controls,ref.controls,job.timeMs,ref.timeMs);
          if(evidence) { setEvidence(row,ref,evidence,Boolean(exact)); break; }
        }
      } catch { /* An optional review must never change physics verification. */ }
    }
    for(const row of rows){
      if(row.result.status!=='verified'||!row.comparisonAllowed||similarityEvidence(row.result))continue;
      const evidence=inputRateEvidence(row.controls,row.job.timeMs);
      if(evidence)evidenceByResult.set(row.result,{...evidence,trackName:catalogTrackName(row.job.trackId)});
    }
    return results;
  };
}
