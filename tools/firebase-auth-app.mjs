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
  assertOnlineCompatibility
}) {
  let pending = null;

  function assertCompatible() {
    return assertOnlineCompatibility();
  }

  return function ensureFirebaseAuthApp() {
    try {
      assertCompatible();
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
      const auth = app.auth();
      await waitForInitialAuth(auth);
      assertCompatible();
      if (!auth.currentUser) {
        await auth.signInAnonymously();
      }
      assertCompatible();
      if (!auth.currentUser) throw new Error('Firebase authentication is not ready');
      return app;
    }).catch(error => {
      pending = null;
      throw error;
    });
    return pending;
  };
}
