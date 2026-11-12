import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const caller=fs.readFileSync(new URL('../.github/workflows/verify-runs.yml',import.meta.url),'utf8');
const capture=fs.readFileSync(new URL('../.github/workflows/publish-verified-snapshots.yml',import.meta.url),'utf8');
test('manual catch-up exposes only bounded replay choices and preserves the routine default',()=>{
 assert.match(caller,/options: \['100', '1000'\]/);assert.match(caller,/default: '100'/);
 assert.match(caller,/replay_document_limit:.*inputs.replay_document_limit/);
 assert.match(capture,/REPLAY_DOCUMENT_LIMIT:.*inputs.replay_document_limit/);
 assert.match(capture,/replayDocumentLimit:replayLimit/);
 assert.match(capture,/maxJobs:10000,maxRuntimeMs:1500000/);
});
test('capture rejects arbitrary replay-budget expansion before calling the updater',()=>{
 const start=capture.indexOf('const replayLimit='),end=capture.indexOf('const sourceCommit=',start);
 assert(start>0&&end>start);const code=capture.slice(start,end);
 for(const value of [undefined,'100','1000'])assert.doesNotThrow(()=>vm.runInNewContext(code,{process:{env:{REPLAY_DOCUMENT_LIMIT:value}}}));
 for(const value of ['0','99','101','2000','50000','NaN','Infinity'])assert.throws(()=>vm.runInNewContext(code,{process:{env:{REPLAY_DOCUMENT_LIMIT:value}}}),/Invalid bounded manual/);
});
