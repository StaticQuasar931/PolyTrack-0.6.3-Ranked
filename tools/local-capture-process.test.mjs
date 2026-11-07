import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {runBoundedCaptureProcess,terminateOwnedCaptureTree} from './local-capture-process.mjs';

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
