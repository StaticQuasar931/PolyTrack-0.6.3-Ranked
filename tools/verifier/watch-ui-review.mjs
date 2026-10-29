import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';

const root = new URL('../../', import.meta.url);
const read = file => readFileSync(new URL(file, root), 'utf8').replace(/\r\n?/g, '\n');
const sha = value => createHash('sha256').update(value).digest('hex');
const before = '!ghosts.length||ghosts.length>2)throw Error("Event replay context changed")';
const after = before.replace('>2', '>10');

// Restore the historical engine in memory; never rewrite its immutable evidence.
export function reviewedWatchUiBaseline(manifest, {
  review = JSON.parse(read('docs/events/watch-limit-ui-engine-review.json')),
  bundle = read('main.bundle.js'),
  previousReviewText = read('tools/verifier/indexed-playback-review.json'),
  geometry = JSON.parse(read('tools/verifier/track-geometry.json'))
} = {}) {
  assert.equal(review.schema, 1);
  assert.equal(review.currentEngine, '7203ead74e290932abafe7f45ae5d121b5e1488b788f7dbe9ea95c8eb30d1ed1');
  assert.equal(review.previousEngine, '3cb2e59839b5ad85ea34d892e1f10ca7dc04f9d8cec17770fbd843673614a3a0');
  assert.equal(manifest.engineDigest, review.currentEngine);
  assert.equal(sha(JSON.stringify(manifest.files)), review.currentEngine);
  assert.equal(review.previousReview, 'tools/verifier/indexed-playback-review.json');
  assert.equal(sha(previousReviewText), review.previousReviewSha256);
  const indexed = JSON.parse(previousReviewText);
  assert.equal(indexed.currentEngine, review.previousEngine);
  assert.deepEqual(review.changedAssets, ['main.bundle.js']);
  assert.deepEqual(Object.keys(review.previousAssets), review.changedAssets);
  assert.deepEqual(Object.keys(review.currentAssets), review.changedAssets);
  assert.deepEqual(review.normalizedUiReplacement, {before, after});
  assert.equal(sha(bundle), review.currentAssets['main.bundle.js']);
  assert.equal(manifest.files['main.bundle.js'], review.currentAssets['main.bundle.js']);
  assert.equal(bundle.split(after).length, 2);
  assert.equal(bundle.split(before).length, 1);
  const previousBundle = bundle.replace(after, before);
  assert.equal(sha(previousBundle), review.previousAssets['main.bundle.js']);
  const files = {...manifest.files, ...review.previousAssets};
  assert.equal(sha(JSON.stringify(files)), review.previousEngine);
  assert.equal(sha(JSON.stringify(Object.entries(manifest.tracks).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))), review.trackPinsSha256);
  assert.equal(review.trackPinsSha256, indexed.trackPinsSha256);
  assert.equal(geometry.engineDigest, review.currentEngine);
  assert.equal(sha(JSON.stringify(geometry.tracks)), review.geometryRowsSha256);
  assert.equal(review.geometryRowsSha256, indexed.geometryRowsSha256);
  assert.equal(review.historicalBootstrapUnchanged, true);
  assert.equal(review.bootstrapId, indexed.bootstrapId);
  return {files, bundle: previousBundle, review};
}
