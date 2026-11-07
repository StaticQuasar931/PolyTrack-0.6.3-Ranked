import test from 'node:test';
import assert from 'node:assert/strict';
import {proofVersionAtOrBefore} from '../src/proof-snapshot-reuse.js';

test('proof versions compare exact nanoseconds, not rounded milliseconds', () => {
  const snapshot = '2026-11-06T03:05:00.123456789Z';
  for (const version of ['2026-11-06T03:05:00.123456788Z', snapshot,
    '2026-11-06T03:05:00.123Z', '2026-11-06T03:05:00Z', '2026-11-05T23:59:59.999999999Z'])
    assert.equal(proofVersionAtOrBefore({updateTime:version}, snapshot), true, version);
  for (const version of ['2026-11-06T03:05:00.123456790Z', '2026-11-06T03:05:00.124Z',
    '2026-11-06T03:05:01Z', '2027-01-01T00:00:00Z'])
    assert.equal(proofVersionAtOrBefore({updateTime:version}, snapshot), false, version);
  assert.equal(proofVersionAtOrBefore({updateTime:'2026-11-06T03:05:00.1Z'}, '2026-11-06T03:05:00.100000000Z'), true);
});

test('uncertain or malformed timestamps never authorize historical proof reuse', () => {
  const valid = '2026-11-06T03:05:00Z';
  for (const value of [undefined, null, '', 1793934300000, {}, 'v1', '2026-11-06',
    '2026-11-06T03:05:00+00:00', '2026-11-06T03:05:00.1234567890Z',
    '2026-11-06T03:05:00.Z', '2026-02-29T00:00:00Z', '2026-11-31T00:00:00Z',
    '2026-13-01T00:00:00Z', '2026-11-06T24:00:00Z', '2026-11-06T03:05:60Z', '0000-01-01T00:00:00Z']) {
    assert.equal(proofVersionAtOrBefore({updateTime:value}, valid), false, String(value));
    assert.equal(proofVersionAtOrBefore({updateTime:valid}, value), false, String(value));
  }
  assert.equal(proofVersionAtOrBefore(null, valid), false);
  assert.equal(proofVersionAtOrBefore({}, valid), false);
  assert.equal(proofVersionAtOrBefore({updateTime:'2024-02-29T00:00:00Z'}, valid), true);
});
