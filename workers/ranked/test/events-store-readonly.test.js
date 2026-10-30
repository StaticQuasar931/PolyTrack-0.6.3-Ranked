import test from 'node:test';
import assert from 'node:assert/strict';
import {createEventFirestoreStore, eventEncode} from '../src/events-store.js';
import {EVENT_SERVER_TIMESTAMP} from '../src/events.js';

const projectId = 'polytrack-052';
const base = `projects/${projectId}/databases/(default)/documents/`;

function fixture({commit, rollback, retries = 2} = {}) {
  const calls = [], pauses = [], snapshots = new Map(), documents = new Map();
  let begins = 0;
  const request = async (route, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({route, body, method: init.method});
    if (route === ':beginTransaction') {
      assert.deepEqual(body, {options: {readWrite: {}}});
      const transaction = `snapshot/${++begins}+=`;
      snapshots.set(transaction, structuredClone(documents));
      return {transaction};
    }
    if (route === ':rollback') {
      assert(snapshots.has(body.transaction));
      return rollback ? rollback(body) : {};
    }
    if (route === ':commit') {
      assert(snapshots.has(body.transaction));
      assert(body.writes.length > 0, 'never send an empty commit');
      return commit ? commit(body) : {writeResults: body.writes.map(() => ({updateTime: 'committed'}))};
    }
    assert(route.startsWith('/'), 'unexpected transport route: ' + route);
    const [path, query] = route.split('?'), transaction = new URLSearchParams(query).get('transaction');
    assert(snapshots.has(transaction), 'reads must carry their own transaction token');
    const document = snapshots.get(transaction).get(decodeURIComponent(path.slice(1)));
    return document ? {updateTime: document.updateTime, fields: eventEncode(document.data).mapValue.fields} : null;
  };
  const store = createEventFirestoreStore({request, projectId, retries, pause: async ms => {pauses.push(ms);}});
  return {store, calls, pauses, documents, count: route => calls.filter(call => call.route === route).length,
    reads: () => calls.filter(call => call.route.startsWith('/'))};
}

test('seven-read idle transaction sends one rollback, zero commits and no retry', async () => {
  const f = fixture({commit: () => {throw Error('FIRESTORE_409');}});
  let callbacks = 0;
  const expected = {drained: false, writes: 0};
  const result = await f.store.transaction(async tx => {
    callbacks++;
    for (let i = 0; i < 7; i++) assert.equal(await tx.get('queue/item' + i), null);
    return expected;
  });
  assert.equal(result, expected); assert.equal(callbacks, 1);
  assert.equal(f.reads().length, 7); assert.equal(f.count(':beginTransaction'), 1);
  assert.equal(f.count(':commit'), 0); assert.equal(f.count(':rollback'), 1);
  assert.deepEqual(f.calls.at(-1).body, {transaction: 'snapshot/1+='});
  assert.deepEqual(f.pauses, []);
});

test('read-only result uses a consistent snapshot and clone-isolated cached reads', async () => {
  const f = fixture();
  f.documents.set('items/a', {data: {nested: {value: 1}}, updateTime: 'a-v1'});
  f.documents.set('items/b', {data: {value: 2}, updateTime: 'b-v1'});
  const result = await f.store.transaction(async tx => {
    const first = await tx.get('items/a'); first.nested.value = 99;
    f.documents.set('items/a', {data: {nested: {value: 10}}, updateTime: 'a-v2'});
    f.documents.set('items/b', {data: {value: 20}, updateTime: 'b-v2'});
    assert.equal(await tx.get('items/missing'), null);
    assert.equal(await tx.get('items/missing'), null);
    return {a: await tx.get('items/a'), b: await tx.get('items/b')};
  });
  assert.deepEqual(result, {a: {nested: {value: 1}}, b: {value: 2}});
  assert.equal(f.reads().length, 3); assert.equal(f.count(':commit'), 0); assert.equal(f.count(':rollback'), 1);
  for (const read of f.reads()) assert(read.route.endsWith('?transaction=snapshot%2F1%2B%3D'));
});

test('read-only completion is awaited and returns falsey or reference values unchanged', async () => {
  for (const expected of [undefined, null, false, 0, '', {complete: true}]) {
    let release;
    const f = fixture({rollback: () => new Promise(resolve => {release = resolve;})});
    let settled = false;
    const transaction = f.store.transaction(async () => expected).finally(() => {settled = true;});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.count(':rollback'), 1); assert.equal(f.count(':commit'), 0); assert.equal(settled, false);
    release({});
    assert.equal(await transaction, expected); assert.equal(settled, true);
  }
});

for (const error of [Error('FIRESTORE_429'), Error('FIRESTORE_409'), Error('FIRESTORE_412'),
  Object.assign(Error('aborted cleanup'), {code: 'ABORTED'}), Error('rollback transport failed')])
  test(`read-only ${error.message} rollback fails closed exactly once without retry`, async () => {
    const f = fixture({rollback: () => {throw error;}});
    let callbacks = 0;
    await assert.rejects(f.store.transaction(async tx => {callbacks++; await tx.get('items/a'); return 'not acknowledged';}),
      caught => caught === error);
    assert.equal(callbacks, 1); assert.equal(f.count(':beginTransaction'), 1);
    assert.equal(f.count(':rollback'), 1); assert.equal(f.count(':commit'), 0);
    assert.equal(f.reads().length, 1); assert.deepEqual(f.pauses, []);
  });

test('nonempty patch, set, create and delete preserve transactional CAS commit payloads', async () => {
  const f = fixture(), timestamp = '2026-10-30T00:00:00.123456789Z';
  for (const id of ['patched', 'replaced', 'removed']) f.documents.set('items/' + id,
    {data: {old: true}, updateTime: timestamp});
  const expected = {published: true};
  assert.equal(await f.store.transaction(async tx => {
    for (const id of ['patched', 'replaced', 'removed']) await tx.get('items/' + id);
    tx.patch('items/patched', {value: 2, updatedAt: EVENT_SERVER_TIMESTAMP});
    tx.set('items/replaced', {value: 3}); tx.create('items/created', {value: 4}); tx.delete('items/removed');
    return expected;
  }), expected);
  assert.equal(f.count(':commit'), 1); assert.equal(f.count(':rollback'), 0);
  const commit = f.calls.find(call => call.route === ':commit');
  assert.equal(commit.method, 'POST'); assert.equal(commit.body.transaction, 'snapshot/1+=');
  assert.deepEqual(commit.body.writes, [
    {update: {name: base + 'items/patched', fields: {value: {integerValue: '2'}}}, currentDocument: {updateTime: timestamp},
      updateMask: {fieldPaths: ['value']}, updateTransforms: [{fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME'}]},
    {update: {name: base + 'items/replaced', fields: {value: {integerValue: '3'}}}, currentDocument: {updateTime: timestamp}},
    {update: {name: base + 'items/created', fields: {value: {integerValue: '4'}}}, currentDocument: {exists: false}},
    {delete: base + 'items/removed', currentDocument: {updateTime: timestamp}}
  ]);
});

test('a write conflict retries with fresh transaction reads and fresh CAS, not an empty commit', async () => {
  let commits = 0;
  const f = fixture({commit: () => {
    if (++commits === 1) {
      f.documents.set('items/a', {data: {value: 10}, updateTime: 'a-v2'}); throw Error('FIRESTORE_412');
    }
    return {writeResults: [{updateTime: 'a-v3'}]};
  }});
  f.documents.set('items/a', {data: {value: 1}, updateTime: 'a-v1'});
  let callbacks = 0;
  const result = await f.store.transaction(async tx => {
    callbacks++; const value = (await tx.get('items/a')).value + 1;
    tx.set('items/a', {value}); return value;
  });
  assert.equal(result, 11); assert.equal(callbacks, 2);
  assert.equal(f.count(':beginTransaction'), 2); assert.equal(f.count(':commit'), 2); assert.equal(f.count(':rollback'), 1);
  const attempts = f.calls.filter(call => call.route === ':commit').map(call => call.body);
  assert.deepEqual(attempts.map(body => body.transaction), ['snapshot/1+=', 'snapshot/2+=']);
  assert.deepEqual(attempts.map(body => body.writes[0].currentDocument), [{updateTime: 'a-v1'}, {updateTime: 'a-v2'}]);
  assert.deepEqual(f.pauses, [25]);
});

test('exhausted write conflicts remain bounded and never fall back to nontransactional writes', async () => {
  const error = Error('FIRESTORE_409'), f = fixture({commit: () => {throw error;}});
  await assert.rejects(f.store.transaction(async tx => {await tx.get('items/a'); tx.set('items/a', {value: 1});}),
    caught => caught === error);
  assert.equal(f.count(':beginTransaction'), 3); assert.equal(f.count(':commit'), 3); assert.equal(f.count(':rollback'), 3);
  assert.deepEqual(f.pauses, [25, 50]);
});

test('nonempty write quota error preserves the original failure and does not retry', async () => {
  const error = Error('FIRESTORE_429'), f = fixture({commit: () => {throw error;}});
  await assert.rejects(f.store.transaction(async tx => {await tx.get('items/a'); tx.set('items/a', {value: 1});}),
    caught => caught === error);
  assert.equal(f.count(':beginTransaction'), 1); assert.equal(f.count(':commit'), 1); assert.equal(f.count(':rollback'), 1);
  assert.deepEqual(f.pauses, []);
});

test('callback failures retain existing single-cleanup and original-error behavior', async () => {
  const error = Error('callback rejected');
  for (const rollback of [undefined, () => {throw Error('cleanup failed');}]) {
    const f = fixture({rollback});
    await assert.rejects(f.store.transaction(async tx => {await tx.get('items/a'); throw error;}), caught => caught === error);
    assert.equal(f.count(':beginTransaction'), 1); assert.equal(f.count(':commit'), 0); assert.equal(f.count(':rollback'), 1);
    assert.deepEqual(f.pauses, []);
  }
});
