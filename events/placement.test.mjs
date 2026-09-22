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
 for(const board of [{period:{id:'other',trackId},updatedAt:1,entries:[]},{...input([]).board,entries:[{accountId:b,timeMs:0}]},{...input([]).board,entries:[{accountId:b,timeMs:1},{accountId:b,timeMs:2}]}])assert.equal(eventFinishPlace({...input([]),board}),null);
});
test('a first-run finish gets a provisional place without a snapshot',()=>{
 assert.deepEqual(eventFinishPlace({board:null,periodId:'weekly',trackId,accountId:a,timeMs:20000}),{rank:1,fieldSize:null,provisional:true,saved:false});
});
test('waiting recordings affect provisional finish place but never represent awarded points',()=>{
 const pending=(accountId,timeMs,runId)=>({accountId,timeMs,runId,verificationStatus:'waiting',pending:true,verified:false,eventRpEligible:false,source:'pending-event-playback'});
 const board={period:{id:'weekly',trackId},updatedAt:1,entries:[{accountId:b,timeMs:19000}],pendingPlaybacks:[pending(c,18000,'e'.repeat(64))]};
 assert.deepEqual(eventFinishPlace({board,periodId:'weekly',trackId,accountId:a,timeMs:20000}),{rank:3,fieldSize:3,provisional:true,saved:false});
 assert.equal(eventFinishPlace({board:{...board,pendingPlaybacks:[pending('invalid',18000,'e'.repeat(64))]},periodId:'weekly',trackId,accountId:a,timeMs:20000}),null);
});
