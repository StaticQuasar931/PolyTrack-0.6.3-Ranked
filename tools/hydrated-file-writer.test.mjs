import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {writeHydratedFiles} from './hydrated-file-writer.mjs';
import {hydrateStaging} from './update-public-snapshot.mjs';
import {encodeSnapshot} from './snapshot-package.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const row = (logicalPath, value = {}) => ({logicalPath, decoded: Buffer.from(JSON.stringify(value))});
const absent = file => assert.rejects(fs.lstat(file), error => error.code === 'ENOENT');
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hydrated-writer-test-'));
  t.after(async () => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert(path.basename(root).startsWith('hydrated-writer-test-'));
    assert.equal(await fs.realpath(root), root);
    await fs.rm(root, {recursive: true, force: false});
  });
  return {root, destination: path.join(root, 'output')};
}

test('eight writers preserve every byte and share one mkdir per new directory', async t => {
  const f = await fixture(t), rows = Array.from({length: 80}, (_, i) => row(`nested/shared/${i}.json`, {i}));
  const originals = rows.map(entry => sha(entry.decoded)), write = fs.writeFile, mkdir = fs.mkdir;
  const created = []; let active = 0, peak = 0;
  t.mock.method(fs, 'mkdir', async (...args) => {created.push(args[0]); return mkdir(...args);});
  t.mock.method(fs, 'writeFile', async (target, bytes, options) => {
    assert.equal(options.flag, 'wx'); active++; peak = Math.max(peak, active);
    try {await new Promise(resolve => setTimeout(resolve, 3)); return await write(target, bytes, options);}
    finally {active--;}
  });
  const result = await writeHydratedFiles(f.destination, rows);
  assert.equal(result.files, 80); assert.equal(result.mkdirCalls, 3);
  assert.equal(new Set(created).size, 3); assert.equal(created.length, 3);
  assert.equal(peak, 8); assert.equal(result.maxActiveWrites, 8); assert.equal(active, 0);
  for (let i = 0; i < rows.length; i++) {
    assert.equal(sha(await fs.readFile(path.join(f.destination, rows[i].logicalPath))), originals[i]);
    assert.equal(sha(rows[i].decoded), originals[i]);
    assert.equal((await fs.stat(path.join(f.destination, rows[i].logicalPath))).nlink, 1);
  }
});

test('all paths, duplicate aliases and buffers validate before any output creation', async t => {
  const f = await fixture(t);
  for (const bad of ['../escape.json', '/absolute.json', 'a//b.json', 'a/./b.json', 'a\\b.json', 'a:stream.json', 'export-progress.json']) {
    await assert.rejects(writeHydratedFiles(f.destination, [row('good.json'), row(bad)]), /unsafe/);
    await absent(f.destination);
  }
  for (const paths of [['a.json', 'a.json'], ['A.json', 'a.json'], ['Dir/a.json', 'dir/b.json'],
    ['a.json/b.json', 'a.json'], ['a.json', 'a.json/b.json']]) {
    await assert.rejects(writeHydratedFiles(f.destination, paths.map(name => row(name))), /conflicting/);
    await absent(f.destination);
  }
  await assert.rejects(writeHydratedFiles(f.destination, [row('good.json'), {logicalPath: 'bad.json', decoded: '{}'}]), /Buffer/);
  await absent(f.destination);
});

test('exclusive writes refuse existing files without overwriting or pruning them', async t => {
  const f = await fixture(t); await fs.mkdir(f.destination);
  const target = path.join(f.destination, 'sentinel.json'); await fs.writeFile(target, 'untouched');
  await assert.rejects(writeHydratedFiles(f.destination, [row('sentinel.json')]), error => error.code === 'EEXIST');
  assert.equal(await fs.readFile(target, 'utf8'), 'untouched');
  await writeHydratedFiles(f.destination, [row('other.json', {added: true})]);
  assert.equal(await fs.readFile(target, 'utf8'), 'untouched');
});

test('root and nested directory links cannot redirect hydration writes', async t => {
  const f = await fixture(t), outside = path.join(f.root, 'outside'); await fs.mkdir(outside);
  const link = path.join(f.root, 'link'); await fs.symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writeHydratedFiles(path.join(link, 'new'), [row('file.json')]), /directory link/);
  await absent(path.join(outside, 'new'));
  await fs.mkdir(f.destination);
  await fs.symlink(outside, path.join(f.destination, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(writeHydratedFiles(f.destination, [row('nested/file.json')]), /directory link/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test('write failure stops scheduling and drains active writers before rejecting', async t => {
  const f = await fixture(t), write = fs.writeFile; let active = 0, peak = 0, calls = 0;
  const failure = Error('fixture write failed');
  t.mock.method(fs, 'writeFile', async (...args) => {
    assert.equal(args[2].flag, 'wx'); const call = ++calls; active++; peak = Math.max(peak, active);
    try {await new Promise(resolve => setTimeout(resolve, call === 3 ? 1 : 20)); if (call === 3) throw failure; return await write(...args);}
    finally {active--;}
  });
  await assert.rejects(writeHydratedFiles(f.destination, Array.from({length: 40}, (_, i) => row(`${i}.json`))), error => error === failure);
  assert.equal(active, 0); assert(peak > 1 && peak <= 8); assert(calls <= 8);
  const finished = calls; await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(calls, finished);
  assert((await fs.lstat(f.destination)).isDirectory());
});

test('a cached failed mkdir rejects all waiters without writing or retrying it', async t => {
  const f = await fixture(t), mkdir = fs.mkdir, failure = Error('fixture mkdir failed'); let attempts = 0, writes = 0;
  t.mock.method(fs, 'mkdir', async (target, ...args) => {
    if (target === path.join(f.destination, 'shared')) {attempts++; throw failure;}
    return mkdir(target, ...args);
  });
  t.mock.method(fs, 'writeFile', async () => {writes++; assert.fail('mkdir failure must precede writes');});
  await assert.rejects(writeHydratedFiles(f.destination, Array.from({length: 20}, (_, i) => row(`shared/${i}.json`))), error => error === failure);
  assert.equal(attempts, 1); assert.equal(writes, 0);
});

test('empty input retains empty staging semantics', async t => {
  const f = await fixture(t), result = await writeHydratedFiles(f.destination, []);
  assert.equal(result.files, 0); assert.equal(result.maxActiveWrites, 0);
  assert.deepEqual(await fs.readdir(f.destination), []);
});

async function packedFixture(t, entries) {
  const f = await fixture(t), generation = path.join(f.root, 'public-snapshots76'); await fs.mkdir(generation);
  const files = {};
  for (const [name, text] of entries) {
    const bytes = await encodeSnapshot(text), hash = sha(bytes);
    await fs.writeFile(path.join(generation, hash + '.bin'), bytes);
    files[name] = {path: hash + '.bin', sha256: hash, decodedBytes: Buffer.byteLength(text)};
  }
  const index = {schemaVersion: 1, encoding: 'gzip-xor-a7-v1', generation: 76, files};
  const writeIndex = () => fs.writeFile(path.join(generation, 'index.json'), JSON.stringify(index));
  await writeIndex(); await fs.writeFile(path.join(f.root, 'snapshot-current.json'), JSON.stringify({currentdir: 'public-snapshots76'}));
  return {...f, generation, index, writeIndex};
}

test('hydrateStaging reads and validates every packed payload before its first output write', async t => {
  const entries = [['first.json', '{"a":1}'], ['nested/last.json', '{"b":2}']];
  const f = await packedFixture(t, entries), read = fs.readFile, write = fs.writeFile, seen = new Set();
  t.mock.method(fs, 'readFile', async (file, ...args) => {if (String(file).endsWith('.bin')) seen.add(String(file)); return read(file, ...args);});
  t.mock.method(fs, 'writeFile', async (file, ...args) => {
    if (String(file).startsWith(f.destination + path.sep)) assert.equal(seen.size, 2);
    return write(file, ...args);
  });
  assert.deepEqual(await hydrateStaging(f.root, f.destination), {directory: 'public-snapshots76', files: 2});
  for (const [name, text] of entries) assert.equal(await fs.readFile(path.join(f.destination, name), 'utf8'), text);
});

for (const damage of ['hash', 'decoded size', 'JSON', 'logical path', 'paging', 'case collision']) {
  test(`late ${damage} validation fails before hydration creates staging`, async t => {
    const entries = [['first.json', '{}'], ['last.json', damage === 'JSON' ? 'not JSON' : '{"last":true}']];
    if (damage === 'paging') entries.push(['snapshot-paging.json', '{}']);
    if (damage === 'case collision') entries.push(['FIRST.json', '{"alias":true}']);
    const f = await packedFixture(t, entries), item = f.index.files['last.json'];
    if (damage === 'hash') await fs.writeFile(path.join(f.generation, item.path), 'corrupt');
    if (damage === 'decoded size') {item.decodedBytes++; await f.writeIndex();}
    if (damage === 'logical path') {f.index.files['../escape.json'] = item; delete f.index.files['last.json']; await f.writeIndex();}
    await assert.rejects(hydrateStaging(f.root, f.destination)); await absent(f.destination);
  });
}
