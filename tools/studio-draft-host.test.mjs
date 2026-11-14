import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {bindStudioDraftHistory} from './studio-draft-host.mjs';

test('invalid or stale host binding fails before reading account drafts',()=>{
 assert.throws(()=>bindStudioDraftHistory(null),/Connected Studio/);
 let reads=0;
 const adapters={accountId:'alpha',getAccountId:()=> 'beta',getDraft:()=>{reads++;return {};},getSavedDraft:()=>{reads++;return {};},onRestore(){}};
 assert.throws(()=>bindStudioDraftHistory({isConnected:true},adapters),/Current account/);assert.equal(reads,0);
 assert.throws(()=>bindStudioDraftHistory({isConnected:false},adapters),/Connected Studio/);assert.equal(reads,0);
});

test('host imports only pure history and has no storage, network, grant or global storage hook',()=>{
 const source=fs.readFileSync(new URL('./studio-draft-host.mjs',import.meta.url),'utf8');
 assert.deepEqual([...source.matchAll(/^import .* from '([^']+)'/gm)].map(match=>match[1]),['./studio-edit-history.mjs']);
 assert.doesNotMatch(source,/\b(fetch|XMLHttpRequest|WebSocket|localStorage|sessionStorage|indexedDB|firebase|grantReward)\b/);
 assert.doesNotMatch(source,/addEventListener\(['"]storage['"]/);
});
