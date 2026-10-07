import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {capturePublicEventTotals,publicEventTotals} from './public-event-totals-backup.mjs';
import {encode} from './verifier/firestore.mjs';

test('event totals allowlist removes personal and unrelated fields',()=>{
  const projected=publicEventTotals({updatedAt:1,ownerUid:'secret',entries:[{accountId:'a'.repeat(64),name:'Racer',rp:50,rank:1,events:2,ownerUid:'secret'}]});
  assert.equal(projected.ownerUid,undefined);assert.equal(projected.entries[0].ownerUid,undefined);
  assert.throws(()=>publicEventTotals({updatedAt:1,entries:[{accountId:'bad'}]}));
});

test('event totals uses one masked public fallback and preserves prior files on failure',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'polytrack-event-totals-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const value={updatedAt:1,entries:[{accountId:'a'.repeat(64),name:'Racer',rp:50,rank:1,events:2}]};let calls=0;
  await capturePublicEventTotals({directory,fetchImpl:async url=>{calls++;if(calls===1)return new Response('',{status:403});assert.ok(url.includes('mask.fieldPaths=entries'));return Response.json({fields:Object.fromEntries(Object.entries(value).map(([k,v])=>[k,encode(v)]))});}});
  assert.equal(calls,2);const before=await fs.readFile(path.join(directory,'event-totals.json'),'utf8');
  const result=await capturePublicEventTotals({directory,fetchImpl:async()=>new Response('',{status:429})});
  assert.equal(result.deferred,true);assert.equal(await fs.readFile(path.join(directory,'event-totals.json'),'utf8'),before);
});
