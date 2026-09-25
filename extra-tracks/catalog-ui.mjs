const SUBMIT_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSel-vg-VwzQuA2dRTEPoKiLIUgDvJ4bCvjMI8u4hqB33gkvrQ/viewform';
const PAGE_SIZE = 12;
let mountNumber = 0;
const DIFFICULTY_LABELS = ['Any difficulty', 'Beginner', 'Easy', 'Approachable', 'Intermediate', 'Challenging', 'Advanced', 'Expert', 'Very hard', 'Extreme', 'Master'];

function difficulty(entry) {
  if (Number.isInteger(entry?.difficulty) && entry.difficulty >= 1 && entry.difficulty <= 10) return entry.difficulty;
  const tags = Array.isArray(entry?.tags) ? entry.tags : [];
  const numbered = tags.find(tag => /^difficulty-([1-9]|10)$/.test(tag));
  if (numbered) return Number(numbered.split('-')[1]);
  if (tags.includes('easy')) return 2;
  if (tags.includes('medium')) return 4;
  if (tags.includes('hard') || tags.includes('expert')) return 7;
  return null;
}

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

function displayAuthor(entry) {
  const embedded = text(entry.codeAuthor);
  return embedded && !/^anonymous$/i.test(embedded) ? embedded : text(entry.author, 'Unknown author');
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

export function mountExtraTracks({ document, root, entries = [], onPlay, onSave, getPersonalBest, isLoaded, getLocalRating, onSubmit } = {}) {
  if (!document?.createElement || !root?.append) throw new TypeError('document and root are required');
  let destroyed = false;
  let opened = false;
  let returnFocus = null;
  let page = 1;
  let pendingAction = false;
  let cachedRecords = null;
  const state = { search: '', source: '', tag: '', difficulty: '', curated: false, completion: 'all', sort: 'recommended' };
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
  const inviteRow = make('div', 'sq-extra-invite-row');
  const submit = button('Submit a track', 'sq-extra-submit', () => {
    submissionModal.hidden = false;
    showStatus('');
    submitName.focus();
  });
  inviteRow.append(invitation, submit);
  dialog.append(inviteRow);

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
    const count = make('span', 'sq-extra-filter-count');
    count.setAttribute('aria-hidden', 'true');
    label.append(count);
    return { label, select, count };
  };
  const sourceField = selectField('Source', [['', 'All sources']]);
  const tagField = selectField('Style', [['', 'All styles']]);
  const difficultyField = selectField('Difficulty', [['', 'Any level'], ...DIFFICULTY_LABELS.slice(1).map((label, index) => [String(index + 1), label])]);
  const completionField = selectField('Progress', [['all', 'All tracks'], ['completed', 'Completed'], ['uncompleted', 'Not completed'], ['loaded', 'Imported, not completed']]);
  const sortChoices = [['recommended', 'Recommended'], ['name', 'Name A-Z'], ['author', 'Author A-Z']];
  if (Array.isArray(entries) && entries.some(entry => Number.isSafeInteger(entry?.sizeBytes) && entry.sizeBytes >= 0)) sortChoices.push(['size-largest', 'Largest track'], ['size-smallest', 'Smallest track']);
  if (Array.isArray(entries) && entries.some(entry => Number.isSafeInteger(entry?.sourceCopies) && entry.sourceCopies >= 0 || Number.isSafeInteger(entry?.sourcePlays) && entry.sourcePlays >= 0)) sortChoices.push(['plays', 'Most plays']);
  if (typeof getLocalRating === 'function') sortChoices.push(['my-rating', 'My ratings']);
  const sortField = selectField('Sort', sortChoices);
  const curatedLabel = make('label', 'sq-extra-check');
  const curated = make('input');
  curated.type = 'checkbox';
  curatedLabel.append(curated, make('span', '', 'Curated only'));
  controls.append(searchLabel, sourceField.label, tagField.label, difficultyField.label, completionField.label, sortField.label, curatedLabel);
  dialog.append(controls);

  const summary = make('div', 'sq-extra-summary');
  const count = make('p', 'sq-extra-count');
  count.setAttribute('role', 'status');
  count.setAttribute('aria-live', 'polite');
  summary.append(count);
  dialog.append(summary);
  const submissionModal = make('div', 'sq-extra-submission-modal');
  submissionModal.hidden = true;
  submissionModal.setAttribute('role', 'dialog');
  submissionModal.setAttribute('aria-modal', 'true');
  submissionModal.setAttribute('aria-label', 'Submit an Extra Track');
  const submission = make('form', 'sq-extra-submission');
  const submissionTitle = make('h3', '', 'Share your track');
  const submissionClose = button('Close', 'sq-extra-submission-close', () => { submissionModal.hidden = true; submit.focus(); });
  const formField = (caption, tag, maxLength) => {
    const label = make('label', 'sq-extra-submission-field', caption);
    const input = make(tag);
    if (maxLength) input.maxLength = maxLength;
    label.append(input);
    submission.append(label);
    return input;
  };
  submission.append(submissionTitle, submissionClose);
  const submitName = formField('Track name', 'input', 80);
  const submitAuthor = formField('Creator name', 'input', 80);
  const submitDescription = formField('What makes this track worth playing?', 'textarea', 1000);
  const submitCode = formField('PolyTrack export code', 'textarea', 524288);
  const submitDifficulty = formField('Difficulty (1 beginner to 10 master)', 'select');
  for (let level = 1; level <= 10; level++) {
    const option = make('option', '', `${level} - ${DIFFICULTY_LABELS[level]}`);
    option.value = String(level);
    submitDifficulty.append(option);
  }
  const submitTags = formField('Style tags (optional, comma separated)', 'input', 120);
  const tagSuggestions = make('div', 'sq-extra-tag-suggestions');
  tagSuggestions.setAttribute('aria-label', 'Suggested style tags');
  submission.append(tagSuggestions);
  const submitSource = formField('Original post URL (optional)', 'input', 300);
  const permissionLabel = make('label', 'sq-extra-submission-check');
  const submitPermission = make('input'); submitPermission.type = 'checkbox';
  permissionLabel.append(submitPermission, make('span', '', 'I created this track or have permission to share its code.'));
  submission.append(permissionLabel);
  const submissionActions = make('div', 'sq-extra-submission-actions');
  const sendSubmission = button('Send for review', 'sq-extra-send', event => submitForm(event));
  const fallback = make('a', 'sq-extra-fallback', 'Use Google Form instead');
  fallback.href = SUBMIT_URL; fallback.target = '_blank'; fallback.rel = 'noopener noreferrer';
  submissionActions.append(sendSubmission, fallback);
  submission.append(submissionActions);
  submissionModal.append(submission);
  submissionModal.addEventListener('click', event => { if (event.target === submissionModal) { submissionModal.hidden = true; submit.focus(); } });
  overlay.append(submissionModal);
  const status = make('p', 'sq-extra-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  status.hidden = true;
  dialog.append(status);
  const submissionStatus = make('p', 'sq-extra-submission-status');
  submissionStatus.setAttribute('role', 'status');
  submissionStatus.setAttribute('aria-live', 'polite');
  submissionStatus.hidden = true;
  submission.append(submissionStatus);
  const list = make('div', 'sq-extra-grid');
  dialog.append(list);
  const pagination = make('nav', 'sq-extra-pagination');
  pagination.setAttribute('aria-label', 'Track pages');
  dialog.append(pagination);
  root.append(overlay);

  function currentEntries() {
    return (Array.isArray(entries) ? entries : []).filter(entry => entry && typeof entry === 'object' && text(entry.id));
  }

  function options(select, values, allLabel, selected, counts = null) {
    select.replaceChildren();
    for (const value of ['', ...values]) {
      const option = make('option', '', value ? `${value}${counts ? ` (${counts.get(value) || 0})` : ''}` : `${allLabel}${counts ? ` (${currentEntries().length})` : ''}`);
      option.value = value;
      select.append(option);
    }
    select.value = values.includes(selected) ? selected : '';
  }

  function filterCount(field, value) {
    field.count.textContent = value === null ? '' : Number(value).toLocaleString();
    field.count.hidden = value === null;
  }

  function showStatus(message, error = false) {
    status.textContent = message;
    status.hidden = !message;
    status.className = error ? 'sq-extra-status sq-extra-status-error' : 'sq-extra-status';
    submissionStatus.textContent = message;
    submissionStatus.hidden = !message || submissionModal.hidden;
    submissionStatus.className = error ? 'sq-extra-submission-status sq-extra-status-error' : 'sq-extra-submission-status';
  }

  async function submitForm(event) {
    event.preventDefault();
    if (pendingAction) return;
    const payload = {
      name: submitName.value.trim(), author: submitAuthor.value.trim(), description: submitDescription.value.trim(),
      code: submitCode.value.trim(), difficulty: Number(submitDifficulty.value || 1),
      tags: submitTags.value.split(',').map(value => value.trim()).filter(Boolean).slice(0, 6),
      sourceUrl: submitSource.value.trim(), permissionGranted: submitPermission.checked
    };
    if (!payload.name || !payload.author || !/^PolyTrack[A-Za-z0-9+/_=-]{20,}$/.test(payload.code) || !payload.permissionGranted) {
      showStatus('Add a name, creator, valid export code, and sharing permission.', true); return;
    }
    if (typeof onSubmit !== 'function') { showStatus('In-game submission is unavailable. Use the Google Form below.', true); return; }
    pendingAction = true; sendSubmission.disabled = true; showStatus('Sending track for review...');
    try {
      await onSubmit(payload);
      showStatus('Track received for review. Thanks for sharing it.');
      submissionModal.hidden = true; submitCode.value = ''; submit.focus();
    } catch (error) {
      showStatus(`${error?.message || 'Could not send this track.'} You can use the Google Form instead.`, true);
    } finally { pendingAction = false; sendSubmission.disabled = false; }
  }
  submission.addEventListener('submit', submitForm);

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

  function card(entry, best, loaded) {
    const article = make('article', 'sq-extra-card');
    if (text(entry.tier).toLowerCase() === 'curated') article.className += ' sq-extra-card-featured';
    if (entry.ranked === false) article.className += ' sq-extra-card-unranked';
    const visual = make('div', 'sq-extra-visual');
    const placeholder = make('span', 'sq-extra-placeholder', text(entry.category, 'Custom track').toUpperCase());
    visual.append(placeholder);
    const imageUrl = safeUrl(document, entry.thumbnailUrl);
    if (imageUrl) {
      const image = make('img');
      image.alt = '';
      image.loading = 'lazy';
      image.decoding = 'async';
      image.fetchPriority = 'low';
      image.addEventListener('load', () => { placeholder.hidden = true; });
      image.addEventListener('error', () => { image.remove(); placeholder.hidden = false; });
      image.src = imageUrl;
      visual.append(image);
    }
    article.append(visual);
    const body = make('div', 'sq-extra-card-body');
    const tier = text(entry.tier);
    if (tier.toLowerCase() === 'curated') body.append(make('span', 'sq-extra-tier', 'Featured'));
    if (entry.ranked === false) body.append(make('span', 'sq-extra-tier sq-extra-tier-unranked', 'Local challenge · no ranked RP'));
    body.append(make('h3', '', text(entry.name, 'Untitled track')));
    const creditedAuthor = text(entry.author);
    const shownAuthor = displayAuthor(entry);
    body.append(make('p', 'sq-extra-author', `By ${shownAuthor}`));
    if (creditedAuthor && shownAuthor !== creditedAuthor && creditedAuthor.toLocaleLowerCase() !== shownAuthor.toLocaleLowerCase()) {
      body.append(make('p', 'sq-extra-source-credit', `Source credit: ${creditedAuthor}`));
    }
    if (entry.codeModifiedAt && Number.isFinite(Date.parse(entry.codeModifiedAt))) {
      body.append(make('p', 'sq-extra-code-date', `Modified ${new Date(entry.codeModifiedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}`));
    }
    const tags = Array.isArray(entry.tags) ? entry.tags.filter(tag => text(tag) && !/^difficulty-/.test(tag) && !['easy', 'medium', 'hard', 'expert', 'kacky', 'throwback', 'curated'].includes(tag)) : [];
    if (tags.length) {
      const tagList = make('div', 'sq-extra-tags');
      for (const tag of tags.slice(0, 2)) tagList.append(make('span', '', text(tag).replaceAll('-', ' ')));
      body.append(tagList);
    }
    const level = difficulty(entry);
    if (level !== null) body.append(make('p', 'sq-extra-difficulty', `Difficulty ${level}/10 · ${DIFFICULTY_LABELS[level]}`));
    if(entry.ranked===false)body.append(make('p','sq-extra-large-warning','Very large track. May run slowly on school devices. Finishes stay on this device.'));
    const facts = make('p', 'sq-extra-facts');
    facts.append(make('span', best === null ? 'sq-extra-progress' : 'sq-extra-best', best === null ? loaded ? 'Imported, not completed' : 'Not completed' : `Best ${timeLabel(best)}`));
    const copies = Number.isSafeInteger(entry.sourceCopies) ? entry.sourceCopies : null;
    const plays = Number.isSafeInteger(entry.sourcePlays) ? entry.sourcePlays : null;
    if (copies !== null && copies >= 0) facts.append(make('span', 'sq-extra-plays', `${copies.toLocaleString()} source copies`));
    else if (plays !== null && plays >= 0) facts.append(make('span', 'sq-extra-plays', `${plays.toLocaleString()} source plays`));
    if (Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes >= 0) facts.append(make('span', 'sq-extra-size', `${(entry.sizeBytes / 1000).toFixed(1)} KB code`));
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
    const sourceCounts = new Map(), difficultyCounts = new Map();
    for (const entry of all) if (text(entry.source)) sourceCounts.set(entry.source, (sourceCounts.get(entry.source) || 0) + 1);
    for (const entry of all) { const level = difficulty(entry); if (level !== null) difficultyCounts.set(String(level), (difficultyCounts.get(String(level)) || 0) + 1); }
    const sources = [...sourceCounts.keys()].sort((a, b) => a.localeCompare(b));
    const tags = [...new Set(all.flatMap(entry => Array.isArray(entry.tags) ? entry.tags.map(tag => text(tag)).filter(tag => tag && !/^difficulty-/.test(tag) && !['easy', 'medium', 'hard', 'expert', 'kacky', 'throwback'].includes(tag)) : []))].sort((a, b) => a.localeCompare(b));
    const tagCounts = new Map();
    for (const entry of all) for (const tag of new Set(entry.tags || [])) if (tags.includes(tag)) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    options(sourceField.select, sources, 'All sources', state.source, sourceCounts);
    options(tagField.select, tags, 'All styles', state.tag, tagCounts);
    options(difficultyField.select, DIFFICULTY_LABELS.slice(1).map((_, index) => String(index + 1)), 'Any level', state.difficulty, difficultyCounts);
    // The native select stays keyboard-accessible; the count is visually aligned at its right edge.
    for (const option of difficultyField.select.children) if (option.value) option.textContent = `${option.value} · ${DIFFICULTY_LABELS[Number(option.value)]} (${difficultyCounts.get(option.value) || 0})`;
    filterCount(sourceField, state.source ? sourceCounts.get(state.source) || 0 : all.length);
    filterCount(tagField, state.tag ? tagCounts.get(state.tag) || 0 : all.length);
    filterCount(difficultyField, state.difficulty ? difficultyCounts.get(state.difficulty) || 0 : all.length);
    for (const [field, value, fallback] of [[sourceField, state.source, 'All sources'], [tagField, state.tag, 'All styles'], [difficultyField, state.difficulty, 'Any level']]) {
      const selected = [...field.select.children].find(option => option.value === value);
      if (selected) selected.textContent = value ? field === difficultyField ? `${value} · ${DIFFICULTY_LABELS[Number(value)]}` : value : fallback;
    }
    tagSuggestions.replaceChildren();
    for (const tag of [...tagCounts].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      tagSuggestions.append(button(tag[0].replaceAll('-', ' '), '', () => {
        const selected = new Set(submitTags.value.split(',').map(value => value.trim()).filter(Boolean));
        selected.add(tag[0]); submitTags.value = [...selected].slice(0, 6).join(', '); submitTags.focus();
      }));
    }
    state.source = sourceField.select.value;
    state.tag = tagField.select.value;
    const query = state.search.toLocaleLowerCase();
    if (!cachedRecords) cachedRecords = all.map(entry => {
      let best = null, loaded = false, rating = null;
      try { best = personalBest(typeof getPersonalBest === 'function' ? getPersonalBest(entry) : null); } catch { /* A missing PB must not break the catalog. */ }
      try { loaded = typeof isLoaded === 'function' && Boolean(isLoaded(entry)); } catch { /* Local imports are optional. */ }
      try { rating = typeof getLocalRating === 'function' ? Number(getLocalRating(entry)) : null; } catch { /* Local ratings are optional. */ }
      return { entry, best, loaded, rating: Number.isFinite(rating) && rating >= 1 && rating <= 10 ? rating : null };
    });
    const progressCounts = new Map([['all', cachedRecords.length], ['completed', 0], ['uncompleted', 0], ['loaded', 0]]);
    for (const record of cachedRecords) {
      progressCounts.set(record.best === null ? 'uncompleted' : 'completed', progressCounts.get(record.best === null ? 'uncompleted' : 'completed') + 1);
      if (record.loaded && record.best === null) progressCounts.set('loaded', progressCounts.get('loaded') + 1);
    }
    for (const option of completionField.select.children) {
      const name = option.value === 'all' ? 'All tracks' : option.value === 'completed' ? 'Completed' : option.value === 'loaded' ? 'Imported, not completed' : 'Not completed';
      option.textContent = `${name} (${progressCounts.get(option.value) || 0})`;
    }
    filterCount(completionField, progressCounts.get(state.completion) || 0);
    const selectedProgress = [...completionField.select.children].find(option => option.value === state.completion);
    if (selectedProgress) selectedProgress.textContent = state.completion === 'all' ? 'All tracks' : state.completion === 'completed' ? 'Completed' : state.completion === 'loaded' ? 'Imported, not completed' : 'Not completed';
    const records = cachedRecords.filter(({ entry, best, loaded }) => {
      const entryTags = Array.isArray(entry.tags) ? entry.tags.map(tag => text(tag)) : [];
      const searchable = [entry.name, entry.author, entry.codeName, entry.codeAuthor, entry.source, entry.description, ...entryTags].map(value => text(value).toLocaleLowerCase()).join(' ');
      // A curator can mark a track by tier or by the curated tag.
      const isCurated = text(entry.tier).toLocaleLowerCase() === 'curated' || entryTags.some(tag => tag.toLocaleLowerCase() === 'curated');
      return (!query || searchable.includes(query)) && (!state.source || entry.source === state.source) &&
        (!state.tag || entryTags.includes(state.tag)) && (!state.curated || isCurated) &&
        (!state.difficulty || difficulty(entry) === Number(state.difficulty)) &&
        (state.completion === 'all' || state.completion === 'completed' && best !== null ||
          state.completion === 'uncompleted' && best === null || state.completion === 'loaded' && loaded && best === null);
    });
    const compare = (a, b) => text(a).localeCompare(text(b), undefined, { sensitivity: 'base', numeric: true });
    records.sort((a, b) => {
      if (state.sort === 'plays') return (Number.isSafeInteger(b.entry.sourceCopies) ? b.entry.sourceCopies : Number.isSafeInteger(b.entry.sourcePlays) ? b.entry.sourcePlays : -1) -
        (Number.isSafeInteger(a.entry.sourceCopies) ? a.entry.sourceCopies : Number.isSafeInteger(a.entry.sourcePlays) ? a.entry.sourcePlays : -1) || compare(a.entry.name, b.entry.name);
      if (state.sort === 'my-rating') return (b.rating ?? -1) - (a.rating ?? -1) || compare(a.entry.name, b.entry.name);
      if (state.sort === 'size-largest' || state.sort === 'size-smallest') {
        const aSize = Number.isSafeInteger(a.entry.sizeBytes) && a.entry.sizeBytes >= 0 ? a.entry.sizeBytes : null;
        const bSize = Number.isSafeInteger(b.entry.sizeBytes) && b.entry.sizeBytes >= 0 ? b.entry.sizeBytes : null;
        if (aSize === null || bSize === null) return aSize === bSize ? compare(a.entry.name, b.entry.name) : aSize === null ? 1 : -1;
        return (state.sort === 'size-largest' ? bSize - aSize : aSize - bSize) || compare(a.entry.name, b.entry.name);
      }
      if (state.sort === 'author') return compare(displayAuthor(a.entry), displayAuthor(b.entry)) || compare(a.entry.name, b.entry.name);
      if (state.sort === 'recommended') return Number(text(b.entry.tier).toLowerCase() === 'curated') - Number(text(a.entry.tier).toLowerCase() === 'curated') || compare(a.entry.name, b.entry.name);
      return compare(a.entry.name, b.entry.name);
    });
    const pages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
    page = Math.min(page, pages);
    count.textContent = `${records.length} of ${all.length} tracks`;
    list.replaceChildren();
    const visible = records.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    if (!visible.length) list.append(make('p', 'sq-extra-empty', all.length ? 'No tracks match these filters.' : 'No extra tracks are available yet.'));
    for (const { entry, best, loaded } of visible) list.append(card(entry, best, loaded));
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
    submissionModal.hidden = true;
    if (returnFocus?.focus) returnFocus.focus();
  }

  function open() {
    if (destroyed || opened) return;
    returnFocus = document.activeElement;
    opened = true;
    cachedRecords = null;
    overlay.hidden = false;
    showStatus('');
    render();
    search.focus();
  }

  function onKeydown(event) {
    if (!opened) return;
    if (event.key === 'Escape') { event.preventDefault(); if (!submissionModal.hidden) { submissionModal.hidden = true; submit.focus(); } else close(); return; }
    if (!submissionModal.hidden && event.key !== 'Tab') return;
    const activeTag = document.activeElement?.tagName;
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag);
    if (!editing) {
      const digit = /^Digit([0-9])$/.exec(event.code || '');
      if (event.shiftKey && digit) {
        const requested = digit[1] === '0' ? 10 : Number(digit[1]);
        // The render path clamps against the filtered result count.
        page = requested; event.preventDefault(); render(); return;
      }
      if (['ArrowRight', 'ArrowLeft', 'a', 'A', 'd', 'D'].includes(event.key)) {
        page += ['ArrowRight', 'd', 'D'].includes(event.key) ? 1 : -1;
        page = Math.max(1, page);
        event.preventDefault(); render(); return;
      }
    }
    if (event.key !== 'Tab') return;
    const focusRoot = submissionModal.hidden ? dialog : submissionModal;
    const focusable = [...focusRoot.querySelectorAll('button:not([disabled]),input,textarea,select,a[href]')].filter(node => !node.hidden);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  search.addEventListener('input', () => { state.search = search.value.trim(); page = 1; render(); });
  sourceField.select.addEventListener('change', () => { state.source = sourceField.select.value; page = 1; render(); });
  tagField.select.addEventListener('change', () => { state.tag = tagField.select.value; page = 1; render(); });
  difficultyField.select.addEventListener('change', () => { state.difficulty = difficultyField.select.value; page = 1; render(); });
  completionField.select.addEventListener('change', () => { state.completion = completionField.select.value; page = 1; render(); });
  sortField.select.addEventListener('change', () => { state.sort = sortField.select.value; page = 1; render(); });
  curated.addEventListener('change', () => { state.curated = curated.checked; page = 1; render(); });
  document.addEventListener('keydown', onKeydown, true);
  render();
  return {
    open, close, refresh() { cachedRecords = null; render(); },
    destroy() {
      if (destroyed) return;
      close();
      destroyed = true;
      document.removeEventListener('keydown', onKeydown, true);
      overlay.remove();
    }
  };
}
