import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getNativeCar, installFinishCapture, snapshotFinish } from './native-finish.mjs';

const root = process.env.EVENT_TEST_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'main.bundle.js'), 'utf8');

function nativeRuntime() {
  // Test-only module loading. Never execute the game's DOM bootstrap or write
  // the bundle. The isolated fixture skips rendering, not finish/recording logic.
  const end = source.lastIndexOf('},n={};function i(e)');
  assert(end > 0, 'pinned webpack factory boundary');
  const context = vm.createContext({ console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView,
    performance, atob, btoa, setTimeout, clearTimeout });
  const factories = vm.runInContext(`(${source.slice(source.indexOf('t={') + 2, end + 1)})`, context);
  let carFactory = factories[641].toString();
  // Give the fixture access to real private maps initialized as constructor
  // would. These names are asserted by test execution against this exact build.
  carFactory = carFactory.slice(0, -1) + `;
    t.fixture = function() {
      const car = Object.create(ot.prototype);
      D.add(car); Be.set(car,false); ze.set(car,0); ie.set(car,true);
      te.set(car,{frames:0,hasStarted:false,finishFrames:null,nextCheckpointIndex:0,controls:{reset:false}});
      re.set(car,new st.A()); Me.set(car,w.A.default());
      ce.set(car,[]);he.set(car,[]);de.set(car,[]);Y.set(car,null);
      car.notificationAudioEnabled=false;
      Xe=function(){};Ze=function(){};qe=function(){};
      return car;
    };
  }`;
  factories[641] = vm.runInContext(`(${carFactory})`, context);
  const cache = {};
  function require(id) {
    if (cache[id]) return cache[id].exports;
    const module = cache[id] = { exports: {} };
    factories[id](module, module.exports, require);
    return module.exports;
  }
  require.d = (exports, names) => { for (const k in names) Object.defineProperty(exports, k, { get: names[k], enumerable: true }); };
  require.o = (object, name) => Object.hasOwn(object, name);
  require.r = exports => Object.defineProperty(exports, '__esModule', { value: true });
  require.n = exports => { const get = exports?.__esModule ? () => exports.default : () => exports; require.d(get, { a: get }); return get; };
  require.g = context; require.p = '';
  return { require, car: () => require(641).fixture() };
}

const binding = { localPlayer: true, accountId: 'b'.repeat(64), trackId: 'a'.repeat(64), raceId: 'race1' };
function frame(car, frames, finishFrames, up = true) {
  car.setCarState({ frames, finishFrames, hasStarted: true, nextCheckpointIndex: 0,
    controls: { up, right: false, down: false, left: false, reset: false } }, false);
}

test('actual native modules expose required methods and base64url serialization', () => {
  const runtime = nativeRuntime();
  const Car = getNativeCar(runtime.require);
  assert.equal(typeof Car.prototype.setCarState, 'function');
  const recording = new (runtime.require(1754).A)();
  recording.recordFrame(0, { up: true, right: false, down: false, left: false, reset: false });
  assert.match(recording.serialize(), /^[A-Za-z0-9_-]+$/);
  assert.equal(new (runtime.require(6146).A)(1234).numberOfFrames, 1234);
  assert.equal(typeof runtime.require(8724).A.default().serialize(), 'string');
});

test('native finish transition captures every run including non-all-time PB, with last input', () => {
  const runtime = nativeRuntime(), captures = [], errors = [], order = [];
  const Car = getNativeCar(runtime.require);
  installFinishCapture({ Car, bindCar: () => binding,
    onFinish: snapshot => { order.push('capture'); captures.push(snapshot); }, onError: e => errors.push(e) });
  let allTimeBest = 100;
  for (const finish of [50, 200, 150]) {
    const car = runtime.car();
    car.addFinishCallback(car => { order.push('native'); if (car.getTime().numberOfFrames < allTimeBest) allTimeBest = car.getTime().numberOfFrames; });
    car.addFinishCallback(() => {});
    frame(car, 1, null, true);
    frame(car, finish, finish, false);
    frame(car, finish + 1, finish, false);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(captures.map(s => s.frames), [50, 200, 150]);
  assert.deepEqual(order, ['capture', 'native', 'capture', 'native', 'capture', 'native']);
  assert.equal(allTimeBest, 50);
  const recording = runtime.require(1754).A.deserialize(captures[1].replay);
  assert.equal(recording.getFrame(0).up, true);
  assert.equal(recording.getFrame(1).up, false, 'final transition recorded before callback');
  assert(Object.isFrozen(captures[0]));
});

test('race context is snapshotted before mutable parent selection changes', () => {
  const runtime = nativeRuntime(), captures = [], current = { ...binding };
  installFinishCapture({ Car: getNativeCar(runtime.require), bindCar: () => current,
    onFinish: s => captures.push(s), onError: assert.fail });
  const car = runtime.car(); car.addFinishCallback(() => {});
  current.trackId = 'c'.repeat(64); current.accountId = 'changed';
  frame(car, 1, null); frame(car, 100, 100);
  assert.equal(captures[0].trackId, binding.trackId);
  assert.equal(captures[0].accountId, binding.accountId);
});

test('remote/ghost cars excluded, missing local binding reported, never silent native failure', () => {
  for (const local of [null, {}, { ...binding, trackId: '' }]) {
    const runtime = nativeRuntime(), errors = []; let native = 0, captured = 0;
    installFinishCapture({ Car: getNativeCar(runtime.require), bindCar: () => local,
      onFinish: () => captured++, onError: e => errors.push(e) });
    const car = runtime.car(); car.addFinishCallback(() => native++);
    frame(car, 1, null); frame(car, 100, 100);
    assert.equal(native, 1); assert.equal(captured, 0);
    assert.equal(errors.length, local === null ? 0 : 1);
  }
});

test('capture failure and oversize are visible, do not break native callbacks', async () => {
  const runtime = nativeRuntime(), errors = []; let native = 0;
  installFinishCapture({ Car: getNativeCar(runtime.require), bindCar: () => binding,
    onFinish: () => Promise.reject(Error('offline')), onError: e => errors.push(e.message) });
  const car = runtime.car(); car.addFinishCallback(() => native++);
  frame(car, 1, null); frame(car, 100, 100);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, ['offline']); assert.equal(native, 1);
  assert.throws(() => snapshotFinish({ getTime: () => ({ numberOfFrames: 300001 }), getRecording: () => null }, binding), /frame_limit/);
  assert.throws(() => snapshotFinish({ getTime: () => ({ numberOfFrames: 1 }),
    getRecording: () => ({ serialize: () => 'x'.repeat(65537) }), getCarStyle: () => ({ serialize: () => '' }) }, binding), /replay_limit/);
});

test('late installation requires race restart; stop preserves native behavior', () => {
  const runtime = nativeRuntime(), Car = getNativeCar(runtime.require);
  const oldCar = runtime.car(); let captures = 0, native = 0;
  oldCar.addFinishCallback(() => native++);
  const original = Car.prototype.addFinishCallback;
  const handle = installFinishCapture({ Car, bindCar: () => binding,
    onFinish: () => captures++, onError: assert.fail });
  assert.equal(handle.requiresRaceRestart, true);
  frame(oldCar, 1, null); frame(oldCar, 100, 100);
  assert.equal(captures, 0);
  const newCar = runtime.car(); newCar.addFinishCallback(() => native++);
  handle.stop(); assert.equal(Car.prototype.addFinishCallback, original);
  frame(newCar, 1, null); frame(newCar, 100, 100);
  assert.equal(native, 2); assert.equal(captures, 0);
  assert.throws(() => installFinishCapture({ Car, bindCar: () => binding, onFinish() {}, onError() {} }), /already_installed/);
});
