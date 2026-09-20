const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const patchPath = process.env.POLYTRACK_PATCH_PATH || path.join(__dirname, '..', 'polytrack_062_patch.js');
const source = fs.readFileSync(patchPath, 'utf8');

function extract(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is present`);
  const parameters = source.indexOf('(', start);
  let parameterDepth = 0;
  let body = -1;
  for (let index = parameters; index < source.length; index += 1) {
    if (source[index] === '(') parameterDepth += 1;
    if (source[index] === ')' && --parameterDepth === 0) { body = source.indexOf('{', index); break; }
  }
  assert.notEqual(body, -1, `${name} body is present`);
  let depth = 0;
  for (let index = body; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}' && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`Could not extract ${name}`);
}

test('filter integration requires an exact complete public snapshot and source ranks', () => {
  const context = vm.createContext({
    overallEntriesCache: [{ rank: 1 }, { rank: 2 }],
    rankedFilterSnapshotMeta: null
  });
  vm.runInContext(`${extract('setRankedFilterSnapshotMeta')};${extract('rankedFilterCompleteness')};`, context);
  const exact = { complete: true, totalEntriesExact: true, totalEntries: 2, publishedEntries: 2, ranksExact: true };
  context.setRankedFilterSnapshotMeta(exact, 2);
  assert.equal(context.rankedFilterCompleteness('snapshot', context.overallEntriesCache), true);
  assert.equal(context.rankedFilterCompleteness('rank', context.overallEntriesCache), true);
  for (const key of ['complete', 'totalEntriesExact', 'publishedEntries', 'ranksExact']) {
    context.setRankedFilterSnapshotMeta({ ...exact, [key]: key === 'publishedEntries' ? 1 : false }, 2);
    assert.equal(context.rankedFilterCompleteness('snapshot', context.overallEntriesCache), false, key);
  }
});

test('Casual RP ranks known values high to low and leaves legacy values unranked', () => {
  const rows = [
    { userId: 'legacy', rank: 1, casualRp: null, casualCompletionCount: null },
    { userId: 'zero', rank: 2, casualRp: 0, casualCompletionCount: 0 },
    { userId: 'leader', rank: 3, casualRp: 300, casualCompletionCount: 3 }
  ];
  const context = vm.createContext({ overallCategory: 'casual', overallEntriesCache: rows });
  vm.runInContext(`${extract('sortedOverallEntries')};`, context);
  const sorted = context.sortedOverallEntries();
  assert.deepEqual(Array.from(sorted, row => row.userId), ['leader', 'zero', 'legacy']);
  assert.deepEqual(Array.from(sorted, row => row.categoryRank), [1, 2, null]);
  assert.deepEqual(Array.from(sorted, row => row.globalRank), [3, 2, 1]);
});

test('server achievement normalization keeps only bounded allowlisted proof summaries', () => {
  const context = vm.createContext({
    SERVER_COSMETIC_UNLOCK_IDS: new Set(['emblem:target', 'stripe:overdrive']),
    cleanUserId: value => String(value || '').trim().toLowerCase()
  });
  vm.runInContext(`${extract('safeServerInteger')};${extract('sanitizeServerAchievementProof')};${extract('sanitizeServerAchievements')};`, context);
  const proof = (cosmeticId, id, threshold) => ({
    id, threshold, cosmeticId, trackId: 'track-1', source: 'ranked-track-snapshot',
    sourceRevision: 7, sourceUpdatedAt: 8, sourceSignature: 'abcdefghijklmnop',
    playerTimeMs: 900, targetTimeMs: 1000, playerPbAt: 6, targetPbAt: 5, unlockedAt: 9
  });
  const normalized = context.sanitizeServerAchievements({ beatOwner: {
    targetAccountId: 'a'.repeat(64), count: 3,
    unlocks: [
      proof('emblem:target', 'beat-owner-1', 1),
      proof('stripe:overdrive', 'beat-owner-3', 3),
      proof('theme:forged', 'forged', 99)
    ]
  } });
  assert.equal(normalized.beatOwner.targetAccountId, 'a'.repeat(64));
  assert.equal(normalized.beatOwner.count, 3);
  assert.deepEqual(Array.from(normalized.beatOwner.unlocks, row => row.cosmeticId), ['emblem:target', 'stripe:overdrive']);
  assert.equal('ledger' in normalized.beatOwner, false);
});

test('source contract renders legacy Casual RP as unavailable and preserves exact metadata', () => {
  assert.match(source, /overallCategory==='casual'.*missingValue/s);
  assert.match(source, /visibleRank=overallCategory==='casual'&&missingValue\?null:rank/);
  assert.match(source, /totalEntriesExact:meta\.totalEntriesExact===true/);
  assert.match(source, /publishedEntries===entryCount/);
  assert.match(source, /totalPlaytimeMs: Number\.isFinite\(entry\.totalPlaytimeMs\).*\?entry\.totalPlaytimeMs:null/);
  assert.doesNotMatch(source, /\.casualScore|\.casualRank/);
});
