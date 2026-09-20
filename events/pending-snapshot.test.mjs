import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('./client.mjs',import.meta.url),'utf8');
const code=source.slice(source.indexOf('  function eventDisplayRows('),source.indexOf('  function syncNativeBoard('));
const period={id:'fixture',trackId:'a'.repeat(64)};
function rows(board){const ctx={bridge:{accountId:()=> 'viewer'},cache:new Map([[period.id,board]]),read:()=>null,localBest:()=>null,ownReceipts:new Map(),displayName:r=>r.name||'Racer',STORE:'fixture'};vm.createContext(ctx);vm.runInContext(code,ctx);return ctx.eventDisplayRows(period).rows;}
test('server pendingPlaybacks are playable provisional rows, never awarded points',()=>{
 const row={accountId:'other',runId:'b'.repeat(64),timeMs:1234,verificationStatus:'waiting',verified:false,rp:999};
 const result=rows({period,entries:[],pendingPlaybacks:[row]});assert.equal(result.length,1);assert.equal(result[0].runId,row.runId);assert.equal(result[0].pending,true);assert.equal(result[0].rp,0);assert.equal(result[0].rank,null);
});
test('wrong-period and terminal replay bindings never enter displayed event rows',()=>{
 const row={accountId:'other',runId:'b'.repeat(64),timeMs:1234,verificationStatus:'waiting',verified:false};
 assert.equal(rows({period:{...period,id:'other'},entries:[],pendingPlaybacks:[row]}).length,0);
 for(const status of ['rejected','mismatch','verified','expired'])assert.equal(rows({period,entries:[],pendingPlaybacks:[{...row,verificationStatus:status}]}).length,0);
});
