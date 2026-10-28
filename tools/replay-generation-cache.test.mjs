import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(process.env.POLYTRACK_REPLAY_TEST_SOURCE || new URL('../polytrack_062_patch.js', import.meta.url), 'utf8');
const start = source.indexOf('  function cachedNativeRecording(');
const end = source.indexOf('  async function repairOwnNativeRecording(', start);
assert.ok(start >= 0 && end > start, 'production native recording cache functions must exist');

function generationCallback() {
  const owner = source.indexOf('  async function readPublicSnapshotBackup(');
  const match = /onGenerationChange\s*:\s*\(\)\s*=>\s*\{/.exec(source.slice(owner));
  assert.ok(owner >= 0 && match, 'production snapshot generation callback must exist');
  const open = owner + match.index + match[0].length - 1;
  let depth = 0, quote = null, comment = null;
  for (let i = open; i < source.length; i++) {
    const ch = source[i], next = source[i + 1];
    if (comment === 'line') { if (ch === '\n') comment = null; continue; }
    if (comment === 'block') { if (ch === '*' && next === '/') { comment = null; i++; } continue; }
    if (quote) { if (ch === '\\') i++; else if (ch === quote) quote = null; continue; }
    if (ch === '/' && next === '/') { comment = 'line'; i++; continue; }
    if (ch === '/' && next === '*') { comment = 'block'; i++; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    if (ch === '}' && --depth === 0) return source.slice(open, i + 1);
  }
  assert.fail('production generation callback must have a complete body');
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}

const accountId = 'a'.repeat(64), trackId = 'b'.repeat(64), uploadId = 12;
const pendingEntry = Object.freeze({accountId, trackId, uploadId, frames:5000, timeMs:5000,
  replayHash:'c'.repeat(64), runVerified:false, verified:false, integrityVerified:true, verifiedState:0});
const row = (verified, recording = verified ? 'verified-payload' : 'pending-payload') => ({
  recording, frames:5000, carStyle:'default', verifiedState:verified ? 1 : 0,
  playbackPending:!verified, verificationStatus:verified ? 'verified' : 'pending'
});

function harness({read = async () => null, playback = async () => row(false)} = {}) {
  const calls = [];
  const context = {
    currentTrackLoadState:{trackId},
    nativePartialReplayRevision:0, nativePartialReplaySelection:null,
    playbackWorkerBridgePromise:Promise.resolve(null),
    invalidateEventSnapshotCaches() {}, publicSnapshotPublishedAt:0,
    readRecordingStore:ids => ids.map(() => null),
    normalizeReplayPayloadString:value => value,
    safePositiveInt:(value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback,
    __pt062NormalizeStyle:value => value,
    getDefaultCarStyle:() => 'default',
    readPublicSnapshotBackup:async (kind, id) => { calls.push({kind, id}); return read(kind, id); },
    publicSnapshotReaderPromise:Promise.resolve({recordingPlayback:playback}),
    metadataRecovery:{reset() {}, warm() {}},
    snapshotTrackStatistics:{}, snapshotCosmeticEntries:{}, snapshotRacerDirectoryEntries:{}, publicSnapshotCapturedAt:0,
    profileSnapshotEpoch:0, profileSnapshotResults:new Map(), profileSnapshotRequests:new Map(),
    profileSnapshotRetryAt:new Map(), profilePlacementRequests:new Map(), profileGuideCache:new Map(),
    cosmeticEpoch:0, overallCacheGeneration:0,
    queueMicrotask:callback => callback(), document:{getElementById:() => null},
    isElementVisible:() => false
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end) + `
    globalThis.cache = {memory:nativeRecordingMemory, requests:nativeRecordingRequests,
      retryAt:nativeRecordingRetryAt, epoch:() => nativeRecordingEpoch,
      read:readNativeRecordings, remember:rememberNativeRecording};`, context);
  // Execute the actual generation callback, not a test-written copy of its reset logic.
  const change = vm.runInContext('(() => ' + generationCallback() + ')', context);
  return {cache:context.cache, change, calls};
}

test('actual generation callback increments replay epoch and clears all three caches', () => {
  const h = harness();
  h.cache.remember(uploadId, row(false));
  h.cache.requests.set(uploadId, Promise.resolve(row(false)));
  h.cache.retryAt.set(uploadId, 123456);
  const before = h.cache.epoch();
  h.change();
  assert.equal(h.cache.epoch(), before + 1);
  assert.equal(h.cache.memory.size, 0);
  assert.equal(h.cache.requests.size, 0);
  assert.equal(h.cache.retryAt.size, 0);
});

test('generation refresh promotes cached pending playback to the new verified status', async () => {
  let verified = false;
  const h = harness({read:async kind => kind === 'recording' ? verified ? row(true) : null : verified ? null : {entries:[pendingEntry]}});
  const first = (await h.cache.read([uploadId]))[0];
  assert.equal(first.verifiedState, 0);
  assert.equal(first.playbackPending, true);
  const before = h.calls.length;
  assert.equal((await h.cache.read([uploadId]))[0].verifiedState, 0);
  assert.equal(h.calls.length, before, 'same-generation cache hit adds no public reads');
  verified = true;
  h.change();
  const fresh = (await h.cache.read([uploadId]))[0];
  assert.equal(fresh.verifiedState, 1);
  assert.equal(fresh.playbackPending, false);
  assert.equal(fresh.verificationStatus, 'verified');
  assert.equal(h.calls.length, before + 2);
  assert.equal(pendingEntry.runVerified, false, 'published entry flags are not promoted or mutated');
  assert.equal(pendingEntry.verifiedState, 0);
});

test('retired direct response returns null and cannot remove a newer in-flight request', async () => {
  const oldGate = deferred(), freshGate = deferred();
  let reads = 0;
  const h = harness({read:kind => {
    if (kind === 'track') return null;
    assert.equal(kind, 'recording');
    return ++reads === 1 ? oldGate.promise : freshGate.promise;
  }});
  const old = h.cache.read([uploadId]);
  h.change();
  const fresh = h.cache.read([uploadId]);
  const currentRequest = h.cache.requests.get(uploadId);
  oldGate.resolve(row(true, 'retired-payload'));
  assert.deepEqual(Array.from(await old), [null]);
  assert.equal(h.cache.memory.has(uploadId), false);
  assert.equal(h.cache.retryAt.has(uploadId), false, 'retired replies do not add cooldowns');
  assert.equal(h.cache.requests.get(uploadId), currentRequest, 'old finally cannot delete a current request');
  freshGate.resolve(row(true, 'current-payload'));
  assert.equal((await fresh)[0].recording, 'current-payload');
  assert.equal(h.cache.memory.get(uploadId).recording, 'current-payload');
  assert.equal(h.cache.requests.size, 0);
});

test('retired pending playback cannot overwrite a newer verified cache entry', async () => {
  const entered = deferred(), oldPlayback = deferred();
  let verified = false;
  const h = harness({
    read:async kind => kind === 'recording' ? verified ? row(true, 'current-verified') : null : verified ? null : {entries:[pendingEntry]},
    playback:async (entry, options) => {
      assert.equal(entry, pendingEntry);
      assert.equal(options.allowPending, true);
      entered.resolve();
      return oldPlayback.promise;
    }
  });
  const old = h.cache.read([uploadId]);
  await entered.promise;
  verified = true;
  h.change();
  assert.equal((await h.cache.read([uploadId]))[0].verifiedState, 1);
  oldPlayback.resolve(row(false, 'retired-pending'));
  assert.deepEqual(Array.from(await old), [null]);
  assert.equal(h.cache.memory.get(uploadId).recording, 'current-verified');
  assert.equal(h.cache.memory.get(uploadId).verifiedState, 1);
  assert.equal(h.cache.memory.get(uploadId).playbackPending, false);
  assert.equal(h.cache.requests.size, 0);
  assert.equal(h.cache.retryAt.size, 0);
});
