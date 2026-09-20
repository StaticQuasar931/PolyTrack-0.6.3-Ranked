import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { KODUB_METADATA_URL, provisionKodubEvent } from '../src/kodub-event.js';

const root = 'https://vps.kodub.com/v6';
const now = Date.UTC(2026, 8, 20, 12);
const endsAt = now + 4 * 86400000;
const trackId = 'a'.repeat(64);
const imageId = 'b'.repeat(64);
const code = 'PolyTrack2' + 'A'.repeat(128);
const assetId = createHash('sha256').update(code).digest('hex');
const metadata = {
  serverTime: new Date(now).toISOString(),
  current: {
    trackId,
    name: 'Official weekly',
    author: 'Kodub',
    lastModified: new Date(now - 1000).toISOString(),
    environment: 0,
    endTime: new Date(endsAt).toISOString(),
    trackUrl: `${root}/trackOfTheWeek/track/${assetId}`,
    thumbnailUrl: `${root}/trackOfTheWeek/image/${imageId}`,
    coverUrl: null,
  },
};
const capacity = { policyVersion: 'kodub-reviewed-v1', entrants: 200, admissionsPerPeriod: 512,
  replayBytesPerPeriod: 8388608, minIntervalMs: 1000, verificationsPerDay: 128 };

function fixture(overrides = {}) {
  const calls = [];
  const reads = [];
  let created;
  const payloads = new Map([
    [KODUB_METADATA_URL, Response.json(overrides.metadata || metadata)],
    [`${root}/trackOfTheWeek/track/${assetId}?version=0.6.3`, new Response(overrides.code || code)],
    [`${root}/leaderboard?version=0.6.3&trackId=${trackId}&skip=0&amount=1&onlyVerified=true`,
      Response.json(overrides.leaderboard || { total: 4, entries: [{ frames: 20402, verifiedState: 1 }], userEntry: null })],
  ]);
  const runtime = {
    now: () => now,
    store: { transaction: async operation => operation({ get: async path => { reads.push(path); return overrides.existing || null; } }) },
    service: { createPeriod: async (period, options) => { created = { period, options }; } },
  };
  const fetch = async (url, init) => {
    calls.push([url, init]);
    const response = payloads.get(url);
    if (!response) throw Error('unexpected_url');
    return response;
  };
  return { runtime, fetch, calls, reads, created: () => created };
}

test('provisions one immutable Kodub period from exact official endpoints', async () => {
  const f = fixture();
  const result = await provisionKodubEvent(f.runtime, { capacity, fetch: f.fetch });
  const { period, options } = f.created();
  assert.equal(result.created, `kodub_${endsAt}`);
  assert.deepEqual(f.calls.map(call => call[0]), [
    KODUB_METADATA_URL,
    `${root}/trackOfTheWeek/track/${assetId}?version=0.6.3`,
    `${root}/leaderboard?version=0.6.3&trackId=${trackId}&skip=0&amount=1&onlyVerified=true`,
  ]);
  assert(f.calls.every(([, init]) => init.method === 'GET' && init.redirect === 'error'));
  assert(f.calls.every(([, init]) => init.headers.Origin === 'https://app-polytrack.kodub.com' &&
    init.headers.Referer === 'https://app-polytrack.kodub.com/'));
  assert.deepEqual(f.calls.map(([, init]) => init.headers.Accept), ['application/json', 'text/plain', 'application/json']);
  assert.deepEqual(options, { currentUtc: true });
  assert.equal(period.kind, 'kodub');
  assert.equal(period.maxRp, 700);
  assert.equal(period.trackId, trackId);
  assert.equal(period.startsAt, endsAt - 7 * 86400000);
  assert.equal(period.endsAt, endsAt);
  assert.equal(period.targetMs, 20402);
  assert.equal(period.kodub.trackCode, code);
  assert.equal(period.kodub.officialTrackAssetHash, assetId);
  assert.equal(period.kodub.trackCodeHash, createHash('sha256').update(code).digest('hex'));
  assert.equal(period.kodub.trackCodeHash, period.kodub.officialTrackAssetHash);
  assert.equal(period.kodub.officialFastestVerifiedMs, period.targetMs);
  assert.equal(period.kodub.officialEndTime, period.endsAt);
  assert(Object.isFrozen(period));
  assert(Object.isFrozen(period.kodub));
});

test('an exact existing period returns after one bounded read without refetching mutable inputs', async () => {
  const existing = {
    id: `kodub_${endsAt}`, kind: 'kodub', trackId, startsAt: endsAt - 7 * 86400000, endsAt,
    targetMs: 21000, maxRp: 700,
    kodub: { source: 'kodub-v6-track-of-the-week', trackCode: code, trackCodeHash: assetId,
      officialTrackAssetHash: assetId, officialEndTime: endsAt, officialFastestVerifiedMs: 21000 },
  };
  const f = fixture({ existing });
  const result = await provisionKodubEvent(f.runtime, { capacity, fetch: f.fetch });
  assert.deepEqual(f.calls.map(call => call[0]), [KODUB_METADATA_URL]);
  assert.deepEqual(f.reads, [`0.6.2_event_periods/kodub_${endsAt}`]);
  assert.equal(result.created, null);
  assert.equal(result.existing, existing.id);
  assert.equal(result.period.targetMs, 21000);
  assert.equal(f.created(), undefined);
});

test('an occupied deterministic id with different identity fails before asset or leaderboard fetch', async () => {
  const f = fixture({ existing: { id: `kodub_${endsAt}`, kind: 'weekly', trackId, endsAt } });
  await assert.rejects(provisionKodubEvent(f.runtime, { capacity, fetch: f.fetch }), /existing_period_mismatch/);
  assert.deepEqual(f.calls.map(call => call[0]), [KODUB_METADATA_URL]);
  assert.equal(f.created(), undefined);
});

test('an existing period with code that disagrees with its frozen hash fails closed', async () => {
  const existing = {
    id: `kodub_${endsAt}`, kind: 'kodub', trackId, endsAt, targetMs: 21000,
    kodub: { source: 'kodub-v6-track-of-the-week', trackCode: code.slice(0, -1) + 'B', trackCodeHash: assetId,
      officialTrackAssetHash: assetId, officialEndTime: endsAt, officialFastestVerifiedMs: 21000 },
  };
  const f = fixture({ existing });
  await assert.rejects(provisionKodubEvent(f.runtime, { capacity, fetch: f.fetch }), /existing_period_mismatch/);
  assert.deepEqual(f.calls.map(call => call[0]), [KODUB_METADATA_URL]);
  assert.equal(f.created(), undefined);
});

test('foreign asset URLs and unverified targets fail closed without provisioning', async () => {
  const hostileMetadata = structuredClone(metadata);
  hostileMetadata.current.trackUrl = `https://evil.test/track/${trackId}`;
  for (const overrides of [
    { metadata: hostileMetadata },
    { leaderboard: { total: 1, entries: [{ frames: 1, verifiedState: 0 }] } },
    { leaderboard: { total: 1, entries: [{ frames: 1, verifiedState: 2 }] } },
    { leaderboard: { total: 1, entries: [{ frames: 1, verifiedState: 3 }] } },
    { leaderboard: { total: 1, entries: [{ frames: 1, verifiedState: 4 }] } },
    { leaderboard: { total: 0, entries: [] } },
    { code: '<script>alert(1)</script>' },
    { code: code.slice(0, -1) + 'B' },
  ]) {
    const f = fixture(overrides);
    await assert.rejects(provisionKodubEvent(f.runtime, { capacity, fetch: f.fetch }), /kodub_/);
    assert.equal(f.created(), undefined);
  }
});

test('oversized streamed payloads are rejected before period creation', async () => {
  const f = fixture();
  f.fetch = async url => url === KODUB_METADATA_URL ? Response.json(metadata) :
    new Response('PolyTrack2' + 'A'.repeat(262144));
  await assert.rejects(provisionKodubEvent(f.runtime, { capacity, fetch: f.fetch }), /payload_too_large/);
  assert.equal(f.created(), undefined);
});
