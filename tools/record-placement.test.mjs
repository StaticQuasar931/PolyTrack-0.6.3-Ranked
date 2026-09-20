import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRecordPlacement,
  installRecordPlacement,
  normalizeAuthoritativeSnapshot,
  parseDisplayedRecordTime,
  preparePolyTrackCachedSnapshot,
  preparePolyTrackOverallPlacements,
  readRecordPlacementSettings
} from './record-placement.mjs';

const TRACK = 'track-a';

function row(accountId, timeMs, extra = {}) {
  return { accountId, userId: accountId, trackId: TRACK, timeMs, timingVersion: 2, ...extra };
}

function snapshot(entries, revision = 1, extra = {}) {
  return {
    authoritative: true,
    complete: true,
    source: 'edge',
    schemaVersion: 5,
    algorithmVersion: 'rank-v1',
    revision,
    sourceRevision: revision,
    totalEntries: entries.length,
    entries,
    ...extra
  };
}

function placement(entries, accountId, extra = {}) {
  return computeRecordPlacement({
    snapshot: snapshot(entries, 1, extra.snapshot),
    trackId: TRACK,
    accountId,
    policy: extra.policy,
    expectedAlgorithmVersion: 'rank-v1',
    minSchemaVersion: 5
  });
}

test('derives centered badge text and top-three color from the complete field', () => {
  const entries = [row('a', 1000, { runVerified: true }), row('me', 2000), row('c', 3000), row('d', 4000)];
  assert.deepEqual(placement(entries, 'me'), {
    trackId: TRACK,
    accountId: 'me',
    rank: 2,
    fieldSize: 4,
    timeMs: 2000,
    label: '2/4',
    podium: 'silver',
    verified: false,
    revision: 1
  });
  assert.equal(placement(entries, 'missing'), null, 'no account record means no badge');
});

test('ties use deterministic competition ranks without trusting row rank fields', () => {
  const entries = [
    row('z', 1000, { rank: 8 }),
    row('a', 1000, { rank: 19 }),
    row('me', 1500, { rank: 1 }),
    row('last', 2000, { rank: 2 })
  ];
  assert.equal(placement(entries, 'a').label, '1/4');
  assert.equal(placement(entries, 'z').label, '1/4');
  assert.equal(placement(entries, 'me').label, '3/4');
  assert.equal(placement(entries, 'me').podium, 'bronze');
});

test('verified policy ranks and sizes only verified rows', () => {
  const entries = [row('fast', 1000), row('me', 2000, { runVerified: true }), row('slow', 3000, { runVerified: true })];
  assert.equal(placement(entries, 'me', { policy: 'verified' }).label, '1/2');
  assert.equal(placement([row('me', 1000)], 'me', { policy: 'verified' }), null);
  assert.equal(placement([row('me', 1000)], 'me', { policy: 'all' }).label, '1/1');
});

test('missing, partial, malformed, duplicate, and local-only data fail closed', () => {
  const valid = [row('me', 1000), row('other', 2000)];
  const cases = [
    null,
    snapshot(valid, 0),
    snapshot(valid, 1, { authoritative: false }),
    snapshot(valid, 1, { complete: false }),
    { ...snapshot(valid), totalEntries: undefined },
    snapshot(valid, 1, { totalEntries: 3 }),
    snapshot(valid, 1, { source: 'local-fallback' }),
    snapshot([row('me', 1000, { localPending: true })]),
    snapshot([{ trackId: TRACK, timeMs: 1000 }]),
    snapshot([row('me', 0)]),
    snapshot([row('me', 1000), row('me', 900)]),
    snapshot([row('me', 1000, { userId: 'someone-else' })]),
    snapshot([row('me', 1000, { trackId: 'wrong-track' })]),
    snapshot(valid, 1, { algorithmVersion: 'old-rank' }),
    snapshot(valid, 1, { schemaVersion: 4 })
  ];
  for (const value of cases) {
    assert.equal(computeRecordPlacement({
      snapshot: value,
      trackId: TRACK,
      accountId: 'me',
      expectedAlgorithmVersion: 'rank-v1',
      minSchemaVersion: 5
    }), null);
  }
  assert.equal(normalizeAuthoritativeSnapshot(snapshot([], 2), TRACK)?.rows.length, 0);
  assert.equal(computeRecordPlacement({ snapshot: snapshot([], 2), trackId: TRACK, accountId: 'me' }), null);
});

test('rejected and unavailable rows are excluded under both policies', () => {
  const entries = [
    row('rejected', 500, { status: 'rejected', runVerified: true }),
    row('unavailable', 600, { validationState: 'unavailable_final', runVerified: true }),
    row('pending', 700),
    row('me', 1000, { runVerified: true })
  ];
  assert.equal(placement(entries, 'me', { policy: 'all' }).label, '2/2');
  assert.equal(placement(entries, 'me', { policy: 'verified' }).label, '1/1');
  assert.equal(placement(entries, 'rejected', { policy: 'all' }), null);
  assert.equal(placement(entries, 'unavailable', { policy: 'all' }), null);
});

test('older revisions cannot replace a newer placement and newer empty snapshots clear it', () => {
  const renders = [];
  const api = installRecordPlacement({
    autoUpdate: false,
    tracks: [{ id: TRACK, name: 'Track A' }],
    expectedAlgorithmVersion: 'rank-v1',
    minSchemaVersion: 5,
    render: placements => renders.push(placements.get(TRACK)?.label || null)
  });
  assert.equal(api.update({ accountId: 'me', snapshots: { [TRACK]: snapshot([row('fast', 900), row('me', 1000)], 5) } }).get(TRACK).label, '2/2');
  assert.equal(api.update({ accountId: 'me', snapshots: { [TRACK]: snapshot([row('me', 800)], 4) } }).get(TRACK).label, '2/2');
  assert.equal(api.update({ accountId: 'me', snapshots: { [TRACK]: snapshot([], 6) } }).size, 0);
  assert.equal(api.update({ accountId: 'me', snapshots: { [TRACK]: snapshot([row('me', 800)], 5) } }).size, 0);
  assert.deepEqual(renders, ['2/2', '2/2', null, null]);
});

test('a newer partial revision clears the badge and blocks an older complete rollback', () => {
  const api = installRecordPlacement({
    autoUpdate: false,
    tracks: [{ id: TRACK }],
    expectedAlgorithmVersion: 'rank-v1',
    render() {}
  });
  assert.equal(api.update({ accountId: 'me', snapshots: { [TRACK]: snapshot([row('me', 1000)], 3) } }).size, 1);
  assert.equal(api.update({ accountId: 'me', snapshots: { [TRACK]: snapshot([row('me', 900)], 4, { complete: false }) } }).size, 0);
  assert.equal(api.update({ accountId: 'me', snapshots: { [TRACK]: snapshot([row('me', 1000)], 3) } }).size, 0);
  assert.equal(api.update({ accountId: 'me', snapshots: { [TRACK]: snapshot([row('me', 900)], 4) } }).size, 1, 'complete replacement at the same revision may recover');
});

test('explicit invalidation removes the badge until a later revision arrives', () => {
  const api = installRecordPlacement({
    autoUpdate: false,
    tracks: [{ id: TRACK }],
    expectedAlgorithmVersion: 'rank-v1',
    render() {}
  });
  const rev7 = { [TRACK]: snapshot([row('me', 1000)], 7) };
  assert.equal(api.update({ accountId: 'me', snapshots: rev7 }).size, 1);
  assert.equal(api.invalidate(TRACK).size, 0);
  assert.equal(api.update({ accountId: 'me', snapshots: rev7 }).size, 0);
  assert.equal(api.update({ accountId: 'me', snapshots: { [TRACK]: snapshot([row('me', 900)], 8) } }).size, 1);
});

test('account switches recompute identity against the same accepted snapshot', () => {
  const api = installRecordPlacement({
    autoUpdate: false,
    tracks: [{ id: TRACK }],
    expectedAlgorithmVersion: 'rank-v1',
    render() {}
  });
  const snapshots = { [TRACK]: snapshot([row('first', 1000), row('second', 2000)], 9) };
  assert.equal(api.update({ accountId: 'first', snapshots }).get(TRACK).label, '1/2');
  assert.equal(api.update({ accountId: 'second', snapshots }).get(TRACK).label, '2/2');
  assert.equal(api.update({ accountId: 'unknown', snapshots }).size, 0);
});

test('settings default enabled/all and tolerate unavailable storage', () => {
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null };
  assert.deepEqual(readRecordPlacementSettings(storage), { enabled: true, policy: 'all' });
  values.set('polytrack-0.6.2-pb-podiums', '0');
  values.set('polytrack-0.6.2-pb-podiums-verified-only', '1');
  assert.deepEqual(readRecordPlacementSettings(storage), { enabled: false, policy: 'verified' });
  assert.deepEqual(readRecordPlacementSettings({ getItem() { throw Error('blocked'); } }), { enabled: true, policy: 'all' });
});

test('patch cache adapter requires explicit completeness and matching declared size', () => {
  const cached = snapshot([row('me', 1000)], 7, { fetchedAt: 100, checkedAt: 110 });
  const prepared = preparePolyTrackCachedSnapshot(cached, { algorithmVersion: 'rank-v1', schemaVersion: 5 });
  assert.equal(prepared.authoritative, true);
  assert.equal(prepared.complete, true);
  assert.equal(prepared.totalEntries, 1);
  for (const bad of [
    { ...cached, source: 'local-fallback' },
    { ...cached, complete: undefined },
    { ...cached, totalEntries: undefined },
    { ...cached, bestEffort: true },
    { ...cached, revision: 0, sourceRevision: 0 },
    { ...cached, fetchedAt: 0 },
    { ...cached, checkedAt: 0 },
    { ...cached, schemaVersion: 4 },
    { ...cached, algorithmVersion: 'old-rank' },
    { ...cached, totalEntries: 2 },
    { ...cached, entries: null }
  ]) {
    assert.equal(preparePolyTrackCachedSnapshot(bad, { algorithmVersion: 'rank-v1', schemaVersion: 5 }).authoritative, false);
  }
});

test('raw canonical fallback is not trusted without explicit completeness metadata', () => {
  const fallback = {
    ...snapshot([row('me', 1000)], 7),
    source: 'canonical-firestore',
    fetchedAt: 100,
    checkedAt: 110,
    complete: undefined,
    totalEntries: undefined
  };
  assert.equal(preparePolyTrackCachedSnapshot(fallback, { algorithmVersion: 'rank-v1', schemaVersion: 5 }).authoritative, false);
});

test('published Overall summaries fill uncached tracks without fabricating rank or field size', () => {
  const overall = {
    source: 'edge',
    revision: 12,
    algorithmVersion: 'rank-v1',
    schemaVersion: 5,
    entries: [{
      userId: 'me',
      resultSamples: [
        { trackId: 'official-track', rank: 2, fieldSize: 11, timeMs: 12345 },
        { trackId: 'community-track', rank: 7, fieldSize: 29, timeMs: 67890 }
      ]
    }]
  };
  const options = { authoritative: true, expectedAlgorithmVersion: 'rank-v1', minSchemaVersion: 5 };
  const prepared = preparePolyTrackOverallPlacements(overall, 'me', options);
  assert.equal(prepared.get('official-track').label, '2/11');
  assert.equal(prepared.get('community-track').label, '7/29');
  assert.equal(preparePolyTrackOverallPlacements(overall, 'me', options), prepared, 'the unchanged Overall snapshot is normalized once');

  const api = installRecordPlacement({
    autoUpdate: false,
    tracks: new Map([
      ['official-track', { name: 'Summer 1', type: 'official' }],
      ['community-track', { name: 'Rolling Hills Racer', type: 'community' }]
    ]),
    expectedAlgorithmVersion: 'rank-v1',
    render() {}
  });
  const placements = api.update({ accountId: 'me', snapshots: {}, authoritativePlacements: prepared });
  assert.equal(placements.get('official-track').label, '2/11');
  assert.equal(placements.get('community-track').label, '7/29');
  assert.equal(api.update({ accountId: 'me', policy: 'verified', snapshots: {}, authoritativePlacements: prepared }).size, 0,
    'an all-runs published rank cannot be relabeled as a verified-only rank');
});

test('Overall fallback rejects untrusted, local, conflicting, and malformed summaries', () => {
  const entry = {
    accountId: 'me',
    resultSamples: [{ trackId: TRACK, rank: 2, fieldSize: 5, timeMs: 12345 }]
  };
  const base = { source: 'edge', revision: 2, entries: [entry] };
  assert.equal(preparePolyTrackOverallPlacements(base, 'me').size, 0);
  assert.equal(preparePolyTrackOverallPlacements({ ...base, source: 'local' }, 'me', { authoritative: true }).size, 0);
  assert.equal(preparePolyTrackOverallPlacements({ ...base, entries: [entry, entry] }, 'me', { authoritative: true }).size, 0);
  assert.equal(preparePolyTrackOverallPlacements({
    ...base,
    entries: [{ ...entry, bestTracks: [{ trackId: TRACK, rank: 3, fieldSize: 5, timeMs: 12345 }] }]
  }, 'me', { authoritative: true }).size, 0);
  assert.equal(preparePolyTrackOverallPlacements({
    ...base,
    entries: [{ accountId: 'me', resultSamples: [{ trackId: TRACK, rank: 6, fieldSize: 5, timeMs: 12345 }] }]
  }, 'me', { authoritative: true }).size, 0);
});

test('snapshot preparation is cached across repeated reconciliation passes', () => {
  const raw = snapshot([row('me', 1000)], 4);
  let prepares = 0;
  const api = installRecordPlacement({
    autoUpdate: false,
    tracks: new Map([[TRACK, { name: 'Track A' }]]),
    expectedAlgorithmVersion: 'rank-v1',
    prepareSnapshot(value) {
      prepares++;
      return value;
    },
    render() {}
  });
  api.update({ accountId: 'me', snapshots: new Map([[TRACK, raw]]) });
  api.update({ accountId: 'me', snapshots: new Map([[TRACK, raw]]) });
  assert.equal(prepares, 1);
});

test('native record time parser accepts minute-second-millisecond only', () => {
  assert.equal(parseDisplayedRecordTime('00:12.345'), 12345);
  assert.equal(parseDisplayedRecordTime('0:12.345'), 12345);
  assert.equal(parseDisplayedRecordTime('PB 2:03.4'), 123400);
  assert.equal(parseDisplayedRecordTime('No record'), null);
  assert.equal(parseDisplayedRecordTime('12.345'), null);
  assert.equal(parseDisplayedRecordTime('1:63.000'), null);
});

test('DOM reconciliation reuses an unchanged badge and removes it once when no record exists', () => {
  const classes = new Set();
  const record = {
    child: null,
    appends: 0,
    removals: 0,
    textContent: '0:01.000',
    classList: {
      add: value => classes.add(value),
      remove: value => classes.delete(value)
    },
    querySelector: () => record.child,
    appendChild(node) {
      this.child = node;
      node.parentElement = this;
      this.appends++;
    }
  };
  const title = {
    textContent: 'Track A',
    closest: () => ({ querySelector: () => record })
  };
  const styles = new Map();
  const document = {
    head: { appendChild: node => styles.set(node.id, node) },
    getElementById: id => styles.get(id) || null,
    createElement: tag => {
      const node = {
        tag,
        dataset: {},
        className: '',
        textContent: '',
        title: '',
        parentElement: null,
        setAttribute(name, value) { this[name] = value; },
        remove() {
          if (this.parentElement?.child === this) {
            this.parentElement.child = null;
            this.parentElement.removals++;
          }
          styles.delete(this.id);
        }
      };
      return node;
    },
    querySelectorAll: selector => {
      if (selector === '.track-title p') return [title];
      if (selector === '[data-record-placement]') return record.child ? [record.child] : [];
      if (selector === '.sq-record-placement-host') return classes.has('sq-record-placement-host') ? [record] : [];
      return [];
    }
  };
  const api = installRecordPlacement({
    autoUpdate: false,
    document,
    tracks: [{ id: TRACK, name: 'Track A' }],
    expectedAlgorithmVersion: 'rank-v1'
  });
  const snapshots = { [TRACK]: snapshot([row('me', 1000), row('other', 2000)], 4) };
  api.update({ accountId: 'me', snapshots });
  const firstBadge = record.child;
  api.update({ accountId: 'me', snapshots });
  assert.equal(record.child, firstBadge);
  assert.equal(record.appends, 1);
  assert.equal(record.removals, 0);
  api.update({ accountId: 'missing', snapshots });
  assert.equal(record.child, null);
  assert.equal(record.removals, 1);
  api.destroy();
});

test('DOM renderer does not badge No record or a stale displayed PB time', () => {
  const classes = new Set();
  const record = {
    child: null,
    textContent: 'No record',
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
    querySelector: () => record.child,
    appendChild(node) { this.child = node; node.parentElement = this; }
  };
  const title = { textContent: 'Track A', closest: () => ({ querySelector: () => record }) };
  const styles = new Map();
  const document = {
    head: { appendChild: node => styles.set(node.id, node) },
    getElementById: id => styles.get(id) || null,
    createElement: () => ({ dataset: {}, setAttribute() {}, remove() { if (this.parentElement) this.parentElement.child = null; } }),
    querySelectorAll: selector => selector === '.track-title p' ? [title] : selector === '[data-record-placement]' && record.child ? [record.child] : []
  };
  const api = installRecordPlacement({ autoUpdate: false, document, tracks: [{ id: TRACK, name: 'Track A' }], expectedAlgorithmVersion: 'rank-v1' });
  const snapshots = { [TRACK]: snapshot([row('me', 1000)], 4) };
  api.update({ accountId: 'me', snapshots });
  assert.equal(record.child, null);
  record.textContent = '0:00.999';
  api.update({ accountId: 'me', snapshots });
  assert.equal(record.child, null);
  record.textContent = '0:01.000';
  api.update({ accountId: 'me', snapshots });
  assert(record.child);
  api.destroy();
});

test('native official and community cards badge cached and Overall placements without idle class churn', () => {
  function nativeCard(name, recordText) {
    const classes = new Set();
    const mutations = [];
    const record = {
      child: null,
      textContent: recordText,
      classList: {
        contains: value => classes.has(value),
        add(value) { classes.add(value); mutations.push(['add', value]); },
        remove(value) { classes.delete(value); mutations.push(['remove', value]); }
      },
      querySelector: () => record.child,
      appendChild(node) { record.child = node; node.parentElement = record; }
    };
    const button = { querySelector: selector => selector === '.record,.personal-best' ? record : null };
    const title = { textContent: name, closest: selector => selector === 'button' ? button : null };
    return { title, record, classes, mutations };
  }

  const official = nativeCard('Summer 1', '00:12.345');
  const community = nativeCard('Rolling Hills Racer', '01:07.890');
  const emptyCards = Array.from({ length: 55 }, (_, index) => nativeCard(`No PB ${index}`, 'No record'));
  const cards = [official, community, ...emptyCards];
  const styles = new Map();
  const document = {
    head: { appendChild: node => styles.set(node.id, node) },
    getElementById: id => styles.get(id) || null,
    createElement: tag => ({
      tag,
      dataset: {},
      className: '',
      textContent: '',
      parentElement: null,
      setAttribute(name, value) { this[name] = value; },
      remove() {
        if (this.parentElement?.child === this) this.parentElement.child = null;
        styles.delete(this.id);
      }
    }),
    querySelectorAll(selector) {
      if (selector === '.track-title p') return cards.map(card => card.title);
      if (selector === '[data-record-placement]') return cards.map(card => card.record.child).filter(Boolean);
      if (selector === '.sq-record-placement-host') return cards.filter(card => card.classes.has('sq-record-placement-host')).map(card => card.record);
      return [];
    }
  };
  const tracks = new Map([
    ['official-track', { name: 'Summer 1', type: 'official' }],
    ['community-track', { name: 'Rolling Hills Racer', type: 'community' }],
    ...emptyCards.map((_, index) => [`empty-${index}`, { name: `No PB ${index}`, type: 'community' }])
  ]);
  const overall = preparePolyTrackOverallPlacements({
    source: 'edge',
    revision: 8,
    entries: [{ accountId: 'me', resultSamples: [{ trackId: 'community-track', rank: 3, fieldSize: 21, timeMs: 67890 }] }]
  }, 'me', { authoritative: true });
  const officialSnapshot = {
    ...snapshot([
      { accountId: 'first', userId: 'first', trackId: 'official-track', timeMs: 10000 },
      { accountId: 'me', userId: 'me', trackId: 'official-track', timeMs: 12345 }
    ], 7),
    entries: [
      { accountId: 'first', userId: 'first', trackId: 'official-track', timeMs: 10000 },
      { accountId: 'me', userId: 'me', trackId: 'official-track', timeMs: 12345 }
    ]
  };
  const api = installRecordPlacement({
    autoUpdate: false,
    document,
    tracks,
    expectedAlgorithmVersion: 'rank-v1'
  });
  const input = {
    accountId: 'me',
    snapshots: new Map([['official-track', officialSnapshot]]),
    authoritativePlacements: overall
  };
  api.update(input);
  assert.equal(official.record.child.textContent, '2/2');
  assert.equal(community.record.child.textContent, '3/21');
  assert.equal(official.mutations.length, 1);
  assert.equal(community.mutations.length, 1);
  assert.equal(emptyCards.reduce((sum, card) => sum + card.mutations.length, 0), 0);

  for (let pass = 0; pass < 16; pass++) api.update(input);
  assert.equal(official.mutations.length, 1);
  assert.equal(community.mutations.length, 1);
  assert.equal(emptyCards.reduce((sum, card) => sum + card.mutations.length, 0), 0,
    'unbadged native records must not receive no-op class removals');
  api.destroy();
});
