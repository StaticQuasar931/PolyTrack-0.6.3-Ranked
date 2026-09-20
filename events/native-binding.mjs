// Opt-in native integration. Imports have no effects on native prototypes.
import { getNativeCar, installFinishCapture } from './native-finish.mjs';

const installations = new WeakSet();
const HASH = /^[a-f0-9]{64}$/;
const fail = reason => { throw new Error(reason); };

export function installNativeLocalBinding({ require, onError, newRaceId = () => crypto.randomUUID() }) {
  const Car = getNativeCar(require);
  const Physics = require(5220).A;
  const Profiles = require(2522).A;
  const Profile = require(5492).A;
  const Track = require(9117).A;
  if (typeof onError !== 'function' || typeof newRaceId !== 'function') fail('binding_callbacks_required');
  if (installations.has(Car)) fail('binding_already_installed');
  const original = {
    profile: Profiles.prototype.getCurrentUserProfile,
    slot: Object.getOwnPropertyDescriptor(Profiles.prototype, 'profileSlot')?.get,
    tokenHash: Object.getOwnPropertyDescriptor(Profile.prototype, 'tokenHash')?.get,
    track: Track.prototype.getId,
    create: Physics.prototype.createCar,
    control: Physics.prototype.controlCar,
    remove: Physics.prototype.deleteCar,
    state: Car.prototype.getCarState
  };
  if (!Object.values(original).every(fn => typeof fn === 'function')) fail('binding_native_contract_missing');
  const states = new WeakMap(), cars = new WeakMap(), pending = new WeakMap();
  const hooks = [];
  let active = true, manager = null, ambiguous = false, epoch = 0, sequence = 0, observed = null;
  const report = error => { try { onError(error); } catch {} };
  function healthy() {
    if (!active) fail('binding_stopped');
    if (ambiguous) fail('binding_multiple_profile_managers');
    for (const { prototype, name, wrapper } of hooks) {
      if (prototype[name] !== wrapper) fail('binding_hook_replaced');
    }
  }
  function identity(profile) {
    if (!(profile instanceof Profile)) fail('binding_native_profile_required');
    const accountId = original.tokenHash.call(profile);
    const profileSlot = original.slot.call(manager);
    if (!HASH.test(accountId) || !Number.isSafeInteger(profileSlot) || profileSlot < 0) fail('binding_profile_invalid');
    return Object.freeze({ accountId, profileSlot, epoch });
  }
  function currentIdentity() {
    if (!manager) fail('binding_profile_unobserved');
    return identity(original.profile.call(manager));
  }
  function sameIdentity(a, b) {
    return a.accountId === b.accountId && a.profileSlot === b.profileSlot && a.epoch === b.epoch;
  }
  function hook(prototype, name, wrapper) {
    const prior = prototype[name];
    if (typeof prior !== 'function') fail(`binding_native_missing_${name}`);
    prototype[name] = wrapper;
    hooks.push({ prototype, name, wrapper, prior });
  }
  try {
    hook(Profiles.prototype, 'getCurrentUserProfile', function(...args) {
      const profile = original.profile.apply(this, args);
      if (!active) return profile;
      try {
        if (manager && manager !== this) { ambiguous = true; fail('binding_multiple_profile_managers'); }
        manager = this;
        const serial = ++sequence;
        observed = { ...identity(profile), serial };
        // Native race factory reads the profile and creates its car in one
        // synchronous call. Never reuse an unrelated read from an earlier task.
        queueMicrotask(() => { if (observed?.serial === serial) observed = null; });
      } catch (error) { observed = null; report(error); }
      return profile;
    });
    for (const method of ['setProfileSlot', 'createProfile', 'deleteProfileSlot']) {
      const prior = Profiles.prototype[method];
      hook(Profiles.prototype, method, function(...args) {
        // Invalidate even a switch away and back to the same account.
        if (active) { epoch++; observed = null; }
        return prior.apply(this, args);
      });
    }
    hook(Physics.prototype, 'createCar', function(...args) {
      let evidence;
      try {
        healthy();
        const track = args[3], recording = args[4];
        if (recording != null) evidence = { excluded: true };
        else {
          if (!(track instanceof Track)) fail('binding_native_track_required');
          if (!observed || !sameIdentity(observed, currentIdentity())) fail('binding_profile_context_missing');
          const trackId = original.track.call(track);
          if (!HASH.test(trackId)) fail('binding_track_hash_invalid');
          evidence = { ...currentIdentity(), trackId, track, controlled: false };
        }
      } catch (error) { evidence = { error: error.message }; report(error); }
      // Preserve exact native arguments, return value, worker messages and errors.
      const result = original.create.apply(this, args);
      if (active && result?.carState && typeof result.carState === 'object') {
        let index = pending.get(this);
        if (!index) { index = new Map(); pending.set(this, index); }
        // Bound pending linkage, not the engine's own car collection.
        if (index.size >= 64) { evidence = { error: 'binding_pending_limit' }; report(new Error(evidence.error)); }
        else index.set(result.id, evidence);
        evidence.physics = this; evidence.id = result.id;
        states.set(result.carState, evidence);
      }
      return result;
    });
    hook(Physics.prototype, 'controlCar', function(...args) {
      const result = original.control.apply(this, args);
      const evidence = pending.get(this)?.get(args[0]);
      // Native Car constructor calls this only for non-null local controls and
      // a real physics car ID, before registering its finish callback.
      if (active && evidence && !evidence.excluded && !evidence.error) evidence.controlled = true;
      return result;
    });
    hook(Physics.prototype, 'deleteCar', function(...args) {
      const result = original.remove.apply(this, args);
      const evidence = pending.get(this)?.get(args[0]);
      if (evidence) evidence.deleted = true;
      pending.get(this)?.delete(args[0]);
      return result;
    });
  } catch (error) {
    for (const h of hooks.reverse()) if (h.prototype[h.name] === h.wrapper) h.prototype[h.name] = h.prior;
    throw error;
  }
  installations.add(Car);
  return Object.freeze({
    Car,
    requiresRaceRestart: true,
    bindCar(car) {
      healthy();
      if (!(car instanceof Car)) fail('binding_native_car_required');
      if (cars.has(car)) return cars.get(car).context;
      const evidence = states.get(original.state.call(car));
      if (!evidence) fail('binding_creation_unobserved_restart_required');
      if (evidence.excluded) return null;
      if (evidence.error) fail(evidence.error);
      if (evidence.deleted || !evidence.controlled) fail('binding_local_control_unproven');
      if (!sameIdentity(evidence, currentIdentity())) fail('binding_account_changed');
      if (original.track.call(evidence.track) !== evidence.trackId) fail('binding_track_changed');
      const raceId = newRaceId();
      if (typeof raceId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(raceId)) fail('binding_race_id_invalid');
      const context = Object.freeze({ localPlayer: true, accountId: evidence.accountId, trackId: evidence.trackId, raceId });
      cars.set(car, { context, evidence });
      // Native physics maintains the lifecycle; retaining this index until
      // deleteCar lets us reject disposal, while the WeakMaps avoid global scans.
      return context;
    },
    validateFinish(car, context) {
      healthy();
      const binding = cars.get(car);
      if (!binding || binding.context.raceId !== context.raceId || binding.context.accountId !== context.accountId ||
          binding.context.trackId !== context.trackId) fail('binding_finish_mismatch');
      if (binding.evidence.deleted) fail('binding_car_deleted');
      if (!sameIdentity(binding.evidence, currentIdentity())) fail('binding_account_changed');
      if (original.track.call(binding.evidence.track) !== binding.context.trackId) fail('binding_track_changed');
    },
    stop() {
      active = false; observed = null;
      for (const h of [...hooks].reverse()) if (h.prototype[h.name] === h.wrapper) h.prototype[h.name] = h.prior;
    }
  });
}

export function installNativeBoundCapture({ require, onFinish, onError, newRaceId }) {
  const binding = installNativeLocalBinding({ require, onError, newRaceId });
  try {
    const capture = installFinishCapture({ Car: binding.Car, bindCar: binding.bindCar,
      validateFinish: binding.validateFinish, onFinish, onError });
    return Object.freeze({ requiresRaceRestart: true, stop() { capture.stop(); binding.stop(); } });
  } catch (error) { binding.stop(); throw error; }
}
