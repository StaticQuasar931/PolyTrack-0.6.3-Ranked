import test from 'node:test';
import {generateKeyPairSync} from 'node:crypto';
const fixtureKey=generateKeyPairSync('rsa',{modulusLength:2048}).privateKey.export({type:'pkcs8',format:'pem'});
const exportAuth={serviceAccount:{type:'service_account',project_id:'polytrack-052',client_email:'fixture@polytrack-052.iam.gserviceaccount.com',private_key:fixtureKey},
 oauthFetch:async()=>Response.json({access_token:'fixture-token',token_type:'Bearer',expires_in:3600})};
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {updatePublicSnapshot} from './update-public-snapshot.mjs';
import {exportPublicProfilesAndReplays} from './public-profile-replay-export.mjs';

const workflow=await fs.readFile(new URL('../.github/workflows/sync-event-catalog.yml',import.meta.url),'utf8');
const embedded=workflow.match(/<<'NODE'\r?\n([\s\S]*?)^          NODE\r?$/m);
assert.ok(embedded,'test the actual workflow helper, not a second implementation');
const source=embedded[1].replace(/^          /gm,'');
const {ledger,run}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const account='a'.repeat(64),track='b'.repeat(64),hash='d'.repeat(64),now=Date.UTC(2026,9,18);
const key=JSON.stringify([account,track,42,900,hash]);
const failure={signature:key,available:false,reason:'missing',checkedAt:now-1000,attempts:4,bindingTimeMs:15000};
const cache=records=>({schemaVersion:1,projectId:'polytrack-052',records});
const read=async file=>JSON.parse(await fs.readFile(file,'utf8'));
const write=async(file,value)=>{await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,JSON.stringify(value));};
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'snapshot-retry-workflow-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));return root;}
function entry(accountId=account,uploadId=42){return {accountId,trackId:track,uploadId,frames:900,raceTimeFrames:900,replayHash:hash,timeMs:15000,runVerified:true,integrityVerified:true};}
async function stage(root,entries=[entry()]){
 const directory=path.join(root,'local-reports','snapshot-staging');
 await write(path.join(directory,'tracks',track+'.json'),{trackId:track,complete:true,entries});
 await write(path.join(directory,'overall.json'),{complete:true,entries:[],trackSummaries:[]});
 await write(path.join(directory,'manifest.json'),{trackIdsKnown:1,trackBackupsPresent:1,trackBackupsMissing:0,eventsMissing:0});
 await fs.writeFile(path.join(root,'index.html'),'<html><head></head><body></body></html>');return directory;
}
const missing=async(_url,options)=>({ok:true,text:async()=>JSON.stringify(JSON.parse(options.body).documents.map(name=>({missing:name})))});

test('workflow caches one runner-temp ledger only on trusted default-branch captures',()=>{
 assert.match(workflow,/if: github\.repository == 'StaticQuasar931\/PolyTrack-0\.6\.3-Ranked' && github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
 assert.doesNotMatch(workflow,/pull_request|pull_request_target|repository_dispatch/);
 assert.match(workflow,/group: public-repository-captures-\$\{\{ github\.repository \}\}/);
 assert.match(workflow,/actions\/cache\/restore@[a-f0-9]{40}/);assert.match(workflow,/actions\/cache\/save@[a-f0-9]{40}/);
 const paths=[...workflow.matchAll(/^          path: (.+)$/gm)].map(m=>m[1]);
 assert.deepEqual(paths,['${{ runner.temp }}/polytrack-replay-retries/history.json','${{ runner.temp }}/polytrack-replay-retries/history.json']);
 assert.match(workflow,/key: replay-retries-v1-\$\{\{ github.repository_id \}\}-\$\{\{ github.event.repository.default_branch \}\}-\$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/);
 assert.match(workflow,/steps\.snapshot\.outcome == 'failure'/);assert.match(workflow,/steps\.retry_checkpoint\.outputs\.ready == 'true'/);
 assert.ok(workflow.indexOf('Prepare validated private replay retry checkpoint')<workflow.indexOf('name: Capture bounded public snapshots'));
 assert.ok(workflow.indexOf('Save private replay retry ledger')<workflow.indexOf('name: Commit changed assignments'));
 assert.doesNotMatch(workflow,/git add[^\n]*(?:local-reports|history\.json|export-progress)/);
});

test('allowlist strips credentials, replay data and all success/completion claims',()=>{
 const result=ledger({...cache({[key]:{...failure,token:'secret',replay:'private'}}),credentials:'secret',profiles:{complete:true},covered:{[key]:true}},now);
 assert.deepEqual(result,cache({[key]:failure}));assert.doesNotMatch(JSON.stringify(result),/secret|credentials|profiles|covered|replay"/);
});

test('invalid signatures, projects, timestamps, transient errors and successes are not cached',()=>{
 for(const patch of [{available:true},{reason:'batch-response-mismatch'},{checkedAt:now+1},{checkedAt:now-31*86400000},{bindingTimeMs:-1},{checkedAt:'today'}])assert.deepEqual(ledger(cache({[key]:{...failure,...patch}}),now).records,{});
 for(const signature of ['not json',JSON.stringify([account,track,42,900,hash,'extra']),JSON.stringify([account,track,-1,900,hash])])assert.deepEqual(ledger(cache({[signature]:failure}),now).records,{});
 assert.deepEqual(ledger({...cache({[key]:failure}),projectId:'other-project'},now).records,{});
 assert.deepEqual(ledger({...cache({[key]:failure}),schemaVersion:2},now).records,{});
 assert.deepEqual(ledger(cache({[key]:{...failure,attempts:1e9}}),now).records[key].attempts,32);
});

test('ledger storage is bounded and obsolete records cannot accumulate indefinitely',()=>{
 const records={};for(let i=0;i<20010;i++){const signature=JSON.stringify([i.toString(16).padStart(64,'0'),track,i+1,900,hash]);records[signature]={...failure,signature};}
 assert.equal(Object.keys(ledger(cache(records),now).records).length,20000);
});

test('restore seeds only retry records and preserves existing local checkpoint state',async t=>{
 const root=await fixture(t),cacheFile=path.join(root,'runner','history.json'),progressFile=path.join(root,'stage','export-progress.json');
 await write(cacheFile,{...cache({[key]:failure}),profiles:{complete:true},raceExport:{covered:{[key]:true}},secret:'never copy'});
 await run('restore',cacheFile,progressFile,now);
 assert.deepEqual(await read(progressFile),{schemaVersion:2,projectId:'polytrack-052',raceExport:{records:{[key]:failure}}});
 const local={schemaVersion:2,projectId:'polytrack-052',profiles:{cursor:'keep',complete:false},fullSnapshotPending:true,raceExport:{records:{[key]:{...failure,checkedAt:now}},pending:['keep']}};
 await write(progressFile,local);await run('restore',cacheFile,progressFile,now);assert.deepEqual(await read(progressFile),local);
});

test('missing, corrupt, oversized and wrong-project cache falls back without inventing coverage',async t=>{
 const root=await fixture(t),cacheFile=path.join(root,'runner','history.json'),progressFile=path.join(root,'stage','export-progress.json');
 await run('restore',cacheFile,progressFile,now);await assert.rejects(fs.stat(progressFile),{code:'ENOENT'});
 await fs.mkdir(path.dirname(cacheFile),{recursive:true});
 for(const content of ['not json',JSON.stringify({...cache({[key]:failure}),projectId:'wrong'}),' '.repeat(16*1024*1024+1)]){
  await fs.writeFile(cacheFile,content);await run('restore',cacheFile,progressFile,now);await assert.rejects(fs.stat(progressFile),{code:'ENOENT'});
 }
 await run('save',cacheFile,progressFile,now);assert.deepEqual(await read(cacheFile),cache({}));
});

test('cache save never exports full checkpoint or retains resolved failure records',async t=>{
 const root=await fixture(t),cacheFile=path.join(root,'runner','history.json'),progressFile=path.join(root,'stage','export-progress.json');
 await write(progressFile,{schemaVersion:2,projectId:'polytrack-052',profiles:{ids:[account],complete:true,secret:'private'},fullSnapshotPending:true,raceExport:{covered:{[key]:true},records:{[key]:failure}},credential:'secret'});
 await run('save',cacheFile,progressFile,now);assert.deepEqual(await read(cacheFile),cache({[key]:failure}));
 await write(progressFile,{schemaVersion:2,projectId:'polytrack-052',raceExport:{records:{[key]:{available:true}}}});
 await run('save',cacheFile,progressFile,now);assert.deepEqual(await read(cacheFile),cache({}));
});

test('retry ledger survives blocked publication and fresh-run staging rebase without appearing in published snapshots',async t=>{
 const firstRoot=await fixture(t),firstStage=await stage(firstRoot,[]),cacheFile=path.join(firstRoot,'runner','history.json');
 const initial=await updatePublicSnapshot({root:firstRoot,offline:true,log:()=>{}});
 await write(path.join(firstStage,'tracks',track+'.json'),{trackId:track,complete:true,entries:[entry()]});
 await assert.rejects(updatePublicSnapshot({root:firstRoot,capture:async()=>({}),refreshReplays:true,log:()=>{},exportPublic:options=>exportPublicProfilesAndReplays({...options,now:now-1000,fetchImpl:missing})}),{code:'SNAPSHOT_REPLAYS_INCOMPLETE'});
 await run('save',cacheFile,path.join(firstStage,'export-progress.json'),now);
 assert.equal(Object.keys((await read(cacheFile)).records).length,1);
 const secondRoot=await fixture(t);await fs.cp(path.join(firstRoot,initial.directory),path.join(secondRoot,initial.directory),{recursive:true});
 await fs.copyFile(path.join(firstRoot,'snapshot-current.json'),path.join(secondRoot,'snapshot-current.json'));
 await fs.copyFile(path.join(firstRoot,'index.html'),path.join(secondRoot,'index.html'));
 const progressFile=path.join(secondRoot,'local-reports','snapshot-staging','export-progress.json');await run('restore',cacheFile,progressFile,now);
 let requests=0;
 await assert.rejects(updatePublicSnapshot({root:secondRoot,capture:async({directory})=>{
  await write(path.join(directory,'tracks',track+'.json'),{trackId:track,complete:true,entries:[entry()]});return {};
 },refreshReplays:true,log:()=>{},exportPublic:options=>exportPublicProfilesAndReplays({...options,now,fetchImpl:async()=>{requests++;throw Error('cooldown must survive hydration/rebase');}})}),{code:'SNAPSHOT_REPLAYS_INCOMPLETE'});
 assert.equal(requests,0);
 assert.equal((await read(path.join(secondRoot,'local-reports','snapshot-staging','public-export-summary.json'))).coverage.complete,false);
 assert.equal((await read(path.join(secondRoot,'snapshot-current.json'))).currentdir,initial.directory);
 const index=await read(path.join(secondRoot,initial.directory,'index.json'));
 assert.ok(!Object.keys(index.files).some(name=>/export-progress|history\.json|retry/i.test(name)));
 assert.equal((await read(progressFile)).raceExport.records[key].attempts,1);
});

test('capture failure retains only already-checkpointed deterministic failures',async t=>{
 const root=await fixture(t),directory=await stage(root,[entry(),entry('c'.repeat(64),43)]),cacheFile=path.join(root,'runner','history.json');let calls=0;
 await assert.rejects(exportPublicProfilesAndReplays({directory,snapshotDirectory:directory,includeProfiles:false,pageSize:1,now:now-1000,
  fetchImpl:async(...args)=>{if(calls++===0)return missing(...args);throw Error('transient');}}),/transient/);
 await run('save',cacheFile,path.join(directory,'export-progress.json'),now);
 const saved=await read(cacheFile);assert.equal(Object.keys(saved.records).length,1);assert.equal(saved.records[key].reason,'missing');
});

test('restored history does not defer changed bindings or turn a cache miss into complete coverage',async t=>{
 const root=await fixture(t),directory=await stage(root,[entry(account,43)]),cacheFile=path.join(root,'runner','history.json');
 await write(cacheFile,cache({[key]:failure}));await run('restore',cacheFile,path.join(directory,'export-progress.json'),now);let requests=0;
 const result=await exportPublicProfilesAndReplays({directory,snapshotDirectory:directory,includeProfiles:false,now,fetchImpl:async(...args)=>{requests++;return missing(...args);}});
 assert.equal(requests,1);assert.equal(result.complete,false);assert.equal(result.deferredBindingRetries,0);assert.equal(result.totalCoverage.missing,1);
});

test('mid-export quota deferral retains checkpointed retry ledger and never advances public package',async t=>{
 const root=await fixture(t),directory=await stage(root,[]);
 const published=await updatePublicSnapshot({root,offline:true,log:()=>{}});
 await write(path.join(directory,'tracks',track+'.json'),{trackId:track,complete:true,entries:[entry(),entry('c'.repeat(64),43)]});
 const pointer=await fs.readFile(path.join(root,'snapshot-current.json'));
 const index=await fs.readFile(path.join(root,published.directory,'index.json'));
 const html=await fs.readFile(path.join(root,'index.html'));
 let calls=0;
 const result=await updatePublicSnapshot({root,refreshReplays:true,capture:async()=>({}),log:()=>{},exportAuth,
  exportPublic:options=>exportPublicProfilesAndReplays({...options,pageSize:1,now}),
  exportFetch:async(...args)=>++calls===1?missing(...args):new Response('',{status:429})});
 assert.equal(calls,2);assert.equal(result.deferred,true);assert.equal(result.published,false);
 assert.deepEqual(await fs.readFile(path.join(root,'snapshot-current.json')),pointer);
 assert.deepEqual(await fs.readFile(path.join(root,published.directory,'index.json')),index);
 assert.deepEqual(await fs.readFile(path.join(root,'index.html')),html);
 const cacheFile=path.join(root,'runner','history.json');
 await run('save',cacheFile,path.join(directory,'export-progress.json'),now);
 const saved=await read(cacheFile);assert.equal(Object.keys(saved.records).length,1);
 assert.equal(saved.records[key].reason,'missing');
 const freshProgress=path.join(root,'fresh-run','export-progress.json');
 await run('restore',cacheFile,freshProgress,now);
 assert.deepEqual((await read(freshProgress)).raceExport.records,saved.records);
 assert.ok(!Object.keys(JSON.parse(index).files).includes('export-progress.json'));
});
