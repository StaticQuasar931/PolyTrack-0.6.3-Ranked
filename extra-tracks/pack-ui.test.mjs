import test from 'node:test';
import assert from 'node:assert/strict';
import { mountTrackPack } from './pack-ui.mjs';

class FakeNode {
  constructor(document, tagName) {
    this.document = document;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this._text = '';
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name); }
  addEventListener(name, handler) { const list = this.listeners.get(name) || []; list.push(handler); this.listeners.set(name, list); }
  removeEventListener(name, handler) { this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item !== handler)); }
  dispatch(name, extra = {}) { return Promise.all((this.listeners.get(name) || []).map(handler => handler({ target: this, preventDefault() {}, ...extra }))); }
  focus() {
    this.document.activeElement = this;
    this.document.listeners.get('focusin')?.({ target: this });
  }
  contains(node) { return node === this || this.children.some(child => child.contains(node)); }
  querySelectorAll() { return walk(this).filter(node => ['BUTTON', 'INPUT'].includes(node.tagName) && !node.disabled); }
}

function walk(node) { return node.children.flatMap(child => [child, ...walk(child)]); }
function byClass(root, name) { return walk(root).filter(node => node.className?.split(' ').includes(name)); }
function buttons(root) { return walk(root).filter(node => node.tagName === 'BUTTON'); }
function buttonNamed(root, name) { return buttons(root).find(button => button.textContent === name); }
function fixture(entries, options = {}) {
  const document = { listeners: new Map(), createElement(name) { return new FakeNode(this, name); } };
  document.addEventListener = (name, handler) => document.listeners.set(name, handler);
  document.removeEventListener = (name, handler) => document.listeners.delete(name);
  const root = document.createElement('main');
  const opener = document.createElement('button');
  opener.focus();
  const api = mountTrackPack({ document, root, entries, pack: { name: 'TMNF A+B', authors: ['Pack authors'], tags: ['A', 'B'], difficulty: 'Mixed' }, onImport: async () => {}, ...options });
  return { document, root, opener, api };
}
const tracks = [{ name: 'Alpha', thumbnailUrl: '/alpha.png', codeAuthor: 'Native Alpha' }, { name: 'Beta', author: 'Native Beta' }];

test('renders accessible dialog, default selection, own previews and collective pack metadata separately', () => {
  const { root } = fixture(tracks);
  const dialog = byClass(root, 'pt-pack-dialog')[0];
  assert.equal(dialog.getAttribute('role'), 'dialog');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(byClass(root, 'pt-pack-checkbox').every(box => box.checked), true);
  assert.equal(byClass(root, 'pt-pack-thumbnail')[0].src, 'https://polytrack.local/alpha.png');
  assert.match(byClass(root, 'pt-pack-track-author')[0].textContent, /Native Alpha/);
  assert.match(byClass(root, 'pt-pack-collective')[0].textContent, /Pack authors.*A, B.*Mixed/);
  assert.equal(byClass(root, 'pt-pack-track-author').some(author => /Pack authors/.test(author.textContent)), false);
});

test('select all and none update the selected counter and import availability', async () => {
  const { root } = fixture(tracks);
  const all = buttonNamed(root, 'Select all');
  const none = buttonNamed(root, 'Select none');
  const importButton = buttonNamed(root, 'Import all 2');
  await none.dispatch('click');
  assert.equal(byClass(root, 'pt-pack-checkbox').some(box => box.checked), false);
  assert.equal(importButton.disabled, true);
  assert.equal(importButton.textContent, 'Import 0 selected');
  byClass(root, 'pt-pack-checkbox')[0].checked = true;
  await byClass(root, 'pt-pack-checkbox')[0].dispatch('change');
  assert.equal(importButton.textContent, 'Import 1 selected');
  await none.dispatch('click');
  await all.dispatch('click');
  assert.equal(byClass(root, 'pt-pack-checkbox').every(box => box.checked), true);
  assert.equal(importButton.disabled, false);
  assert.match(byClass(root, 'pt-pack-count')[0].textContent, /2 of 2/);
  assert.equal(importButton.textContent, 'Import all 2');
});

test('imports serially, continues after failure, blocks close while busy and reports results', async () => {
  let release;
  const order = [];
  const { root, document, api } = fixture(tracks, { onImport: async entry => {
    order.push(`start ${entry.name}`);
    if (entry.name === 'Alpha') await new Promise(resolve => { release = resolve; });
    order.push(`end ${entry.name}`);
    if (entry.name === 'Beta') throw new Error('expected test failure');
  } });
  const closeButton = buttonNamed(root, 'Close');
  const importButton = buttonNamed(root, 'Import all 2');
  const importing = importButton.dispatch('click');
  await Promise.resolve();
  assert.deepEqual(order, ['start Alpha']);
  assert.equal(closeButton.disabled, true);
  let escapePrevented = false;
  let escapeStopped = false;
  document.listeners.get('keydown')({
    key: 'Escape',
    preventDefault() { escapePrevented = true; },
    stopPropagation() { escapeStopped = true; }
  });
  assert.equal(escapePrevented, true);
  assert.equal(escapeStopped, true);
  assert.equal(root.children.length, 1);
  release();
  await importing;
  assert.deepEqual(order, ['start Alpha', 'end Alpha', 'start Beta', 'end Beta']);
  assert.match(byClass(root, 'pt-pack-status')[0].textContent, /Imported 1 of 2.*Beta/);
  assert.equal(root.children.length, 1);
  api.close();
  assert.equal(root.children.length, 0);
  assert.equal(document.listeners.size, 0);
});

test('Escape and explicit close remove overlay, restore focus and clean keyboard listeners', () => {
  const first = fixture(tracks);
  first.document.listeners.get('keydown')({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  assert.equal(first.root.children.length, 0);
  assert.equal(first.document.listeners.size, 0);
  assert.equal(first.document.activeElement, first.opener);

  const second = fixture(tracks);
  buttonNamed(second.root, 'Close').dispatch('click');
  assert.equal(second.root.children.length, 0);
  assert.equal(second.document.listeners.size, 0);
  assert.equal(second.document.activeElement, second.opener);
});

test('Tab stays inside the modal and outside focus returns to its close control', () => {
  const { document, root } = fixture(tracks);
  const dialog = byClass(root, 'pt-pack-dialog')[0];
  const focusable = dialog.querySelectorAll();
  const keydown = document.listeners.get('keydown');
  let prevented = false;

  focusable[0].focus();
  keydown({ key: 'Tab', shiftKey: true, preventDefault() { prevented = true; } });
  assert.equal(document.activeElement, focusable.at(-1));
  assert.equal(prevented, true);

  focusable.at(-1).focus();
  keydown({ key: 'Tab', preventDefault() { prevented = true; } });
  assert.equal(document.activeElement, focusable[0]);

  document.createElement('button').focus();
  assert.equal(document.activeElement, focusable[0]);
});

test('shows readable pack-level difficulty and a concise optional description', () => {
  const description = 'A'.repeat(220);
  const { root } = fixture(tracks, { pack: { difficulty: 4, description } });
  const collective = byClass(root, 'pt-pack-collective')[0].textContent;
  assert.match(collective, /Pack difficulty: 4 \/ 10 · Intermediate/);
  assert.match(collective, /About this pack: A{177}…/);
  assert.equal(collective.includes('A'.repeat(178)), false);
});
