import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import {eventPeriod} from '../workers/ranked/src/events.js';
import {encode} from './verifier/firestore.mjs';
import {ARCHIVE_REPAIR_NOT_BEFORE, prepareLocalArchiveReplayRepair, repairLocalArchiveReplays,
  createArchiveReplayRepairReader} from './local-archive-replay-repair.mjs';
const sha = b => createHash('sha256').update(b).digest('hex');
const now = () => ARCHIVE_REPAIR_NOT_BEFORE;
async function fixture(t) {
  t.mock.method(globalThis,'fetch',() => assert.fail('No network allowed'));
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'archive-repair-'));
  t.after(() => fs.rm(directory,{recursive:true,force:true}));
  await fs.mkdir(path.join(directory,'events'));
  const periodId = 'd_20260913', trackId = 'b'.repeat(64);
  const p = eventPeriod({id:periodId,trackId,enabled:true,startsAt:1000,endsAt:2000,graceMs:0,
    targetMs:1000,maxRp:100,kind:'daily',eligibility:'best-submitted-during-period',
    capacity:{policyVersion:'test',entrants:200,admissionsPerPeriod:2048,replayBytesPerPeriod:65536,minIntervalMs:1000,verificationsPerDay:100}});
  const binding = {...p}; delete binding.scoringVersion; delete binding.storageVersion;
  const replay = deflateSync(Buffer.alloc(15)).toString('base64url'), replayHash = sha(replay);
  const targets = Array.from({length:12},(_,i) => ({periodId,accountId:(i+1).toString(16).padStart(64,'0'),trackId,timeMs:1000}));
  const entries = targets.map(t => ({accountId:t.accountId,timeMs:t.timeMs,runId:'c'.repeat(64),replayHash}));
  const board = {id:periodId,period:p,archived:true,entries,updatedAt:88};
  const manifest = {schemaVersion:1,events:{[periodId]:{path:`events/${periodId}.json`}},updatedAt:77,proofAuthority:{untouched:true}};
  const put = (name,v) => fs.writeFile(path.join(directory,name),JSON.stringify(v));
  await put(`events/${periodId}.json`,board); await put('manifest.json',manifest);
  const planFile = path.join(directory,'plan.json'); await put('plan.json',{schemaVersion:1,targets});
  const options = {directory,planFile,planSha256:sha(await fs.readFile(planFile)),maxDocuments:12,now};
  const retained = {...targets[0],runId:entries[0].runId,replay,replayHash,carStyle:'',verifiedAt:123,
    periodBinding:JSON.stringify(binding)};
  let calls = 0;
  const getDocument = async (collection,id) => {
    calls++; assert.equal(collection,'0.6.2_event_replays');
    const target = targets.find(t => id === `${t.periodId}_${t.accountId}`); assert.ok(target);
    return {...retained,...target};
  };
  return {directory,targets,board,manifest,options,retained,getDocument,put,calls:() => calls,
    run:(extra = {}) => repairLocalArchiveReplays({...options,getDocument,...extra})};
}
test('preparation is offline, fingerprinted, exact and does not stage',async t => {
  const f = await fixture(t), receipt = await prepareLocalArchiveReplayRepair(f.options);
  assert.equal(receipt.missing.length,12); assert.equal(f.calls(),0);
  await assert.rejects(f.run({now:() => ARCHIVE_REPAIR_NOT_BEFORE-1}),/before Nov/);
  assert.equal(f.calls(),0);
  await assert.rejects(prepareLocalArchiveReplayRepair({...f.options,planSha256:'0'.repeat(64)}),/fingerprint/);
  await assert.rejects(prepareLocalArchiveReplayRepair({...f.options,maxDocuments:13}),/boundary/);
});
test('all 12 validated payloads commit once, preserve boards, dates and authority',async t => {
  const f = await fixture(t), before = await fs.readFile(path.join(f.directory,'events/d_20260913.json'));
  const report = await f.run(); assert.equal(report.backendReads,12); assert.equal(report.backendWrites,0); assert.equal(report.staged,true);
  assert.deepEqual(await fs.readFile(path.join(f.directory,'events/d_20260913.json')),before);
  const manifest = JSON.parse(await fs.readFile(path.join(f.directory,'manifest.json')));
  assert.equal(manifest.updatedAt,77); assert.deepEqual(manifest.proofAuthority,f.manifest.proofAuthority);
  assert.equal(Object.keys(manifest.eventReplays).length,12);
  const saved = JSON.parse(await fs.readFile(path.join(f.directory,report.files[0])));
  assert.equal(saved.verifiedAt,123); assert.equal(saved.verified,undefined); assert.equal(saved.periodBinding,undefined);
  assert.equal((await f.run()).backendReads,0); assert.equal(f.calls(),12);
});
test('binding, hash, structure, date and retained proof failures never stage',async t => {
  for (const patch of [{trackId:'e'.repeat(64)},{accountId:'e'.repeat(64)},{periodId:'d_20260914'},
    {timeMs:999},{runId:'d'.repeat(64)},{replayHash:'d'.repeat(64)},{verifiedAt:0},
    {periodBinding:'{}'},{replay:'broken',replayHash:sha('broken')}]) {
    const f = await fixture(t);
    await assert.rejects(f.run({getDocument:async () => ({...f.retained,...patch})}));
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,'manifest.json'))),f.manifest);
    await assert.rejects(fs.stat(path.join(f.directory,'event-replays')),{code:'ENOENT'});
  }
});
test('quota/auth errors stop immediately with accounting and no partial publication',async t => {
  for(const status of [401,403,429]) {
    const f = await fixture(t); let calls = 0;
    await assert.rejects(f.run({getDocument:async (...args) => {
      if(++calls === 2) throw Object.assign(Error('stopped'),{status}); return f.getDocument(...args);
    }}),e => e.status === status && e.accounting.backendReads === 2 && !e.accounting.staged);
    assert.equal(calls,2); assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,'manifest.json'))),f.manifest);
  }
});
test('board drift and manifest races prevent publication',async t => {
  const f = await fixture(t); f.board.entries[0].timeMs = 999; await f.put('events/d_20260913.json',f.board);
  await assert.rejects(f.run(),/drift/); assert.equal(f.calls(),0);
  const g = await fixture(t);
  await assert.rejects(g.run({getDocument:async (...args) => {
    const value = await g.getDocument(...args); await g.put('manifest.json',{...g.manifest,changed:true}); return value;
  }}),/staging changed/);
});
test('production factory enforces exact direct GETs, budgets, no redirects and no retries',async t => {
  const f = await fixture(t); let requests = 0;
  const reader = createArchiveReplayRepairReader({targets:f.targets,access:'fake-only',now,fetchImpl:async (url,init) => {
    requests++; assert.equal(init.method,'GET'); assert.equal(init.redirect,'error'); assert.equal(init.body,undefined);
    return {ok:false,status:429,headers:new Headers(),json:async () => ({})};
  }});
  await assert.rejects(reader.getDocument('other','x'),/allowlist/); assert.equal(requests,0);
  const id = f.targets[0].periodId+'_'+f.targets[0].accountId;
  await assert.rejects(reader.getDocument('0.6.2_event_replays',id));
  await assert.rejects(reader.getDocument('0.6.2_event_replays',id)); assert.equal(requests,1);
  assert.equal(reader.accounting().backendWrites,0); assert.equal(reader.accounting().documentBudget.readLimit,12);
  assert.equal(reader.accounting().documentBudget.writeLimit,1);
});
test('production reader decodes only the exact returned document',async t => {
  const f = await fixture(t);
  const reader = createArchiveReplayRepairReader({targets:f.targets,access:'fake-only',now,fetchImpl:async url => ({ok:true,status:200,
    json:async () => ({name:url.slice('https://firestore.googleapis.com/v1/'.length),fields:encode(f.retained).mapValue.fields})})});
  const id = f.targets[0].periodId+'_'+f.targets[0].accountId;
  assert.deepEqual(await reader.getDocument('0.6.2_event_replays',id),f.retained);
  await assert.rejects(reader.getDocument('0.6.2_event_replays',id),/duplicate/);
});
test('unexpected missing archived rows fail before any read',async t => {
  const f = await fixture(t);
  f.board.entries.push({accountId:'f'.repeat(64),timeMs:1000}); await f.put('events/d_20260913.json',f.board);
  await assert.rejects(f.run(),/outside preparation plan/); assert.equal(f.calls(),0);
});
test('manifest commit failure rolls back only newly created replay files',async t => {
  const f = await fixture(t), rename = fs.rename;
  t.mock.method(fs,'rename',async (from,to) => {
    if(to === path.join(f.directory,'manifest.json')) throw Error('injected disk failure');
    return rename(from,to);
  });
  await assert.rejects(f.run(),/disk failure/);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.directory,'manifest.json'))),f.manifest);
  assert.deepEqual(await fs.readdir(path.join(f.directory,'event-replays/d_20260913')),[]);
});
