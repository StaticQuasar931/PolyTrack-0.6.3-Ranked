import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {resolveCosmeticPreview,bindCosmeticPreview} from './cosmetic-preview.mjs';
const catalog={theme:[['blue','Blue',0],['gold','Gold',12]],title:[['racer','Racer','pb:25']],badge:[['beta','Beta','beta']]};

test('only one exact valid known catalog option resolves, without granting anything',()=>{
 const result=resolveCosmeticPreview(catalog,{kind:'theme',id:'gold'});assert.deepEqual(result,{kind:'theme',id:'gold',label:'Gold',requirement:12,previewOnly:true,unlocked:false});assert.ok(Object.isFrozen(result));
 for(const request of [null,{}, {kind:'__proto__',id:'gold'},{kind:'theme',id:'missing'},{kind:'unknown',id:'gold'},{kind:'theme',id:'gold extra'},{kind:'theme',id:{toString:()=> 'gold'}}])assert.equal(resolveCosmeticPreview(catalog,request),null);
});

test('a catalog default is still only a preview, never entitlement',()=>{assert.equal(resolveCosmeticPreview(catalog,{kind:'theme',id:'blue'}).unlocked,false);});

test('ambiguous, malformed and accessor catalog values fail closed',()=>{
 for(const value of [{theme:[['gold','A',1],['gold','B',2]]},{theme:[['gold','Gold',{}]]},{theme:[['gold',{},1]]},Object.create({theme:catalog.theme})])assert.equal(resolveCosmeticPreview(value,{kind:'theme',id:'gold'}),null);
 const source={};Object.defineProperty(source,'theme',{get(){throw Error('No accessor evaluation');}});assert.equal(resolveCosmeticPreview(source,{kind:'theme',id:'gold'}),null);
});

test('all actual catalog choices are supported without copying private data or unlock rules',()=>{
 const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');const literal=source.match(/const PROFILE_COSMETIC_OPTIONS=(\{[\s\S]*?\n  \});/)[1];const actual=JSON.parse(JSON.stringify(vm.runInNewContext('('+literal+')')));
 for(const [kind,options]of Object.entries(actual))for(const [id]of options)assert.ok(resolveCosmeticPreview(actual,{kind,id}),kind+':'+id);
});

test('binding rejects missing DOM/render ownership, and cannot inspect storage/drafts',()=>{
 assert.throws(()=>bindCosmeticPreview(null,{catalog,onPreview(){},onRestore(){}}),/Connected/);
 const source=fs.readFileSync(new URL('./cosmetic-preview.mjs',import.meta.url),'utf8');assert.doesNotMatch(source,/\b(fetch|localStorage|sessionStorage|indexedDB|Firestore)\s*[.(]/);assert.doesNotMatch(source,/\.(setItem|removeItem|clearStorage)\s*\(/);
});
