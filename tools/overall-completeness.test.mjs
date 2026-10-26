import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const start=source.indexOf('  function publishedOverallRanksExact('),end=source.indexOf('\n  }',start)+4;
const check=vm.runInNewContext('('+source.slice(start,end)+')',{MIN_RANKED_TRACKS:3,cleanUserId:id=>typeof id==='string'&&/^[a-f0-9]{64}$/.test(id)?id:''});
const row=(n,rank,raceCount,provisional=false)=>({userId:n.toString(16).padStart(64,'0'),rank,raceCount,provisional});
test('valid unranked provisional accounts do not make full standings incomplete',()=>{
 assert.equal(check([row(1,1,17),row(2,2,3),row(3,0,2,true),row(4,0,0,true)]),true);
 assert.equal(check([]),true);
});
test('eligible missing ranks and fabricated provisional flags still fail closed',()=>{
 for(const entries of [[row(1,0,3)],[row(1,0,3,true)],[row(1,1,2)],[row(1,1,2,true)],[row(1,0,2)],[row(1,0,-1,true)]])assert.equal(check(entries),false);
});
test('rank gaps, duplicate identities, invalid counts and misplaced provisional rows are not exact',()=>{
 for(const entries of [[row(1,1,3),row(2,3,4)],[row(1,1,3),row(1,2,4)],[row(1,0,1,true),row(2,1,3)],[row(1,1,3.5)]])assert.equal(check(entries),false);
 assert.equal(check(null),false);
});
test('coverage validator agrees with the unchanged authoritative qualification threshold',()=>{
 const worker=fs.readFileSync(new URL('../workers/ranked/src/index.js',import.meta.url),'utf8');
 assert.match(worker,/const MIN_RANKED_TRACKS = 3;/);
 assert.match(worker,/const rank = row.provisional \? 0 : \+\+ranked;/);
 assert.ok(source.includes('const ranksExact=Array.isArray(data.entries)&&data.entries.length===direct.length&&publishedOverallRanksExact(data.entries);'));
});
test('responsive list may shrink beneath legacy short-screen fixed heights without shrinking controls',()=>{
 const css=fs.readFileSync(new URL('../responsive-ui.css',import.meta.url),'utf8');
 const rules=css.match(/html body #overallLeaderboardPanel #overallLeaderboardList\s*\{[^}]*\}/g)?.join('')||'';
 assert.match(rules,/flex:\s*1 1 0\s*!important/);assert.match(rules,/min-height:\s*0\s*!important/);assert.match(rules,/max-height:\s*none\s*!important/);
 assert.match(css,/html body #overallLeaderboardPanel \.overall-shell\s*\{[^}]*overflow:\s*hidden\s*!important/);
});
