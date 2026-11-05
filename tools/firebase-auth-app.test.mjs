import test from 'node:test';
import assert from 'node:assert/strict';
import {createFirebaseAuthApp} from './firebase-auth-app.mjs';

function harness({existing = false, user = null} = {}) {
  const calls = {loads: [], config: 0, initialize: 0, restore: 0, signIn: 0};
  let allowed = true;
  const offline = Object.assign(new Error('Version offline'), {code: 'client-version-offline'});
  const auth = {
    currentUser: user,
    async signInAnonymously() {
      calls.signIn++;
      this.currentUser = {uid: 'mock-anonymous'};
    }
  };
  const app = {auth: () => auth, firestore: () => {throw new Error('Firestore must not be used');}};
  const sdk = {
    apps: existing ? [app] : [],
    app: () => app,
    initializeApp(config) {
      assert.deepEqual(config, {projectId: 'mock-project'});
      calls.initialize++;
      this.apps.push(app);
      return app;
    }
  };
  const options = {
    window: {firebase: sdk},
    loadScript: async url => {calls.loads.push(url);},
    resolveFirebaseConfig: async () => {calls.config++; return {projectId: 'mock-project'};},
    waitForInitialAuth: async value => {assert.equal(value, auth); calls.restore++;},
    assertOnlineCompatibility: () => {if (!allowed) throw offline;}
  };
  return {calls, app, auth, sdk, options, offline, setAllowed: value => {allowed = value;}};
}

test('lazy factory shares one promise and app across concurrent and later callers', async () => {
  const h = harness();
  const ensure = createFirebaseAuthApp(h.options);
  assert.equal(h.calls.loads.length, 0);
  const first = ensure();
  assert.equal(ensure(), first);
  const apps = await Promise.all(Array.from({length: 20}, () => ensure()));
  assert(apps.every(app => app === h.app));
  assert.equal(await first, h.app);
  assert.equal(ensure(), first);
  assert.equal(h.calls.initialize, 1);
  assert.equal(h.calls.restore, 1);
  assert.equal(h.calls.signIn, 1);
  assert.deepEqual(h.calls.loads, [
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js',
    'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js'
  ]);
});

test('restored user on existing app is reused without anonymous sign-in', async () => {
  const h = harness({existing: true});
  h.options.waitForInitialAuth = async auth => {
    h.calls.restore++;
    auth.currentUser = {uid: 'restored'};
  };
  assert.equal(await createFirebaseAuthApp(h.options)(), h.app);
  assert.equal(h.calls.initialize, 0);
  assert.equal(h.calls.signIn, 0);
  assert.equal(h.auth.currentUser.uid, 'restored');
});

test('version gate rejects before SDK work and also gates cached success', async () => {
  const h = harness();
  const ensure = createFirebaseAuthApp(h.options);
  h.setAllowed(false);
  await assert.rejects(ensure(), error => error === h.offline);
  assert.equal(h.calls.loads.length, 0);
  h.setAllowed(true);
  await ensure();
  h.setAllowed(false);
  await assert.rejects(ensure(), error => error === h.offline);
  assert.equal(h.calls.signIn, 1);
  h.setAllowed(true);
  assert.equal(await ensure(), h.app);
});

test('gate changing during SDK loading blocks remaining cloud initialization and permits retry', async () => {
  const h = harness();
  let interrupt = true;
  h.options.loadScript = async url => {
    h.calls.loads.push(url);
    if (interrupt) h.setAllowed(false);
  };
  const ensure = createFirebaseAuthApp(h.options);
  await assert.rejects(ensure(), error => error === h.offline);
  assert.equal(h.calls.loads.length, 1);
  assert.equal(h.calls.initialize, 0);
  h.setAllowed(true);
  interrupt = false;
  assert.equal(await ensure(), h.app);
});

test('reads the global SDK after the supplied script loader installs it', async () => {
  const h = harness();
  delete h.options.window.firebase;
  h.options.loadScript = async url => {
    h.calls.loads.push(url);
    if (url.endsWith('/firebase-auth-compat.js')) h.options.window.firebase = h.sdk;
  };
  assert.equal(await createFirebaseAuthApp(h.options)(), h.app);
  assert.equal(h.calls.initialize, 1);
});

test('version change during restored-session wait prevents anonymous sign-in', async () => {
  const h = harness();
  let interrupt = true;
  h.options.waitForInitialAuth = async () => {if (interrupt) h.setAllowed(false);};
  const ensure = createFirebaseAuthApp(h.options);
  await assert.rejects(ensure(), error => error === h.offline);
  assert.equal(h.calls.signIn, 0);
  h.setAllowed(true);
  interrupt = false;
  assert.equal(await ensure(), h.app);
  assert.equal(h.calls.initialize, 1);
});

for (const stage of ['loadScript', 'resolveFirebaseConfig', 'waitForInitialAuth', 'signInAnonymously']) {
  test(`${stage} failure is shared, preserves error identity, and resets for retry`, async () => {
    const h = harness();
    const failure = new Error(`mock ${stage} failure`);
    let fail = true;
    const target = stage === 'signInAnonymously' ? h.auth : h.options;
    const original = target[stage];
    target[stage] = function (...args) {
      if (fail) throw failure;
      return original.apply(this, args);
    };
    const ensure = createFirebaseAuthApp(h.options);
    const first = ensure();
    assert.equal(ensure(), first);
    await assert.rejects(first, error => error === failure);
    fail = false;
    const retry = ensure();
    assert.notEqual(retry, first);
    assert.equal(await retry, h.app);
    assert.equal(h.calls.initialize, 1);
  });
}

test('anonymous sign-in resolving without a user is not cached as success', async () => {
  const h = harness();
  let ready = false;
  h.auth.signInAnonymously = async () => {if (ready) h.auth.currentUser = {uid: 'ready'};};
  const ensure = createFirebaseAuthApp(h.options);
  await assert.rejects(ensure(), /authentication is not ready/);
  ready = true;
  assert.equal(await ensure(), h.app);
  assert.equal(h.calls.initialize, 1);
});

test('Firestore SDK and quota state are not required by Auth-only callers', async () => {
  const h = harness({existing: true, user: {uid: 'signed-in'}});
  Object.defineProperty(h.options.window, 'firestoreQuotaPaused', {
    get() {throw new Error('Firestore quota state must not be consulted');}
  });
  h.sdk.firestore = () => {throw new Error('Firestore SDK must not be used');};
  assert.equal(await createFirebaseAuthApp(h.options)(), h.app);
  assert(h.calls.loads.every(url => !url.includes('firestore')));
  assert.equal(h.calls.signIn, 0);
});

test('cached initialization revalidates a lost session and coalesces recovery', async () => {
  const h = harness();
  const ensure = createFirebaseAuthApp(h.options);
  await ensure();
  h.auth.currentUser = null;
  const recovered = await Promise.all(Array.from({length: 20}, () => ensure()));
  assert.ok(recovered.every(app => app === h.app));
  assert.ok(h.auth.currentUser, 'cached app must not claim auth readiness with no user');
  assert.equal(h.calls.signIn, 2, 'one initial sign-in and one shared recovery');
  assert.equal(h.calls.initialize, 1);
});

test('failed lost-session recovery can retry without a second app', async () => {
  const h = harness();
  const ensure = createFirebaseAuthApp(h.options);
  await ensure();
  h.auth.currentUser = null;
  const signIn = h.auth.signInAnonymously;
  h.auth.signInAnonymously = async () => {throw Error('offline recovery');};
  await assert.rejects(ensure(), /offline recovery/);
  h.auth.signInAnonymously = signIn;
  await ensure();
  assert.ok(h.auth.currentUser);
  assert.equal(h.calls.initialize, 1);
});
