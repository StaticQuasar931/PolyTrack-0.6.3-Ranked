import {canRecoverExpiredTrackBuild, trackBuildDisposition, trackBuildId, TRACK_BUILD_JOBS,
  TRACK_BUILD_DEADLINE_POLICY, TRACK_BUILD_CONTINUATION_MS, TRACK_BUILD_MAX_AGE_MS} from './track-build.js';

const QUEUE_ID = 'canonical_reconcile_v2';

// Explicit admin work only: never enumerate tracks, scan changes, seed proofs or
// aggregate Overall. The original full-build adapter owns proof and publication CAS.
export async function continueQueuedTrackBuild(input, {read, commit, rebuild, beforePublish = () => {}, now = Date.now()}) {
  const {trackId, generation, checkpointVersion, recoverExpired = false} = input || {};
  const fail = (status,error,extra={}) => ({status,body:{error,...extra}});
  if (typeof trackId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(trackId) ||
      typeof generation !== 'string' || !/^[a-f0-9]{64}$/.test(generation) ||
      typeof checkpointVersion !== 'string' || !checkpointVersion || checkpointVersion.length > 128 ||
      typeof recoverExpired !== 'boolean') return fail(400,'invalid_track_build_checkpoint');
  if (!Number.isSafeInteger(now) || now < 0) throw Error('TRACK_BUILD_CLOCK_INVALID');
  const queue = await read(TRACK_BUILD_JOBS,QUEUE_ID), queued = queue?.data;
  if (!queued?.pendingTrackIds?.includes(trackId) || !queued.pendingFullRebuildTrackIds?.includes(trackId))
    return fail(409,'track_build_not_queued');
  if (queued.activeFullRebuildTrackId && queued.activeFullRebuildTrackId !== trackId)
    return fail(409,'another_track_build_active');
  const prior = await read('0.6.2_s1_leaderboards_track',trackId);
  let job = await read(TRACK_BUILD_JOBS,trackBuildId(trackId));
  if (!job || job.updateTime !== checkpointVersion || job.data?.generation !== generation)
    return fail(409,'track_build_checkpoint_changed');
  if (job.data.complete !== false || job.data.baseVersion !== (prior?.updateTime || ''))
    return fail(409,'track_build_base_changed');
  const disposition = trackBuildDisposition({prior,job,now});
  if (recoverExpired) {
    if (!canRecoverExpiredTrackBuild({prior,job,now})) return fail(409,'track_build_recovery_not_eligible');
    const archiveId = `${trackBuildId(trackId)}_deadline_recovery_v${TRACK_BUILD_DEADLINE_POLICY}`;
    const reserved = {...job.data,deadlinePolicy:TRACK_BUILD_DEADLINE_POLICY,
      deadlineRecovery:{archiveId,previousGeneration:generation,reserved:true,reservedAt:now}};
    // Consume recovery before any fresh canonical read. Failure after this commit
    // leaves the old block fenced; retrying cannot acquire a second read point.
    const saved = await commit([
      {collection:TRACK_BUILD_JOBS,id:archiveId,prior:null,
        data:{checkpoint:job.data,checkpointVersion:job.updateTime,recoveredAt:now,policy:TRACK_BUILD_DEADLINE_POLICY}},
      {collection:TRACK_BUILD_JOBS,id:trackBuildId(trackId),prior:job,data:reserved}
    ]);
    const version = saved?.writeResults?.at(-1)?.updateTime;
    job = version ? {data:reserved,updateTime:version} : await read(TRACK_BUILD_JOBS,trackBuildId(trackId));
  } else {
    if (disposition.action !== 'resume') return fail(409,'track_build_blocked',{reason:disposition.reason || disposition.action});
    if (Number(job.data.nextContinuationAt || 0) > now)
      return fail(429,'track_build_continuation_not_due',{retryAfterMs:job.data.nextContinuationAt-now});
  }
  const result = await rebuild(trackId,{prepared:{prior,job},recovery:recoverExpired,continuation:true});
  if (result.blocked || result.restart) return fail(409,'track_build_blocked',{reason:result.reason || 'restart'});
  const pending = result.pending === true;
  const failures = {...queued.failedFullRebuilds};
  delete failures[trackId];
  const full = pending ? queued.pendingFullRebuildTrackIds : queued.pendingFullRebuildTrackIds.filter(id=>id!==trackId);
  // Keyed PBs may postdate the fixed read point. Never discharge them with a full scan.
  const keepTrack = pending || queued.pendingResultIds?.[trackId]?.length || queued.backfillCatchupTrackIds?.includes(trackId);
  const state = {...queued,failedFullRebuilds:failures,pendingFullRebuildTrackIds:full,
    pendingTrackIds:keepTrack ? queued.pendingTrackIds : queued.pendingTrackIds.filter(id=>id!==trackId),
    activeFullRebuildTrackId:pending ? trackId : '',updatedAt:now};
  const publications = result.publicationDocuments || [];
  if (publications.length > 5) throw Error('RECONCILE_PUBLICATION_WRITE_BUDGET');
  await beforePublish();
  await commit([...publications,{collection:TRACK_BUILD_JOBS,id:QUEUE_ID,prior:queue,data:state}]);
  return {status:200,body:{pending,complete:!pending,
    ...(pending ? {generation:result.generation,checkpointVersion:result.checkpointVersion,
      sourceCount:result.sourceCount,continueAfterMs:TRACK_BUILD_CONTINUATION_MS,
      deadlineAt:Date.parse(result.sourceReadTime)+TRACK_BUILD_MAX_AGE_MS} : {revision:result.revision})}};
}
