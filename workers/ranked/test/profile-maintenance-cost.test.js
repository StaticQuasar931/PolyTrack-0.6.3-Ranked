import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/index.js';

test('profile maintenance fetches only the one job it can process', async () => {
  const calls = [], queries = [];
  let completion;
  worker.scheduled({cron:'2-59/5 * * * *', scheduledTime:Date.UTC(2026, 9, 20, 0, 20)}, {
    __TEST_FIRESTORE:async (path, init) => {
      calls.push(path);
      if (path === ':runQuery') queries.push(JSON.parse(init.body).structuredQuery);
      return [];
    }
  }, {waitUntil:promise => {completion = promise;}});
  await completion;
  assert.deepEqual(calls, [':runQuery', ':runQuery']);
  assert.equal(queries[0].from[0].collectionId, '0.6.2_s1_worker_jobs');
  assert.deepEqual(queries.map(q=>q.where.fieldFilter.field.fieldPath).sort(), ['active','profileRetryAt']);
  assert(queries.every(q=>q.limit===1), 'each lane fetches only the job it can process');
});
