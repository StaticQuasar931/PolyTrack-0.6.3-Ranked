import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {encodeSnapshot} from './snapshot-package.mjs';
import {selectPublishedEventTotalsBaseline} from './published-event-totals-baseline.mjs';
import {projectAssembledEventTotals, createNativeEventBaseline, nativeEventSourceHash} from './native-event-snapshot.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const account = sha('racer'), other = sha('other');
const period = {id: 'day1', trackId: sha('track'), startsAt: 1000, endsAt: 100000,
  graceMs: 1000, maxRp: 100, targetMs: 1000, kind: 'daily', entrantLimit: 200};
const board = () => ({id: period.id, period: structuredClone(period), archived: true, updatedAt: 2000,
  entries: [{accountId: account, timeMs: 1000, rp: 100}, {accountId: other, timeMs: 2000, rp: 50}]});
const totalRow = (accountId, finiteEventRp, events) => ({accountId, name: 'Preserved Racer',
  finiteEventRp, events, rp: finiteEventRp + 7, permanentRollingHillsRp: 7,
  rollingHillsEventRpContribution: 7, identityUpdatedAt: 1234, accountCreatedAt: 5});
const previousTotals = () => ({updatedAt: 3000, complete: true, totalEntries: 2,
  capturedAt: '1970-01-01T00:00:03.000Z', entries: [totalRow(account, 123, 2), totalRow(other, 50, 1)],
  nativeEventOverlay: {version: 'native-event-overlay-v1'}});
const exactBoard = value => ({...value, complete: true, totalEntries: value.entries.length});
const write = (dir, file, value) => fs.writeFile(path.join(dir, file), JSON.stringify(value));

async function fixture(t, {previous = previousTotals(), prior = board(), current, backendUpdatedAt = 2500} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'published-event-baseline-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const directory = path.join(root, 'capture'), published = path.join(root, 'public-snapshots72');
  await fs.mkdir(path.join(directory, 'events'), {recursive: true});
  await fs.mkdir(published);
  const index = {schemaVersion: 1, generation: 72, encoding: 'gzip-xor-a7-v1', files: {}};
  async function pack(logical, value) {
    const bytes = Buffer.from(await encodeSnapshot(value)), hash = sha(bytes);
    index.files[logical] = {path: hash + '.bin', sha256: hash, decodedBytes: Buffer.byteLength(JSON.stringify(value))};
    await fs.writeFile(path.join(published, hash + '.bin'), bytes);
    await write(published, 'index.json', index);
  }
  await pack('event-totals.json', previous);
  await pack('events/day1.json', prior);
  // The permanent board is not a finite contribution source and must not be read.
  index.files['events/permanent-rolling-hills.json'] = {path: 'unavailable.bin'};
  await write(published, 'index.json', index);
  await write(root, 'snapshot-current.json', {currentdir: 'public-snapshots72'});
  const raw = {updatedAt: backendUpdatedAt, entries: [], complete: true, totalEntries: 0};
  await write(directory, 'event-totals.json', raw);
  await write(directory, 'events/day1.json', current ?? exactBoard(prior));
  const manifest = {events: {day1: {path: 'events/day1.json'}}};
  await write(directory, 'manifest.json', manifest);
  return {root, directory, published, index, previous, raw, pack, manifest,
    select: () => selectPublishedEventTotalsBaseline({root, directory})};
}

test('selects trusted published totals, preserves residual/identity/dates, and does not write captures', async t => {
  const f = await fixture(t), before = await fs.readFile(path.join(f.directory, 'event-totals.json'));
  const result = await f.select(), provenance = result.totals.publishedSnapshotBaseline;
  const {nativeEventOverlay, ...preserved} = f.previous;
  assert.deepEqual(result.totals, {...preserved,
    publishedSnapshotBaseline: provenance});
  assert.equal(Object.hasOwn(result.totals, 'nativeEventOverlay'), false);
  assert.deepEqual(provenance, {generation: 72,
    indexSha256: sha(await fs.readFile(path.join(f.published, 'index.json'))),
    totalsSha256: f.index.files['event-totals.json'].sha256});
  assert.deepEqual(result.report, {selected: 'trusted-published-snapshot', fallback: true,
    backendUpdatedAt: 2500, priorUpdatedAt: 3000, totalAccounts: 2, knownAccounts: 2,
    exactAccounts: 1, residualAccounts: 1, priorBoards: 1, matchedBoards: 1,
    newEmptyBoards: 0, ignoredIncompleteBoards: 0});
  assert.deepEqual(await fs.readFile(path.join(f.directory, 'event-totals.json')), before);
});

test('normal native totals guard still rejects overlays, but accepts explicitly validated selection', async t => {
  const f = await fixture(t);
  assert.throws(() => projectAssembledEventTotals(f.previous), /not a pristine server baseline/);
  const {totals} = await f.select();
  assert.equal(projectAssembledEventTotals(totals).entries.length, 2);
  const source = exactBoard(board());
  const baseline = createNativeEventBaseline({serverBoard: source, serverTotals: totals,
    expectedSourceHash: nativeEventSourceHash(source)});
  assert.deepEqual(baseline.board.entries.map(row => row.rp), [100, 50]);
});

test('compares canonical contribution tuples and period keys rather than row order or display metadata', async t => {
  const current = exactBoard(board());
  current.entries.reverse();
  current.entries[0].name = 'Changed display only';
  current.period = Object.fromEntries(Object.entries(current.period).reverse());
  const f = await fixture(t, {current});
  assert.equal((await f.select()).report.matchedBoards, 1);
});

for (const backendUpdatedAt of [3000, 4000]) {
  test('keeps backend totals unchanged when not older: ' + backendUpdatedAt, async t => {
    const f = await fixture(t, {backendUpdatedAt});
    await fs.unlink(path.join(f.directory, 'manifest.json'));
    const result = await f.select();
    assert.deepEqual(result.totals, f.raw);
    assert.equal(result.report.fallback, false);
    assert.equal(result.totals.publishedSnapshotBaseline, undefined);
  });
}

for (const [name, mutate] of [
  ['account', value => {value.entries[0].accountId = sha('different');}],
  ['time', value => {value.entries[0].timeMs++;}],
  ['rp', value => {value.entries[0].rp++;}],
  ['track', value => {value.period.trackId = sha('different track');}],
  ['period policy', value => {value.period.targetMs++;}],
  ['period identity', value => {value.period.id = 'different';}],
  ['removed row', value => {value.entries.pop(); value.totalEntries--;}],
  ['emptied prior nonempty', value => {value.entries = []; value.totalEntries = 0;}],
  ['overlay', value => {value.nativeEventOverlay = {version: 'untrusted'};}]
]) {
  test('fails closed on changed current baseline ' + name, async t => {
    const current = exactBoard(board()); mutate(current);
    const f = await fixture(t, {current});
    await assert.rejects(f.select());
  });
}

test('permits new empty periods and ignores incomplete current boards for delta', async t => {
  const current = exactBoard(board()); current.sourceComplete = false; current.entries[0].rp = 999;
  const f = await fixture(t, {current});
  const empty = exactBoard({...board(), id: 'newday', period: {...period, id: 'newday'}, entries: []});
  await write(f.directory, 'events/newday.json', empty);
  f.manifest.events.newday = {path: 'events/newday.json'};
  await write(f.directory, 'manifest.json', f.manifest);
  const result = await f.select();
  assert.equal(result.report.ignoredIncompleteBoards, 1);
  assert.equal(result.report.newEmptyBoards, 1);
  empty.entries.push({accountId: account, timeMs: 1000, rp: 100}); empty.totalEntries = 1;
  await write(f.directory, 'events/newday.json', empty);
  await assert.rejects(f.select(), /New nonempty/);
});

for (const [name, mutate] of [
  ['incomplete', value => {value.complete = false;}],
  ['totalEntries', value => {value.totalEntries++;}],
  ['source incomplete', value => {value.sourceComplete = false;}],
  ['pagination', value => {value.pagination = {hasMore: true};}],
  ['duplicate account', value => {value.entries[1].accountId = account;}],
  ['missing known account', value => {value.entries.pop(); value.totalEntries--;}],
  ['fractional finite', value => {value.entries[0].finiteEventRp += 0.5;}],
  ['fractional rp', value => {value.entries[0].rp += 0.5;}],
  ['fractional events', value => {value.entries[0].events += 0.5;}],
  ['component conflict', value => {value.entries[0].rollingHillsEventRpContribution++;}],
  ['sum exceeds finite', value => {value.entries[0].finiteEventRp = 99; value.entries[0].rp = 106;}],
  ['sum exceeds events', value => {value.entries[0].events = 0;}]
]) {
  test('rejects inconsistent prior totals ' + name, async t => {
    const previous = previousTotals(); mutate(previous);
    const f = await fixture(t, {previous});
    await assert.rejects(f.select());
  });
}

test('checks all prior boards, including archived boards missing completeness markers', async t => {
  const f = await fixture(t);
  const extra = {...board(), id: 'archive', period: {...period, id: 'archive'}};
  await f.pack('events/archive.json', extra);
  await assert.rejects(f.select(), /known contributions exceed/);
});

test('rejects duplicate prior board accounts', async t => {
  const prior = board(); prior.entries[1].accountId = account;
  const f = await fixture(t, {prior});
  await assert.rejects(f.select(), /Invalid event contribution/);
});

for (const logical of ['event-totals.json', 'events/day1.json']) {
  for (const kind of ['sha256', 'decodedBytes', 'path']) {
    test('verifies ' + logical + ' ' + kind + ' before parsing payload', async t => {
      const f = await fixture(t), record = f.index.files[logical];
      if (kind === 'sha256') await fs.appendFile(path.join(f.published, record.path), 'corrupt');
      if (kind === 'decodedBytes') record.decodedBytes++;
      if (kind === 'path') record.path = '../outside.bin';
      await write(f.published, 'index.json', f.index);
      await assert.rejects(f.select(), /SHA256|decodedBytes|metadata/);
    });
  }
}

test('rejects unexpected publication pointer and index generation', async t => {
  const f = await fixture(t);
  await write(f.root, 'snapshot-current.json', {currentdir: 'public-snapshots73'});
  await assert.rejects(f.select(), /Expected trusted/);
  await write(f.root, 'snapshot-current.json', {currentdir: 'public-snapshots72'});
  f.index.generation = 73;
  await write(f.published, 'index.json', f.index);
  await assert.rejects(f.select(), /Invalid trusted snapshot index/);
});

test('rejects corrupted prior board even when current board is incomplete', async t => {
  const current = exactBoard(board()); current.complete = false;
  const f = await fixture(t, {current});
  f.index.files['events/day1.json'].decodedBytes++;
  await write(f.published, 'index.json', f.index);
  await assert.rejects(f.select(), /decodedBytes/);
});


test('large packed index is not confused with the two MiB per-payload limit', async t=>{const f=await fixture(t);f.index.metadataPadding='x'.repeat(2*1024*1024);await write(f.published,'index.json',f.index);const r=await f.select();assert.equal(r.report.fallback,true);});
