let serial = 0;

/** Mount after setupRacerStudio, inside the existing profile card/panel ancestry.
 * Returns cleanup() with .open('achievements'|'studio', reward?) and .close().
 * content.__profileHubOpen is the same opener. Cleanup BEFORE replacing content.
 * No Studio node is cloned, no choice is clicked, and no save is synthesized.
 * Optional model/buildModel follow the journal's existing pure model contract.
 * Optional storage defaults safely to this document's localStorage; null disables.
 */
export function mountProfileAchievements(content, {accountId,confirmed,local,cosmetics,onTryCosmetic,onNavigate,revision,storage,model,buildModel,launcher = true} = {}) {
  if (!content?.ownerDocument || !content.isConnected) {
    const noop = () => {}; noop.open = () => false; noop.close = noop; return noop;
  }
  const doc = content.ownerDocument, win = doc.defaultView;
  let id;
  do {id = `profile-hub-${++serial}`;} while (doc.getElementById(id));
  let preferenceStorage = storage;
  if (preferenceStorage === undefined) {
    try { preferenceStorage = win?.localStorage; } catch { preferenceStorage = null; }
  }
  const moduleURL = new URL('./achievement-journal.mjs',import.meta.url);
  moduleURL.search = new URL(import.meta.url).search;
  if (revision !== undefined && revision !== null) moduleURL.searchParams.set('v',String(revision));
  const cssURL = new URL('./achievement-journal.css',import.meta.url); cssURL.search = moduleURL.search;
  if (![...doc.querySelectorAll('link[data-profile-achievements-css]')].some(link => link.href === cssURL.href)) {
    const link = doc.createElement('link'); link.rel = 'stylesheet'; link.href = cssURL.href;
    link.dataset.profileAchievementsCss = ''; doc.head.append(link);
  }

  const entry = doc.createElement('div');
  entry.className = 'profile-achievement-journey'; entry.setAttribute('role','group'); entry.setAttribute('aria-label','Racer progress and design');
  entry.innerHTML = `<button type="button" data-ph-launch="achievements" aria-haspopup="dialog" aria-controls="${id}"><span class="ph-entry-mark" aria-hidden="true">//</span><span><strong>Achievements</strong><small>Find your next unlock</small></span></button><button type="button" data-ph-launch="studio" aria-haspopup="dialog" aria-controls="${id}"><span class="ph-entry-mark" aria-hidden="true">//</span><span><strong>Racer Studio</strong><small>Make it yours</small></span></button>`;
  const initialStudio = content.querySelector('.profile-customizer');
  const initialHidden = initialStudio?.hidden;
  if (initialStudio) initialStudio.hidden = true;
  if (launcher) { if (initialStudio) initialStudio.before(entry); else content.append(entry); }

  // Keep both dialog and moved Studio inside the native delegated event ancestry.
  const dialog = doc.createElement('dialog');
  dialog.id = id; dialog.className = 'profile-hub'; dialog.dataset.accountId = String(accountId ?? '');
  dialog.setAttribute('aria-labelledby',`${id}-title`);
  dialog.innerHTML = `<header class="ph-header"><div class="ph-brand" aria-hidden="true"><svg viewBox="0 0 48 48" fill="none"><path d="M7 38V8h30l-6 9 6 9H10M16 8v18M26 8v18M10 17h24" stroke="currentColor" stroke-width="3"/></svg></div><div class="ph-heading"><p>YOUR RACER</p><h2 id="${id}-title">Achievements &amp; Studio</h2></div><button type="button" class="ph-close" data-ph-close aria-label="Close racer hub">Close <span aria-hidden="true">&#215;</span></button></header><div class="ph-tabbar" role="tablist" aria-label="Racer hub"><button type="button" role="tab" id="${id}-tab-achievements" aria-controls="${id}-achievements" aria-selected="true" data-ph-tab="achievements">Achievements</button><button type="button" role="tab" id="${id}-tab-studio" aria-controls="${id}-studio" aria-selected="false" tabindex="-1" data-ph-tab="studio">Racer Studio</button><span class="ph-tab-hint">Earn styles as you race.</span></div><section class="ph-panel" id="${id}-achievements" role="tabpanel" aria-labelledby="${id}-tab-achievements"><div data-ph-journal></div></section><section class="ph-panel ph-studio-panel" id="${id}-studio" role="tabpanel" aria-labelledby="${id}-tab-studio" hidden><p class="ph-studio-note">Choose your style.</p><div data-ph-studio></div></section>`;
  content.append(dialog);
  const journalHost = dialog.querySelector('[data-ph-journal]'), studioHost = dialog.querySelector('[data-ph-studio]');
  const studioPanel = dialog.querySelector('.ph-studio-panel');
  const tabs = [...dialog.querySelectorAll('[data-ph-tab]')];
  let disposed = false, pending = null, unbind = null, studio = null, snapshot = null, returnFocus = null, activeTab = 'achievements';
  const touched = new Map();
  const sameAccount = () => !content.dataset.accountId || content.dataset.accountId === String(accountId ?? '');
  const current = () => !disposed && sameAccount() && content.isConnected && dialog.isConnected && content.contains(dialog);
  function measureStudio() {
    if (!current() || !dialog.open || studioPanel.hidden || !studio) return;
    const preview = studio.querySelector('.profile-customizer-preview');
    if (!preview) return;
    const panelBox = studioPanel.getBoundingClientRect(), previewBox = preview.getBoundingClientRect();
    const paddingBottom = parseFloat(win.getComputedStyle(studioPanel).paddingBottom) || 0;
    studioPanel.style.setProperty('--ph-panel-height',`${studioPanel.clientHeight}px`);
    studioPanel.style.setProperty('--ph-preview-height',`${Math.max(0,Math.floor(panelBox.bottom - Math.max(panelBox.top,previewBox.top) - paddingBottom))}px`);
  }
  const previewResize = new win.ResizeObserver(measureStudio);

  function touch(node,attribute,value) {
    if (!touched.has(node)) touched.set(node,new Map());
    if (!touched.get(node).has(attribute)) touched.get(node).set(attribute,node.getAttribute(attribute));
    node.setAttribute(attribute,value);
  }
  function clearTargets() {
    for (const [node,attributes] of touched) for (const [name,value] of attributes) {
      if (value === null) node.removeAttribute(name); else node.setAttribute(name,value);
    }
    touched.clear();
  }
  function moveStudio() {
    if (studio) return;
    studio = content.querySelector('.profile-customizer');
    if (!studio) {studioHost.textContent = 'Racer Studio is available from your own profile.';return;}
    const placeholder = doc.createComment('Racer Studio return position'); studio.before(placeholder);
    const summary = studio.querySelector(':scope > summary');
    snapshot = {placeholder,open:studio.open,hidden:studio.hidden,summary,summaryHidden:summary?.hidden};
    if (summary) summary.hidden = true;
    studio.open = true; studio.hidden = false;
    studioHost.replaceChildren(studio);
  }
  function restoreStudio() {
    clearTargets();
    if (!studio || !snapshot) return;
    studio.open = snapshot.open;
    studio.hidden = disposed ? (studio === initialStudio ? initialHidden : snapshot.hidden) : true;
    if (snapshot.summary) snapshot.summary.hidden = snapshot.summaryHidden;
    // Missing placeholder means the root was replaced. Never resurrect an old account.
    if (sameAccount() && snapshot.placeholder.parentNode) snapshot.placeholder.replaceWith(studio);
    else {snapshot.placeholder.remove();studio.remove();}
    studio = null; snapshot = null;
  }
  function focusReward(reward) {
    if (!studio || !reward?.kind) return;
    const group = [...studio.querySelectorAll('.profile-cosmetic-group')].find(node => node.classList.contains(`kind-${reward.kind}`));
    if (!group) return;
    const pane = group.closest('[data-studio-panel]');
    if (pane) [...studio.querySelectorAll('[data-studio-tab]')].find(node => node.dataset.studioTab === pane.dataset.studioPanel)?.click();
    clearTargets();
    const choice = [...group.querySelectorAll('[data-cosmetic-choice]')].find(node => node.dataset.cosmeticKind === reward.kind && node.dataset.cosmeticValue === reward.id);
    const target = choice ?? group;
    touch(target,'data-hub-reward-target','');
    if (!target.matches('button,input,select,textarea,[tabindex]')) touch(target,'tabindex','-1');
    target.focus({preventScroll:true}); target.scrollIntoView({block:'nearest'});
  }
  function showTab(tab,reward,focus = false) {
    activeTab = tab === 'studio' ? 'studio' : 'achievements';
    for (const node of tabs) {
      const selected = node.dataset.phTab === activeTab;
      node.setAttribute('aria-selected',String(selected)); node.tabIndex = selected ? 0 : -1;
      dialog.querySelector(`#${node.getAttribute('aria-controls')}`).hidden = !selected;
    }
    if (activeTab === 'achievements') void loadJournal(); else {measureStudio();focusReward(reward);}
    if (focus && !reward) tabs.find(node => node.dataset.phTab === activeTab)?.focus({preventScroll:true});
  }
  function viewReward(reward) {
    if (!current() || !dialog.open) return;
    showTab('studio',reward); onTryCosmetic?.(reward);
  }
  function navigate(family) {
    if (family === 'style' || family === 'titles') {
      showTab('studio',family === 'titles' ? {kind:'title'} : undefined,true); onNavigate?.(family);
    } else if (onNavigate) {closeHub();onNavigate(family);}
  }
  function loadJournal() {
    if (!current() || !dialog.open || unbind || pending) return pending;
    journalHost.setAttribute('aria-busy','true'); journalHost.textContent = 'Loading achievements...';
    pending = import(moduleURL.href).then(api => {
      if (!current() || !dialog.open) return;
      journalHost.innerHTML = api.renderAchievementJournal({progress:{confirmed,local},cosmetics,model,buildModel,embedded:true});
      unbind = api.bindAchievementJournal(journalHost,{onTryCosmetic:viewReward,onNavigate:navigate,onClose:closeHub,storage:preferenceStorage});
    }).catch(() => {
      if (current() && dialog.open) journalHost.textContent = 'Achievements could not load. Close and reopen to try again.';
    }).finally(() => {pending = null;if (current()) journalHost.removeAttribute('aria-busy');});
    return pending;
  }
  const observer = new win.MutationObserver(() => {if (!current()) cleanup();});
  function openHub(tab = 'achievements',reward) {
    if (!current()) return false;
    if (!dialog.open) {
      returnFocus = doc.activeElement; moveStudio(); dialog.showModal();
      previewResize.observe(studioPanel);
      previewResize.observe(dialog.querySelector('.ph-studio-note'));
      observer.observe(doc.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['data-account-id']});
    }
    showTab(tab,reward,true); return true;
  }
  function finishClose(restoreFocus = true) {
    previewResize.disconnect();
    if (!snapshot && !returnFocus) {observer.disconnect();return;}
    observer.disconnect(); restoreStudio();
    if (restoreFocus) {
      const returnable = returnFocus?.matches?.('button,input,select,textarea,a[href],summary,[tabindex]') && returnFocus.isConnected && returnFocus.getClientRects().length;
      const target = returnable ? returnFocus : entry.isConnected ? entry.querySelector(`[data-ph-launch="${activeTab}"]`) : null;
      target?.focus({preventScroll:true});
    }
    returnFocus = null;
  }
  function closeHub() {if (dialog.open) dialog.close();finishClose();}
  function keydown(event) {
    if (!dialog.open || !dialog.contains(event.target)) return;
    if (event.key === 'Escape') {event.preventDefault();event.stopPropagation();closeHub();return;}
    if (event.key === 'Tab') {
      // Trap only our Tab key, before the underlying profile's bubble-phase trap.
      event.stopPropagation();
      const focusables = [...dialog.querySelectorAll('button:not([disabled]),summary,input:not([disabled]),select:not([disabled]),textarea:not([disabled]),a[href],[tabindex]')].filter(node => node.tabIndex >= 0 && !node.closest('[hidden],[inert]') && node.getClientRects().length);
      const first = focusables[0], last = focusables.at(-1);
      if (event.shiftKey && doc.activeElement === first) {event.preventDefault();last?.focus();}
      else if (!event.shiftKey && doc.activeElement === last) {event.preventDefault();first?.focus();}
      return;
    }
    if (event.target.matches('[data-ph-tab]') && ['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const index = tabs.indexOf(event.target), next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      showTab(tabs[next].dataset.phTab,undefined,true);
    }
  }
  const click = event => {
    const target = event.target.closest('button');
    if (target?.hasAttribute('data-ph-close')) closeHub();
    else if (target?.hasAttribute('data-ph-tab')) showTab(target.dataset.phTab,undefined,true);
    // Native Studio click/change/input events bubble unchanged.
  };
  const launch = event => {const button = event.target.closest('[data-ph-launch]');if (button && entry.contains(button)) openHub(button.dataset.phLaunch);};
  const cancel = event => {event.preventDefault();event.stopPropagation();closeHub();};
  const closed = () => {if (!dialog.open) finishClose();};
  entry.addEventListener('click',launch);
  dialog.addEventListener('click',click); dialog.addEventListener('keydown',keydown);
  dialog.addEventListener('cancel',cancel); dialog.addEventListener('close',closed);
  function cleanup() {
    if (disposed) return;
    disposed = true; observer.disconnect(); previewResize.disconnect(); unbind?.(); unbind = null;
    if (dialog.open) dialog.close(); finishClose(false);
    if (initialStudio) initialStudio.hidden = initialHidden;
    entry.removeEventListener('click',launch);
    dialog.removeEventListener('click',click); dialog.removeEventListener('keydown',keydown);
    dialog.removeEventListener('cancel',cancel); dialog.removeEventListener('close',closed);
    entry.remove(); dialog.remove();
    if (content.__profileHubOpen === openHub) delete content.__profileHubOpen;
  }
  cleanup.open = openHub; cleanup.close = closeHub; cleanup.dialog = dialog;
  content.__profileHubOpen = openHub;
  return cleanup;
}
