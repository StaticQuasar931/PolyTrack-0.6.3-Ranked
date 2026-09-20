import test from 'node:test';
import assert from 'node:assert/strict';
import {eventFinishPlace} from './placement.mjs';
const a='a'.repeat(64),b='b'.repeat(64),c='c'.repeat(64),trackId='d'.repeat(64);
const input=entries=>({board:{period:{id:'weekly',trackId},updatedAt:1,entries},periodId:'weekly',trackId,accountId:a,timeMs:20000});
test('event finish place uses strict competition ties and excludes older own PB',()=>{
 assert.deepEqual(eventFinishPlace(input([{accountId:a,timeMs:21000},{accountId:b,timeMs:19000},{accountId:c,timeMs:20000}])),{rank:2,fieldSize:3,provisional:true,saved:false});
});
test('only matching published time is a published place',()=>{
 assert.equal(eventFinishPlace(input([{accountId:a,timeMs:20000}])).provisional,false);
 assert.equal(eventFinishPlace(input([])).provisional,true);
});
test('missing, wrong-period, duplicate and invalid boards never invent first place',()=>{
 for(const board of [null,{period:{id:'other',trackId},updatedAt:1,entries:[]},{...input([]).board,entries:[{accountId:b,timeMs:0}]},{...input([]).board,entries:[{accountId:b,timeMs:1},{accountId:b,timeMs:2}]}])assert.equal(eventFinishPlace({...input([]),board}),null);
});
