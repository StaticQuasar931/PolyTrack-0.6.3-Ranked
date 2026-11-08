import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createCaptureProcessSupervisor} from './local-capture-process.mjs';

const turn=()=>new Promise(resolve=>setImmediate(resolve));
function fixture({prepareHelper=async()=>({executable:'native-broker.exe'}),autoReady=true,now=Date.now}={}) {
  const session='c'.repeat(64),helper=new EventEmitter(),control=new EventEmitter(),calls=[],writes=[];
  helper.pid=98765;helper.stdout=new EventEmitter();helper.stderr=new EventEmitter();helper.stdin=null;
  for(const item of [helper,helper.stdout,helper.stderr,control]){item.ref=()=>{};item.unref=()=>{};}
  helper.kill=()=>{calls.push('kill');queueMicrotask(()=>helper.emit('close',1,null));return true;};
  control.destroy=()=>{calls.push('destroy');};
  control.end=()=>{calls.push('end');queueMicrotask(()=>{control.emit('close');helper.emit('close',0,null);});};
  const reply=text=>control.emit('data',Buffer.from(text));
  control.write=(text,callback)=>{writes.push(text);callback?.();const [kind,,id]=text.trim().split(' ');if(kind==='DISPOSE')queueMicrotask(()=>reply(`BYE ${session} ${id}\n`));return true;};
  const broker=createCaptureProcessSupervisor({session,now,prepareHelper,
    spawnHelper(file,args,options){calls.push({file,args,options});queueMicrotask(()=>helper.stdout.emit('data',Buffer.from(`PIPE_LISTENING ${session} ${process.pid} ${helper.pid}\n`)));return helper;},
    connectControl(options){calls.push(options);if(autoReady)queueMicrotask(()=>reply(`READY ${session} ${process.pid}\n`));return control;}
  });
  return {broker,helper,control,calls,writes,reply,session};
}
test('native transport has injectable preparation and duplex connection without stdin or PowerShell',async()=>{
  let preparation;const f=fixture({prepareHelper:async options=>{preparation=options;return {executable:'pinned-native.exe'};}});
  const deadline=Date.now()+20000;await f.broker.prepare({deadline});
  assert.equal(preparation.deadline,deadline);assert.equal(preparation.signal.aborted,false);
  const spawn=f.calls.find(v=>v.options);assert.equal(spawn.file,'pinned-native.exe');assert.deepEqual(spawn.args,[]);
  assert.deepEqual(spawn.options.stdio,['ignore','pipe','pipe']);assert.equal(spawn.options.shell,false);
  assert.deepEqual(Object.keys(spawn.options.env).sort(),['CAPTURE_SETUP_DEADLINE','CAPTURE_PARENT_PID','CAPTURE_RUNTIME','CAPTURE_SESSION','PATH','SystemRoot','TEMP','TMP','WINDIR'].sort());
  assert.equal(f.calls.find(v=>v.path).path,`\\\\.\\pipe\\polytrack-capture-${process.pid}-${f.session}`);
  assert.deepEqual([...f.calls.find(v=>v.path).path.slice(0,9)].map(c=>c.charCodeAt(0)),[92,92,46,92,112,105,112,101,92]);
  const first=f.broker.dispose(),second=f.broker.dispose();assert.equal(first,second);await first;
  assert.equal(f.writes.length,1);assert.match(f.writes[0],/^DISPOSE /);assert.equal(f.calls.includes('kill'),false);
});
test('rejected native build never spawns helper or connects control',async()=>{
  const f=fixture({prepareHelper:async()=>{throw Error('artifact rejected');}});
  await assert.rejects(f.broker.prepare(),/artifact rejected/);await assert.rejects(f.broker.dispose(),/artifact rejected/);assert.deepEqual(f.calls,[]);
});
test('late artifact after absolute preparation deadline never spawns',async()=>{
  let now=1000,resolveBuild,signal;const f=fixture({now:()=>now,prepareHelper:options=>{signal=options.signal;return new Promise(resolve=>{resolveBuild=resolve;});}});
  const pending=f.broker.prepare({deadline:2000}),rejected=assert.rejects(pending,/deadline/);
  now=2000;resolveBuild({executable:'late.exe'});await rejected;await assert.rejects(f.broker.dispose());assert.equal(signal.aborted,true);assert.deepEqual(f.calls,[]);
});
test('preparation timeout aborts build and rejects a later artifact without spawn',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let resolveBuild,signal;
  const f=fixture({prepareHelper:options=>{signal=options.signal;return new Promise(resolve=>{resolveBuild=resolve;});}});
  const pending=f.broker.prepare({deadline:Date.now()+1000}),rejected=assert.rejects(pending,/deadline/);
  t.mock.timers.tick(1001);await rejected;assert.equal(signal.aborted,true);
  resolveBuild({executable:'late.exe'});await turn();await assert.rejects(f.broker.dispose());assert.deepEqual(f.calls,[]);
});
test('READY after absolute native setup deadline fails even before timer callback',async()=>{
  let now=1000;const f=fixture({autoReady:false,now:()=>now});
  const pending=f.broker.prepare({deadline:2000}),rejected=assert.rejects(pending,/late/);await turn();
  now=2000;f.reply(`READY ${f.session} ${process.pid}\n`);await rejected;await assert.rejects(f.broker.dispose());assert.equal(f.calls.filter(v=>v==='kill').length,1);
});
test('build cannot return a missing executable',async()=>{
  const f=fixture({prepareHelper:async()=>({})});await assert.rejects(f.broker.prepare(),/artifact unavailable/);
  await assert.rejects(f.broker.dispose());assert.deepEqual(f.calls,[]);
});
test('control channel EOF without disposal fails closed and kills only exact helper',async()=>{
  const f=fixture();await f.broker.prepare();f.control.emit('close');
  await assert.rejects(f.broker.prepare(),/closed without confirmed/);await assert.rejects(f.broker.dispose());
  assert.equal(f.calls.filter(v=>v==='kill').length,1);
});
test('stdout cannot impersonate a typed control reply',async()=>{
  const f=fixture();await f.broker.prepare();f.helper.stdout.emit('data',Buffer.from(`READY ${f.session} ${process.pid}\n`));
  await assert.rejects(f.broker.prepare(),/listener announcement/);await assert.rejects(f.broker.dispose());
});
test('concurrent preparation uses one native build and one helper',async()=>{
  let count=0;const f=fixture({prepareHelper:async()=>{count++;return {executable:'native.exe'};}});
  await Promise.all([f.broker.prepare(),f.broker.prepare()]);assert.equal(count,1);assert.equal(f.calls.filter(v=>v.options).length,1);await f.broker.dispose();
});
