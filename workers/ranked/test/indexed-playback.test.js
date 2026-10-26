import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {createEventService,eventPeriod,EVENT_COLLECTIONS as C} from '../src/events.js';
import {VERIFIER_ENGINE_DIGEST as engine,VERIFIER_VERSION as version,VERIFICATION_BOOTSTRAP_ID,hasAcceptedVerifiedProof,verificationKey,bootstrapSlots} from '../src/verification.js';
import {compatibleEventEngine,PRE_EVENT_LAUNCH_ENGINE} from '../src/event-engine-compatibility.js';
const account = 'b'.repeat(64), track = 'a'.repeat(64);
const hash = value => createHash('sha256').update(value).digest('hex');
const replay = deflateSync(Buffer.alloc(15)).toString('base64url');
const capacity = { policyVersion: 'test-reviewed-v1', entrants: 200, admissionsPerPeriod: 512,
  replayBytesPerPeriod: 8388608, minIntervalMs: 1000, verificationsPerDay: 128 };
const inputPeriod = { id: 'day1', enabled: true, trackId: track, startsAt: 1000, endsAt: 86401000,
  graceMs: 3600000, targetMs: 10000, maxRp: 1000, capacity, eligibility: 'best-submitted-during-period' };
const p = eventPeriod(inputPeriod);
function verdict(job, override = {}) {
  return { resultId: job.resultId, timeMs: job.timeMs, trackId: job.trackId,
    replayHash: job.replayHash, status: 'verified', reason: 'native_exact_finish', engineDigest: engine,
    binding: { resultId: job.resultId, timeMs: job.timeMs, trackId: job.trackId, nativeTrackId: job.trackId,
      replayHash: job.replayHash, actualReplayHash: job.replayHash, engineDigest: engine, verifierVersion: version }, ...override };
}
function memoryStore() {
  const data = new Map(), counts = []; let serial = Promise.resolve(), failPath = null;
  return { data, counts, fail: value => { failPath = value; }, transaction(fn) {
    const operation = serial.then(async () => {
      const copy = structuredClone(data), reads = new Set(); let writing = false, writes = 0;
      const write = (k, v, mode) => {
        if (k === failPath) throw Error('simulated_write_failure');
        writing = true;
        assert(++writes <= 16, 'bounded transaction writes');
        if (mode !== 'create') assert(reads.has(k), 'write requires a read');
        if (mode === 'create' && copy.has(k)) throw Error('already_exists');
        if (mode === 'delete') copy.delete(k);
        else copy.set(k, structuredClone(mode === 'patch' ? { ...copy.get(k), ...v } : v));
      };
      const result = await fn({ get: async k => { assert(!writing, 'all reads before writes'); reads.add(k); assert(reads.size <= 16, 'bounded transaction reads'); return structuredClone(copy.get(k) || null); },
        create: (k, v) => write(k, v, 'create'), set: (k, v) => write(k, v, 'set'),
        patch: (k, v) => write(k, v, 'patch'), delete: k => write(k, null, 'delete') });
      counts.push({ reads: reads.size, writes });
      data.clear(); for (const [k, v] of copy) data.set(k, v); return result;
    });
    serial = operation.catch(() => {}); return operation;
  }};
}
function fixture() {
  const store = memoryStore(); let time = 0, nonce = 0;
  store.data.set(`${C.profiles}/${account}`, { accountId: account, ownerUid: 'user1', name: 'Native Racer' });
  const service = createEventService({ store, now: () => time, hash, randomId: () => `lease_${nonce++}` });
  return { service, store, data: store.data, time: t => { time = t; }, advance: () => { time += 1000; },
    async start(period = inputPeriod) { await service.bindOwner('user1', account); await service.createPeriod(period); time = 1000; },
    submit: (ms = 20402, attemptId = 'run1', extra = {}) => service.submit('day1', 'user1', {
      accountId: account, trackId: track, attemptId, timeMs: ms, frames: ms, replay, carStyle: 'test', ...extra }),
    run: runId => store.data.get(`${C.runs}/${runId}`),
    canonical: () => store.data.get(`${C.canonical}/${account}_${track}`),
    async publish() { return service.processBatch('day1', async jobs => jobs.map(j => verdict(j))); }
  };
}


const oldNormal=['7cd54f05e02b66c67133fd856f025c829c21d600d8ef6a9071df62b4fb5905c4','8249dd184ae2e804b77a2eb3b6551a5569ace0e2695a9de235ecae0bb32efd4b','46aba6e247567f5954d412e0988e3d2cd04e9ec154c294bdf3fcaa830d9d12f3','246a1dcdc272cc2c59a1433da3e31b2cd3dfd017ee8235d5288987127a3cf578','32bfe32b8680597d9f1322dbcbb19242be38bee9ab243a379f5e449c3f4030fd','895eeacbdfdd5f68b9db92c502af620709539c5211782809f610c1a76e60785d'];
const current='3cb2e59839b5ad85ea34d892e1f10ca7dc04f9d8cec17770fbd843673614a3a0';
const row={accountId:account,trackId:track,timeMs:20402,frames:20402,uploadId:123,replayHash:'c'.repeat(64)};
const proof=d=>({status:'verified',verifierVersion:version,engineDigest:d,key:JSON.stringify([version,d,account,track,row.timeMs,row.frames,row.uploadId,row.replayHash])});
test('indexed pin retains all explicitly accepted normal proofs without requeue',()=>{assert.equal(engine,current);for(const d of [...oldNormal,current]){const accepted=proof(d);assert.equal(hasAcceptedVerifiedProof(row,accepted),true,d);assert.deepEqual({...bootstrapSlots(track,[row],{[account]:accepted})},{[account]:accepted});}});
test('arbitrary normal digest and changed binding are rejected',()=>{for(const d of ['d'.repeat(64),PRE_EVENT_LAUNCH_ENGINE,''])assert.equal(hasAcceptedVerifiedProof(row,proof(d)),false);for(const change of [{timeMs:20403},{uploadId:124},{replayHash:'d'.repeat(64)},{frames:20403}])assert.equal(hasAcceptedVerifiedProof({...row,...change},proof(oldNormal[0])),false);});
test('new normal key binds the exact current engine and bootstrap remains stable',()=>{assert.equal(JSON.parse(verificationKey(row))[1],current);assert.equal(VERIFICATION_BOOTSTRAP_ID,'verification_snapshot_v3_'+version+'_'+oldNormal[2]);});
test('reviewed historical event periods remain readable, arbitrary engine rejected',async()=>{for(const d of [...oldNormal,PRE_EVENT_LAUNCH_ENGINE,current]){assert.equal(compatibleEventEngine(d),true);const f=fixture();await f.start();f.data.get(C.periods+'/day1').engineDigest=d;assert.equal((await f.service.snapshot('day1')).period.id,'day1');}const f=fixture();await f.start();f.data.get(C.periods+'/day1').engineDigest='d'.repeat(64);assert.equal(compatibleEventEngine('d'.repeat(64)),false);await assert.rejects(f.service.snapshot('day1'),/event_version_unavailable/);});
test('new event completions reject every prior digest and accept only exact current proof',async()=>{for(const d of [...oldNormal,PRE_EVENT_LAUNCH_ENGINE,'d'.repeat(64),current]){const f=fixture();await f.start();f.data.get(C.periods+'/day1').engineDigest=oldNormal[0];await f.submit();const [job]=await f.service.leaseJobs('day1');const result=verdict(job);result.engineDigest=d;result.binding.engineDigest=d;if(d===current){assert.equal((await f.service.completeJob('day1',job,result)).status,'verified');assert.equal(f.run(job.resultId).proof.engineDigest,current);}else{const before=structuredClone(f.data);await assert.rejects(f.service.completeJob('day1',job,result),/verifier_proof_mismatch/);assert.deepEqual(f.data,before);}}});

test('stored historical event proofs and boards are retained without mutation',async()=>{for(const d of oldNormal){const f=fixture();await f.start();const receipt=await f.submit();await f.publish();f.data.get(C.periods+'/day1').engineDigest=d;f.run(receipt.runId).proof.engineDigest=d;const before=structuredClone(f.data),snapshot=await f.service.snapshot('day1');assert.equal(snapshot.entries.length,1);assert.equal(snapshot.entries[0].accountId,account);assert.deepEqual(f.data,before);}});
test('current event envelope never permits an obsolete proof binding',async()=>{const f=fixture();await f.start();await f.submit();const [job]=await f.service.leaseJobs('day1'),result=verdict(job);result.binding.engineDigest=oldNormal[0];const before=structuredClone(f.data);await assert.rejects(f.service.completeJob('day1',job,result),/verifier_proof_mismatch/);assert.deepEqual(f.data,before);});

test('unpublished draft 512 is not an accepted proof or period engine',()=>{const d='51258f231e15e2acb7e2ba852476985255a6ccdbf1fa141ebb6d4ed859c13bf2';assert.equal(hasAcceptedVerifiedProof(row,proof(d)),false);assert.equal(compatibleEventEngine(d),false);});
