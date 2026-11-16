import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const from=source.indexOf('  function eventRpHighlightMarkup('),to=source.indexOf('\n  function ',from+1);
assert.ok(from>=0&&to>from);
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const render=new Function('escapeHtml',source.slice(from,to)+';return eventRpHighlightMarkup')(escape);
test('Event RP highlights show saved contribution and compact placement, not a time',()=>{
 const html=render({rp:1200,eventHighlights:[{name:'Rolling Hills Racer',eventRp:979,rank:5,fieldSize:100},{name:'Hydropower',eventRp:201,rank:3,fieldSize:20}]});
 assert.match(html,/Rolling Hills Racer<\/b> \+979 ERP · #5/);
 assert.match(html,/Hydropower<\/b> \+201 ERP · #3/);
 assert.doesNotMatch(html,/run .*old|00:/);
});
test('unknown placement stays unknown; invalid scores and HTML cannot fabricate highlights',()=>{
 assert.doesNotMatch(render({rp:5,eventHighlights:[{name:'Bad',eventRp:6,rank:1,fieldSize:1}]}),/Bad/);
 const html=render({rp:5,eventHighlights:[{name:'<img src=x>',eventRp:5,rank:null,fieldSize:null}]});
 assert.match(html,/&lt;img src=x&gt;/);assert.doesNotMatch(html,/<img|#|verified/);
 assert.equal(render({rp:5}), '');
});

test('Rolling Hills can show two finite highlights and no redundant verified-field wording',()=>{const html=render({rp:1200,eventHighlights:[{kind:'permanent',name:'Rolling Hills Racer',eventRp:900,rank:3,fieldSize:100},{kind:'weekly',name:'Summer 1',eventRp:200,rank:2,fieldSize:20},{kind:'daily',name:'Desert 1',eventRp:100,rank:1,fieldSize:10}]});assert.match(html,/Weekly Summer 1/);assert.match(html,/Daily Desert 1/);assert.doesNotMatch(html,/verified|\/ 100/);});
