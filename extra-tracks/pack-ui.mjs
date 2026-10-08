let packMountNumber = 0;

export function mountTrackPack({ document, root, entries = [], pack = {}, onImport, onClose } = {}) {
  if (!document?.createElement || !root?.append) throw new TypeError('document and root are required');
  if (typeof onImport !== 'function') throw new TypeError('onImport is required');

  let busy = false;
  let closed = false;
  const returnFocus = document.activeElement;
  const selected = new Set(entries);
  const make = (tag, className, content) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (content !== undefined) node.textContent = content;
    return node;
  };
  const button = (label, className, action) => {
    const node = make('button', className, label);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  };
  const formatCollective = value => Array.isArray(value) ? value.join(', ') : String(value ?? '').trim();
  const formatDifficulty = value => {
    const match = typeof value === 'number' ? String(value) : String(value ?? '').trim();
    const level = /^(10|[1-9])$/.exec(match)?.[1];
    const labels = ['Beginner', 'Easy', 'Approachable', 'Intermediate', 'Challenging', 'Advanced', 'Expert', 'Very hard', 'Extreme', 'Master'];
    return level ? `${level} / 10 · ${labels[Number(level) - 1]}` : match;
  };
  const localPreviewUrl = value => {
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const base = document.baseURI || 'https://polytrack.local/';
      const url = new URL(value, base);
      return /^https?:$/.test(url.protocol) && url.origin === new URL(base).origin ? url.href : null;
    } catch { return null; }
  };

  const overlay = make('div', 'pt-pack-overlay');
  const dialog = make('section', 'pt-pack-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.tabIndex = -1;
  const title = make('h2', 'pt-pack-title', pack.name || 'Track pack');
  title.id = `pt-pack-title-${++packMountNumber}`;
  dialog.setAttribute('aria-labelledby', title.id);

  const header = make('header', 'pt-pack-header');
  const heading = make('div', 'pt-pack-heading');
  heading.append(title, make('p', 'pt-pack-subtitle', `${entries.length} tracks in this pack`));
  const closeButton = button('Close', 'pt-pack-close', close);
  header.append(heading, closeButton);

  const collective = make('section', 'pt-pack-collective');
  collective.setAttribute('aria-label', 'Shared pack information');
  const collectiveItems = [
    ['Pack authors', pack.authors],
    ['Pack tags', pack.tags],
    ['Pack difficulty', formatDifficulty(pack.difficulty)]
  ];
  for (const [label, value] of collectiveItems) {
    const formatted = formatCollective(value);
    if (!formatted) continue;
    const item = make('p', 'pt-pack-collective-item');
    const name = make('strong', '', `${label}: `);
    item.append(name, make('span', '', formatted));
    collective.append(item);
  }
  const description = typeof pack.description === 'string' ? pack.description.trim() : '';
  if (description) {
    const conciseDescription = description.length > 180 ? `${description.slice(0, 177).trimEnd()}…` : description;
    const item = make('p', 'pt-pack-collective-item');
    item.append(make('strong', '', 'About this pack: '), make('span', '', conciseDescription));
    collective.append(item);
  }

  const toolbar = make('div', 'pt-pack-toolbar');
  const selectionTools = make('div', 'pt-pack-selection-tools');
  const selectAllButton = button('Select all', 'pt-pack-secondary', () => setSelection(true));
  const selectNoneButton = button('Select none', 'pt-pack-secondary', () => setSelection(false));
  selectionTools.append(selectAllButton, selectNoneButton);
  const count = make('p', 'pt-pack-count');
  count.setAttribute('aria-live', 'polite');
  const importButton = button('Import 0 selected', 'pt-pack-import', importSelected);
  toolbar.append(selectionTools, count, importButton);

  const status = make('p', 'pt-pack-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;
  const grid = make('div', 'pt-pack-grid');
  grid.setAttribute('aria-label', 'Tracks in the pack');

  const cards = entries.map((entry, index) => {
    const card = make('article', 'pt-pack-card');
    const preview = make('div', 'pt-pack-preview');
    preview.setAttribute('aria-hidden', 'true');
    const thumbnailUrl = localPreviewUrl(entry.thumbnailUrl);
    if (thumbnailUrl) {
      const image = make('img', 'pt-pack-thumbnail');
      image.src = thumbnailUrl;
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      preview.append(image);
    } else {
      preview.append(make('span', 'pt-pack-no-preview', 'Preview unavailable'));
    }
    const details = make('div', 'pt-pack-card-details');
    const name = make('h3', 'pt-pack-track-name', entry.name || `Track ${index + 1}`);
    const author = entry.codeAuthor || entry.author;
    if (author) details.append(make('p', 'pt-pack-track-author', `By ${author}`));
    const label = make('label', 'pt-pack-check-label');
    const checkbox = make('input', 'pt-pack-checkbox');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.value = String(index);
    checkbox.setAttribute('aria-label', `Import ${entry.name || `Track ${index + 1}`}`);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) selected.add(entry);
      else selected.delete(entry);
      updateCount();
    });
    label.append(checkbox, make('span', '', 'Include in import'));
    details.append(name, label);
    card.append(preview, details);
    grid.append(card);
    return { checkbox, entry };
  });

  function updateCount() {
    count.textContent = `${selected.size} of ${entries.length} selected`;
    importButton.textContent = entries.length > 0 && selected.size === entries.length
      ? `Import all ${entries.length}`
      : `Import ${selected.size} selected`;
    importButton.disabled = busy || selected.size === 0;
  }

  function setSelection(include) {
    if (busy || closed) return;
    selected.clear();
    for (const { entry, checkbox } of cards) {
      checkbox.checked = include;
      if (include) selected.add(entry);
    }
    status.hidden = true;
    updateCount();
  }

  function setBusy(value) {
    busy = value;
    dialog.setAttribute('aria-busy', String(value));
    closeButton.disabled = value;
    selectAllButton.disabled = value;
    selectNoneButton.disabled = value;
    for (const { checkbox } of cards) checkbox.disabled = value;
    importButton.disabled = value || selected.size === 0;
  }

  async function importSelected() {
    if (busy || closed || selected.size === 0) return;
    const batch = entries.filter(entry => selected.has(entry));
    const failures = [];
    let successes = 0;
    setBusy(true);
    status.hidden = false;
    try {
      for (let index = 0; index < batch.length; index++) {
        const entry = batch[index];
        status.textContent = `Importing ${index + 1} of ${batch.length}: ${entry.name || 'Track'}…`;
        try {
          await onImport(entry);
          successes++;
        } catch (error) {
          failures.push({ name: entry.name || `Track ${index + 1}`, error });
        }
      }
      const failedNames = failures.map(item => item.name).join(', ');
      status.textContent = failures.length
        ? `Imported ${successes} of ${batch.length}. Failed: ${failedNames}. You can retry by importing the selected tracks again.`
        : `Successfully imported ${successes} ${successes === 1 ? 'track' : 'tracks'}.`;
      status.className = failures.length ? 'pt-pack-status pt-pack-status-error' : 'pt-pack-status pt-pack-status-success';
    } finally {
      setBusy(false);
    }
  }

  function onKeydown(event) {
    if (closed) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      if (!busy) close();
      return;
    }
    if (event.key === 'Tab') {
      const focusable = [...(dialog.querySelectorAll?.('button, input, [href], [tabindex]') || [])]
        .filter(node => !node.disabled && !node.hidden && node.tabIndex !== -1);
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus?.();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  function onFocusin(event) {
    if (!closed && !dialog.contains(event.target)) (busy ? dialog : closeButton).focus?.();
  }

  function close() {
    if (closed || busy) return;
    closed = true;
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('focusin', onFocusin);
    overlay.remove();
    if (typeof onClose === 'function') onClose();
    if (returnFocus?.isConnected !== false) returnFocus?.focus?.();
  }

  updateCount();
  dialog.append(header, collective, toolbar, status, grid);
  overlay.append(dialog);
  root.append(overlay);
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('focusin', onFocusin);
  closeButton.focus?.();

  return { close };
}
