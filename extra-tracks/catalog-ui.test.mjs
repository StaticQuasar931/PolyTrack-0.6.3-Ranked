import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mountExtraTracks } from './catalog-ui.mjs';

class FakeNode {
  constructor(document, tagName) {
    this.document = document;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this._text = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.inert = false;
    this.checked = false;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, handler) { const list = this.listeners.get(name) || []; list.push(handler); this.listeners.set(name, list); }
  removeEventListener(name, handler) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== handler)); }
  dispatch(name, extra = {}) { return Promise.all((this.listeners.get(name) || []).map(handler => handler({ target: this, preventDefault() {}, ...extra }))); }
  focus(options) { this.document.activeElement = this; this.focusOptions = options; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  querySelectorAll() { return walk(this).filter(node => ['BUTTON', 'INPUT', 'SELECT', 'A'].includes(node.tagName) && !node.disabled); }
}

function field(root, caption) { return cls(root, 'sq-extra-field').find(node => node._text === caption); }

function walk(node) { return node.children.flatMap(child => [child, ...walk(child)]); }

test('plain text search finds normalized track names, authors and shared aliases without changing display data', async () => {
  const items = [entry(1, {name: 'B\u26f6XED IN', author: '\u{1d400}\u{1d425}\u{1d429}\u{1d421}\u{1d41a}'}), entry(2, {name: 'N\u00fcrburgring Nordschleife', author: 'Jos\u00e9'}), entry(3, {name: 'AO9-race', author: 'Zero\u200bWidth'})];
  const original = JSON.stringify(items);
  const {root, api} = fixture(items); api.open();
  const search = tag(cls(root, 'sq-extra-search-field')[0], 'input')[0];
  for (const [query, name] of [['boxed in', items[0].name], ['alpha', items[0].name], ['nuerburgring', items[1].name], ['jose', items[1].name], ['a09 race', items[2].name], ['zerowidth', items[2].name]]) {
    search.value = query; await search.dispatch('input');
    assert.deepEqual(cls(root, 'sq-extra-card').map(card => tag(card, 'h3')[0].textContent), [name], query);
  }
  assert.equal(JSON.stringify(items), original);
  api.destroy();
});

test('grading help credits Window Cleaner and its search reveals a single external cat image', async () => {
  const {root, api} = fixture([entry(1)]); api.open();
  assert.match(cls(root, 'sq-extra-grading-help')[0].textContent, /Thanks to Window Cleaner for help with track gradings/);
  const reveal = cls(root, 'sq-extra-cleaner')[0];
  const search = tag(cls(root, 'sq-extra-search-field')[0], 'input')[0];
  assert.equal(reveal.hidden, true); assert.equal(tag(reveal, 'img').length, 0);
  for (const query of ['WINDOW-cleaner', 'window cleaner']) {
    search.value = query; await search.dispatch('input');
    assert.equal(reveal.hidden, false); assert.equal(tag(reveal, 'img').length, 1);
    assert.equal(tag(reveal, 'img')[0].src, 'https://cdn.jsdelivr.net/gh/StaticQuasar931/Images@main/Window_Cleaner_Cat.jpg');
  }
  search.value = ''; await search.dispatch('input'); assert.equal(reveal.hidden, true);
  api.destroy();
});

test('every filter option retains readable counts including selected published rating thresholds', async () => {
  const entries = JSON.parse(fs.readFileSync(new URL('./catalog.json', import.meta.url), 'utf8')).slice(0, 3);
  const {root, api} = fixture(entries); api.open();
  const fields = cls(root, 'sq-extra-field');
  for (const caption of ['Source', 'Catalog level', 'Progress', 'Review status', 'Rating', 'Difficulty', 'Votes']) {
    const select = tag(fields.find(field => field._text === caption), 'select')[0];
    for (const option of select.children) assert.match(option.textContent, / \(\d+\)$/, caption);
    if (caption === 'Rating') {
      select.value = '6'; await select.dispatch('change');
      assert.equal(select.children.find(option => option.value === '6').textContent, 'At least 6/10 (2)');
    }
  }
  assert.equal(cls(root, 'sq-extra-reviewed-count').length, 0);
  assert.doesNotMatch(root.textContent, /one opinion|\d+ reviewers?/);
  api.destroy();
});
function cls(root, name) { return walk(root).filter(node => node.className?.split(' ').includes(name)); }
function tag(root, name) { return walk(root).filter(node => node.tagName === name.toUpperCase()); }
function click(node) { return node.dispatch('click'); }
function fixture(entries, callbacks = {}, viewport = null) {
  const document = { baseURI: 'https://polytrack.example/', activeElement: null, listeners: new Map() };
  if (viewport) {
    const listeners = new Set();
    const media = {matches: viewport.width <= 600 || viewport.height <= 650,
      addEventListener: (type, callback) => listeners.add(callback), removeEventListener: (type, callback) => listeners.delete(callback)};
    document.defaultView = {matchMedia: query => {assert.equal(query, '(max-width: 600px), (max-height: 650px)');return media;}, addEventListener() {}, removeEventListener() {}};
    document.resizeTo = (width, height) => {const matches = width <= 600 || height <= 650;if (matches !== media.matches) {media.matches = matches;for (const callback of listeners) callback({matches});}};
    document.mediaListeners = listeners;
  }
  document.createElement = name => new FakeNode(document, name);
  document.addEventListener = (name, handler) => document.listeners.set(name, handler);
  document.removeEventListener = name => document.listeners.delete(name);
  const root = document.createElement('div');
  const launch = document.createElement('button');
  launch.focus();
  const api = mountExtraTracks({ document, root, entries, ...callbacks });
  return { document, root, launch, api };
}

const entry = (n, extra = {}) => ({
  id: `track-${n}`, name: `Track ${String(n).padStart(2, '0')}`, author: `Author ${n}`,
  source: n % 2 ? 'Kacky' : 'Community', sourceUrl: 'https://example.com/source',
  tags: n % 2 ? ['technical'] : ['speed'], tier: n % 3 ? '' : 'Featured',
  trackPath: `tracks/${n}.track`, sourcePlays: n * 10, ...extra
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fillSubmission(root) {
  const fields = cls(root, 'sq-extra-submission-field');
  fields[0].children[0].value = 'Test track';
  fields[1].children[0].value = 'Tester';
  fields[3].children[0].value = 'PolyTrack' + 'A'.repeat(24);
  cls(root, 'sq-extra-submission-check')[0].children[0].checked = true;
}

test('mount is hidden until open, paginates exact counts and restores focus', () => {
  const { root, launch, document, api } = fixture(Array.from({ length: 15 }, (_, i) => entry(i + 1)));
  assert.equal(cls(root, 'sq-extra-overlay')[0].hidden, true);
  api.open();
  assert.equal(cls(root, 'sq-extra-overlay')[0].hidden, false);
  assert.equal(document.activeElement.tagName, 'INPUT');
  assert.equal(cls(root, 'sq-extra-count')[0].textContent, '15 of 15 tracks');
  assert.equal(tag(cls(root, 'sq-extra-controls')[0], 'input')[0].getAttribute('aria-describedby'), cls(root, 'sq-extra-count')[0].id);
  assert.equal(tag(cls(root, 'sq-extra-controls')[0], 'input')[0].getAttribute('aria-controls'), cls(root, 'sq-extra-grid')[0].id);
  assert.equal(cls(root, 'sq-extra-card').length, 12);
  click(tag(cls(root, 'sq-extra-pagination')[0], 'button')[1]);
  assert.equal(cls(root, 'sq-extra-card').length, 3);
  assert.match(cls(root, 'sq-extra-pagination')[0].textContent, /Page 2 of 2/);
  api.close();
  assert.equal(document.activeElement, launch);
  api.destroy();
  assert.equal(root.children.length, 0);
  assert.equal(document.listeners.size, 0);
  api.open();
  assert.equal(root.children.length, 0);
});

test('page navigation scrolls cards into view and keeps focus on the replacement control', async () => {
  const { root, api } = fixture(Array.from({ length: 26 }, (_, i) => entry(i + 1)));
  api.open();
  const list = cls(root, 'sq-extra-grid')[0];
  const scrolls = [];
  list.scrollIntoView = options => scrolls.push(options);
  let next = tag(cls(root, 'sq-extra-pagination')[0], 'button')[1];
  await click(next);
  next = tag(cls(root, 'sq-extra-pagination')[0], 'button')[1];
  assert.match(cls(root, 'sq-extra-pagination')[0].textContent, /Page 2 of 3/);
  assert.deepEqual(scrolls, [{ block: 'start' }]);
  assert.equal(root.children[0].document.activeElement, next);
  await click(next);
  assert.match(cls(root, 'sq-extra-pagination')[0].textContent, /Page 3 of 3/);
  assert.equal(root.children[0].document.activeElement, tag(cls(root, 'sq-extra-pagination')[0], 'button')[0], 'last page focuses the remaining enabled control');
  api.destroy();
});

test('local picks toggle, rating changes and export callback stay device-scoped', async () => {
  const saved = new Map(), exported = [];
  const item = entry(1, { trackId: 'a'.repeat(64) });
  const { document, root, api } = fixture([item], {
    getFeedback: track => saved.get(track.trackId) || {},
    onFeedback: (track, change) => saved.set(track.trackId, { ...saved.get(track.trackId), ...change }),
    getLocalRating: track => saved.get(track.trackId)?.rating,
    onExportFeedback: () => exported.push(true)
  });
  api.open();
  const favorite = cls(root, 'sq-extra-favorite')[0];
  assert.equal(favorite.getAttribute('aria-label'), 'Add to favorites');
  assert.equal(favorite.getAttribute('aria-pressed'), 'false');
  await click(favorite);
  assert.equal(saved.get(item.trackId).favorite, true);
  assert.equal(cls(root, 'sq-extra-favorite')[0].getAttribute('aria-pressed'), 'true');
  await click(cls(root, 'sq-extra-favorite')[0]);
  assert.equal(saved.get(item.trackId).favorite, false);
  const more = cls(root, 'sq-extra-more')[0];
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  assert.equal(more.getAttribute('aria-haspopup'), 'dialog');
  await click(more);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  assert.equal(cls(root, 'sq-extra-more-menu')[0].hidden, false);
  await click(cls(root, 'sq-extra-pick')[0]);
  assert.equal(saved.get(item.trackId).vote, 1);
  assert.equal(cls(root, 'sq-extra-more-menu')[0].hidden, false);
  await click(cls(root, 'sq-extra-pick')[1]);
  assert.equal(saved.get(item.trackId).vote, -1);
  assert.equal(cls(root, 'sq-extra-more-menu')[0].hidden, false);
  const rating = tag(cls(root, 'sq-extra-rating')[0], 'select')[0];
  rating.value = '8'; await rating.dispatch('change');
  assert.equal(saved.get(item.trackId).rating, 8);
  await click(cls(root, 'sq-extra-export')[0]);
  assert.equal(exported.length, 1);
  api.destroy();
});

test('async pick export is single-flight and exposes its pending state', async () => {
  const request = deferred();
  let exports = 0;
  const { root, api } = fixture([entry(1)], {
    onExportFeedback: () => { exports++; return request.promise; }
  });
  api.open();
  const exportButton = cls(root, 'sq-extra-export')[0];
  const first = click(exportButton);
  const duplicate = click(exportButton);
  assert.equal(exports, 1, 'repeated clicks do not start duplicate exports');
  assert.equal(exportButton.disabled, true);
  assert.equal(exportButton.textContent, 'Exporting...');
  assert.equal(exportButton.getAttribute('aria-busy'), 'true');
  request.resolve();
  await Promise.all([first, duplicate]);
  assert.equal(exportButton.disabled, false);
  assert.equal(exportButton.textContent, 'Export my picks');
  assert.equal(exportButton.getAttribute('aria-busy'), undefined);
  assert.match(cls(root, 'sq-extra-status')[0].textContent, /were exported/);
  api.destroy();
});

test('reviewer quick ratings map zero to ten, accept number-pad keys and ignore editable controls', async () => {
  const saved = new Map();
  const item = entry(1);
  const { document, root, api } = fixture([item], {
    getFeedback: track => saved.get(track.id) || {},
    onFeedback: (track, change) => saved.set(track.id, { ...saved.get(track.id), ...change })
  });
  api.open();
  const keydown = document.listeners.get('keydown');
  const search = tag(cls(root, 'sq-extra-controls')[0], 'input')[0];
  search.focus();
  keydown({ key: '7', code: 'Digit7', preventDefault() {} });
  assert.equal(saved.has(item.id), false, 'search typing is never captured as a quick rating');
  await click(cls(root, 'sq-extra-more')[0]);
  keydown({ key: '0', code: 'Numpad0', preventDefault() {} });
  assert.equal(saved.get(item.id).rating, 10);
  assert.equal(cls(root, 'sq-extra-more-menu')[0].hidden, false, 'quick rating leaves the menu open');
  const rating = tag(cls(root, 'sq-extra-rating')[0], 'select')[0];
  rating.focus();
  keydown({ key: '0', code: 'Digit0', preventDefault() {} });
  assert.equal(saved.get(item.id).rating, 10, 'zero on the rating select maps to ten');
  keydown({ key: '8', code: 'Digit8', shiftKey: true, preventDefault() {} });
  assert.equal(saved.get(item.id).rating, 10, 'Shift-modified digits are not ratings');
  keydown({ key: '6', code: 'Numpad6', ctrlKey: true, preventDefault() {} });
  assert.equal(saved.get(item.id).rating, 10, 'modified number-pad digits are not ratings');
  keydown({ key: '9', code: 'Digit9', preventDefault() {} });
  assert.equal(saved.get(item.id).rating, 9, 'one through nine remain direct ratings');
  assert.equal(cls(root, 'sq-extra-more-menu')[0].hidden, false);
  api.destroy();
});

test('local tag suggestions add, remove and undo without changing canonical tags', async () => {
  const saved = new Map();
  const item = entry(1, { tags: ['technical', 'scenic'] });
  const { root, api } = fixture([item], {
    getFeedback: track => saved.get(track.id) || {},
    onFeedback: (track, change) => saved.set(track.id, { ...saved.get(track.id), ...change })
  });
  api.open();
  await click(cls(root, 'sq-extra-more')[0]);
  assert.equal(cls(root, 'sq-extra-tag-choice').length, 0, 'tag choices are not built for closed pickers');
  await click(tag(cls(root, 'sq-extra-tag-picker')[0], 'summary')[0]);
  const choices = () => cls(root, 'sq-extra-tag-choice');
  const findChoice = name => choices().find(choice => choice.textContent === name);
  await click(findChoice('Remove Scenic'));
  assert.deepEqual(saved.get(item.id).removedTags, ['scenic']);
  assert.equal(findChoice('Add Scenic').getAttribute('aria-pressed'), 'false');
  await click(findChoice('Add Scenic'));
  assert.deepEqual(saved.get(item.id).removedTags, []);
  await click(findChoice('Add Elite Track'));
  assert.deepEqual(saved.get(item.id).addedTags, ['elite-track']);
  assert.ok(cls(root, 'sq-extra-tags')[0].textContent.includes('Elite Track'), 'a new tag is visible even when the track already has two tags');
  const tagSearch = cls(root, 'sq-extra-tag-search')[0];
  tagSearch.value = 'elite';
  tagSearch.dispatch('input');
  assert.equal(findChoice('Remove Elite Track').hidden, false);
  assert.equal(findChoice('Remove Scenic').hidden, true);
  tagSearch.value = '';
  tagSearch.dispatch('input');
  await click(findChoice('Remove Elite Track'));
  assert.deepEqual(saved.get(item.id).addedTags, []);
  assert.deepEqual(item.tags, ['technical', 'scenic']);
  assert.equal(cls(root, 'sq-extra-more-menu')[0].hidden, false, 'tag changes keep the dropdown available');
  api.destroy();
});

test('activity progress filter includes every review type plus imports and finishes, with a default reset', async () => {
  const tracks = Array.from({length: 9}, (_, index) => entry(index + 1));
  const choices = [{favorite: true}, {rating: 8}, {difficultyRating: 5}, {vote: -1}, {addedTags: ['mini']}, {removedTags: ['speed']}, {}, {}, {}];
  const {root, api} = fixture(tracks, {
    getFeedback: track => choices[tracks.indexOf(track)],
    isLoaded: track => track.id === tracks[6].id,
    getPersonalBest: track => track.id === tracks[7].id ? 12345 : null
  });
  api.open();
  const progress = tag(field(root, 'Progress'), 'select')[0];
  progress.value = 'activity'; await progress.dispatch('change');
  assert.equal(cls(root, 'sq-extra-card').length, 8);
  progress.value = 'untouched'; await progress.dispatch('change');
  assert.equal(cls(root, 'sq-extra-card').length, 1);
  await click(tag(root, 'button').find(button => button.textContent === 'Reset filters'));
  assert.equal(progress.value, 'all'); assert.equal(cls(root, 'sq-extra-card').length, 9);
  api.destroy();
});

test('reset review needs confirmation, clears all review fields and keeps PB/import state', async () => {
  const item = entry(1);
  let saved = {favorite: true, vote: 1, rating: 9, difficultyRating: 8, addedTags: ['mini'], removedTags: ['technical']};
  const {root, api} = fixture([item], {getFeedback: () => saved, onFeedback: (_track, change) => { saved = {...saved, ...change}; }, isLoaded: () => true, getPersonalBest: () => 12345});
  api.open(); await click(cls(root, 'sq-extra-more')[0]);
  const reset = cls(root, 'sq-extra-review-reset')[0];
  await click(reset); assert.equal(saved.rating, 9);
  await click(reset); assert.equal(saved.rating, 0); assert.equal(saved.difficultyRating, 0);
  assert.equal(saved.favorite, false); assert.equal(saved.vote, 0); assert.deepEqual(saved.addedTags, []); assert.deepEqual(saved.removedTags, []);
  assert.ok(cls(root, 'sq-extra-best')[0].textContent.includes('Best'));
  assert.equal(cls(root, 'sq-extra-more-menu')[0].hidden, false);
  api.destroy();
});

test('review status and sorting count ratings and tag edits, not just favorites', async () => {
  const saved = new Map();
  const items = [entry(1), entry(2), entry(3)];
  const { root, api } = fixture(items, {
    getFeedback: track => saved.get(track.id) || {},
    onFeedback: (track, change) => saved.set(track.id, { ...saved.get(track.id), ...change })
  });
  api.open();
  saved.set(items[0].id, { favorite: true, rating: 10 });
  saved.set(items[1].id, { addedTags: ['scenic'], editedAt: Date.now() });
  api.refresh();
  const review = tag(cls(root, 'sq-extra-advanced')[0].children[4], 'select')[0];
  const names = () => cls(root, 'sq-extra-card').map(card => tag(card, 'h3')[0].textContent);
  review.value = 'edited'; await review.dispatch('change');
  assert.deepEqual(names(), ['Track 01', 'Track 02']);
  review.value = 'not-edited'; await review.dispatch('change');
  assert.deepEqual(names(), ['Track 03']);
  const sort = tag(field(root, 'Sort'), 'select')[0];
  review.value = 'all'; await review.dispatch('change');
  sort.value = 'edited-first'; await sort.dispatch('change');
  assert.equal(names()[0], 'Track 01');
  sort.value = 'unedited-first'; await sort.dispatch('change');
  assert.equal(names()[0], 'Track 03');
  api.destroy();
});

test('tag filter reports vocabulary size and disables unused options without hiding them from tag editing', async () => {
  const { root, api } = fixture([entry(1, { tags: ['technical', 'difficulty-7', 'slide'] })], {
    getFeedback: () => ({}), onFeedback: () => {}
  });
  api.open();
  const tagField = cls(root, 'sq-extra-advanced')[0].children[1];
  const select = tag(tagField, 'select')[0];
  const scenic = [...select.children].find(option => option.value === 'scenic');
  assert.equal(scenic.disabled, true);
  assert.equal(cls(tagField, 'sq-extra-filter-count')[0].textContent, `${select.children.length - 1} Tags`);
  assert.equal([...select.children].some(option => option.value === 'slide'), false);
  await click(cls(root, 'sq-extra-more')[0]);
  assert.equal(cls(root, 'sq-extra-tag-choice').length, 0, 'opening the three-dot menu does not eagerly create tag buttons');
  await click(tag(cls(root, 'sq-extra-tag-picker')[0], 'summary')[0]);
  assert.ok(cls(root, 'sq-extra-tag-choice').some(choice => choice.textContent === 'Add Scenic'), 'unused valid tags remain addable in reviewer controls');
  api.destroy();
});

test('source counts, suggested tags and the submission dialog stay together', async () => {
  const { root, api } = fixture([entry(1), entry(2), entry(3)]);
  api.open();
  const source = cls(root, 'sq-extra-advanced')[0].children[0].children.find(node => node.tagName === 'SELECT');
  assert.match(source.textContent, /Kacky \(2\)/);
  assert.match(source.textContent, /Community \(1\)/);
  const modal = cls(root, 'sq-extra-submission-modal')[0];
  assert.equal(modal.hidden, true);
  await click(cls(root, 'sq-extra-submit')[0]);
  assert.equal(modal.hidden, false);
  assert.match(cls(root, 'sq-extra-tag-suggestions')[0].textContent, /technical/i);
  await click(cls(root, 'sq-extra-submission-close')[0]);
  assert.equal(modal.hidden, true);
  api.destroy();
});

test('submission explains an API failure and keeps the fallback available', async () => {
  const { root, api } = fixture([entry(1)], { onSubmit: async () => { throw Error('You already submitted a track today.'); } });
  api.open();
  await click(cls(root, 'sq-extra-submit')[0]);
  const fields = cls(root, 'sq-extra-submission-field');
  fields[0].children[0].value = 'Test track';
  fields[1].children[0].value = 'Tester';
  fields[3].children[0].value = 'PolyTrack' + 'A'.repeat(24);
  cls(root, 'sq-extra-submission-check')[0].children[0].checked = true;
  await click(cls(root, 'sq-extra-send')[0]);
  assert.match(cls(root, 'sq-extra-submission-status')[0].textContent, /already submitted a track today/);
  assert.equal(cls(root, 'sq-extra-fallback')[0].href.includes('docs.google.com'), true);
  api.destroy();
});

test('search, source, tag, curated and completion filters combine and refresh reads new PBs', () => {
  const entries = [entry(1), entry(2), entry(3, { tier: 'Curated', tags: ['technical', 'curated'] })];
  const best = new Map([['track-3', { timeMs: 61234, place: 2 }]]);
  const { root, api } = fixture(entries, { getPersonalBest: item => best.get(item.id) });
  api.open();
  const fields = cls(root, 'sq-extra-field');
  const search = tag(field(root, 'Search tracks'), 'input')[0];
  const source = tag(field(root, 'Source'), 'select')[0];
  const tagSelect = tag(field(root, 'Tag'), 'select')[0];
  const completion = tag(field(root, 'Progress'), 'select')[0];
  source.value = 'Kacky'; source.dispatch('change');
  tagSelect.value = 'technical'; tagSelect.dispatch('change');
  completion.value = 'completed'; completion.dispatch('change');
  assert.equal(cls(root, 'sq-extra-count')[0].textContent, '1 of 3 tracks');
  assert.match(cls(root, 'sq-extra-facts')[0].textContent, /Best 1:01.234/);
  const curated = tag(cls(root, 'sq-extra-check').find(label => label.textContent === 'Curated only'), 'input')[0];
  curated.checked = true; curated.dispatch('change');
  assert.equal(cls(root, 'sq-extra-card').length, 1);
  search.value = 'no such track'; search.dispatch('input');
  assert.equal(cls(root, 'sq-extra-count')[0].textContent, '0 of 3 tracks');
  search.value = ''; search.dispatch('input');
  best.delete('track-3'); api.refresh();
  assert.equal(cls(root, 'sq-extra-count')[0].textContent, '0 of 3 tracks');
  completion.value = 'uncompleted'; completion.dispatch('change');
  assert.equal(cls(root, 'sq-extra-count')[0].textContent, '1 of 3 tracks');
  entries.push(entry(4, { source: 'Kacky', tags: ['technical'], tier: 'Curated' }));
  api.refresh();
  assert.equal(cls(root, 'sq-extra-count')[0].textContent, '2 of 4 tracks');
});

test('search ranks exact titles, prefixes, token matches and generic substrings while preserving selected-sort ties', () => {
  const entries = [
    entry(1, { name: 'Saturn Ring', author: 'a' }),
    entry(2, { name: 'The Great Turn', author: 'c' }),
    entry(3, { name: 'Turn Right', author: 'z' }),
    entry(4, { name: 'turn', author: 'd' }),
    entry(5, { name: 'Turn Ahead', author: 'a' }),
    entry(6, { name: 'Turn from Saturn', author: 'b' })
  ];
  const { root, api } = fixture(entries);
  api.open();
  const fields = cls(root, 'sq-extra-field');
  const search = tag(field(root, 'Search tracks'), 'input')[0];
  const sort = tag(field(root, 'Sort'), 'select')[0];
  sort.value = 'author'; sort.dispatch('change');
  search.value = 'TURN'; search.dispatch('input');
  const names = () => cls(root, 'sq-extra-card').map(card => tag(card, 'h3')[0].textContent);
  assert.deepEqual(names(), ['turn', 'Turn Ahead', 'Turn from Saturn', 'Turn Right', 'The Great Turn', 'Saturn Ring']);

  search.value = ''; search.dispatch('input');
  assert.deepEqual(names(), ['Saturn Ring', 'Turn Ahead', 'Turn from Saturn', 'The Great Turn', 'turn', 'Turn Right']);
  assert.equal(sort.value, 'author', 'clearing search keeps the selected sort');
  api.destroy();
});

test('difficulty and imported-only progress filter independently of tags', () => {
  const entries = [entry(1, { difficulty: 2, tags: ['speed'] }), entry(2, { difficulty: 7, tags: ['speed'] }), entry(3, { difficulty: 7, tags: ['technical'] })];
  const { root, api } = fixture(entries, { isLoaded: item => item.id === 'track-2' });
  api.open();
  const fields = cls(root, 'sq-extra-field');
  const difficulty = tag(field(root, 'Catalog level'), 'select')[0];
  const progress = tag(field(root, 'Progress'), 'select')[0];
  difficulty.value = '7'; difficulty.dispatch('change');
  progress.value = 'loaded'; progress.dispatch('change');
  assert.equal(cls(root, 'sq-extra-count')[0].textContent, '1 of 3 tracks');
  assert.match(cls(root, 'sq-extra-card')[0].textContent, /Track 02/);
  assert.match(cls(root, 'sq-extra-card')[0].textContent, /Catalog level 7\/10 · Expert/);
  assert.equal(cls(field(root, 'Catalog level'), 'sq-extra-filter-count')[0].textContent, '2');
  assert.equal(cls(field(root, 'Progress'), 'sq-extra-filter-count')[0].textContent, '1');
  assert.match(cls(root, 'sq-extra-card')[0].textContent, /Imported, not completed/);
});

test('page shortcuts work outside text fields and clamp to the last page', () => {
  const { root, document, api } = fixture(Array.from({ length: 26 }, (_, i) => entry(i + 1)));
  api.open();
  const keydown = document.listeners.get('keydown');
  cls(root, 'sq-extra-close')[0].focus();
  keydown({ key: '2', code: 'Digit2', shiftKey: true, preventDefault() {} });
  assert.match(cls(root, 'sq-extra-pagination')[0].textContent, /Page 2 of 3/);
  keydown({ key: 'ArrowRight', code: 'ArrowRight', preventDefault() {} });
  assert.match(cls(root, 'sq-extra-pagination')[0].textContent, /Page 3 of 3/);
  keydown({ key: 'a', code: 'KeyA', preventDefault() {} });
  assert.match(cls(root, 'sq-extra-pagination')[0].textContent, /Page 2 of 3/);
});

test('sort, callbacks and attribution use the original entry and safe links', async () => {
  const dangerous = entry(1, { name: '<img src=x onerror=alert(1)>', author: '<script>bad</script>', sourceUrl: 'javascript:alert(1)', thumbnailUrl: 'data:image/svg+xml,<svg onload=alert(1)>' });
  const popular = entry(2, { sourcePlays: 1000, thumbnailUrl: '/thumb.png' });
  const played = [];
  const { root, api } = fixture([dangerous, popular], { onPlay: async item => { played.push(item); } });
  api.open();
  const sort = tag(field(root, 'Sort'), 'select')[0];
  assert.match(sort.textContent, /Plays/);
  assert.doesNotMatch(sort.textContent, /Most chosen/);
  sort.value = 'plays'; sort.dispatch('change');
  assert.match(cls(root, 'sq-extra-card')[0].textContent, /Track 02/);
  assert.equal(cls(root, 'sq-extra-visual').length, 1, 'cards without usable art omit the oversized preview panel');
  assert.equal(cls(root, 'sq-extra-visual')[0].children.filter(node => node.tagName === 'IMG').length, 1);
  assert.equal(cls(root, 'sq-extra-category')[0].textContent, 'Custom track', 'missing art keeps its category as a compact label');
  assert.match(cls(root, 'sq-extra-card')[1].textContent, /<script>bad<\/script>/);
  assert.equal(cls(root, 'sq-extra-source').length, 0);
  const submit = cls(root, 'sq-extra-submit')[0];
  await click(submit);
  const fallback = cls(root, 'sq-extra-fallback')[0];
  assert.equal(fallback.href, 'https://docs.google.com/forms/d/e/1FAIpQLSel-vg-VwzQuA2dRTEPoKiLIUgDvJ4bCvjMI8u4hqB33gkvrQ/viewform');
  assert.equal(fallback.rel, 'noopener noreferrer');
  assert.equal(cls(root, 'sq-extra-play')[0].textContent, 'Import and play');
  assert.equal(cls(root, 'sq-extra-save').length, 0);
  await click(cls(root, 'sq-extra-play')[0]);
  assert.equal(played[0], popular);
  assert.equal(cls(root, 'sq-extra-overlay')[0].hidden, true);
});

test('More retains administrative metadata while cards keep author credit searchable', async () => {
  const { root, api } = fixture([entry(1, {
    author: 'Site account', codeName: 'Code title', codeAuthor: 'Track maker',
    codeModifiedAt: '2026-09-17T10:25:36.000Z', sizeBytes: 16680
  })]);
  api.open();
  const card = cls(root, 'sq-extra-card')[0];
  assert.match(card.textContent, /By Track maker/);
  assert.match(card.textContent, /Source credit: Site account/);
  assert.doesNotMatch(card.textContent, /Modified|KB code/);
  await click(cls(root, 'sq-extra-more')[0]);
  const details = cls(root, 'sq-extra-track-details')[0];
  assert.match(details.textContent, /Modified .*2026/);
  assert.match(details.textContent, /16\.7 KB code/);
  const search = tag(field(root, 'Search tracks'), 'input')[0];
  search.value = 'Track maker'; search.dispatch('input');
  assert.equal(cls(root, 'sq-extra-card').length, 1);
  api.destroy();
});

test('oversized local challenge is visibly unranked while keeping the normal import action', () => {
  const { root, api } = fixture([entry(1, { ranked: false, name: 'Poly Dip 2', sizeBytes: 329716 })]);
  api.open();
  assert.equal(cls(root, 'sq-extra-card-unranked').length, 1);
  assert.match(cls(root, 'sq-extra-card')[0].textContent, /Unranked challenge · no RP or verification/);
  assert.match(cls(root, 'sq-extra-card')[0].textContent, /Finishes appear on an unranked leaderboard/);
  assert.equal(cls(root, 'sq-extra-play')[0].textContent, 'Import and play');
  api.destroy();
});

test('size sorting uses actual catalog byte sizes and keeps missing sizes last', () => {
  const entries = [
    entry(1, { name: 'Medium', sizeBytes: 20 }),
    entry(2, { name: 'Small', sizeBytes: 4 }),
    entry(3, { name: 'Large', sizeBytes: 80 }),
    entry(4, { name: 'Unknown' }),
    entry(5, { name: 'Invalid', sizeBytes: -1 })
  ];
  const { root, api } = fixture(entries);
  api.open();
  const sort = tag(field(root, 'Sort'), 'select')[0];
  assert.match(sort.textContent, /Track size/);
  assert.equal(sort.children.filter(option => option.value === 'size').length, 1);
  const names = () => cls(root, 'sq-extra-card').map(card => tag(card, 'h3')[0].textContent);
  sort.value = 'size-largest'; sort.dispatch('change');
  assert.deepEqual(names(), ['Large', 'Medium', 'Small', 'Invalid', 'Unknown']);
  sort.value = 'size-smallest'; sort.dispatch('change');
  assert.deepEqual(names(), ['Small', 'Medium', 'Large', 'Invalid', 'Unknown']);
  api.destroy();
});

test('size sorting is omitted when code byte sizes are unavailable', () => {
  const { root, api } = fixture([entry(1), entry(2, { sizeBytes: '12' }), entry(3, { sizeBytes: -1 })]);
  const sort = tag(field(root, 'Sort'), 'select')[0];
  assert.doesNotMatch(sort.textContent, /Track size/);
  api.destroy();
});

test('refresh updates data-dependent sort choices and falls back when selected data disappears', () => {
  const entries = [
    { id: 'track-a', name: 'Alpha', author: 'Tester' },
    { id: 'track-b', name: 'Bravo', author: 'Tester' }
  ];
  const { root, api } = fixture(entries);
  api.open();
  const sort = tag(field(root, 'Sort'), 'select')[0];
  assert.doesNotMatch(sort.textContent, /Track size|Plays|Forum activity|Track date/);

  entries[0].sizeBytes = 30;
  entries[1].sizeBytes = 10;
  entries[0].sourcePlays = 8;
  entries[0].sourceUpvotes = 2;
  entries[0].submittedAt = '2026-10-18T12:00:00Z';
  api.refresh();
  assert.match(sort.textContent, /Track size/);
  assert.match(sort.textContent, /Plays/);
  assert.match(sort.textContent, /Forum activity/);
  assert.match(sort.textContent, /Track date/);

  sort.value = 'size-largest'; sort.dispatch('change');
  assert.deepEqual(cls(root, 'sq-extra-card').map(card => tag(card, 'h3')[0].textContent), ['Alpha', 'Bravo']);
  entries[0].sizeBytes = undefined;
  entries[1].sizeBytes = undefined;
  api.refresh();
  assert.doesNotMatch(sort.textContent, /Track size/);
  assert.equal(sort.value, 'recommended', 'a removed sort capability does not leave a stale selected sort');
  api.destroy();
});

test('forum activity stays distinct from plays and missing signals sort last', () => {
  const entries = [
    entry(1, { name: 'Unrated', sourcePlays: null }),
    entry(2, { name: 'Liked', sourcePlays: null, sourceUpvotes: 8, sourceReplies: 1 }),
    entry(3, { name: 'Discussed', sourcePlays: null, sourceReplies: 4 })
  ];
  const { root, api } = fixture(entries);
  api.open();
  const sort = tag(field(root, 'Sort'), 'select')[0];
  assert.match(sort.textContent, /Forum activity/);
  sort.value = 'forum'; sort.dispatch('change');
  assert.deepEqual(cls(root, 'sq-extra-card').map(card => tag(card, 'h3')[0].textContent), ['Liked', 'Discussed', 'Unrated']);
  assert.match(cls(root, 'sq-extra-card')[0].textContent, /itch\.io: 8 likes · 1 reply/);
  assert.match(cls(root, 'sq-extra-card')[1].textContent, /itch\.io: 4 replies/);
  assert.doesNotMatch(cls(root, 'sq-extra-card')[0].textContent, /source plays/);
  api.destroy();
});

test('async callback failures stay visible without closing or throwing', async () => {
  const { root, api } = fixture([entry(1)], {
    onPlay: async () => { throw new Error('private importer detail'); }
  });
  api.open();
  await click(cls(root, 'sq-extra-play')[0]);
  assert.equal(cls(root, 'sq-extra-overlay')[0].hidden, false);
  assert.match(cls(root, 'sq-extra-status')[0].textContent, /Could not open this track/);
  assert.doesNotMatch(cls(root, 'sq-extra-status')[0].textContent, /private importer detail/);
  assert.equal(cls(root, 'sq-extra-overlay')[0].hidden, false);
  api.close();
  assert.equal(root.children.length, 1);
  api.open();
  assert.equal(cls(root, 'sq-extra-status')[0].hidden, true);
});

test('Import and play waits for the native importer before hiding', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const { root, api } = fixture([entry(1)], { onPlay: () => pending });
  api.open();
  const action = click(cls(root, 'sq-extra-play')[0]);
  assert.equal(cls(root, 'sq-extra-overlay')[0].hidden, false);
  assert.equal(cls(root, 'sq-extra-status')[0].textContent, 'Opening track...');
  finish();
  await action;
  assert.equal(cls(root, 'sq-extra-overlay')[0].hidden, true);
});

test('a late play completion cannot close a reopened catalog and pending actions explain themselves', async () => {
  const request = deferred();
  const { root, api } = fixture([entry(1)], { onPlay: () => request.promise });
  api.open();
  const pending = click(cls(root, 'sq-extra-play')[0]);
  api.close();
  api.open();

  await click(cls(root, 'sq-extra-play')[0]);
  assert.match(cls(root, 'sq-extra-status')[0].textContent, /Another request is still processing/);
  assert.equal(cls(root, 'sq-extra-overlay')[0].hidden, false);

  request.resolve();
  await pending;
  assert.equal(cls(root, 'sq-extra-overlay')[0].hidden, false, 'the old play action must not close the new catalog session');
  api.destroy();
});

test('track reports expose exactly three reasons and report clear success or failure', async () => {
  const reports = [];
  const { root, api } = fixture([entry(1)], { onReport: async (item, reason) => { reports.push([item, reason]); } });
  api.open();
  const more = cls(root, 'sq-extra-more')[0];
  assert.equal(cls(root, 'sq-extra-more-menu').length, 0, 'the disclosure is not mounted until its trigger opens');
  await click(more);
  assert.equal(cls(root, 'sq-extra-more-menu')[0].parent.className, 'sq-extra-card-menu-layer');
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  await click(cls(root, 'sq-extra-report-button')[0]);
  const modal = cls(root, 'sq-extra-report-modal')[0];
  const choices = cls(root, 'sq-extra-report-choice');
  assert.equal(modal.hidden, false);
  assert.deepEqual(choices.map(choice => choice.children[1].textContent), ['Inappropriate', 'Broken or unplayable', 'Incorrect credit']);
  assert.equal(tag(modal, 'input').length, 3);
  choices[2].children[0].checked = true;
  await click(cls(modal, 'sq-extra-report-send')[0]);
  assert.deepEqual(reports, [[entry(1), 'incorrect_credit']]);
  assert.match(cls(modal, 'sq-extra-report-status')[0].textContent, /Report received/);
  api.destroy();

  const failed = fixture([entry(2)], { onReport: async () => { throw Error('private detail'); } });
  failed.api.open();
  await click(cls(failed.root, 'sq-extra-more')[0]);
  await click(cls(failed.root, 'sq-extra-report-button')[0]);
  cls(failed.root, 'sq-extra-report-choice')[0].children[0].checked = true;
  await click(cls(failed.root, 'sq-extra-report-send')[0]);
  assert.match(cls(failed.root, 'sq-extra-report-status')[0].textContent, /Could not send/);
  assert.doesNotMatch(cls(failed.root, 'sq-extra-report-status')[0].textContent, /private detail/);
  failed.api.destroy();
});

test('report dialog Escape restores focus and catalog close clears nested dialog state', async () => {
  const { root, document, launch, api } = fixture([entry(1)], { onReport: async () => {} });
  api.open();
  const keydown = document.listeners.get('keydown');
  const parentDialog = cls(root, 'sq-extra-menu')[0];
  const more = cls(root, 'sq-extra-more')[0];
  assert.equal(parentDialog.getAttribute('aria-modal'), 'true');
  assert.equal(parentDialog.inert, false);
  await click(more);
  await click(cls(root, 'sq-extra-report-button')[0]);
  const report = cls(root, 'sq-extra-report-modal')[0];
  assert.equal(report.hidden, false);
  assert.equal(parentDialog.getAttribute('aria-modal'), 'false');
  assert.equal(parentDialog.inert, true);
  assert.equal(document.activeElement, cls(root, 'sq-extra-submission-close')[1]);
  keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(report.hidden, true);
  assert.equal(parentDialog.getAttribute('aria-modal'), 'true');
  assert.equal(parentDialog.inert, false);
  assert.equal(document.activeElement, more);

  await click(more);
  await click(cls(root, 'sq-extra-report-button')[0]);
  api.close();
  assert.equal(report.hidden, true);
  assert.equal(parentDialog.getAttribute('aria-modal'), 'true');
  assert.equal(parentDialog.inert, false);
  assert.equal(cls(root, 'sq-extra-overlay')[0].hidden, true);
  assert.equal(document.activeElement, launch);

  api.open();
  const submissionTrigger = cls(root, 'sq-extra-submit')[0];
  submissionTrigger.focus();
  await click(submissionTrigger);
  const submission = cls(root, 'sq-extra-submission-modal')[0];
  assert.equal(submission.hidden, false);
  assert.equal(parentDialog.getAttribute('aria-modal'), 'false');
  assert.equal(parentDialog.inert, true);
  keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(submission.hidden, true);
  assert.equal(parentDialog.getAttribute('aria-modal'), 'true');
  assert.equal(parentDialog.inert, false);
  assert.equal(document.activeElement, submissionTrigger);

  submissionTrigger.focus();
  await click(submissionTrigger);
  await click(cls(root, 'sq-extra-submission-close')[0]);
  assert.equal(submission.hidden, true);
  assert.equal(parentDialog.getAttribute('aria-modal'), 'true');
  assert.equal(parentDialog.inert, false);
  assert.equal(document.activeElement, submissionTrigger);

  await click(more);
  await click(cls(root, 'sq-extra-report-button')[0]);
  api.destroy();
  assert.equal(report.hidden, true);
  assert.equal(parentDialog.getAttribute('aria-modal'), 'true');
  assert.equal(parentDialog.inert, false);
  assert.equal(document.activeElement, launch);
  assert.equal(cls(root, 'sq-extra-overlay').length, 0);
});

test('late submission success or rejection cannot close or overwrite a reopened form', async () => {
  for (const outcome of ['resolve', 'reject']) {
    const request = deferred();
    let posts = 0;
    const { root, api } = fixture([entry(1)], { onSubmit: () => { posts++; return request.promise; } });
    api.open();
    await click(cls(root, 'sq-extra-submit')[0]);
    fillSubmission(root);
    const send = cls(root, 'sq-extra-send')[0];
    const pending = click(send);
    await Promise.resolve();
    assert.equal(posts, 1);
    const modal = cls(root, 'sq-extra-submission-modal')[0];
    await click(cls(modal, 'sq-extra-submission-close')[0]);
    await click(cls(root, 'sq-extra-submit')[0]);
    assert.equal(modal.hidden, false);
    assert.equal(send.disabled, true);
    await click(send);
    assert.equal(posts, 1, 'reopening cannot duplicate a pending submission');
    if (outcome === 'resolve') request.resolve();
    else request.reject(Error('stale submission failure'));
    await pending;
    assert.equal(modal.hidden, false, 'late completion leaves the newer form open');
    assert.equal(send.disabled, false);
    assert.doesNotMatch(cls(root, 'sq-extra-submission-status')[0].textContent, /received for review|stale submission failure|Could not send/);
    api.destroy();
  }
});

test('late report success or rejection cannot overwrite a different reopened track report', async () => {
  for (const outcome of ['resolve', 'reject']) {
    const request = deferred();
    let postedEntry;
    const entries = [entry(1), entry(2)];
    const { root, api } = fixture(entries, { onReport: item => { postedEntry = item; return request.promise; } });
    api.open();
    const cards = cls(root, 'sq-extra-card');
    await click(cls(cards[0], 'sq-extra-more')[0]);
    await click(cls(root, 'sq-extra-report-button')[0]);
    const modal = cls(root, 'sq-extra-report-modal')[0];
    cls(root, 'sq-extra-report-choice')[0].children[0].checked = true;
    const pending = click(cls(root, 'sq-extra-report-send')[0]);
    await Promise.resolve();
    assert.equal(postedEntry, entries[0]);
    await click(cls(modal, 'sq-extra-submission-close')[0]);
    await click(cls(cards[1], 'sq-extra-more')[0]);
    await click(cls(root, 'sq-extra-report-button')[0]);
    assert.equal(cls(root, 'sq-extra-report-entry')[0].textContent, entries[1].name);
    if (outcome === 'resolve') request.resolve();
    else request.reject(Error('stale report failure'));
    await pending;
    assert.equal(modal.hidden, false, 'late completion leaves the newer report open');
    assert.equal(cls(root, 'sq-extra-report-entry')[0].textContent, entries[1].name);
    assert.doesNotMatch(cls(root, 'sq-extra-report-status')[0].textContent, /Report received|stale report failure|Could not send/);
    assert.equal(cls(root, 'sq-extra-report-send')[0].disabled, false);
    api.destroy();
  }
});

test('cross-type requests disable both send controls and restore them when the request settles', async () => {
  {
    const request = deferred();
    let submissions = 0, reports = 0;
    const { root, api } = fixture([entry(1)], {
      onSubmit: () => { submissions++; return request.promise; },
      onReport: async () => { reports++; }
    });
    api.open();
    await click(cls(root, 'sq-extra-submit')[0]);
    fillSubmission(root);
    const submitPending = click(cls(root, 'sq-extra-send')[0]);
    await Promise.resolve();
    await click(cls(root, 'sq-extra-submission-close')[0]);
    const more = cls(root, 'sq-extra-more')[0];
    await click(more);
    await click(cls(root, 'sq-extra-report-button')[0]);
    const reportSend = cls(root, 'sq-extra-report-send')[0];
    assert.equal(cls(root, 'sq-extra-send')[0].disabled, true);
    assert.equal(reportSend.disabled, true);
    assert.match(cls(root, 'sq-extra-report-status')[0].textContent, /Another request is still processing/);
    cls(root, 'sq-extra-report-choice')[0].children[0].checked = true;
    await click(reportSend);
    assert.equal(reports, 0, 'the other request lock prevents a duplicate cross-type post');
    request.resolve();
    await submitPending;
    assert.equal(reportSend.disabled, false);
    assert.equal(cls(root, 'sq-extra-send')[0].disabled, false);
    assert.equal(cls(root, 'sq-extra-report-status')[0].hidden, true);
    assert.equal(submissions, 1);
    api.destroy();
  }

  {
    const request = deferred();
    let submissions = 0, reports = 0;
    const { root, api } = fixture([entry(1)], {
      onSubmit: async () => { submissions++; },
      onReport: () => { reports++; return request.promise; }
    });
    api.open();
    const more = cls(root, 'sq-extra-more')[0];
    await click(more);
    await click(cls(root, 'sq-extra-report-button')[0]);
    cls(root, 'sq-extra-report-choice')[0].children[0].checked = true;
    const reportPending = click(cls(root, 'sq-extra-report-send')[0]);
    await Promise.resolve();
    await click(cls(root, 'sq-extra-submission-close')[0]);
    await click(cls(root, 'sq-extra-submit')[0]);
    fillSubmission(root);
    const send = cls(root, 'sq-extra-send')[0];
    assert.equal(send.disabled, true);
    assert.equal(cls(root, 'sq-extra-report-send')[0].disabled, true);
    assert.match(cls(root, 'sq-extra-submission-status')[0].textContent, /Another request is still processing/);
    await click(send);
    assert.equal(submissions, 0, 'the other request lock prevents a duplicate cross-type post');
    request.resolve();
    await reportPending;
    assert.equal(send.disabled, false);
    assert.equal(cls(root, 'sq-extra-report-send')[0].disabled, false);
    assert.equal(cls(root, 'sq-extra-submission-status')[0].textContent, '');
    assert.equal(reports, 1);
    api.destroy();
  }
});

test('empty entries still mount and show an accurate zero count', () => {
  const { root, api } = fixture([]);
  api.open();
  assert.equal(cls(root, 'sq-extra-count')[0].textContent, '0 of 0 tracks');
  assert.equal(cls(root, 'sq-extra-card').length, 0);
  assert.match(tag(cls(root, 'sq-extra-empty')[0], 'h3')[0].textContent, /No extra tracks/);
  assert.equal(cls(root, 'sq-extra-empty')[0].getAttribute('aria-live'), 'polite');
  api.refresh();
  assert.equal(cls(root, 'sq-extra-count')[0].textContent, '0 of 0 tracks');
});

test('art previews are compact, and failed thumbnails collapse to a category label', async () => {
  const { root, api } = fixture([
    entry(1, { thumbnailUrl: '/preview.png', category: 'Community track' }),
    entry(2, { category: 'Custom track' })
  ]);
  api.open();
  const card = cls(root, 'sq-extra-card')[0];
  const visual = cls(card, 'sq-extra-visual')[0];
  assert.match(visual.getAttribute('style'), /height:clamp\(76px,14vw,132px\)/);
  assert.equal(cls(root, 'sq-extra-visual').length, 1, 'no preview frame is reserved when no thumbnail exists');
  assert.equal(cls(root, 'sq-extra-category').find(node => node.parent === cls(root, 'sq-extra-card')[1].children.at(-1)).hidden, false);
  await tag(visual, 'img')[0].dispatch('error');
  assert.equal(cls(root, 'sq-extra-visual').length, 0, 'broken art removes its panel instead of leaving a blank frame');
  assert.equal(cls(root, 'sq-extra-category')[0].hidden, false);
  assert.equal(cls(root, 'sq-extra-category')[0].textContent, 'Community track');
  api.destroy();
});

test('advanced filter count tracks active groups and excludes search', async () => {
  const { root, api } = fixture([entry(1), entry(2)]);
  api.open();
  const toggle = cls(root, 'sq-extra-advanced-toggle')[0];
  const fields = cls(root, 'sq-extra-field');
  assert.equal(toggle.textContent, 'Filters');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false', 'desktop starts uncluttered');
  assert.equal(toggle.hidden, false, 'desktop disclosure stays discoverable');
  await click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  const search = tag(field(root, 'Search tracks'), 'input')[0];
  search.value = 'track'; await search.dispatch('input');
  assert.equal(toggle.textContent, 'Filters', 'search is not counted as an advanced group');
  const source = tag(field(root, 'Source'), 'select')[0];
  source.value = 'Kacky'; await source.dispatch('change');
  assert.equal(toggle.textContent, 'Filters (1)');
  const sort = tag(field(root, 'Sort'), 'select')[0];
  sort.value = 'name'; await sort.dispatch('change');
  assert.equal(toggle.textContent, 'Filters (1)', 'the always-visible sort is not counted as a hidden filter');
  await click(cls(root, 'sq-extra-clear')[0]);
  assert.equal(toggle.textContent, 'Filters', 'reset clears the active-group count');
  api.destroy();
});

test('multiple tags combine, and empty results offer a reset', async () => {
  const { document, root, api } = fixture([
    entry(1, { tags: ['technical', 'speed'] }),
    entry(2, { tags: ['technical'] }),
    entry(3, { tags: ['speed'] })
  ]);
  api.open();
  const tagFilter = tag(field(root, 'Tag'), 'select')[0];
  tagFilter.value = 'technical'; await tagFilter.dispatch('change');
  tagFilter.value = 'speed'; await tagFilter.dispatch('change');
  assert.deepEqual(cls(root, 'sq-extra-card').map(card => tag(card, 'h3')[0].textContent), ['Track 01']);
  assert.equal(cls(root, 'sq-extra-selected-tag').length, 2);
  const search = tag(field(root, 'Search tracks'), 'input')[0];
  search.value = 'not here'; await search.dispatch('input');
  assert.equal(cls(root, 'sq-extra-card').length, 0);
  await click(cls(root, 'sq-extra-clear')[0]);
  assert.equal(cls(root, 'sq-extra-card').length, 3);
  assert.equal(cls(root, 'sq-extra-selected-tag').length, 0);
  assert.equal(document.activeElement, search, 'clearing empty results restores focus to search');
  assert.equal(search.focusOptions.preventScroll, true, 'restoring focus does not scroll the menu');
  api.destroy();
});

test('track date sorting uses submission dates and puts undated tracks last', async () => {
  const { root, api } = fixture([
    entry(1, { codeModifiedAt: '2026-09-20T00:00:00Z' }),
    entry(2, { codeModifiedAt: null, submittedAt: '2026-09-25T00:00:00Z', featuredSubmission: true }),
    entry(3, { codeModifiedAt: '2026-09-23T00:00:00Z' }),
    entry(4, { codeModifiedAt: null })
  ]);
  api.open();
  const sort = tag(field(root, 'Sort'), 'select')[0];
  const names = () => cls(root, 'sq-extra-card').map(card => tag(card, 'h3')[0].textContent);
  sort.value = 'date-newest'; await sort.dispatch('change');
  assert.deepEqual(names(), ['Track 02', 'Track 03', 'Track 01', 'Track 04']);
  sort.value = 'date-oldest'; await sort.dispatch('change');
  assert.deepEqual(names(), ['Track 01', 'Track 03', 'Track 02', 'Track 04']);
  api.destroy();
});

test('Escape closes menu and CSS defines narrow responsive layout', () => {
  const { document, root, api } = fixture([entry(1, { thumbnailUrl: '/preview.png' })]);
  api.open();
  document.listeners.get('keydown')({ key: 'Escape', preventDefault() {} });
  assert.equal(cls(root, 'sq-extra-overlay')[0].hidden, true);
  const css = fs.readFileSync(new URL('./catalog.css', import.meta.url), 'utf8');
  assert.match(css, /@media\(max-width:560px\)/);
  assert.match(css, /@media\(max-width:850px\)/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.match(css, /\.sq-extra-overlay\[hidden\]\{display:none!important\}/);
  assert.match(css, /\.sq-extra-visual img\{[^}]*object-fit:contain/);
  assert.match(css, /\.sq-extra-visual img\{[^}]*width:100%;height:100%/);
  assert.doesNotMatch(css, /\.sq-extra-visual img\{[^}]*transform:/);
  assert.match(css, /\.sq-extra-title-row/);
  assert.match(css, /\.sq-extra-more-menu\[hidden\]\{display:none\}/);
  assert.match(css, /\.sq-extra-grid\{[^}]*gap:12px/);
  assert.match(css, /\.sq-extra-card\{[^}]*linear-gradient/);
  assert.match(css, /\.sq-extra-menu \.sq-extra-tag-picker summary:focus-visible\{outline:3px solid #fff2a3/);
  assert.ok(css.includes('@media(max-width:560px),(pointer:coarse){.sq-extra-more-menu .sq-extra-picks{grid-template-columns:44px 44px;gap:8px}.sq-extra-more-menu button:has(.sq-extra-vote-icon){min-width:44px;min-height:44px}.sq-extra-review-done,.sq-extra-review-reset,.sq-extra-tag-picker summary,.sq-extra-tag-search,.sq-extra-tag-choice{min-height:44px}.sq-extra-review-ratings .sq-extra-rating select{min-height:44px}.sq-extra-more-menu .sq-extra-menu-favorite,.sq-extra-more-menu .sq-extra-report-button{min-height:44px}}'));
  const image = cls(root, 'sq-extra-visual')[0].children.find(node => node.tagName === 'IMG');
  assert.equal(image.loading, 'lazy');
  assert.equal(image.decoding, 'async');
  assert.equal(image.fetchPriority, 'low');
});

test('separate mounts use distinct accessible title targets', () => {
  const first = fixture([]);
  const second = fixture([]);
  const firstDialog = cls(first.root, 'sq-extra-menu')[0];
  const secondDialog = cls(second.root, 'sq-extra-menu')[0];
  assert.notEqual(firstDialog.getAttribute('aria-labelledby'), secondDialog.getAttribute('aria-labelledby'));
  assert.equal(firstDialog.getAttribute('aria-labelledby'), tag(firstDialog, 'h2')[0].id);
  first.api.destroy(); second.api.destroy();
});

test('card feedback dropdown is portaled out of card flow and closes on Escape or outside click', async () => {
  const {root, document, api} = fixture([entry(1), entry(2)], {
    getFeedback: () => ({}), onFeedback: () => {}
  });
  api.open();
  const more = cls(root, 'sq-extra-more')[0];
  await click(more);
  const menu = cls(root, 'sq-extra-more-menu')[0];
  assert.equal(menu.parent.className, 'sq-extra-card-menu-layer');
  assert.equal(menu.getAttribute('role'), 'dialog');
  assert.equal(menu.getAttribute('aria-modal'), undefined, 'the floating dialog is nonmodal');
  assert.equal(cls(root, 'sq-extra-card-body').some(body => body.children.includes(menu)), false);
  assert.equal(more.getAttribute('aria-expanded'), 'true');
  document.listeners.get('keydown')({key: 'Escape', preventDefault() {}});
  assert.equal(menu.hidden, true);
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  await click(more);
  document.listeners.get('click')({target: document.createElement('div')});
  assert.equal(cls(root, 'sq-extra-more-menu').length, 0, 'outside click removes the floating menu');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  api.destroy();
});

test('recommended player submissions put TMNF tracks last and show no collection launcher',()=>{
 const {root,api}=fixture([
  entry(1,{name:'A01',featuredSubmission:true,packId:'tmnf-ab',packName:'TMNF',submissionOrder:1}),
  entry(2,{name:'Zebra',featuredSubmission:true}),
  entry(3,{name:'Normal',featuredSubmission:false})
 ],{onOpenPack:()=>{throw Error('Removed collection button must not call this');}});
 api.open();
 assert.deepEqual(cls(root,'sq-extra-card').map(card=>tag(card,'h3')[0].textContent),['Zebra','A01','Normal']);
 assert.equal(cls(root,'sq-extra-pack-open').length,0);assert.equal(cls(root,'sq-extra-pack-links').length,0);
 api.destroy();
});

test('all local review signals filter and sort consistently after changes and reset',async()=>{
 const items=Array.from({length:8},(_,i)=>entry(i+1));
 const feedback=[{}, {rating:8}, {difficultyRating:6}, {vote:-1}, {addedTags:['mini']}, {removedTags:['speed']}, {favorite:true}, {}];
 const {root,api}=fixture(items,{getFeedback:e=>feedback[items.indexOf(e)],getLocalRating:e=>feedback[items.indexOf(e)].rating,
  getPersonalBest:e=>e===items[7]?1234:null,isLoaded:e=>e===items[7]});api.open();
 const fields=cls(root,'sq-extra-field'),review=tag(field(root, 'Review status'),'select')[0],sort=tag(field(root, 'Sort'),'select')[0];
 const names=()=>cls(root,'sq-extra-card').map(c=>tag(c,'h3')[0].textContent);
 review.value='edited';await review.dispatch('change');assert.deepEqual(names(),['Track 02','Track 03','Track 04','Track 05','Track 06']);
 assert.equal(cls(root,'sq-extra-review-field')[0].children.at(-1).textContent,'5');
 review.value='not-edited';await review.dispatch('change');assert.deepEqual(names(),['Track 01','Track 07','Track 08']);
 review.value='all';await review.dispatch('change');sort.value='edited-first';await sort.dispatch('change');assert.equal(names()[0],'Track 02');
 sort.value='my-rating';await sort.dispatch('change');assert.equal(names()[0],'Track 02');
 feedback[0]={rating:10};api.refresh();assert.equal(names()[0],'Track 01');
 feedback[0]={rating:0};api.refresh();assert.equal(names()[0],'Track 02');
 review.value='edited';await review.dispatch('change');const source=tag(field(root, 'Source'),'select')[0];source.value='Community';await source.dispatch('change');
 assert.deepEqual(names(),['Track 02','Track 04','Track 06']);
 await click(tag(root,'button').find(b=>b.textContent==='Reset filters'));assert.equal(names().length,8);assert.equal(review.value,'all');api.destroy();
});


test('published reviews are independent of local activity and combine reviewed filters, ordering and reset', async () => {
  const entries = JSON.parse(fs.readFileSync(new URL('./catalog.json', import.meta.url), 'utf8')).slice(0, 3);
  let writes = 0;
  const local = {rating: 1, difficultyRating: 2};
  const {root, api} = fixture(entries, {getFeedback: e => e === entries[0] ? local : {}, onFeedback: () => {writes++;}});
  api.open();
  const firstSort = tag(field(root, 'Sort'), 'select')[0];
  firstSort.value = 'review-quality-high'; await firstSort.dispatch('change');
  assert.match(cls(root, 'sq-extra-reviewed')[0].textContent, /Rating 9\/10Difficulty 7\/10/);
  assert.match(cls(root, 'sq-extra-my-review')[0].textContent, /My rating 1\/10 · My difficulty 2\/10/);
  assert.equal(cls(root, 'sq-extra-reviewed')[0].getAttribute('aria-label'), 'Published rating and difficulty');
  const fields = cls(root, 'sq-extra-field');
  const select = caption => tag(fields.find(field => field._text === caption), 'select')[0];
  const names = () => cls(root, 'sq-extra-card').map(card => tag(card, 'h3')[0].textContent);
  select('Sort').value = 'review-quality-low'; await select('Sort').dispatch('change');
  assert.deepEqual(names(), [entries[1].name, entries[2].name, entries[0].name]);
  select('Sort').value = 'review-quality-high'; await select('Sort').dispatch('change');
  assert.deepEqual(names(), [entries[0].name, entries[2].name, entries[1].name]);
  select('Rating').value = '6'; await select('Rating').dispatch('change');
  assert.deepEqual(names(), [entries[0].name, entries[2].name]);
  assert.equal(fields.find(field => field._text === 'Rating').children.at(-1).textContent, '2 tracks');
  select('Votes').value = 'positive'; await select('Votes').dispatch('change');
  assert.deepEqual(names(), [entries[2].name]);
  await click(cls(root, 'sq-extra-clear')[0]);
  select('Difficulty').value = '7'; await select('Difficulty').dispatch('change');
  assert.deepEqual(names(), [entries[0].name]);
  await click(cls(root, 'sq-extra-clear')[0]);
  select('Review status').value = 'edited'; await select('Review status').dispatch('change');
  assert.deepEqual(names(), [entries[0].name], 'only the personal score counts as local review');
  select('Review status').value = 'not-edited'; await select('Review status').dispatch('change');
  assert.equal(names().length, 2, 'published reviews do not become personal activity');
  assert.equal(writes, 0); assert.deepEqual(local, {rating: 1, difficultyRating: 2});
  api.destroy();
});

test('reviewed missing scores remain last in either direction and unknown identities stay unrated', async () => {
  const known = JSON.parse(fs.readFileSync(new URL('./catalog.json', import.meta.url), 'utf8')).slice(0, 2);
  const missing = entry(99, {trackId: 'f'.repeat(64)});
  const {root, api} = fixture([...known, missing]); api.open();
  const sort = tag(field(root, 'Sort'), 'select')[0];
  for (const value of ['review-quality-high', 'review-quality-low', 'review-difficulty-high', 'review-difficulty-low', 'review-votes-high', 'review-votes-low']) {
    sort.value = value; await sort.dispatch('change');
    assert.equal(tag(cls(root, 'sq-extra-card').at(-1), 'h3')[0].textContent, missing.name);
  }
  const review = tag(field(root, 'Review status'), 'select')[0];
  review.value = 'no-published'; await review.dispatch('change');
  assert.equal(cls(root, 'sq-extra-reviewed').length, 0);
  assert.equal(cls(root, 'sq-extra-card').length, 1);
  api.destroy();
});


test('review sort labels stay short while the selected control exposes the full meaning', async () => {
  const entries = JSON.parse(fs.readFileSync(new URL('./catalog.json', import.meta.url), 'utf8')).slice(0, 3);
  const {root, api} = fixture(entries); api.open();
  const sort = tag(field(root, 'Sort'), 'select')[0];
  for (const [value, label, description] of [
    ['review-quality-high','Rating','Published ratings, highest first (10 to 1)'],
    ['review-quality-low','Rating','Published ratings, lowest first (1 to 10)'],
    ['review-difficulty-high','Difficulty','Published difficulty, hardest first (10 to 1)'],
    ['review-difficulty-low','Difficulty','Published difficulty, easiest first (1 to 10)'],
    ['review-votes-high','Votes','Published net votes, highest first'],
    ['review-votes-low','Votes','Published net votes, lowest first']
  ]) {
    const metric = value.replace(/-(high|low)$/, '');
    const option = sort.children.find(child => child.value === metric);
    assert.equal(option.textContent, label);assert.ok(label.length <= 20);
    sort.value = value; await sort.dispatch('change');
    assert.equal(sort.value, metric, 'legacy directional choices migrate to one metric');
    assert.equal(sort.title, description);assert.equal(sort.getAttribute('aria-description'), description);
  }
  sort.value = 'recommended'; await sort.dispatch('change');
  assert.equal(sort.getAttribute('aria-description'), undefined);api.destroy();
});


test('all game windows default collapsed with an accessible disclosure',()=>{
  for (const [width,height,compact] of [[1366,600,true],[1366,650,true],[1366,651,false],[600,900,true],[601,900,false],[844,320,true],[1920,1080,false]]) {
    const {root,api,document}=fixture([entry(1)],{}, {width,height});api.open();
    const advanced=cls(root,'sq-extra-advanced')[0],toggle=cls(root,'sq-extra-advanced-toggle')[0];
    assert.equal(advanced.hidden,true,width+'x'+height);assert.equal(advanced.inert,true);
    assert.equal(toggle.hidden,false);assert.equal(toggle.getAttribute('aria-expanded'),'false');
    assert.equal(toggle.getAttribute('aria-controls'),advanced.id);
    api.destroy();assert.equal(document.mediaListeners.size,0);
  }
});

test('short-window disclosure exposes all filters, preserves chosen counts, focus and resize state',async()=>{
  const {root,api,document}=fixture([entry(1),entry(2)],{}, {width:1366,height:600});api.open();
  const advanced=cls(root,'sq-extra-advanced')[0],toggle=cls(root,'sq-extra-advanced-toggle')[0];
  await click(toggle);assert.equal(advanced.hidden,false);assert.equal(advanced.inert,false);
  const source=tag(field(root, 'Source'),'select')[0];source.value='Kacky';await source.dispatch('change');
  source.focus();await click(toggle);
  assert.equal(advanced.hidden,true);assert.equal(toggle.textContent,'Filters (1)');
  assert.equal(document.activeElement,toggle,'collapsing cannot strand focus in hidden controls');
  api.refresh();api.close();api.open();assert.equal(advanced.hidden,true);assert.equal(toggle.textContent,'Filters (1)');
  document.resizeTo(1366,900);assert.equal(advanced.hidden,true);assert.equal(toggle.hidden,false);
  document.resizeTo(1366,650);assert.equal(advanced.hidden,true);assert.equal(toggle.hidden,false);
  await click(toggle);document.resizeTo(1920,1080);document.resizeTo(844,320);
  assert.equal(advanced.hidden,false,'an explicitly expanded compact layout survives a resize');
  assert.equal(source.value,'Kacky');assert.equal(toggle.textContent,'Filters (1)');api.destroy();
});

test('filter CSS uses a compact natural grid with no obsolete explicit row assignments',()=>{
  const css=fs.readFileSync(new URL('./catalog.css',import.meta.url),'utf8');
  assert.match(css,/sq-extra-controls>\.sq-extra-advanced\[hidden\]\{display:none\}/);
  assert.ok(css.includes('grid-template-columns:repeat(4,minmax(0,1fr))'));
  assert.ok(css.includes('.sq-extra-advanced>.sq-extra-field{grid-column:auto;grid-row:auto;min-width:0}'));
});

test('Static credit is modest, query-scoped and loads one optional square logo',async()=>{
 const {root,api}=fixture([entry(1)]);api.open();
 const search=tag(cls(root,'sq-extra-search-field')[0],'input')[0];
 const sunshine=cls(root,'sq-extra-static')[0],cleaner=cls(root,'sq-extra-cleaner')[0];
 assert.equal(sunshine.hidden,true);assert.equal(tag(sunshine,'img').length,0);
 for(const query of ['Static','STATIC','credits']){
  search.value=query;await search.dispatch('input');
  assert.equal(sunshine.hidden,false);assert.equal(sunshine.textContent,'StaticI build and maintain Ranked. Thanks for playing.');
  assert.equal(tag(sunshine,'img').length,1);assert.equal(cls(root,'sq-extra-empty').length,0);
  assert.equal(cleaner.hidden,query!=='credits');
 }
 const logo=tag(sunshine,'img')[0];
 assert.equal(logo.src,'https://cdn.jsdelivr.net/gh/StaticQuasar931/Images@main/squarestaticquasar931logo.jpg');
 assert.equal(logo.alt,'');assert.equal(logo.width,64);assert.equal(logo.height,64);
 await logo.dispatch('error');assert.equal(logo.hidden,true);
 api.refresh();assert.equal(tag(sunshine,'img')[0],logo);assert.equal(logo.hidden,true);
 search.value='static noise';await search.dispatch('input');assert.equal(sunshine.hidden,true);
 assert.equal(cls(root,'sq-extra-empty').length,1);
 search.value='window cleaner';await search.dispatch('input');assert.equal(sunshine.hidden,true);assert.equal(cleaner.hidden,false);
 api.destroy();
});

test('published cards retain grades without the redundant vote tally',()=>{
 const rows=JSON.parse(fs.readFileSync(new URL('./catalog.json',import.meta.url),'utf8')).slice(0,3);
 const {root,api}=fixture(rows);api.open();
 assert.ok(cls(root,'sq-extra-reviewed-quality').length);
 assert.ok(cls(root,'sq-extra-reviewed-difficulty').length);
 assert.equal(cls(root,'sq-extra-reviewed-votes').length,0);
 assert.doesNotMatch(cls(root,'sq-extra-grid')[0].textContent,/Votes:.*up.*down/);
 api.destroy();
});

test('direction toggles keep unknown local ratings last, refresh correctly and reset to fixed recommendation', async () => {
  const feedback = {1: {rating: 8}, 2: {rating: 3}, 3: {rating: 8}, 4: {}};
  const entries = [1, 2, 3, 4].map(n => entry(n, {name: ['Zulu', 'Beta', 'Alpha', 'Missing'][n - 1]}));
  const {root, api} = fixture(entries, {getFeedback: e => feedback[Number(e.id.split('-')[1])], getLocalRating: e => feedback[Number(e.id.split('-')[1])].rating});
  api.open();
  const sort = tag(field(root, 'Sort'), 'select')[0], direction = cls(root, 'sq-extra-sort-direction')[0];
  const names = () => cls(root, 'sq-extra-card').map(card => tag(card, 'h3')[0].textContent);
  assert.equal(direction.disabled, true);
  sort.value = 'my-rating'; await sort.dispatch('change');
  assert.deepEqual(names(), ['Alpha', 'Zulu', 'Beta', 'Missing']);
  assert.match(direction.getAttribute('aria-label'), /descending.*Switch to ascending/);
  await click(direction);
  assert.deepEqual(names(), ['Beta', 'Alpha', 'Zulu', 'Missing']);
  assert.match(direction.getAttribute('aria-label'), /ascending.*Switch to descending/);
  feedback[1].rating = 1; api.refresh();
  assert.deepEqual(names(), ['Zulu', 'Beta', 'Alpha', 'Missing']);
  api.close(); api.open();
  assert.match(direction.getAttribute('aria-label'), /ascending/);
  sort.value = 'name'; await sort.dispatch('change');
  assert.deepEqual(names(), ['Alpha', 'Beta', 'Missing', 'Zulu']);
  await click(direction);
  assert.deepEqual(names(), ['Zulu', 'Missing', 'Beta', 'Alpha']);
  await click(cls(root, 'sq-extra-clear')[0]);
  assert.equal(sort.value, 'recommended'); assert.equal(direction.disabled, true);
  api.destroy();
});

test('one choice per metric and direction changes reset pagination without changing active filters', async () => {
  const entries = Array.from({length: 26}, (_, i) => entry(i + 1, {tier: 'Curated', sizeBytes: i + 1}));
  const {root, api} = fixture(entries, {getFeedback: () => ({favorite: true})}); api.open();
  const sort = tag(field(root, 'Sort'), 'select')[0], direction = cls(root, 'sq-extra-sort-direction')[0];
  assert.equal(sort.children.filter(o => o.value === 'size').length, 1);
  assert.ok(sort.children.every(o => !/-(high|low|largest|smallest|newest|oldest|first)$/.test(o.value)));
  const favorites = tag(cls(root, 'sq-extra-quick-filters')[0], 'input')[0];
  favorites.checked = true; await favorites.dispatch('change');
  sort.value = 'size'; await sort.dispatch('change');
  await click(tag(cls(root, 'sq-extra-pagination')[0], 'button')[1]);
  assert.match(cls(root, 'sq-extra-pagination')[0].textContent, /Page 2 of 3/);
  await click(direction);
  assert.match(cls(root, 'sq-extra-pagination')[0].textContent, /Page 1 of 3/);
  assert.equal(tag(cls(root, 'sq-extra-card')[0], 'h3')[0].textContent, entries[0].name);
  assert.equal(favorites.checked, true);
  assert.equal(cls(root, 'sq-extra-count')[0].textContent, '26 of 26 tracks');
  api.destroy();
});

test('published metric arrow toggles preserve missing-last ordering and filter counts', async () => {
  const entries = JSON.parse(fs.readFileSync(new URL('./catalog.json', import.meta.url), 'utf8')).slice(0, 3);
  const {root, api} = fixture([...entries, entry(99, {name: 'Unknown', trackId: 'f'.repeat(64)})]); api.open();
  const sort = tag(field(root, 'Sort'), 'select')[0], direction = cls(root, 'sq-extra-sort-direction')[0];
  const names = () => cls(root, 'sq-extra-card').map(card => tag(card, 'h3')[0].textContent);
  for (const metric of ['review-quality', 'review-difficulty', 'review-votes']) {
    sort.value = metric; await sort.dispatch('change');
    assert.equal(names().at(-1), 'Unknown');
    const descending = names();
    await click(direction); assert.equal(names().at(-1), 'Unknown');
    await click(direction); assert.deepEqual(names(), descending);
  }
  const quality = tag(field(root, 'Rating'), 'select')[0];
  quality.value = '6'; await quality.dispatch('change');
  const options = quality.textContent, filtered = [...names()].sort();
  await click(direction);
  assert.deepEqual([...names()].sort(), filtered); assert.equal(quality.textContent, options);
  assert.equal(cls(root, 'sq-extra-advanced-toggle')[0].textContent, 'Filters (1)');
  api.destroy();
});

test('Popular shows plain player counts from snapshots, distinguishes zero and unknown, and keeps the header unchanged', async () => {
  const ids = ['a', 'b', 'c', 'd', 'e'].map(char => char.repeat(64));
  const items = ids.map((trackId, i) => entry(i + 1, {trackId, sourceCopies: 999 - i}));
  const {root, api} = fixture(items); api.open();
  const header = cls(root, 'sq-extra-header')[0].textContent;
  const sort = tag(field(root, 'Sort'), 'select')[0];
  assert.equal(sort.children.find(option => option.value === 'popular').textContent, 'Popular');
  sort.value = 'popular'; await sort.dispatch('change');
  assert.match(cls(root, 'sq-extra-count')[0].textContent, /0 exact, 5 unknown/);
  assert.equal(api.setSnapshotStatistics({generation: 69, statistics: {schemaVersion: 1, complete: false, tracks: {
    [ids[0]]: {complete: true, count: 0, players: 0, totalEntries: 0},
    [ids[1]]: {complete: false, count: 99, players: null, totalEntries: 100},
    [ids[2]]: {complete: true, count: 7, players: 7, totalEntries: 7},
    [ids[3]]: {complete: true, count: 7, players: 7, totalEntries: 7}
  }}}), true);
  const names = () => cls(root, 'sq-extra-card').map(card => tag(card, 'h3')[0].textContent);
  assert.deepEqual(names(), ['Track 03', 'Track 04', 'Track 01', 'Track 02', 'Track 05']);
  assert.match(cls(root, 'sq-extra-count')[0].textContent, /3 exact, 2 unknown/);
  assert.deepEqual(cls(root, 'sq-extra-popularity').map(node => node.textContent), [
    '7 players', '7 players', '0 players', 'Player count unknown', 'Player count unknown']);
  await click(cls(root, 'sq-extra-sort-direction')[0]);
  assert.deepEqual(names(), ['Track 01', 'Track 03', 'Track 04', 'Track 02', 'Track 05']);
  assert.match(sort.getAttribute('aria-description'), /fewest first.*unknown coverage stays last/);
  assert.equal(cls(root, 'sq-extra-header')[0].textContent, header);
  api.destroy();
});

test('snapshot popularity is normalized once per generation, never during search, refresh, paging or reopen', async () => {
  const trackId = 'a'.repeat(64);
  const items = Array.from({length: 15}, (_, i) => entry(i + 1, {trackId: i ? 'b'.repeat(64) : trackId}));
  const {root, api} = fixture(items); let reads = 0;
  const statistics = {schemaVersion: 1, get tracks() {
    reads++; return {[trackId]: {complete: true, count: 8, players: 8, totalEntries: 8}};
  }};
  assert.equal(api.setSnapshotStatistics({generation: 69, statistics}), true);
  const afterLoad = reads; assert.equal(afterLoad, 1);
  api.open();
  const sort = tag(field(root, 'Sort'), 'select')[0];
  sort.value = 'popular'; await sort.dispatch('change');
  await click(tag(cls(root, 'sq-extra-pagination')[0], 'button')[1]);
  const search = tag(cls(root, 'sq-extra-search-field')[0], 'input')[0];
  for (const query of ['track', 'track 01', '']) {search.value = query; await search.dispatch('input');}
  api.refresh(); api.close(); api.open();
  assert.equal(api.setSnapshotStatistics({generation: 69, statistics}), false);
  assert.equal(api.setSnapshotStatistics({generation: 68, statistics}), false);
  assert.equal(reads, afterLoad);
  assert.match(cls(root, 'sq-extra-count')[0].textContent, /1 exact, 14 unknown/);
  assert.equal(api.setSnapshotStatistics({generation: 70, statistics: null}), true);
  assert.match(cls(root, 'sq-extra-count')[0].textContent, /0 exact, 15 unknown/);
  for (const generation of [undefined, NaN, -1, 70.1, '71']) assert.equal(api.setSnapshotStatistics({generation, statistics}), false);
  api.destroy();
  assert.equal(api.setSnapshotStatistics({generation: 71, statistics}), false);
  assert.equal(reads, afterLoad);
});

test('popularity labels handle singular, plural and unknown without implying live plays', async () => {
  const ids = ['a', 'b', 'c', 'd'].map(char => char.repeat(64));
  const {root, api} = fixture(ids.map((trackId, i) => entry(i + 1, {trackId})));
  api.setSnapshotStatistics({generation: 1, statistics: {schemaVersion: 1, tracks: {
    [ids[0]]: {complete: true, players: 1, count: 1, totalEntries: 1},
    [ids[1]]: {complete: true, players: 28, count: 28, totalEntries: 28},
    [ids[2]]: {complete: true, players: 0, count: 0, totalEntries: 0}
  }}});
  api.open();
  const sort = tag(field(root, 'Sort'), 'select')[0];
  sort.value = 'popular'; await sort.dispatch('change');
  const labels = cls(root, 'sq-extra-popularity');
  assert.deepEqual(labels.map(node => node.textContent), ['28 players', '1 player', '0 players', 'Player count unknown']);
  for (const label of labels) assert.match(label.title, /saved snapshot.*Not live plays/);
  const controls = cls(root, 'sq-extra-controls')[0];
  assert.equal(cls(root, 'sq-extra-search-field')[0].parent, controls);
  const toggle = cls(root, 'sq-extra-advanced-toggle')[0];
  assert.equal(toggle.parent, controls);
  assert.equal(toggle.getAttribute('aria-controls'), cls(root, 'sq-extra-advanced')[0].id);
  api.destroy();
});
