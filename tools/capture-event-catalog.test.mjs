import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {syncPublicEventCatalog} from './sync-event-catalog.mjs';
import {runPublicSnapshotBackup} from './public-snapshot-backup.mjs';
import {updatePublicSnapshot} from './update-public-snapshot.mjs';
import {decodeSnapshot} from './snapshot-package.mjs';
import {EVENT_CATALOG_ENDPOINT, EVENT_CATALOG_HANDOFF_MAX_AGE_MS, eventCatalogHandoffFromEnvironment,
  writeEventCatalogHandoff, readEventCatalogHandoff} from './capture-event-catalog.mjs';

const at = Date.parse('2026-11-06T08:46:00Z');
const sourceCommit = 'f1e88968f013b2adfa411cafce762f21ff5eee80';
const trackId = 'a'.repeat(64);
const period = {id: 'daily-capture', kind: 'daily', trackId, startsAt: at - 60000, endsAt: at + 3600000};
const rawCatalog = {periods: [period], archives: [], updatedAt: at, sourceRevision: 27, privateCaptureMarker: 'raw-only-fixture'};
const overall = {updatedAt: at, entries: [], trackSummaries: []};
const quiet = () => {};

async function fixture(t) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Catalog handoff tests must not issue production requests'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'catalog-handoff-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  const directory = path.join(root, 'local-reports', 'snapshot-staging');
  const runner = path.join(root, 'runner');
  await fs.mkdir(directory, {recursive: true});
  await fs.mkdir(runner);
  await fs.mkdir(path.join(root, 'events'));
  await fs.writeFile(path.join(root, 'index.html'), '<head></head>');
  const outputFile = path.join(root, 'events', 'public-catalog.json');
  const history = {...period, id: 'retained-history', startsAt: at - 3 * 86400000, endsAt: at - 2 * 86400000};
  await fs.writeFile(outputFile, JSON.stringify({periods: [], archives: [history]}));
  const env = {EVENT_CATALOG_HANDOFF_FILE: path.join(runner, 'event-catalog.private'),
    EVENT_CATALOG_CAPTURE_STARTED_AT: String(at - 1000), GITHUB_REPOSITORY: 'StaticQuasar931/PolyTrack-0.6.3-Ranked',
    GITHUB_RUN_ID: '123456', GITHUB_RUN_ATTEMPT: '1'};
  const handoff = eventCatalogHandoffFromEnvironment({env, sourceCommit});
  const calls = [], logs = [];
  let catalogResponse = () => Response.json(rawCatalog);
  const fetchImpl = async input => {
    const url = new URL(input); calls.push(url.pathname);
    if (url.href === EVENT_CATALOG_ENDPOINT) return catalogResponse();
    if (url.pathname === '/v1/snapshot/overall') return Response.json(overall);
    assert.match(url.pathname, /^\/v1\/events\/(?:daily-capture|permanent-rolling-hills)\/snapshot$/);
    return new Response('', {status: 404});
  };
  const sync = (options = {}) => syncPublicEventCatalog({outputFile, stagingDirectory: directory, fetchImpl,
    catalogHandoff: handoff, now: () => at, log: quiet, ...options});
  const backupOptions = {directory, fetchImpl, trackIds: [], trackFetchLimit: 0, now: at + 1000,
    log: line => logs.push(JSON.parse(line).publicSnapshotBackup)};
  const readEnvelope = async () => JSON.parse(await fs.readFile(handoff.file, 'utf8'));
  const putEnvelope = value => fs.writeFile(handoff.file, typeof value === 'string' ? value : JSON.stringify(value));
  return {root, directory, outputFile, env, handoff, calls, logs, sync, backupOptions, readEnvelope, putEnvelope,
    setResponse: response => {catalogResponse = response;}};
}

test('mocked before/after: dedicated capture plus backup uses one catalog HTTP request instead of two', async t => {
  const before = await fixture(t);
  await before.sync({catalogHandoff: null});
  const baseline = await runPublicSnapshotBackup(before.backupOptions);
  assert.equal(before.calls.filter(url => url === '/v1/events/catalog').length, 2);
  assert.equal(before.logs.at(-1).catalogFetches, 1);
  const after = await fixture(t);
  await after.sync();
  const result = await runPublicSnapshotBackup({...after.backupOptions, catalogHandoff: after.handoff});
  assert.equal(after.calls.filter(url => url === '/v1/events/catalog').length, 1);
  assert.equal(before.calls.length - after.calls.length, 1, 'one fewer HTTP request, not an assertion about billed reads');
  assert.equal(before.logs.at(-1).workerRequests - after.logs.at(-1).workerRequests, 1);
  t.diagnostic(JSON.stringify({catalogHttpRequests: {before: before.calls.filter(url => url === '/v1/events/catalog').length,
    after: after.calls.filter(url => url === '/v1/events/catalog').length},
    totalWorkerHttpRequests: {before: before.calls.length, after: after.calls.length}, billedDocumentReads: 'not-measured'}));
  assert.equal(after.logs.at(-1).catalogFetches, 0);
  assert.equal(after.logs.at(-1).catalogReused, true);
  assert.deepEqual(result, baseline, 'no change to captured boards, revisions, limits or event selection');
  const savedPublic = JSON.parse(await fs.readFile(after.outputFile, 'utf8'));
  assert.equal(savedPublic.archives[0].id, 'retained-history');
  assert.equal(result.selectedEventIds.includes('retained-history'), false, 'merged history is not fresh discovery');
  const envelope = await after.readEnvelope();
  assert.deepEqual(JSON.parse(envelope.raw), rawCatalog, 'retain the exact parsed response before public projection/merge');
  assert.equal(savedPublic.sourceRevision, undefined);
  assert.equal(JSON.stringify(after.logs).includes('raw-only-fixture'), false);
  assert.equal((await fs.readdir(path.dirname(after.handoff.file))).length, 1, 'no temporary files remain');
});

test('private raw envelope never enters staged JSON or the public pack, including via the real updater', async t => {
  const f = await fixture(t); await f.sync();
  const result = await updatePublicSnapshot({root: f.root, verificationAuthority: 'firestore', env: f.env,
    resolveSourceCommit: () => sourceCommit, captureOverall: null, captureTotals: null, calculateOverall: null,
    captureOptions: f.backupOptions, log: quiet});
  assert.equal(result.published, true);
  assert.equal(f.calls.filter(url => url === '/v1/events/catalog').length, 1);
  const index = JSON.parse(await fs.readFile(path.join(f.root, result.directory, 'index.json'), 'utf8'));
  for (const [logical, item] of Object.entries(index.files)) {
    assert.doesNotMatch(logical, /private|handoff|catalog/i);
    const raw = await decodeSnapshot(await fs.readFile(path.join(f.root, result.directory, item.path)));
    assert.equal(Buffer.from(raw).includes(Buffer.from('raw-only-fixture')), false);
    assert.equal(Buffer.from(raw).includes(Buffer.from('raw-event-catalog-capture')), false);
  }
  assert.deepEqual(JSON.parse((await f.readEnvelope()).raw), rawCatalog, 'packaging leaves private response outside staging');
});

const invalidCases = [
  ['absent', async f => fs.unlink(f.handoff.file)],
  ['projected public catalog', async f => f.putEnvelope(JSON.parse(await fs.readFile(f.outputFile, 'utf8')))],
  ['raw catalog without private binding', async f => f.putEnvelope(rawCatalog)],
  ['malformed JSON', async f => f.putEnvelope('{')],
  ['wrong source', async (_f, e) => {e.binding.sourceCommit = 'b'.repeat(40);}],
  ['wrong repository', async (_f, e) => {e.binding.repository = 'other/repository';}],
  ['wrong run', async (_f, e) => {e.binding.runId = '123457';}],
  ['wrong attempt', async (_f, e) => {e.binding.runAttempt = '2';}],
  ['wrong capture start', async (_f, e) => {e.binding.startedAt--;}],
  ['wrong endpoint', async (_f, e) => {e.endpoint += '?alternate=1';}],
  ['wrong kind', async (_f, e) => {e.kind = 'projected-catalog';}],
  ['wrong version', async (_f, e) => {e.schemaVersion = 2;}],
  ['wrong digest', async (_f, e) => {e.sha256 = '0'.repeat(64);}],
  ['future fetch time', async (_f, e) => {e.fetchedAt = at + 2000;}],
  ['before capture start', async (_f, e) => {e.fetchedAt = at - 2000;}],
  ['oversized file', async f => f.putEnvelope(' '.repeat(13 * 1024 * 1024))],
  ['invalid expected binding', async f => {f.handoff.binding.runAttempt = ''; return true;}]
];
for (const [name, change] of invalidCases) test(name + ' falls back to exactly one bounded catalog request in backup', async t => {
  const f = await fixture(t); await f.sync();
  const envelope = await f.readEnvelope();
  const handled = await change(f, envelope);
  if (handled === undefined && !['absent', 'projected public catalog', 'raw catalog without private binding', 'malformed JSON', 'oversized file'].includes(name))
    await f.putEnvelope(envelope);
  f.calls.length = 0;
  await runPublicSnapshotBackup({...f.backupOptions, catalogHandoff: f.handoff});
  assert.equal(f.calls.filter(url => url === '/v1/events/catalog').length, 1);
  assert.equal(f.logs.at(-1).catalogReused, false);
});

test('stale handoff falls back; a stale source cannot borrow a fresh file timestamp', async t => {
  const f = await fixture(t); await f.sync();
  const later = at + EVENT_CATALOG_HANDOFF_MAX_AGE_MS + 1;
  const envelope = await f.readEnvelope(); envelope.fetchedAt = later;
  await f.putEnvelope(envelope);
  f.calls.length = 0;
  await runPublicSnapshotBackup({...f.backupOptions, now: later, catalogHandoff: f.handoff});
  assert.equal(f.calls.filter(url => url === '/v1/events/catalog').length, 1);
});

test('freshness uses consumption time after a slow Overall capture, not the backup start time', async t => {
  const f = await fixture(t); await f.sync();
  let clock = at + 1000;
  t.mock.method(Date, 'now', () => clock);
  const fetchImpl = async (...args) => {
    if (String(args[0]).endsWith('/v1/snapshot/overall')) clock += EVENT_CATALOG_HANDOFF_MAX_AGE_MS;
    return f.backupOptions.fetchImpl(...args);
  };
  f.calls.length = 0;
  await runPublicSnapshotBackup({...f.backupOptions, now: undefined, fetchImpl, catalogHandoff: f.handoff});
  assert.equal(f.calls.filter(url => url === '/v1/events/catalog').length, 1);
});

test('all raw periods are revalidated even with a matching payload digest; invalid/empty data uses fallback', async t => {
  const f = await fixture(t); await f.sync();
  for (const raw of [{periods: [{...period, trackId: 'invalid'}], archives: []}, {periods: [], archives: []},
    {periods: Array.from({length: 161}, () => period), archives: []}]) {
    const envelope = await f.readEnvelope(); envelope.raw = JSON.stringify(raw);
    envelope.sha256 = createHash('sha256').update(envelope.raw).digest('hex'); await f.putEnvelope(envelope);
    f.calls.length = 0;
    await runPublicSnapshotBackup({...f.backupOptions, catalogHandoff: f.handoff});
    assert.equal(f.calls.filter(url => url === '/v1/events/catalog').length, 1);
  }
});

test('event start/end/grace boundaries and midnight rollover require a fresh request', async t => {
  const f = await fixture(t);
  for (const boundary of ['startsAt', 'endsAt', 'graceMs', 'midnight']) {
    let raw = structuredClone(rawCatalog), fetchedAt = at, now = at + 2000;
    if (boundary === 'startsAt') raw.periods[0].startsAt = at + 1000;
    if (boundary === 'endsAt') raw.periods[0].endsAt = at + 1000;
    if (boundary === 'graceMs') {raw.periods[0].endsAt = at - 1000; raw.periods[0].graceMs = 2000;}
    if (boundary === 'midnight') {fetchedAt = Date.parse('2026-11-06T23:59:59Z'); now = fetchedAt + 2000;}
    const handoff = {...f.handoff, binding: {...f.handoff.binding, startedAt: fetchedAt - 1000}};
    await writeEventCatalogHandoff(handoff, raw, {now: fetchedAt, stagingDirectory: f.directory});
    f.calls.length = 0;
    await runPublicSnapshotBackup({...f.backupOptions, now, catalogHandoff: handoff});
    assert.equal(f.calls.filter(url => url === '/v1/events/catalog').length, 1, boundary);
  }
});

test('deferred or invalid sync clears prior handoff and preserves saved public assignments', async t => {
  const f = await fixture(t);
  for (const response of [() => new Response('', {status: 429}), () => new Response('', {status: 503}),
    () => {throw TypeError('fetch failed');}, () => Response.json({periods: [], archives: []}),
    () => Response.json({periods: 'bad'})]) {
    await f.sync(); const saved = await fs.readFile(f.outputFile, 'utf8');
    f.setResponse(response);
    try {assert.equal((await f.sync()).deferred, true);} catch (error) {assert.match(error.message, /Invalid public event catalog/);}
    assert.equal(await fs.readFile(f.outputFile, 'utf8'), saved);
    assert.equal(await readEventCatalogHandoff(f.handoff, {now: at, stagingDirectory: f.directory}), null);
    f.setResponse(() => Response.json(rawCatalog));
  }
});

test('fallback preserves temporary deferral and invalid-data failure without retries or staging writes', async t => {
  const f = await fixture(t); await f.sync(); await fs.unlink(f.handoff.file);
  await fs.writeFile(path.join(f.directory, 'manifest.json'), JSON.stringify({schemaVersion: 1, tracks: {}, events: {}}));
  const saved = await fs.readFile(path.join(f.directory, 'manifest.json'), 'utf8');
  for (const status of [429, 503]) {
    f.setResponse(() => new Response('', {status})); f.calls.length = 0;
    const result = await runPublicSnapshotBackup({...f.backupOptions, catalogHandoff: f.handoff});
    assert.equal(result.deferred, true); assert.equal(result.status, status);
    assert.equal(f.calls.filter(url => url === '/v1/events/catalog').length, 1);
    assert.equal(await fs.readFile(path.join(f.directory, 'manifest.json'), 'utf8'), saved);
  }
  f.setResponse(() => Response.json({periods: [{...period, trackId: 'bad'}], archives: []}));
  await assert.rejects(runPublicSnapshotBackup({...f.backupOptions, catalogHandoff: f.handoff}), /Invalid public event period/);
  assert.equal(await fs.readFile(path.join(f.directory, 'manifest.json'), 'utf8'), saved);
});

test('raw handoff paths inside staging or with a .json extension are rejected before capture', async t => {
  const f = await fixture(t);
  for (const file of [path.join(f.directory, 'catalog.private'), path.join(f.directory, 'nested', 'catalog.private'),
    path.join(path.dirname(f.handoff.file), 'catalog.json')]) {
    const handoff = {...f.handoff, file}; f.calls.length = 0;
    await assert.rejects(f.sync({catalogHandoff: handoff}), /outside.*staging/);
    assert.equal(f.calls.length, 0);
    await assert.rejects(runPublicSnapshotBackup({...f.backupOptions, catalogHandoff: handoff}), /outside.*staging/);
  }
});

test('fresh catalog reuse cannot bypass the strict missing-replay publication barrier', async t => {
  const f = await fixture(t); await f.sync();
  await fs.mkdir(path.join(f.directory, 'tracks'));
  await fs.writeFile(path.join(f.directory, 'tracks', trackId + '.json'), JSON.stringify({trackId,
    entries: [{accountId: 'b'.repeat(64), uploadId: 42, replayHash: 'c'.repeat(64), frames: 1000,
      timeMs: 1000, runVerified: true, integrityVerified: true, verified: true, verifiedState: 1}]}));
  await assert.rejects(updatePublicSnapshot({root: f.root, verificationAuthority: 'firestore', env: f.env,
    resolveSourceCommit: () => sourceCommit, capture: async options => {
      assert.deepEqual(options.catalogHandoff, f.handoff);
      assert.deepEqual(await readEventCatalogHandoff(options.catalogHandoff, {now: at + 1000, stagingDirectory: f.directory}), rawCatalog);
      return {};
    }, log: quiet}), error => error.code === 'SNAPSHOT_REPLAYS_INCOMPLETE');
  await assert.rejects(fs.stat(path.join(f.root, 'snapshot-current.json')), {code: 'ENOENT'});
});

test('updater binds to actual checkout independently of a caller-supplied native source pin; offline mode ignores handoff', async t => {
  const f = await fixture(t); await f.sync();
  const actualCommit = 'b'.repeat(40);
  const result = await updatePublicSnapshot({root: f.root, verificationAuthority: 'firestore', env: f.env,
    nativePhaseOptions: {sourceCommit}, resolveSourceCommit: root => {assert.equal(root, f.root); return actualCommit;},
    capture: async options => {
      assert.equal(options.catalogHandoff.binding.sourceCommit, actualCommit);
      assert.equal(await readEventCatalogHandoff(options.catalogHandoff, {now: at + 1000, stagingDirectory: f.directory}), null);
      return {};
    }, log: quiet});
  assert.equal(result.published, true);
  await updatePublicSnapshot({root: f.root, offline: true, verificationAuthority: 'firestore', env: f.env,
    resolveSourceCommit: () => assert.fail('offline packaging does not resolve catalog bindings'), log: quiet});
});

test('workflow shares one private binding between existing steps and keeps admission, recovery and one-off limits', async () => {
  const source = (await fs.readFile(new URL('../.github/workflows/publish-verified-snapshots.yml', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
  const step = name => source.split(/(?=^      - )/m).find(block => block.startsWith('      - name: ' + name + '\n'));
  const catalog = step('Capture public event assignments'), snapshot = step('Capture bounded public snapshots');
  for (const block of [catalog, snapshot]) {
    assert.match(block, /EVENT_CATALOG_HANDOFF_FILE: \$\{\{ runner.temp \}\}\/polytrack-event-catalog.private/);
    assert.match(block, /EVENT_CATALOG_CAPTURE_STARTED_AT: \$\{\{ steps.coordination.outputs.started_at \}\}/);
  }
  assert.match(catalog, /execFileSync\('git',\['rev-parse','--verify','HEAD'\]/);
  assert.match(catalog, /checkWorkerCaptureAccess\(\)/);
  assert.match(catalog, /steps.overnight_guard.outputs.admitted == 'true'/);
  assert.match(snapshot, /steps.catalog.outputs.capture_status == 'complete'/);
  assert.match(snapshot, /recovery\?CAPTURE_REPAIR_SECOND.replayDocumentLimit:OVERNIGHT_SNAPSHOT.replayDocumentLimit/);
  assert.match(snapshot, /finally\{/);
  assert.match(snapshot, /encryptCaptureRecovery/);
  assert.match(step('Test snapshot integrity and resumable capture'), /tools\/capture-event-catalog.test.mjs/);
  assert.equal(eventCatalogHandoffFromEnvironment({env: {}, sourceCommit}), null);
});
