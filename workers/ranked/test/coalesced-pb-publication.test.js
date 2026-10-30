import test from 'node:test';
import assert from 'node:assert/strict';
import {enqueueCanonicalPublication, CANONICAL_PUBLICATION_JOB as JOB,
  CANONICAL_PUBLICATION_CAPACITY as CAP} from '../src/coalesced-pb-publication.js';

const track = 'a'.repeat(64), other = 'b'.repeat(64), id = 'racer_' + track;
const trackAt = index => index.toString(16).padStart(64, '0');
const response = changed => ({queued: true, changed, publicationPending: true});
function fixture(data, conflict) {
  let version = 1, saved = data == null ? null : structuredClone(data);
  const counts = {reads: 0, commits: 0, writes: 0}, batches = [];
  const read = async job => {
    assert.equal(job, JOB); counts.reads++;
    return saved === null ? null : {data: structuredClone(saved), updateTime: 'v' + version};
  };
  const commit = async (job, next, prior) => {
    assert.equal(job, JOB); counts.commits++;
    assert.equal(prior?.updateTime ?? null, saved === null ? null : 'v' + version);
    if (conflict) await conflict({counts, next, replace(value) {saved = structuredClone(value); version++;}});
    batches.push(next); saved = structuredClone(next); version++; counts.writes++;
  };
  return {counts, batches, args: {trackId: track, resultId: id, canonicalBindingKey: 'binding-v1', now: 123, read, commit}, saved: () => saved};
}

test('first enqueue stores identities; duplicate is one queue read and zero writes', async () => {
  const f = fixture();
  assert.deepEqual(await enqueueCanonicalPublication(f.args), response(true));
  assert.deepEqual(f.counts, {reads: 1, commits: 1, writes: 1});
  assert.deepEqual(f.saved().pendingTrackIds, [track]);
  assert.deepEqual(f.saved().pendingResultIds[track], [id]);
  assert.equal(Object.getPrototypeOf(f.batches[0].pendingResultIds), null);
  assert.equal(Object.getPrototypeOf(f.batches[0]), null);
  assert.deepEqual(await enqueueCanonicalPublication({...f.args, now: 456}), response(false));
  assert.deepEqual(f.counts, {reads: 2, commits: 1, writes: 1});
  assert.equal(f.saved().updatedAt, 123);
});

test('enqueue preserves cursors, builds, cooldowns and unrelated fields without mutating prior', async () => {
  const data = {cursorIngestedAt: '2026-10-29T00:00:00Z', cursorDocumentId: 'cursor',
    backfillComplete: true, backfillDocumentId: 'old', schemaVersion: 2, lastScanAt: 99,
    pendingTrackIds: [other], pendingFullRebuildTrackIds: [other], activeFullRebuildTrackId: other,
    pendingResultIds: {[other]: ['other_' + other]}, failedFullRebuilds: {[other]: {attempts: 2, retryAt: 999}},
    forceFullRebuildAll: false, marker: {proof: 'untouched'}};
  const before = structuredClone(data), f = fixture(data);
  await enqueueCanonicalPublication(f.args);
  for (const key of Object.keys(before).filter(key => !['pendingTrackIds', 'pendingResultIds'].includes(key)))
    assert.deepEqual(f.saved()[key], before[key], key);
  assert.deepEqual(f.saved().pendingResultIds[other], before.pendingResultIds[other]);
  assert.deepEqual(data, before);
});

test('pending full rebuild gets a binding fence once; active fixed-readTime build never falsely ACKs', async () => {
  for (const data of [{pendingFullRebuildTrackIds: [track]}, {pendingTrackIds: [track], forceFullRebuildAll: true}]) {
    const f = fixture(data);
    assert.deepEqual(await enqueueCanonicalPublication(f.args), response(true));
    assert.deepEqual(await enqueueCanonicalPublication(f.args), response(false));
    assert.equal(f.counts.writes, 1);
  }
  const f = fixture({pendingTrackIds: [track], pendingFullRebuildTrackIds: [track], activeFullRebuildTrackId: track});
  await assert.rejects(enqueueCanonicalPublication(f.args), /PUBLICATION_QUEUE_REBUILD_ACTIVE/);
  assert.equal(f.counts.writes, 0);
});

test('orphan result/full entries participate in union capacity and are preserved', async () => {
  const full = Array.from({length: CAP}, (_, i) => trackAt(i));
  const f = fixture({pendingFullRebuildTrackIds: full});
  await assert.rejects(enqueueCanonicalPublication(f.args), /PUBLICATION_QUEUE_CAPACITY/);
  assert.equal(f.counts.writes, 0);
  const g = fixture({pendingResultIds: {[other]: ['other_' + other]}});
  await enqueueCanonicalPublication(g.args);
  assert.deepEqual(g.saved().pendingTrackIds, [other, track]);
  assert.deepEqual(g.saved().pendingResultIds[other], ['other_' + other]);
});

test('capacity rejects new work without ACK but acknowledges already durable duplicates', async () => {
  const ids = Array.from({length: CAP}, (_, i) => 'r' + i + '_' + track);
  const f = fixture({pendingTrackIds: [track], pendingResultIds: {[track]: ids}, pendingResultBindings: {[ids[0]]: 'binding-v1'}});
  await assert.rejects(enqueueCanonicalPublication(f.args), /PUBLICATION_QUEUE_CAPACITY/);
  assert.equal(f.counts.writes, 0);
  assert.deepEqual(await enqueueCanonicalPublication({...f.args, resultId: ids[0]}), response(false));
  const g = fixture({pendingTrackIds: Array.from({length: CAP}, (_, i) => trackAt(i))});
  await assert.rejects(enqueueCanonicalPublication(g.args), /PUBLICATION_QUEUE_CAPACITY/);
  assert.equal(g.counts.writes, 0);
});

test('409/412 CAS conflict rereads and merges concurrent work, including a concurrent duplicate', async () => {
  for (const status of [409, 412]) {
    const f = fixture({}, ({counts, replace}) => {
      if (counts.commits === 1) {
        replace({pendingTrackIds: [other], pendingResultIds: {[other]: ['other_' + other]}, cursorDocumentId: 'new'});
        throw Error('FIRESTORE_' + status);
      }
    });
    assert.deepEqual(await enqueueCanonicalPublication(f.args), response(true));
    assert.deepEqual(f.counts, {reads: 2, commits: 2, writes: 1});
    assert.equal(f.saved().cursorDocumentId, 'new');
    assert.deepEqual(f.saved().pendingResultIds[other], ['other_' + other]);
  }
  const g = fixture({}, ({replace}) => {
    replace({pendingTrackIds: [track], pendingResultIds: {[track]: [id]}, pendingResultBindings: {[id]: 'binding-v1'}}); throw Error('FIRESTORE_412');
  });
  assert.deepEqual(await enqueueCanonicalPublication(g.args), response(false));
  assert.deepEqual(g.counts, {reads: 2, commits: 1, writes: 0});
});

test('CAS retry is bounded to three attempts; 429 and other failures are not retried', async () => {
  const f = fixture({}, () => {throw Error('FIRESTORE_412');});
  await assert.rejects(enqueueCanonicalPublication(f.args), /FIRESTORE_412/);
  assert.deepEqual(f.counts, {reads: 3, commits: 3, writes: 0});
  for (const error of [Error('FIRESTORE_429'), Error('FIRESTORE_500'),
    Error('FIRESTORE_412\n'), Object.assign(Error('FIRESTORE_412'), {status: '429'}),
    Object.assign(Error('FIRESTORE_412'), {code: 'RESOURCE_EXHAUSTED'}),
    Object.assign(Error('FIRESTORE_412'), {status: 429}), Object.assign(Error('FIRESTORE_409'), {code: 429})]) {
    const g = fixture({}, () => {throw error;});
    await assert.rejects(enqueueCanonicalPublication(g.args), caught => caught === error);
    assert.deepEqual(g.counts, {reads: 1, commits: 1, writes: 0});
  }
  let reads = 0;
  await assert.rejects(enqueueCanonicalPublication({...f.args, read: async () => {reads++; throw Error('FIRESTORE_429');}}), /FIRESTORE_429/);
  assert.equal(reads, 1);
});

test('input rejects coercible values, newline suffixes and prototype names before I/O', async () => {
  const f = fixture();
  for (const options of [undefined, null, [], 'invalid', 1])
    await assert.rejects(enqueueCanonicalPublication(options), /INPUT_INVALID/);
  for (const name of ['__proto__', 'constructor', 'toString', '__defineGetter__']) {
    await assert.rejects(enqueueCanonicalPublication({...f.args, trackId: name, resultId: 'racer_' + name}), /INPUT_INVALID/);
    await assert.rejects(enqueueCanonicalPublication({...f.args, resultId: name + '_' + track}), /INPUT_INVALID/);
  }
  for (const patch of [{trackId: track + '\n', resultId: id + '\n'}, {trackId: {toString: () => track}},
    {resultId: {endsWith: () => true, toString: () => id}}, {resultId: 'racer_' + other},
    {resultId: '.' + '_' + track}, {resultId: '..' + '_' + track}, {resultId: 'x'.repeat(129) + '_' + track},
    {now: -1}, {now: NaN}, {now: 1.5}, {read: null}, {commit: undefined}])
    await assert.rejects(enqueueCanonicalPublication({...f.args, ...patch}), /INPUT_INVALID/);
  assert.equal(f.counts.reads, 0);
});

test('malformed, sparse, inherited, over-capacity and unsafe existing state fails closed', async () => {
  const badStates = [{pendingTrackIds: null}, {pendingTrackIds: new Array(1)}, {pendingTrackIds: [track + '\n']},
    {activeFullRebuildTrackId: null}, {activeFullRebuildTrackId: 'constructor'},
    {pendingFullRebuildTrackIds: ['constructor']}, {pendingResultIds: []}, {pendingResultIds: null},
    {pendingResultIds: {[track]: [id + '\n']}}, {pendingResultIds: {[track]: new Array(1)}},
    {pendingResultIds: {[track]: ['other_' + other]}}, {pendingTrackIds: Array(CAP + 1).fill(track)},
    {pendingResultIds: {[track]: Array(CAP + 1).fill(id)}},
    {pendingResultIds: JSON.parse('{"__proto__":[]}')},
    {pendingTrackIds: Array.from({length: CAP}, (_, i) => trackAt(i)), pendingFullRebuildTrackIds: [track]}];
  for (const data of badStates) {
    const f = fixture(data);
    await assert.rejects(enqueueCanonicalPublication(f.args), /PUBLICATION_QUEUE_INVALID/);
    assert.equal(f.counts.writes, 0);
  }
  const f = fixture();
  for (const prior of [{data: Object.create({pendingTrackIds: [track]}), updateTime: 'v1'},
    {data: {pendingResultIds: Object.create({[track]: [id]})}, updateTime: 'v1'},
    {data: []}, {data: {}}, {data: {}, updateTime: ''}, {data: {}, updateTime: 1}])
    await assert.rejects(enqueueCanonicalPublication({...f.args, read: async () => prior}), /PUBLICATION_QUEUE_INVALID/);
  assert.equal(Object.prototype.polluted, undefined);
});

test('supports null-prototype input/state maps, maximum IDs and safe underscores in account IDs', async () => {
  const f = fixture({pendingResultIds: {}});
  for (const [trackId, accountId] of [['t'.repeat(80), 'r'.repeat(128)], [track, 'safe_account_with_underscores']]) {
    const options = Object.assign(Object.create(null), f.args, {trackId, resultId: accountId + '_' + trackId});
    assert.deepEqual(await enqueueCanonicalPublication(options), response(true));
  }
  const previous = Object.assign(Object.create(null), {pendingResultIds: Object.create(null)});
  const prior = Object.assign(Object.create(null), {data: previous, updateTime: 'v1'});
  let next;
  await enqueueCanonicalPublication({...f.args, read: async () => prior, commit: async (_id, value) => {next = value;}});
  assert.equal(Object.getPrototypeOf(next.pendingResultIds), null);
  assert.deepEqual(Object.keys(previous.pendingResultIds), []);
});

test('a CAS reread that discovers full capacity stops without losing concurrent work or ACKing', async () => {
  const ids = Array.from({length: CAP}, (_, i) => 'r' + i + '_' + track);
  const f = fixture({}, ({replace}) => {
    replace({pendingTrackIds: [track], pendingResultIds: {[track]: ids}, cursorDocumentId: 'new-cursor'});
    throw Error('FIRESTORE_412');
  });
  await assert.rejects(enqueueCanonicalPublication(f.args), /PUBLICATION_QUEUE_CAPACITY/);
  assert.deepEqual(f.counts, {reads: 2, commits: 1, writes: 0});
  assert.deepEqual(f.saved().pendingResultIds[track], ids);
  assert.equal(f.saved().cursorDocumentId, 'new-cursor');
});

test('inherited queue fields cannot fake durable coverage or erase newly enqueued work', async () => {
  const fields = {pendingTrackIds: [track], pendingResultIds: {[track]: [id]},
    pendingFullRebuildTrackIds: [track], forceFullRebuildAll: true, activeFullRebuildTrackId: track};
  const descriptors = new Map(Object.keys(fields).map(key => [key, Object.getOwnPropertyDescriptor(Object.prototype, key)]));
  try {
    for (const [key, value] of Object.entries(fields)) Object.defineProperty(Object.prototype, key,
      {value, configurable: true, writable: true});
    const f = fixture({});
    assert.deepEqual(await enqueueCanonicalPublication(f.args), response(true));
    assert.equal(f.counts.writes, 1);
    assert.equal(Object.hasOwn(f.batches[0], 'pendingTrackIds'), true);
    assert.deepEqual(f.saved().pendingResultIds[track], [id]);
  } finally {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else delete Object.prototype[key];
    }
  }
});
