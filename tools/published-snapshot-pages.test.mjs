import assert from 'node:assert/strict';
import test from 'node:test';
import { assemblePublishedSnapshotPages } from './published-snapshot-pages.mjs';

const generation = 'a'.repeat(64);
const account = index => index.toString(16).padStart(64, '0');

function fixture(totalEntries = 531, overrides = {}) {
  const pageCount = Math.ceil(totalEntries / 100);
  const value = {
    entries: Array.from({ length: Math.min(totalEntries, 200) }, (_, index) => ({ accountId: account(index + 1) })),
    pagination: { version: 1, generation, pageSize: 100, pageCount, totalEntries, complete: true },
    sourceRevision: 42,
    ...overrides,
  };
  const pages = Array.from({ length: pageCount }, (_, page) => ({
    generation,
    page,
    pageSize: 100,
    pageCount,
    totalEntries,
    complete: true,
    sourceRevision: 42,
    entries: Array.from({ length: Math.min(100, totalEntries - page * 100) }, (_, index) => ({
      accountId: account(page * 100 + index + 1),
      rank: page * 100 + index + 1,
    })),
  }));
  return { value, pages };
}

test('legacy snapshots without pagination are returned unchanged without fetching', async () => {
  const legacy = { entries: [{ userId: account(1) }], complete: false };
  let requests = 0;
  const result = await assemblePublishedSnapshotPages(legacy, { fetchPage: async () => { requests++; } });
  assert.equal(result, legacy);
  assert.equal(requests, 0);
});

test('valid 531-row capture replaces the legacy preview only after all pages validate', async () => {
  const { value, pages } = fixture();
  value.pagination.privateMetadata = { internalNote: 'must not be returned' };
  value.pagination.ownerUid = 'private-owner';
  const preview = value.entries;
  const requests = [];
  const result = await assemblePublishedSnapshotPages(value, {
    fetchPage: async (page, requestedGeneration) => {
      assert.equal(requestedGeneration, generation);
      requests.push(page);
      return pages[page];
    },
    onRequest: page => requests.push(`count:${page}`),
  });

  assert.equal(result.entries.length, 531);
  assert.equal(result.entries[0].rank, 1);
  assert.equal(result.entries.at(-1).rank, 531);
  assert.equal(result.sourceComplete, true);
  assert.equal(result.complete, true);
  assert.equal(result.totalEntries, 531);
  assert.equal(result.sourceRevision, 42);
  assert.equal(result.paginatedSource, true);
  assert.deepEqual(result.pagination, {
    version: 1,
    generation,
    pageSize: 100,
    pageCount: 6,
    totalEntries: 531,
    complete: true,
  });
  assert.deepEqual(Object.keys(result.pagination), ['version', 'generation', 'pageSize', 'pageCount', 'totalEntries', 'complete']);
  assert.deepEqual(value.entries, preview, 'input preview remains unmodified');
  assert.deepEqual(requests.filter(value => typeof value === 'number'), [0, 1, 2, 3, 4, 5]);
  assert.equal(requests.filter(value => typeof value === 'string').length, 6);
});

test('validated pages preserve explicit canonical source incompleteness', async () => {
  const { value, pages } = fixture(150, { sourceComplete: false, complete: false });
  const result = await assemblePublishedSnapshotPages(value, { fetchPage: async page => pages[page] });

  assert.equal(result.entries.length, 150);
  assert.equal(result.totalEntries, 150);
  assert.equal(result.paginatedSource, true);
  assert.equal(result.sourceComplete, false);
  assert.equal(result.complete, false);
});

test('page response metadata, generation, and revision must stay consistent', async () => {
  const badPages = [
    page => ({ ...page, generation: 'b'.repeat(64) }),
    page => ({ ...page, page: 1 }),
    page => ({ ...page, pageSize: 99 }),
    page => ({ ...page, pageCount: page.pageCount + 1 }),
    page => ({ ...page, totalEntries: page.totalEntries + 1 }),
    page => ({ ...page, complete: false }),
    page => ({ ...page, sourceRevision: 43 }),
  ];
  for (const mutate of badPages) {
    const { value, pages } = fixture(150);
    pages[0] = mutate(pages[0]);
    await assert.rejects(assemblePublishedSnapshotPages(value, { fetchPage: async page => pages[page] }));
  }

  const { value, pages } = fixture(150);
  pages[1].sourceRevision = 43;
  await assert.rejects(assemblePublishedSnapshotPages(value, { fetchPage: async page => pages[page] }), /mixed source revisions/);
});

test('exact page lengths and account identities are required', async () => {
  for (const mutate of [
    page => { page.entries.pop(); },
    page => { page.entries.push({ accountId: account(999) }); },
    page => { page.entries[0] = { accountId: 'bad' }; },
    page => { page.entries[0] = { accountId: account(1), userId: account(2) }; },
    (_page, pages) => { pages[1].entries[0].accountId = account(1); },
  ]) {
    const { value, pages } = fixture(150);
    mutate(pages[0], pages);
    await assert.rejects(assemblePublishedSnapshotPages(value, { fetchPage: async page => pages[page] }));
  }
});

test('malformed pagination and page budgets fail before any page request', async () => {
  const cases = [
    { version: 2 },
    { generation: 'not-a-generation' },
    { pageSize: 99 },
    { pageCount: 3 },
    { pageCount: 1, totalEntries: 101 },
    { complete: false },
  ];
  for (const change of cases) {
    const { value } = fixture(150);
    value.pagination = { ...value.pagination, ...change };
    let requests = 0;
    await assert.rejects(assemblePublishedSnapshotPages(value, { fetchPage: async () => { requests++; } }));
    assert.equal(requests, 0);
  }

  for (const change of [{ pagination: null }, { generation: 'b'.repeat(64) }, { totalEntries: 151 }, { sourceRevision: -1 }]) {
    const { value } = fixture(150);
    Object.assign(value, change);
    let requests = 0;
    await assert.rejects(assemblePublishedSnapshotPages(value, { fetchPage: async () => { requests++; } }));
    assert.equal(requests, 0);
  }

  const { value } = fixture(10_001);
  let requests = 0;
  await assert.rejects(assemblePublishedSnapshotPages(value, { fetchPage: async () => { requests++; } }), /page budget/);
  assert.equal(requests, 0);
});

test('assembled pages preserve v2 root/counts and reject mixed or stripped page versions',async()=>{
 const {value,pages}=fixture(101,{eventCountVersion:2});
 for(const page of pages){page.eventCountVersion=2;page.entries=page.entries.map(row=>({...row,events:1,finiteEvents:0,permanentEvents:1}));}
 const result=await assemblePublishedSnapshotPages(value,{fetchPage:async i=>pages[i]});
 assert.equal(result.eventCountVersion,2);assert.ok(result.entries.every(row=>row.events===1&&row.finiteEvents===0&&row.permanentEvents===1));
 for(const version of [undefined,3])await assert.rejects(assemblePublishedSnapshotPages(value,{fetchPage:async i=>i?{...pages[i],eventCountVersion:version}:pages[i]}),/event count versions/);
});
