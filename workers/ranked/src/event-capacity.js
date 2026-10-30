export const EVENT_RETENTION_COLLECTION = '0.6.2_event_retention_pages';
export const EVENT_RETENTION_PAGE_SIZE = 100;
export const EVENT_REVIEWED_MAX_ENTRANTS = 10000;
export const EVENT_REVIEWED_MAX_SUBMISSIONS = 32768;

// Only storage-v2 periods may opt into larger reviewed admission policies.
// Native verifier limits, rate limits, replay quota and outstanding work stay bounded.
export function eventCapacityStorage(input) {
  return input?.storageVersion === 2 || input?.capacity?.storageVersion === 2 ? 2 : 1;
}

// Reuse the provisioning read. Only a monotonic, active-period upgrade may write.
export function eventCapacityUpgradeRequired(period, capacity, at) {
  if (!period || !capacity || capacity.storageVersion !== 2 || period.archived === true ||
      period.enabled !== true || !Number.isSafeInteger(period.startsAt) || !Number.isSafeInteger(period.endsAt) ||
      !Number.isSafeInteger(at) || at < period.startsAt || at >= period.endsAt) return false;
  const previous = period.capacity;
  if (!previous || !Number.isSafeInteger(previous.entrants) || !Number.isSafeInteger(previous.admissionsPerPeriod) ||
      !Number.isSafeInteger(capacity.entrants) || capacity.entrants < previous.entrants ||
      capacity.entrants > EVENT_REVIEWED_MAX_ENTRANTS ||
      !Number.isSafeInteger(capacity.admissionsPerPeriod) || capacity.admissionsPerPeriod < previous.admissionsPerPeriod ||
      capacity.admissionsPerPeriod > EVENT_REVIEWED_MAX_SUBMISSIONS) return false;
  return eventCapacityStorage(period) !== 2 || capacity.entrants > previous.entrants ||
    capacity.admissionsPerPeriod > previous.admissionsPerPeriod;
}
export async function prepareEventRetention(tx, periodId, queue, runId, accountId, ownerHash, newSubject) {
  const page = Math.floor(Number(queue.retentionCount || 0) / EVENT_RETENTION_PAGE_SIZE);
  const target = `${EVENT_RETENTION_COLLECTION}/${periodId}_${page}`;
  const prior = await tx.get(target) || {runIds:[],subjects:[]};
  if (prior.runIds.length >= EVENT_RETENTION_PAGE_SIZE) throw Error('EVENT_RETENTION_PAGE_FULL');
  return {target, data:{runIds:[...prior.runIds,runId],subjects:newSubject?[...prior.subjects,{accountId,ownerHash}]:prior.subjects},
    retentionCount:Number(queue.retentionCount||0)+1,retentionPages:page+1};
}
export function eventRetentionPaths(page, periodId, collections) {
  return [...(page?.runIds||[]).map(runId=>`${collections.runs}/${runId}`),
    ...(page?.subjects||[]).flatMap(({accountId,ownerHash})=>[
      `${collections.quotas}/${periodId}_${ownerHash}`,`${collections.pbs}/${periodId}_${accountId}`,
      `${collections.inbox}/${periodId}_${accountId}`,`${collections.cursors}/${periodId}_${accountId}`,
      `${collections.retries}/${periodId}_${accountId}`,`${collections.receipts}/${periodId}_${accountId}`])];
}
