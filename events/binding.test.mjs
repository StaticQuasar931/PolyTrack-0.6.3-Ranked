import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installNativeLocalBinding, installNativeBoundCapture } from './native-binding.mjs';

const root = process.env.EVENT_TEST_REPO || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'main.bundle.js'), 'utf8');

function runtime() {
  const end = source.lastIndexOf('},n={};function i(e)');
  assert(end > 0);
  const context = vm.createContext({ console, TextEncoder, TextDecoder, Uint8Array, ArrayBuffer, DataView,
    performance, atob, btoa, setTimeout, clearTimeout });
  const factories = vm.runInContext(`(${source.slice(source.indexOf('t={') + 2, end + 1)})`, context);
  function append(id, fixture) {
    const text = factories[id].toString();
    factories[id] = vm.runInContext(`(${text.slice(0, -1)};${fixture}})`, context);
  }
  // Actual constructor and binding logic are retained. Only models, rendering
  // and audio helpers are replaced in this isolated VM, never in a repo file.
  append(641, `t.prepareFixture=function(){
    B.models={chassis:new c.YJl(),suspension:new c.YJl()};
    We=function(){}; Oe=function(){return {dispose(){}}};
    Ve=function(){return new c.YJl()}; He=function(){return new c.YJl()}; Fe=function(){};
    Xe=function(){};Ze=function(){};qe=function(){};Ge=function(){};
  };`);
  // Native Physics createCar/controlCar/deleteCar run unchanged. Worker I/O is
  // a bounded message array; fixture emit invokes the actual callback registered
  // by the actual Car constructor.
  append(5220, `t.fixture=function(){const instance=Object.create(v.prototype);
    l.add(instance);c.set(instance,{});d.set(instance,0);p.set(instance,new Map());
    const messages=[];h.set(instance,{postMessage(message){messages.push(message)}});
    return {instance,messages,emit(id,state){p.get(instance).get(id)(state)}};
  };`);
  const cache = {};
  function require(id) {
    if (cache[id]) return cache[id].exports;
    const module = cache[id] = { exports: {} };
    factories[id](module, module.exports, require); return module.exports;
  }
  require.d = (exports, names) => { for (const k in names) Object.defineProperty(exports, k, { get: names[k], enumerable: true }); };
  require.o = (object, name) => Object.hasOwn(object, name);
  require.r = exports => Object.defineProperty(exports, '__esModule', { value: true });
  require.n = exports => { const get = exports?.__esModule ? () => exports.default : () => exports; require.d(get, { a: get }); return get; };
  require.g = context; require.p = '';
  const Car = require(641).A, Track = require(9117).A, Profile = require(5492).A, Profiles = require(2522).A;
  const three = require(4922);
  require(641).prepareFixture();
  const physics = require(5220).fixture();
  const profiles = new Map([[0, new Profile('a'.repeat(64))], [1, new Profile('b'.repeat(64))]]);
  const storage = { loadUserProfileSlot: () => 0, loadUserProfile: slot => profiles.get(slot),
    saveUserProfile: (slot, value) => profiles.set(slot, value), saveUserProfileSlot() {},
    deleteAllRecordsForProfile() {}, deleteUserProfile: slot => profiles.delete(slot) };
  const manager = new Profiles(storage);
  const track = new Track(0, new three.Pq0(0, 1, 0));
  const renderer = { scene: new three.YJl(), addContextRestoredEventListener() {}, removeContextRestoredEventListener() {} };
  const mountains = { getMountainVertices: () => new Float32Array(), getMountainOffset: () => ({ x: 0, y: 0, z: 0 }) };
  const controls = { up: false, right: false, down: false, left: false, reset: false,
    addChangeCallback() {}, removeChangeCallback() {}, getControls() { return { up: this.up, right: this.right, down: this.down, left: this.left, reset: this.reset }; } };
  const transform = { position: new three.Pq0(0, 0, 0), quaternion: new three.PTz() };
  return { require, Car, Profile, Profiles, manager, storage, physics, track, controls,
    construct({ observe = true, local = true, recording = null, simulation = physics.instance, useTrack = track } = {}) {
      if (observe) manager.getCurrentUserProfile();
      return new Car(simulation, transform, recording, local ? controls : null, renderer, null, mountains, {}, useTrack, null, null);
    },
    finish(id, rawMs = 20402) {
      const initial = physics.messages.find(message => message.messageType === 3 && message.carId === id);
      assert(initial, 'native create message exists');
      const state = (frames, finishFrames, up) => ({ frames, finishFrames, speedKmh: 1, hasStarted: true,
        nextCheckpointIndex: 0, controls: { up, down: false, right: false, left: false, reset: false } });
      physics.emit(id, state(1, null, true)); physics.emit(id, state(rawMs, rawMs, false));
    }
  };
}

test('actual native constructor proves physics-state, local-control, track and account linkage', () => {
  const r = runtime(), errors = [];
  const binder = installNativeLocalBinding({ require: r.require, onError: e => errors.push(e.message), newRaceId: () => 'race1' });
  const car = r.construct();
  const binding = binder.bindCar(car);
  assert.equal(binding.localPlayer, true);
  assert.equal(binding.trackId, r.track.getId());
  assert.equal(binding.accountId, r.manager.getCurrentUserProfile().tokenHash);
  assert.equal(binding.raceId, 'race1');
  assert(Object.isFrozen(binding));
  assert.equal(binder.bindCar(car), binding);
  assert.deepEqual(errors, []);
  assert.deepEqual(Array.from(r.physics.messages, m => m.messageType), [3, 6]);
  assert.equal(r.physics.messages[0].carRecording, null);
  assert.equal(r.physics.messages[0].trackData, r.track.toSaveString());
  assert(!JSON.stringify(binding).includes('a'.repeat(64)), 'raw profile token is not emitted');
});

test('actual constructors and worker callbacks capture PB and non-PB with native ms intact', () => {
  const r = runtime(), captured = [], errors = [], order = []; let id = 0, pb = Infinity;
  installNativeBoundCapture({ require: r.require, onFinish: s => { captured.push(s); order.push('capture'); },
    onError: e => errors.push(e.message), newRaceId: () => `race_${id++}` });
  for (const [carId, time] of [10000, 20402, 15000].entries()) {
    const car = r.construct();
    car.addFinishCallback(c => { order.push('native'); pb = Math.min(pb, c.getTime().numberOfFrames); });
    r.finish(carId, time);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(captured.map(s => s.timeMs), [10000, 20402, 15000]);
  assert.deepEqual(captured.map(s => s.frames), [10000, 20402, 15000]);
  assert.equal(pb, 10000);
  assert.deepEqual(order, ['capture', 'native', 'capture', 'native', 'capture', 'native']);
  assert.equal(new Set(captured.map(s => s.raceId)).size, 3);
  const recording = r.require(1754).A.deserialize(captured[1].replay);
  assert.equal(recording.getFrame(0).up, true); assert.equal(recording.getFrame(1).up, false);
});

test('recorded simulated cars excluded; remote and uncontrolled cars cannot bind', () => {
  const r = runtime();
  const binder = installNativeLocalBinding({ require: r.require, onError() {} });
  const replay = new (r.require(1754).A)();
  const ghost = r.construct({ local: false, recording: replay });
  assert.equal(binder.bindCar(ghost), null);
  const remote = r.construct({ local: false, simulation: null });
  assert.throws(() => binder.bindCar(remote), /creation_unobserved/);
  const uncontrolled = r.construct({ local: false });
  assert.throws(() => binder.bindCar(uncontrolled), /local_control_unproven/);
});

test('profile switch including away/back invalidates the captured race but leaves native finish intact', () => {
  const r = runtime(), errors = []; let captured = 0, native = 0;
  installNativeBoundCapture({ require: r.require, onFinish: () => captured++, onError: e => errors.push(e.message) });
  const car = r.construct(); car.addFinishCallback(() => native++);
  r.manager.setProfileSlot(1); r.manager.setProfileSlot(0);
  r.finish(0);
  assert.equal(captured, 0); assert.equal(native, 1); assert(errors.includes('binding_account_changed'));
});

test('new native race uses new account and track, not stale UI selection', () => {
  const r = runtime();
  const binder = installNativeLocalBinding({ require: r.require, onError() {} });
  const oldCar = r.construct(), oldBinding = binder.bindCar(oldCar);
  r.manager.setProfileSlot(1);
  r.track.environment = 1;
  const next = r.construct(), nextBinding = binder.bindCar(next);
  assert.notEqual(nextBinding.accountId, oldBinding.accountId);
  assert.notEqual(nextBinding.trackId, oldBinding.trackId);
  assert.throws(() => binder.validateFinish(oldCar, oldBinding), /account_changed/);
});

test('mid-race track mutation invalidates capture', () => {
  const r = runtime();
  const binder = installNativeLocalBinding({ require: r.require, onError() {} });
  const car = r.construct(), binding = binder.bindCar(car);
  r.track.environment = 1;
  assert.throws(() => binder.validateFinish(car, binding), /track_changed/);
});

test('missing or stale native profile observation and late install fail closed', async () => {
  const r = runtime(), existing = r.construct();
  const binder = installNativeLocalBinding({ require: r.require, onError() {} });
  assert.throws(() => binder.bindCar(existing), /creation_unobserved/);
  const missing = r.construct({ observe: false });
  assert.throws(() => binder.bindCar(missing), /profile_context_missing/);
  r.manager.getCurrentUserProfile(); await Promise.resolve();
  const stale = r.construct({ observe: false });
  assert.throws(() => binder.bindCar(stale), /profile_context_missing/);
});

test('multiple native profile managers are rejected, not guessed', () => {
  const r = runtime();
  const binder = installNativeLocalBinding({ require: r.require, onError() {} });
  const car = r.construct();
  const other = new r.Profiles(r.storage); other.getCurrentUserProfile();
  assert.throws(() => binder.bindCar(car), /multiple_profile_managers/);
});

test('deleted car, replaced hook, and stopped binding cannot publish', () => {
  const r = runtime();
  const binder = installNativeLocalBinding({ require: r.require, onError() {} });
  const car = r.construct(), binding = binder.bindCar(car);
  r.physics.instance.deleteCar(0);
  assert.throws(() => binder.validateFinish(car, binding), /car_deleted/);
  const prototype = r.require(5220).A.prototype, prior = prototype.controlCar;
  prototype.controlCar = function() {};
  assert.throws(() => binder.validateFinish(car, binding), /hook_replaced/);
  binder.stop(); assert.notEqual(prototype.controlCar, prior, 'do not overwrite another hook');
  assert.throws(() => binder.bindCar(car), /stopped/);
});

test('pending linkage is bounded and overflow fails closed without stopping native construction', () => {
  const r = runtime(), errors = [];
  const binder = installNativeLocalBinding({ require: r.require, onError: e => errors.push(e.message) });
  for (let n = 0; n < 64; n++) r.construct();
  const car = r.construct();
  assert.throws(() => binder.bindCar(car), /pending_limit/);
  assert(errors.includes('binding_pending_limit'));
  assert.equal(r.physics.messages.filter(m => m.messageType === 3).length, 65);
});

test('native dispose releases linkage so repeated restarts do not exhaust the bound', () => {
  const r = runtime(), errors = [];
  const binder = installNativeLocalBinding({ require: r.require, onError: e => errors.push(e.message) });
  for (let n = 0; n < 80; n++) {
    const car = r.construct(), binding = binder.bindCar(car);
    car.dispose();
    assert.throws(() => binder.validateFinish(car, binding), /car_deleted/);
  }
  assert.deepEqual(errors, []);
  assert.equal(r.physics.messages.filter(m => m.messageType === 4).length, 80);
});

test('native caller audit: local profile read precedes controlled construction and finish registration', () => {
  const start = source.indexOf('Es=function(e){');
  const end = source.indexOf('s.addFinishCallback(', start);
  assert(start >= 0 && end > start);
  const local = source.slice(start, end);
  assert(local.indexOf('.getCurrentUserProfile()') < local.indexOf('new z.A('));
  assert(local.includes('new z.A((0,R.gn)(this,na,"f"),i,null,(0,R.gn)(this,qa,"f")'));
  assert(local.includes('(0,R.gn)(this,ra,"f")'));
  assert(source.includes('new z.A(null,t,e.settings.recording,null,'));
  assert(source.includes('new z.A(null,t,null,null,'));
  assert.equal(source.split('new Bu.A(').length - 1, 1, 'bootstrap constructs one native profile manager');
});
