import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {exportPublicProfilesAndReplays} from './public-profile-replay-export.mjs';

const ids = ['a', 'b', 'c'].map(value => value.repeat(64));
const name = id => `projects/polytrack-052/databases/(default)/documents/0.6.2_profiles_public/${id}`;
const document = id => ({document: {name: name(id), fields: {name: {stringValue: 'Public Racer'}}}});

async function fixture(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'export-storage-'));
  await fs.mkdir(path.join(directory, 'staging', 'tracks'), {recursive: true});
  try { await run(directory); }
  finally { await fs.rm(directory, {recursive: true, force: true}); }
}

test('profile storage failure retains successful page prefix and resumes the failed row before pruning', async () => {
  await fixture(async directory => {
    const stale = 'f'.repeat(64);
    await fs.mkdir(path.join(directory, 'profiles'));
    await fs.writeFile(path.join(directory, 'profiles', stale + '.json'), '{}');
    const originalRename = fs.rename;
    const failure = Object.assign(Error('mock disk full'), {code: 'ENOSPC'});
    const requests = [];
    let returnedDocuments = 0;
    const fetchImpl = async (url, options) => {
      assert.ok(String(url).endsWith(':runQuery'));
      const query = JSON.parse(options.body).structuredQuery;
      requests.push(query);
      const after = query.startAt?.values[0].referenceValue;
      const rows = ids.filter(id => !after || name(id) > after).map(document);
      returnedDocuments += rows.length;
      return {ok: true, text: async () => JSON.stringify(rows)};
    };
    fs.rename = async (...args) => {
      if (args[1] === path.join(directory, 'profiles', ids[1] + '.json')) throw failure;
      return originalRename(...args);
    };
    try {
      await assert.rejects(exportPublicProfilesAndReplays({directory, fullSnapshot: true, pageSize: 3,
        maxDocuments: 3, fetchImpl}), error => error === failure);
    } finally { fs.rename = originalRename; }
    const progress = JSON.parse(await fs.readFile(path.join(directory, 'export-progress.json'), 'utf8'));
    assert.equal(progress.profiles.cursor, name(ids[0]));
    assert.equal(progress.profiles.scanned, 1);
    assert.equal(progress.profileCount, 1);
    assert.equal(progress.profileSkipped, 0);
    assert.equal(progress.profiles.complete, false);
    assert.equal(progress.fullSnapshotPending, true);
    assert.equal(await fs.readFile(path.join(directory, 'profiles', stale + '.json'), 'utf8'), '{}');
    await assert.rejects(fs.stat(path.join(directory, 'profiles', ids[1] + '.json')), {code: 'ENOENT'});
    const result = await exportPublicProfilesAndReplays({directory, pageSize: 3, maxDocuments: 3, fetchImpl});
    assert.equal(requests.length, 2);
    assert.equal(requests[1].startAt.values[0].referenceValue, name(ids[0]));
    assert.equal(returnedDocuments, 5, 'three initial mock document reads plus two resumed reads');
    assert.equal(result.fetchedDocumentsThisRun, 2);
    assert.equal(result.counts.profiles, 3);
    assert.equal(result.complete, true);
    for (const id of ids) assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'profiles', id + '.json'))).accountId, id);
    await assert.rejects(fs.stat(path.join(directory, 'profiles', stale + '.json')), {code: 'ENOENT'});
    assert.deepEqual((await fs.readdir(path.join(directory, 'profiles'))).sort(), ids.map(id => id + '.json'));
  });
});

test('malformed profile data still prevents completeness and stale-profile pruning', async () => {
  await fixture(async directory => {
    await fs.mkdir(path.join(directory, 'profiles'));
    const stalePath = path.join(directory, 'profiles', 'f'.repeat(64) + '.json');
    await fs.writeFile(stalePath, '{}');
    const result = await exportPublicProfilesAndReplays({directory, fullSnapshot: true,
      fetchImpl: async () => ({ok: true, text: async () => JSON.stringify([
        {document: {name: name(ids[0]), fields: {name: {unsupportedValue: 'invalid'}}}}
      ])})});
    assert.equal(result.complete, false);
    assert.equal(result.counts.skipped, 1);
    assert.equal(result.counts.profiles, 0);
    assert.equal(await fs.readFile(stalePath, 'utf8'), '{}');
  });
});
