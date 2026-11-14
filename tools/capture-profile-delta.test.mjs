import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import {encode} from './verifier/firestore.mjs';import {captureProfileDelta} from './capture-profile-delta.mjs';
const prefix='projects/polytrack-052/databases/(default)/documents/0.6.2_profiles_public/',point='2026-11-07T08:05:00.000Z',id=n=>n.toString(16).padStart(64,'0');
const row=(n,extra={})=>({document:{name:prefix+id(n),fields:encode({name:'Racer',updatedAt:n+1000,...extra}).mapValue.fields},readTime:point});
async function fixture(t,pages){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'profile-delta-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));const calls=[];return {directory,calls,db:{call:async(endpoint,body)=>{assert.equal(endpoint,':runQuery');calls.push(body);const value=pages.shift();if(value instanceof Error)throw value;return value;}}};}

test('profile delta uses public projection and saves only after complete frozen scan',async t=>{const f=await fixture(t,[[row(1,{userToken:'private',ownerUid:'private'})]]);const report=await captureProfileDelta({...f,since:1000});assert.equal(report.complete,true);assert.equal(report.profilesUpdated,1);const value=JSON.parse(await fs.readFile(path.join(f.directory,'profiles',id(1)+'.json'),'utf8'));assert.equal(value.accountId,id(1));assert.ok(!JSON.stringify(value).includes('private'));assert.equal(f.calls[0].structuredQuery.where.fieldFilter.op,'GREATER_THAN');});

test('keyset pages share one exact read time without offsets or repeated accounts',async t=>{const first=Array.from({length:100},(_,i)=>row(i+1)),f=await fixture(t,[first,[row(101)]]);const report=await captureProfileDelta({...f,since:1000});assert.equal(report.profilesUpdated,101);assert.equal(f.calls[1].readTime,point);assert.deepEqual(f.calls[1].structuredQuery.startAt.values,[{integerValue:'1100'},{referenceValue:prefix+id(100)}]);assert.equal(f.calls[1].structuredQuery.offset,undefined);});

test('quota or page failure never writes partially captured profiles',async t=>{const f=await fixture(t,[Array.from({length:100},(_,i)=>row(i+1)),Error('quota')]);await assert.rejects(captureProfileDelta({...f,since:1000}),/quota/);assert.deepEqual(await fs.readdir(f.directory),[]);});

test('budget exhaustion is incomplete, not an advanced watermark',async t=>{const f=await fixture(t,[[row(1),row(2)]]);await assert.rejects(captureProfileDelta({...f,since:1000,maxDocuments:2}),/before complete/);assert.deepEqual(await fs.readdir(f.directory),[]);});

test('foreign paths, duplicates, changed read time and future timestamps are rejected before writes',async t=>{for(const bad of [[{...row(1),document:{...row(1).document,name:'foreign/'+id(1)}}],[row(1),row(1)],[row(1),{...row(2),readTime:'2026-11-07T08:05:01.000Z'}],[row(1,{updatedAt:Date.parse(point)+1})]]){const f=await fixture(t,[bad]);await assert.rejects(captureProfileDelta({...f,since:1000}));assert.deepEqual(await fs.readdir(f.directory),[]);}});

test('empty changed-profile result is complete and costs one minimum read',async t=>{const f=await fixture(t,[[{readTime:point}]]);const report=await captureProfileDelta({...f,since:1000});assert.equal(report.complete,true);assert.equal(report.profilesUpdated,0);assert.equal(report.estimatedDocumentReads,1);});


test('approved 5000 profile ceiling is accepted but 5001 fails before any source query',async t=>{
 const f=await fixture(t,[[{readTime:point}]]);const result=await captureProfileDelta({...f,since:1000,maxDocuments:5000});
 assert.equal(result.complete,true);assert.equal(result.backendWrites,0);assert.equal(f.calls.length,1);assert.equal(f.calls[0].structuredQuery.limit,100);
 await assert.rejects(captureProfileDelta({...f,since:1000,maxDocuments:5001}),/Invalid profile delta/);assert.equal(f.calls.length,1);
});
