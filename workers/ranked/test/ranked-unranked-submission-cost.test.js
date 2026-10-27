import assert from 'node:assert/strict';
import test from 'node:test';
import {handleRequest} from '../src/index.js';
import {eventEncode as encode, eventDecode as decode} from '../src/events-store.js';

const trackId = '586fbb2ef6e638f8d22e050342896497f22da6302ff081e434aa17bf6f75cf87';
const origin = 'https://audit.invalid';
const accountId = 'f'.repeat(64);
const entries = () => Array.from({length: 500}, (_, i) => ({
  accountId: (i + 1).toString(16).padStart(64, '0'), name: 'Racer',
  timeMs: 10000 + i, frames: 10000 + i, runVerified: false, integrityVerified: false, unranked: true
}));

function fixture({racer = accountId, count = 500, conflict = false} = {}) {
  let board = {trackId, entries: entries().slice(0, count), total: count, updatedAt: 1};
  let writes = 0, attempts = 0;
  const calls = [];
  const env = {ALLOWED_ORIGINS: origin, PB_NOTIFY_RATE_LIMITER: {limit: async () => ({success:true})}, __TEST_UID: 'owner', __TEST_FIRESTORE: async (path, init = {}) => {
    calls.push(path);
    if (path === ':commit') {
      attempts++;
      const batch = JSON.parse(init.body).writes;
      assert.equal(batch.length, 1);
      assert.ok(batch[0].update.name.endsWith('/0.6.2_extra_unranked_leaderboards/' + trackId));
      assert.deepEqual(batch[0].currentDocument, {updateTime: `board-v${writes}`});
      if (conflict && attempts === 1) {
        board = {...board, entries: entries().map(row => ({...row, timeMs: 9000, frames: 9000})), total: 500};
        throw Error('FIRESTORE_409');
      }
      board = decode({mapValue: {fields: batch[0].update.fields}});
      writes++;
      return {};
    }
    if (path === '/0.6.2_profiles_public/' + racer) return {
      fields: encode({accountId: racer, ownerUid: 'owner', nickname: 'Runner'}).mapValue.fields};
    if (path === '/0.6.2_extra_unranked_leaderboards/' + trackId) return {
      fields: encode(board).mapValue.fields, updateTime: `board-v${writes}`};
    assert.fail(`unexpected Firestore request ${path}`);
  }};
  const send = timeMs => handleRequest(new Request(origin + '/v1/extra-tracks/unranked', {
    method: 'POST', headers: {Origin: origin, 'Content-Type': 'application/json'},
    body: JSON.stringify({trackId, accountId: racer, timeMs, frames: timeMs, recording: 'A'.repeat(20), uploadId: 1})
  }), env);
  return {send, calls, board: () => board, writes: () => writes, attempts: () => attempts};
}

test('repeated below-cutoff unranked submissions do not rewrite 500 rows or inflate total', async () => {
  const f = fixture(), original = structuredClone(f.board());
  for (let i = 0; i < 3; i++) {
    const response = await f.send(20000);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {accepted: true, improved: false, rank: 0});
  }
  assert.equal(f.writes(), 0);
  assert.deepEqual(f.board(), original);
  assert.equal(f.calls.length, 6, 'only owner profile and board reads per submission');
});

test('cutoff ties use the existing account ordering without no-op writes', async () => {
  const excluded = fixture();
  assert.equal((await excluded.send(10499)).status, 200);
  assert.equal(excluded.writes(), 0);
  const included = fixture({racer: '0'.repeat(64)});
  const response = await included.send(10499);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).rank, 500);
  assert.equal(included.writes(), 1);
  assert.equal(included.board().entries.length, 500);
});

test('qualifying unranked improvements still publish once and remain unverified', async () => {
  const f = fixture();
  const response = await f.send(9999);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).rank, 1);
  assert.equal(f.writes(), 1);
  assert.equal(f.board().entries.length, 500);
  assert.equal(f.board().entries[0].runVerified, false);
  assert.equal(f.board().entries[0].integrityVerified, false);
  assert.equal(f.board().entries[0].rp, undefined);
  assert.equal((await f.send(9999)).status, 200);
  assert.equal(f.writes(), 1);
});

test('a new slow entrant still publishes when the unranked board has space', async () => {
  const f = fixture({count: 499});
  const response = await f.send(20000);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).rank, 500);
  assert.equal(f.writes(), 1);
  assert.equal(f.board().total, 500);
});

test('a conflict that moves the cutoff ahead of this run ends without another write attempt', async () => {
  const f = fixture({conflict: true});
  const response = await f.send(9999);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).improved, false);
  assert.equal(f.attempts(), 1);
  assert.equal(f.writes(), 0);
  assert.equal(f.board().total, 500);
});
