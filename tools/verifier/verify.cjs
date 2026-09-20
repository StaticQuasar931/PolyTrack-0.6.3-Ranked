'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { LIMITS, sha256, checkJob } = require('./replay.cjs');
const { snapshot, serve } = require('./assets.cjs');
const { geometryDecision } = require('./geometry.cjs');
const { normalizeTrustedTracks } = require('./kodub-track.cjs');

const VERIFIER_VERSION = 'polytrack-native-bounded-v1';
const trace = message => { if (process.env.VERIFIER_DEBUG === '1') process.stderr.write(`[verifier] ${message}\n`); };
const verifierFingerprint = sha256(['verify.cjs', 'assets.cjs', 'replay.cjs', 'geometry.cjs', 'kodub-track.cjs', 'track-geometry.json'].map(name => name + '\n' + fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/\r\n?/g, '\n')).join('\n'));

function duration(name, maximum) {
  const raw = process.env[name];
  if (raw === undefined) return maximum;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw Error('invalid_deadline_configuration');
  return value;
}

function publicJob(job) {
  // Copy only bounded scalar inputs, never spread queue documents or service credentials.
  return {
    resultId: typeof job?.resultId === 'string' && job.resultId.length <= 512 ? job.resultId : null,
    trackId: typeof job?.trackId === 'string' && job.trackId.length <= 64 ? job.trackId : null,
    timeMs: Number.isSafeInteger(job?.timeMs) ? job.timeMs : null,
    replayHash: typeof job?.replayHash === 'string' && job.replayHash.length <= 64 ? job.replayHash : null,
  };
}

function verdict(job, status, reason, engine, track, extra = {}) {
  const input = publicJob(job);
  const actualReplayHash = typeof job?.replay === 'string' && job.replay.length <= LIMITS.replayCharacters ? sha256(job.replay) : null;
  const binding = {
    verifierVersion: VERIFIER_VERSION, verifierFingerprint,
    ...input, actualReplayHash,
    nativeTrackId: track?.id ?? null,
    trackContentHash: track?.hash ?? null,
    engineDigest: engine?.engineFingerprint ?? null,
  };
  const fingerprint = actualReplayHash === null ? null : sha256(JSON.stringify(binding));
  return {
    ...input, status, reason,
    trackGeometry: track?.geometry ?? null, geometryPolicy: track?.geometryPolicy ?? null,
    engineDigest: binding.engineDigest,
    trackContentHash: binding.trackContentHash,
    engineFingerprint: binding.engineDigest,
    boundinputfingerprint: fingerprint,
    boundInputFingerprint: fingerprint,
    binding, ...extra,
  };
}

function browserEnvironment() {
  const result = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'DISPLAY', 'XDG_RUNTIME_DIR', 'LD_LIBRARY_PATH', 'LANG']) {
    if (process.env[key] !== undefined) result[key] = process.env[key];
  }
  return result;
}

function hasExited(child) {
  return child.exitCode != null || child.signalCode != null;
}

function waitForExit(child, timeoutMs) {
  if (hasExited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); child.removeListener('exit', done); resolve(true); };
    const timer = setTimeout(() => { child.removeListener('exit', done); resolve(hasExited(child)); }, timeoutMs);
    child.once('exit', done);
    if (hasExited(child)) done();
  });
}

async function terminate(session, { graceful = false } = {}) {
  const child = session.server.process();
  // A previously rejected attempt must not mask an exit observed afterward.
  if (hasExited(child)) return;
  if (session.killPromise) return session.killPromise;
  session.dead = true;
  session.killPromise = (async () => {
    const diagnostics = session.cleanup = { method: graceful ? 'graceful' : 'forced', pid: child.pid };
    if (graceful) {
      // Normal successful batches do not need taskkill's racy descendant enumeration.
      Promise.resolve().then(() => session.server.close()).catch(() => {});
      if (await waitForExit(child, 1500)) return;
      diagnostics.method = 'graceful_then_forced';
    }
    if (process.platform === 'win32') {
      const command = path.join(process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows', 'System32', 'taskkill.exe');
      await new Promise(resolve => execFile(command, ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 5000 }, (error, stdout, stderr) => {
          diagnostics.commandCode = error?.code ?? 0;
          diagnostics.commandTimedOut = Boolean(error?.killed);
          diagnostics.commandSignal = error?.signal ?? null;
          if (error) diagnostics.commandError = String(stderr || stdout || error.message).slice(0, 600);
          // A command error may only mean a child disappeared during /T enumeration.
          // Wait for the owned process's exit instead of rejecting in this callback.
          resolve();
        }));
    } else {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { diagnostics.commandCode = error.code; }
    }
    if (await waitForExit(child, 1500)) return;
    diagnostics.exitObserved = false;
    throw Object.assign(Error('process_cleanup_failed'), { reason: 'process_cleanup_failed' });
  })();
  return session.killPromise;
}

// This timer runs in Node, outside both browser JS and the synchronous WASM worker.
// A deadline terminates Chromium's process tree, not just a page promise.
async function bounded(operation, session, wallMs, cpuMs) {
  let rejectLimit;
  let stopping = false;
  let polling = false;
  let wallTimer;
  let cpuTimer;
  let peakCpuMs = 0;
  const baseline = new Map();
  const peaks = new Map();
  const abort = reason => {
    if (stopping) return;
    stopping = true;
    session.dead = true;
    terminate(session).catch(() => {});
    rejectLimit(Object.assign(Error(reason), { reason }));
  };
  const limit = new Promise((_, reject) => { rejectLimit = reject; });
  try {
    wallTimer = setTimeout(() => abort('wall_deadline'), wallMs);
    const measured = (async () => {
      const start = await session.system.send('SystemInfo.getProcessInfo');
      for (const p of start.processInfo) baseline.set(p.id, p.cpuTime);
      cpuTimer = setInterval(async () => {
        if (polling || stopping) return;
        polling = true;
        try {
          const sample = await session.system.send('SystemInfo.getProcessInfo');
          for (const p of sample.processInfo) peaks.set(p.id, Math.max(peaks.get(p.id) || 0, p.cpuTime - (baseline.get(p.id) || 0)));
          peakCpuMs = [...peaks.values()].reduce((sum, seconds) => sum + seconds * 1000, 0);
          if (peakCpuMs > cpuMs) abort('cpu_deadline');
        } catch { if (!stopping) abort('cpu_monitor_unavailable'); }
        finally { polling = false; }
      }, 100);
      const value = await operation();
      return { value, sampledCpuMs: peakCpuMs };
    })();
    return await Promise.race([measured, limit]);
  } finally {
    stopping = true;
    clearTimeout(wallTimer);
    clearInterval(cpuTimer);
    if (session.killPromise) await session.killPromise;
  }
}

async function initialize(session, engine, origin, trustedTracks = []) {
  const context = await session.browser.newContext({ serviceWorkers: 'block', viewport: { width: 800, height: 600 } });
  session.context = context;
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin || !['GET', 'HEAD'].includes(route.request().method())) return route.abort('blockedbyclient');
    return route.continue();
  });
  await context.routeWebSocket('**/*', socket => socket.close());
  const page = await context.newPage();
  session.page = page;
  session.pageErrors = [];
  page.on('pageerror', error => { trace(`page error: ${error.message.slice(0, 300)}`); if (session.pageErrors.length < 10) session.pageErrors.push(error.message.slice(0, 200)); });
  await page.addInitScript(() => {
    globalThis.__workers = [];
    globalThis.__trustedInit = null;
    const Native = Worker;
    globalThis.Worker = class extends Native {
      constructor(...args) {
        super(...args);
        if (String(args[0]).includes('simulation_worker')) __workers.push(this);
      }
      postMessage(message, ...args) {
        if (message?.messageType === 0 && !globalThis.__trustedInit) globalThis.__trustedInit = message;
        return super.postMessage(message, ...args);
      }
    };
  });
  await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
  trace('page loaded; awaiting trusted Init');
  await page.waitForFunction(() => globalThis.__trustedInit && globalThis.__vrRequire);
  await page.evaluate(() => { for (const worker of __workers) worker.terminate(); __workers.length = 0; });
  // Explicit trusted tracks precede static artifacts so a matching native ID
  // remains bound to the server-captured event bytes and expected hash.
  const tracks = [...trustedTracks, ...[...engine.files]
    .filter(([name, file]) => name.startsWith('tracks/') && name.endsWith('.track') && file.bytes.length <= LIMITS.trackBytes)
    .map(([name, file]) => ({ name, hash: file.hash, text: file.bytes.toString('utf8').trim(), trusted: false }))];
  const catalog = await page.evaluate(({ tracks }) => {
    const Track = __vrRequire(9117).A;
    globalThis.__tracks = new Map();
    const claimed = new Set();
    const result = [];
    for (const source of tracks) {
      const expectedId = source.expectedId || null;
      if (expectedId && claimed.has(expectedId)) continue;
      if (expectedId) claimed.add(expectedId);
      try {
        const track = Track.fromExportString(source.text)?.trackData;
        if (!track) {
          if (expectedId) result.push({ id: null, lookupId: expectedId, name: source.name, hash: source.hash,
            trusted: true, reason: 'trusted_track_decode_failed', geometry: null });
          continue;
        }
        const id = track.getId();
        const lookupId = expectedId || id;
        if (!expectedId && claimed.has(lookupId)) continue;
        if (!expectedId) claimed.add(lookupId);
        const bounds = track.getBounds();
        const spanX = bounds.max.x - bounds.min.x;
        const spanZ = bounds.max.y - bounds.min.y;
        let reason = null;
        if (expectedId && id !== expectedId) reason = 'track_identity_mismatch';
        else if (!track.getStartTransform()) reason = 'track_missing_start';
        if (!reason) __tracks.set(lookupId, track);
        result.push({ id, lookupId, name: source.name, hash: source.hash, trusted: source.trusted === true,
          reason, geometry: {parts: track.numberOfParts, spanX, spanZ} });
      } catch {
        if (expectedId) result.push({ id: null, lookupId: expectedId, name: source.name, hash: source.hash,
          trusted: true, reason: 'trusted_track_decode_failed', geometry: null });
      }
    }
    return result;
  }, { tracks });
  return new Map(catalog.map(track => {
    const decision = track.geometry ? geometryDecision(track, engine.engineFingerprint) :
      { reason: 'trusted_track_decode_failed', geometryPolicy: 'rejected' };
    return [track.lookupId, {...track, ...decision, reason: track.reason || decision.reason}];
  }));
}

async function simulate(session, job) {
  return session.page.evaluate(async ({ trackId, replay, timeMs }) => {
    const track = __tracks.get(trackId);
    if (!track || track.getId() !== trackId) return { status: 'unavailable', reason: 'track_identity_mismatch' };
    const Recording = __vrRequire(1754).A;
    const Time = __vrRequire(6146).A;
    const Validator = __vrRequire(5220).A;
    // Original bytes only reach the native decoder after strict, bounded Node validation.
    const recording = Recording.deserialize(replay);
    if (!recording) return { status: 'unavailable', reason: 'native_decoder_disagreement' };
    const validator = new Validator(false, { getPhysicsParts: () => __trustedInit.trackParts }, { hasLoaded: () => true });
    try {
      const deterministic = await validator.testDeterminism();
      if (deterministic !== true) return { status: 'unavailable', reason: 'determinism_failed' };
      const valid = await validator.validate(track, recording, new Time(timeMs));
      if (typeof valid !== 'boolean') return { status: 'unavailable', reason: 'invalid_native_response' };
      return { status: valid ? 'verified' : 'mismatch', reason: valid ? 'native_exact_finish' : 'native_finish_mismatch', deterministic };
    } finally { validator.dispose(); __workers.length = 0; }
  }, { trackId: job.trackId, replay: job.replay, timeMs: job.timeMs });
}

async function verifyBatch(root, jobs, trustedTracks) {
  if (!Array.isArray(jobs) || jobs.length > LIMITS.jobs) throw new TypeError(`jobs must be an array of at most ${LIMITS.jobs} jobs`);
  if (jobs.length === 0) return [];
  // Copy now so a caller cannot replace a PB input during an await.
  jobs = jobs.map(job => ({ ...publicJob(job), replay: typeof job?.replay === 'string' ? job.replay : null }));
  const output = new Array(jobs.length);
  const pending = [];
  let engine;
  let host;
  let session;
  let wallMs;
  let cpuMs;
  try {
    wallMs = duration('VERIFIER_WALL_MS', LIMITS.wallMs);
    cpuMs = duration('VERIFIER_CPU_MS', LIMITS.cpuMs);
    engine = snapshot(root);
    trace('snapshot loaded');
    const pin = JSON.parse(fs.readFileSync(path.join(__dirname, 'engine-manifest.json'), 'utf8'));
    if (pin.engineDigest !== engine.engineFingerprint || sha256(JSON.stringify(pin.files)) !== pin.engineDigest) throw Error('engine_pin_mismatch');
    if (JSON.stringify(pin.tracks) !== JSON.stringify(engine.tracks)) throw Error('track_pin_mismatch');
    if (process.env.VERIFIER_ENGINE_DIGEST && process.env.VERIFIER_ENGINE_DIGEST !== engine.engineFingerprint) throw Error('engine_pin_mismatch');
    const trusted = normalizeTrustedTracks(trustedTracks, new Set(jobs.map(job => job.trackId)));
    for (let i = 0; i < jobs.length; i++) {
      try { checkJob(jobs[i]); pending.push(i); }
      catch (error) { output[i] = verdict(jobs[i], error.status || 'unavailable', error.reason || 'input_validation_failed', engine); }
    }
    if (!pending.length) return output;
    const { chromium } = require(process.env.VERIFIER_PLAYWRIGHT_MODULE || 'playwright');
    host = await serve(engine);
    const server = await chromium.launchServer({
      headless: true, timeout: wallMs, host: '127.0.0.1', env: browserEnvironment(),
      chromiumSandbox: process.platform === 'linux',
      executablePath: chromium.executablePath(),
      ...(process.env.VERIFIER_CHROMIUM_PATH ? { executablePath: process.env.VERIFIER_CHROMIUM_PATH } : {}),
    });
    session = { server, dead: false };
    trace('browser launched');
    session.browser = await chromium.connect(server.wsEndpoint(), { timeout: wallMs });
    trace('browser connected');
    session.system = await session.browser.newBrowserCDPSession();
    trace('CPU monitor connected');
    const init = await bounded(() => initialize(session, engine, host.origin, trusted), session, wallMs, cpuMs);
    const catalog = init.value;
    trace(`initialized ${catalog.size} trusted tracks`);
    for (const index of pending) {
      const job = jobs[index];
      const track = catalog.get(job.trackId);
      if (!track || track.reason) {
        output[index] = verdict(job, 'unavailable', track?.reason || 'missing_trusted_track', engine, track);
        continue;
      }
      if (session.dead) { output[index] = verdict(job, 'unavailable', 'isolate_terminated', engine, track); continue; }
      const started = performance.now();
      try {
        const result = await bounded(() => simulate(session, job), session, wallMs, cpuMs);
        const native = session.pageErrors.length ? { status: 'unavailable', reason: 'page_error' } : result.value;
        output[index] = verdict(job, native.status, native.reason, engine, track, {
          deterministic: native.deterministic ?? null,
          wallMs: Math.round(performance.now() - started), sampledCpuMs: Math.round(result.sampledCpuMs),
        });
      } catch (error) {
        output[index] = verdict(job, 'unavailable', error.reason || 'native_engine_error', engine, track);
        session.dead = true;
        await terminate(session);
      }
    }
  } catch (error) {
    trace(`failure: ${error.message}`);
    console.error('[verifier startup]', String(error.message||error).replace(/https?:\/\/[^\s]+/g,'[url]').slice(0,1600));
    const reason = ['engine_pin_mismatch', 'track_pin_mismatch', 'module_5220_hook_missing_or_ambiguous', 'invalid_deadline_configuration'].includes(error.message) ? error.message : error.reason || 'engine_unavailable';
    for (let i = 0; i < jobs.length; i++) if (!output[i]) output[i] = verdict(jobs[i], 'unavailable', reason, engine);
  } finally {
    trace('cleanup');
    if (session) {
      try { await terminate(session, { graceful: !session.dead }); }
      catch {
        for (let i = 0; i < output.length; i++) {
          output[i] = { ...output[i], priorStatus: output[i]?.status, priorReason: output[i]?.reason,
            status: 'unavailable', reason: 'process_cleanup_failed', cleanup: session.cleanup };
        }
      }
    }
    if (host) await host.close();
  }
  return output;
}

module.exports = { verifyBatch, VERIFIER_VERSION, verifierFingerprint,
  _internals: { bounded, terminate, initialize, browserEnvironment, waitForExit, verdict } };
