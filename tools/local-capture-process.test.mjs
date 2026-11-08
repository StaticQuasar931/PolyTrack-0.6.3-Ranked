import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {runBoundedCaptureProcess,terminateOwnedCaptureTree,createCaptureProcessSupervisor} from './local-capture-process.mjs';

function fixture(patch = {}) {
  const child = new EventEmitter(), calls = [];
  Object.assign(child, {pid:12345, exitCode:null, signalCode:null, connected:true,
    send(message, callback) { calls.push(['ipc', message]); callback?.(); }});
  const exit = (status = 0, signal = null) => {
    child.exitCode = status; child.signalCode = signal;
    child.emit('exit', status, signal);
  };
  const close = (status = child.exitCode, signal = child.signalCode) => {
    calls.push('close'); child.emit('close', status, signal);
  };
  child.kill=()=>{calls.push('exact-gate-kill');exit(1);close();return true;};
  const config = {file:'owned-worker', args:['receipt', 'owner'],
    options:{stdio:['ignore', 41, 41, 'ipc']}, timeoutMs:10, graceMs:10,
    spawnImpl(file, args, options) { calls.push(['spawn', file, args, options]); return child; },
    killTree(value, {isRunning}) {
      assert.equal(value, child); assert.equal(isRunning(), true);
      calls.push('kill'); exit(null, 'SIGKILL'); close();
    },
    recoverAfterTimeout(result) { calls.push(['recover', result]); }, ...patch};
  return {child, calls, config, exit, close};
}

test('normal exit preserves log descriptors, isolates the child, and never recovers', async () => {
  const f = fixture();
  f.config.options = {...f.config.options, shell:true, windowsHide:false, detached:false,
    timeout:1, signal:new AbortController().signal};
  const pending = runBoundedCaptureProcess(f.config);
  const options = f.calls[0][3];
  assert.deepEqual(options.stdio, ['ignore', 41, 41, 'ipc']);
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
  assert.equal(options.detached, process.platform !== 'win32');
  assert.equal('timeout' in options, false); assert.equal('signal' in options, false);
  f.exit(); f.close();
  assert.deepEqual(await pending, {status:0, signal:null, timedOut:false});
  assert.equal(f.calls.length, 2);
});

test('cooperative abort gets grace, recovery waits for close, late zero is timeout failure', async () => {
  const f = fixture({graceMs:100});
  f.child.send = (message, callback) => {
    f.calls.push(['ipc', message]); callback(); f.exit(0);
    assert.equal(f.calls.some(v => Array.isArray(v) && v[0] === 'recover'), false);
    setImmediate(() => f.close());
  };
  assert.deepEqual(await runBoundedCaptureProcess(f.config), {status:0, signal:null, timedOut:true});
  assert.deepEqual(f.calls[1], ['ipc', {type:'abort', reason:'timeout'}]);
  assert.equal(f.calls.includes('kill'), false);
  assert.equal(f.calls.at(-2), 'close'); assert.equal(f.calls.at(-1)[0], 'recover');
});

test('unresponsive owned child is forced after IPC grace and recovered once after close', async () => {
  const f = fixture();
  assert.deepEqual(await runBoundedCaptureProcess(f.config), {status:null, signal:'SIGKILL', timedOut:true});
  assert.deepEqual(f.calls.slice(1).map(v => Array.isArray(v) ? v[0] : v), ['ipc', 'kill', 'close', 'recover']);
  f.child.emit('close', 0, null);
  assert.equal(f.calls.filter(v => Array.isArray(v) && v[0] === 'recover').length, 1);
});

test('exit before deadline cannot kill a stale or reused PID while close is pending', async () => {
  const f = fixture();
  const pending = runBoundedCaptureProcess(f.config);
  f.exit(7); f.child.pid = 99999;
  await new Promise(resolve => setTimeout(resolve, 30));
  f.close();
  assert.deepEqual(await pending, {status:7, signal:null, timedOut:false});
  assert.equal(f.calls.includes('kill'), false);
});

test('exit during grace cancels force even if output close arrives after grace', async () => {
  const f = fixture();
  f.child.send = () => { f.exit(0); setTimeout(() => f.close(), 30); };
  assert.equal((await runBoundedCaptureProcess(f.config)).timedOut, true);
  assert.equal(f.calls.includes('kill'), false);
});

test('close waits for forced tree termination completion before fallback encryption', async () => {
  const f = fixture();
  f.config.killTree = async () => {
    f.calls.push('kill'); f.exit(null, 'SIGKILL'); f.close();
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.calls.some(v => Array.isArray(v) && v[0] === 'recover'), false);
    f.calls.push('tree-stopped');
  };
  await runBoundedCaptureProcess(f.config);
  assert.equal(f.calls.at(-2), 'tree-stopped'); assert.equal(f.calls.at(-1)[0], 'recover');
});

test('broken IPC still forces the owned child rather than escaping the deadline', async () => {
  for (const connected of [true, false]) {
    const f = fixture(); f.child.connected = connected;
    f.child.send = () => { throw Error('IPC closed'); };
    assert.equal((await runBoundedCaptureProcess(f.config)).timedOut, true);
    assert.equal(f.calls.includes('kill'), true);
  }
});

test('spawn throws and asynchronous redirection errors reject without recovery', async () => {
  const f = fixture({spawnImpl() { throw Error('bad fd'); }});
  await assert.rejects(runBoundedCaptureProcess(f.config), /bad fd/);
  const g = fixture(), pending = runBoundedCaptureProcess(g.config);
  g.child.emit('error', Error('spawn denied')); g.close(null);
  await assert.rejects(pending, /spawn denied/);
  assert.equal(g.calls.some(v => Array.isArray(v) && v[0] === 'recover'), false);
});

test('unconfirmed tree termination rejects without attempting recovery', async () => {
  const f = fixture({killTree() { throw Error('tree still running'); }});
  await assert.rejects(runBoundedCaptureProcess(f.config), /tree still running/);
  f.exit(); f.close();
  assert.equal(f.calls.some(v => Array.isArray(v) && v[0] === 'recover'), false);
});

test('tree termination failure after child close still forbids recovery', async () => {
  const f = fixture();
  f.config.killTree = async () => {
    f.exit(null, 'SIGKILL'); f.close();
    throw Error('descendant cleanup unconfirmed');
  };
  await assert.rejects(runBoundedCaptureProcess(f.config), /descendant cleanup unconfirmed/);
  assert.equal(f.calls.some(v => Array.isArray(v) && v[0] === 'recover'), false);
});

test('recovery failure rejects and is not retried', async () => {
  let attempts = 0;
  const f = fixture({recoverAfterTimeout() { attempts++; throw Error('encryption failed'); }});
  await assert.rejects(runBoundedCaptureProcess(f.config), /encryption failed/);
  assert.equal(attempts, 1);
});

test('invalid timeout or missing IPC is rejected before spawning', async () => {
  for (const patch of [{timeoutMs:0}, {graceMs:-1}, {options:{stdio:'ignore'}},
    {options:{stdio:['ignore', 1, 2]}}, {options:{stdio:['ipc', 'ipc']}}]) {
    const f = fixture(patch);
    await assert.rejects(runBoundedCaptureProcess(f.config), TypeError);
    assert.deepEqual(f.calls, []);
  }
});

test('termination capability ignores unowned objects even when supplied a plausible PID',async()=>{
  await terminateOwnedCaptureTree({pid:process.pid},{isRunning:()=>true});
  await terminateOwnedCaptureTree({pid:1},{isRunning:()=>true});
});

test('an owned object cannot redirect termination to a replaced PID',async()=>{
  const f=fixture(),pending=runBoundedCaptureProcess(f.config);
  f.child.pid=process.pid;
  await terminateOwnedCaptureTree(f.child,{isRunning:()=>true});
  f.exit();f.close();
  assert.deepEqual(await pending,{status:0,signal:null,timedOut:false});
  assert.equal(f.calls.includes('kill'),false);
});

for(const earlyClose of [false,true])test('a stalled tree terminator is bounded and cannot recover, early close '+earlyClose,async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const f=fixture({killTree:()=>new Promise(()=>{})});
  const pending=runBoundedCaptureProcess(f.config);
  const rejected=assert.rejects(pending,/termination deadline exceeded/);
  t.mock.timers.tick(10);t.mock.timers.tick(10);
  await new Promise(resolve=>setImmediate(resolve));
  if(earlyClose){f.exit(null,'SIGKILL');f.close();}
  t.mock.timers.tick(10000);await rejected;
  if(!earlyClose){f.exit();f.close();}
  assert.equal(f.calls.some(value=>Array.isArray(value)&&value[0]==='recover'),false);
});

test('late successful tree termination after its deadline cannot revive recovery',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let stopped;
  const f=fixture({killTree:()=>new Promise(resolve=>{stopped=resolve;})});
  const pending=runBoundedCaptureProcess(f.config),rejected=assert.rejects(pending,/termination deadline exceeded/);
  t.mock.timers.tick(10);t.mock.timers.tick(10);await new Promise(resolve=>setImmediate(resolve));
  t.mock.timers.tick(10000);await rejected;
  f.exit(null,'SIGKILL');f.close();stopped();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(f.calls.some(value=>Array.isArray(value)&&value[0]==='recover'),false);
});

function brokerFixture({autoReady=true,autoOwn=true,autoStop=true,autoBye=true,now=Date.now}={}) {
  const session='a'.repeat(64),writes=[],helper=new EventEmitter(),control=new EventEmitter(),queued=[];let options,ended=false,connected=false;
  for(const key of ['stdout','stderr'])helper[key]=new EventEmitter();helper.stdin=null;
  for(const value of [helper,helper.stdout,helper.stderr,control]){value.ref=()=>{};value.unref=()=>{};}
  const respond=text=>{if(connected)control.emit('data',Buffer.from(text));else queued.push(text);};
  control.write=(text,callback)=>{
    writes.push(text);callback?.();
    const [kind,,id]=text.trim().split(' '),reply={OWN:'OWNED',STOP:'STOPPED',RELEASE:'RELEASED',DISPOSE:'BYE'}[kind];
    if(reply&&(kind!=='OWN'||autoOwn)&&(kind!=='STOP'||autoStop)&&(kind!=='DISPOSE'||autoBye))queueMicrotask(()=>respond(reply+' '+session+' '+id+'\n'));
    return true;
  };
  control.destroy=()=>{};
  control.end=()=>{if(!ended){ended=true;queueMicrotask(()=>{control.emit('close');helper.emit('close',0,null);});}};
  helper.pid=123456;helper.kill=()=>{helper.killCalls=(helper.killCalls||0)+1;queueMicrotask(()=>helper.emit('close',1,null));return true;};
  const broker=createCaptureProcessSupervisor({session,now,prepareHelper:async()=>({executable:'fixed-native.exe'}),
    spawnHelper:(file,args,value)=>{options={file,args,...value};queueMicrotask(()=>helper.stdout.emit('data',Buffer.from('PIPE_LISTENING '+session+' '+process.pid+' '+helper.pid+'\n')));return helper;},
    connectControl:()=>{queueMicrotask(()=>{connected=true;for(const text of queued)respond(text);queued.length=0;if(autoReady)respond('READY '+session+' '+process.pid+'\n');});return control;}
  });
  return {broker,helper,control,writes,respond,session,options:()=>options};
}
const turn=()=>new Promise(resolve=>setImmediate(resolve));

test('helper READY accepts split frames, is credential-free, and disposal confirms close',async()=>{
  const f=brokerFixture({autoReady:false}),pending=f.broker.prepare();
  for(const char of `READY ${f.session} ${process.pid}\r\n`)f.respond(char);
  await pending;
  const options=f.options();assert.equal(options.shell,false);assert.equal(options.windowsHide,true);
  assert.equal(options.env.CAPTURE_PARENT_PID,String(process.pid));
  assert.deepEqual(Object.keys(options.env).sort(),['CAPTURE_SETUP_DEADLINE','CAPTURE_PARENT_PID','CAPTURE_RUNTIME','CAPTURE_SESSION','PATH','SystemRoot','TEMP','TMP','WINDIR'].sort());
  await f.broker.dispose();assert.match(f.writes.at(-1),/^DISPOSE /);
  await assert.rejects(f.broker.prepare(),/disposed/);
});

for(const malformed of ['READY wrong 1\n','READY '+ 'a'.repeat(64)+' 0\n','garbage\n','x'.repeat(4097)])
test('invalid helper readiness never admits a job: '+malformed.slice(0,20),async()=>{
  const f=brokerFixture({autoReady:false}),pending=f.broker.prepare();const rejected=assert.rejects(pending,/Malformed|bound/);
  f.respond(malformed);await rejected;await assert.rejects(f.broker.acquire({deadline:Date.now()+1000}));
  assert.equal(f.writes.some(line=>line.startsWith('OWN ')),false);await assert.rejects(f.broker.dispose());
});

test('duplicate readiness, unknown IDs and stale session responses fail closed',async()=>{
  for(const response of [`READY ${'a'.repeat(64)} ${process.pid}\n`,`STOPPED ${'a'.repeat(64)} 99\n`,`OWNED ${'b'.repeat(64)} 1\n`]){
    const f=brokerFixture();await f.broker.prepare();f.respond(response);
    await assert.rejects(f.broker.acquire({deadline:Date.now()+1000}));await assert.rejects(f.broker.dispose());
  }
});

test('missing READY consumes the caller deadline and spawns no target',async()=>{
  const f=brokerFixture({autoReady:false});let spawned=false;
  await assert.rejects(runBoundedCaptureProcess({file:process.execPath,timeoutMs:20,supervisor:f.broker,
    spawnImpl:()=>{spawned=true;throw Error('must not spawn');}}),/preparation|deadline/);
  assert.equal(spawned,false);f.helper.emit('close',0,null);await assert.rejects(f.broker.dispose());
});

test('warmup cannot restart an expired absolute work deadline',async t=>{
  let clock=1000,spawned=false,released=false;t.mock.method(Date,'now',()=>clock);
  const supervisor={acquire:async({deadline})=>{assert.equal(deadline,1100);clock=1100;return {release:async()=>{released=true;}};}};
  await assert.rejects(runBoundedCaptureProcess({file:process.execPath,timeoutMs:100,supervisor,
    spawnImpl:()=>{spawned=true;}}),/original work deadline/);
  assert.equal(spawned,false);assert.equal(released,true);
});

test('workload admission waits for exact registration acknowledgement',async()=>{
  const b=brokerFixture({autoOwn:false}),f=fixture({file:process.execPath,timeoutMs:1000,supervisor:b.broker});
  const pending=runBoundedCaptureProcess(f.config);await turn();
  assert.equal(f.calls.some(value=>Array.isArray(value)&&value[0]==='ipc'),false);
  const own=b.writes.find(value=>value.startsWith('OWN '));assert(own);
  b.respond(`OWNED ${b.session} ${own.split(' ')[2]}\n`);await turn();
  assert.equal(f.calls.find(value=>Array.isArray(value)&&value[0]==='ipc')[1].type,'capture-supervisor-start');
  f.exit();f.close();assert.equal((await pending).status,0);await b.broker.dispose();
});

test('helper failure before registration prevents workload and recovery',async()=>{
  const b=brokerFixture({autoOwn:false}),f=fixture({file:process.execPath,timeoutMs:1000,supervisor:b.broker});
  const pending=runBoundedCaptureProcess(f.config),rejected=assert.rejects(pending,/Helper closed/);await turn();
  b.helper.emit('close',1,null);await rejected;f.exit(1);f.close();await turn();
  assert.equal(f.calls.some(value=>Array.isArray(value)&&value[0]==='ipc'&&value[1].type==='capture-supervisor-start'),false);
  assert.equal(f.calls.some(value=>Array.isArray(value)&&value[0]==='recover'),false);await assert.rejects(b.broker.dispose());
});

test('eight reservations are bounded before target spawn and cannot be disposed while active',async()=>{
  const f=brokerFixture(),leases=[];await f.broker.prepare();
  for(let i=0;i<8;i++)leases.push(await f.broker.acquire({deadline:Date.now()+1000}));
  await assert.rejects(f.broker.acquire({deadline:Date.now()+1000}),/concurrency/);
  await assert.rejects(f.broker.dispose(),/owned jobs/);
  await Promise.all(leases.map(lease=>lease.release()));await f.broker.dispose();
});

test('unowned objects cannot become broker termination requests',async()=>{
  const f=brokerFixture(),lease=await f.broker.acquire({deadline:Date.now()+1000});
  assert.throws(()=>lease.register({pid:process.pid}),/Invalid owned registration/);
  assert.equal(f.writes.some(value=>value.startsWith('OWN ')),false);await lease.release();await f.broker.dispose();
});

test('late STOPPED never authorizes timeout recovery',async()=>{
  let clock=1000;const b=brokerFixture({autoStop:false,now:()=>clock});
  const f=fixture({file:process.execPath,timeoutMs:10,graceMs:0,supervisor:b.broker,killTree:terminateOwnedCaptureTree});
  const pending=runBoundedCaptureProcess(f.config),rejected=assert.rejects(pending,/stale|unconfirmed|Unconfirmed/);
  for(let i=0;i<20&&!b.writes.some(value=>value.startsWith('STOP '));i++)await new Promise(resolve=>setTimeout(resolve,5));
  const stop=b.writes.find(value=>value.startsWith('STOP '));assert(stop);clock+=10001;
  b.respond(`STOPPED ${b.session} ${stop.split(' ')[2]}\n`);f.exit(1);f.close();await rejected;await turn();
  assert.equal(f.calls.some(value=>Array.isArray(value)&&value[0]==='recover'),false);await assert.rejects(b.broker.dispose());
});

test('stalled startup kills the exact helper when EOF does not close it',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=brokerFixture({autoReady:false});f.control.end=()=>{};
  const pending=f.broker.prepare({deadline:Date.now()+100}),rejected=assert.rejects(pending,/preparation/);
  await turn();t.mock.timers.tick(101);await rejected;assert.equal(f.helper.killCalls,1);await assert.rejects(f.broker.dispose());
  assert.equal(f.writes.some(value=>value.startsWith('OWN ')),false);
});

test('missing BYE still terminates and observes helper close without claiming success',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=brokerFixture({autoBye:false});f.control.end=()=>{};
  await f.broker.prepare();const pending=f.broker.dispose(),rejected=assert.rejects(pending,/deadline/);
  t.mock.timers.tick(5001);await rejected;assert.equal(f.helper.killCalls,1);
  await assert.rejects(f.broker.dispose(),/deadline/);
});

test('assignment rejection kills the still-inert exact gate without starting workload',async()=>{
  const b=brokerFixture({autoOwn:false}),f=fixture({file:process.execPath,timeoutMs:1000,supervisor:b.broker});
  const pending=runBoundedCaptureProcess(f.config),rejected=assert.rejects(pending,error=>{
    assert.match(error.message,/operation unconfirmed/);assert.deepEqual(error.termination,{step:4,code:5});return true;
  });await turn();
  const own=b.writes.find(value=>value.startsWith('OWN '));b.respond(`FAILED ${b.session} ${own.split(' ')[2]} 4 5\n`);await rejected;
  assert(f.calls.includes('exact-gate-kill'));
  assert.equal(f.calls.some(value=>Array.isArray(value)&&value[0]==='ipc'&&value[1].type==='capture-supervisor-start'),false);
  assert.equal(b.helper.killCalls,undefined);await b.broker.dispose();
});

test('gate preloads are withheld until registered workload admission',async()=>{
  const b=brokerFixture(),f=fixture({file:process.execPath,timeoutMs:1000,supervisor:b.broker,
    options:{env:{NODE_OPTIONS:'--require=fixture-preload',NODE_PATH:'fixture-modules',KEEP:'yes'}}});
  const pending=runBoundedCaptureProcess(f.config);await turn();
  const options=f.calls.find(value=>Array.isArray(value)&&value[0]==='spawn')[3];
  assert.equal(options.env.NODE_OPTIONS,undefined);assert.equal(options.env.NODE_PATH,undefined);assert.equal(options.env.KEEP,'yes');
  const message=f.calls.find(value=>Array.isArray(value)&&value[0]==='ipc')[1];
  assert.equal(message.nodeOptions,'--require=fixture-preload');assert.equal(message.nodePath,'fixture-modules');
  f.exit();f.close();await pending;await b.broker.dispose();
});

test('STOP close and RELEASE consume one shared fifteen-second cleanup deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});let clock=1000,stop,releaseDeadline;
  t.mock.method(Date,'now',()=>clock);
  const lease={job:1,released:false,register:async()=>1,stop:async()=>{},release:({deadline})=>{lease.released=true;releaseDeadline=deadline;return new Promise(()=>{});}};
  const f=fixture({file:process.execPath,timeoutMs:100,graceMs:0,supervisor:{acquire:async()=>lease},killTree:()=>new Promise(resolve=>{stop=resolve;})});
  const pending=runBoundedCaptureProcess(f.config),rejected=assert.rejects(pending,/release|deadline/);await turn();
  clock=1100;t.mock.timers.tick(100);t.mock.timers.tick(0);await turn();assert(stop);
  clock=11090;t.mock.timers.tick(9990);stop();await turn();
  clock=16080;t.mock.timers.tick(4990);f.exit(1);f.close();await turn();assert.equal(releaseDeadline,16100);
  clock=16100;t.mock.timers.tick(20);await rejected;
  assert.equal(f.calls.some(value=>Array.isArray(value)&&value[0]==='recover'),false);
});

test('BYE without helper close forces exact termination and remains a persistent failure',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=brokerFixture();f.control.end=()=>{};
  await f.broker.prepare();const pending=f.broker.dispose(),rejected=assert.rejects(pending,/close unconfirmed/);await turn();
  t.mock.timers.tick(5001);await rejected;assert.equal(f.helper.killCalls,1);
  await assert.rejects(f.broker.dispose(),/close unconfirmed/);
});

test('concurrent disposal shares one acknowledgement and close promise including beforeExit',async()=>{
  const f=brokerFixture({autoBye:false});let ended=false,settled=false;
  f.control.end=()=>{ended=true;};await f.broker.prepare();
  const first=f.broker.dispose(),second=f.broker.dispose({caller:'beforeExit'});
  assert.equal(first,second);second.then(()=>{settled=true;});await turn();assert.equal(settled,false);
  const commands=f.writes.filter(value=>value.startsWith('DISPOSE '));assert.equal(commands.length,1);
  f.respond(`BYE ${f.session} ${commands[0].split(' ')[2].trim()}\n`);await turn();
  assert.equal(ended,true);assert.equal(settled,false);
  f.helper.emit('close',0,null);await first;assert.equal(settled,true);assert.equal(f.broker.dispose(),first);
});

test('concurrent disposal timeout stays sticky and exposes only bounded transport metadata',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});const f=brokerFixture({autoBye:false});f.control.end=()=>{};
  await f.broker.prepare();const first=f.broker.dispose(),second=f.broker.dispose({caller:'beforeExit'});
  assert.equal(first,second);const rejected=assert.rejects(first,error=>{
    assert.match(error.message,/deadline/);assert.deepEqual(error.supervisor,{
      command:'DISPOSE',id:1,expected:'BYE',elapsedMs:error.supervisor.elapsedMs,state:'closing',leaseCount:0,pendingCount:1,
      releasePhase:null,writeCallback:'ok',helperExitCode:null,helperSignal:null,helperClosed:false,lastReply:null,disposeCaller:'explicit'});
    assert.equal(JSON.stringify(error.supervisor).includes(f.session),false);return true;
  });
  t.mock.timers.tick(5001);await rejected;assert.equal(f.broker.dispose(),first);await assert.rejects(second,/deadline/);
  assert.equal(f.helper.killCalls,1);assert.equal(f.writes.filter(value=>value.startsWith('DISPOSE ')).length,1);
});

test('Windows mixed-case and inherited preload aliases never reach the inert gate',{skip:process.platform!=='win32'},async()=>{
  const cases=[
    {env:{node_options:'lower',Node_Options:'title',NODE_OPTIONS:'upper',Node_Path:'path-title',node_path:'path-lower'},options:'upper',path:'path-title'},
    {env:{NODE_PATH:undefined,Node_Path:'must-not-win',Node_Options:'title',node_options:'lower'},options:'title',path:undefined},
    {env:Object.assign(Object.create({Node_Options:'inherited-title'}),{node_options:'own-lower',KEEP:'yes'}),options:'inherited-title',path:undefined}
  ];
  for(const item of cases){
    const b=brokerFixture(),f=fixture({file:process.execPath,timeoutMs:1000,supervisor:b.broker,options:{env:item.env}});
    const pending=runBoundedCaptureProcess(f.config);await turn();
    const environment=f.calls.find(value=>Array.isArray(value)&&value[0]==='spawn')[3].env;
    assert.equal(Object.keys(environment).some(key=>['NODE_OPTIONS','NODE_PATH'].includes(key.toUpperCase())),false);
    const admitted=f.calls.find(value=>Array.isArray(value)&&value[0]==='ipc')[1];
    assert.equal(admitted.nodeOptions,item.options);assert.equal(admitted.nodePath,item.path);
    f.exit();f.close();await pending;await b.broker.dispose();
  }
});
