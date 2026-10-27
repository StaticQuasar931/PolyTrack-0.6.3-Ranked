import test from 'node:test';
import assert from 'node:assert/strict';
import worker, {handleRequest, rebuildOverall} from '../src/index.js';
import {eventEncode, eventDecode} from '../src/events-store.js';
import {preparePublicationPages, PUBLIC_PAGE_COLLECTION, PUBLIC_MANIFEST_COLLECTION,
  publicationManifestId} from '../src/paged-publication.js';

const token = 'offline-fixture-only';
const origin = 'https://staticquasar931.github.io';
const metaPath = '/0.6.2_s1_release_meta/current';
const overallPath = '/0.6.2_s1_leaderboards_overall/main';
const document = (data, updateTime = '2026-10-27T00:00:00Z') => ({fields:eventEncode(data).mapValue.fields, updateTime});
const request = (path, method = 'GET', token) => new Request('https://external-mode.example' + path, {
  method, headers:{Origin:origin, ...(token ? {'X-Admin-Token':token} : {})}
});
function fixture(mode = 'external', read = async () => {throw Error('UNEXPECTED_STORAGE');}) {
  const calls = [];
  const env = {ALLOWED_ORIGINS:origin, OVERALL_PUBLICATION_MODE:mode, ADMIN_REBUILD_TOKEN:token,
    __TEST_FIRESTORE:async (path, init) => {calls.push({path, init}); return read(path, init);}};
  return {env, calls};
}

test('external publication blocks all implicit builds before storage, even forced ones', async () => {
  const f = fixture();
  for (const [force, options] of [[false, undefined], [true, undefined], [false, {adminRecovery:true}],
    [true, {adminRecovery:'true'}]]) {
    assert.deepEqual(await rebuildOverall(f.env, force, options), {
      rebuilt:false, reason:'externally_published', publicationMode:'external'
    });
  }
  assert.deepEqual(f.calls, []);
});

test('external-mode callers cannot join an already-running legacy build', async () => {
  let release;
  const waiting = new Promise(resolve => {release = resolve;});
  const f = fixture('worker', async path => {
    assert.equal(path, metaPath);
    await waiting;
    return document({overallRebuildRetryAt:Date.now() + 60000});
  });
  const pending = rebuildOverall(f.env);
  const external = {...f.env, OVERALL_PUBLICATION_MODE:'external', __FIRESTORE_ROOT_ENV:f.env};
  try {
    assert.equal((await rebuildOverall(external)).reason, 'externally_published');
    assert.equal((await rebuildOverall(external, true)).reason, 'externally_published');
    assert.equal(f.calls.length, 1);
  } finally {release(); await pending;}
});

test('the Overall cron consumes zero storage requests throughout an external-mode day', async () => {
  const f = fixture(), original = console.log, logs = [];
  console.log = (...args) => logs.push(args);
  try {
    for (let minute = 1; minute < 1440; minute += 5) {
      let completion;
      worker.scheduled({cron:'1-59/5 * * * *', scheduledTime:Date.UTC(2026,9,27) + minute * 60000},
        f.env, {waitUntil:value => {completion = value;}});
      await completion;
    }
  } finally {console.log = original;}
  assert.deepEqual(f.calls, []);
  assert.equal(logs.length, 288);
  for (const [message, payload] of logs) {
    assert.equal(message, 'Ranked scheduled Firestore reads');
    const audit = JSON.parse(payload);
    assert.equal(audit.httpRequests, 0);
    assert.equal(audit.documentReadEstimate, 0);
  }
});

for (const mode of [undefined, '', 'worker', 'external-typo', 'EXTERNAL', true]) {
  test('non-opted-in mode preserves legacy metadata read: ' + String(mode), async () => {
    const f = fixture(mode, async path => {
      assert.equal(path, metaPath);
      return document({overallRebuildRetryAt:Date.now() + 60000});
    });
    // A missing binding, not just a binding whose value is undefined.
    if (mode === undefined) delete f.env.OVERALL_PUBLICATION_MODE;
    assert.equal((await rebuildOverall(f.env)).reason, 'failure_cooldown');
    assert.equal(f.calls.length, 1);
  });
}

test('admin recovery requires both the existing token and the explicit acknowledgement', async () => {
  const f = fixture();
  for (const token of [undefined, 'wrong']) {
    assert.equal((await handleRequest(request('/v1/admin/rebuild?recovery=worker-rebuild', 'POST', token), f.env)).status, 403);
  }
  for (const suffix of ['', '?force=true', '?recovery=true', '?recovery=worker-rebuild-typo']) {
    const response = await handleRequest(request('/v1/admin/rebuild' + suffix, 'POST', token), f.env);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error, 'external_overall_publication');
  }
  assert.deepEqual(f.calls, []);
});

for (const mode of ['worker', 'external']) {
  test('authenticated legacy builder can still publish through CAS in mode ' + mode, async () => {
    const f = fixture(mode, async (path, init) => {
      if (path === metaPath) return document({revision:9, dirty:true});
      if (path === overallPath || path === '/0.6.2_s1_worker_jobs/release_migration') return null;
      if (path === ':runQuery') return [];
      if (path === ':commit') {
        const writes = JSON.parse(init.body).writes;
        const main = writes.find(w => w.update.name.endsWith(overallPath));
        assert.deepEqual(main.currentDocument, {exists:false});
        const meta = writes.find(w => w.update.name.endsWith(metaPath));
        assert.deepEqual(meta.currentDocument, {updateTime:'2026-10-27T00:00:00Z'});
        return {writeResults:writes.map(() => ({updateTime:'2026-10-27T00:01:00Z'}))};
      }
      assert.fail('Unexpected recovery operation: ' + path);
    });
    const suffix = mode === 'external' ? '?recovery=worker-rebuild' : '';
    const response = await handleRequest(request('/v1/admin/rebuild' + suffix, 'POST', token), f.env);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).rebuilt, true);
    assert.equal(f.calls.filter(call => call.path === ':commit').length, 1);
  });
}

test('explicit external-mode recovery retains legacy publication CAS and rejects stale output', async () => {
  const f = fixture('external', async (path, init) => {
    if (path === metaPath) return document({revision:9, builtRevision:8, dirty:true});
    if (path === overallPath) return document({entries:[], revision:8}, '2026-10-26T00:00:00Z');
    if (path === '/0.6.2_s1_worker_jobs/release_migration') return null;
    if (path === ':runQuery') return [];
    if (path === ':commit') {
      const writes = JSON.parse(init.body).writes;
      const main = writes.find(w => w.update.name.endsWith(overallPath));
      if (main) {
        assert.deepEqual(main.currentDocument, {updateTime:'2026-10-26T00:00:00Z'});
        const meta = writes.find(w => w.update.name.endsWith(metaPath));
        assert.deepEqual(meta.currentDocument, {updateTime:'2026-10-27T00:00:00Z'});
        assert.equal(eventDecode({mapValue:{fields:main.update.fields}}).sourceRevision, 9);
        throw Error('FIRESTORE_412');
      }
      return {writeResults:writes.map(() => ({updateTime:'2026-10-27T00:01:00Z'}))};
    }
    assert.fail('Unexpected operation: ' + path);
  });
  await assert.rejects(handleRequest(request('/v1/admin/rebuild?recovery=worker-rebuild', 'POST', token), f.env), /FIRESTORE_412/);
  assert.ok(f.calls.some(call => call.path === ':runQuery'));
  const publications = f.calls.filter(call => call.path === ':commit' &&
    JSON.parse(call.init.body).writes.some(w => w.update.name.endsWith(overallPath)));
  assert.equal(publications.length, 1, 'no fresh CAS retry can bless stale output');
});

test('admin reconcile in external mode does not silently aggregate Overall', async () => {
  const f = fixture('external', async path => {
    if (path.includes('/0.6.2_s1_worker_jobs/')) return document({complete:true,
      backfillComplete:true, pendingTrackIds:[], lastScanAt:Date.now()});
    if (path === ':runQuery') return [];
    assert.fail('Unexpected reconciliation operation: ' + path);
  });
  const response = await handleRequest(request('/v1/admin/reconcile', 'POST', token), f.env);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).overall.reason, 'externally_published');
  assert.ok(f.calls.every(call => call.path !== metaPath && call.path !== overallPath));
});

test('cold public roots remain read-only for missing, dirty, outdated and corrupt publications', async () => {
  const previous = globalThis.caches;
  delete globalThis.caches;
  try {
    for (const data of [null, {entries:[], revision:1}, {entries:[], schemaVersion:0, dirty:true},
      {entryDetailsBundle:'invalid', entryDetailsVersion:1}]) {
      const f = fixture('external', async path => {
        if (path === overallPath) return data === null ? null : document(data);
        if (path === metaPath) return document({dirty:true, revision:2, builtRevision:1});
        assert.fail('Public request must not scan, write, or read build inputs: ' + path);
      });
      const pending = [];
      // Corrupt bundles may throw, but must never trigger repair.
      await handleRequest(request('/v1/snapshot/overall?recovery=worker-rebuild'), f.env,
        {waitUntil:task => pending.push(task)}).catch(() => {});
      assert.equal((await handleRequest(request('/v1/status'), f.env)).status, 200);
      await Promise.all(pending);
      assert.deepEqual(f.calls.map(call => call.path), [overallPath, metaPath]);
    }
  } finally {if (previous === undefined) delete globalThis.caches; else globalThis.caches = previous;}
});

test('published public roots and pages have bounded cold reads and no cache-buster amplification', async () => {
  const previous = globalThis.caches;
  delete globalThis.caches;
  try {
    const paged = await preparePublicationPages('overall', 'main', [{userId:'racer'}], {sourceRevision:9});
    const page = paged.documents[0];
    const manifestPath = '/' + PUBLIC_MANIFEST_COLLECTION + '/' + publicationManifestId('overall', 'main', paged.pagination.generation);
    const pagePath = '/' + PUBLIC_PAGE_COLLECTION + '/' + page.id;
    const f = fixture('external', async path => {
      if (path === overallPath) return document({entries:[], pagination:paged.pagination});
      if (path === metaPath) return document({dirty:true, revision:9});
      if (path === manifestPath) return document(paged.pagination);
      if (path === pagePath) return document(page.data);
      assert.fail('Unexpected public operation: ' + path);
    });
    const paths = ['/v1/snapshot/overall', '/v1/status',
      '/v1/snapshot/overall/page?generation=' + paged.pagination.generation + '&page=0'];
    for (let i = 0; i < 4; i++) for (const path of paths) {
      const suffix = (path.includes('?') ? '&' : '?') + 'noise=' + i;
      assert.equal((await handleRequest(request(path + suffix), f.env)).status, 200);
    }
    assert.deepEqual(f.calls.map(call => call.path), [overallPath, metaPath, manifestPath, pagePath]);
  } finally {if (previous === undefined) delete globalThis.caches; else globalThis.caches = previous;}
});
