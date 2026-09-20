import test from 'node:test';
import assert from 'node:assert/strict';
import { eventWorkerMaintenance } from '../src/events-worker.js';
import { eventPeriod, EVENT_COLLECTIONS as C } from '../src/events.js';
import { eventEncode, eventDecode } from '../src/events-store.js';

test('delayed cron intake uses advancing processing clock, not scheduled timestamp or phase', async () => {
  const accountId = 'b'.repeat(64), trackId = 'a'.repeat(64), at = 120000;
  let wallClock = 301000;
  const receivedAt = { __firestoreTimestamp: new Date(305000).toISOString() };
  const period = eventPeriod({ id: 'd_clock', enabled: true, kind: 'daily', trackId,
    startsAt: 1000, endsAt: 86401000, graceMs: 86400000, maxRp: 100, targetMs: 10000,
    eligibility: 'best-submitted-during-period', capacity: { policyVersion: 'test', entrants: 200,
      admissionsPerPeriod: 2048, replayBytesPerPeriod: 16777216, minIntervalMs: 5000, verificationsPerDay: 1536 } });
  const inboxId = `d_clock_${accountId}`;
  const inbox = { periodId: 'd_clock', accountId, ownerUid: 'user1', trackId,
    attemptId: 'after-schedule', timeMs: 20402, frames: 20402, replay: 'AAAA', carStyle: '', receivedAt };
  const data = new Map([
    [`${C.periods}/d_clock`, period], [`${C.inbox}/${inboxId}`, inbox],
    [`${C.profiles}/${accountId}`, { ownerUid: 'user1', accountId, name: 'Racer' }],
    [`${C.queues}/d_clock`, { slots: [], runIds: [], subjects: [], admitted: 0, entrants: 0, replayBytes: 0 }]
  ]);
  const doc = key => ({ name: `projects/polytrack-052/databases/(default)/documents/${key}`,
    updateTime: new Date(305000).toISOString(), fields: eventEncode(data.get(key)).mapValue.fields });
  const request = async (path, init) => {
    if (path === ':beginTransaction') return { transaction: 'clock-regression' };
    if (path === ':rollback') return {};
    if (path === ':runQuery') {
      wallClock = 310000; // Receipt arrived during this delayed invocation.
      const query = JSON.parse(init.body).structuredQuery;
      return query.from[0].collectionId === C.inbox ? [{ document: doc(`${C.inbox}/${inboxId}`) }] : [];
    }
    if (path === ':commit') {
      const body = JSON.parse(init.body);
      assert.equal(body.transaction, 'clock-regression');
      for (const write of body.writes) {
        const key = (write.update?.name || write.delete).split('/documents/')[1];
        if (write.delete) { data.delete(key); continue; }
        const fields = eventDecode({ mapValue: { fields: write.update.fields } });
        data.set(key, write.updateMask ? { ...data.get(key), ...fields } : fields);
      }
      return {};
    }
    const key = path.slice(1).split('?')[0];
    return data.has(key) ? doc(key) : null;
  };
  const result = await eventWorkerMaintenance({ EVENTS_ENABLED: 'true' }, {
    request, at, now: () => wallClock, officialIds: [trackId], allIds: [trackId],
    targetForTrack: () => assert.fail('scheduled phase is intake, not processing-time provisioning')
  });
  assert.equal(result.status, 'waiting'); assert.equal(result.consumed, 1);
  assert.equal(result.rejected, undefined);
  const run = data.get(`${C.runs}/${result.runId}`);
  assert.equal(run.receivedAt, 305000);
  assert.equal(data.get(`${C.queues}/d_clock`).admitted, 1);
  assert.equal(data.get(`${C.receipts}/${inboxId}`).status, 'waiting');
  assert.deepEqual(data.get(`${C.inbox}/${inboxId}`), inbox);
});
