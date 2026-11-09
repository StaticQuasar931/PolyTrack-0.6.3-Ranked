import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeRankedNotifications, rankedNotificationRetryDelay} from './ranked-notification-policy.mjs';

const account = 'a'.repeat(64);
const foreignAccount = 'b'.repeat(64);
const uid = 'active-user';
const track = 'c'.repeat(64);
const otherTrack = 'd'.repeat(64);
const resultId = `${account}_${track}`;
const item = (overrides = {}) => ({resultId, trackId: track, queuedAt: 10, attempts: 1, ...overrides});

test('accepts legacy canonical IDs and normalizes stable queue fields', () => {
  assert.deepEqual(normalizeRankedNotifications([item()], account, uid), [{
    resultId, accountId: account, ownerUid: uid, trackId: track, queuedAt: 10, attempts: 1, reason: 'pending'
  }]);
});

test('rejects malformed, noncanonical, foreign account, and foreign owner items', () => {
  const rejected = [
    null, {}, item({resultId: `${account}_${track}_extra`}), item({resultId: `${foreignAccount}_${track}`}),
    item({resultId: `${account}_not-a-track`}), item({resultId: `${account}_${otherTrack}`, trackId: track}),
    item({accountId: foreignAccount}), item({ownerUid: 'other-user'}), item({uid: 'other-user'}),
    item({queuedAt: '10'}), item({queuedAt: -1}), item({attempts: 1.5})
  ];
  assert.deepEqual(normalizeRankedNotifications(rejected, account, uid), []);
});

test('deduplicates canonical results by newest queuedAt independent of input order', () => {
  const first = item({queuedAt: 10, reason: 'old'});
  const newest = item({queuedAt: 20, reason: 'new'});
  assert.deepEqual(normalizeRankedNotifications([first, newest], account, uid),
    normalizeRankedNotifications([newest, first], account, uid));
  assert.equal(normalizeRankedNotifications([first, newest], account, uid)[0].reason, 'new');
});

test('keeps deterministic winner for equal timestamps', () => {
  const a = item({queuedAt: 20, reason: 'a'});
  const b = item({queuedAt: 20, reason: 'b'});
  assert.deepEqual(normalizeRankedNotifications([a, b], account, uid), normalizeRankedNotifications([b, a], account, uid));
});

test('limits output to newest 100 distinct canonical results in deterministic order', () => {
  const queue = Array.from({length: 105}, (_, i) => {
    const trackId = i.toString(16).padStart(64, '0');
    return {resultId: `${account}_${trackId}`, trackId, queuedAt: i};
  });
  const normalized = normalizeRankedNotifications(queue, account, uid);
  assert.equal(normalized.length, 100);
  assert.equal(normalized[0].queuedAt, 104);
  assert.equal(normalized.at(-1).queuedAt, 5);
});

test('invalid active identity and non-array queue fail closed', () => {
  assert.deepEqual(normalizeRankedNotifications([item()], 'bad-account', uid), []);
  assert.deepEqual(normalizeRankedNotifications([item()], account, ''), []);
  assert.deepEqual(normalizeRankedNotifications(item(), account, uid), []);
});

test('retry delay honors future or elapsed edge deadline without I/O', () => {
  assert.equal(rankedNotificationRetryDelay({retryAt: 5000, now: 2000}), 3000);
  assert.equal(rankedNotificationRetryDelay({retryAt: 1000, now: 2000}), 0);
});

test('retry delay is suppressed offline or while hidden', () => {
  assert.equal(rankedNotificationRetryDelay({retryAt: 5000, now: 2000, online: false}), null);
  assert.equal(rankedNotificationRetryDelay({retryAt: 5000, now: 2000, visible: false}), null);
});

test('invalid retry timing produces no schedule', () => {
  assert.equal(rankedNotificationRetryDelay({retryAt: NaN, now: 0}), null);
  assert.equal(rankedNotificationRetryDelay({retryAt: 10, now: Infinity}), null);
});
