// Only the initial empty/loading UI may bypass changelog menu readiness.
// This module never installs the network updater or grants reload permission.
export function installEarlyUpdateNotice({document, release, installInstalledRevisionNotice, canUpdateFromGameMenu}) {
  const ui = document.getElementById('ui');
  if (!ui || !document.body) return null;
  const loading = '.loading-screen-ui,.loading-ui,.menu-ui.loading-screen';
  const active = '.game-ui,.pause-screen-ui,.session-end-ui,.editor-ui,.editor-side-toolbar-ui,.editor-height-selector-ui';
  const conflicts = '.track-selection-ui,.track-info-ui,.settings-menu-ui,.sq-extra-overlay,.sq-events-dialog,dialog[open]:not([data-site-installed-revision])';
  const visible = node => {
    for (let parent=node; parent; parent=parent.parentElement) {
      const style=document.defaultView.getComputedStyle(parent);
      if (parent.hidden || parent.classList?.contains('hidden') || style.display==='none' ||
        ['hidden','collapse'].includes(style.visibility) || Number(style.opacity || '1')<=0) return false;
    }
    return [...node.getClientRects()].some(rect => rect.width>0 && rect.height>0);
  };
  let boot = true;
  const available = () => {
    if ([...ui.children].some(node => !node.matches(loading)) || ui.querySelector(active)) boot = false;
    if (document.visibilityState !== 'visible' || [...document.querySelectorAll(conflicts)].some(visible)) return false;
    const focused = document.activeElement;
    return !(focused?.matches('input,textarea,select,iframe') || focused?.isContentEditable || focused?.closest('[role="textbox"]'));
  };
  const notice = installInstalledRevisionNotice({document, release, revision:release.revision,
    installedReleaseCommittedAt:release.committedAt, isReady:() => true,
    isInitialLoading:() => available() && boot,
    isIdle:() => available() && canUpdateFromGameMenu(document) && !!document.querySelector('.main-buttons-container')});
  // Track native controller transitions, not changing HUD text or leaderboard rows.
  const observer = new document.defaultView.MutationObserver(records => {
    if (records.some(record => record.target === ui || record.target === document.body ||
      record.target.matches?.('.menu-ui,.main-buttons-container,.loading-screen-ui,.loading-ui') ||
      record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some(node =>
        node.nodeType === 1 && (node.matches(active) || node.querySelector(active))))) notice.resume();
  });
  observer.observe(ui, {childList:true, subtree:true, attributes:true, attributeFilter:['class','style','hidden']});
  observer.observe(document.body, {childList:true});
  return notice;
}

if (globalThis.document) {
  const versioned = name => new URL(name + new URL(import.meta.url).search, import.meta.url).href;
  void Promise.all([import(versioned('./site-updates.mjs')), import(versioned('./release-info.mjs')),
    import(versioned('./site-update-menu-state.mjs'))]).then(([notices, release, menus]) => {
    installEarlyUpdateNotice({document:globalThis.document, release:release.RELEASE_INFO,
      installInstalledRevisionNotice:notices.installInstalledRevisionNotice, canUpdateFromGameMenu:menus.canUpdateFromGameMenu});
  }).catch(error => console.warn('[UPDATE_NOTICE] Early release information unavailable', error));
}
