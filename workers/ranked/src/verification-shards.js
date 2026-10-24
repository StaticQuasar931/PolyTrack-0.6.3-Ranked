import {pendingSlot, verificationKey, hasAcceptedVerifiedProof, verificationSchedule} from './verification.js';

export const VERIFICATION_SHARD_VERSION = 2;
export const VERIFICATION_MIGRATION_BATCH = 48;
export function verificationShardId(trackId, accountId) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(trackId) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(accountId)) throw Error('INVALID_VERIFICATION_SHARD_ID');
  // One account per shard is a strict size bound, independent of population/hash skew.
  return `${trackId}_${accountId}`;
}
export function queueDocumentId(document) {
  return document?.data?.queueId || document?.id || String(document?.name || '').split('/').pop() || document?.data?.trackId;
}
function nextSlot(row, slot) {
  return slot?.reason === 'canonical_missing' || slot?.key !== verificationKey(row) && !hasAcceptedVerifiedProof(row, slot)
    ? pendingSlot(row) : slot;
}

// Each move removes legacy slots only in the same CAS commit as their new homes.
// An old runner writing the legacy root consequently conflicts, never resurrects a proof.
export async function migrateVerificationChunk({trackId, collection, root, read, readMany, commit}) {
  const selected = Object.entries(root?.data?.slots || {}).slice(0, VERIFICATION_MIGRATION_BATCH);
  if (!selected.length && root?.data?.storageVersion === VERIFICATION_SHARD_VERSION) return root;
  const slots = {...root?.data?.slots}, writes = [];
  const documents = readMany ? await readMany(collection,selected.map(([accountId])=>verificationShardId(trackId,accountId))) : null;
  for (const [accountId, legacySlot] of selected) {
    const id = verificationShardId(trackId, accountId), prior = documents ? documents.get(id) : await read(collection, id);
    // A shard updated since migration began wins; never overwrite its newer binding.
    if (!prior) writes.push({collection, id, prior:null, data:{trackId, queueId:id, storageVersion:2,
      slots:{[accountId]:legacySlot}, ...verificationSchedule({[accountId]:legacySlot}), updatedAt:Date.now()}});
    delete slots[accountId];
  }
  const data = {...root?.data, trackId, storageVersion:2, slots, ...verificationSchedule(slots),
    migrationComplete:Object.keys(slots).length === 0, updatedAt:Date.now()};
  const result = await commit([...writes, {collection, id:trackId, prior:root, data}]);
  const updateTime = result?.writeResults?.at(-1)?.updateTime;
  // The adapter must refresh the CAS preimage if its commit response omits versions.
  return updateTime ? {id:trackId, data, updateTime} : await read(collection, trackId);
}

export async function prepareShardedVerification({trackId, collection, rows, root, read, readMany, commit}) {
  const verdicts = Object.assign(Object.create(null), root?.data?.slots || {});
  for (let start = 0; start < rows.length; start += VERIFICATION_MIGRATION_BATCH) {
    const writes = [];
    const batch = rows.slice(start,start+VERIFICATION_MIGRATION_BATCH);
    const documents = readMany ? await readMany(collection,batch.map(row=>verificationShardId(trackId,row.accountId||row.userId))) : null;
    for (const row of batch) {
      const accountId = row.accountId || row.userId, id = verificationShardId(trackId, accountId);
      const prior = documents ? documents.get(id) : await read(collection, id);
      const previous = prior?.data?.slots?.[accountId] || verdicts[accountId];
      const slot = nextSlot(row, previous);
      verdicts[accountId] = slot;
      if (!prior || slot !== previous) writes.push({collection, id, prior, data:{trackId, queueId:id,
        storageVersion:2, slots:{[accountId]:slot}, ...verificationSchedule({[accountId]:slot}), updatedAt:Date.now()}});
    }
    if (writes.length) await commit(writes);
  }
  return verdicts;
}
