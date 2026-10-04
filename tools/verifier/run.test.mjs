import assert from 'node:assert/strict';
import test from 'node:test';
import {runRound} from './run.mjs';
import {VERIFICATION_COLLECTION, EXTRA_VERIFICATION_COLLECTION} from '../../workers/ranked/src/verification.js';
import {EXTRA_TRACK_IDS} from '../../workers/ranked/src/extra-track-ids.js';

const noop = () => {};
const eventRun = async () => ({checked: 0, consumed: 0, rejected: false, archived: null, results: []});
const options = {env: {}, log: noop, eventRun, prioritizeNormal: async (_db, docs) => docs,
  selectNormal: async (_db, docs, _now, limits) => ({jobs: [], canonicalAttempts: 0, selectionConflicts: 0, limits}),
  verifyNormal: async () => [], publishNormal: async () => ({verified: 0}), borrowUnusedEvents: true};

test('small remaining publication reserve lowers each due-lane query bound', async () => {
  const queries = [];
  const db = {remainingRequests: () => 30, call: async (_path, body) => {
    const query = body.structuredQuery; queries.push(query);
    if (query.from[0].collectionId === VERIFICATION_COLLECTION) return [
      {document: {fields: {trackId: {stringValue: 'core-a'}}}},
      {document: {fields: {trackId: {stringValue: 'core-b'}}}},
    ];
    return [];
  }};

  await runRound(db, options);
  assert.equal(queries.length, 2);
  assert.deepEqual(queries.map(query => query.limit), [2, 2]);
  assert.equal(queries.reduce((sum, query) => sum + query.limit, 0), 4);
});

test('no runnable publication reserve skips both repeated queue scans', async () => {
  let queries = 0;
  const db = {remainingRequests: () => 14, call: async () => { queries++; return []; }};
  await runRound(db, options);
  assert.equal(queries, 0);
});

test('one round shares priority metadata between lanes but the next round rereads it', async () => {
  const core = ['core-a', 'core-b'].map(trackId => ({document: {fields: {
    trackId: {stringValue: trackId}, notBefore: {integerValue: '0'}, slots: {mapValue: {fields: {}}},
  }}}));
  const extraIds = [...EXTRA_TRACK_IDS].slice(0, 2);
  assert.equal(extraIds.length, 2);
  const extra = extraIds.map(trackId => ({document: {fields: {
    trackId: {stringValue: trackId}, notBefore: {integerValue: '0'}, slots: {mapValue: {fields: {}}},
  }}}));
  let overallReads = 0;
  const db = {remainingRequests: () => 400, call: async (_path, body) =>
    body.structuredQuery.from[0].collectionId === VERIFICATION_COLLECTION ? core : extra,
  get: async () => { overallReads++; return {data: {trackSummaries: []}}; }};
  const priority = async (connection, docs, now, cache) => {
    const {prioritizeQueueDocuments} = await import('./runner.mjs');
    return prioritizeQueueDocuments(connection, docs, now, cache);
  };
  const roundOptions = {...options, prioritizeNormal: priority};

  await runRound(db, roundOptions);
  await runRound(db, roundOptions);
  assert.equal(overallReads, 2);
});

