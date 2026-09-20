import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../src/index.js';
import { eventPeriod, createEventService, EVENT_COLLECTIONS as C } from '../src/events.js';
import { eventEncode, eventDecode, createEventFirestoreStore } from '../src/events-store.js';
import { VERIFIER_ENGINE_DIGEST, VERIFIER_VERSION } from '../src/verification.js';

test('actual Worker routes accept seven-field run without session and publish matching read contracts', async () => {
  const at = Date.now(), accountId = 'b'.repeat(64), trackId = 'a'.repeat(64), data = new Map();
  const capacity = { policyVersion: 'test', entrants: 200, admissionsPerPeriod: 2048,
    replayBytesPerPeriod: 16777216, minIntervalMs: 5000, verificationsPerDay: 1536 };
  const period = eventPeriod({ id: 'd_test', enabled: true, kind: 'daily', maxRp: 100,
    trackId, startsAt: at - 10000, endsAt: at + 86400000 - 10000, graceMs: 86400000,
    targetMs: 10000, capacity, eligibility: 'best-submitted-during-period' });
  data.set(`${C.periods}/d_test`, period);
  data.set(`${C.catalog}/main`, { periods: [period] });
  data.set(`${C.queues}/d_test`, { slots: [], runIds: [], subjects: [], admitted: 0, entrants: 0, replayBytes: 0 });
  data.set(`${C.profiles}/${accountId}`, { ownerUid: 'user1', accountId, name: 'Racer' });
  let reads = 0; const commits = [];
  const env = { EVENTS_ENABLED: 'true', FIREBASE_PROJECT_ID: 'polytrack-052',
    ALLOWED_ORIGINS: 'https://example.test', __TEST_UID: 'user1',
    EVENT_RATE_LIMITER: { limit: async () => ({ success: true }) },
    __TEST_FIRESTORE: async (path, init) => {
      if (path === ':beginTransaction') { reads = 0; return { transaction: 'test' }; }
      if (path === ':rollback') return {};
      if (path === ':commit') {
        const body = JSON.parse(init.body); assert.equal(body.transaction, 'test');
        commits.push({ reads, writes: body.writes.length });
        for (const write of body.writes) {
          const key = (write.update?.name || write.delete).split('/documents/')[1];
          if (write.delete) { data.delete(key); continue; }
          const fields = eventDecode({ mapValue: { fields: write.update.fields } });
          data.set(key, write.updateMask ? { ...data.get(key), ...fields } : fields);
        }
        return {};
      }
      const key = path.slice(1).split('?')[0];
      reads++;
      return data.has(key) ? { updateTime: new Date(at).toISOString(), fields: eventEncode(data.get(key)).mapValue.fields } : null;
    } };
  const request = (route, body) => new Request('https://worker.test/v1/events/' + route, {
    method: body ? 'POST' : 'GET', headers: { Origin: 'https://example.test', 'Content-Type': 'application/json', 'CF-Connecting-IP': '127.0.0.1' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  const body = { accountId, trackId, attemptId: 'native1', timeMs: 20402, frames: 20402, replay: 'AAAA', carStyle: '' };
  const response = await handleRequest(request('d_test/runs', body), env);
  assert.equal(response.status, 202); assert.equal((await response.json()).status, 'waiting');
  assert.equal(data.get(`${C.queues}/d_test`).admitted, 1);
  const receipt = await (await handleRequest(request('d_test/receipt?accountId=' + accountId), env)).json();
  assert.equal(receipt.attemptId, 'native1'); assert.equal(receipt.status, 'waiting');
  const catalog = await (await handleRequest(request('catalog'), env)).json();
  assert.equal(catalog.periods[0].id, period.id); assert.equal(typeof catalog.periods[0].startsAt, 'number');
  assert.deepEqual((await (await handleRequest(request('totals'), env)).json()).entries, []);
  const snapshot = await (await handleRequest(request('d_test/snapshot'), env)).json();
  assert.equal(snapshot.period.id, period.id); assert.deepEqual(snapshot.entries, []);
  assert.equal((await handleRequest(request('d_test/sessions', body), env)).status, 404);
  assert.equal((await handleRequest(request('catalog'), { ...env, EVENTS_ENABLED: 'false' })).status, 503);
  // Exercise the production adapter, not the memoryStore core fixture. Native
  // physics is intentionally replaced by an exact bound verdict for this test.
  const service = createEventService({ store: createEventFirestoreStore({ request: env.__TEST_FIRESTORE, projectId: 'polytrack-052' }) });
  const [job] = await service.leaseJobs('d_test');
  const binding = { resultId: job.resultId, trackId, nativeTrackId: trackId, timeMs: job.timeMs,
    replayHash: job.replayHash, actualReplayHash: job.replayHash,
    engineDigest: VERIFIER_ENGINE_DIGEST, verifierVersion: VERIFIER_VERSION };
  const published = await service.completeJob('d_test', job, { resultId: job.resultId, trackId,
    timeMs: job.timeMs, replayHash: job.replayHash, engineDigest: VERIFIER_ENGINE_DIGEST,
    binding, status: 'verified', reason: 'native_exact_finish' });
  assert.equal(published.canonicalImproved, true); assert.equal(published.eventImproved, true);
  assert.deepEqual(commits.at(-1), { reads: 12, writes: 9 });
  assert(commits.every(c => c.reads <= 16 && c.writes <= 16));
  assert.equal(data.get(`${C.receipts}/d_test_${accountId}`).status, 'verified');
  assert.equal(data.get(`${C.profiles}/${accountId}`).pbCount, 1);
  assert.equal(data.get(`${C.canonical}/${accountId}_${trackId}`).timeMs, 20402);
});
