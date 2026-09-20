import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sourceUrl = new URL('../polytrack_062_patch.js', import.meta.url);
let source;
try {
  source = readFileSync(sourceUrl, 'utf8');
} catch {
  source = readFileSync(new URL('./polytrack_062_patch.js', import.meta.url), 'utf8');
}

function sourceFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in the patch`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    else if (source[index] === '}' && --depth === 0) {
      return Function(`"use strict";return (${source.slice(start, index + 1)});`)();
    }
  }
  throw new Error(`Could not extract ${name}`);
}

const transition = sourceFunction('cosmeticPublishQueueTransition');
const backoff = sourceFunction('cosmeticPublishBackoff');
const identityMatches = sourceFunction('cosmeticPublishIdentityMatches');

function item(accountId, ownerUid, draftId, queuedAt) {
  return { accountId, ownerUid, draftId, queuedAt, cosmetics: { theme: draftId }, attempts: 0, nextAttemptAt: 0 };
}

test('cosmetic retry backoff is bounded at one hour', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 20].map(backoff), [15000, 60000, 300000, 900000, 3600000, 3600000]);
});

test('publish identity requires both the active account and bound auth UID', () => {
  const pending = item('account-a', 'uid-a', 'draft-a', 1);
  assert.equal(identityMatches(pending, 'account-a', 'uid-a'), true);
  assert.equal(identityMatches(pending, 'account-b', 'uid-a'), false);
  assert.equal(identityMatches(pending, 'account-a', 'uid-b'), false);
});

test('newest draft replaces the prior account draft and stale acknowledgements cannot clear it', () => {
  let state = transition(null, { type: 'queue', item: item('account-a', 'uid-a', 'old', 1) });
  state = transition(state, { type: 'queue', item: item('account-a', 'uid-a', 'new', 2) });
  assert.equal(state.entries['account-a'].draftId, 'new');

  state = transition(state, { type: 'ack', accountId: 'account-a', draftId: 'old' });
  assert.equal(state.entries['account-a'].draftId, 'new');
  state = transition(state, { type: 'failure', accountId: 'account-a', draftId: 'old', nextAttemptAt: 50, error: 'stale' });
  assert.equal(state.entries['account-a'].attempts, 0);

  state = transition(state, { type: 'failure', accountId: 'account-a', draftId: 'new', nextAttemptAt: 75, error: 'offline' });
  assert.equal(state.entries['account-a'].attempts, 1);
  assert.equal(state.entries['account-a'].nextAttemptAt, 75);
  state = transition(state, { type: 'ack', accountId: 'account-a', draftId: 'new' });
  assert.equal(state.entries['account-a'], undefined);
});

test('pending drafts remain account-scoped and storage is bounded to newest accounts', () => {
  let state = transition(null, { type: 'queue', item: item('account-a', 'uid-a', 'a', 1) }, 2);
  state = transition(state, { type: 'queue', item: item('account-b', 'uid-b', 'b', 2) }, 2);
  state = transition(state, { type: 'queue', item: item('account-c', 'uid-c', 'c', 3) }, 2);
  assert.deepEqual(Object.keys(state.entries).sort(), ['account-b', 'account-c']);
  assert.equal(state.entries['account-b'].ownerUid, 'uid-b');
  assert.equal(state.entries['account-c'].ownerUid, 'uid-c');
});
