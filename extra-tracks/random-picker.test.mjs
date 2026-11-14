import test from 'node:test';
import assert from 'node:assert/strict';
import {PICKER_PREFS_KEY, normalizePickerPrefs, readPickerPrefs, savePickerPrefs, eligibleRecords, chooseUniform} from './random-picker.mjs';
const record = (id, overrides = {}) => ({entry:{id}, level:null, published:{quality:null, difficulty:null}, rating:null, finishKnown:false, best:null, importKnown:false, loaded:false, ...overrides});
const ids = records => records.map(row => row.entry.id);
test('preferences whitelist values and discard unknown keys, arrays, inherited values and oversized payloads', () => {
 const defaults=normalizePickerPrefs(null);
 for (const value of [null, [], 3, 'bad', {pool:'remote', played:true, rating:8, imported:'nope'}]) assert.deepEqual(normalizePickerPrefs(value), defaults);
 assert.deepEqual(normalizePickerPrefs(Object.create({pool:'filtered'})), defaults);
 assert.deepEqual(normalizePickerPrefs({pool:'filtered', rating:'8', token:'secret'}), {...defaults,pool:'filtered',rating:'8'});
 for (const raw of ['{', '[]', 'x'.repeat(1025)]) assert.deepEqual(readPickerPrefs({getItem:()=>raw}),defaults);
});
test('safe storage writes only a small namespaced preference object without deletion', () => {
 const values=new Map([['existing-track', 'keep']]);
 const storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
 assert.equal(savePickerPrefs(storage,{pool:'filtered',imported:'yes',entries:Array(100).fill('track')}),true);
 assert.ok(values.get(PICKER_PREFS_KEY).length<250);
 assert.equal(values.get('existing-track'),'keep');
 assert.equal(readPickerPrefs(storage).imported,'yes');
 const blocked={getItem(){throw Error();},setItem(){throw Error();}};
 assert.equal(savePickerPrefs(blocked,{}),false);
 assert.equal(savePickerPrefs(null,{}),false);
 assert.equal(readPickerPrefs(blocked,{rating:'9'}).rating,'9');
 assert.equal(readPickerPrefs(null,{rating:'9'}).rating,'9');
});
test('catalog difficulty, published difficulty, quality and local ratings never substitute for each other', () => {
 const rows=[record('a',{level:2,published:{quality:8.5,difficulty:6.6},rating:3}),record('b',{level:7,published:{quality:3,difficulty:2},rating:9}),record('unknown')];
 assert.deepEqual(ids(eligibleRecords(rows,{level:'2'})),['a']);
 assert.deepEqual(ids(eligibleRecords(rows,{difficulty:'7'})),['a']);
 assert.deepEqual(ids(eligibleRecords(rows,{rating:'8'})),['a']);
 assert.deepEqual(ids(eligibleRecords(rows,{localRating:'9'})),['b']);
 assert.deepEqual(ids(eligibleRecords(rows,{level:'2',difficulty:'2'})),[]);
 assert.deepEqual(ids(eligibleRecords(rows,{rating:'unknown'})),['unknown']);
 assert.equal(eligibleRecords(rows,{}).length,3);
 for (const value of [0,11,NaN,Infinity,'8',undefined]) assert.equal(eligibleRecords([record('bad',{published:{quality:value}})],{rating:'unknown'}).length,1);
});
test('history filtering requires explicit known values and combines finish/import constraints', () => {
 const rows=[record('unknown'),record('finished',{finishKnown:true,best:1200,importKnown:true,loaded:true}),record('untouched',{finishKnown:true,importKnown:true}),record('partial',{finishKnown:true,best:0})];
 assert.deepEqual(ids(eligibleRecords(rows,{played:'yes'})),['finished']);
 assert.deepEqual(ids(eligibleRecords(rows,{played:'no'})),['untouched']);
 assert.deepEqual(ids(eligibleRecords(rows,{imported:'no'})),['untouched']);
 assert.deepEqual(ids(eligibleRecords(rows,{played:'yes',imported:'yes'})),['finished']);
 assert.deepEqual(ids(eligibleRecords(rows,{played:'no',imported:'yes'})),[]);
});
test('uniform selection covers every full-set index once per equal interval, with no empty sampling loop', () => {
 const rows=Array.from({length:137},(_,i)=>record(String(i)));
 assert.equal(chooseUniform([],()=>{throw Error('must not sample');}),null);
 assert.equal(chooseUniform([rows[0]],()=>0.999999),rows[0]);
 assert.deepEqual(rows.map((_,i)=>chooseUniform(rows,()=>(i+0.5)/rows.length)),rows);
 assert.equal(chooseUniform(rows,()=>0),rows[0]);
 assert.equal(chooseUniform(rows,()=>1-Number.EPSILON),rows.at(-1));
 for (const value of [-1,1,NaN,Infinity]) assert.throws(()=>chooseUniform(rows,()=>value),RangeError);
});
