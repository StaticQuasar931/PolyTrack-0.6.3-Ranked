import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as review from './review.mjs';

function fixture() {
  const source = fs.readFileSync(new URL('../polytrack_062_patch.js', import.meta.url), 'utf8');
  const start = source.indexOf("  const extraFeedbackKey='sq-extra-feedback-v1';");
  const end = source.indexOf('  async function openExtraTracks(){', start);
  assert.ok(start >= 0 && end > start);
  const storage = new Map();
  const entry = {id: 'example', trackId: 'a'.repeat(64), name: 'Example', author: 'Creator', tags: ['technical']};
  const state = {writes: 0, fail: false, blob: null, clicked: false};
  const context = vm.createContext({
    review, Blob, Date, Object, JSON, Number, Error,
    window: {addEventListener() {}}, extraTracksUi: null,
    localStorage: {
      getItem: key => storage.get(key) || null,
      setItem: (key, value) => { if (state.fail) throw Error('Storage full'); state.writes++; storage.set(key, value); }
    },
    extraTrackIds: () => ({example: entry.trackId}), loadExtraTracksCatalog: async () => [entry],
    readLocalRaceRows: () => [], extraTrackPersonalBest: () => ({timeMs: 12345}),
    URL: {createObjectURL: blob => {state.blob = blob; return 'blob:review';}, revokeObjectURL() {}},
    document: {createElement: () => ({click: () => {state.clicked = true;}})}, setTimeout() {}
  });
  vm.runInContext(source.slice(start, end) + '\nextraReviewHelpers=review;globalThis.api={extraFeedback,saveExtraFeedback,exportExtraFeedback};', context);
  return {entry, state, api: context.api};
}

test('real local save preserves existing picks while applying tag edits without a cloud request', () => {
  const {entry, state, api} = fixture();
  api.saveExtraFeedback(entry, {favorite: true, rating: 10});
  api.saveExtraFeedback(entry, {addedTags: ['scenic'], removedTags: ['technical']});
  const saved = api.extraFeedback(entry);
  assert.equal(saved.favorite, true); assert.equal(saved.rating, 10);
  assert.deepEqual(saved.addedTags, ['scenic']); assert.deepEqual(saved.removedTags, ['technical']);
  assert.ok(saved.editedAt > 0); assert.equal(state.writes, 2);
  api.saveExtraFeedback(entry, {addedTags: [], removedTags: []});
  assert.equal(api.extraFeedback(entry).editedAt, null);
});

test('actual Export My Picks includes tag edits and preserves existing progress fields', async () => {
  const {entry, state, api} = fixture();
  api.saveExtraFeedback(entry, {favorite: true, vote: 1, rating: 10, addedTags: ['mini'], removedTags: ['technical']});
  await api.exportExtraFeedback();
  const data = JSON.parse(await state.blob.text());
  assert.equal(state.clicked, true); assert.equal(data.version, 3);
  const row = data.tracks[entry.trackId];
  assert.equal(row.favorite, true); assert.equal(row.vote, 1); assert.equal(row.rating, 10);
  assert.equal(row.imported, true); assert.equal(row.played, true); assert.equal(row.personalBestMs, 12345);
  assert.deepEqual(row.catalogTags, ['technical']); assert.deepEqual(row.addedTags, ['mini']);
  assert.deepEqual(row.removedTags, ['technical']); assert.deepEqual(row.effectiveTags, ['mini']);
});

test('failed local saves do not change cached feedback or erase successful reviewer work', () => {
  const {entry, state, api} = fixture();
  api.saveExtraFeedback(entry, {rating: 8}); state.fail = true;
  assert.throws(() => api.saveExtraFeedback(entry, {rating: 10, addedTags: ['scenic']}), /Storage full/);
  assert.equal(api.extraFeedback(entry).rating, 8); assert.deepEqual(api.extraFeedback(entry).addedTags, []);
});
