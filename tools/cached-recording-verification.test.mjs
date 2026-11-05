import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {createHash, webcrypto} from 'node:crypto';
import {pathToFileURL, fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const {preparePublicRecordingPlayback} = await import(pathToFileURL(root + 'tools/public-replay-playback.mjs'));
const bytes = fs.readFileSync(root + 'polytrack_062_patch.js');
const source = bytes.toString('utf8'), main = fs.readFileSync(root + 'main.bundle.js', 'utf8');
const hash = value => createHash('sha256').update(value).digest('hex');
console.log('Producer SHA256: ' + hash(bytes));
console.log('Native main SHA256: ' + hash(main));
function block(start, end) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const storeAndReader = block('  function readRecordingStore(ids){', '  function invalidateNativePartialReplay(');
const validator = block('  async function validateNativePartialReplay(', '  function installNativePartialReplayFallback(');
const originalSync = block('  function syncCachedRecordingVerification(entries){', '  function addLocalRaceRow(');
const proposedSync = originalSync;

function runtime() {
  const end = main.lastIndexOf('},n={};function i(e)');
  assert.ok(end > 0);
  const context = vm.createContext({console, TextEncoder, TextDecoder, Uint8Array, Uint16Array,
    Int32Array, ArrayBuffer, DataView, atob, btoa, setTimeout, clearTimeout});
  const factories = vm.runInContext('(' + main.slice(main.indexOf('t={') + 2, end + 1) + ')', context), cache = {};
  const require = id => {
    if (cache[id]) return cache[id].exports;
    const module = cache[id] = {exports: {}};
    factories[id](module, module.exports, require); return module.exports;
  };
  require.d = (exports, names) => { for (const key in names) Object.defineProperty(exports, key, {get: names[key]}); };
  require.o = (object, key) => Object.hasOwn(object, key);
  require.r = exports => Object.defineProperty(exports, '__esModule', {value: true});
  require.n = exports => { const getter = exports?.__esModule ? () => exports.default : () => exports; require.d(getter, {a: getter}); return getter; };
  require.g = context; require.p = ''; return require;
}
const require = runtime();
const input = new (require(1754).A)();
input.recordFrame(0, {up: true, right: false, down: false, left: false, reset: false});
const recording = input.serialize(), carStyle = require(8724).A.default().serialize();
const accountId = 'a'.repeat(64), trackId = 'b'.repeat(64), uploadId = 7, frames = 100;
const own = Object.freeze({accountId, trackId, uploadId, frames, raceTimeFrames: frames, timeMs: frames,
  replay: recording, replayHash: hash(recording), carStyle});
const verified = Object.freeze({...own, recording, runVerified: true, verified: true, integrityVerified: true, verifiedState: 1});
const opponent = Object.freeze({...verified, accountId: 'd'.repeat(64)});

function fixture({publicEntry = verified, publicPayload = verified, ownRow = own} = {}) {
  let disk = JSON.stringify({[uploadId]: {recording, frames, carStyle, verifiedState: 1}}), viewer = accountId;
  let releases = null, prepares = 0;
  const context = vm.createContext({console, URL, crypto: webcrypto, TextEncoder,
    RECORDING_STORE_KEY: 'fixture', currentTrackLoadState: {trackId}, nativePartialReplayRevision: 0,
    playbackWorkerBridgePromise: Promise.resolve(null),
    eventsModuleUrl: pathToFileURL(root + 'events/client.mjs').href,
    localStorage: {getItem: () => disk, setItem: (_key, value) => { disk = value; }},
    readJsonStorage: () => JSON.parse(disk),
    readLocalRaceRows: () => ownRow ? [ownRow] : [], activeRankedAccountId: () => viewer,
    cleanUserId: value => String(value || ''), safeRecordingId: value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null,
    normalizeReplayPayloadString: value => value,
    cleanCarId: value => value || null,
    safePositiveInt: (value, fallback) => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : fallback,
    __pt062NormalizeStyle: value => value, getDefaultCarStyle: () => carStyle,
    __pt062WebpackRequire: () => require,
    readPublicSnapshotBackup: async kind => kind === 'track' ? {entries: publicEntry ? [publicEntry] : []} : null,
    publicSnapshotReaderPromise: Promise.resolve({recordingPlayback: async entry => {
      prepares++; if (releases) await releases;
      return preparePublicRecordingPlayback(publicPayload, entry, {allowPending: true});
    }})
  });
  vm.runInContext(storeAndReader + validator + proposedSync + '\nthis.memory=nativeRecordingMemory;', context,
    {importModuleDynamically: vm.constants.USE_MAIN_CONTEXT_DEFAULT_LOADER});
  context.syncCachedRecordingVerification([{uploadId, runVerified: true}]);
  assert.equal(JSON.parse(disk)[uploadId].verifiedState, 0);
  const methodStart = main.indexOf('getRecordings(e){');
  const method = main.slice(methodStart, main.indexOf('submitLeaderboard(', methodStart));
  class XHR {
    static DONE = 4;
    open(_method, url) { this.ids = new URL(url).searchParams.get('ids').split(',').map(Number); }
    overrideMimeType() {}
    send() {
      context.readNativeRecordings(this.ids).then(rows => {
        this.readyState = 4; this.status = 200; this.responseText = JSON.stringify(rows); this.onreadystatechange();
      }, () => { this.readyState = 4; this.status = 500; this.onreadystatechange(); });
    }
  }
  const Native = new Function('R', 'Af', 'gf', 'Mo', 'ie', 'xt', 'Zt', 'XMLHttpRequest', 'return class {' + method + '}')(
    {gn: (_owner, field) => field === 'timeout' ? 5000 : ''}, 'base', 'timeout', {Ok: 0},
    require(1754), require(6146), require(8724), XHR);
  const native = new Native(); native.determinismState = 0;
  const selection = {recordingId: uploadId, nickname: 'Fixture', isSelf: !publicEntry || publicEntry.accountId === accountId};
  const binding = {trackId, accountId, revision: '0:0'};
  return {context, native, selection, binding, read: () => context.readNativeRecordings([uploadId]),
    validate: payload => context.validateNativePartialReplay(payload, selection, binding),
    disk: () => JSON.parse(disk)[uploadId], prepares: () => prepares,
    changeAccount: () => { viewer = 'c'.repeat(64); }, gate: promise => { releases = promise; }};
}

test('cleared persistent flag still yields verified public replay through exact reader and native parser', async () => {
  const f = fixture({publicEntry: opponent, publicPayload: opponent, ownRow: null});
  for (let pass = 0; pass < 2; pass++) {
    f.context.memory.clear();
    const [payload] = await f.read();
    assert.equal(payload.verifiedState, 1);
    assert.equal(await f.validate(payload), true);
    const [parsed] = await f.native.getRecordings([uploadId]);
    assert.equal(parsed.verifiedState, 1); assert.equal(parsed.time.numberOfFrames, frames);
    assert.equal(parsed.recording.serialize(), recording);
    assert.equal(f.disk().verifiedState, 0, 'public proof is not copied into the unbound persistent cache');
  }
  assert.ok(f.prepares() >= 4);
});

test('cleared own unpublished local PB remains playable at state zero with exact own binding', async () => {
  const f = fixture({publicEntry: null});
  const [payload] = await f.read();
  assert.equal(payload.verifiedState, 0); assert.equal(await f.validate(payload), true);
  const [parsed] = await f.native.getRecordings([uploadId]);
  assert.equal(parsed.verifiedState, 0); assert.equal(parsed.recording.serialize(), recording);
  assert.equal(parsed.carStyle.serialize(), carStyle); assert.equal(f.prepares(), 0);
});

for (const change of [{recording: 'corrupt'}, {frames: 101}, {accountId: 'd'.repeat(64)}, {verificationStatus: 'rejected'}]) {
  test('public binding failure cannot fall back to cleared own cache: ' + JSON.stringify(change), async () => {
    const f = fixture({publicPayload: {...verified, ...change}});
    assert.equal((await f.read())[0], null);
    assert.equal((await f.native.getRecordings([uploadId]))[0], null);
    assert.equal(f.disk().recording, recording); assert.equal(f.disk().verifiedState, 0);
  });
}

test('changed payload metadata is rejected even after successful public preparation', async () => {
  const f = fixture({publicEntry: opponent, publicPayload: opponent, ownRow: null}), [payload] = await f.read();
  for (const change of [{verifiedState: 0}, {frames: 101}, {carStyle: 'AAAA'}, {recording: 'corrupt'}]) {
    await assert.rejects(f.validate({...payload, ...change}), /changed/);
  }
});

test('local fallback does not bypass explicit self or current-account checks', async () => {
  const f = fixture({publicEntry: null}), [payload] = await f.read();
  assert.ok(payload); assert.equal(payload.verifiedState, 0);
  for (const change of [{frames: 101}, {carStyle: 'AAAA'}, {recording: 'corrupt'}, {verifiedState: 1}]) {
    await assert.rejects(f.validate({...payload, ...change}));
  }
  f.selection.isSelf = false;
  await assert.rejects(f.validate(payload), /exact public board binding/);
  f.selection.isSelf = true; f.changeAccount();
  await assert.rejects(f.validate(payload), /context changed/);
});

test('account switch while public revalidation awaits cannot authorize playback', async () => {
  const f = fixture(), [payload] = await f.read();
  let release; f.gate(new Promise(resolve => { release = resolve; }));
  const validation = f.validate(payload);
  f.changeAccount(); release();
  await assert.rejects(validation, /changed/);
});

test('payload mutation during public validation cannot authorize different frames', async () => {
  const f = fixture({publicEntry: opponent, publicPayload: opponent, ownRow: null}), [payload] = await f.read();
  const validation = f.validate(payload); payload.frames++;
  await assert.rejects(validation, /changed/);
});
