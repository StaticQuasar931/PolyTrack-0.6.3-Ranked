import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';

const source=await readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
function fn(name){const start=source.indexOf('  function '+name+'(');assert(start>=0);return source.slice(start,source.indexOf('\n  }',start)+4);}
test('snapshot-only freshness keeps its date label and offers only a static update check',()=>{
 const button={textContent:'Snapshot package · 13h old',title:'Published standings.',setAttribute(key,value){this[key]=value;}};
 const context=vm.createContext({snapshotOnlyForNewAccount:()=>true,snapshotUpdateChecking:false});
 vm.runInContext(fn('applyRankedRefreshCooldown'),context);context.applyRankedRefreshCooldown(button);
 assert.equal(button.disabled,false);assert.equal(button['aria-disabled'],'false');
 assert.equal(button['aria-label'],'Snapshot package · 13h old. Check for a newer published snapshot. No Firebase reads.');
 assert.doesNotMatch(button.textContent,/refresh|minute/i);
});
test('snapshot-only refresh entry delegates only to the static update check for every ranking',()=>{
 for(const category of ['overall','events','casual','tracks']){
  let updates=0;
  const context=vm.createContext({overallCategory:category,snapshotOnlyForNewAccount:()=>true,checkPublishedSnapshotUpdate:()=>{updates++;}});
  vm.runInContext(fn('requestRankedRefresh'),context);assert.equal(context.requestRankedRefresh(),undefined);assert.equal(updates,1);
 }
});
test('header claims local recalculation only for a visible score or placement difference',()=>{
 const context=vm.createContext({overallEntriesCache:[{userId:'racer',score:2.572,rank:3}],formatRp:value=>Number(value).toFixed(3)});
 vm.runInContext(fn('rankingProjectionChanged'),context);
 const check=row=>context.rankingProjectionChanged({racers:[{userId:'racer',score:2.572,projectedRank:3,...row}]});
 assert.equal(check({}),false);assert.equal(check({score:2.5720001}),false);
 assert.equal(check({score:2.402}),true);assert.equal(check({projectedRank:2}),true);
 assert.equal(check({userId:'new-racer',score:3}),false);assert.equal(check({projectedRank:null}),false);
});
