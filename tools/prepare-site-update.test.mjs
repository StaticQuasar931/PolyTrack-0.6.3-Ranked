import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFile, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, dirname, basename} from 'node:path';
import {spawnSync} from 'node:child_process';

const patch = 'installSiteUpdates({revision:193});';
const index = '<script src="polytrack_062_patch.js?v=193"></script>';
async function fixture(t, manifest, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'polytrack-prepare-site-update-'));
  t.after(async () => {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('polytrack-prepare-site-update-'));
    await rm(directory, {recursive:true, force:true});
  });
  await mkdir(join(directory, 'tools'));
  await mkdir(join(directory, 'events'));
  for (const name of ['prepare-site-update.mjs', 'site-release.mjs']) {
    await copyFile(new URL('./' + name, import.meta.url), join(directory, 'tools', name));
  }
  const files = {
    'site-version.json': JSON.stringify(manifest, null, 2) + '\n',
    'polytrack_062_patch.js': patch,
    'index.html': index,
    'events/client.mjs': "import {confirmPartialReplaySelection} from '../tools/partial-replay-selection.mjs?v=193';",
    ...overrides
  };
  for (const [name, content] of Object.entries(files)) await writeFile(join(directory, name), content);
  return {
    files,
    read: name => readFile(join(directory, name), 'utf8'),
    run: (...args) => spawnSync(process.execPath, [join(directory, 'tools', 'prepare-site-update.mjs'), ...args], {
      cwd:directory, encoding:'utf8', timeout:10000
    })
  };
}

test('default increment preserves minimumSupportedRevision and unknown manifest fields', async t => {
  const manifest = {
    revision:193,
    minimumSupportedRevision:172,
    futurePolicy:{enabled:false, versions:[172,193], label:'Keep this policy'},
    optionalValue:null,
    channel:'stable'
  };
  const f = await fixture(t, manifest);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await f.read('site-version.json')), {...manifest, revision:194});
  assert.match(await f.read('polytrack_062_patch.js'), /installSiteUpdates\(\{revision:194\}\)/);
  assert.match(await f.read('index.html'), /polytrack_062_patch\.js\?v=194/);
  assert.match(result.stdout, /Prepared website revision 194/);
  assert.match(await f.read('events/client.mjs'), /partial-replay-selection\.mjs\?v=194/);
});

test('explicit revision jump preserves fields and does not invent absent manifest policies', async t => {
  for (const manifest of [{revision:193, minimumSupportedRevision:172}, {revision:193, futureFlag:true}]) {
    const f = await fixture(t, manifest);
    const result = f.run('200');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(await f.read('site-version.json')), {...manifest, revision:200});
    assert.match(await f.read('polytrack_062_patch.js'), /revision:200/);
    assert.match(await f.read('index.html'), /patch\.js\?v=200/);
  }
});

test('invalid or non-increasing revisions leave all fixture files byte-for-byte unchanged', async t => {
  const f = await fixture(t, {revision:193, minimumSupportedRevision:172, future:{keep:true}});
  for (const revision of ['193', '192', '-1', '194.5', 'not-a-number', '9007199254740992']) {
    const result = f.run(revision);
    assert.notEqual(result.status, 0, revision);
    assert.match(result.stderr, /integer greater than the published revision/);
    for (const [name, before] of Object.entries(f.files)) assert.equal(await f.read(name), before, name);
  }
});

test('missing stamping anchors leave manifest and entry files unchanged', async t => {
  const f = await fixture(t, {revision:193, minimumSupportedRevision:172}, {'polytrack_062_patch.js':'// No stamping anchor.'});
  const result = f.run('194');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Release anchors are missing/);
  for (const [name, before] of Object.entries(f.files)) assert.equal(await f.read(name), before, name);
});

test('missing event stamping anchors leave every file unchanged', async t => {
  const f = await fixture(t, {revision:193}, {'events/client.mjs':'// Missing anchor.'});
  assert.notEqual(f.run('194').status, 0);
  for (const [name, before] of Object.entries(f.files)) assert.equal(await f.read(name), before, name);
});
