import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { encodeSnapshot } from './snapshot-package.mjs';
import { exportReadableSnapshot } from './export-readable-snapshot.mjs';

async function fixture(t, logicalPath = 'profiles/example.json', value = { name: '<img src=x onerror=alert(1)>', points: [1, 2] }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'readable-snapshot-'));
  const source = path.join(root, 'encoded');
  const output = path.join(root, 'private', 'archive');
  await mkdir(source);
  t.after(() => rm(root, { recursive: true, force: true }));
  const payload = Buffer.from(await encodeSnapshot(value));
  const hash = createHash('sha256').update(payload).digest('hex');
  await writeFile(path.join(source, `${hash}.bin`), payload);
  await writeFile(path.join(source, 'index.json'), JSON.stringify({ schemaVersion: 1, generation: 7, encoding: 'gzip-xor-a7-v1', files: { [logicalPath]: { path: `${hash}.bin`, sha256: hash, decodedBytes: Buffer.byteLength(JSON.stringify(value)) } } }));
  return { root, source, output, hash };
}

test('exports validated JSON at its logical path and builds an offline viewer', async (t) => {
  const paths = await fixture(t);
  const result = await exportReadableSnapshot({ sourceDirectory: paths.source, outputDirectory: paths.output });
  assert.equal(result.fileCount, 1);
  assert.equal(await readFile(path.join(paths.output, 'data/profiles/example.json'), 'utf8'), '{"name":"<img src=x onerror=alert(1)>","points":[1,2]}');
  const html = await readFile(path.join(paths.output, 'index.html'), 'utf8');
  assert.match(html, /textContent/);
  assert.doesNotMatch(html, /<img src=x onerror=alert/);
  assert.match(await readFile(path.join(paths.output, 'index.json'), 'utf8'), /no encryption/);
});

test('rejects payload hash mismatch without creating output', async (t) => {
  const paths = await fixture(t);
  await writeFile(path.join(paths.source, `${paths.hash}.bin`), 'tampered');
  await assert.rejects(exportReadableSnapshot({ sourceDirectory: paths.source, outputDirectory: paths.output }), /Payload hash mismatch/);
});

test('rejects traversal paths before creating output', async (t) => {
  const paths = await fixture(t, '../outside.json');
  await assert.rejects(exportReadableSnapshot({ sourceDirectory: paths.source, outputDirectory: paths.output }), /Unsafe snapshot path/);
});

test('refuses to overwrite an existing destination', async (t) => {
  const paths = await fixture(t);
  await mkdir(paths.output, { recursive: true });
  await assert.rejects(exportReadableSnapshot({ sourceDirectory: paths.source, outputDirectory: paths.output }), /Output already exists/);
});


test('default source follows the validated current pointer, not generation one', async t => {
  const f = await fixture(t);
  const {rename} = await import('node:fs/promises');
  await rename(f.source, path.join(f.root, 'public-snapshots7'));
  await writeFile(path.join(f.root, 'snapshot-current.json'), JSON.stringify({currentdir:'public-snapshots7'}));
  const result = await exportReadableSnapshot({root:f.root, outputDirectory:f.output});
  assert.equal(result.generation, 7);
});

test('default source rejects malformed or escaping generation pointers before output', async t => {
  const f = await fixture(t);
  for (const currentdir of ['../encoded','public-snapshots0','public-snapshots07','public-snapshots7/../encoded','public-snapshots9007199254740992',null]) {
    await writeFile(path.join(f.root,'snapshot-current.json'),JSON.stringify({currentdir}));
    await assert.rejects(exportReadableSnapshot({root:f.root,outputDirectory:f.output}), /snapshot pointer/i);
  }
});

test('default source rejects an index from another generation', async t => {
  const f = await fixture(t);
  const {rename} = await import('node:fs/promises');
  await rename(f.source,path.join(f.root,'public-snapshots8'));
  await writeFile(path.join(f.root,'snapshot-current.json'),JSON.stringify({currentdir:'public-snapshots8'}));
  await assert.rejects(exportReadableSnapshot({root:f.root,outputDirectory:f.output}),/generation/i);
});

test('default export location stays within the organized PolyTrack project', async () => {
  const source=await readFile(new URL('./export-readable-snapshot.mjs',import.meta.url),'utf8');
  assert.match(source,/Codexstorage\/PolyTrack\/Projects\/Ranked-0\.6\.3\/Exports\/ReadableSnapshots/);
  assert.doesNotMatch(source,/PolyTrack-private-snapshots|path\.join\(ROOT, 'public-snapshots1'\)/);
});


test('default source refuses directory junctions escaping the repository',async t=>{
  const f=await fixture(t),{symlink}=await import('node:fs/promises');
  await symlink(f.source,path.join(f.root,'public-snapshots7'),process.platform==='win32'?'junction':'dir');
  await writeFile(path.join(f.root,'snapshot-current.json'),JSON.stringify({currentdir:'public-snapshots7'}));
  await assert.rejects(exportReadableSnapshot({root:f.root,outputDirectory:f.output}),/pointer directory/);
});
