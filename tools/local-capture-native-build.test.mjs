import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {NATIVE_SOURCE_SHA256,NATIVE_TOOLCHAIN,runNativeBuildCommand,validateNativeManifest,validateNativeArtifact,withNativeBuildStage} from './local-capture-native-build.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const switches=['/nologo','/noconfig','/nostdlib+','/target:exe','/platform:x64','/optimize+','/debug-'];
const toolchainKey=hash(JSON.stringify({version:1,toolchain:NATIVE_TOOLCHAIN,switches}));
const binarySha256='a'.repeat(64),identity={device:'123',file:'456'};
const manifest=()=>({version:1,sourceSha256:NATIVE_SOURCE_SHA256,toolchainKey,toolchain:{...NATIVE_TOOLCHAIN},switches:[...switches],binarySha256,identity:{...identity}});

test('native manifest binds exact source, toolchain, switches, binary hash and file identity',()=>{
  assert.equal(validateNativeManifest(manifest(),{binarySha256,identity}),true);
});
for(const [name,change] of [
  ['version',m=>m.version++],['source',m=>m.sourceSha256='b'.repeat(64)],
  ['toolchain key',m=>m.toolchainKey='b'.repeat(64)],['compiler',m=>m.toolchain['csc.exe']='b'.repeat(64)],
  ['compiler config',m=>m.toolchain['csc.exe.config']='b'.repeat(64)],['system assembly',m=>m.toolchain['System.dll']='b'.repeat(64)],
  ['switches',m=>m.switches.push('/unsafe')],['binary hash',m=>m.binarySha256='b'.repeat(64)],
  ['file identity',m=>m.identity.file='457'],['volume identity',m=>m.identity.device='124']
])test('native manifest rejects changed '+name,()=>{
  const value=manifest();change(value);assert.throws(()=>validateNativeManifest(value,{binarySha256,identity}),/BINDING_MISMATCH/);
});

function fixture({killCloses=true}={}) {
  const child=new EventEmitter();child.pid=99999;child.stdout=new EventEmitter();child.stderr=new EventEmitter();
  const calls=[];child.kill=()=>{calls.push('kill');if(killCloses)queueMicrotask(()=>child.emit('close',null,'SIGTERM'));return true;};
  const spawnImpl=(file,args,options)=>{calls.push({file,args,options});return child;};
  const run=extra=>runNativeBuildCommand({file:'pinned-csc.exe',args:['/noconfig'],options:{shell:true},deadline:Date.now()+30000,spawnImpl,...extra});
  return {child,calls,run};
}
test('bounded compiler uses no shell or stdin and waits for close',async()=>{
  const f=fixture(),p=f.run();f.child.stdout.emit('data',Buffer.from('ok'));
  let settled=false;p.then(()=>{settled=true;});f.child.emit('exit',0,null);await Promise.resolve();assert.equal(settled,false);
  f.child.emit('close',0,null);assert.deepEqual(await p,{output:'ok'});
  assert.equal(f.calls[0].options.shell,false);assert.equal(f.calls[0].options.windowsHide,true);
  assert.deepEqual(f.calls[0].options.stdio,['ignore','pipe','pipe']);
});
test('build rejects exhausted deadline without spawning',async()=>{
  const f=fixture();await assert.rejects(f.run({deadline:Date.now()+4999}),/DEADLINE/);assert.equal(f.calls.length,0);
});
test('build rejects already aborted preparation without spawning',async()=>{
  const f=fixture(),abort=new AbortController();abort.abort();await assert.rejects(f.run({signal:abort.signal}));assert.equal(f.calls.length,0);
});
test('build timeout reserves five seconds to close the exact compiler',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture(),p=f.run({deadline:Date.now()+6000});
  const rejected=assert.rejects(p,/NATIVE_BUILD_DEADLINE/);t.mock.timers.tick(1001);await rejected;assert.equal(f.calls.filter(v=>v==='kill').length,1);
});
test('build abort kills only its retained child and rejects even a subsequent zero close',async()=>{
  const f=fixture({killCloses:false}),abort=new AbortController(),p=f.run({signal:abort.signal});
  const rejected=assert.rejects(p,/ABORTED/);abort.abort();f.child.emit('close',0,null);await rejected;assert.equal(f.calls.filter(v=>v==='kill').length,1);
});
test('unconfirmed compiler close remains a failure',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=fixture({killCloses:false}),p=f.run({deadline:Date.now()+6000});
  const rejected=assert.rejects(p,e=>e.code==='NATIVE_BUILD_CLOSE_UNCONFIRMED'&&e.cleanupConfirmed===false&&e.directProcessClosed===false);
  t.mock.timers.tick(1001);t.mock.timers.tick(5000);await rejected;f.child.emit('close',0,null);
});
test('oversized compiler output stops the compiler without exposing output',async()=>{
  const f=fixture(),p=f.run();const rejected=assert.rejects(p,/OUTPUT_LIMIT/);f.child.stderr.emit('data',Buffer.alloc(16385));await rejected;
  assert.equal(f.calls.filter(v=>v==='kill').length,1);
});
test('nonzero compiler result is rejected without exposing diagnostics',async()=>{
  const f=fixture(),p=f.run();f.child.stderr.emit('data',Buffer.from('private-data'));f.child.emit('close',1,null);
  await assert.rejects(p,e=>e.code==='NATIVE_BUILD_FAILED'&&e.directProcessClosed===true&&!e.message.includes('private-data'));
});
test('synchronous compiler spawn failure is sanitized',async()=>{
  await assert.rejects(runNativeBuildCommand({file:'compiler',args:[],deadline:Date.now()+30000,spawnImpl(){throw Error('private-data');}}),e=>e.code==='NATIVE_BUILD_SPAWN_FAILED'&&!e.message.includes('private-data'));
});
test('asynchronous spawn failure with no process is rejected without a kill attempt',async()=>{
  const f=fixture();delete f.child.pid;const p=f.run();f.child.emit('error',Error('private-data'));
  await assert.rejects(p,/SPAWN_FAILED/);assert.equal(f.calls.includes('kill'),false);
});
test('error after compiler launch requires retained child cleanup',async()=>{
  const f=fixture(),p=f.run();f.child.emit('error',Error('private-data'));
  await assert.rejects(p,/SPAWN_FAILED/);assert.equal(f.calls.filter(v=>v==='kill').length,1);
});

const source=await fs.readFile(new URL('./local-capture-native-broker.cs',import.meta.url));
const buildSource=await fs.readFile(new URL('./local-capture-native-build.mjs',import.meta.url),'utf8');
test('native C# is exactly the proven duplex prototype source',()=>{
  assert.equal(hash(Buffer.from(source.toString('utf8').replace(/\r\n?/g,'\n'))),NATIVE_SOURCE_SHA256);
});
test('build pins system compiler, config and explicit framework references without policy bypass',()=>{
  assert.deepEqual(Object.keys(NATIVE_TOOLCHAIN),['csc.exe','csc.exe.config','mscorlib.dll','System.dll','System.Core.dll']);
  assert.match(buildSource,/\/noconfig/);assert.match(buildSource,/\/nostdlib\+/);assert.match(buildSource,/\/reference:/);
  assert.doesNotMatch(buildSource,/-ExecutionPolicy|ExecutionPolicy\s+Bypass|Unblock-File|takeown|icacls/i);
  assert.match(buildSource,/SetAccessRuleProtection\(\$true,\$false\)/);assert.match(buildSource,/Unexpected access/);
  assert.match(buildSource,/AreAccessRulesProtected/);assert.match(buildSource,/ReparsePoint/);
  assert.match(buildSource,/native-supervisor-v1/);assert.match(buildSource,/flag:'wx'/);
  assert.match(buildSource,/NATIVE_ACL_TOOL_PIN_MISMATCH/);assert.match(buildSource,/NATIVE_SYSTEM_ROOT_INVALID/);
  assert.match(buildSource,/NATIVE_CACHE_RESOURCE_BOUND/);assert.match(buildSource,/stat\.nlink!==1n/);
});

test('artifact validation rejects extra files, changed source, replaced binary identity and hash tampering',async t=>{
  const here=path.dirname(fileURLToPath(import.meta.url));
  let root=here;while(path.basename(root).toLowerCase()!=='ranked-0.6.3'){const next=path.dirname(root);assert.notEqual(next,root);root=next;}
  assert.equal(path.basename(path.dirname(root)).toLowerCase(),'projects');
  assert.equal(path.basename(path.dirname(path.dirname(root))).toLowerCase(),'polytrack');
  const parent=path.join(root,'local-reports','native-build-unit-tests');await fs.mkdir(parent,{recursive:true});
  const directory=await fs.mkdtemp(path.join(parent,'artifact-'));
  t.after(async()=>{assert.equal(path.dirname(directory),parent);await fs.rm(directory,{recursive:true,force:true});});
  const executable=path.join(directory,'broker.exe'),fake=Buffer.alloc(1024);fake.write('MZ');
  await fs.writeFile(path.join(directory,'broker.cs'),source);await fs.writeFile(executable,fake);
  const stat=await fs.stat(executable,{bigint:true}),value={...manifest(),binarySha256:hash(fake),identity:{device:String(stat.dev),file:String(stat.ino)}};
  const writeManifest=()=>fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(value));await writeManifest();
  assert.equal((await validateNativeArtifact(directory)).executable,executable);
  await fs.writeFile(path.join(directory,'broker.exe.config'),'unexpected');await assert.rejects(validateNativeArtifact(directory),/INVENTORY/);await fs.unlink(path.join(directory,'broker.exe.config'));
  await fs.writeFile(path.join(directory,'broker.cs'),'changed');await assert.rejects(validateNativeArtifact(directory),/CONTENT/);await fs.writeFile(path.join(directory,'broker.cs'),source);
  fake[1023]=1;await fs.writeFile(executable,fake);await assert.rejects(validateNativeArtifact(directory),/BINDING_MISMATCH/);
  value.binarySha256=hash(fake);value.identity.file='0';await writeManifest();await assert.rejects(validateNativeArtifact(directory),/BINDING_MISMATCH/);
});

async function stageFixture(t) {
  let project=path.dirname(fileURLToPath(import.meta.url));
  while(path.basename(project).toLowerCase()!=='ranked-0.6.3'){const next=path.dirname(project);assert.notEqual(next,project);project=next;}
  const parent=path.join(project,'local-reports','native-build-unit-tests');await fs.mkdir(parent,{recursive:true});
  const directory=await fs.mkdtemp(path.join(parent,'stages-')),links=[];
  t.after(async()=>{
    assert.equal(path.dirname(directory),parent);
    for(const link of links){assert(path.relative(directory,link)&&!path.relative(directory,link).startsWith('..'));try{if((await fs.lstat(link)).isSymbolicLink())await fs.unlink(link);}catch(error){if(error.code!=='ENOENT')throw error;}}
    await fs.rm(directory,{recursive:true,force:true});
  });
  const cacheRoot=path.join(directory,'cache');await fs.mkdir(cacheRoot);
  const artifact=path.join(cacheRoot,NATIVE_SOURCE_SHA256+'-'+toolchainKey),calls=[];let stage,closed=true;
  const privateDirectory=async(value,action)=>{calls.push({value,action});if(action==='create'){stage=value;await fs.mkdir(value);}};
  const run=extra=>withNativeBuildStage({cacheRoot,artifact,privateDirectory,isClosed:()=>closed,
    build:async value=>{await fs.writeFile(path.join(value,'broker.exe'),'candidate');},
    validate:async value=>({executable:path.join(value,'broker.exe')}),...extra});
  const link=async(value,target)=>{await fs.symlink(target,value,'junction');links.push(value);};
  return {directory,cacheRoot,artifact,calls,run,link,stage:()=>stage,unconfirmed:()=>{closed=false;}};
}
const absent=async file=>assert.rejects(fs.lstat(file),{code:'ENOENT'});

test('confirmed failed build removes only its random invocation stage',async t=>{
  const f=await stageFixture(t),other=path.join(f.cacheRoot,'stage-'+'e'.repeat(32));await fs.mkdir(other);await fs.writeFile(path.join(other,'guard'),'keep');
  const failure=Error('compiler rejected');
  await assert.rejects(f.run({build:async stage=>{await fs.writeFile(path.join(stage,'partial.exe'),'partial');throw failure;}}),error=>error===failure);
  await absent(f.stage());assert.equal(await fs.readFile(path.join(other,'guard'),'utf8'),'keep');
});
test('confirmed compiler failure closure permits cleanup but does not change failure result',async t=>{
  const f=await stageFixture(t),command=fixture();
  await assert.rejects(f.run({build:async stage=>{
    await fs.writeFile(path.join(stage,'broker.cs'),'source');const result=command.run();command.child.emit('close',1,null);
    try{await result;}catch(error){assert.equal(error.directProcessClosed,true);throw error;}
  }}),{code:'NATIVE_BUILD_FAILED'});await absent(f.stage());
});
test('unconfirmed direct process close preserves the stage and failure',async t=>{
  const f=await stageFixture(t),failure=Object.assign(Error('compiler close unconfirmed'),{directProcessClosed:false});
  await assert.rejects(f.run({build:async stage=>{await fs.writeFile(path.join(stage,'partial.exe'),'keep');f.unconfirmed();throw failure;}}),error=>error===failure);
  assert.equal(await fs.readFile(path.join(f.stage(),'partial.exe'),'utf8'),'keep');await absent(f.artifact);
});
test('unconfirmed closure cannot publish even if a build callback returns',async t=>{
  const f=await stageFixture(t);await assert.rejects(f.run({build:async()=>{f.unconfirmed();}}),/CLOSE_UNCONFIRMED/);
  assert((await fs.lstat(f.stage())).isDirectory());await absent(f.artifact);
});
test('successful published artifact is never stage-cleaned',async t=>{
  const f=await stageFixture(t);assert.deepEqual(await f.run(),{executable:path.join(f.artifact,'broker.exe')});
  await absent(f.stage());assert.equal(await fs.readFile(path.join(f.artifact,'broker.exe'),'utf8'),'candidate');
});
test('confirmed race loser is cleaned while existing winner is validated and preserved',async t=>{
  const f=await stageFixture(t);await fs.mkdir(f.artifact);await fs.writeFile(path.join(f.artifact,'broker.exe'),'winner');
  await f.run();await absent(f.stage());assert.equal(await fs.readFile(path.join(f.artifact,'broker.exe'),'utf8'),'winner');
  assert(f.calls.some(v=>v.value===f.artifact&&v.action==='validate'));
});
test('winner arriving at publication cleans the losing stage after confirmed close',async t=>{
  const f=await stageFixture(t);let raced=0;
  await f.run({renameStage:async(from,to)=>{
    assert.equal(from,f.stage());assert.equal(to,f.artifact);raced++;
    await fs.mkdir(to);await fs.writeFile(path.join(to,'guard'),'winner');throw Object.assign(Error('race'),{code:'EEXIST'});
  }});
  assert.equal(raced,1);await absent(f.stage());assert.equal(await fs.readFile(path.join(f.artifact,'guard'),'utf8'),'winner');
  assert(f.calls.some(v=>v.value===f.artifact&&v.action==='validate'));
});
test('unconfirmed winner validation preserves both loser stage and existing artifact',async t=>{
  const f=await stageFixture(t);await fs.mkdir(f.artifact);await fs.writeFile(path.join(f.artifact,'guard'),'winner');
  let ownStage;
  await assert.rejects(f.run({privateDirectory:async(value,action)=>{
    if(action==='create'){ownStage=value;await fs.mkdir(value);return;}
    f.unconfirmed();throw Object.assign(Error('validation process close unconfirmed'),{directProcessClosed:false});
  }}),/close unconfirmed/);
  assert.equal(await fs.readFile(path.join(ownStage,'broker.exe'),'utf8'),'candidate');assert.equal(await fs.readFile(path.join(f.artifact,'guard'),'utf8'),'winner');
});
test('invalid existing winner is never deleted even when race loser cleanup succeeds',async t=>{
  const f=await stageFixture(t);await fs.mkdir(f.artifact);await fs.writeFile(path.join(f.artifact,'guard'),'keep');
  await assert.rejects(f.run({validate:async()=>{throw Error('invalid winner');}}),/invalid winner/);
  await absent(f.stage());assert.equal(await fs.readFile(path.join(f.artifact,'guard'),'utf8'),'keep');
});
test('preexisting empty artifact is not replaced or removed',async t=>{
  const f=await stageFixture(t);await fs.mkdir(f.artifact);const before=await fs.stat(f.artifact,{bigint:true});
  await assert.rejects(f.run({validate:async()=>{throw Error('empty winner');}}),/empty winner/);
  await absent(f.stage());const after=await fs.stat(f.artifact,{bigint:true});assert.equal(after.ino,before.ino);assert.deepEqual(await fs.readdir(f.artifact),[]);
});
test('failed validation after publication preserves the new artifact and error',async t=>{
  const f=await stageFixture(t);await assert.rejects(f.run({validate:async()=>{throw Error('validation rejected');}}),/validation rejected/);
  assert.equal(await fs.readFile(path.join(f.artifact,'broker.exe'),'utf8'),'candidate');
});
test('post-create deadline failure cleans the confirmed empty stage without calling build',async t=>{
  const f=await stageFixture(t);let builds=0;
  await assert.rejects(f.run({check(){throw Error('deadline');},build:async()=>{builds++;}}),/deadline/);
  assert.equal(builds,0);await absent(f.stage());
});
test('missing stage-creation acknowledgement preserves a possible stage',async t=>{
  const f=await stageFixture(t);let possible;
  await assert.rejects(f.run({privateDirectory:async value=>{possible=value;await fs.mkdir(value);throw Error('creation unconfirmed');}}),/creation unconfirmed/);
  assert((await fs.lstat(possible)).isDirectory());
});
test('cleanup rejects an unexpected subdirectory without deleting any stage files',async t=>{
  const f=await stageFixture(t);let failure;
  await assert.rejects(f.run({build:async stage=>{await fs.writeFile(path.join(stage,'first'),'keep');await fs.mkdir(path.join(stage,'unexpected'));throw (failure=Error('build failed'));}}),error=>error===failure&&error.stageCleanup?.code==='NATIVE_STAGE_CONTENTS');
  assert.equal(await fs.readFile(path.join(f.stage(),'first'),'utf8'),'keep');
});
test('cleanup rejects replaced stage directory identity without deleting replacement',async t=>{
  const f=await stageFixture(t);let replaced;
  await assert.rejects(f.run({build:async stage=>{replaced=stage+'-original';await fs.rename(stage,replaced);await fs.mkdir(stage);await fs.writeFile(path.join(stage,'guard'),'keep');throw Error('build failed');}}),error=>error.stageCleanup?.code==='NATIVE_STAGE_IDENTITY');
  assert.equal(await fs.readFile(path.join(f.stage(),'guard'),'utf8'),'keep');assert((await fs.lstat(replaced)).isDirectory());
});
test('cleanup rejects replaced cache identity without touching new cache contents',async t=>{
  const f=await stageFixture(t);
  await assert.rejects(f.run({build:async stage=>{await fs.rename(f.cacheRoot,f.cacheRoot+'-original');await fs.mkdir(f.cacheRoot);await fs.mkdir(stage);await fs.writeFile(path.join(stage,'guard'),'keep');throw Error('build failed');}}),error=>error.stageCleanup?.code==='NATIVE_STAGE_IDENTITY');
  assert.equal(await fs.readFile(path.join(f.stage(),'guard'),'utf8'),'keep');
});
test('stage links preserve external targets and fail closed without recursive deletion',async t=>{
  const f=await stageFixture(t),outside=path.join(f.directory,'outside');await fs.mkdir(outside);await fs.writeFile(path.join(outside,'guard'),'keep');
  await assert.rejects(f.run({build:async stage=>{await f.link(path.join(stage,'linked'),outside);throw Error('build failed');}}),error=>error.stageCleanup?.code==='NATIVE_ARTIFACT_REPARSE');
  assert.equal(await fs.readFile(path.join(outside,'guard'),'utf8'),'keep');assert((await fs.lstat(f.stage())).isDirectory());
});
test('linked cache root is rejected before creating any stage',async t=>{
  const f=await stageFixture(t),outside=path.join(f.directory,'outside');await fs.mkdir(outside);await fs.rmdir(f.cacheRoot);await f.link(f.cacheRoot,outside);
  await assert.rejects(f.run(),/REPARSE/);assert.equal(f.calls.length,0);assert.deepEqual(await fs.readdir(outside),[]);
});
test('outside, traversal and stage-shaped artifact destinations are rejected before creation',async t=>{
  const f=await stageFixture(t);
  for(const artifact of [path.join(f.directory,path.basename(f.artifact)),path.join(f.cacheRoot,'..',path.basename(f.artifact)),path.join(f.cacheRoot,'stage-'+'a'.repeat(32))])await assert.rejects(f.run({artifact}),/STAGE_PATH/);
  assert.equal(f.calls.length,0);assert.deepEqual(await fs.readdir(f.cacheRoot),[]);
});
test('overfull cache removes only the new confirmed stage',async t=>{
  const f=await stageFixture(t);for(let i=0;i<32;i++)await fs.writeFile(path.join(f.cacheRoot,'existing-'+i),'keep');
  let builds=0;await assert.rejects(f.run({build:async()=>{builds++;}}),/RESOURCE_BOUND/);
  assert.equal(builds,0);await absent(f.stage());assert.equal((await fs.readdir(f.cacheRoot)).length,32);
});
