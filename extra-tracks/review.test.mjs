import test from 'node:test';
import assert from 'node:assert/strict';
import {reviewTagOptions, normalizeReviewFeedback, effectiveReviewTags, hasTagEdits, reviewExportRow, hasReviewExportData, tagLabel} from './review.mjs';

test('tag choices keep Kacky and new review categories, without Slide or difficulty aliases', () => {
  const options = reviewTagOptions([{tags: ['slide', 'technical', 'difficulty-7', 'kacky', 'easy']}]);
  for (const tag of ['technical', 'scenic', 'elite-track', 'kacky', 'mini', 'other-route']) assert.ok(options.includes(tag));
  for (const tag of ['slide', 'difficulty-7', 'easy']) assert.ok(!options.includes(tag));
  assert.equal(tagLabel('elite-track'), 'Elite Track');
});

test('export eligibility includes each kind of real activity, not catalog metadata or cleared picks', () => {
  const entry = {name: 'Example', tags: ['technical']};
  assert.equal(hasReviewExportData(reviewExportRow(entry)), false);
  for (const feedback of [{favorite: true}, {vote: -1}, {rating: 4}, {difficultyRating: 7}, {addedTags: ['mini']}, {removedTags: ['technical']}]) {
    assert.equal(hasReviewExportData(reviewExportRow(entry, {feedback})), true);
  }
  assert.equal(hasReviewExportData(reviewExportRow(entry, {imported: true})), true);
  assert.equal(hasReviewExportData(reviewExportRow(entry, {personalBestMs: 1234})), true);
  assert.equal(hasReviewExportData(reviewExportRow(entry, {feedback: {favorite: false, rating: 0, difficultyRating: 99, editedAt: 1790000000000}})), false);
});

test('local additions and removals leave catalog data intact and do not count canceled edits', () => {
  const entry = {tags: ['technical', 'stunt', 'difficulty-4']};
  const feedback = normalizeReviewFeedback(entry, {addedTags: ['Scenic', 'technical', 'scenic'], removedTags: ['stunt', 'not-a-tag'], editedAt: 1790000000000});
  assert.deepEqual(feedback.addedTags, ['scenic']);
  assert.deepEqual(feedback.removedTags, ['stunt']);
  assert.deepEqual(effectiveReviewTags(entry, feedback), ['technical', 'scenic']);
  assert.deepEqual(entry.tags, ['technical', 'stunt', 'difficulty-4']);
  assert.equal(hasTagEdits(entry, feedback), true);
  assert.equal(hasTagEdits(entry, {favorite: true, rating: 10}), false);
  assert.equal(normalizeReviewFeedback(entry, {editedAt: 1790000000000}).editedAt, null);
});

test('review export retains favorites, ratings, tag deltas, import status and finish evidence', () => {
  const row = reviewExportRow({name: 'Example', author: 'Credit', codeAuthor: 'Creator', tags: ['technical']}, {
    feedback: {favorite: true, vote: -1, rating: 10, addedTags: ['mini'], removedTags: ['technical'], editedAt: 1790000000000},
    imported: true, personalBestMs: 12345
  });
  assert.equal(row.author, 'Creator');
  assert.equal(row.imported, true); assert.equal(row.played, true); assert.equal(row.personalBestMs, 12345);
  assert.equal(row.favorite, true); assert.equal(row.vote, -1); assert.equal(row.rating, 10);
  assert.deepEqual(row.catalogTags, ['technical']); assert.deepEqual(row.effectiveTags, ['mini']);
  assert.deepEqual(row.addedTags, ['mini']); assert.deepEqual(row.removedTags, ['technical']);
  assert.equal(row.locallyEdited, true);
});

test('malformed device data is bounded and cannot introduce markup or fake PBs', () => {
  const row = reviewExportRow({name: 'Example', tags: ['stunt']}, {feedback: {
    addedTags: ['<script>', 'x'.repeat(41), null, 'Mini', 'slide'], removedTags: 'stunt', rating: '10', vote: 7
  }, personalBestMs: -1});
  assert.deepEqual(row.addedTags, ['mini']); assert.deepEqual(row.removedTags, []);
  assert.equal(row.rating, 0); assert.equal(row.vote, 0); assert.equal(row.played, false);
});
