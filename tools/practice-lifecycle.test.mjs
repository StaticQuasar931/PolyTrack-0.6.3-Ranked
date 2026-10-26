import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const repo = process.env.PRACTICE_LIFECYCLE_REPO;
const historyUrl = repo ? pathToFileURL(repo + '/tools/practice-history.mjs') : new URL('./practice-history.mjs', import.meta.url);
const nativeUrl = process.env.PRACTICE_LIFECYCLE_NATIVE
  ? pathToFileURL(process.env.PRACTICE_LIFECYCLE_NATIVE) : new URL('./practice-native.mjs', import.meta.url);
const { createPracticeHistory } = await import(historyUrl);
const { installPracticeObserver } = await import(nativeUrl);
const account = 'a'.repeat(64), other = 'c'.repeat(64), track = 'b'.repeat(64);

function fixture() {
  let at = Date.UTC(2026, 9, 25), owner = account, saved = null, timer, cancels = 0, deny = false;
  const events = new EventTarget();
  const storage = { getItem: () => saved, setItem(_key, value) { if (deny) throw Error('denied'); saved = value; } };
  const history = createPracticeHistory({ storage, now: () => at });
  class Physics { createCar() { return { carState: { frames: 0 } }; } }
  class Car {
    constructor(state) { this.state = state; this.resets = []; this.finishes = []; this.done = false; }
    getCarState() { return this.state; }
    getTime() { return { numberOfFrames: this.state.frames }; }
    getFinishTime() { return { numberOfFrames: this.state.frames }; }
    hasStarted() { return true; }
    hasFinished() { return this.done; }
    get isPaused() { return false; }
    getNextCheckpointIndex() { return 2; }
    addResetCallback(fn) { this.resets.push(fn); }
    addFinishCallback(fn) { this.finishes.push(fn); }
    dispose() { return 'native-disposed'; }
  }
  const originals = { create: Physics.prototype.createCar, reset: Car.prototype.addResetCallback, finish: Car.prototype.addFinishCallback, dispose: Car.prototype.dispose };
  const physics = new Physics();
  const options = { require: id => ({ A: id === 5220 ? Physics : Car }), history, accountId: () => owner,
    clock: () => at, visible: () => true, schedule: fn => { timer = fn; return 1; }, cancel: () => { cancels++; }, eventTarget: events, windowTarget: events };
  const install = () => installPracticeObserver(options);
  const observer = install();
  const advance = (car, ms) => { at += ms; car.state.frames += ms; };
  return { history, observer, install, originals, Physics, Car, events, storage,
    car() { const car = new Car(physics.createCar(null, null, null, { getId: () => track }).carState); car.addResetCallback(() => {}); return car; },
    advance, step(car, ms = 1000) { advance(car, ms); timer(); }, switchAccount() { owner = other; },
    deny(value) { deny = value; }, cancels: () => cancels,
    persisted(id = account) { return createPracticeHistory({ storage, now: () => at }).get(id, track); } };
}

test('stop samples an authoritative finish before disabling callbacks and persists it once', () => {
  const f = fixture(), car = f.car();
  f.advance(car, 750); car.done = true;
  f.observer.stop();
  const row = f.persisted();
  assert.equal(row.activeMs, 750);
  assert.equal(row.finishes, 1);
  assert.equal(row.trackedBestMs, 750);
  assert.equal(row.recentFinishes.length, 1);
  for (const callback of car.finishes) callback();
  assert.equal(f.history.get(account, track).finishes, 1);
});

test('stale repeated stop cannot remove a newer installation or cancel twice', () => {
  const f = fixture(); f.observer.stop();
  const newer = f.install();
  try {
    f.observer.stop();
    assert.equal(f.install(), newer, 'new observer must remain deduplicated');
    assert.equal(f.cancels(), 1);
    assert.equal(f.Car.prototype.addFinishCallback, f.originals.finish);
    assert.equal(f.Car.prototype.dispose, f.originals.dispose);
  } finally { newer.stop(); }
});

test('pagehide samples and persists a dirty sub-30-second unfinished drive', () => {
  const f = fixture(); try {
    const car = f.car(); f.step(car); f.step(car);
    assert.equal(f.history.get(account, track).activeMs, 2000);
    assert.ok(f.persisted().activeMs < 2000, 'throttled storage can lag live memory');
    f.advance(car, 250); f.events.dispatchEvent(new Event('pagehide'));
    assert.equal(f.persisted().activeMs, 2250);
    assert.equal(f.persisted().lastPlayedAt, Date.UTC(2026, 9, 25) + 2250);
  } finally { f.observer.stop(); }
});

test('disposal before the first timer tick persists via the microtask or immediate pagehide', async () => {
  for (const pagehide of [false, true]) {
    const f = fixture(); try {
      const car = f.car(); f.advance(car, 250); assert.equal(car.dispose(), 'native-disposed');
      if (pagehide) f.events.dispatchEvent(new Event('pagehide'));
      await Promise.resolve();
      assert.equal(f.persisted().activeMs, 250);
      assert.equal(f.persisted().attempts, 1);
      assert.equal(f.persisted().finishes, 0);
    } finally { f.observer.stop(); }
  }
});

test('account switch flushes the old owner and does not transfer the old car', () => {
  const f = fixture(); try {
    const old = f.car(); f.step(old); f.switchAccount(); f.step(old);
    assert.equal(f.persisted().activeMs, 1000);
    assert.equal(f.history.get(other, track), null);
    const next = f.car(); f.step(next);
    f.events.dispatchEvent(new Event('pagehide'));
    assert.equal(f.persisted(other).activeMs, 1000);
    assert.equal(f.persisted().activeMs, 1000);
  } finally { f.observer.stop(); }
});

test('failed forced persistence keeps data dirty for a later boundary retry', () => {
  const f = fixture(); try {
    const car = f.car(); f.step(car); f.deny(true); f.advance(car, 200);
    f.events.dispatchEvent(new Event('pagehide'));
    assert.equal(f.history.get(account, track).activeMs, 1200);
    f.deny(false); f.events.dispatchEvent(new Event('pagehide'));
    assert.equal(f.persisted().activeMs, 1200);
  } finally { f.observer.stop(); }
});
