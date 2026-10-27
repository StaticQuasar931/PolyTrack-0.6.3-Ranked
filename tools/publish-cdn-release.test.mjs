import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,mkdir,readFile,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {releasePlan,checkReleaseFiles,refreshReleasePointer,publishRelease,publishAssetTree,bindSnapshotPackage,sameReleasePointer,validReleasePointer,includeReleaseAsset,assertCdnAssetSizes,POINTER_URL,POINTER_MIRRORS,REPOSITORY,validPurgeState} from './publish-cdn-release.mjs';

const sha='a'.repeat(40),hash=b=>createHash('sha256').update(b).digest('hex');
function fixture(){
  const payload=Buffer.from('rankings fixture'),id=hash(payload);
  const files=new Map(Object.entries({
    'index.html':'<head><meta name="polytrack-snapshot" content="./public-snapshots1/"><script src="./main.bundle.js"></script><script src="./polytrack_062_patch.js"></script></head>',
    'snapshot-current.json':JSON.stringify({currentdir:'public-snapshots1'}),
    'public-snapshots1/index.json':JSON.stringify({schemaVersion:1,generation:1,encoding:'gzip-xor-a7-v1',files:Object.fromEntries(['overall-manifest.json','overall-preview.json','overall-pages/1.json'].map(name=>[name,{path:id+'.bin',sha256:id,decodedBytes:payload.length}]))}),
    'public-snapshots1/bootstrap-fast.json':JSON.stringify({schemaVersion:1,generation:1,encoding:'gzip-xor-a7-v1',compactIndexVersion:1,partial:true,fallbackIndex:'index.json',files:Object.fromEntries(['overall-manifest.json','overall-preview.json','overall-pages/1.json'].map(name=>[name,[id,payload.length]]))}),
    'tools/overall-local-controller.mjs':'/* controller */','tools/overall-local-projection.mjs':'/* projection */','tools/practice-profile.mjs':'/* practice */','tools/unique-profile-name.mjs':'/* atomic names */','tools/public-snapshot-client.mjs':'/* reader */','tools/snapshot-metadata-recovery.mjs':'/* metadata */','events/client.mjs':'/* events */',
    ['public-snapshots1/'+id+'.bin']:payload,
    'extra-tracks/catalog-ui.mjs':'/* catalog */','extra-tracks/pack-ui.mjs':'/* packs */',
    'site-version.json':'{}','main.bundle.js':'/* game */','polytrack_062_patch.js':'/* patch */','simulation_worker.bundle.js':'/* worker */','polytrack_physics.wasm':'wasm fixture'
  }).map(([k,v])=>[k,Buffer.from(v)]));
  return {files,read:async file=>{if(!files.has(file))throw Error('Missing '+file);return files.get(file);}};
}
const response=bytes=>({ok:true,async arrayBuffer(){return Buffer.from(bytes);}});

test('a release references a whole commit, including unchanged entry files', async()=>{
  const f=fixture(),first=await releasePlan({commit:sha,...f}),second=await releasePlan({commit:'b'.repeat(40),...f});
  assert.equal(first.pointer.indexSha256,second.pointer.indexSha256);
  assert.notEqual(first.pointer.commit,second.pointer.commit);
  assert.ok(first.files.some(f=>f.path.endsWith('.wasm')));
});
test('invalid commit, mismatched generation and missing rankings fail closed',async()=>{
  await assert.rejects(releasePlan({commit:'main',...fixture()}),/SHA/);
  let f=fixture();f.files.set('snapshot-current.json',Buffer.from('{"currentdir":"public-snapshots2"}'));
  await assert.rejects(releasePlan({commit:sha,...f}),/disagree/);
  f=fixture();f.files.set('public-snapshots1/index.json',Buffer.from('{"schemaVersion":1,"generation":1,"encoding":"gzip-xor-a7-v1","files":{}}'));
  await assert.rejects(releasePlan({commit:sha,...f}),/fast snapshot entry|Missing initial rankings/);
  f=fixture();f.files.set('public-snapshots1/bootstrap-fast.json',Buffer.from('{}'));
  await assert.rejects(releasePlan({commit:sha,...f}),/Invalid fast snapshot/);
});
test('bootstrap rejects malformed non-ranking entries and missing runtime fields',async()=>{
  const f=fixture(),fast=JSON.parse(await f.read('public-snapshots1/bootstrap-fast.json'));
  fast.files['track-statistics.json']=['not-a-hash',1];
  f.files.set('public-snapshots1/bootstrap-fast.json',Buffer.from(JSON.stringify(fast)));
  await assert.rejects(releasePlan({commit:sha,...f}),/Invalid fast snapshot entry/);
  delete fast.files['track-statistics.json'];delete fast.partial;
  f.files.set('public-snapshots1/bootstrap-fast.json',Buffer.from(JSON.stringify(fast)));
  await assert.rejects(releasePlan({commit:sha,...f}),/Invalid fast snapshot index/);
});
test('CDN readiness compares every boot asset to local committed bytes',async()=>{
  const f=fixture(),plan=await releasePlan({commit:sha,...f}),calls=[];
  await checkReleaseFiles(plan,{fetchImpl:async url=>{calls.push(url);const file=url.split('@'+sha+'/')[1];return response(await f.read(file));}});
  assert.equal(calls.length,plan.files.length);
  assert.ok(calls.every(u=>u.startsWith('https://cdn.jsdelivr.net/gh/'+REPOSITORY+'@'+sha+'/')));
});
test('failed or wrong CDN bytes stop publication with bounded retries',async()=>{
  let count=0;
  await assert.rejects(checkReleaseFiles({pointer:{commit:sha},files:[{path:'index.html',sha256:hash('correct')}]},{fetchImpl:async()=>{count++;return response('wrong');},sleep:async()=>{}}),/not advertised/);
  assert.equal(count,3);
});
test('transient CDN 403 can recover after the old nine-second retry window',async()=>{
  let calls=0,time=0;const delays=[],messages=[];
  await checkReleaseFiles({pointer:{commit:sha},files:[{path:'images/paste.svg',sha256:hash('icon')}]},{
    fetchImpl:async()=>++calls<4?{ok:false,status:403}:response('icon'),now:()=>time,
    sleep:async ms=>{delays.push(ms);time+=ms;},log:message=>messages.push(message)});
  assert.equal(calls,4);assert.deepEqual(delays,[5000,15000,30000]);assert.ok(time>9000);
  assert.ok(messages.every(message=>message.includes('images/paste.svg')));
});
test('persistent CDN errors still fail closed after bounded backoff',async()=>{
  let calls=0,time=0;
  await assert.rejects(checkReleaseFiles({pointer:{commit:sha},files:[{path:'images/paste.svg',sha256:hash('icon')}]},{
    fetchImpl:async()=>{calls++;return {ok:false,status:403};},now:()=>time,
    sleep:async ms=>{time+=ms;},log:()=>{}}),/not advertised: images\/paste.svg after 5 attempts/);
  assert.equal(calls,5);assert.equal(time,110000);
});
test('Retry-After is respected within the readiness budget',async()=>{
  let calls=0,time=0;const delays=[];
  await checkReleaseFiles({pointer:{commit:sha},files:[{path:'index.html',sha256:hash('html')}]},{
    fetchImpl:async()=>++calls===1?{ok:false,status:429,headers:{get:()=> '45'}}:response('html'),now:()=>time,
    sleep:async ms=>{delays.push(ms);time+=ms;},log:()=>{}});
  assert.deepEqual(delays,[45000]);
});
test('readiness budget stops further retries instead of waiting indefinitely',async()=>{
  let calls=0,time=0;
  await assert.rejects(checkReleaseFiles({pointer:{commit:sha},files:[{path:'index.html',sha256:hash('html')}]},{
    fetchImpl:async()=>{calls++;time+=110000;return {ok:false,status:503};},now:()=>time,
    sleep:async ms=>{time+=ms;},log:()=>{}}),/not advertised/);
  assert.equal(calls,3);
});
test('package-size denial is permanent and is not retried as a temporary 403',async()=>{
  let calls=0;
  await assert.rejects(checkReleaseFiles({pointer:{commit:sha},files:[{path:'index.html',sha256:hash('html')}]},{
    fetchImpl:async()=>{calls++;return {ok:false,status:403,text:async()=> 'Package size exceeded the configured limit of 50 MB.'};},
    sleep:async()=>assert.fail('must not retry package size errors'),log:()=>{}}),/after 1 attempts/);
  assert.equal(calls,1);
});
test('compact tree keeps current snapshots and runtime while excluding old generations and development files',()=>{
  for(const file of ['index.html','main.bundle.js','images/paste.svg','events/session.mjs','public-snapshots52/abc.bin','tools/public-snapshot-client.mjs'])assert.equal(includeReleaseAsset(file,'public-snapshots52'),true,file);
  for(const file of ['public-snapshots37/abc.bin','.github/workflows/verify.yml','docs/notes.md','tools/verifier/run.mjs','workers/ranked/test/unit.test.js','tools/example.test.mjs'])assert.equal(includeReleaseAsset(file,'public-snapshots52'),false,file);
});
test('every CDN file, not only readiness probes, must be strictly below 20 MB',()=>{
  assert.doesNotThrow(()=>assertCdnAssetSizes([{path:'large.bin',bytes:19999999}]));
  for(const bytes of [20000000,20000001,NaN,-1])assert.throws(()=>assertCdnAssetSizes([{path:'large.bin',bytes}]),/under 20,000,000/);
});
test('the full tar archive, including padding, must stay strictly below 49 MB before push',async()=>{
  const calls=[];
  await assert.rejects(publishAssetTree({pointer:{commit:sha,snapshotDirectory:'public-snapshots1'},files:[{path:'index.html'}]},args=>{
    calls.push(args[0]);
    if(args[0]==='ls-tree')return '100644 blob '+'b'.repeat(40)+' 1\tindex.html\0';
    if(args[0]==='write-tree')return 'c'.repeat(40);
    if(args[0]==='archive')return Buffer.alloc(49000000);
    if(['read-tree','update-index'].includes(args[0]))return '';
    assert.fail('archive rejection must precede remote or push: '+args[0]);
  }),/49 MB/);
  assert.ok(!calls.includes('push'));
});
test('a current loader pointer avoids redundant purges',async()=>{
  const expected=(await releasePlan({commit:sha,...fixture()})).pointer,calls=[];
  const result=await refreshReleasePointer(expected,{sleep:async()=>{},fetchImpl:async url=>{calls.push(url);return response(JSON.stringify(expected));}});
  assert.deepEqual(calls,[POINTER_URL]);assert.equal(result.purges,0);assert.equal(result.confirmed,true);
});
test('purge success with stale pointer is not reported as success',async()=>{
  const expected=(await releasePlan({commit:sha,...fixture()})).pointer,calls=[];let time=0;
  await assert.rejects(refreshReleasePointer(expected,{now:()=>time,log:()=>{},sleep:async ms=>{time+=ms;},fetchImpl:async url=>{calls.push(url);return response(JSON.stringify(url.includes('purge.jsdelivr.net')?{status:'finished'}:{...expected,commit:'b'.repeat(40)}));}}),error=>error.code==='CDN_PROPAGATION_PENDING'&&error.purges===1);
  assert.equal(calls.filter(url=>url.includes('purge.jsdelivr.net')).length,1);
  assert.ok(calls.length<=12);assert.equal(calls.filter(url=>POINTER_MIRRORS.includes(url)).length,2);assert.ok(time<=240000);assert.ok(time>49000);
});

test('delayed CDN propagation recovers beyond the old 49-second limit without repeated purging',async()=>{
  const expected=(await releasePlan({commit:sha,...fixture()})).pointer,calls=[];let time=0;
  const result=await refreshReleasePointer(expected,{now:()=>time,log:()=>{},sleep:async ms=>{time+=ms;},fetchImpl:async url=>{
    calls.push(url);return response(JSON.stringify(url.includes('purge.jsdelivr.net')?{status:'finished'}:time<110000?{...expected,commit:'b'.repeat(40)}:expected));
  }});
  assert.equal(result.confirmed,true);assert.equal(result.elapsedMs,110000);assert.equal(result.purges,1);
  assert.ok(calls.every(url=>url===POINTER_URL||url===POINTER_URL.replace('://cdn.','://purge.')));
});

test('purge transport failures do not prevent confirming actually current content',async()=>{
  const expected=(await releasePlan({commit:sha,...fixture()})).pointer;let reads=0;
  const result=await refreshReleasePointer(expected,{log:()=>{},sleep:async()=>{},fetchImpl:async url=>{
    if(url.includes('purge.jsdelivr.net'))throw TypeError('fetch failed');
    return response(JSON.stringify(++reads===1?{...expected,commit:'b'.repeat(40)}:expected));
  }});
  assert.equal(result.confirmed,true);assert.equal(result.purges,1);assert.equal(reads,2);
});

test('finished purge with a throttled path defers honestly instead of claiming propagation',async()=>{
  const expected=(await releasePlan({commit:sha,...fixture()})).pointer,calls=[];
  const result=await refreshReleasePointer(expected,{sleep:async()=>assert.fail('do not wait through a provider cooldown'),fetchImpl:async url=>{
    calls.push(url);return response(JSON.stringify(url.includes('purge.jsdelivr.net')?
      {status:'finished',paths:{[new URL(POINTER_URL).pathname]:{throttled:true,throttlingReset:2561}}}:{...expected,commit:'b'.repeat(40)}));
  }});
  assert.equal(result.confirmed,false);assert.equal(result.status,'deferred');assert.equal(result.reason,'purge-throttled');assert.equal(result.retryAfterMs,2561000);assert.equal(calls.length,4);
});

test('purge HTTP rate limiting is deferred without replaying captures or waiting out the cooldown',async()=>{
  const expected=(await releasePlan({commit:sha,...fixture()})).pointer;
  const result=await refreshReleasePointer(expected,{sleep:async()=>assert.fail('do not spin on 429'),fetchImpl:async url=>url.includes('purge.jsdelivr.net')?
    {ok:false,status:429,headers:{get:()=> '120'}}:response(JSON.stringify({...expected,commit:'b'.repeat(40)}))});
  assert.equal(result.confirmed,false);assert.equal(result.status,'deferred');assert.equal(result.reason,'purge-rate-limited');assert.equal(result.retryAfterMs,120000);
});

test('an invalid or foreign pointer cannot become a successful release confirmation',async()=>{
  const expected=(await releasePlan({commit:sha,...fixture()})).pointer;let calls=0;
  for(const actual of [{...expected,repository:'another/repository'},{...expected,indexSha256:'bad'},{...expected,publishedAt:'invalid'},null]){
    await assert.rejects(refreshReleasePointer(expected,{fetchImpl:async()=>{calls++;return response(JSON.stringify(actual));}}),/Invalid CDN release pointer/);
  }
  assert.equal(calls,4);
  await assert.rejects(refreshReleasePointer({...expected,commit:'main'},{fetchImpl:async()=>assert.fail('invalid expected pointer must not fetch')}),/Invalid expected/);
});

test('source commit equality is checked even when immutable asset bytes are unchanged',async()=>{
  const expected={...(await releasePlan({commit:sha,...fixture()})).pointer,sourceCommit:'f'.repeat(40)};let reads=0;
  const result=await refreshReleasePointer(expected,{log:()=>{},sleep:async()=>{},fetchImpl:async url=>response(JSON.stringify(url.includes('purge.jsdelivr.net')?{status:'finished'}:++reads===1?{...expected,sourceCommit:'e'.repeat(40)}:expected))});
  assert.equal(reads,2);assert.equal(result.confirmed,true);
});

test('fresh mirrors cannot confirm a stale canonical loader URL',async()=>{
  const expected=(await releasePlan({commit:sha,...fixture()})).pointer;let time=0;
  await assert.rejects(refreshReleasePointer(expected,{now:()=>time,sleep:async ms=>{time+=ms;},log:()=>{},
    fetchImpl:async url=>response(JSON.stringify(POINTER_MIRRORS.includes(url)?expected:url.includes('purge.')?{status:'finished'}:{...expected,commit:'b'.repeat(40)}))}),
    error=>error.code==='CDN_PROPAGATION_PENDING'&&error.mirrors.length===2&&error.mirrors.every(row=>row.status==='current'));
});

test('obsolete authoritative pointer stops polling and purging, not falsely confirming replacement',async()=>{
  const expected=(await releasePlan({commit:sha,...fixture()})).pointer;
  const result=await refreshReleasePointer(expected,{getCurrentPointer:async()=>({...expected,commit:'b'.repeat(40)}),
    fetchImpl:async()=>assert.fail('obsolete pointer must not touch CDN'),sleep:async()=>assert.fail('obsolete job must stop')});
  assert.equal(result.status,'superseded');assert.equal(result.confirmed,false);assert.equal(result.purges,0);
});

test('authority changing while the CDN request is in flight prevents stale confirmation',async()=>{
  const expected=(await releasePlan({commit:sha,...fixture()})).pointer;let checks=0;
  const result=await refreshReleasePointer(expected,{getCurrentPointer:async()=>++checks===1?expected:{...expected,commit:'b'.repeat(40)},fetchImpl:async()=>response(JSON.stringify(expected))});
  assert.equal(result.status,'superseded');assert.equal(result.confirmed,false);assert.equal(checks,2);
});

test('unavailable pointer authority defers without pretending CDN content is current',async()=>{
  const expected=(await releasePlan({commit:sha,...fixture()})).pointer;
  const result=await refreshReleasePointer(expected,{getCurrentPointer:async()=>{throw TypeError('Git transport unavailable');},fetchImpl:async()=>assert.fail('no CDN requests without authority')});
  assert.equal(result.reason,'pointer-authority-unavailable');assert.equal(result.confirmed,false);
});

test('persisted provider cooldown skips purge but still checks the actual loader URL first',async()=>{
  const expected=(await releasePlan({commit:sha,...fixture()})).pointer, calls=[];
  const options={now:()=>1000,purgeState:{schemaVersion:1,pointerUrl:POINTER_URL,updatedAt:0,nextPurgeAt:3600000},
    fetchImpl:async url=>{calls.push(url);assert.ok(!url.includes('purge.'));return response(JSON.stringify({...expected,commit:'b'.repeat(40)}));}};
  const result=await refreshReleasePointer(expected,options);
  assert.equal(result.status,'deferred');assert.equal(result.reason,'purge-cooldown');assert.equal(result.retryAfterMs,3599000);
  assert.equal(calls[0],POINTER_URL);assert.equal(calls.length,3);
  const fresh=await refreshReleasePointer(expected,{...options,fetchImpl:async()=>response(JSON.stringify(expected))});
  assert.equal(fresh.confirmed,true);
});

test('hour-long Retry-After is persisted intact instead of clamped to asset retry duration',async()=>{
  const expected=(await releasePlan({commit:sha,...fixture()})).pointer,states=[];
  const result=await refreshReleasePointer(expected,{now:()=>1000,savePurgeState:async state=>states.push(state),
    fetchImpl:async url=>url.includes('purge.')?{ok:false,status:429,headers:{get:()=> '3600'}}:response(JSON.stringify({...expected,commit:'b'.repeat(40)}))});
  assert.equal(result.retryAfterMs,3600000);assert.equal(states.at(-1).nextPurgeAt,3601000);assert.equal(validPurgeState(states.at(-1),1000),true);
});

test('cooldown checkpoints are bounded, path-specific, and optional',async()=>{
  const base={schemaVersion:1,pointerUrl:POINTER_URL,updatedAt:1000,nextPurgeAt:2000};
  assert.equal(validPurgeState(base,1000),true);
  for(const damage of [{pointerUrl:'https://foreign.invalid/'},{updatedAt:2000},{nextPurgeAt:86401001},{nextPurgeAt:NaN},{schemaVersion:2}])assert.equal(validPurgeState({...base,...damage},1000),false);
  const expected=(await releasePlan({commit:sha,...fixture()})).pointer;let reads=0;
  const result=await refreshReleasePointer(expected,{savePurgeState:async()=>{throw Error('optional cache unavailable');},sleep:async()=>{},log:()=>{},
    fetchImpl:async url=>response(JSON.stringify(url.includes('purge.')?{status:'finished'}:++reads===1?{...expected,commit:'b'.repeat(40)}:expected))});
  assert.equal(result.confirmed,true);
});
test('forks and non-default branches cannot publish',async()=>{
  for(const options of [{repository:'fork/repo',branch:'main'},{repository:REPOSITORY,branch:'dev'}])await assert.rejects(publishRelease({...options,git:()=>assert.fail('must not run git')}),/canonical/);
});
test('real local bare remote: no source changes, first publish, no-op repeat, next commit and retries',async()=>{
  const temp=await mkdtemp(path.join(os.tmpdir(),'polytrack-cdn-release-'));
  const config=path.join(temp,'gitconfig');await writeFile(config,'');
  const env={...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:config};
  const run=(cwd,args,options={})=>execFileSync('git',['-c','safe.directory='+cwd,...args],{cwd,encoding:'utf8',stdio:['pipe','pipe','pipe'],...options,env:{...env,...options.env,GIT_CONFIG_GLOBAL:config}});
  const remote=path.join(temp,'remote.git');run(temp,['init','--bare','--initial-branch=main',remote]);
  const root=path.join(temp,'work');run(temp,['clone',remote,root]);
  run(root,['config','user.name','Release Test']);run(root,['config','user.email','test@example.invalid']);
  const f=fixture();f.files.set('public-snapshots0/obsolete.bin',Buffer.from('old snapshot'));for(const [file,bytes]of f.files){await mkdir(path.dirname(path.join(root,file)),{recursive:true});await writeFile(path.join(root,file),bytes);}
  run(root,['add','.']);run(root,['commit','-m','base']);run(root,['push','origin','main']);
  const git=(args,options)=>run(root,args,options), checks=[],purges=[];
  const options={root,branch:'main',repository:REPOSITORY,git,check:async plan=>checks.push(plan),refresh:async pointer=>purges.push(pointer)};
  const first=await publishRelease(options),pointerHead=git(['ls-remote','--heads','origin','cdn-release']).split(/\s/)[0];
  assert.equal(git(['status','--porcelain']),'');
  assert.ok(first.pointer.sourceCommit);
  assert.notEqual(first.pointer.commit,first.pointer.sourceCommit);
  assert.ok(first.assetPackage.archiveBytes<49000000);
  assert.ok(first.assetPackage.snapshot.archiveBytes<49000000);
  assert.ok(first.pointer.snapshotCommit);
  assert.notEqual(first.pointer.snapshotCommit,first.pointer.commit);
  const publishedHtml=git(['show',first.pointer.commit+':index.html']);
  assert.equal(hash(publishedHtml),first.pointer.indexSha256);
  assert.ok(publishedHtml.includes('@'+first.pointer.snapshotCommit+'/public-snapshots1/'));
  assert.ok(!git(['ls-tree','-r','--name-only',first.pointer.commit]).includes('public-snapshots1/'));
  assert.ok(git(['ls-tree','-r','--name-only',first.pointer.snapshotCommit]).includes('public-snapshots1/index.json'));
  assert.ok(!git(['ls-tree','-r','--name-only',first.pointer.snapshotCommit]).includes('main.bundle.js'));
  assert.ok(git(['ls-tree','-r','--name-only',first.pointer.sourceCommit]).includes('public-snapshots0/obsolete.bin'));
  assert.ok(!git(['ls-tree','-r','--name-only',first.pointer.commit]).includes('public-snapshots0/obsolete.bin'));
  assert.ok(git(['ls-tree','-r','--name-only',first.pointer.commit]).includes('main.bundle.js'));
  const tree=git(['ls-tree','--name-only',pointerHead]).trim();assert.equal(tree,'release.json');
  await publishRelease(options);
  assert.equal(git(['ls-remote','--heads','origin','cdn-release']).split(/\s/)[0],pointerHead,'repeat repairs purge without creating a commit');
  await writeFile(path.join(root,'unrelated.txt'),'another change');git(['add','unrelated.txt']);git(['commit','-m','next']);git(['push','origin','main']);
  const next=await publishRelease(options);
  assert.equal(first.pointer.indexSha256,next.pointer.indexSha256);
  assert.notEqual(first.pointer.commit,next.pointer.commit);
  assert.equal(purges.length,3);
  await mkdir(path.join(root,'docs'),{recursive:true});await writeFile(path.join(root,'docs/notes.md'),'documentation only');git(['add','docs/notes.md']);git(['commit','-m','docs']);git(['push','origin','main']);
  const documentation=await publishRelease(options);
  assert.equal(documentation.pointer.commit,next.pointer.commit,'unchanged asset tree reuses immutable CDN commit');
  assert.notEqual(documentation.pointer.sourceCommit,next.pointer.sourceCommit);
  assert.equal(purges.length,4);
  await assert.rejects(publishRelease({...options,check:async()=>{throw Error('CDN down');}}),/CDN down/);
  assert.equal(purges.length,4);
  const checked=checks.length;
  const repaired=await publishRelease({...options,refreshOnly:true,check:async()=>assert.fail('do not rewarm an already-published immutable package')});
  assert.equal(repaired.assetChecks,'previously-published-immutable-package');assert.equal(checks.length,checked);assert.equal(purges.length,5);
  await writeFile(path.join(root,'index.html'),(await f.read('index.html')).toString()+'\n');git(['add','index.html']);git(['commit','-m','updated entry']);git(['push','origin','main']);
  const updated=await publishRelease({...options,refreshOnly:true});
  assert.equal(updated.assetChecks,'validated');assert.equal(checks.length,checked+1,'new source still needs the full asset gate');
  const beforeRace=git(['ls-remote','--heads','origin','cdn-release']).split(/\s/)[0];
  await assert.rejects(publishRelease({...options,check:async()=>{
    await writeFile(path.join(root,'during-validation.txt'),'new main while older assets warm');
    git(['add','during-validation.txt']);git(['commit','-m','advance during readiness']);git(['push','origin','main']);
  }}),error=>error.code==='CDN_SOURCE_SUPERSEDED');
  assert.equal(git(['ls-remote','--heads','origin','cdn-release']).split(/\s/)[0],beforeRace,'late main race does not publish an obsolete pointer');
  const preload=path.join(temp,'mock-cdn.mjs'),output=path.join(temp,'cli-output'),summary=path.join(temp,'cli-summary'),state=path.join(temp,'purge-state.json');
  await writeFile(preload,`import {execFileSync} from 'node:child_process';
const root=${JSON.stringify(root)},config=${JSON.stringify(config)},base=${JSON.stringify('https://cdn.jsdelivr.net/gh/'+REPOSITORY+'@')};
const git=args=>execFileSync('git',['-c','safe.directory='+root,...args],{cwd:root,env:{...process.env,GIT_CONFIG_GLOBAL:config}});
globalThis.fetch=async url=>{
 if(url===${JSON.stringify(POINTER_URL)} || ${JSON.stringify(POINTER_MIRRORS)}.includes(url)){
  const ref=git(['ls-remote','--heads','origin','cdn-release']).toString().split(/\\s/)[0];
  const pointer=JSON.parse(git(['show',ref+':release.json']));
  return Response.json({...pointer,commit:'f'.repeat(40)});
 }
 if(url===${JSON.stringify(POINTER_URL.replace('://cdn.','://purge.'))})return new Response('',{status:429,headers:{'Retry-After':'3600'}});
 if(url.startsWith(base)){const suffix=url.slice(base.length),index=suffix.indexOf('/');return new Response(git(['show',suffix.slice(0,index)+':'+suffix.slice(index+1)]));}
 throw Error('Unexpected network URL blocked in offline CLI test');
};\n`);
  execFileSync(process.execPath,['--import',pathToFileURL(preload).href,fileURLToPath(new URL('./publish-cdn-release.mjs',import.meta.url)),'--refresh-only'],{
    cwd:root,encoding:'utf8',timeout:120000,env:{...env,DEFAULT_BRANCH:'main',GITHUB_REPOSITORY:REPOSITORY,
      GITHUB_OUTPUT:output,GITHUB_STEP_SUMMARY:summary,CDN_PURGE_STATE_FILE:state},stdio:['pipe','pipe','pipe']});
  assert.equal(await readFile(output,'utf8'),'cdn_status=deferred\n');
  assert.match(await readFile(summary,'utf8'),/freshness is NOT confirmed/);
  const checkpoint=JSON.parse(await readFile(state,'utf8'));
  assert.equal(checkpoint.nextPurgeAt-checkpoint.updatedAt,3600000,'CLI checkpoint retains provider hour cooldown');
});
test('all file-writing workflows explicitly publish after their push, including token pushes',async()=>{
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const directory=path.join(root,'.github/workflows');
  for(const file of await readdir(directory)){
    if(!file.endsWith('.yml'))continue;
    const text=await readFile(path.join(directory,file),'utf8');
    if(text.includes('node tools/push-public-capture.mjs')){
      assert.match(text,/publish_cdn_release:[\s\S]*needs: sync[\s\S]*uses: \.\/\.github\/workflows\/publish-cdn-release\.yml/,file);
      assert.ok(text.indexOf('publish_cdn_release:')>text.indexOf('node tools/push-public-capture.mjs'),file);
    }
  }
  const publisher=await readFile(path.join(directory,'publish-cdn-release.yml'),'utf8');
  assert.match(publisher,/branches: \[main\]/);assert.match(publisher,/workflow_call:/);
  assert.ok(!publisher.includes('pull_request_target'));assert.ok(!publisher.includes('workflow_run:'));
  assert.match(publisher,/fetch-depth: 0/);
});

test('lazy browser tools and their shared dependencies remain in the readiness graph', async()=>{
  const f=fixture();
  f.files.set('polytrack_062_patch.js',Buffer.from("import('./tools/lazy-client.mjs?v=1');"));
  f.files.set('tools/lazy-client.mjs',Buffer.from("import {ids} from '../workers/ranked/src/browser-ids.js';"));
  f.files.set('workers/ranked/src/browser-ids.js',Buffer.from('export const ids=[];'));
  const plan=await releasePlan({commit:sha,...f}),needed=new Set(plan.files.map(file=>file.path));
  for(const file of ['tools/lazy-client.mjs','workers/ranked/src/browser-ids.js']){
    assert.ok(needed.has(file),file);
    assert.equal(includeReleaseAsset(file,'public-snapshots1',needed),true);
  }
  for(const file of ['tools/update-public-snapshot.mjs','tools/publish-cdn-release.mjs','workers/ranked/src/index.js','workers/ranked/wrangler.jsonc','electron/main.js','images/icons/cover1920x1080.png'])
    assert.equal(includeReleaseAsset(file,'public-snapshots1',needed),false,file);
  assert.equal(includeReleaseAsset('public-snapshots1/preserved-replay.bin','public-snapshots1',needed),true);
  assert.equal(includeReleaseAsset('events/kodub/assets/archived.track','public-snapshots1',needed),true);
  needed.add('images/icons/cover1920x1080.png');
  assert.equal(includeReleaseAsset('images/icons/cover1920x1080.png','public-snapshots1',needed),true,'explicitly needed image cannot be trimmed');
});

test('the current shipped snapshot fits the CDN tar budget without dropping any snapshot files',{timeout:120000},async t=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const local=(args,options={})=>execFileSync('git',['-c','safe.directory='+root,...args],{cwd:root,encoding:'utf8',maxBuffer:20000000,...options});
  const commit=process.env.POLYTRACK_CDN_TEST_COMMIT||local(['rev-parse','HEAD']).trim(),plan=await releasePlan({root,commit});
  let selected=[];
  const git=(args,options={})=>{
    if(args[0]==='ls-remote'||args[0]==='push')return '';
    if(args[0]==='commit-tree')return 'c'.repeat(40);
    if(args[0]==='fetch')assert.fail('capacity regression must not access a remote');
    if(args[0]==='update-index')selected=options.input.split('\0').filter(Boolean).map(line=>line.split('\t')[1]);
    return local(args,options);
  };
  const snapshot=await publishAssetTree(plan,git,{partition:'snapshot'});
  const snapshotFiles=local(['ls-tree','-r','--name-only',commit,'--',plan.pointer.snapshotDirectory]).trim().split('\n');
  assert.equal(snapshotFiles.filter(file=>!selected.includes(file)).length,0,'all replay payloads and lookup/index files are retained');
  assert.ok(selected.includes('snapshot-current.json'),'snapshot recovery pointer stays with its data');
  assert.ok(!selected.includes('main.bundle.js'));
  const entryHtml=bindSnapshotPackage(plan,snapshot.commit);
  const runtime=await publishAssetTree(plan,git,{partition:'runtime',entryHtml});
  assert.ok(snapshot.archiveBytes<49000000);assert.ok(runtime.archiveBytes<49000000);
  assert.ok(!selected.some(file=>file.startsWith(plan.pointer.snapshotDirectory+'/')));
  assert.ok(!selected.includes('workers/ranked/src/index.js'));
  assert.ok(selected.includes('workers/ranked/src/extra-track-ids.js'),'shared browser scoring input stays available');
  t.diagnostic('Immutable tars: runtime '+runtime.archiveBytes+', snapshot '+snapshot.archiveBytes+' bytes; '+plan.files.length+' readiness probes; no remote requests.');
});

test('split snapshot binding changes only the CDN entry and keeps source HTML reusable',async()=>{
  const plan=await releasePlan({commit:sha,...fixture()}),original=plan.entryHtml,snapshot='d'.repeat(40);
  const html=bindSnapshotPackage(plan,snapshot);
  assert.equal(plan.entryHtml,original);
  assert.equal(plan.pointer.indexSha256,hash(html));
  assert.equal(plan.files.find(file=>file.path==='index.html').sha256,hash(html));
  assert.ok(html.includes('https://cdn.jsdelivr.net/gh/'+REPOSITORY+'@'+snapshot+'/public-snapshots1/'));
  for(const file of plan.files)assert.equal(file.commit,file.path.startsWith('public-snapshots1/')?snapshot:undefined);
  assert.equal(bindSnapshotPackage(plan,snapshot),html,'repeat binding never rewrites the already absolute output twice');
  assert.equal(validReleasePointer({...plan.pointer,snapshotCommit:'invalid'}),false);
  assert.equal(sameReleasePointer({...plan.pointer,snapshotCommit:'e'.repeat(40)},plan.pointer),false);
  assert.throws(()=>bindSnapshotPackage(plan,'main'),/Invalid snapshot package/);
});

test('readiness validates each snapshot probe at its own immutable commit',async()=>{
  const plan=await releasePlan({commit:sha,...fixture()}),snapshot='d'.repeat(40),html=bindSnapshotPackage(plan,snapshot);
  plan.pointer.commit='c'.repeat(40);
  const f=fixture(),urls=[];
  await checkReleaseFiles(plan,{fetchImpl:async url=>{
    urls.push(url);
    const file=plan.files.find(file=>url.endsWith('/'+file.path));assert.ok(file);
    assert.ok(url.includes('@'+(file.commit||plan.pointer.commit)+'/'));
    return response(file.path==='index.html'?html:await f.read(file.path));
  }});
  assert.equal(urls.length,plan.files.length);
  assert.ok(urls.some(url=>url.includes('@'+snapshot+'/public-snapshots1/')));
});
