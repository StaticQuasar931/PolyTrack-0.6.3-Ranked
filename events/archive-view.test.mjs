import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { archivePeriodCounts, archiveSnapshotState, catalogArchivePeriods, mountArchiveView, normalizeArchivePeriods, paginateArchivePeriods, summarizeArchives } from './archive-view.mjs';
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

test('archive month navigation rolls years correctly and returns to recent events',()=>{
 const {root}=archiveFixture(),months=[];
 mountArchiveView(root,{periods:[],month:'2026-01',onMonthChange:month=>months.push(month)});
 const buttons=descendants(root,node=>node.tagName==='BUTTON');
 for(const label of ['Previous month','Next month','All saved events'])buttons.find(button=>button.textContent===label).emit('click');
 assert.deepEqual(months,['2026-01','2025-12','2026-01','']);
 assert.match(root.textContent,/Final event results.*separate all-time leaderboard/);
});

test('archive cards prefer safe period artwork and expose accessible cached standings', () => {
  const { root } = archiveFixture();
  const period = { id: 'past', kind: 'daily', endsAt: 100, maxRp: 100, racerCount: 2, thumbnailUrl: '/tracks/past.png', thumbnail: 'javascript:alert(1)' };
  const winner = { accountId: 'winner', name: 'Fast Racer', timeMs: 1234, rp: 100 };
  let fallbackCalls = 0, snapshotCalls = 0;
  const cached = new Map([['past', { archived: true, racerCount: 2, entries: [winner, { accountId: 'next', name: 'Next', timeMs: 1400 }] }]]);
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
  assert.equal(summary.attributes['aria-label'], 'Daily: Past Track; 2 event racers; 2 verified; winner Fast Racer, 0:01.234; Saved final event standings.');
  assert.equal(image.src, '/tracks/past.png');
  assert.equal(image.loading, 'lazy');
  assert.equal(image.alt, 'Past Track thumbnail');
  assert.equal(fallbackCalls, 0);
  assert.equal(snapshotCalls, 0);
  assert.deepEqual(descendants(card, node => node.className === 'sq-archive-winner').map(node => node.textContent), ['Winner Fast Racer 0:01.234']);
});

test('archive cards reject standings bound to a different event, track, or kind', async () => {
  const { root } = archiveFixture();
  const period = { id: 'kodub-week', kind: 'kodub', trackId: 'a'.repeat(64), endsAt: 100, racerCount: 1 };
  const wrong = { period: { id: 'other-week', kind: 'kodub', trackId: period.trackId }, entries: [{ accountId: 'wrong', timeMs: 900 }] };
  let loads = 0;
  mountArchiveView(root, {
    periods: [period], snapshots: new Map([[period.id, wrong]]),
    loadSnapshot: async () => { loads++; return { period: { ...period, trackId: 'b'.repeat(64) }, entries: [] }; }
  });
  const card = descendants(root, node => node.tagName === 'DETAILS')[0];
  assert.equal(descendants(card, node => node.className === 'sq-event-winner').length, 0);
  card.open = true;
  card.emit('toggle');
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(loads, 1);
  assert.match(card.textContent, /could not be loaded/);
  assert.doesNotMatch(card.textContent, /wrong/);
});

test('unsafe or missing period artwork falls back to bridge thumbnail and snapshots stay lazy', async () => {
  const { root } = archiveFixture();
  const period = { id: 'past', kind: 'weekly', endsAt: 100, maxRp: 500, coverUrl: 'javascript:alert(1)' };
  let fallbackCalls = 0, snapshotCalls = 0;
  const fallback = root.ownerDocument.createElement('img');
  fallback.alt = 'Cached track preview';
  mountArchiveView(root, {
    periods: [period],
    loadSnapshot: async () => { snapshotCalls += 1; return { archived: true, entries: [{ accountId: 'a', name: 'Winner', timeMs: 900 }] }; },
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
  assert.equal(descendants(card, node => node.className === 'sq-archive-racer-count')[0].textContent, '1 event racer');
});

test('catalog-only zero counts do not prevent loading a saved event board on demand', async () => {
  const { root } = archiveFixture();
  let snapshotCalls = 0;
  mountArchiveView(root, {
    periods: [{ id: 'empty', kind: 'custom', endsAt: 100, racerCount: 0 }],
    loadSnapshot: async () => { snapshotCalls += 1; return { archived:true, racerCount:1, entries: [{accountId:'racer',timeMs:1000}] }; }
  });
  const card = descendants(root, node => node.tagName === 'DETAILS')[0];
  const summary = descendants(card, node => node.tagName === 'SUMMARY')[0];
  assert.equal(summary.attributes['aria-disabled'], undefined);
  assert.equal(summary.tabIndex, 0);
  card.open = true;
  card.emit('toggle');
  assert.equal(card.open, true);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(snapshotCalls, 1);
  assert.equal(descendants(card, node => node.className === 'sq-archive-racer-count')[0].textContent, '1 event racer');
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
  assert.doesNotMatch(source, /disableEmpty/);
});

test('events UI keeps permanent Rolling live, archives practice-only, and does not publish scoring formulas', () => {
  const source = fs.readFileSync(new URL('./client.mjs', import.meta.url), 'utf8');
  assert.match(source, /cards\(livePeriods\(\)\.filter\(p=>p.kind==='kodub'\),\{details:true\}\)\+permanentCard\(true\)/);
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
  const inputs = descendants(root, node => node.tagName === 'INPUT' && node.type === 'checkbox');
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

test('late archive standings do not restore filtered-out events to the summary', async () => {
  const { root } = archiveFixture();
  let resolveSnapshot;
  const pendingSnapshot = new Promise(resolve => { resolveSnapshot = resolve; });
  const periods = [
    { id: 'daily', kind: 'daily', endsAt: 300, racerCount: 1 },
    { id: 'weekly', kind: 'weekly', endsAt: 200, racerCount: 1 },
    { id: 'custom', kind: 'custom', endsAt: 100, racerCount: 1 }
  ];
  mountArchiveView(root, { periods, loadSnapshot: () => pendingSnapshot });
  const weekly = descendants(root, node => node.tagName === 'DETAILS').find(node => node.dataset.archiveEventId === 'weekly');
  weekly.open = true;
  weekly.emit('toggle');
  const weeklyFilter = descendants(root, node => node.tagName === 'INPUT').find(node => node.value === 'weekly');
  weeklyFilter.checked = false;
  weeklyFilter.emit('change');
  const stats = descendants(root, node => node.className === 'sq-archive-stats')[0];
  assert.equal(stats.dataset.totalEvents, '2');
  resolveSnapshot({ entries: [{ accountId: 'racer', timeMs: 1000 }] });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(stats.dataset.totalEvents, '2');
  assert.equal(stats.dataset.loadedEvents, '0');
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
  assert.equal(periods[2].maxRp, null);
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
    ['d1', { archived: true, entries: [
      { accountId: 'a', timeMs: 1000 },
      { accountId: 'b', timeMs: 1100, pending: true }
    ] }],
    ['w1', { archived: true, entries: [
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
    { accountId: 'a', timeMs: 1000 },
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
  const counts = archivePeriodCounts({ id: 'w1' }, { archived: true, entries: [
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

test('saved event rows take precedence over stale lower catalog and board counts', () => {
  const period={id:'past',kind:'kodub',trackId:'a'.repeat(64),racerCount:1};
  const snapshot={period,archived:true,racerCount:1,entries:[
    {accountId:'a',timeMs:1000},{accountId:'b',timeMs:1100},
    {accountId:'a',timeMs:1200},{accountId:'c',timeMs:1300}],
    pendingPlaybacks:[{accountId:'b',timeMs:900,pending:true},{accountId:'d',timeMs:1400,pending:true}]};
  const counts=archivePeriodCounts(period,snapshot);
  assert.equal(counts.racers,4);
  assert.equal(counts.verified,3);
});

test('ordinary track racer counts cannot be substituted for bound event participants', () => {
  const period={id:'velvoire',kind:'kodub',trackId:'a'.repeat(64),racerCount:1};
  const event={period,archived:true,racerCount:1,entries:[{accountId:'me',name:'Static',timeMs:270425}]};
  const ordinary={trackId:period.trackId,complete:true,totalEntries:4,entries:[
    {accountId:'me',timeMs:270425},{accountId:'other',timeMs:310222},
    {accountId:'third',timeMs:357306},{accountId:'fourth',timeMs:801634}]};
  assert.equal(archivePeriodCounts(period,event).racers,1);
  assert.equal(archivePeriodCounts(period,event).winner.name,'Static');
  assert.equal(archivePeriodCounts(period,ordinary).verified,null);
  assert.equal(archiveSnapshotState(period,ordinary),'mismatched');
});

test('archive search and chronological order reuse saved metadata without loading boards',()=>{
 const {root}=archiveFixture();let loads=0;
 mountArchiveView(root,{periods:[{id:'older',kind:'daily',trackName:'Alpine',endsAt:100,maxRp:100},{id:'newer',kind:'weekly',trackName:'Canyon',endsAt:200,maxRp:500}],loadSnapshot:()=>{loads++;}});
 const cards=()=>descendants(root,node=>node.className==='sq-archive-event').map(node=>node.dataset.archiveEventId);
 assert.deepEqual(cards(),['newer','older']);
 const search=descendants(root,node=>node.tagName==='INPUT'&&node.type==='search')[0];
 search.value='canyon';search.emit('input');assert.deepEqual(cards(),['newer']);
 search.value='';search.emit('input');
 const order=descendants(root,node=>node.tagName==='SELECT')[0];order.value='oldest';order.emit('change');
 assert.deepEqual(cards(),['older','newer']);assert.equal(loads,0);
});

test('archive search matches the locally formatted end date shown on the card',()=>{
 const {root}=archiveFixture();let loads=0;
 const endsAt=Date.UTC(2025,3,15,12);
 mountArchiveView(root,{locale:'en-US',periods:[{id:'dated-event',kind:'daily',trackName:'Alpine',endsAt,maxRp:100}],loadSnapshot:()=>{loads++;}});
 const card=descendants(root,node=>node.className==='sq-archive-event')[0];
 const shownDate=descendants(card,node=>node.className==='sq-archive-date')[0].textContent.split(' | ')[0];
 const search=descendants(root,node=>node.tagName==='INPUT'&&node.type==='search')[0];
 search.value=shownDate;search.emit('input');
 assert.equal(descendants(root,node=>node.className==='sq-archive-event').length,1);
 assert.equal(loads,0);
});

test('archive search matches the stable ISO end date at a UTC date boundary',()=>{
 const {root}=archiveFixture();let loads=0;
 const endsAt=Date.parse('2025-01-01T00:00:00.000Z');
 mountArchiveView(root,{locale:'en-US-u-ca-japanese',periods:[{id:'boundary-event',kind:'weekly',trackName:'Alpine',endsAt,maxRp:100}],loadSnapshot:()=>{loads++;}});
 const card=descendants(root,node=>node.className==='sq-archive-event')[0];
 const shownDate=descendants(card,node=>node.className==='sq-archive-date')[0].textContent.split(' | ')[0];
 assert.doesNotMatch(shownDate,/2025-01-01/);
 const search=descendants(root,node=>node.tagName==='INPUT'&&node.type==='search')[0];
 search.value='2025-01-01';search.emit('input');
 assert.equal(descendants(root,node=>node.className==='sq-archive-event').length,1);
 assert.equal(loads,0);
});

test('month jumps across all saved periods while preserving search, type and order through paging', () => {
  const {root}=archiveFixture(); let loads=0;
  const periods=Array.from({length:60},(_,i)=>({id:`event-${i}`,kind:i%2?'daily':'kodub',trackName:'Saved track',endsAt:Date.UTC(2026,9,24-i),racerCount:1}));
  mountArchiveView(root,{periods,loadSnapshot:()=>{loads++;}});
  const all=()=>descendants(root,node=>node.tagName==='DETAILS');
  const daily=descendants(root,node=>node.type==='checkbox'&&node.value==='daily')[0];daily.checked=false;daily.emit('change');
  const search=descendants(root,node=>node.type==='search')[0];search.value='saved';search.emit('input');
  const month=descendants(root,node=>node.type==='month')[0];month.value='2026-09';
  const form=descendants(root,node=>node.tagName==='FORM')[0];form.emit('submit',{preventDefault(){}});
  assert.equal(all().length,12);assert.ok(all().every(node=>node.dataset.eventKind==='kodub'));
  assert.ok(root.textContent.includes('Page 2 of 3'));assert.ok(root.textContent.includes('Other months remain available'));
  descendants(root,node=>node.tagName==='BUTTON'&&node.textContent==='Next')[0].emit('click');
  assert.ok(root.textContent.includes('Page 3 of 3'));assert.ok(all().every(node=>node.dataset.eventKind==='kodub'));
  month.value='2020-01';form.emit('submit',{preventDefault(){}});
  assert.match(root.textContent,/No saved events in 2020-01 match/);assert.equal(all().length,6);
  assert.equal(loads,0);
});

test('selection-only and empty archives retain practice actions even without final standings',()=>{
 const {root}=archiveFixture();let opened=0,imported=0,loads=0;
 mountArchiveView(root,{periods:[{id:'selection',kind:'kodub',endsAt:100,historyOnly:true,trackId:'a'.repeat(64),author:'Saved author'}],
   onOpenPeriod:()=>opened++,onImportPeriod:()=>imported++,loadSnapshot:()=>loads++});
 const card=descendants(root,node=>node.tagName==='DETAILS')[0];card.open=true;card.emit('toggle');
 for(const button of descendants(card,node=>node.tagName==='BUTTON'))button.emit('click');
 assert.equal(opened,1);assert.equal(imported,1);assert.equal(loads,0);
 assert.match(card.textContent,/no final standings or Event RP were captured/);assert.match(card.textContent,/Saved author/);
});

test('Spite-like saved live captures preserve entrant totals without inventing a final winner', () => {
  const {root} = archiveFixture();
  const period = {id:'spite', kind:'kodub', trackId:'a'.repeat(64), endsAt:100, racerCount:21};
  const snapshot = {period, archived:false, racerCount:21,
    entries:Array.from({length:17}, (_,i) => ({accountId:`racer-${i}`, timeMs:1000+i, rp:100-i}))};
  mountArchiveView(root, {periods:[period], snapshots:new Map([[period.id,snapshot]])});
  const card = descendants(root, node => node.tagName === 'DETAILS')[0];
  assert.equal(card.dataset.standingsState, 'non-final');
  assert.equal(descendants(card,node=>node.className==='sq-archive-standings')[0].children[0].className,'sq-archive-standings-status');
  assert.match(card.textContent, /21 event racers/);
  assert.match(card.textContent, /17 verified in saved capture/);
  assert.match(card.textContent, /Final standings are unavailable/);
  assert.match(card.textContent, /100 RP \(saved\)/);
  assert.match(card.textContent, /ordinary track leaderboard, not these historic event standings/);
  assert.equal(descendants(card, node => node.className === 'sq-archive-winner').length, 0);
  assert.equal(archivePeriodCounts(period,snapshot).winner, null);
  assert.equal(summarizeArchives([period],new Map([[period.id,snapshot]])).verifiedFinishes, 0);
});

test('final partial boards preserve saved ranks and do not fabricate missing RP or a winner', () => {
  const {root} = archiveFixture();
  const period = {id:'partial',kind:'daily',trackId:'a'.repeat(64),endsAt:100};
  const snapshot = {period,archived:true,complete:false,totalEntries:20,
    entries:[{accountId:'a',timeMs:1000,rank:11},{accountId:'b',timeMs:1100}]};
  mountArchiveView(root,{periods:[period],snapshots:new Map([[period.id,snapshot]])});
  assert.match(root.textContent, /Only part of the final event standings was saved/);
  assert.match(root.textContent, /#11/);
  assert.match(root.textContent, /Rank unavailable/);
  assert.match(root.textContent, /RP unavailable/);
  assert.doesNotMatch(root.textContent, /Winner|0 RP/);
  for (const change of [{complete:false},{sourceComplete:false},{totalEntries:3},{pagination:{hasMore:true}},{publicationPending:true}]) {
    assert.equal(archiveSnapshotState(period,{...snapshot,complete:true,totalEntries:2,...change}), 'partial-final');
  }
});

test('unbound or ordinary practice boards cannot be passed to the archive launch callback', () => {
  const {root} = archiveFixture();
  const period = {id:'event',kind:'kodub',trackId:'a'.repeat(64),endsAt:100};
  let passed = 'not-called';
  const practice = {trackId:period.trackId,complete:true,totalEntries:9,entries:[{accountId:'a',timeMs:1}]};
  mountArchiveView(root,{periods:[period],snapshots:new Map([[period.id,practice]]),onOpenPeriod:(_,snapshot)=>{passed=snapshot;}});
  descendants(root,node=>node.tagName==='BUTTON'&&node.textContent==='Track details / practice')[0].emit('click');
  assert.equal(passed,null);
  assert.equal(archivePeriodCounts(period,practice).verified,null);
  assert.equal(archiveSnapshotState(period,practice),'mismatched');
});

test('explicitly unverified, rejected, malformed and waiting rows never become verified results', () => {
  const period = {id:'event'};
  const rejected = [{pending:true},{verified:false},{runVerified:false},{eventRpEligible:false},
    {status:'pending'},{status:'mismatch'},{verificationStatus:'waiting'},{timeMs:0},{timeMs:NaN},{timeMs:1.5}];
  const snapshot = {archived:true,entries:[{accountId:'winner',timeMs:900},
    ...rejected.map((flags,i)=>({accountId:`bad-${i}`,timeMs:100,...flags}))]};
  assert.deepEqual(archivePeriodCounts(period,snapshot).verifiedEntries.map(row=>row.accountId),['winner']);
  assert.equal(archivePeriodCounts(period,{entries:[],pendingPlaybacks:[{accountId:'waiting'}]}).racers,1);
});

test('non-final empty captures and catalog-only zeros do not assert an empty final board', () => {
  const {root} = archiveFixture();
  const period = {id:'empty',kind:'daily',endsAt:100,racerCount:3};
  mountArchiveView(root,{periods:[period],snapshots:{empty:{entries:[],archived:false}}});
  assert.match(root.textContent,/Final results are not known/);
  assert.doesNotMatch(root.textContent,/No verified finishes were recorded/);
  mountArchiveView(root,{periods:[{...period,racerCount:0}]});
  const card=descendants(root,node=>node.tagName==='DETAILS')[0];card.open=true;card.emit('toggle');
  assert.match(root.textContent,/No final standings have been loaded/);
});

test('synchronous snapshot loader failures use the retry message and leave imports available', async () => {
  const {root}=archiveFixture();let loads=0,imports=0;
  mountArchiveView(root,{periods:[{id:'missing',kind:'kodub',endsAt:100}],
    loadSnapshot:()=>{loads++;throw Error('not saved');},onImportPeriod:()=>imports++});
  const card=descendants(root,node=>node.tagName==='DETAILS')[0];card.open=true;card.emit('toggle');
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.match(root.textContent,/could not be loaded/);
  card.open=false;card.emit('toggle');card.open=true;card.emit('toggle');
  await new Promise(resolve=>setTimeout(resolve,0));
  descendants(root,node=>node.tagName==='BUTTON'&&node.textContent==='Import saved track')[0].emit('click');
  assert.equal(loads,2);assert.equal(imports,1);
});
