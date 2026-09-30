import assert from 'node:assert/strict';
import test from 'node:test';
import {computeOverall, computeTrackEntries, handleRequest, rebuildOverall} from '../src/index.js';

const ORIGIN = 'https://staticquasar931.github.io';
const ACCOUNT = 'group-racer';
const TRACK = '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';

function encode(value) {
  if (value === null || value === undefined) return {nullValue: null};
  if (Array.isArray(value)) return {arrayValue: {values: value.map(encode)}};
  if (typeof value === 'boolean') return {booleanValue: value};
  if (typeof value === 'number') return Number.isInteger(value) ? {integerValue: String(value)} : {doubleValue: value};
  if (typeof value === 'object') return {mapValue: {fields: encodeFields(value)}};
  return {stringValue: String(value)};
}

function encodeFields(value) {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)]));
}

function decode(value) {
  if ('nullValue' in value) return null;
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('arrayValue' in value) return (value.arrayValue.values || []).map(decode);
  if ('mapValue' in value) return decodeFields(value.mapValue.fields || {});
  return null;
}

function decodeFields(fields) {
  return Object.fromEntries(Object.entries(fields || {}).map(([key, item]) => [key, decode(item)]));
}

function document(data, updateTime = 'v1') {
  return {fields: encodeFields(data), updateTime};
}

function request(method, path, body) {
  return new Request(`https://ranked.example${path}`, {
    method,
    headers: {Origin: ORIGIN, ...(body === undefined ? {} : {'Content-Type': 'application/json'})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})
  });
}

function requestEnv({groupCode = '', overallEntries = [], ownerUid = 'signed-in-user', directoryAccounts} = {}) {
  const initialDirectory = directoryAccounts ?? (groupCode && groupCode !== null ? {[ACCOUNT]: {groupCode, updatedAt: 1}} : {});
  const docs = new Map([
    [`/0.6.2_profiles_public/${ACCOUNT}`, document({accountId: ACCOUNT, ownerUid, nickname: 'Racer'})],
    ...(groupCode === null ? [] : [[`/0.6.2_s1_group_tags/account_${ACCOUNT}`, document({accountId: ACCOUNT, groupCode, updatedAt: 1})]]),
    [`/0.6.2_s1_group_tags/current`, document({accounts: initialDirectory, updatedAt: 1})],
    ...(overallEntries.length ? [[`/0.6.2_s1_leaderboards_overall/main`, document({entries: overallEntries, revision: 7})]] : [])
  ]);
  const commits = [];
  const calls = [];
  let version = 1;
  const env = {
    ALLOWED_ORIGINS: ORIGIN,
    __TEST_UID: 'signed-in-user',
    __TEST_FIRESTORE: async (path, init = {}) => {
      calls.push(path);
      if (path === ':commit') {
        const writes = JSON.parse(init.body).writes;
        commits.push(writes);
        const writeResults = [];
        for (const write of writes) {
          if (write.delete) {
            const key = `/${write.delete.split('/documents/')[1]}`;
            docs.delete(key);
            continue;
          }
          const key = `/${write.update.name.split('/documents/')[1]}`;
          const updateTime = `v${++version}`;
          docs.set(key, {fields: write.update.fields, updateTime});
          writeResults.push({updateTime});
        }
        return {writeResults};
      }
      if (init.method === 'PATCH') {
        const key = decodeURIComponent(path);
        const body = JSON.parse(init.body);
        const updateTime = `v${++version}`;
        docs.set(key, {fields: body.fields, updateTime});
        return {updateTime};
      }
      if (path === ':runQuery' || path === ':batchGet') return [];
      return docs.get(decodeURIComponent(path)) || null;
    }
  };
  return {env, docs, commits, calls};
}

async function postGroupCode(fixture, groupCode, accountId = ACCOUNT) {
  const pending = [];
  const response = await handleRequest(request('POST', '/v1/profile/group-code', {accountId, groupCode}), fixture.env, {
    waitUntil(promise) { pending.push(promise); }
  });
  await Promise.all(pending);
  return response;
}

test('group-code routes require authentication and profile ownership', async () => {
  const unauthenticated = new Request(`https://ranked.example/v1/profile/group-code?accountId=${ACCOUNT}`, {headers: {Origin: ORIGIN}});
  const authResponse = await handleRequest(unauthenticated, {ALLOWED_ORIGINS: ORIGIN});
  assert.equal(authResponse.status, 401);

  const fixture = requestEnv({ownerUid: 'different-user', groupCode: null});
  const response = await postGroupCode(fixture, '123456');
  assert.equal(response.status, 403);
  assert.equal(fixture.docs.has(`/0.6.2_s1_group_tags/account_${ACCOUNT}`), false);
  assert.equal(fixture.commits.length, 0);
});

test('group-code accepts only six digit strings or an empty clear value', async () => {
  for (const groupCode of ['12345', '1234567', '12a456', 123456, null]) {
    const fixture = requestEnv({groupCode: null});
    const response = await postGroupCode(fixture, groupCode);
    assert.equal(response.status, 400, `rejected ${JSON.stringify(groupCode)}`);
    assert.equal(fixture.commits.length, 0);
  }
});

test('group-code saves privately, updates only its public overall row, and can be read by its owner', async () => {
  const fixture = requestEnv({groupCode: '111111', overallEntries: [
    {userId: ACCOUNT, name: 'Racer'}, {userId: 'other-racer', name: 'Other'}
  ]});
  const response = await postGroupCode(fixture, '012345');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {groupCode: '012345'});

  const profile = decodeFields(fixture.docs.get(`/0.6.2_profiles_public/${ACCOUNT}`).fields);
  const tag = decodeFields(fixture.docs.get(`/0.6.2_s1_group_tags/account_${ACCOUNT}`).fields);
  const directory = decodeFields(fixture.docs.get('/0.6.2_s1_group_tags/current').fields);
  const overall = decodeFields(fixture.docs.get('/0.6.2_s1_leaderboards_overall/main').fields);
  assert.equal(profile.groupCode, undefined);
  assert.equal(tag.groupCode, '012345');
  assert.equal(directory.accounts[ACCOUNT].groupCode, '012345');
  assert.equal(overall.entries.find(row => row.userId === ACCOUNT).groupCode, '012345');
  assert.equal(overall.entries.find(row => row.userId === 'other-racer').groupCode, undefined);
  assert.equal(fixture.calls.filter(path => path === ':runQuery').length, 0, 'saving a code does not scan race results');
  const atomic = fixture.commits.find(writes => writes.some(write => write.update.name.endsWith(`/0.6.2_s1_group_tags/account_${ACCOUNT}`)));
  assert.ok(atomic?.some(write => write.update.name.endsWith('/0.6.2_s1_group_tags/current')));
  assert.ok(atomic?.some(write => write.update.name.endsWith('/0.6.2_s1_leaderboards_overall/main')));

  const get = await handleRequest(request('GET', `/v1/profile/group-code?accountId=${ACCOUNT}`), fixture.env);
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), {groupCode: '012345'});
});

test('group-code can be cleared without leaving a stale public value', async () => {
  const fixture = requestEnv({groupCode: '654321', overallEntries: [{userId: ACCOUNT, groupCode: '654321'}]});
  const response = await postGroupCode(fixture, '');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {groupCode: ''});
  assert.equal(decodeFields(fixture.docs.get(`/0.6.2_s1_group_tags/account_${ACCOUNT}`).fields).groupCode, '');
  let directory = decodeFields(fixture.docs.get('/0.6.2_s1_group_tags/current').fields);
  assert.equal(directory.accounts[ACCOUNT], undefined);
  assert.equal(decodeFields(fixture.docs.get('/0.6.2_s1_leaderboards_overall/main').fields).entries[0].groupCode, undefined);

  const readded = await postGroupCode(fixture, '112233');
  assert.equal(readded.status, 200);
  directory = decodeFields(fixture.docs.get('/0.6.2_s1_group_tags/current').fields);
  assert.equal(directory.accounts[ACCOUNT].groupCode, '112233');
});

test('group-code can be set when no overall row exists without scanning results', async () => {
  const fixture = requestEnv({groupCode: null});
  const response = await postGroupCode(fixture, '908172');
  assert.equal(response.status, 200);
  assert.equal(decodeFields(fixture.docs.get(`/0.6.2_s1_group_tags/account_${ACCOUNT}`).fields).groupCode, '908172');
  assert.equal(fixture.calls.filter(path => path === ':runQuery').length, 0);
  assert.equal(fixture.docs.has('/0.6.2_s1_leaderboards_overall/main'), false);
});

test('group-code directory rejects a 2,001st active account without partial writes', async () => {
  const directoryAccounts = Object.fromEntries(Array.from({length: 2000}, (_, index) => [`tag-${index}`, {groupCode: '123456', updatedAt: 1}]));
  const fixture = requestEnv({groupCode: null, directoryAccounts});
  const response = await postGroupCode(fixture, '908172');
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {error: 'group_code_capacity'});
  assert.equal(fixture.commits.length, 0);
});

test('track identity carries group codes into overall computation and rebuilds preserve prior public codes', async () => {
  const trackEntry = {accountId: ACCOUNT, trackId: TRACK, timeMs: 20000, frames: 1200, replay: 'sample', replayHash: 'a'.repeat(64),
    integrityVerified: true, runVerified: true, groupCode: '246810'};
  const trackRows = computeTrackEntries([trackEntry], TRACK);
  assert.equal(trackRows[0].groupCode, '246810');
  const computed = computeOverall([{trackId: TRACK, entries: [
    {...trackRows[0], rank: 1, weight: 2, integrityVerified: true, runVerified: true},
    {accountId: 'other-racer', trackId: TRACK, rank: 2, weight: 1, timeMs: 21000, integrityVerified: true, runVerified: true}
  ]}]);
  assert.equal(computed.find(row => row.userId === ACCOUNT).groupCode, '246810');

  const prior = {entries: [{userId: ACCOUNT, groupCode: '135790'}], revision: 7, builtRevision: 7, updatedAt: 1};
  const board = {trackId: TRACK, complete: true, entries: [
    {accountId: ACCOUNT, rank: 1, weight: 2, timeMs: 20000, integrityVerified: true, runVerified: true},
    {accountId: 'other-racer', rank: 2, weight: 1, timeMs: 21000, integrityVerified: true, runVerified: true}
  ]};
  let published;
  let groupTag = null;
  const batchGets = [];
  const docs = new Map([
    ['/0.6.2_s1_leaderboards_overall/main', document(prior)],
    ['/0.6.2_s1_release_meta/current', document({dirty: true, revision: 8})]
  ]);
  const env = {__TEST_FIRESTORE: async (path, init = {}) => {
    if (path === ':runQuery') return [{document: {name: `projects/test/databases/(default)/documents/0.6.2_s1_leaderboards_track/${TRACK}`, fields: encodeFields(board)}}];
    if (path === ':batchGet') {
      const documents = JSON.parse(init.body).documents;
      batchGets.push(documents);
      return groupTag ? [{found: {
        name: 'projects/test/databases/(default)/documents/0.6.2_s1_group_tags/current',
        fields: encodeFields(groupTag), updateTime: 'v2'
      }}] : [];
    }
    if (path === ':commit') {
      const main = JSON.parse(init.body).writes.find(write => write.update.name.endsWith('/0.6.2_s1_leaderboards_overall/main'));
      published = decodeFields(main.update.fields);
      return {};
    }
    return docs.get(path) || null;
  }};
  await rebuildOverall(env, true);
  assert.equal(published.entries.find(row => row.userId === ACCOUNT).groupCode, '135790');
  assert.equal(batchGets.length, 1);
  assert.ok(batchGets[0].some(path => path.endsWith('/0.6.2_s1_group_tags/current')));
  assert.ok(!batchGets[0].some(path => path.includes('/0.6.2_s1_group_tags/account_')));
  groupTag = {accounts: {}, updatedAt: 9};
  await rebuildOverall(env, true);
  assert.equal(batchGets.length, 2);
  const clearedRow = published.entries.find(row => row.userId === ACCOUNT);
  assert.equal(clearedRow.groupCode, undefined);
  assert.equal(clearedRow.groupCodeUpdatedAt, undefined);
  groupTag = {accounts: {[ACCOUNT]: {groupCode: '112233', updatedAt: 10}}, updatedAt: 10};
  await rebuildOverall(env, true);
  assert.equal(batchGets.length, 3);
  assert.equal(published.entries.find(row => row.userId === ACCOUNT).groupCode, '112233');
});
