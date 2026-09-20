// Explicit opt-in only. Importing this module does not patch the game.
const installed = new WeakMap();
export const CAPTURE_LIMITS = Object.freeze({ replayCharacters: 65536, frames: 300000 });

export function getNativeCar(require) {
  const Car = require(641)?.A;
  for (const method of ['addFinishCallback', 'getRecording', 'getTime', 'getCarStyle']) {
    if (typeof Car?.prototype?.[method] !== 'function') throw new Error(`native_missing_${method}`);
  }
  return Car;
}

export function snapshotFinish(car, context) {
  const frames = car.getTime()?.numberOfFrames;
  const recording = car.getRecording();
  if (!Number.isSafeInteger(frames) || frames <= 0 || frames > CAPTURE_LIMITS.frames) {
    throw new Error('capture_frame_limit');
  }
  if (typeof recording?.serialize !== 'function') throw new Error('capture_recording_missing');
  // Serialize synchronously, before any native finish UI, reset or asynchronous upload.
  const replay = recording.serialize();
  const carStyle = car.getCarStyle()?.serialize?.();
  if (typeof replay !== 'string' || !replay.length || replay.length > CAPTURE_LIMITS.replayCharacters) {
    throw new Error('capture_replay_limit');
  }
  if (typeof carStyle !== 'string' || carStyle.length > 256) throw new Error('capture_style_invalid');
  return Object.freeze({ ...context, frames, timeMs: frames, replay, carStyle });
}

/**
 * Install before local race construction. bindCar must return a race-start context
 * for a positively identified local player, or null for ghosts/remote cars.
 * Existing cars must be restarted; private callback arrays cannot be enumerated.
 * onFinish must synchronously take ownership of the snapshot. No internal queue.
 */
export function installFinishCapture({ Car, bindCar, onFinish, onError, validateFinish = () => {} }) {
  const prototype = Car?.prototype;
  if (!prototype || typeof prototype.addFinishCallback !== 'function') throw new Error('native_unavailable');
  if (installed.has(prototype)) throw new Error('capture_already_installed');
  if (![bindCar, onFinish, onError, validateFinish].every(fn => typeof fn === 'function')) throw new Error('capture_callbacks_required');
  const original = prototype.addFinishCallback;
  const attached = new WeakSet();
  let active = true;
  const report = error => { try { onError(error); } catch { /* Never interrupt the native game. */ } };
  function registration(callback) {
    if (active && !attached.has(this)) {
      attached.add(this);
      try {
        const binding = bindCar(this);
        if (binding !== null) {
          if (binding?.localPlayer !== true || !/^[a-f0-9]{64}$/.test(binding.trackId) ||
              typeof binding.accountId !== 'string' || !binding.accountId ||
              typeof binding.raceId !== 'string' || !binding.raceId) throw new Error('capture_binding_required');
          const context = Object.freeze({ trackId: binding.trackId, accountId: binding.accountId, raceId: binding.raceId });
          original.call(this, car => {
            if (!active) return;
            try {
              validateFinish(car, context);
              const result = onFinish(snapshotFinish(car, context));
              if (result && typeof result.then === 'function') Promise.resolve(result).catch(report);
            } catch (error) { report(error); }
          });
        }
      } catch (error) { report(error); }
    }
    return original.call(this, callback);
  }
  prototype.addFinishCallback = registration;
  const handle = Object.freeze({
    requiresRaceRestart: true,
    stop() {
      active = false;
      if (prototype.addFinishCallback === registration) prototype.addFinishCallback = original;
      // Retain the installation marker: old private callbacks cannot be removed.
      // Reload to reinstall, rather than stack callbacks with uncertain ordering.
    }
  });
  installed.set(prototype, handle);
  return handle;
}
