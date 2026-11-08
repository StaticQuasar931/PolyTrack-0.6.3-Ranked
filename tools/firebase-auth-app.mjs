const APP_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js';
const AUTH_SDK = 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth-compat.js';

/**
 * Create once per page and share between db() and authenticated broker callers.
 * The returned function resolves to the compat app; it never loads Firestore.
 * All callbacks are supplied by the host, including its online-version gate.
 */
export function createFirebaseAuthApp({
  window,
  loadScript,
  resolveFirebaseConfig,
  waitForInitialAuth,
  assertOnlineCompatibility,
  expectedOwnerUid = () => '',
  allowAnonymousCreation = () => true
}) {
  let pending = null, readyApp = null;

  function assertCompatible() {
    return assertOnlineCompatibility();
  }

  function assertKnownOwner(auth) {
    const owner=expectedOwnerUid();
    if(!auth.currentUser&&(owner||allowAnonymousCreation()===false))throw Object.assign(new Error('Your cloud sign-in could not be restored. Local PBs are safe; no replacement sign-in was created.'),{code:'cloud-signin-restoration-required'});
    if(!owner)return;
    if(auth.currentUser.uid!==owner)throw Object.assign(new Error('This cloud sign-in does not match this racer. Local PBs are safe.'),{code:'account-session-conflict'});
  }

  return function ensureFirebaseAuthApp() {
    try {
      assertCompatible();
      // A fulfilled initialization promise is not proof of a current auth session.
      if(readyApp)assertKnownOwner(readyApp.auth());
      if (readyApp && !readyApp.auth().currentUser) {
        pending = null;
        readyApp = null;
      }
    } catch (error) {
      return Promise.reject(error);
    }
    if (pending) return pending;

    // Defer work so even synchronous callback failures reset the shared promise.
    pending = Promise.resolve().then(async () => {
      assertCompatible();
      await loadScript(APP_SDK);
      assertCompatible();
      await loadScript(AUTH_SDK);
      assertCompatible();
      const config = await resolveFirebaseConfig();
      assertCompatible();
      const sdk = window.firebase;
      const app = sdk.apps?.length ? sdk.app() : sdk.initializeApp(config);
      if(app.options?.projectId&&config.projectId&&app.options.projectId!==config.projectId)throw Object.assign(new Error('The loaded cloud app belongs to a different project.'),{code:'cloud-project-mismatch'});
      const auth = app.auth();
      await waitForInitialAuth(auth);
      assertCompatible();
      assertKnownOwner(auth);
      if (!auth.currentUser) {
        await auth.signInAnonymously();
      }
      assertCompatible();
      if (!auth.currentUser) throw new Error('Firebase authentication is not ready');
      readyApp = app;
      return app;
    }).catch(error => {
      pending = null;
      readyApp = null;
      throw error;
    });
    return pending;
  };
}
