const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createHash} = require('node:crypto');

const source = fs.readFileSync(path.join(__dirname, '../polytrack_062_patch.js'), 'utf8');
const accountId = 'a'.repeat(64), trackId = 'b'.repeat(64);
const sha = value => createHash('sha256').update(value).digest('hex');
const pb = (extra = {}) => ({accountId, trackId, ownerUid: 'uid', timeMs: 1000, frames: 1000,
  replay: 'local-replay', replayHash: sha('local-replay'), uploadId: 7, name: 'Racer', ...extra});
const signature = row => JSON.stringify([String(row.trackId || ''), Number(row.timeMs || 0), String(row.replayHash || '')]);
const plain = value => JSON.parse(JSON.stringify(value));
function section(start, end) {
  const first = source.indexOf(start), last = source.indexOf(end, first);
  assert(first > 0 && last > first, start);
  return source.slice(first, last);
}

function common(rows = []) {
  let now = 1000000, uid = 'uid', timerId = 0;
  const storage = new Map(), timers = new Map(), listeners = new Map();
  const context = {
    Date: {now: () => now}, Map, Set, Math, JSON, Array, String, Number, Error,
    LOCAL_PB_RECONCILE_STATE_KEY: 'state', FIREBASE_QUOTA_PAUSE_KEY: 'quota', OVERALL_PB_DIRTY_KEY: 'dirty',
    COLLECTIONS: {raceResults: 'races', profilesPublic: 'profiles'},
    localPbReconcilePromises: new Map(), localPbReconcileTimers: new Map(),
    cleanUserId: value => String(value || ''), activeRankedAccountId: () => accountId,
    isCurrentLocalPbReconcileIdentity: (id, owner) => id === accountId && (!owner || owner === uid),
    readLocalRaceRows: () => rows, localBestRowsForAccount: id => rows.filter(row => row.accountId === id),
    canonicalRaceTimeMs: row => Number(row?.timeMs || 0), localPbSyncSignature: signature,
    readJsonStorage: (key, fallback) => storage.has(key) ? plain(storage.get(key)) : fallback,
    writeJsonStorage: (key, value) => {storage.set(key, plain(value)); return true;},
    firebaseQuotaPaused: () => false, noteFirebaseQuota: () => {}, log: () => {},
    setTimeout: (fn, delay) => {const id = ++timerId; timers.set(id, {fn, delay}); return id;}, clearTimeout: id => timers.delete(id),
    window: {addEventListener: (name, fn) => listeners.set(name, fn), firebase: {
      auth: () => ({currentUser: {uid}}), firestore: {FieldValue: {serverTimestamp: () => 'server-time'}}}},
    document: {addEventListener: (name, fn) => listeners.set(name, fn), visibilityState: 'visible'},
    navigator: {onLine: true}, compatibilityOnlineAllowed: true,
    cloudOwnerConflicts: new Map(), showCloudOwnerConflict: () => {}, assertCloudOwner: () => {},
    readRecordingStore: () => [], safeRecordingId: value => Number(value) > 0 ? Number(value) : null,
    normalizeReplayPayloadString: value => String(value || ''), safePositiveInt: value => Number(value) || 1,
    getLastKnownName: () => 'Racer', getDefaultCarStyle: () => 'style', overallLoadState: {},
    addLocalRaceRow: row => {
      const index = rows.findIndex(old => old.accountId === row.accountId && old.trackId === row.trackId);
      if (index < 0) rows.push(row); else if (rows[index].timeMs >= row.timeMs) rows[index] = row;
      return true;
    }
  };
  return {context, rows, storage, timers, listeners, advance: ms => {now += ms;}, owner: value => {uid = value;}};
}

function mirrorHarness({cloud = null, publicationFails = true, localWritable = true, transactionFails = false, retryCloud} = {}) {
  const h = common(), c = h.context, disk = new Map(), writes = [];
  let scheduled = 0, quotaErrors = 0;
  const database = {collection: kind => ({doc: id => ({kind, id})})};
  Object.assign(c, {
    parsePayload: value => value, accountIdFromPayload: async value => value.accountId || accountId, guestAccountId: accountId,
    LAST_ACTIVE_NAME_KEY: 'last-name', localStorage: {getItem: key => disk.get(key) || null, setItem: (key, value) => disk.set(key, value)},
    sanitizeDisplayName: value => value, enforceSafeDisplayName: async value => value, setLastKnownName: () => {},
    invalidateNativePartialReplayAccount: () => {}, __pt062NormalizeStyle: value => value, __pt062RememberStyle: () => {},
    sha256Hex: async value => sha(value), currentPlaytimeMs: () => 0, deploymentSourceOrigin: () => 'fixture',
    lastMirrorSig: '', lastMirrorAt: 0, nextUploadId: () => 7, readTrackSnapshotCache: () => null,
    localPersonalBestMs: () => 0, recordDailyActivity: () => ({shouldCloudSync: false}), writeRecordingStore: () => {},
    db: async () => database, resolveManualNameOverride: async (db, id, name) => name, readOverallSnapshotCache: () => null,
    claimCloudProfileName: async (db, tx, id, uid, profile, name) => name, legacyNameTransactions: new WeakSet(),
    confirmedRecordingUploads: new Map(), showPublicNameAdjustment: () => {}, safeDisplayName: value => value,
    saveClaimedPublicProfile: async (db, id, uid, profile) => profile.name, syncDailyActivity: async () => {},
    sendRankedNotification: async () => {if (publicationFails) throw Error('publication unavailable'); return {accepted: true};},
    syncExactCarPreview: async () => {}, retainTrackSnapshotAfterLocalPb: () => {}, opponentShortcutBoard: () => null,
    opponentShortcutStatus: () => {}, scheduleLocalPbCloudReconcile: () => {scheduled++;}, noteFirebaseQuota: () => {quotaErrors++;},
    runFirebaseTransaction: async (db, callback) => {
      if (transactionFails) throw Error('transaction unavailable');
      const run = async current => {
        const staged = [];
        await callback({get: async ref => ref.kind === 'races' ? {exists: !!current, data: () => current} : {exists: false, data: () => ({})},
          set: (ref, value) => staged.push({ref, value})});
        return staged;
      };
      if (retryCloud !== undefined) await run(null);
      writes.push(...await run(retryCloud === undefined ? cloud : retryCloud));
    }
  });
  if (!localWritable) c.addLocalRaceRow = () => false;
  vm.createContext(c);
  vm.runInContext(section('  function localPbSyncSignature(row){', '  function scheduleLocalPbCloudReconcile('), c);
  vm.runInContext(section('  async function mirrorRaceResult(', '  function localBestRowsForAccount('), c);
  h.run = () => c.mirrorRaceResult('fixture', {accountId, trackId, timeMs: 1000, frames: 1000, recording: 'local-replay', nickname: 'Racer', carStyle: 'style'});
  h.writes = writes; h.scheduled = () => scheduled; h.quotaErrors = () => quotaErrors;
  return h;
}

function reconcileHarness({rows = [pb()], cloud = pb(), readDoc} = {}) {
  const h = common(rows), c = h.context;
  let reads = 0, databases = 0;
  c.db = async () => {databases++; return {collection: () => ({doc: id => ({get: async () => {
    reads++; return readDoc ? readDoc(id) : {exists: !!cloud, metadata: {fromCache: false}, data: () => cloud};
  }})})};};
  c.mirrorRaceResult = async (url, value) => {c.rememberConfirmedLocalPb(accountId, value); return {saved: true};};
  vm.createContext(c);
  vm.runInContext(section('  function localPbSyncSignature(row){', '  function hookLegacyNetworking(){'), c);
  h.run = () => c.reconcileLocalPersonalBestsToCloud(accountId);
  h.reads = () => reads; h.databases = () => databases;
  return h;
}

test('a committed exact PB stays confirmed when publication fails, without retrying canonical saving', async () => {
  const h = mirrorHarness(), result = await h.run();
  assert.equal(result.saved, true); assert.equal(result.cloudConfirmed, true);
  assert.equal(result.canonicalConflict, false); assert.equal(result.publicationPending, true);
  assert.equal(h.writes.filter(row => row.ref.kind === 'races').length, 1);
  assert.equal(h.scheduled(), 0); assert.equal(h.quotaErrors(), 0);
});

test('an existing exact canonical binding is confirmed without claiming a new write', async () => {
  const h = mirrorHarness({cloud: pb({uploadId: 42})}), result = await h.run();
  assert.equal(result.saved, false); assert.equal(result.cloudConfirmed, true); assert.equal(result.uploadId, 42);
  assert.equal(h.writes.length, 0);
});

for (const publicationFails of [false, true]) test('equal time with different canonical replay is local, publicationFails=' + publicationFails, async () => {
  const cloud = pb({replayHash: sha('other-replay'), replay: 'other-replay', uploadId: 42});
  const h = mirrorHarness({cloud, publicationFails}), result = await h.run();
  assert.equal(result.saved, false); assert.equal(result.cloudConfirmed, false); assert.equal(result.canonicalConflict, true);
  assert.equal(result.localSaved, true); assert.equal(result.uploadId, 7, 'do not bind the local run to another recording');
  const state = h.storage.get('state')[accountId];
  assert.notEqual(state.confirmed[trackId], signature(pb()));
  assert.equal(state.canonicalConflicts[trackId].signature, signature(pb()));
  assert.equal(h.scheduled(), 0);
});

test('a faster existing canonical result does not confirm the slower submitted replay after follow-up failure', async () => {
  const h = mirrorHarness({cloud: pb({timeMs: 900, frames: 900, uploadId: 42})}), result = await h.run();
  assert.equal(result.saved, false); assert.equal(result.cloudConfirmed, false); assert.equal(result.uploadId, 7);
  assert.notEqual(h.storage.get('state')[accountId].confirmed[trackId], signature(pb()));
});

test('canonical account, track and nonempty SHA-256 must all match before claiming confirmation', async () => {
  for (const change of [{accountId: 'c'.repeat(64)}, {trackId: 'c'.repeat(64)}, {replayHash: ''}, {replayHash: undefined}]) {
    const h = mirrorHarness({cloud: pb(change)}), result = await h.run();
    assert.equal(result.cloudConfirmed, false, JSON.stringify(change));
    assert.notEqual(h.storage.get('state')[accountId].confirmed?.[trackId], signature(pb()));
  }
});

test('the final transaction retry, not a discarded earlier write, determines exact confirmation', async () => {
  const h = mirrorHarness({retryCloud: pb({replayHash: sha('other')})}), result = await h.run();
  assert.equal(result.saved, false); assert.equal(result.cloudConfirmed, false);
  assert.equal(h.writes.length, 0);
});

test('failed local and canonical writes never claim localSaved or cloudConfirmed', async () => {
  const h = mirrorHarness({localWritable: false, transactionFails: true}), result = await h.run();
  assert.equal(result.saved, false); assert.equal(result.localSaved, false); assert.notEqual(result.cloudConfirmed, true);
});

test('equal-time exact reconciliation confirms the actual server binding once', async () => {
  const h = reconcileHarness(), result = await h.run();
  assert.equal(result.failed, 0); assert.equal(result.superseded, 0);
  assert.equal(h.storage.get('state')[accountId].confirmed[trackId], signature(pb()));
  assert.equal(h.context.localPbCloudConfirmed(pb(), accountId), true);
  await h.run(); assert.equal(h.reads(), 1);
});

test('an equal-time replay conflict becomes dormant with no confirmation, repeated reads or retry timers', async () => {
  const h = reconcileHarness({cloud: pb({replayHash: sha('other')})}), first = await h.run();
  assert.equal(first.superseded, 1); assert.equal(first.failed, 0); assert.equal(first.remaining, 0);
  assert.equal(h.context.localPbCloudConfirmed(pb(), accountId), false);
  assert.equal(h.timers.size, 0);
  for (let index = 0; index < 8; index++) {h.advance(3600000); await h.run();}
  assert.equal(h.reads(), 1); assert.equal(h.databases(), 1); assert.equal(h.timers.size, 0);
});

test('changing the local replay signature reopens only that dormant conflict immediately', async () => {
  const cloud = pb({replayHash: sha('other')}), rows = [pb()], h = reconcileHarness({rows, cloud});
  await h.run(); rows[0].replayHash = cloud.replayHash; rows[0].replay = 'other';
  const result = await h.run();
  assert.equal(h.reads(), 2); assert.equal(result.failed, 0);
  assert.equal(h.context.localPbCloudConfirmed(rows[0], accountId), true);
  assert.deepEqual(h.storage.get('state')[accountId].canonicalConflicts, {});
});

test('changing owner identity invalidates a conflict marker rather than suppressing the new session', async () => {
  const cloud = pb({replayHash: sha('other')}), h = reconcileHarness({cloud});
  await h.run(); h.owner('next-owner'); cloud.ownerUid = 'next-owner'; cloud.replayHash = pb().replayHash;
  await h.run(); assert.equal(h.reads(), 2);
  assert.equal(h.context.localPbCloudConfirmed(pb(), accountId), true);
});

test('missing hash and equal-time identity mismatches are never mistaken for exact confirmation', async () => {
  for (const change of [{replayHash: ''}, {accountId: 'c'.repeat(64)}, {trackId: 'c'.repeat(64)}]) {
    const h = reconcileHarness({cloud: pb(change)}), result = await h.run();
    assert.equal(result.superseded, 1);
    assert.equal(h.context.localPbCloudConfirmed(pb(), accountId), false);
    await h.run(); assert.equal(h.reads(), 1);
  }
});

test('dormant conflicts are pruned to current bindings and preserve unrelated state fields', async () => {
  const h = reconcileHarness({cloud: pb({replayHash: sha('other')})});
  await h.run(); const state = h.storage.get('state');
  state[accountId].privateExistingField = {keep: true}; state['other-account'] = {keep: true};
  for (let index = 0; index < 700; index++) state[accountId].canonicalConflicts['stale-' + index] =
    {signature: 'stale', ownerUid: 'uid', status: 'canonical-conflict'};
  h.storage.set('state', state); await h.run();
  const next = h.storage.get('state');
  assert.equal(Object.keys(next[accountId].canonicalConflicts).length, 1);
  assert.deepEqual(next[accountId].privateExistingField, {keep: true});
  assert.deepEqual(next['other-account'], {keep: true}); assert.equal(h.reads(), 1);
});

test('one terminal replay conflict does not block another PB from being saved', async () => {
  const second = pb({trackId: 'd'.repeat(64)});
  const h = reconcileHarness({rows: [pb(), second], readDoc: async id => id.endsWith(trackId)
    ? {exists: true, metadata: {fromCache: false}, data: () => pb({replayHash: sha('other')})}
    : {exists: false, metadata: {fromCache: false}}});
  const result = await h.run();
  assert.equal(result.superseded, 1); assert.equal(result.uploaded, 1); assert.equal(result.failed, 0);
  assert.equal(h.context.localPbCloudConfirmed(second, accountId), true);
  assert.equal(h.timers.size, 0);
});

test('a cached response cannot establish even an otherwise exact canonical receipt', async () => {
  const h = reconcileHarness({readDoc: async () => ({exists: true, metadata: {fromCache: true}, data: () => pb()})});
  const result = await h.run();
  assert.equal(result.failed, 1); assert.equal(h.context.localPbCloudConfirmed(pb(), accountId), false);
});
