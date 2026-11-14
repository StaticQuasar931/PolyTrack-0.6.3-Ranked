/** Mount after setupRacerStudio; call cleanup before replacing content or accounts.
 * confirmed is the authoritative profile entry, local is exact device progress,
 * cosmetics is PROFILE_COSMETIC_OPTIONS. Callback shapes match the journal API.
 * Module query parameters are preserved; revision overrides the v cache key.
 * storage defaults safely to this document's localStorage; null disables it.
 */
export function mountProfileAchievements(content, {accountId,confirmed,local,cosmetics,onTryCosmetic,onNavigate,revision,storage} = {}) {
  if (!content?.ownerDocument || !content.isConnected) return () => {};
  const document = content.ownerDocument;
  let preferenceStorage = storage;
  if (preferenceStorage === undefined) {
    try { preferenceStorage = document.defaultView?.localStorage; } catch { preferenceStorage = null; }
  }
  const moduleURL = new URL('./achievement-journal.mjs',import.meta.url);
  moduleURL.search = new URL(import.meta.url).search;
  if (revision !== undefined && revision !== null) moduleURL.searchParams.set('v',String(revision));
  const cssURL = new URL('./achievement-journal.css',import.meta.url);
  cssURL.search = moduleURL.search;
  const details = document.createElement('details');
  details.className = 'profile-achievement-journey';
  details.dataset.accountId = String(accountId ?? '');
  const summary = document.createElement('summary');
  summary.className = 'profile-achievement-journey-summary';
  const title = document.createElement('strong'); title.textContent = 'Achievements';
  const subtitle = document.createElement('span'); subtitle.textContent = 'Find your next unlock';
  summary.append(title,document.createTextNode(' '),subtitle);
  const host = document.createElement('div');
  host.className = 'profile-achievement-journey-content';
  details.append(summary,host);
  const customizer = content.querySelector('.profile-customizer');
  if (customizer) customizer.before(details); else content.append(details);
  let disposed = false, pending = null, unbind = null;
  const current = () => !disposed && content.isConnected && details.isConnected && content.contains(details);
  const loadStyle = () => {
    if ([...document.querySelectorAll('link[data-profile-achievements-css]')].some(link => link.href === cssURL.href)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet'; link.href = cssURL.href;
    link.dataset.profileAchievementsCss = '';
    document.head.append(link);
  };
  const close = () => {
    if (!current()) return;
    details.open = false;
    summary.focus();
  };
  const open = () => {
    if (!details.open || !current() || unbind || pending) return;
    host.setAttribute('aria-busy','true');host.textContent='Loading achievements...';
    pending = import(moduleURL.href).then(api => {
      if (!current() || !details.open) return;
      host.innerHTML = api.renderAchievementJournal({progress:{confirmed,local},cosmetics});
      unbind = api.bindAchievementJournal(host,{onTryCosmetic,onNavigate,onClose:close,storage:preferenceStorage});
    }).catch(() => {
      if (!current() || !details.open) return;
      host.textContent = 'Achievements could not load. Close and reopen to try again.';
    }).finally(() => {
      pending = null;
      if (current()) host.removeAttribute('aria-busy');
    });
  };
  loadStyle();
  details.addEventListener('toggle',open);
  return () => {
    if (disposed) return;
    disposed = true;
    details.removeEventListener('toggle',open);
    unbind?.(); unbind = null;
    details.remove();
  };
}
