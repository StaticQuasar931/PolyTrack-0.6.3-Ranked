import test from 'node:test';
import assert from 'node:assert/strict';
import {compactExportCheckpoint} from './export-checkpoint.mjs';

const bytes = value => Buffer.byteLength(`${JSON.stringify(value)}\n`);

test('compacts 22000 successful records above 16 MiB without changing profiles or retry history', () => {
  const records = {}, covered = {}, pending = [];
  for (let i = 0; i < 22000; i++) {
    const accountId = i.toString(16).padStart(64, '0'), trackId = 'b'.repeat(64);
    const signature = JSON.stringify([accountId, trackId, i + 1, 900, 'c'.repeat(64)]);
    records[signature] = {signature, available: true, replayPath: `recordings/${i + 1}.json`,
      canonicalPath: `canonical/${trackId}/${accountId}.json`};
    covered[signature] = true;
    pending.push(signature);
  }
  const failures = Object.fromEntries(['missing', 'binding-mismatch', 'batch-response-mismatch',
    'upload-conflict', 'output-too-large'].map((reason, i) => [`failure-${i}`, {
    signature: `failure-${i}`, available: false, reason, checkedAt: 123 + i, attempts: 32,
    bindingTimeMs: 15000, retryAt: 456 + i, mismatchReason: 'time', history: [{at: 10, reason}]
  }]));
  Object.assign(records, failures);
  records.unknown = {attempts: 3, history: ['unclassified retry']};
  const progress = {schemaVersion: 2, projectId: 'polytrack-052',
    profiles: {cursor: 'saved-cursor', complete: false, scanned: 123, ids: ['saved-id']},
    profileCount: 123, profileSkipped: 7, fullSnapshotPending: true,
    raceExport: {fingerprint: 'fingerprint', known: 22006, invalid: 2, responseInvalid: 1, records, covered, pending}};
  const before = JSON.stringify(progress);
  assert.ok(bytes(progress) > 16 * 1024 * 1024);
  const compact = compactExportCheckpoint(progress);
  assert.ok(bytes(compact) < 4096);
  assert.deepEqual(compact.raceExport.records, {...failures, unknown: records.unknown});
  assert.deepEqual(compact, {...progress, raceExport: {
    fingerprint: 'fingerprint', known: 22006, invalid: 2, responseInvalid: 1,
    records: {...failures, unknown: records.unknown}}});
  assert.equal(JSON.stringify(progress), before);
  compact.profiles.ids.push('changed');
  compact.raceExport.records['failure-0'].history[0].reason = 'changed';
  assert.deepEqual(progress.profiles.ids, ['saved-id']);
  assert.equal(failures['failure-0'].history[0].reason, 'missing');
});

test('supports legacy checkpoints with absent race state without sharing mutable data', () => {
  for (const raceExport of [undefined, null, {records: {failed: {available: false, attempts: 8}}}]) {
    const progress = {schemaVersion: 2, profiles: {ids: ['saved']}, raceExport};
    const compact = compactExportCheckpoint(progress);
    assert.deepEqual(compact, progress);
    compact.profiles.ids.length = 0;
    assert.deepEqual(progress.profiles.ids, ['saved']);
  }
});
