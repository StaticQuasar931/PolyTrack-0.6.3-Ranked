// Native controller lifetimes, not HUD visibility, determine update eligibility.
// main.bundle.js: Fr owns .game-ui for both driving and replay until dispose().
// 112.bundle.js: editor changes its root class to "hidden" during load/save;
// its toolbar/height-selector children remain attached until editor disposal.
const TRACK_ROOTS = '.game-ui,.pause-screen-ui,.session-end-ui';
const EDITOR_ROOTS = '.editor-ui,.editor-side-toolbar-ui,.editor-height-selector-ui';
const LOADING_ROOTS = '.loading-screen-ui,.loading-ui';
const NATIVE_MENUS = '.menu-ui,.settings-menu-ui,.track-info-ui,.track-selection-ui';
// These roots are created by the Ranked patch, events/client and catalog-ui.
const CUSTOM_MENUS = '#overallLeaderboardPanel,#overallProfilePopup,#overallHelpPopup,.sq-events-overlay,.sq-extra-overlay';
const NON_TEXT_INPUTS = new Set(['button','submit','reset','checkbox','radio','range','color','file','image','hidden']);

const result = (canUpdate, reason) => Object.freeze({canUpdate, reason});
const attached = node => node?.isConnected === true;

function hasAttached(root, selectors) {
  return [...root.querySelectorAll(selectors)].some(attached);
}

function visibleMenu(node, view) {
  if (!attached(node)) return false;
  // Check ancestors too: opacity/visibility on a hidden menu parent is not
  // necessarily reflected in a child's own computed style or layout rects.
  for (let parent = node; parent; parent = parent.parentElement) {
    if (parent.hidden || parent.classList.contains('hidden')) return false;
    const style = view.getComputedStyle(parent);
    if (style.display === 'none' || ['hidden','collapse'].includes(style.visibility) ||
        !Number.isFinite(Number(style.opacity || '1')) || Number(style.opacity || '1') <= 0) return false;
  }
  // Native modal inertness/aria-hidden do not mean the menu was disposed.
  return [...node.getClientRects()].some(rect => rect.width > 0 && rect.height > 0);
}

function textEntryFocused(document) {
  let active = document.activeElement;
  const seen = new Set();
  while (active?.shadowRoot?.activeElement) {
    if (seen.has(active)) return true;
    seen.add(active);active = active.shadowRoot.activeElement;
  }
  if (!active) return false;
  const tag = active.tagName?.toLowerCase();
  return tag === 'textarea' || tag === 'select' || tag === 'iframe' ||
    tag === 'input' && !NON_TEXT_INPUTS.has(String(active.type || 'text').toLowerCase()) ||
    active.isContentEditable === true || !!active.closest?.('[role="textbox"]');
}

/**
 * Read current native/menu state without side effects, observers or cached proof.
 * Connected track/editor roots veto even if hidden behind menus or dialogs.
 * Dialogs alone never establish a menu; the updater's own modal is not a veto.
 * This is reload/offer policy only, NOT the installed release changelog policy.
 * @returns {{canUpdate: boolean, reason: string}}
 */
export function readSiteUpdateMenuState(document = globalThis.document) {
  try {
    if (!document?.body || !attached(document.body)) return result(false, 'document-unavailable');
    if (document.visibilityState !== 'visible') return result(false, 'page-hidden');
    const ui = document.getElementById('ui');
    if (!attached(ui)) return result(false, 'native-ui-unavailable');
    // Never consult visibility for active-controller vetoes. Native .game-ui
    // can be hidden for free camera/HUD toggles, and paused replay is still a track.
    if (hasAttached(ui, TRACK_ROOTS)) return result(false, 'track-active');
    if (hasAttached(ui, EDITOR_ROOTS)) return result(false, 'editor-active');
    if (hasAttached(document, LOADING_ROOTS)) return result(false, 'loading');
    if (textEntryFocused(document)) return result(false, 'text-entry');
    const view = document.defaultView;
    if (typeof view?.getComputedStyle !== 'function') return result(false, 'visibility-unavailable');
    const menus = [...ui.querySelectorAll(NATIVE_MENUS), ...document.querySelectorAll(CUSTOM_MENUS)];
    return menus.some(node => visibleMenu(node, view)) ? result(true, 'menu') : result(false, 'menu-unavailable');
  } catch {
    return result(false, 'state-unavailable');
  }
}

/** Use the same fresh guard for installSiteUpdates.isIdle and .canReload. */
export function canUpdateFromGameMenu(document = globalThis.document) {
  return readSiteUpdateMenuState(document).canUpdate;
}
