const SUBMIT_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSel-vg-VwzQuA2dRTEPoKiLIUgDvJ4bCvjMI8u4hqB33gkvrQ/viewform';
const PAGE_SIZE = 12;
let mountNumber = 0;

function safeUrl(document, value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value, document.baseURI || 'https://polytrack.local/');
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch { return null; }
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function personalBest(value) {
  const time = typeof value === 'number' ? value : value?.timeMs;
  return Number.isFinite(time) && time > 0 ? time : null;
}

function timeLabel(ms) {
  const total = Math.floor(ms);
  const minutes = Math.floor(total / 60000);
  const seconds = String(Math.floor(total / 1000) % 60).padStart(2, '0');
  return `${minutes}:${seconds}.${String(total % 1000).padStart(3, '0')}`;
}

export function mountExtraTracks({ document, root, entries = [], onPlay, onSave, getPersonalBest } = {}) {
  if (!document?.createElement || !root?.append) throw new TypeError('document and root are required');
  let destroyed = false;
  let opened = false;
  let returnFocus = null;
  let page = 1;
  let pendingAction = false;
  const state = { search: '', source: '', tag: '', curated: false, completion: 'all', sort: 'recommended' };
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

  const overlay = make('div', 'sq-extra-overlay');
  overlay.hidden = true;
  const dialog = make('section', 'sq-extra-menu');
  const titleId = `sq-extra-title-${++mountNumber}`;
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', titleId);
  overlay.append(dialog);
  const header = make('header', 'sq-extra-header');
  const titleGroup = make('div', 'sq-extra-title-group');
  const eyebrow = make('span', 'sq-extra-eyebrow', 'POLYTRACK / COMMUNITY');
  const title = make('h2', '', 'Extra Tracks');
  title.id = titleId;
  titleGroup.append(eyebrow, title);
  const closeButton = button('Close', 'sq-extra-close', close);
  header.append(titleGroup, closeButton);
  dialog.append(header);
  const invitation = make('p', 'sq-extra-invite', 'Made a track? Direct submissions get priority review for this collection. Inclusion and featured placement are not guaranteed.');
  dialog.append(invitation);

  const controls = make('div', 'sq-extra-controls');
  const searchLabel = make('label', 'sq-extra-field', 'Search tracks');
  const search = make('input');
  search.type = 'search';
  search.placeholder = 'Name, author, source, tag';
  searchLabel.append(search);
  const selectField = (caption, choices) => {
    const label = make('label', 'sq-extra-field', caption);
    const select = make('select');
    for (const [value, name] of choices) {
      const option = make('option', '', name);
      option.value = value;
      select.append(option);
    }
    label.append(select);
    return { label, select };
  };
  const sourceField = selectField('Source', [['', 'All sources']]);
  const tagField = selectField('Tag', [['', 'All tags']]);
  const completionField = selectField('Progress', [['all', 'All tracks'], ['completed', 'Completed'], ['uncompleted', 'Uncompleted']]);
  const sortChoices = [['recommended', 'Recommended'], ['name', 'Name A-Z'], ['author', 'Author A-Z']];
  if (Array.isArray(entries) && entries.some(entry => Number.isSafeInteger(entry?.sourcePlays) && entry.sourcePlays >= 0)) sortChoices.push(['plays', 'Most played']);
  const sortField = selectField('Sort', sortChoices);
  const curatedLabel = make('label', 'sq-extra-check');
  const curated = make('input');
  curated.type = 'checkbox';
  curatedLabel.append(curated, make('span', '', 'Curated only'));
  controls.append(searchLabel, sourceField.label, tagField.label, completionField.label, sortField.label, curatedLabel);
  dialog.append(controls);

  const summary = make('div', 'sq-extra-summary');
  const count = make('p', 'sq-extra-count');
  count.setAttribute('role', 'status');
  count.setAttribute('aria-live', 'polite');
  const submit = make('a', 'sq-extra-submit', 'Submit a track');
  submit.href = SUBMIT_URL;
  submit.target = '_blank';
  submit.rel = 'noopener noreferrer';
  summary.append(count, submit);
  dialog.append(summary);
  const status = make('p', 'sq-extra-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;
  dialog.append(status);
  const list = make('div', 'sq-extra-grid');
  dialog.append(list);
  const pagination = make('nav', 'sq-extra-pagination');
  pagination.setAttribute('aria-label', 'Track pages');
  dialog.append(pagination);
  root.append(overlay);

  function currentEntries() {
    return (Array.isArray(entries) ? entries : []).filter(entry => entry && typeof entry === 'object' && text(entry.id));
  }

  function options(select, values, allLabel, selected) {
    select.replaceChildren();
    for (const value of ['', ...values]) {
      const option = make('option', '', value || allLabel);
      option.value = value;
      select.append(option);
    }
    select.value = values.includes(selected) ? selected : '';
  }

  function showStatus(message, error = false) {
    status.textContent = message;
    status.hidden = !message;
    status.className = error ? 'sq-extra-status sq-extra-status-error' : 'sq-extra-status';
  }

  async function runAction(kind, callback, entry) {
    if (pendingAction || destroyed) return;
    if (typeof callback !== 'function') {
      showStatus(`${kind === 'play' ? 'Play' : 'Save'} is unavailable.`, true);
      return;
    }
    pendingAction = true;
    showStatus(kind === 'play' ? 'Opening track...' : 'Saving track...');
    try {
      await callback(entry);
      if (destroyed) return;
      if (kind === 'play') close();
      else showStatus('Track saved.');
    } catch {
      if (!destroyed) showStatus(kind === 'play' ? 'Could not open this track. Please try again.' : 'Could not save this track. Please try again.', true);
    } finally {
      pendingAction = false;
    }
  }

  function card(entry, best) {
    const article = make('article', 'sq-extra-card');
    const visual = make('div', 'sq-extra-visual');
    const placeholder = make('span', 'sq-extra-placeholder', 'TRACK PREVIEW');
    visual.append(placeholder);
    const imageUrl = safeUrl(document, entry.thumbnailUrl);
    if (imageUrl) {
      const image = make('img');
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.addEventListener('load', () => { placeholder.hidden = true; });
      image.addEventListener('error', () => { image.remove(); placeholder.hidden = false; });
      image.src = imageUrl;
      visual.append(image);
    }
    article.append(visual);
    const body = make('div', 'sq-extra-card-body');
    const tier = text(entry.tier);
    if (tier) body.append(make('span', 'sq-extra-tier', tier));
    body.append(make('h3', '', text(entry.name, 'Untitled track')));
    if (text(entry.description)) body.append(make('p', 'sq-extra-description', text(entry.description)));
    body.append(make('p', 'sq-extra-author', `By ${text(entry.author, 'Unknown author')}`));
    const sourceLine = make('p', 'sq-extra-source');
    sourceLine.append(make('span', '', 'Source: '));
    const sourceName = text(entry.source, 'Unknown');
    const sourceUrl = safeUrl(document, entry.sourceUrl);
    if (sourceUrl) {
      const link = make('a', '', sourceName);
      link.href = sourceUrl;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      sourceLine.append(link);
    } else sourceLine.append(make('span', '', sourceName));
    body.append(sourceLine);
    const tags = Array.isArray(entry.tags) ? entry.tags.filter(tag => text(tag)) : [];
    if (tags.length) {
      const tagList = make('div', 'sq-extra-tags');
      for (const tag of tags) tagList.append(make('span', '', text(tag)));
      body.append(tagList);
    }
    const facts = make('p', 'sq-extra-facts', best === null ? 'Not completed' : `Best ${timeLabel(best)}`);
    if (Number.isSafeInteger(entry.sourcePlays) && entry.sourcePlays >= 0) facts.append(make('span', '', ` / ${entry.sourcePlays.toLocaleString()} source plays`));
    body.append(facts);
    const actions = make('div', 'sq-extra-actions');
    actions.append(button('Import and play', 'sq-extra-play', () => runAction('play', onPlay, entry)));
    body.append(actions);
    article.append(body);
    return article;
  }

  function render() {
    if (destroyed) return;
    const all = currentEntries();
    const sources = [...new Set(all.map(entry => text(entry.source)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const tags = [...new Set(all.flatMap(entry => Array.isArray(entry.tags) ? entry.tags.map(tag => text(tag)).filter(Boolean) : []))].sort((a, b) => a.localeCompare(b));
    options(sourceField.select, sources, 'All sources', state.source);
    options(tagField.select, tags, 'All tags', state.tag);
    state.source = sourceField.select.value;
    state.tag = tagField.select.value;
    const query = state.search.toLocaleLowerCase();
    const records = all.map(entry => {
      let best = null;
      try { best = personalBest(typeof getPersonalBest === 'function' ? getPersonalBest(entry) : null); } catch { /* A missing PB must not break the catalog. */ }
      return { entry, best };
    }).filter(({ entry, best }) => {
      const entryTags = Array.isArray(entry.tags) ? entry.tags.map(tag => text(tag)) : [];
      const searchable = [entry.name, entry.author, entry.source, entry.description, ...entryTags].map(value => text(value).toLocaleLowerCase()).join(' ');
      // A curator can mark a track by tier or by the curated tag.
      const isCurated = text(entry.tier).toLocaleLowerCase() === 'curated' || entryTags.some(tag => tag.toLocaleLowerCase() === 'curated');
      return (!query || searchable.includes(query)) && (!state.source || entry.source === state.source) &&
        (!state.tag || entryTags.includes(state.tag)) && (!state.curated || isCurated) &&
        (state.completion === 'all' || (state.completion === 'completed') === (best !== null));
    });
    const compare = (a, b) => text(a).localeCompare(text(b), undefined, { sensitivity: 'base', numeric: true });
    records.sort((a, b) => {
      if (state.sort === 'plays') return (Number.isSafeInteger(b.entry.sourcePlays) ? b.entry.sourcePlays : -1) - (Number.isSafeInteger(a.entry.sourcePlays) ? a.entry.sourcePlays : -1) || compare(a.entry.name, b.entry.name);
      if (state.sort === 'author') return compare(a.entry.author, b.entry.author) || compare(a.entry.name, b.entry.name);
      if (state.sort === 'recommended') return Number(text(b.entry.tier).toLowerCase() === 'curated') - Number(text(a.entry.tier).toLowerCase() === 'curated') || compare(a.entry.name, b.entry.name);
      return compare(a.entry.name, b.entry.name);
    });
    const pages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
    page = Math.min(page, pages);
    count.textContent = `${records.length} of ${all.length} tracks`;
    list.replaceChildren();
    const visible = records.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    if (!visible.length) list.append(make('p', 'sq-extra-empty', all.length ? 'No tracks match these filters.' : 'No extra tracks are available yet.'));
    for (const { entry, best } of visible) list.append(card(entry, best));
    pagination.replaceChildren();
    const previous = button('Previous', '', () => { page--; render(); });
    previous.disabled = page <= 1;
    const next = button('Next', '', () => { page++; render(); });
    next.disabled = page >= pages;
    pagination.append(previous, make('span', '', `Page ${page} of ${pages}`), next);
  }

  function close() {
    if (!opened || destroyed) return;
    opened = false;
    overlay.hidden = true;
    if (returnFocus?.focus) returnFocus.focus();
  }

  function open() {
    if (destroyed || opened) return;
    returnFocus = document.activeElement;
    opened = true;
    overlay.hidden = false;
    showStatus('');
    render();
    search.focus();
  }

  function onKeydown(event) {
    if (!opened) return;
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not([disabled]),input,select,a[href]')].filter(node => !node.hidden);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  search.addEventListener('input', () => { state.search = search.value.trim(); page = 1; render(); });
  sourceField.select.addEventListener('change', () => { state.source = sourceField.select.value; page = 1; render(); });
  tagField.select.addEventListener('change', () => { state.tag = tagField.select.value; page = 1; render(); });
  completionField.select.addEventListener('change', () => { state.completion = completionField.select.value; page = 1; render(); });
  sortField.select.addEventListener('change', () => { state.sort = sortField.select.value; page = 1; render(); });
  curated.addEventListener('change', () => { state.curated = curated.checked; page = 1; render(); });
  document.addEventListener('keydown', onKeydown);
  render();
  return {
    open, close, refresh: render,
    destroy() {
      if (destroyed) return;
      close();
      destroyed = true;
      document.removeEventListener('keydown', onKeydown);
      overlay.remove();
    }
  };
}
