import test from 'node:test';
import assert from 'node:assert/strict';
import {stampClientRelease} from './site-release.mjs';

const index = '<script src="polytrack_062_patch.js?v=44"></script>';
const patch = "const eventsModuleUrl=new URL('./events/client.mjs',base).href;const extraCatalogRevision='40';import('filter-menu.mjs?v=44');import('site-updates.mjs?v=44');installSiteUpdates({revision:44});";

test('responsive styles and viewport adapter advance together',()=>{
  const html=index+'<link href="responsive-ui.css?v=167"><link href="practice-responsive.css?v=167"><script type="module" src="tools/responsive-ui.mjs?v=167"></script>';
  const result=stampClientRelease(patch,html,168);
  for(const file of ['responsive-ui.css','practice-responsive.css','responsive-ui.mjs'])assert.ok(result.index.includes(file+'?v=168'));
});

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

test('event stylesheet and module preload use the same release as the client', () => {
  const html=index+'<link rel="stylesheet" href="./events/events.css" data-event-css><link rel="modulepreload" href="./events/client.mjs?v=43">';
  const result=stampClientRelease(patch,html,45);
  assert.match(result.index,/events\/events\.css\?v=45/);
  assert.match(result.index,/events\/client\.mjs\?v=45/);
  const next=stampClientRelease(result.patch,result.index,46);
  assert.match(next.index,/events\/events\.css\?v=46/);
  assert.match(next.index,/events\/client\.mjs\?v=46/);
});

test('placement module changes receive the client release cache key',()=>{
  const input=patch+"const placements=new URL('../tools/record-placement.mjs?v=109',eventsModuleUrl).href;";
  assert.match(stampClientRelease(input,index,110).patch,/record-placement\.mjs\?v=110/);
});

test('shared name-policy changes receive the same cache key as the client',()=>{
  const html='<script src="./public-name-policy.js?v=120"></script>'+index;
  const result=stampClientRelease(patch,html,122);
  assert.match(result.index,/public-name-policy\.js\?v=122/);
  assert.deepEqual(stampClientRelease(result.patch,result.index,122),result);
});

test('weekly menu adapter and metadata recovery use the current client release key',()=>{
 const input=patch+"import('./kodub-weekly.mjs');import('./tools/snapshot-metadata-recovery.mjs?v=142');";
 const result=stampClientRelease(input,index,143);
 assert.match(result.patch,/kodub-weekly\.mjs\?v=143/);assert.match(result.patch,/snapshot-metadata-recovery\.mjs\?v=143/);
});


test('native bundle catalog updates receive the same versioned client cache key',()=>{
 const result=stampClientRelease(patch,index+'<script src="./main.bundle.js"></script>',148);
 assert.match(result.index,/main\.bundle\.js\?v=148/);
 assert.match(stampClientRelease(result.patch,result.index,149).index,/main\.bundle\.js\?v=149/);
});

test('live snapshot page helper follows future release cache keys',()=>{
 const input=patch+"import('./tools/ranked-live-snapshot.mjs?v=149');";
 assert.match(stampClientRelease(input,index,150).patch,/ranked-live-snapshot\.mjs\?v=150/);
});

test('practice modules follow the client cache revision',()=>{
 const input=patch+"import('./tools/practice-history.mjs?v=153');import('./tools/practice-native.mjs?v=153');";
 const result=stampClientRelease(input,index,154);
 assert.match(result.patch,/practice-history\.mjs\?v=154/);assert.match(result.patch,/practice-native\.mjs\?v=154/);
});

test('local insights and embedded practice use the release cache key',()=>{const result=stampClientRelease(patch+"import('./tools/local-insights.mjs?v=155');import('./tools/practice-profile.mjs?v=155');",index,156);assert.match(result.patch,/local-insights\.mjs\?v=156/);assert.match(result.patch,/practice-profile\.mjs\?v=156/);});

test('future releases advance local observed revision tracking',()=>{const result=stampClientRelease(patch+'createLocalInsights({storage,revision:156});',index,157);assert.match(result.patch,/createLocalInsights\(\{storage,revision:157\}\)/);});

test('new local features advance coherently with future client revisions',()=>{
 const modules=['opponent-presets','control-usage','kodub-practice-track','overall-local-controller','overall-local-projection'];
 const input=patch+modules.map(name=>"import('./tools/"+name+".mjs?v=174');").join('');
 const result=stampClientRelease(input,index,175);
 for(const name of modules)assert.ok(result.patch.includes(name+'.mjs?v=175'));
 assert.deepEqual(stampClientRelease(result.patch,result.index,175),result);
});

test('Help module cache follows the next client revision',()=>{
 const result=stampClientRelease(patch+"import('../tools/help-controls.mjs?v=190');",index,999);
 assert.match(result.patch,/help-controls\.mjs\?v=999/);
});

test('central release metadata follows the client cache revision, not the manual number',()=>{
 const result=stampClientRelease(patch+"import('./tools/release-info.mjs?v=192');",index,193);
 assert.match(result.patch,/release-info\.mjs\?v=193/);
 assert.deepEqual(stampClientRelease(result.patch,result.index,193),result);
 assert.doesNotMatch(result.patch,/release-info\.mjs\?v=224/);
});
