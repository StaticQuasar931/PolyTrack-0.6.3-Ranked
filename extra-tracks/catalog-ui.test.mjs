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
    this.checked = false;
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  addEventListener(name, handler) { const list = this.listeners.get(name) || []; list.push(handler); this.listeners.set(name, list); }
  removeEventListener(name, handler) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== handler)); }
  dispatch(name, extra = {}) { return Promise.all((this.listeners.get(name) || []).map(handler => handler({ target: this, preventDefault() {}, ...extra }))); }
  focus() { this.document.activeElement = this; }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  querySelectorAll() { return walk(this).filter(node => ['BUTTON', 'INPUT', 'SELECT', 'A'].includes(node.tagName) && !node.disabled); }
}

function walk(node) { return node.children.flatMap(child => [child, ...walk(child)]); }
function cls(root, name) { return walk(root).filter(node => node.className?.split(' ').includes(name)); }
function tag(root, name) { return walk(root).filter(node => node.tagName === name.toUpperCase()); }
function click(node) { return node.dispatch('click'); }
function fixture(entries, callbacks = {}) {
  const document = { baseURI: 'https://polytrack.example/', activeElement: null, listeners: new Map() };
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

test('local picks toggle, rating changes and export callback stay device-scoped', async () => {
  const saved = new Map(), exported = [];
  const item = entry(1, { trackId: 'a'.repeat(64) });
  const { root, api } = fixture([item], {
    getFeedback: track => saved.get(track.trackId) || {},
    onFeedback: (track, change) => saved.set(track.trackId, { ...saved.get(track.trackId), ...change }),
    getLocalRating: track => saved.get(track.trackId)?.rating,
    onExportFeedback: () => exported.push(true)
  });
  api.open();
  await click(cls(root, 'sq-extra-pick')[0]);
  assert.equal(saved.get(item.trackId).favorite, true);
  await click(cls(root, 'sq-extra-pick')[0]);
  assert.equal(saved.get(item.trackId).favorite, false);
  await click(cls(root, 'sq-extra-pick')[1]);
  assert.equal(saved.get(item.trackId).vote, 1);
  await click(cls(root, 'sq-extra-pick')[2]);
  assert.equal(saved.get(item.trackId).vote, -1);
  const rating = tag(cls(root, 'sq-extra-rating')[0], 'select')[0];
  rating.value = '8'; await rating.dispatch('change');
  assert.equal(saved.get(item.trackId).rating, 8);
  await click(cls(root, 'sq-extra-export')[0]);
  assert.equal(exported.length, 1);
  api.destroy();
});

test('source counts, suggested tags and the submission dialog stay together', async () => {
  const { root, api } = fixture([entry(1), entry(2), entry(3)]);
  api.open();
  const source = cls(root, 'sq-extra-controls')[0].children[1].children.find(node => node.tagName === 'SELECT');
  assert.match(source.textContent, /Kacky \(2\)/);
  assert.match(source.textContent, /Community \(1\)/);
  const modal = cls(root, 'sq-extra-submission-modal')[0];
  assert.equal(modal.hidden, true);
  await click(cls(root, 'sq-extra-submit')[0]);
  assert.equal(modal.hidden, false);
  assert.match(cls(root, 'sq-extra-tag-suggestions')[0].textContent, /technical/);
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
  const search = tag(fields[0], 'input')[0];
  const source = tag(fields[1], 'select')[0];
  const tagSelect = tag(fields[2], 'select')[0];
  const completion = tag(fields[4], 'select')[0];
  source.value = 'Kacky'; source.dispatch('change');
  tagSelect.value = 'technical'; tagSelect.dispatch('change');
  completion.value = 'completed'; completion.dispatch('change');
  assert.equal(cls(root, 'sq-extra-count')[0].textContent, '1 of 3 tracks');
  assert.match(cls(root, 'sq-extra-facts')[0].textContent, /Best 1:01.234/);
  const curated = tag(cls(root, 'sq-extra-check')[0], 'input')[0];
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

test('difficulty and imported-only progress filter independently of style tags', () => {
  const entries = [entry(1, { difficulty: 2, tags: ['speed'] }), entry(2, { difficulty: 7, tags: ['speed'] }), entry(3, { difficulty: 7, tags: ['technical'] })];
  const { root, api } = fixture(entries, { isLoaded: item => item.id === 'track-2' });
  api.open();
  const fields = cls(root, 'sq-extra-field');
  const difficulty = tag(fields[3], 'select')[0];
  const progress = tag(fields[4], 'select')[0];
  difficulty.value = '7'; difficulty.dispatch('change');
  progress.value = 'loaded'; progress.dispatch('change');
  assert.equal(cls(root, 'sq-extra-count')[0].textContent, '1 of 3 tracks');
  assert.match(cls(root, 'sq-extra-card')[0].textContent, /Track 02/);
  assert.match(cls(root, 'sq-extra-card')[0].textContent, /Difficulty 7\/10 · Expert/);
  assert.equal(cls(fields[3], 'sq-extra-filter-count')[0].textContent, '2');
  assert.equal(cls(fields[4], 'sq-extra-filter-count')[0].textContent, '1');
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
  const sort = tag(cls(root, 'sq-extra-field')[5], 'select')[0];
  assert.match(sort.textContent, /Most plays/);
  assert.doesNotMatch(sort.textContent, /Most chosen/);
  sort.value = 'plays'; sort.dispatch('change');
  assert.match(cls(root, 'sq-extra-card')[0].textContent, /Track 02/);
  assert.equal(cls(root, 'sq-extra-visual')[0].children.filter(node => node.tagName === 'IMG').length, 1);
  assert.equal(cls(root, 'sq-extra-visual')[1].children.filter(node => node.tagName === 'IMG').length, 0);
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

test('code metadata, credits and actual byte sizes are visible and searchable', () => {
  const { root, api } = fixture([entry(1, {
    author: 'Site account', codeName: 'Code title', codeAuthor: 'Track maker',
    codeModifiedAt: '2026-09-17T10:25:36.000Z', sizeBytes: 16680
  })]);
  api.open();
  const card = cls(root, 'sq-extra-card')[0];
  assert.match(card.textContent, /By Track maker/);
  assert.match(card.textContent, /Source credit: Site account/);
  assert.match(card.textContent, /Modified .*2026/);
  assert.match(card.textContent, /16\.7 KB code/);
  const search = tag(cls(root, 'sq-extra-field')[0], 'input')[0];
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
  const sort = tag(cls(root, 'sq-extra-field')[5], 'select')[0];
  assert.match(sort.textContent, /Largest track/);
  assert.match(sort.textContent, /Smallest track/);
  const names = () => cls(root, 'sq-extra-card').map(card => tag(card, 'h3')[0].textContent);
  sort.value = 'size-largest'; sort.dispatch('change');
  assert.deepEqual(names(), ['Large', 'Medium', 'Small', 'Invalid', 'Unknown']);
  sort.value = 'size-smallest'; sort.dispatch('change');
  assert.deepEqual(names(), ['Small', 'Medium', 'Large', 'Invalid', 'Unknown']);
  api.destroy();
});

test('size sorting is omitted when code byte sizes are unavailable', () => {
  const { root, api } = fixture([entry(1), entry(2, { sizeBytes: '12' }), entry(3, { sizeBytes: -1 })]);
  const sort = tag(cls(root, 'sq-extra-field')[5], 'select')[0];
  assert.doesNotMatch(sort.textContent, /Largest code|Smallest code/);
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
  const sort = tag(cls(root, 'sq-extra-field')[5], 'select')[0];
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

test('track reports expose exactly three reasons and report clear success or failure', async () => {
  const reports = [];
  const { root, api } = fixture([entry(1)], { onReport: async (item, reason) => { reports.push([item, reason]); } });
  api.open();
  const more = cls(root, 'sq-extra-more')[0];
  assert.equal(cls(root, 'sq-extra-more-menu')[0].hidden, true);
  await click(more);
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
  const { root, document, api } = fixture([entry(1)], { onReport: async () => {} });
  api.open();
  const keydown = document.listeners.get('keydown');
  const more = cls(root, 'sq-extra-more')[0];
  await click(more);
  await click(cls(root, 'sq-extra-report-button')[0]);
  const report = cls(root, 'sq-extra-report-modal')[0];
  assert.equal(report.hidden, false);
  assert.equal(document.activeElement, cls(root, 'sq-extra-submission-close')[1]);
  keydown({ key: 'Escape', preventDefault() {} });
  assert.equal(report.hidden, true);
  assert.equal(document.activeElement, more);

  await click(more);
  await click(cls(root, 'sq-extra-report-button')[0]);
  keydown({ key: 'Escape', preventDefault() {} });
  keydown({ key: 'Escape', preventDefault() {} });
  api.open();
  assert.equal(report.hidden, true);
  assert.equal(cls(root, 'sq-extra-overlay')[0].hidden, false);
  api.destroy();
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
    await click(cls(cards[0], 'sq-extra-report-button')[0]);
    const modal = cls(root, 'sq-extra-report-modal')[0];
    cls(root, 'sq-extra-report-choice')[0].children[0].checked = true;
    const pending = click(cls(root, 'sq-extra-report-send')[0]);
    await Promise.resolve();
    assert.equal(postedEntry, entries[0]);
    await click(cls(modal, 'sq-extra-submission-close')[0]);
    await click(cls(cards[1], 'sq-extra-more')[0]);
    await click(cls(cards[1], 'sq-extra-report-button')[0]);
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
  assert.match(cls(root, 'sq-extra-empty')[0].textContent, /No extra tracks/);
  api.refresh();
  assert.equal(cls(root, 'sq-extra-count')[0].textContent, '0 of 0 tracks');
});

test('multiple styles combine, and empty results offer a reset', async () => {
  const { root, api } = fixture([
    entry(1, { tags: ['technical', 'speed'] }),
    entry(2, { tags: ['technical'] }),
    entry(3, { tags: ['speed'] })
  ]);
  api.open();
  const style = tag(cls(root, 'sq-extra-field')[2], 'select')[0];
  style.value = 'technical'; await style.dispatch('change');
  style.value = 'speed'; await style.dispatch('change');
  assert.deepEqual(cls(root, 'sq-extra-card').map(card => tag(card, 'h3')[0].textContent), ['Track 01']);
  assert.equal(cls(root, 'sq-extra-selected-tag').length, 2);
  const search = tag(cls(root, 'sq-extra-field')[0], 'input')[0];
  search.value = 'not here'; await search.dispatch('input');
  assert.equal(cls(root, 'sq-extra-card').length, 0);
  await click(cls(root, 'sq-extra-clear')[0]);
  assert.equal(cls(root, 'sq-extra-card').length, 3);
  assert.equal(cls(root, 'sq-extra-selected-tag').length, 0);
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
  const sort = tag(cls(root, 'sq-extra-field')[5], 'select')[0];
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
  assert.match(css, /\.sq-extra-visual img\{[^}]*width:calc\(100% - 28px\);height:calc\(100% - 24px\)/);
  assert.match(css, /\.sq-extra-grid\{[^}]*gap:12px/);
  assert.match(css, /\.sq-extra-card\{[^}]*linear-gradient/);
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
