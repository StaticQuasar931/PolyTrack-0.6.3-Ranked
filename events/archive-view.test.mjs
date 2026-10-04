import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { archivePeriodCounts, catalogArchivePeriods, mountArchiveView, normalizeArchivePeriods, paginateArchivePeriods, summarizeArchives } from './archive-view.mjs';
import { liveTimedEventPeriods } from './client.mjs';

class TestNode {
  constructor(tagName = '#text', ownerDocument = null) {
    this.tagName = tagName.startsWith('#') ? tagName : tagName.toUpperCase();
    this.nodeType = tagName.startsWith('#') ? 3 : 1;
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.dataset = {};
    this.className = '';
    this.tabIndex = 0;
    this._text = '';
    this.classList = {
      add: name => { this.className = `${this.className} ${name}`.trim(); },
      contains: name => this.className.split(/\s+/).includes(name)
    };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) { (this.listeners[name] ||= []).push(listener); }
  emit(name, event = {}) { for (const listener of this.listeners[name] || []) listener(event); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
}

function archiveFixture() {
  const document = {
    createElement: tagName => new TestNode(tagName, document),
    createTextNode: text => { const node = new TestNode(); node.textContent = text; return node; }
  };
  const root = new TestNode('main', document);
  return { document, root };
}

function descendants(node, predicate) {
  return node.children.flatMap(child => [ ...(predicate(child) ? [child] : []), ...descendants(child, predicate) ]);
}

test('archive cards prefer safe period artwork and expose accessible cached standings', () => {
  const { root } = archiveFixture();
  const period = { id: 'past', kind: 'daily', endsAt: 100, maxRp: 100, racerCount: 2, thumbnailUrl: '/tracks/past.png', thumbnail: 'javascript:alert(1)' };
  const winner = { accountId: 'winner', name: 'Fast Racer', timeMs: 1234, rp: 100 };
  let fallbackCalls = 0, snapshotCalls = 0;
  const cached = new Map([['past', { racerCount: 2, entries: [winner, { accountId: 'next', name: 'Next', timeMs: 1400 }] }]]);
  mountArchiveView(root, {
    periods: [period], snapshots: cached,
    loadSnapshot: async () => { snapshotCalls += 1; return { entries: [] }; },
    renderThumbnail: () => { fallbackCalls += 1; const image = root.ownerDocument.createElement('img'); image.alt = 'Fallback'; return image; },
    resolveName: () => 'Past Track'
  });
  const card = descendants(root, node => node.tagName === 'DETAILS')[0];
  const summary = descendants(card, node => node.tagName === 'SUMMARY')[0];
  const image = descendants(card, node => node.tagName === 'IMG')[0];
  assert.equal(card.dataset.eventKind, 'daily');
  assert.equal(summary.dataset.eventKind, 'daily');
  assert.equal(summary.attributes['aria-label'], 'Daily: Past Track; 2 racers; 2 verified; winner Fast Racer, 0:01.234');
  assert.equal(image.src, '/tracks/past.png');
  assert.equal(image.loading, 'lazy');
  assert.equal(image.alt, 'Past Track thumbnail');
  assert.equal(fallbackCalls, 0);
  assert.equal(snapshotCalls, 0);
  assert.deepEqual(descendants(card, node => node.className === 'sq-archive-winner').map(node => node.textContent), ['Winner Fast Racer 0:01.234']);
});

test('unsafe or missing period artwork falls back to bridge thumbnail and snapshots stay lazy', async () => {
  const { root } = archiveFixture();
  const period = { id: 'past', kind: 'weekly', endsAt: 100, maxRp: 500, coverUrl: 'javascript:alert(1)' };
  let fallbackCalls = 0, snapshotCalls = 0;
  const fallback = root.ownerDocument.createElement('img');
  fallback.alt = 'Cached track preview';
  mountArchiveView(root, {
    periods: [period],
    loadSnapshot: async () => { snapshotCalls += 1; return { entries: [{ accountId: 'a', name: 'Winner', timeMs: 900 }] }; },
    renderThumbnail: () => { fallbackCalls += 1; return fallback; }
  });
  const card = descendants(root, node => node.tagName === 'DETAILS')[0];
  const summary = descendants(card, node => node.tagName === 'SUMMARY')[0];
  assert.equal(descendants(card, node => node.tagName === 'IMG')[0], fallback);
  assert.equal(fallbackCalls, 1);
  assert.equal(snapshotCalls, 0);
  card.open = true;
  card.emit('toggle');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(snapshotCalls, 1);
  assert.match(summary.attributes['aria-label'], /winner Winner/);
  assert.equal(descendants(card, node => node.className === 'sq-archive-racer-count')[0].textContent, '1 racer');
});

test('zero-racer archive cards remain disabled and cannot invoke the snapshot loader', () => {
  const { root } = archiveFixture();
  let snapshotCalls = 0;
  mountArchiveView(root, {
    periods: [{ id: 'empty', kind: 'custom', endsAt: 100, racerCount: 0 }],
    loadSnapshot: async () => { snapshotCalls += 1; return { entries: [] }; }
  });
  const card = descendants(root, node => node.tagName === 'DETAILS')[0];
  const summary = descendants(card, node => node.tagName === 'SUMMARY')[0];
  assert.equal(summary.attributes['aria-disabled'], 'true');
  assert.equal(summary.tabIndex, -1);
  card.open = true;
  card.emit('toggle');
  assert.equal(card.open, false);
  assert.equal(snapshotCalls, 0);
});

test('archive pagination is local, newest-first and clamps bounds', () => {
  const periods = normalizeArchivePeriods(Array.from({ length: 25 }, (_, index) => ({
    id: `event-${index}`,
    endsAt: 1000 - index
  })));
  assert.deepEqual(paginateArchivePeriods(periods).periods.map(period => period.id),
    Array.from({ length: 12 }, (_, index) => `event-${index}`));
  assert.equal(paginateArchivePeriods(periods, 0).page, 1);
  assert.equal(paginateArchivePeriods(periods, 99).page, 3);
  assert.equal(paginateArchivePeriods(periods, 2).periods.length, 12);
  assert.deepEqual(paginateArchivePeriods(periods, 3).periods.map(period => period.id), ['event-24']);
  assert.equal(paginateArchivePeriods(periods, 1, 0).pageSize, 12);
});

test('archive UI exposes local page controls and accurate practice label', () => {
  const source = fs.readFileSync(new URL('./archive-view.mjs', import.meta.url), 'utf8');
  assert.match(source, /className = 'sq-archive-pagination'/);
  assert.match(source, /appendText\(document, pagination, 'button', 'button', 'Previous'\)/);
  assert.match(source, /appendText\(document, pagination, 'button', 'button', 'Next'\)/);
  assert.match(source, /Page \$\{pageInfo\.page\} of \$\{pageInfo\.pageCount\}/);
  assert.match(source, /Track details \/ practice/);
  assert.match(source, /if \(initialRacers === 0\) disableEmpty\(\)/);
  assert.match(source, /if \(counts\.racers === 0\) disableEmpty\(\)/);
});

test('events UI keeps permanent Rolling live, archives practice-only, and does not publish scoring formulas', () => {
  const source = fs.readFileSync(new URL('./client.mjs', import.meta.url), 'utf8');
  assert.match(source, /sq-event-cards.*cards\(livePeriods\(\)\)\+permanentCard\(true\)/);
  assert.match(source, /const actions=closed\?'<button class="button" type="button" data-event-practice>/);
  assert.match(source, /snapshot\(period,force&&!closed\)/);
  assert.match(source, /Current leader/);
  assert.match(source, /data-event-practice>Practice track<\/button>/);
  assert.doesNotMatch(source, /target time\s*[÷/]\s*your time/i);
  assert.doesNotMatch(source, /maximum points/i);
});

test('archive kind checkboxes combine locally and leave unrelated archive kinds visible', () => {
  const { root } = archiveFixture();
  const periods = [
    { id: 'd', kind: 'daily', endsAt: 400, maxRp: 100, racerCount: 1 },
    { id: 'w', kind: 'weekly', endsAt: 300, maxRp: 500, racerCount: 1 },
    { id: 'k', kind: 'kodub', endsAt: 200, maxRp: 700, racerCount: 1 },
    { id: 'c', kind: 'custom', endsAt: 100, maxRp: 100, racerCount: 1 }
  ];
  mountArchiveView(root, { periods, snapshots: new Map(periods.map(period => [period.id, { entries: [] }])) });
  const inputs = descendants(root, node => node.tagName === 'INPUT');
  assert.deepEqual(inputs.map(input => [input.value, input.checked]), [['daily', true], ['weekly', true], ['kodub', true]]);
  const visibleKinds = () => descendants(root, node => node.tagName === 'DETAILS').map(node => node.dataset.eventKind);
  assert.deepEqual(visibleKinds(), ['daily', 'weekly', 'kodub', 'custom']);
  inputs[0].checked = false;
  inputs[0].emit('change');
  inputs[2].checked = false;
  inputs[2].emit('change');
  assert.deepEqual(visibleKinds(), ['weekly', 'custom']);
  inputs[1].checked = false;
  inputs[1].emit('change');
  assert.deepEqual(visibleKinds(), ['custom']);
});

test('live selector yields Kodub, weekly and daily while permanent Rolling stays dedicated', () => {
  const periods = liveTimedEventPeriods([
    { id: 'weekly', kind: 'weekly', startsAt: 1, endsAt: 200 },
    { id: 'daily', kind: 'daily', startsAt: 1, endsAt: 150 },
    { id: 'kodub', kind: 'kodub', startsAt: 1, endsAt: 175 },
    { id: 'kodub', kind: 'kodub', startsAt: 1, endsAt: 175 },
    { id: 'ended', kind: 'daily', startsAt: 1, endsAt: 99 },
    { id: 'permanent-rolling-hills', kind: 'permanent', startsAt: 1, endsAt: 999 }
  ], 100);
  assert.deepEqual(periods.map(period => period.id), ['kodub', 'weekly', 'daily']);
});

test('archive periods are validated, deduplicated and newest-first', () => {
  const periods = normalizeArchivePeriods([
    null,
    { id: '', endsAt: 99 },
    { id: 'weekly-old', kind: 'weekly', endsAt: 100, maxRp: 500 },
    { id: 'daily-new', kind: 'daily', endsAt: 300, maxRp: 100 },
    { id: 'weekly-old', kind: 'weekly', endsAt: 200, maxRp: 500 },
    { id: 'odd', kind: 'unsupported', endsAt: 150, maxRp: -4 }
  ]);
  assert.deepEqual(periods.map(period => period.id), ['daily-new', 'weekly-old', 'odd']);
  assert.equal(periods[1].endsAt, 200);
  assert.equal(periods[2].kind, 'custom');
  assert.equal(periods[2].maxRp, 0);
});

test('catalog archives include every ended timed kind and exclude permanent Rolling Hills', () => {
  const periods = catalogArchivePeriods({
    periods: [
      { id: 'daily-ended', kind: 'daily', endsAt: 90 },
      { id: 'weekly-live', kind: 'weekly', endsAt: 110 },
      { id: 'custom-ended', kind: 'custom', endsAt: 80 },
      { id: 'permanent-rolling-hills', kind: 'permanent', endsAt: Number.MAX_SAFE_INTEGER }
    ],
    archives: [
      { id: 'daily-ended', kind: 'daily', endsAt: 90, racerCount: 7 },
      { id: 'kodub-ended', kind: 'kodub', endsAt: 70 }
    ]
  }, 100);
  assert.deepEqual(periods.map(period => period.id), ['daily-ended', 'custom-ended', 'kodub-ended']);
  assert.equal(periods[0].racerCount, 7);
});

test('archive summary reports event types and only loaded verified finishes', () => {
  const periods = [
    { id: 'd1', kind: 'daily', endsAt: 300 },
    { id: 'w1', kind: 'weekly', endsAt: 200 },
    { id: 'k1', kind: 'kodub', endsAt: 100 }
  ];
  const snapshots = new Map([
    ['d1', { entries: [
      { accountId: 'a', timeMs: 1000 },
      { accountId: 'b', timeMs: 1100, pending: true }
    ] }],
    ['w1', { entries: [
      { accountId: 'a', timeMs: 900 },
      { accountId: 'c', timeMs: 950, status: 'pending' },
      null
    ] }]
  ]);
  assert.deepEqual(summarizeArchives(periods, snapshots), {
    events: 3,
    loadedEvents: 2,
    verifiedFinishes: 2,
    uniqueRacers: 1,
    kindCounts: { daily: 1, weekly: 1, kodub: 1, custom: 0 }
  });
});

test('period counts prefer safe racer totals and exclude pending rows', () => {
  const period = { id: 'd1', racerCount: 9, entrantCount: 8 };
  const snapshot = { racerCount: Number.MAX_SAFE_INTEGER + 1, entrantCount: 7, entries: [
    { accountId: 'a' },
    { accountId: 'b', pending: true },
    { accountId: 'c', status: 'pending' }
  ] };
  const counts = archivePeriodCounts(period, snapshot);
  assert.equal(counts.racers, 7);
  assert.equal(counts.verified, 1);
  assert.deepEqual(counts.verifiedEntries.map(row => row.accountId), ['a']);
  assert.deepEqual(archivePeriodCounts({ racerCount: -1, entrantCount: 3 }), {
    racers: 3,
    verified: null,
    verifiedEntries: [],
    winner: null
  });
});

test('archive standings deduplicate racers by fastest verified result and identify the winner', () => {
  const counts = archivePeriodCounts({ id: 'w1' }, { entries: [
    { accountId: 'b', name: 'B slower duplicate', timeMs: 1300, rank: 3 },
    { accountId: 'a', name: 'Winner', timeMs: 1000, rank: 1 },
    { accountId: 'b', name: 'B best', timeMs: 1100, rank: 2 },
    { accountId: 'c', name: 'Waiting', timeMs: 900, pending: true }
  ] });
  assert.equal(counts.racers, 3);
  assert.equal(counts.verified, 2);
  assert.deepEqual(counts.verifiedEntries.map(row => [row.accountId, row.timeMs, row.rank]), [
    ['a', 1000, 1],
    ['b', 1100, 2]
  ]);
  assert.equal(counts.winner.name, 'Winner');
});
