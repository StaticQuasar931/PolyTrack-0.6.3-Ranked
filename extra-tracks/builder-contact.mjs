export const BUILDER_DISCORD_URL = 'https://discord.gg/jW2az4AQUH';
export const BUILDER_EMAIL = 'StaticQuasar931Games@gmail.com';

export function builderContactDraft() {
  return 'Builder program / track credit review\n\n' +
    'Track name and code or link:\n' +
    'Original post or authorship evidence:\n' +
    'Original creator(s) and contributor roles:\n' +
    'Permissions and original credits for any port or adaptation:\n' +
    'Requested review or credit correction:\n' +
    'Optional public reply handle:\n\n' +
    'Please review the attribution. I understand this request does not guarantee featuring.\n';
}
export function builderContactMailto() {
  return 'mailto:' + BUILDER_EMAIL + '?subject=' + encodeURIComponent('Builder program / track credit review') + '&body=' + encodeURIComponent(builderContactDraft());
}

export function mountBuilderContact({document, root, onBack, onDownload} = {}) {
  if (!document?.createElement || !root?.append) throw new TypeError('document and root are required');
  let destroyed = false, pending = false;
  const make = (tag, className, value) => {
    const node = document.createElement(tag); if (className) node.className = className;
    if (value !== undefined) node.textContent = value; return node;
  };
  const panel = make('section', 'sq-builder-contact');
  panel.setAttribute('aria-label', 'Builder program contact');
  const back = make('button', 'sq-builder-back', 'Back to tracks'); back.type = 'button';
  back.addEventListener('click', () => {if (!destroyed) onBack?.();});
  const title = make('h3', '', 'Builder program');
  title.setAttribute('tabindex', '-1');
  panel.append(back, title, make('p', 'sq-builder-intro', 'Share a track or request a credit review.'));
  panel.append(make('p', 'sq-builder-review-note', 'Credits and featuring are reviewed. Ports must credit original creators.'));
  const reviewHelp = make('details', 'sq-builder-review-help');
  reviewHelp.append(make('summary', '', 'How review works'), make('p', '', 'Original submissions, creator credits and contributor roles inform attribution. A contact request does not prove account ownership or guarantee featuring. This contact page sends no ratings or votes.'));
  panel.append(reviewHelp);
  const checklist = make('section', 'sq-builder-checklist'); checklist.append(make('h4', '', 'Include in your message'));
  const list = make('ul');
  for (const item of ['Track name and a code or playable link', 'Original post or other authorship evidence', 'Original creators and each contributor role', 'Permission and original credits for reused or adapted work', 'What you want reviewed or corrected']) list.append(make('li', '', item));
  checklist.append(list); panel.append(checklist);
  const actions = make('div', 'sq-builder-contact-actions');
  const discord = make('a', 'sq-builder-discord', 'Contact on Discord'); discord.href = BUILDER_DISCORD_URL;
  discord.target = '_blank'; discord.rel = 'noopener noreferrer'; discord.referrerPolicy = 'no-referrer';
  const email = make('a', 'sq-builder-email', 'Email backup'); email.href = builderContactMailto();
  email.setAttribute('aria-label', 'Email backup: ' + BUILDER_EMAIL);
  const download = make('button', 'sq-builder-download', 'Download message checklist'); download.type = 'button';
  const status = make('p', 'sq-builder-contact-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); status.hidden = true;
  download.addEventListener('click', async () => {
    if (destroyed || pending) return;
    pending = true; download.disabled = true;
    try {
      const draft = builderContactDraft();
      if (onDownload) await onDownload(draft);
      else {
        const view = document.defaultView || globalThis;
        const blob = new view.Blob([draft], {type: 'text/plain;charset=utf-8'});
        const url = view.URL.createObjectURL(blob);
        const anchor = make('a'); anchor.href = url; anchor.download = 'polytrack-builder-contact-checklist.txt';
        try {root.append(anchor); anchor.click();} finally {anchor.remove(); view.URL.revokeObjectURL(url);}
      }
      if (!destroyed) {status.textContent = 'Checklist downloaded locally. Nothing was sent.';status.hidden = false;}
    } catch {
      if (!destroyed) {status.textContent = 'Download unavailable. The email backup also contains the checklist; nothing was sent.';status.hidden = false;}
    } finally {pending = false;if (!destroyed) download.disabled = false;}
  });
  actions.append(discord, email, download); panel.append(actions, make('p', 'sq-builder-privacy', 'Links open on click. Checklist downloads stay on your device.'), status);
  root.append(panel);
  return {focus() {if (!destroyed) title.focus();}, destroy() {destroyed = true;panel.remove();}};
}
