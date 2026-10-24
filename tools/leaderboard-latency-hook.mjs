const NATIVE_STACK = /(?:^|[/(])main\.bundle\.js(?:\?[^:\s)]*)?:\d+:\d+/;
const TRACK_BUTTON = '.track-selection-ui .track > button';

export function isVerifiedNativeInitialLeaderboardSchedule(callback, delay, stack) {
  if (delay !== 500 || typeof callback !== 'function' || !NATIVE_STACK.test(String(stack || ''))) return false;
  const source = Function.prototype.toString.call(callback);
  return source.includes('isCancelled') && source.includes('.getLeaderboard(');
}

export function installNativeInitialOpenLatencyHook({window: view = window, document: root = document, onEvent = () => {}, onInitialOpen = () => {}} = {}) {
  let activeRestore = null;
  const onClick = event => {
    const button = event.target?.closest?.(TRACK_BUTTON);
    if (activeRestore || !button || !button.isConnected || !root.querySelector('script[src*="main.bundle.js"]')) return;
    if (root.querySelector('.track-info-ui:not(.hidden)')) return;

    const original = view.setTimeout;
    let settled = false;
    let fallback;
    const restore = () => {
      if (settled) return;
      settled = true;
      activeRestore = null;
      if (view.setTimeout === scopedTimeout) view.setTimeout = original;
      button.removeEventListener('click', finishOpen);
      view.clearTimeout(fallback);
      onEvent('restored');
    };
    function finishOpen() {
      // The constructor has now created its filter. Apply the existing default
      // before either native request can paint; only this click is accelerated.
      try { onInitialOpen(); } finally { restore(); }
    }
    function scopedTimeout(callback, delay, ...args) {
      const stack = new Error().stack;
      if (isVerifiedNativeInitialLeaderboardSchedule(callback, delay, stack)) {
        onEvent('matched');
        return original.call(view, callback, 0, ...args);
      }
      return original.call(view, callback, delay, ...args);
    }
    activeRestore = restore;
    view.setTimeout = scopedTimeout;
    onEvent('armed');
    button.addEventListener('click', finishOpen, {once:true});
    fallback = original.call(view, restore, 0);
  };
  root.addEventListener('click', onClick, true);
  return () => { root.removeEventListener('click', onClick, true); activeRestore?.(); };
}
