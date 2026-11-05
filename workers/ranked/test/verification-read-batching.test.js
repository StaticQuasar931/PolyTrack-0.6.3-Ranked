import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareShardedVerification, verificationShardId} from '../src/verification-shards.js';
import {pendingSlot, VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION} from '../src/verification.js';
import {COMPETITIVE_REVIEW_REASON} from '../src/competitive-review.js';

const trackId = 'batch-proof-track', collection = 'private-verification';
const rowsFor = count => Array.from({length:count}, (_, i) => ({accountId:'r'+i,trackId,
  timeMs:10000+i,frames:10000+i,raceTimeFrames:10000+i,uploadId:1,replayHash:'a'.repeat(64)}));
const accepted = row => ({...pendingSlot(row),status:'verified',engineDigest:VERIFIER_ENGINE_DIGEST,verifierVersion:VERIFIER_VERSION});
function fixture(count, verified = true) {
  const rows = rowsFor(count), documents = new Map(), reads = [], commits = [];
  let version = 0;
  for (const row of rows) if (verified) documents.set(verificationShardId(trackId,row.accountId),
    {updateTime:'initial',data:{slots:{[row.accountId]:accepted(row)}}});
  const options = {trackId,collection,rows,root:{data:{storageVersion:2,slots:{}}},
    read:async () => assert.fail('no individual-read fallback'),
    readMany:async (c,ids) => {
      assert.equal(c,collection);assert.ok(ids.length<=100);reads.push([...ids]);
      return new Map(ids.filter(id=>documents.has(id)).map(id=>[id,structuredClone(documents.get(id))]));
    },
    commit:async writes => {
      assert.ok(writes.length<=48);
      for (const write of writes) assert.equal(write.prior?.updateTime,documents.get(write.id)?.updateTime,'CAS preimage must still match');
      for (const write of writes) documents.set(write.id,{data:structuredClone(write.data),updateTime:'v'+(++version)});
      commits.push(writes);
    }};
  return {rows,documents,reads,commits,options};
}

for (const [count,batches] of [[0,[]],[1,[1]],[48,[48]],[49,[49]],[96,[96]],[100,[100]],[101,[48,48,5]]])
test(`current proof batching preserves every preimage for ${count} rows`, async () => {
  const f=fixture(count),verdicts=await prepareShardedVerification(f.options);
  assert.deepEqual(f.reads.map(ids=>ids.length),batches);
  assert.equal(f.reads.flat().length,count);
  assert.equal(f.commits.length,0);
  for (const row of f.rows) assert.deepEqual(verdicts[row.accountId],f.documents.get(verificationShardId(trackId,row.accountId)).data.slots[row.accountId]);
});

test('one 100-row read still creates missing proofs in 48/48/4 CAS batches',async () => {
  const f=fixture(100,false),verdicts=await prepareShardedVerification(f.options);
  assert.deepEqual(f.reads.map(ids=>ids.length),[100]);
  assert.deepEqual(f.commits.map(writes=>writes.length),[48,48,4]);
  assert.ok(f.commits.flat().every(write=>write.prior===undefined));
  assert.ok(Object.values(verdicts).every(slot=>slot.status==='waiting'));
});

test('fresh page read preserves an exact old-engine manual hold without a write',async () => {
  const f=fixture(100),row=f.rows[99],id=verificationShardId(trackId,row.accountId);
  const hold={...pendingSlot(row),status:'unavailable',reason:COMPETITIVE_REVIEW_REASON,retryAt:Number.MAX_SAFE_INTEGER};
  const key=JSON.parse(hold.key);key[1]='b'.repeat(64);hold.key=JSON.stringify(key);
  f.documents.set(id,{updateTime:'new-hold',data:{slots:{[row.accountId]:hold}}});
  const verdicts=await prepareShardedVerification(f.options);
  assert.deepEqual(verdicts[row.accountId],hold);
  assert.equal(f.commits.length,0);
});

test('a hold racing a later write batch conflicts instead of being overwritten',async () => {
  const f=fixture(100,false),row=f.rows[50],id=verificationShardId(trackId,row.accountId);
  const commit=f.options.commit;
  f.options.commit=async writes => {
    if (f.commits.length===1) f.documents.set(id,{updateTime:'new-hold',data:{slots:{[row.accountId]:
      {...pendingSlot(row),status:'unavailable',reason:COMPETITIVE_REVIEW_REASON,retryAt:Number.MAX_SAFE_INTEGER}}}});
    await commit(writes);
  };
  await assert.rejects(prepareShardedVerification(f.options),/CAS preimage must still match/);
  assert.equal(f.commits.length,1);
  assert.equal(f.documents.get(id).data.slots[row.accountId].reason,COMPETITIVE_REVIEW_REASON);
});

test('current preimages are never retained across invocations',async () => {
  const f=fixture(100),row=f.rows[0],id=verificationShardId(trackId,row.accountId);
  await prepareShardedVerification(f.options);
  const revoked={...pendingSlot(row),status:'rejected',reason:'revoked'};
  f.documents.set(id,{updateTime:'revoked',data:{slots:{[row.accountId]:revoked}}});
  const verdicts=await prepareShardedVerification(f.options);
  assert.deepEqual(f.reads.map(ids=>ids.length),[100,100]);
  assert.deepEqual(verdicts[row.accountId],revoked);
  assert.equal(f.commits.length,0);
});

for (const invalid of [null,undefined,{},[]]) test('invalid page response fails without writes or fallback: '+String(invalid),async () => {
  const f=fixture(100,false);f.options.readMany=async()=>invalid;
  await assert.rejects(prepareShardedVerification(f.options),/VERIFICATION_PAGE_BATCH_INVALID/);
  assert.equal(f.commits.length,0);
});

test('failed page transport has no write or individual-read fallback',async () => {
  const f=fixture(100,false);f.options.readMany=async()=>{throw Error('FIRESTORE_503');};
  await assert.rejects(prepareShardedVerification(f.options),/FIRESTORE_503/);
  assert.equal(f.commits.length,0);
});
