import test from 'node:test';
import assert from 'node:assert/strict';
import { publicCatalogBackup } from './sync-event-catalog.mjs';

test('public event backup retains assignments without private or overall ranking fields', () => {
  const period = { id: 'd_20260928', kind: 'daily', trackId: 'a'.repeat(64), startsAt: 100, endsAt: 200, maxRp: 100 };
  assert.deepEqual(publicCatalogBackup({ periods: [period], archives: [], totals: [{ accountId: 'private' }] }), { periods: [period], archives: [] });
  assert.throws(() => publicCatalogBackup({ periods: [{ ...period, trackId: 'bad' }], archives: [] }), /Invalid public event period/);
});
