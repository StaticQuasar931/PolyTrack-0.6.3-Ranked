import test from 'node:test';
import assert from 'node:assert/strict';
import {stampClientRelease} from './site-release.mjs';

const index = '<script src="polytrack_062_patch.js?v=44"></script>';
const patch = "const eventsModuleUrl=new URL('./events/client.mjs',base).href;const extraCatalogRevision='40';import('filter-menu.mjs?v=44');import('site-updates.mjs?v=44');installSiteUpdates({revision:44});";

test('a release refreshes events and Extra menu alongside filter modules', () => {
  const result = stampClientRelease(patch, index, 45);
  assert.match(result.patch, /events\/client\.mjs\?v=45/);
  assert.match(result.patch, /extraCatalogRevision='45'/);
  assert.match(result.patch, /filter-menu\.mjs\?v=45/);
  assert.match(result.patch, /site-updates\.mjs\?v=45/);
  assert.match(result.patch, /revision:45/);
  assert.match(result.index, /patch\.js\?v=45/);
  assert.deepEqual(stampClientRelease(result.patch, result.index, 45), result);
  assert.match(stampClientRelease(result.patch, result.index, 46).patch, /events\/client\.mjs\?v=46/);
});

test('release stamping rejects invalid revisions or absent entry anchors', () => {
  assert.throws(() => stampClientRelease(patch, index, NaN), /Invalid release/);
  assert.throws(() => stampClientRelease('', index, 45), /anchors/);
  assert.throws(() => stampClientRelease(patch, '', 45), /anchors/);
});
