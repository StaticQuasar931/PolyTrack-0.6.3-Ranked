import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const from=source.indexOf('  function eventRpHighlightMarkup('),to=source.indexOf('\n  function ',from+1);
assert.ok(from>=0&&to>from);
const escape=value=>String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const render=new Function('escapeHtml',source.slice(from,to)+';return eventRpHighlightMarkup')(escape);
test('Event RP highlights show saved contribution and its verified placement, not a time',()=>{
 const html=render({rp:1200,eventHighlights:[{name:'Rolling Hills Racer',eventRp:979,rank:5,fieldSize:100},{name:'Hydropower',eventRp:201,rank:3,fieldSize:20}]});
 assert.match(html,/Rolling Hills Racer<\/b> \+979 ERP · #5 \/ 100 verified/);
 assert.match(html,/Hydropower<\/b> \+201 ERP · #3 \/ 20 verified/);
 assert.doesNotMatch(html,/run .*old|00:/);
});
test('unknown placement stays unknown; invalid scores and HTML cannot fabricate highlights',()=>{
 assert.doesNotMatch(render({rp:5,eventHighlights:[{name:'Bad',eventRp:6,rank:1,fieldSize:1}]}),/Bad/);
 const html=render({rp:5,eventHighlights:[{name:'<img src=x>',eventRp:5,rank:null,fieldSize:null}]});
 assert.match(html,/&lt;img src=x&gt;/);assert.doesNotMatch(html,/<img|#|verified/);
 assert.equal(render({rp:5}), '');
});
