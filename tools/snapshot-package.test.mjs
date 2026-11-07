import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import { buildTrackStatistics, decodeSnapshot, encodeSnapshot, MAX_DECODED_BYTES, publishSnapshot, restoreSnapshotArchive } from './snapshot-package.mjs';

async function fixture(t) {
  t.mock.method(globalThis, 'fetch', () => assert.fail('Offline package tests forbid network'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'snapshot-package-'));
  const staging = path.join(root, 'staging');
  await mkdir(staging);
  t.after(async () => {
    const resolved = await fs.realpath(root), temporary = await fs.realpath(os.tmpdir());
    const relative = path.relative(temporary, resolved);
    assert.ok(relative.startsWith('snapshot-package-') && !relative.includes(path.sep));
    await rm(resolved, { recursive: true, force: true });
  });
  return { root, staging, stagingDirectory: staging, history: path.join(root, 'private-history'), historyDirectory: path.join(root, 'private-history') };
}

test('publishes immutable numbered generations and archives the previous generation', async (t) => {
  const paths = await fixture(t);
  await writeFile(path.join(paths.staging, 'tracks.json'), JSON.stringify({ tracks: ['a'] }));
  const first = await publishSnapshot(paths);
  assert.equal(first.generation, 1);
  assert.equal(first.directory, 'public-snapshots1');
  const firstFiles = await readdir(path.join(paths.root, first.directory));
  const firstIndex = JSON.parse(await readFile(path.join(paths.root, first.directory, 'index.json'), 'utf8'));
  assert.deepEqual(firstFiles.sort(), ['index.json', firstIndex.files['tracks.json'].path, firstIndex.files['track-statistics.json'].path].sort());
  assert.deepEqual(JSON.parse(await readFile(path.join(paths.root, 'snapshot-current.json'), 'utf8')), { currentdir: 'public-snapshots1' });

  const unchanged = await publishSnapshot(paths);
  assert.equal(unchanged.changed, false);
  assert.equal(unchanged.generation, 1);
  await writeFile(path.join(paths.staging, 'tracks.json'), JSON.stringify({ tracks: ['b'] }));
  const second = await publishSnapshot(paths);
  assert.equal(second.generation, 2);
  assert.equal(second.archivePath, path.join(paths.history, 'generation-1.snapshot.gz'));
  assert.deepEqual((await readdir(path.join(paths.root, 'public-snapshots1'))).sort(), firstFiles.sort());

  const restored = path.join(paths.root, 'restored');
  await restoreSnapshotArchive(second.archivePath, restored);
  const archiveIndex = JSON.parse(await readFile(path.join(restored, 'index.json'), 'utf8'));
  const archivedPayload = await readFile(path.join(restored, archiveIndex.files['tracks.json'].path));
  assert.equal(Buffer.from(await decodeSnapshot(archivedPayload)).toString('utf8'), '{"tracks":["a"]}');
});

function platform(t, value) {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', {...descriptor, value});
  t.after(() => Object.defineProperty(process, 'platform', descriptor));
}
const generationRename = from => /^\.public-snapshots[1-9]\d*\.\d+\.tmp$/.test(path.basename(String(from)));
const localError = code => Object.assign(new Error('Injected local rename failure'), {code});

for (const code of ['EPERM', 'EBUSY']) for (const failures of [1, 3]) {
  test(`Windows ${code} directory commit succeeds after ${failures} bounded retries without rebuilding`, async t => {
    const f = await fixture(t); platform(t, 'win32');
    await writeFile(path.join(f.staging, 'sample.json'), '{"value":1}');
    const rename = fs.rename, write = fs.writeFile, attempts = []; let candidateWrites = 0, stamped = 0;
    t.mock.method(fs, 'writeFile', async (file, ...args) => {
      if (String(file).includes('.tmp' + path.sep)) candidateWrites++;
      return write(file, ...args);
    });
    t.mock.method(fs, 'rename', async (from, to) => {
      if (generationRename(from)) {
        attempts.push([from, to, candidateWrites]);
        if (attempts.length <= failures) throw localError(code);
      }
      return rename(from, to);
    });
    const result = await publishSnapshot({...f, now: () => { stamped++; return 1000; }});
    assert.equal(result.changed, true); assert.equal(attempts.length, failures + 1); assert.equal(stamped, 1);
    for (const attempt of attempts) assert.deepEqual(attempt, attempts[0]);
    assert.deepEqual(JSON.parse(await readFile(path.join(f.root, 'snapshot-current.json'), 'utf8')), {currentdir: 'public-snapshots1'});
    assert.equal((await readdir(f.root)).some(name => name.endsWith('.tmp')), false);
  });
}

test('persistent Windows directory EPERM stops after four attempts and preserves the old pointer', async t => {
  const f = await fixture(t); platform(t, 'win32');
  await writeFile(path.join(f.staging, 'sample.json'), '{"value":1}'); await publishSnapshot(f);
  const pointer = await readFile(path.join(f.root, 'snapshot-current.json'), 'utf8');
  await writeFile(path.join(f.staging, 'sample.json'), '{"value":2}');
  const rename = fs.rename; let attempts = 0;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (generationRename(from)) { attempts++; throw localError('EPERM'); }
    return rename(from, to);
  });
  await assert.rejects(publishSnapshot(f), {code: 'EPERM'});
  assert.equal(attempts, 4);
  assert.equal(await readFile(path.join(f.root, 'snapshot-current.json'), 'utf8'), pointer);
  assert.equal((await readdir(f.root)).some(name => name.endsWith('.tmp') || name === 'public-snapshots2'), false);
});

for (const code of ['EPERM', 'EBUSY']) {
  test(`non-Windows ${code} directory failure is never retried`, async t => {
    const f = await fixture(t); platform(t, 'linux');
    await writeFile(path.join(f.staging, 'sample.json'), '{}');
    const rename = fs.rename; let attempts = 0;
    t.mock.method(fs, 'rename', async (from, to) => {
      if (generationRename(from)) { attempts++; throw localError(code); }
      return rename(from, to);
    });
    await assert.rejects(publishSnapshot(f), {code}); assert.equal(attempts, 1);
  });
}

for (const code of ['EACCES', 'EIO', 'EXDEV', 'EEXIST']) {
  test(`nontransient Windows ${code} directory failure is never retried`, async t => {
    const f = await fixture(t); platform(t, 'win32');
    await writeFile(path.join(f.staging, 'sample.json'), '{}');
    const rename = fs.rename; let attempts = 0;
    t.mock.method(fs, 'rename', async (from, to) => {
      if (generationRename(from)) { attempts++; throw localError(code); }
      return rename(from, to);
    });
    await assert.rejects(publishSnapshot(f), {code}); assert.equal(attempts, 1);
  });
}

for (const type of ['file', 'directory']) {
  test(`destination ${type} appearing after failure is never overwritten by retry`, async t => {
    const f = await fixture(t); platform(t, 'win32');
    await writeFile(path.join(f.staging, 'sample.json'), '{}');
    const rename = fs.rename; let attempts = 0, sentinel;
    t.mock.method(fs, 'rename', async (from, to) => {
      if (generationRename(from)) {
        attempts++;
        if (type === 'directory') { await mkdir(to); sentinel = path.join(to, 'owned-by-another-run'); }
        else sentinel = to;
        await writeFile(sentinel, 'retain'); throw localError('EPERM');
      }
      return rename(from, to);
    });
    await assert.rejects(publishSnapshot(f), {code: 'EEXIST'});
    assert.equal(attempts, 1); assert.equal(await readFile(sentinel, 'utf8'), 'retain');
    assert.equal((await readdir(f.root)).some(name => name.endsWith('.tmp')), false);
  });
}

for (const mutation of ['same-size-content', 'added-file', 'removed-file', 'added-empty-directory']) {
  test(`candidate ${mutation} change aborts without a rename retry`, async t => {
    const f = await fixture(t); platform(t, 'win32');
    await writeFile(path.join(f.staging, 'sample.json'), '{}');
    const rename = fs.rename; let attempts = 0;
    t.mock.method(fs, 'rename', async (from, to) => {
      if (generationRename(from)) {
        attempts++;
        const index = path.join(from, 'index.json');
        if (mutation === 'same-size-content') {
          const bytes = await readFile(index); bytes[0] ^= 1; await writeFile(index, bytes);
        } else if (mutation === 'added-file') await writeFile(path.join(from, 'unexpected'), 'x');
        else if (mutation === 'removed-file') await fs.unlink(index);
        else await mkdir(path.join(from, 'unexpected-directory'));
        throw localError('EPERM');
      }
      return rename(from, to);
    });
    await assert.rejects(publishSnapshot(f), /candidate changed/); assert.equal(attempts, 1);
    assert.deepEqual(await readdir(f.root), ['staging']);
  });
}

test('cleanup does not remove a pre-existing same-PID candidate', async t => {
  const f = await fixture(t), candidate = path.join(f.root, `.public-snapshots1.${process.pid}.tmp`);
  await writeFile(path.join(f.staging, 'sample.json'), '{}'); await mkdir(candidate);
  await writeFile(path.join(candidate, 'sentinel'), 'other invocation');
  await assert.rejects(publishSnapshot(f), {code: 'EEXIST'});
  assert.equal(await readFile(path.join(candidate, 'sentinel'), 'utf8'), 'other invocation');
});

test('replacement candidate identity is neither retried nor recursively removed', async t => {
  const f = await fixture(t); platform(t, 'win32');
  await writeFile(path.join(f.staging, 'sample.json'), '{}');
  const rename = fs.rename; let attempts = 0, replacement;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (generationRename(from)) {
      attempts++; replacement = from;
      await rename(from, path.join(f.root, 'original-candidate')); await mkdir(from);
      await writeFile(path.join(from, 'sentinel'), 'replacement'); throw localError('EPERM');
    }
    return rename(from, to);
  });
  await assert.rejects(publishSnapshot(f), /candidate changed/); assert.equal(attempts, 1);
  assert.equal(await readFile(path.join(replacement, 'sentinel'), 'utf8'), 'replacement');
});

test('pointer replacement EPERM is not retried and preserves old pointer plus finalized generation', async t => {
  const f = await fixture(t); platform(t, 'win32');
  await writeFile(path.join(f.staging, 'sample.json'), '{"value":1}'); await publishSnapshot(f);
  const pointer = await readFile(path.join(f.root, 'snapshot-current.json'), 'utf8');
  await writeFile(path.join(f.staging, 'sample.json'), '{"value":2}');
  const rename = fs.rename; let attempts = 0;
  t.mock.method(fs, 'rename', async (from, to) => {
    if (to === path.join(f.root, 'snapshot-current.json')) { attempts++; throw localError('EPERM'); }
    return rename(from, to);
  });
  await assert.rejects(publishSnapshot(f), {code: 'EPERM'}); assert.equal(attempts, 1);
  assert.equal(await readFile(path.join(f.root, 'snapshot-current.json'), 'utf8'), pointer);
  assert.equal(JSON.parse(await readFile(path.join(f.root, 'public-snapshots2', 'index.json'), 'utf8')).generation, 2);
});

test('real Windows non-delete-sharing directory handle causes one retry then publication succeeds',
  {skip: process.platform !== 'win32'}, async t => {
    const f = await fixture(t); await writeFile(path.join(f.staging, 'sample.json'), '{}');
    const rename = fs.rename; let attempts = 0, actualError;
    t.mock.method(fs, 'rename', async (from, to) => {
      if (!generationRename(from) || ++attempts !== 1) return rename(from, to);
      const releasePath = path.join(f.root, 'release-lock');
      const script = `$ErrorActionPreference='Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class DirectoryLock {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
}
'@
$h=[DirectoryLock]::CreateFileW($env:SNAPSHOT_LOCK_TARGET,1,3,[IntPtr]::Zero,3,0x02000000,[IntPtr]::Zero)
if($h.IsInvalid){throw ('CreateFileW failed: '+[Runtime.InteropServices.Marshal]::GetLastWin32Error())}
try {
  [Console]::WriteLine('LOCKED'); [Console]::Out.Flush()
  $deadline=[DateTime]::UtcNow.AddSeconds(15)
  while(-not [IO.File]::Exists($env:SNAPSHOT_LOCK_RELEASE)) {
    if([DateTime]::UtcNow -gt $deadline){throw 'Directory lock release timed out'}
    Start-Sleep -Milliseconds 20
  }
} finally {$h.Dispose()}
`;
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
        {windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: {...process.env, SNAPSHOT_LOCK_TARGET: from, SNAPSHOT_LOCK_RELEASE: releasePath}});
      let stderr = '', stdout = '';
      child.stderr.on('data', chunk => {stderr += chunk;});
      const closed = new Promise((resolve, reject) => {
        child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr || `Lock child exit ${code}`)));
      });
      // Observe rejection immediately even if startup fails before LOCKED.
      closed.catch(() => {});
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Directory lock startup timed out')), 15000);
          const finish = fn => value => {clearTimeout(timer); fn(value);};
          child.stdout.on('data', chunk => {stdout += chunk; if (stdout.includes('LOCKED')) finish(resolve)();});
          child.once('error', finish(reject));
          child.once('exit', code => {if (!stdout.includes('LOCKED')) finish(reject)(new Error(stderr || `Lock child exit ${code}`));});
        });
        try { return await rename(from, to); }
        catch (error) {actualError = error.code; throw error;}
      } finally {
        await writeFile(releasePath, 'release');
        if (!stdout.includes('LOCKED')) child.kill();
        await closed;
      }
    });
    const result = await publishSnapshot(f);
    assert.ok(['EPERM', 'EBUSY'].includes(actualError), `Expected actual Windows sharing failure, got ${actualError}`);
    assert.equal(attempts, 2); assert.equal(result.directory, 'public-snapshots1');
    t.diagnostic(`Observed real ${actualError}; released directory handle; attempt 2 succeeded`);
  });

test('codec round-trips JSON bytes and explicitly exposes non-security metadata', async () => {
  const encoded = await encodeSnapshot({ label: 'public' });
  assert.equal(Buffer.from(await decodeSnapshot(encoded)).toString('utf8'), '{"label":"public"}');
  assert.match((await import('./snapshot-package.mjs')).SNAPSHOT_CODEC.security, /not|non-security/i);
});
test('retired canonical diagnostic bytes never enter a public snapshot package',async t=>{
 const paths=await fixture(t);
 await writeFile(path.join(paths.staging,'tracks.json'),JSON.stringify({tracks:['public']}));
 await mkdir(path.join(paths.staging,'.retired-canonical'));
 await writeFile(path.join(paths.staging,'.retired-canonical','a'.repeat(64)+'.bin'),'{"privateRetiredFixture":true}');
 const result=await publishSnapshot(paths);
 const index=JSON.parse(await readFile(path.join(paths.root,result.directory,'index.json'),'utf8'));
 assert(!Object.keys(index.files).some(name=>name.includes('retired')));
 for(const item of Object.values(index.files))assert(!Buffer.from(await decodeSnapshot(await readFile(path.join(paths.root,result.directory,item.path)))).toString().includes('privateRetiredFixture'));
});

test('rejects staging files larger than the decoded limit', async (t) => {
  const paths = await fixture(t);
  await writeFile(path.join(paths.staging, 'too-large.json'), `{"data":"${'x'.repeat(MAX_DECODED_BYTES)}"}`);
  await assert.rejects(publishSnapshot(paths), /exceeds decoded limit/);
  assert.deepEqual(await readdir(paths.root), ['staging']);
});

test('omits export-progress checkpoint files', async (t) => {
  const paths = await fixture(t);
  await writeFile(path.join(paths.staging, 'overall.json'), '{"ok":true}');
  await writeFile(path.join(paths.staging, 'export-progress.json'), '{"checkpoint":true}');
  const result = await publishSnapshot(paths);
  const index = JSON.parse(await readFile(path.join(paths.root, result.directory, 'index.json'), 'utf8'));
  assert.deepEqual(Object.keys(index.files).sort(), ['overall.json', 'track-statistics.json']);
  assert.equal(index.encoding, 'gzip-xor-a7-v1');
});

test('builds compact statistics without claiming incomplete entry sets are complete', () => {
  const id = 'a'.repeat(64), other = 'b'.repeat(64);
  const stats = buildTrackStatistics([
    { logicalPath: 'manifest.json', value: { trackIdsKnown: 2, tracks: {
      [id]: { path: `tracks/${id}.json`, revision: 7, sourceUpdatedAt: 100, checkedAt: 200 },
      [other]: { path: null, revision: 3, sourceUpdatedAt: 50 },
    } } },
    { logicalPath: `tracks/${id}.json`, value: { trackId: id, complete: false, totalEntries: 3, updatedAt: 100, revision: 7,
      entries: [{ accountId: 'c'.repeat(64), weight: 0.5 }, { accountId: 'd'.repeat(64), weight: 0.5 }] } },
    { logicalPath: 'overall.json', value: { revision: 12, updatedAt: 300 } },
    { logicalPath: 'public-export-summary.json', value: { capturedAt: '2026-10-10T00:00:00.000Z' } },
  ]);
  assert.equal(stats.complete, false);
  assert.equal(stats.tracksKnown, 2);
  assert.equal(stats.tracksPresent, 1);
  assert.equal(stats.tracks[id].count, 2);
  assert.equal(stats.tracks[id].players, null);
  assert.equal(stats.tracks[id].totalEntries, 3);
  assert.equal(stats.tracks[id].weight, 0.5);
  assert.equal(stats.tracks[id].revision, 7);
  assert.equal(stats.tracks[id].updatedAt, 100);
  assert.equal(stats.tracks[id].capturedAt, new Date(200).toISOString());
  assert.equal(stats.tracks[other].count, null);
  assert.equal(stats.tracks[other].capturedAt, null);
  assert.equal(stats.revision, 12);
  assert.equal(stats.updatedAt, 300);
  assert.equal(stats.capturedAt, '2026-10-10T00:00:00.000Z');
});

test('reports exact players only for complete unique-entry snapshots', () => {
  const id = 'a'.repeat(64);
  const stats = buildTrackStatistics([
    { logicalPath: 'manifest.json', value: { trackIdsKnown: 1, tracks: { [id]: { path: `tracks/${id}.json` } } } },
    { logicalPath: `tracks/${id}.json`, value: { complete: true, totalEntries: 2, entries: [
      { accountId: 'b'.repeat(64), weight: 0.25 }, { accountId: 'c'.repeat(64), weight: 0.25 },
    ] } },
  ]);
  assert.equal(stats.complete, true);
  assert.equal(stats.tracks[id].players, 2);
  assert.equal(stats.tracks[id].count, 2);
});

test('regenerates hydrated track statistics once and preserves a valid zero weight', async (t) => {
  const paths = await fixture(t);
  const id = 'a'.repeat(64);
  await writeFile(path.join(paths.staging, 'manifest.json'), JSON.stringify({ trackIdsKnown: 1, tracks: {
    [id]: { path: `tracks/${id}.json`, revision: 4, checkedAt: 500 },
  } }));
  await mkdir(path.join(paths.staging, 'tracks'));
  await writeFile(path.join(paths.staging, 'tracks', `${id}.json`), JSON.stringify({ trackId: id, complete: true, totalEntries: 1,
    revision: 4, updatedAt: 400, entries: [{ accountId: 'b'.repeat(64), weight: 0 }] }));
  await writeFile(path.join(paths.staging, 'track-statistics.json'), JSON.stringify({ schemaVersion: 1, stale: true }));

  const result = await publishSnapshot(paths);
  const index = JSON.parse(await readFile(path.join(paths.root, result.directory, 'index.json'), 'utf8'));
  assert.equal(Object.keys(index.files).filter(name => name === 'track-statistics.json').length, 1);
  const statsBytes = await readFile(path.join(paths.root, result.directory, index.files['track-statistics.json'].path));
  const stats = JSON.parse(Buffer.from(await decodeSnapshot(statsBytes)).toString('utf8'));
  assert.equal(stats.stale, undefined);
  assert.equal(stats.complete, true);
  assert.equal(stats.tracks[id].players, 1);
  assert.equal(stats.tracks[id].weight, 0);
  assert.equal((await readdir(path.join(paths.root, result.directory))).length, 4);
});


test('package publication time is stable for no-op runs and changes only with content', async t => {
 const f=await fixture(t);await writeFile(path.join(f.staging,'sample.json'),'{"value":1}');
 const first=await publishSnapshot({...f,now:()=>1000});
 const load=async dir=>JSON.parse(await readFile(path.join(f.root,dir,'index.json'),'utf8'));
 assert.equal((await load(first.directory)).publishedAt,1000);
 const same=await publishSnapshot({...f,now:()=>{throw Error('no-op must not stamp time');}});
 assert.equal(same.changed,false);assert.equal((await load(first.directory)).publishedAt,1000);
 await writeFile(path.join(f.staging,'sample.json'),'{"value":2}');
 const changed=await publishSnapshot({...f,now:()=>2000});
 assert.equal((await load(changed.directory)).publishedAt,2000);
 assert.equal((await load(first.directory)).publishedAt,1000);
});
