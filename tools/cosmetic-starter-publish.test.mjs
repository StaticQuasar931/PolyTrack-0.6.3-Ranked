import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import vm from 'node:vm';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
test('opening Studio does not convert Automatic to locked title or badge IDs',()=>{
 const start=source.indexOf('  function profileCustomizerMarkup('),end=source.indexOf('    const lockNote=',start);
 const c=vm.createContext({cleanUserId:x=>x,profileCosmeticDrafts:new Map(),profileCosmeticEntries:new Map(),cosmeticsForEntry:()=>({title:'auto',badge:'auto'}),sanitizeProfileCosmetics:x=>({...x})});
 vm.runInContext(source.slice(start,end)+'return current;}',c);const result=c.profileCustomizerMarkup({userId:'fresh',raceCount:0});
 assert.equal(result.title,'auto');assert.equal(result.badge,'auto');assert.equal(c.profileCosmeticDrafts.get('fresh').title,'auto');
});
test('explicit earned choices are preserved rather than silently substituted',()=>{
 const start=source.indexOf('  function profileCustomizerMarkup('),end=source.indexOf('    const lockNote=',start);
 const c=vm.createContext({cleanUserId:x=>x,profileCosmeticDrafts:new Map([['me',{title:'pbHunter',badge:'betaTester'}]]),profileCosmeticEntries:new Map(),sanitizeProfileCosmetics:x=>({...x})});
 vm.runInContext(source.slice(start,end)+'return current;}',c);const result=c.profileCustomizerMarkup({userId:'me'});assert.equal(result.title,'pbHunter');assert.equal(result.badge,'betaTester');
});
