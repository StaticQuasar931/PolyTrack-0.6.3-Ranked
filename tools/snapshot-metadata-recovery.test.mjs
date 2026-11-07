import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const kinds = ['track-statistics', 'cosmetic-directory', 'racer-directory', 'snapshot-meta'];
const helperSource = fs.readFileSync(new URL('./snapshot-metadata-recovery.mjs', import.meta.url), 'utf8')
  .replace('export function createSnapshotMetadataRecovery', 'function createSnapshotMetadataRecovery');
const helperContext = vm.createContext({});
vm.runInContext(`${helperSource}\nglobalThis.createSnapshotMetadataRecovery = createSnapshotMetadataRecovery;`, helperContext);
const createSnapshotMetadataRecovery = helperContext.createSnapshotMetadataRecovery;
const payload = kind => kind === 'track-statistics' ? { tracks: { current: 1 } }
  : kind === 'snapshot-meta' ? { capturedAt: '2026-01-01T00:00:00Z' }
    : { entries: { current: 1 } };

test('missing metadata retries after 30 seconds, coalesces, and keeps successful values cached', async () => {
  let now = 1_000;
  const calls = new Map();
  const applied = new Map();
  const recovery = createSnapshotMetadataRecovery({
    now: () => now,
    read: kind => {
      calls.set(kind, (calls.get(kind) || 0) + 1);
      return calls.get(kind) === 1 ? null : payload(kind);
    },
    onValue: (kind, value) => applied.set(kind, value),
  });

  await recovery.warm();
  assert.equal(calls.size, 4);
  now += 29_999;
  await recovery.retryMissing();
  assert.deepEqual([...calls.values()], [1, 1, 1, 1]);

  now++;
  await Promise.all([recovery.retryMissing(), recovery.retryMissing()]);
  assert.deepEqual([...calls.values()], [2, 2, 2, 2]);
  assert.equal(applied.size, 4);
  await recovery.retryMissing();
  assert.deepEqual([...calls.values()], [2, 2, 2, 2]);
});

test('explicit reads recover after automatic visibility retries are exhausted', async () => {
  let now = 10_000;
  const calls = new Map();
  const applied = new Map();
  const recovery = createSnapshotMetadataRecovery({
    now: () => now,
    read: kind => {
      const attempt = (calls.get(kind) || 0) + 1;
      calls.set(kind, attempt);
      return attempt < 4 ? null : payload(kind);
    },
    onValue: (kind, value) => applied.set(kind, value),
  });

  await recovery.warm();
  now += 30_000;
  await recovery.retryMissing({ automatic: true });
  now += 30_000;
  await recovery.retryMissing({ automatic: true });
  now += 30_000;
  await recovery.retryMissing({ automatic: true });
  assert.deepEqual([...calls.values()], [3, 3, 3, 3], 'automatic retries stop at two per key');

  await recovery.retryMissing();
  assert.deepEqual([...calls.values()], [4, 4, 4, 4], 'an explicit wrapper read retries after cooldown');
  assert.equal(applied.size, 4);
});

test('retired generation replies cannot populate metadata or block current reads', async () => {
  const replies = [];
  const calls = [];
  const applied = new Map();
  const recovery = createSnapshotMetadataRecovery({
    read: kind => new Promise(resolve => { calls.push(kind); replies.push(resolve); }),
    onValue: (kind, value) => applied.set(kind, value),
  });

  const oldWarm = recovery.warm();
  await Promise.resolve();
  recovery.reset();
  const currentWarm = recovery.warm();
  await Promise.resolve();
  for (const kind of kinds) replies[kinds.indexOf(kind)](payload(kind));
  await oldWarm;
  assert.equal(applied.size, 0);
  for (const kind of kinds) replies[4 + kinds.indexOf(kind)](payload(kind));
  await currentWarm;
  assert.deepEqual([...applied.keys()].sort(), [...kinds].sort());
});


test('ensure shares pending identity work, respects failure cooldown and resets by generation',async()=>{
  let at=0,calls=0,resolve;
  const r=createSnapshotMetadataRecovery({onValue:()=>{},now:()=>at,read:()=>{calls++;return new Promise(done=>resolve=done);}});
  const a=r.ensure('racer-directory'),b=r.ensure('racer-directory');
  await Promise.resolve();assert.equal(calls,1);resolve(null);
  assert.equal(await a,false);assert.equal(await b,false);
  assert.equal(await r.ensure('racer-directory'),false);assert.equal(calls,1);
  at=30000;const c=r.ensure('racer-directory');await Promise.resolve();resolve({entries:{current:1}});
  assert.equal(await c,true);assert.equal(await r.ensure('racer-directory'),true);assert.equal(calls,2);
  r.reset();const d=r.ensure('racer-directory');await Promise.resolve();resolve({entries:{newer:1}});
  assert.equal(await d,true);assert.equal(calls,3);assert.equal(await r.ensure('not-metadata'),false);
});
