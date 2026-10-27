import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
const patch=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
test('Help uses the real bindings, configurable ghost key and current release metadata',()=>{
 const markup=patch.slice(patch.indexOf('  function rankedHelpMarkup('),patch.indexOf('  function ensurePanel('));
 const revision=JSON.parse(fs.readFileSync(new URL('../site-version.json',import.meta.url))).revision;
 for(const label of ['renderHelpControls','readHelpBindings','opponentShortcutLabel','revision:'+revision,'bindHelpControls'])assert.ok(markup.includes(label),label);
 assert.ok(patch.includes('void refreshRankedHelp(pop)'));
 assert.ok(fs.readFileSync(new URL('../index.html',import.meta.url),'utf8').includes('help-controls.css'));
});
test('obsolete Help filter listeners and unlock countdown are not installed',()=>{
 assert.doesNotMatch(patch,/function filterRankedHelp|data-help-clear|setInterval\(tickSnapshotCountdown/);
 assert.doesNotMatch(patch,/Live refresh unlocks in|live leaderboard refresh unlocks after 15 minutes/);
});

test('Overall has one status container, with no duplicate live-region ID',()=>{
 const shell=patch.slice(patch.indexOf('  function ensurePanel('),patch.indexOf('    void ensureRankedFiltersUi();',patch.indexOf('  function ensurePanel(')));
 assert.equal((shell.match(/id="overallDataNotice"/g)||[]).length,1);
 assert.doesNotMatch(shell,/insertAdjacentHTML\('beforebegin','<div id="overallDataNotice"/);
});
