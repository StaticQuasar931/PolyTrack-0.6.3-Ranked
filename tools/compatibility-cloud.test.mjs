import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const extract=name=>{const start=source.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));assert.ok(start>=0);return source.slice(start,source.indexOf('\n  }',start)+4);};
test('offline version gate blocks Firebase before SDK initialization and preserves local storage',async()=>{
 let loads=0;const c=vm.createContext({compatibilityOnlineAllowed:false,onlineServicePageAllowed:()=>true,Error,loadScript:()=>loads++,localStorage:{kept:'PB'}});
 vm.runInContext(extract('assertOnlineCompatibility')+'\n'+extract('db'),c);
 await assert.rejects(c.db(),e=>e.code==='client-version-offline');assert.equal(loads,0);assert.equal(c.localStorage.kept,'PB');
 c.compatibilityOnlineAllowed=true;assert.doesNotThrow(()=>c.assertOnlineCompatibility());
});
test('cloud URL gate matches configured services, not static snapshots or lookalike hosts',()=>{
 const c=vm.createContext({URL,window:{location:{href:'https://game.test/'},POLYTRACK_RANKED_BROKER_URL:'https://cloud.test/ranked/',POLYTRACK_TURN_BROKER_URL:'https://turn.test/'}});
 vm.runInContext(extract('compatibilityCloudTarget'),c);
 for(const url of ['https://cloud.test/ranked/v1/pb/notify','https://turn.test/v1/turn'])assert.equal(c.compatibilityCloudTarget(new URL(url)),true);
 for(const url of ['https://game.test/public-snapshots40/index.json','https://cloud.test/ranked-other','https://cloud.test.evil.test/ranked/v1','https://game.test/site-version.json'])assert.equal(c.compatibilityCloudTarget(new URL(url)),false);
});
test('installed version callback gates Worker fetches while keeping local legacy API interception',()=>{
 assert.match(source,/onCompatibilityChange:state=>\{compatibilityOnlineAllowed=state.onlineAllowed!==false&&onlineServicePageAllowed\(\);/);
 assert.match(source,/if\(compatibilityCloudTarget\(urlObj\)\)assertOnlineCompatibility\(\);\s*if \(shouldMock\(urlObj\)\)/);
 assert.match(source,/function rankedEdgeAvailable\(\)\{return compatibilityOnlineAllowed&&/);
});

test('copied clients check the allowlisted official policy rather than their stale manifest',()=>{assert.match(source,/endpoint:module\.CANONICAL_SITE_VERSION_URL/);});
