const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../polytrack_062_patch.js'), 'utf8');

test('category movements survive repeat views and reset only with changed standings', () => {
  const start = source.indexOf('  function annotateCategoryRanks(');
  const end = source.indexOf('  function sortedOverallEntries(', start);
  const storage = new Map();
  const context = vm.createContext({Date, cleanUserId: value => value,
    readJsonStorage: (key, fallback) => storage.get(key) || fallback,
    writeJsonStorage: (key, value) => storage.set(key, value)});
  vm.runInContext(source.slice(start, end), context);
  const run = ids => context.annotateCategoryRanks(ids.map(userId => ({userId})), 'wins');
  run(['a', 'b']);
  assert.equal(run(['b', 'a'])[0].categoryMovement, 1);
  assert.equal(run(['b', 'a'])[0].categoryMovement, 1);
  assert.equal(run(['a', 'b'])[0].categoryMovement, 1);
});

test('filter labels, notices, and profile actions keep explicit personal context', () => {
  assert.match(source, /active\?'Filters-Active':'Filters-Inactive'/);
  assert.doesNotMatch(source, /\['Only this racer'/);
  assert.match(source, /Racer profile · Filtered Results/);
  assert.match(source, /showNotice===false/);
  assert.match(source, /getRuleCounts:\(rows,filter\)/);
  assert.match(source, /groupScoreIncomplete\)return '<p class="profile-guide-empty">Not enough saved group results/);
});

test('the website update notice and entry-point cache revision match the published release', () => {
  const revision = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, '../site-version.json'), 'utf8')).revision;
  const index = fs.readFileSync(require('node:path').join(__dirname, '../index.html'), 'utf8');
  assert.ok(Number.isSafeInteger(revision));
  assert.ok(source.includes(`installSiteUpdates({revision:${revision}`));
  assert.ok(index.includes(`polytrack_062_patch.js?v=${revision}`));
});

test('track rule statistics use loaded times and distinguish partial fields', () => {
  const start = source.indexOf('  function personalFilterTracks(');
  const end = source.indexOf('  async function editPersonalRacer(', start);
  const context = vm.createContext({
    activeRankedAccountId: () => 'me',
    personalFilterDataSource: () => ({boards:[{trackId:'track',entries:[
      {accountId:'me',timeMs:3000},{accountId:'other',timeMs:1000},
      {accountId:'third',timeMs:2000}],complete:false,weight:2}]}),
    TRACK_CATALOG:new Map([['track',{name:'Track'}]]), extraTrackInfoById:new Map(),
    canonicalRaceTimeMs:row => row.timeMs
  });
  vm.runInContext(source.slice(start,end),context);
  const track=context.personalFilterTracks()[0];
  assert.equal(track.racerCount,3);
  assert.equal(track.bestTimeMs,1000);
  assert.equal(track.pbTimeMs,3000);
  assert.equal(track.meanTimeMs,2000);
  assert.equal(track.medianTimeMs,2000);
  assert.equal(track.complete,false);
});
