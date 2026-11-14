import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {recommendAchievementTracks as recommend} from './achievement-recommendations.mjs';
const id = n => n.toString(16).padStart(64, '0');
const accountId = 'a'.repeat(64), day = '2026-11-14', at = Date.parse(day + 'T00:00:00Z');
const track = (n, difficulty = 2, extra = {}) => ({trackId:id(n),name:'Track '+n,difficulty,...extra});
const catalog = [...Array.from({length:20},(_,i)=>track(i+1,2)),
  ...Array.from({length:12},(_,i)=>track(i+21,7)), track(33,8),track(34,10)];
const base = {catalog,accountId,day,milestoneId:'tracks-35',snapshotComplete:true,profileFinishes:[]};
const finish = (n, extra = {}) => ({trackId:id(n),timeMs:12000,...extra});

test('cold/warm, catalog order and loaded-track noise cannot bias deterministic five',()=>{
 const cold=recommend(base),warm=recommend({...base,loadedTrackIds:[id(33)],recentlyLoaded:[id(21)]});
 assert.equal(cold.length,5);assert.deepEqual(warm,cold);
 assert.deepEqual(recommend({...base,catalog:[...catalog].reverse()}),cold);
 assert.deepEqual(recommend({...base,profileFinishes:[finish(1),finish(2)]}),
  recommend({...base,profileFinishes:[finish(2),finish(1),finish(1)]}));
});

test('day/account/milestone seeds are stable and vary similarly suitable choices',()=>{
 const first=recommend(base);assert.deepEqual(recommend({...base}),first);
 for(const change of [{day:'2026-11-15'},{accountId:'b'.repeat(64)},{milestoneId:'tracks-50'}])
  assert.notDeepEqual(recommend({...base,...change}).map(row=>row.trackId),first.map(row=>row.trackId));
});

test('unknown skill honestly chooses only beginners; successful rated completions match skilled tracks',()=>{
 const beginner=recommend(base);assert.ok(beginner.every(row=>row.difficulty<=3&&row.reason.includes('Skill unknown')));
 const skilled=recommend({...base,profileFinishes:[finish(21),finish(22)]});
 assert.equal(skilled.length,5);assert.ok(skilled.every(row=>row.difficulty>=5&&row.difficulty<=8));
 assert.ok(skilled.every(row=>!row.reason.includes('Skill unknown')));
 assert.deepEqual(recommend({...base,catalog:catalog.filter(row=>row.difficulty>=7)}),[]);
 const expert=recommend({...base,catalog:[track(50,10),track(51,10),track(52,10),track(53,9),track(54,8)],
  profileFinishes:[finish(50),finish(51)]});assert.ok(expert.every(row=>row.difficulty>=8));
});

test('local PB overlay changes played set and skill without inventing or comparing track times',()=>{
 const first=recommend(base),chosen=first[0].trackId;
 const next=recommend({...base,localPBs:[{trackId:chosen,bestMs:12345,lastPlayedAt:at}]});
 assert.ok(!next.some(row=>row.trackId===chosen));
 const skilled=recommend({...base,localPBs:[{trackId:id(21),bestMs:12345},{trackId:id(22),bestMs:99999}]});
 assert.ok(skilled.every(row=>row.difficulty>=5));
 assert.deepEqual(skilled,recommend({...base,localPBs:[{trackId:id(22),bestMs:1},{trackId:id(21),bestMs:999999}]}));
});

test('unplayed and non-recent choices outrank played/recent choices within suitable band',()=>{
 const input={...base,catalog:Array.from({length:9},(_,i)=>track(i+1)),profileFinishes:[finish(1),finish(2)],recentTrackIds:[id(3)]};
 assert.ok(recommend(input).every(row=>![id(1),id(2),id(3)].includes(row.trackId)));
 const small=recommend({...input,catalog:[track(1),track(2),track(3)],profileFinishes:[finish(1,{pbAt:at})]});
 assert.equal(small[0].trackId,id(2));
});

test('incomplete loaded profile subsets do not become skill/progress authority; foreign rows ignored',()=>{
 const incomplete={...base,snapshotComplete:false};
 assert.deepEqual(recommend({...incomplete,profileFinishes:[finish(21),finish(22)]}),recommend(incomplete));
 assert.deepEqual(recommend({...base,profileFinishes:[finish(21,{accountId:'b'.repeat(64)})],
  localPBs:[{trackId:id(22),bestMs:200,ownerAccountId:'b'.repeat(64)}]}),recommend(base));
 assert.ok(recommend(incomplete).every(row=>row.reason.includes('history is incomplete')));
});

test('malformed metadata, unranked entries, all Kodub archives and duplicates fail closed',()=>{
 const allowed=[track(100),track(101,3)];
 const invalid=[track(102,null),track(103,'2'),track(104,0),track(105,11),track(106,NaN),
  track(107,2,{ranked:false}),track(108,2,{ranked:'true'}),track(109,2,{archiveImport:true}),
  track(110,2,{archiveImport:'false'}),track(111,2,{source:'Kodub weekly',weeklyEndsAt:'2020-01-01T00:00:00Z'}),
  track(112,2,{source:'Kodub weekly',weeklyEndsAt:'2099-01-01T00:00:00Z'}),track(113,2,{weeklyEndsAt:'invalid'}),
  track(114,2,{unranked:true}),track(115,2,{name:''}),track(116,2,{name:'<hidden>'}),
  {...track(117),trackId:'bad'},{...track(118),difficulty:undefined,rating:10,difficultyRating:2},null];
 const result=recommend({...base,catalog:[...allowed,...invalid,track(100)]});
 assert.deepEqual(new Set(result.map(row=>row.trackId)),new Set(allowed.map(row=>row.trackId)));
 assert.deepEqual(recommend({...base,catalog:[track(100),track(100,7)]}),[]);
 assert.deepEqual(recommend({...base,catalog:[track(100),track(100,2,{ranked:false})]}),[]);
});

test('actual static catalog returns only unique regular ranked rated Extras with honest fields',()=>{
 const actual=JSON.parse(readFileSync(new URL('../extra-tracks/catalog.json',import.meta.url),'utf8'));
 assert.equal(actual.some(row=>Object.hasOwn(row,'rating')),false);
 const result=recommend({...base,catalog:actual});assert.equal(result.length,5);
 assert.equal(new Set(result.map(row=>row.trackId)).size,result.length);
 for(const row of result){const source=actual.find(item=>item.trackId===row.trackId);
  assert.ok(source);assert.notEqual(source.ranked,false);assert.notEqual(source.archiveImport,true);
  assert.equal(row.difficulty,source.difficulty);assert.equal(row.name,source.name.trim());
  assert.deepEqual(Object.keys(row).sort(),['difficulty','name','reason','trackId']);
 }
});

test('malformed inputs are bounded and inputs are never mutated',()=>{
 for(const input of [null,[],{...base,catalog:null},{...base,accountId:'bad'},{...base,day:'2026-02-30'},
  {...base,day:'today'},{...base,milestoneId:{}},{...base,accountId:accountId+'\n'}])assert.deepEqual(recommend(input),[]);
 const copy=structuredClone(base),before=JSON.stringify(copy);recommend(copy);assert.equal(JSON.stringify(copy),before);
 assert.deepEqual(recommend({...base,profileFinishes:[null,finish(21,{timeMs:0})],localPBs:[{trackId:id(22),bestMs:'100'}]}),recommend(base));
});


test('no ambient IO clock randomness or input mutation; returned objects do not alias input',t=>{
 t.mock.method(globalThis,'fetch',()=>assert.fail('network forbidden'));
 t.mock.method(Date,'now',()=>assert.fail('wall clock forbidden'));
 t.mock.method(Math,'random',()=>assert.fail('ambient randomness forbidden'));
 const input=structuredClone(base);for(const row of input.catalog)Object.freeze(row);
 Object.freeze(input.catalog);Object.freeze(input.profileFinishes);Object.freeze(input);
 const result=recommend(input);assert.equal(result.length,5);result[0].name='changed';
 assert.notEqual(recommend(input)[0].name,'changed');
 const source=readFileSync(new URL('./achievement-recommendations.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(source,/^\s*import\s/m);assert.doesNotMatch(source,/\b(?:localStorage|sessionStorage|setInterval|setTimeout)\b/);
});
