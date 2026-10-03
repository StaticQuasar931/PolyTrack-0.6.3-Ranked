const SUBMIT_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSel-vg-VwzQuA2dRTEPoKiLIUgDvJ4bCvjMI8u4hqB33gkvrQ/viewform';
const PAGE_SIZE = 12;
const SUBMISSION_PENDING_MESSAGE = 'A previous track submission is still processing.';
const REPORT_PENDING_MESSAGE = 'A previous report is still processing.';
const ACTION_PENDING_MESSAGE = 'Another request is still processing. Please wait before sending.';
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

function forumActivity(entry) {
  const likes = Number.isSafeInteger(entry.sourceUpvotes) && entry.sourceUpvotes >= 0 ? entry.sourceUpvotes : null;
  const dislikes = Number.isSafeInteger(entry.sourceDownvotes) && entry.sourceDownvotes >= 0 ? entry.sourceDownvotes : null;
  const replies = Number.isSafeInteger(entry.sourceReplies) && entry.sourceReplies >= 0 ? entry.sourceReplies : null;
  return likes === null && replies === null ? null : Math.max(0, (likes || 0) - (dislikes || 0)) * 2 + (replies || 0);
}

function searchWords(value) {
  return new Set(value.match(/[\p{L}\p{N}]+/gu) || []);
}

function searchRelevance(record, query, tokens) {
  if (record.searchName === query) return 0;
  if (record.searchName.startsWith(query)) return 1;
  if (tokens.length && tokens.every(token => record.searchNameWords.has(token))) return 2;
  if (tokens.length && tokens.every(token => record.searchableWords.has(token))) return 3;
  return 4;
}

export function mountExtraTracks({ document, root, entries = [], onPlay, onSave, getPersonalBest, isLoaded, getLocalRating, getFeedback, onFeedback, onExportFeedback, onSubmit, onReport } = {}) {
  if (!document?.createElement || !root?.append) throw new TypeError('document and root are required');
  let destroyed = false;
  let opened = false;
  let returnFocus = null;
  let submissionReturnFocus = null;
  let reportReturnFocus = null;
  let page = 1;
  let pendingAction = false;
  let submissionGeneration = 0;
  let reportGeneration = 0;
  let submissionRequest = null;
  let reportRequest = null;
  let cachedRecords = null;
  let sortedRecordsCache = null;
  let expandedCardMenu = null;
  let expandedCardTrigger = null;
  let cardMenuNumber = 0;
  let cardMenuPositionFrame = null;
  const state = { search: '', source: '', tags: [], difficulty: '', curated: false, favorites: false, completion: 'all', sort: 'recommended' };
  const nameCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });
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
  const cardMenuLayer = make('div', 'sq-extra-card-menu-layer');
  cardMenuLayer.setAttribute('aria-live', 'off');
  overlay.append(cardMenuLayer);
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
  header.append(titleGroup);
  if (typeof onExportFeedback === 'function') header.append(button('Export my picks', 'sq-extra-export', async () => {
    try { await onExportFeedback(); showStatus('Your track picks and saved progress were exported.'); }
    catch { showStatus('The export could not be downloaded on this device.', true); }
  }));
  header.append(closeButton);
  dialog.append(header);
  const invitation = make('p', 'sq-extra-invite', 'Made a track? Direct submissions get priority review for this collection. Inclusion and featured placement are not guaranteed.');
  const inviteRow = make('div', 'sq-extra-invite-row');
  const submit = button('Submit a track', 'sq-extra-submit', () => {
    submissionReturnFocus = document.activeElement;
    submissionGeneration++;
    submissionModal.hidden = false;
    showStatus(submissionRequest ? SUBMISSION_PENDING_MESSAGE : pendingAction ? ACTION_PENDING_MESSAGE : '');
    syncSendControls();
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
  const selectedTags = make('div', 'sq-extra-selected-tags');
  selectedTags.setAttribute('aria-label', 'Selected styles');
  tagField.label.append(selectedTags);
  const difficultyField = selectField('Difficulty', [['', 'Any level'], ...DIFFICULTY_LABELS.slice(1).map((label, index) => [String(index + 1), label])]);
  const completionField = selectField('Progress', [['all', 'All tracks'], ['completed', 'Completed'], ['uncompleted', 'Not completed'], ['loaded', 'Imported, not completed']]);
  const sortChoices = [['recommended', 'Recommended'], ['name', 'Name A-Z'], ['author', 'Author A-Z']];
  if (Array.isArray(entries) && entries.some(entry => Number.isSafeInteger(entry?.sizeBytes) && entry.sizeBytes >= 0)) sortChoices.push(['size-largest', 'Largest track'], ['size-smallest', 'Smallest track']);
  if (Array.isArray(entries) && entries.some(entry => Number.isSafeInteger(entry?.sourceCopies) && entry.sourceCopies >= 0 || Number.isSafeInteger(entry?.sourcePlays) && entry.sourcePlays >= 0)) sortChoices.push(['plays', 'Most plays']);
  if (Array.isArray(entries) && entries.some(entry => forumActivity(entry) !== null)) sortChoices.push(['forum', 'Forum activity']);
  if (typeof getLocalRating === 'function') sortChoices.push(['my-rating', 'My ratings']);
  if (Array.isArray(entries) && entries.some(entry => Number.isFinite(Date.parse(entry?.submittedAt || entry?.codeModifiedAt)))) sortChoices.push(['date-newest', 'Newest Track'], ['date-oldest', 'Oldest Track']);
  const sortField = selectField('Sort', sortChoices);
  const curatedLabel = make('label', 'sq-extra-check');
  const curated = make('input');
  curated.type = 'checkbox';
  curatedLabel.append(curated, make('span', '', 'Curated only'));
  const favoritesLabel = make('label', 'sq-extra-check');
  const favorites = make('input'); favorites.type = 'checkbox';
  favoritesLabel.append(favorites, make('span', '', 'My favorites'));
  controls.append(searchLabel, sourceField.label, tagField.label, difficultyField.label, completionField.label, sortField.label, curatedLabel, favoritesLabel);
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
  const submissionClose = button('Close', 'sq-extra-submission-close', closeSubmission);
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
  submissionModal.addEventListener('click', event => { if (event.target === submissionModal) closeSubmission(); });
  overlay.append(submissionModal);
  const reportModal = make('div', 'sq-extra-report-modal');
  reportModal.hidden = true;
  reportModal.setAttribute('role', 'dialog');
  reportModal.setAttribute('aria-modal', 'true');
  reportModal.setAttribute('aria-label', 'Report a track');
  const reportForm = make('form', 'sq-extra-report');
  const reportTitle = make('h3', '', 'Report this track');
  const reportClose = button('Close', 'sq-extra-submission-close', closeReport);
  const reportEntry = make('p', 'sq-extra-report-entry');
  const reportChoices = make('div', 'sq-extra-report-choices');
  const reportReasons = [
    ['inappropriate', 'Inappropriate'],
    ['broken', 'Broken or unplayable'],
    ['incorrect_credit', 'Incorrect credit']
  ];
  for (const [value, label] of reportReasons) {
    const choice = make('label', 'sq-extra-report-choice');
    const input = make('input'); input.type = 'radio'; input.name = `sq-extra-report-reason-${mountNumber}`; input.value = value;
    choice.append(input, make('span', '', label)); reportChoices.append(choice);
  }
  const reportStatus = make('p', 'sq-extra-report-status');
  reportStatus.setAttribute('role', 'status'); reportStatus.setAttribute('aria-live', 'polite'); reportStatus.hidden = true;
  let reportingEntry = null;
  reportForm.append(reportTitle, reportClose, reportEntry, reportChoices);
  const reportSend = button('Send report', 'sq-extra-report-send', () => submitReport());
  reportForm.append(reportSend, reportStatus);
  reportModal.append(reportForm); overlay.append(reportModal);
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

  function syncSendControls() {
    sendSubmission.disabled = Boolean(pendingAction || submissionRequest);
    reportSend.disabled = Boolean(pendingAction || reportRequest);
    if (!pendingAction) {
      if (!submissionModal.hidden && submissionStatus.textContent === ACTION_PENDING_MESSAGE) showStatus('');
      if (!reportModal.hidden && reportStatus.textContent === ACTION_PENDING_MESSAGE) {
        reportStatus.textContent = ''; reportStatus.hidden = true;
      }
    }
  }

  async function submitForm(event) {
    event.preventDefault();
    if (pendingAction) { showStatus(ACTION_PENDING_MESSAGE); return; }
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
    const operation = { generation: submissionGeneration };
    submissionRequest = operation;
    pendingAction = true; syncSendControls(); showStatus('Sending track for review...');
    try {
      await onSubmit(payload);
      if (destroyed || submissionModal.hidden || submissionGeneration !== operation.generation) return;
      showStatus('Track received for review. Thanks for sharing it.');
      submitCode.value = '';
      closeSubmission();
    } catch (error) {
      if (!destroyed && !submissionModal.hidden && submissionGeneration === operation.generation) {
        showStatus(`${error?.message || 'Could not send this track.'} You can use the Google Form instead.`, true);
      }
    } finally {
      pendingAction = false;
      if (submissionRequest === operation) {
        submissionRequest = null;
        syncSendControls();
        if (!destroyed && !submissionModal.hidden && submissionGeneration !== operation.generation && submissionStatus.textContent === SUBMISSION_PENDING_MESSAGE) showStatus('');
      }
    }
  }
  async function submitReport() {
    if (destroyed) return;
    if (pendingAction) {
      reportStatus.textContent = ACTION_PENDING_MESSAGE; reportStatus.className = 'sq-extra-report-status'; reportStatus.hidden = false;
      return;
    }
    const selected = [...reportChoices.children].map(choice => choice.children[0]).find(input => input.checked);
    if (!selected) { reportStatus.textContent = 'Choose one reason before sending.'; reportStatus.className = 'sq-extra-report-status sq-extra-status-error'; reportStatus.hidden = false; return; }
    if (typeof onReport !== 'function') { reportStatus.textContent = 'Reporting is unavailable right now.'; reportStatus.className = 'sq-extra-report-status sq-extra-status-error'; reportStatus.hidden = false; return; }
    const entry = reportingEntry;
    const operation = { generation: reportGeneration, entry };
    reportRequest = operation;
    pendingAction = true; syncSendControls(); reportStatus.textContent = 'Sending report...'; reportStatus.className = 'sq-extra-report-status'; reportStatus.hidden = false;
    try {
      await onReport(entry, selected.value);
      if (destroyed || reportModal.hidden || reportGeneration !== operation.generation || reportingEntry !== entry) return;
      reportStatus.textContent = 'Report received. Thanks for helping keep the catalog accurate.';
      for (const choice of reportChoices.children) choice.children[0].checked = false;
    } catch (error) {
      if (!destroyed && !reportModal.hidden && reportGeneration === operation.generation && reportingEntry === entry) {
        reportStatus.textContent = error?.publicMessage ? error.message : 'Could not send your report. Please try again later.';
        reportStatus.className = 'sq-extra-report-status sq-extra-status-error';
      }
    } finally {
      pendingAction = false;
      if (reportRequest === operation) {
        reportRequest = null;
        syncSendControls();
        if (!destroyed && !reportModal.hidden && reportGeneration !== operation.generation && reportStatus.textContent === REPORT_PENDING_MESSAGE) {
          reportStatus.textContent = ''; reportStatus.hidden = true;
        }
      }
    }
  }
  submission.addEventListener('submit', submitForm);

  async function runAction(kind, callback, entry) {
    if (pendingAction || destroyed) return;
    if (typeof callback !== 'function') {
      showStatus(`${kind === 'play' ? 'Play' : 'Save'} is unavailable.`, true);
      return;
    }
    pendingAction = true;
    syncSendControls();
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
      syncSendControls();
    }
  }

  function card(entry, best, loaded) {
    const article = make('article', 'sq-extra-card');
    if (text(entry.tier).toLowerCase() === 'curated') article.className += ' sq-extra-card-featured';
    if (entry.featuredSubmission === true) article.className += ' sq-extra-card-submitted';
    if (entry.ranked === false) article.className += ' sq-extra-card-unranked';
    const visual = make('div', 'sq-extra-visual');
    const placeholder = make('span', 'sq-extra-placeholder', text(entry.category, 'Custom track').toUpperCase());
    visual.append(placeholder);
    const imageUrl = safeUrl(document, entry.thumbnailUrl);
    if (imageUrl) {
      const image = make('img');
      image.alt = '';
      const thumbnailPath = new URL(imageUrl, document.baseURI || 'https://polytrack.local/').pathname;
      const nativeMapThumbnail = thumbnailPath.includes('/extra-tracks/thumbnails/') &&
        thumbnailPath.endsWith('.png') && entry.thumbnailKind !== 'artwork';
      image.className = nativeMapThumbnail ? 'sq-extra-thumbnail-pixel' : 'sq-extra-thumbnail-photo';
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
    if (entry.featuredSubmission === true) body.append(make('span', 'sq-extra-tier sq-extra-tier-submitted', 'New from players'));
    if (entry.ranked === false) body.append(make('span', 'sq-extra-tier sq-extra-tier-unranked', 'Unranked challenge · no RP or verification'));
    const titleRow = make('div', 'sq-extra-title-row');
    titleRow.append(make('h3', '', text(entry.name, 'Untitled track')));
    let feedback = {};
    if (typeof onFeedback === 'function') {
      try { feedback = getFeedback?.(entry) || {}; } catch { /* Device storage is optional. */ }
      const favorite = button('', 'sq-extra-favorite' + (feedback.favorite ? ' selected' : ''), () => {
        try { onFeedback(entry, { favorite: feedback.favorite !== true }); cachedRecords = null; render(); }
        catch { showStatus('Could not save your picks on this device.', true); }
      });
      favorite.setAttribute('aria-label', feedback.favorite ? 'Remove from favorites' : 'Add to favorites');
      favorite.setAttribute('aria-pressed', String(feedback.favorite === true));
      favorite.title = favorite.getAttribute('aria-label');
      const icon = make('span', 'sq-extra-favorite-icon');
      icon.setAttribute('aria-hidden', 'true');
      icon.innerHTML = '<svg viewBox="0 0 24 24" focusable="false"><path d="M12 21s-8-4.8-8-11a4.5 4.5 0 0 1 8-2.8A4.5 4.5 0 0 1 20 10c0 6.2-8 11-8 11Z"/></svg>';
      favorite.append(icon);
      titleRow.append(favorite);
    }
    body.append(titleRow);
    const creditedAuthor = text(entry.author);
    const shownAuthor = displayAuthor(entry);
    body.append(make('p', 'sq-extra-author', `By ${shownAuthor}`));
    if (creditedAuthor && shownAuthor !== creditedAuthor && creditedAuthor.toLocaleLowerCase() !== shownAuthor.toLocaleLowerCase()) {
      body.append(make('p', 'sq-extra-source-credit', `Source credit: ${creditedAuthor}`));
    }
    if (entry.codeModifiedAt && Number.isFinite(Date.parse(entry.codeModifiedAt))) {
      body.append(make('p', 'sq-extra-code-date', `Modified ${new Date(entry.codeModifiedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}`));
    }
    if (entry.submittedAt && Number.isFinite(Date.parse(entry.submittedAt))) {
      body.append(make('p', 'sq-extra-code-date', `Submitted ${new Date(entry.submittedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}`));
    }
    const tags = Array.isArray(entry.tags) ? entry.tags.filter(tag => text(tag) && !/^difficulty-/.test(tag) && !['easy', 'medium', 'hard', 'expert', 'kacky', 'throwback', 'curated'].includes(tag)) : [];
    if (tags.length) {
      const tagList = make('div', 'sq-extra-tags');
      for (const tag of tags.slice(0, 2)) tagList.append(make('span', '', text(tag).replaceAll('-', ' ')));
      body.append(tagList);
    }
    const level = difficulty(entry);
    if (level !== null) body.append(make('p', 'sq-extra-difficulty', `Difficulty ${level}/10 · ${DIFFICULTY_LABELS[level]}`));
    if(entry.ranked===false)body.append(make('p','sq-extra-large-warning','Very large track. May run slowly on school devices. Finishes appear on an unranked leaderboard.'));
    const facts = make('p', 'sq-extra-facts');
    facts.append(make('span', best === null ? 'sq-extra-progress' : 'sq-extra-best', best === null ? loaded ? 'Imported, not completed' : 'Not completed' : `Best ${timeLabel(best)}`));
    const copies = Number.isSafeInteger(entry.sourceCopies) ? entry.sourceCopies : null;
    const plays = Number.isSafeInteger(entry.sourcePlays) ? entry.sourcePlays : null;
    if (copies !== null && copies >= 0) facts.append(make('span', 'sq-extra-plays', `${copies.toLocaleString()} source copies`));
    else if (plays !== null && plays >= 0) facts.append(make('span', 'sq-extra-plays', `${plays.toLocaleString()} source plays`));
    else if (forumActivity(entry) !== null) {
      const metrics = [];
      if (Number.isSafeInteger(entry.sourceUpvotes) && entry.sourceUpvotes >= 0) metrics.push(`${entry.sourceUpvotes.toLocaleString()} ${entry.sourceUpvotes === 1 ? 'like' : 'likes'}`);
      if (Number.isSafeInteger(entry.sourceReplies) && entry.sourceReplies >= 0) metrics.push(`${entry.sourceReplies.toLocaleString()} ${entry.sourceReplies === 1 ? 'reply' : 'replies'}`);
      facts.append(make('span', 'sq-extra-plays', `itch.io: ${metrics.join(' · ')}`));
    }
    if (Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes >= 0) facts.append(make('span', 'sq-extra-size', `${(entry.sizeBytes / 1000).toFixed(1)} KB code`));
    body.append(facts);
    const actions = make('div', 'sq-extra-actions');
    actions.append(button('Import and play', 'sq-extra-play', () => runAction('play', onPlay, entry)));
    const more = button('', 'sq-extra-more', () => {
      if (expandedCardMenu === moreMenu) { clearCardMenu(); return; }
      if (expandedCardMenu) clearCardMenu();
      cardMenuLayer.append(moreMenu);
      moreMenu.hidden = false;
      more.setAttribute('aria-expanded', 'true');
      expandedCardMenu = moreMenu;
      expandedCardTrigger = more;
      positionCardMenu();
      focusCardMenu();
    });
    more.setAttribute('aria-label', `More actions for ${text(entry.name, 'this track')}`);
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-haspopup', 'dialog');
    const moreIcon = make('span', 'sq-extra-more-icon');
    moreIcon.setAttribute('aria-hidden', 'true');
    moreIcon.innerHTML = '<svg viewBox="0 0 24 24" focusable="false"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
    more.append(moreIcon);
    const moreMenu = make('div', 'sq-extra-more-menu');
    moreMenu.id = `sq-extra-card-menu-${mountNumber}-${++cardMenuNumber}`;
    more.setAttribute('aria-controls', moreMenu.id);
    moreMenu.hidden = true;
    moreMenu.setAttribute('role', 'dialog');
    moreMenu.setAttribute('aria-label', `Track preferences for ${text(entry.name, 'this track')}`);
    if (typeof onFeedback === 'function') {
      const toggle = (field, value) => {
        try { onFeedback(entry, { [field]: feedback[field] === value ? 0 : value }); clearCardMenu(); cachedRecords = null; render(); }
        catch { showStatus('Could not save your picks on this device.', true); }
      };
      const picks = make('div', 'sq-extra-picks');
      const up = button('Helpful', 'sq-extra-pick' + (feedback.vote === 1 ? ' selected' : ''), () => toggle('vote', 1));
      const down = button('Not for me', 'sq-extra-pick' + (feedback.vote === -1 ? ' selected' : ''), () => toggle('vote', -1));
      up.setAttribute('aria-pressed', String(feedback.vote === 1)); down.setAttribute('aria-pressed', String(feedback.vote === -1));
      const ratingLabel = make('label', 'sq-extra-rating', 'My rating');
      const rating = make('select');
      rating.setAttribute('aria-label', `My rating for ${text(entry.name, 'this track')}`);
      for (let n = 0; n <= 10; n++) { const option = make('option', '', n ? `${n}/10` : 'Not rated'); option.value = String(n); rating.append(option); }
      rating.value = String(Number(feedback.rating) || 0);
      rating.addEventListener('change', () => { try { onFeedback(entry, { rating: Number(rating.value) }); clearCardMenu(); cachedRecords = null; render(); } catch { showStatus('Could not save your rating on this device.', true); } });
      ratingLabel.append(rating); picks.append(up, down, ratingLabel); moreMenu.append(picks);
    }
    moreMenu.append(button('Report track', 'sq-extra-report-button', () => {
      clearCardMenu();
      moreMenu.hidden = true; more.setAttribute('aria-expanded', 'false');
      reportReturnFocus = more;
      reportGeneration++;
      reportingEntry = entry; reportEntry.textContent = text(entry.name, 'Untitled track');
      reportStatus.textContent = reportRequest ? REPORT_PENDING_MESSAGE : pendingAction ? ACTION_PENDING_MESSAGE : '';
      reportStatus.hidden = !reportRequest && !pendingAction;
      reportStatus.className = 'sq-extra-report-status';
      syncSendControls();
      for (const choice of reportChoices.children) choice.children[0].checked = false;
      reportModal.hidden = false;
      reportClose.focus();
    }));
    actions.append(more);
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
    options(tagField.select, tags, 'Add a style', '', tagCounts);
    options(difficultyField.select, DIFFICULTY_LABELS.slice(1).map((_, index) => String(index + 1)), 'Any level', state.difficulty, difficultyCounts);
    // The native select stays keyboard-accessible; the count is visually aligned at its right edge.
    for (const option of difficultyField.select.children) if (option.value) option.textContent = `${option.value} · ${DIFFICULTY_LABELS[Number(option.value)]} (${difficultyCounts.get(option.value) || 0})`;
    filterCount(sourceField, state.source ? sourceCounts.get(state.source) || 0 : all.length);
    filterCount(tagField, state.tags.length ? all.filter(entry => state.tags.every(tag => entry.tags?.includes(tag))).length : all.length);
    filterCount(difficultyField, state.difficulty ? difficultyCounts.get(state.difficulty) || 0 : all.length);
    for (const [field, value, fallback] of [[sourceField, state.source, 'All sources'], [difficultyField, state.difficulty, 'Any level']]) {
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
    selectedTags.replaceChildren();
    for (const tag of state.tags) {
      const remove = button(`${tag.replaceAll('-', ' ')} x`, 'sq-extra-selected-tag', () => {
        state.tags = state.tags.filter(value => value !== tag); page = 1; render();
      });
      remove.setAttribute('aria-label', `Remove ${tag.replaceAll('-', ' ')} style`);
      selectedTags.append(remove);
    }
    const query = state.search.toLowerCase();
    const queryTokens = [...searchWords(query)];
    if (!cachedRecords) cachedRecords = all.map(entry => {
      let best = null, loaded = false, rating = null, favorite = false;
      try { best = personalBest(typeof getPersonalBest === 'function' ? getPersonalBest(entry) : null); } catch { /* A missing PB must not break the catalog. */ }
      try { loaded = typeof isLoaded === 'function' && Boolean(isLoaded(entry)); } catch { /* Local imports are optional. */ }
      try { rating = typeof getLocalRating === 'function' ? Number(getLocalRating(entry)) : null; } catch { /* Local ratings are optional. */ }
      try { favorite = getFeedback?.(entry)?.favorite === true; } catch { /* Device storage is optional. */ }
      const searchName = text(entry.name, 'Untitled track').toLowerCase();
      const searchable = [entry.name, entry.author, entry.codeName, entry.codeAuthor, entry.source, entry.description, ...(Array.isArray(entry.tags) ? entry.tags : [])]
        .map(value => text(value).toLowerCase()).join(' ');
      return {
        entry, best, loaded, favorite,
        rating: Number.isFinite(rating) && rating >= 1 && rating <= 10 ? rating : null,
        searchName, searchNameWords: searchWords(searchName), searchable, searchableWords: searchWords(searchable)
      };
    });
    const compare = (a, b) => nameCollator.compare(text(a), text(b));
    if (!sortedRecordsCache || sortedRecordsCache.records !== cachedRecords || sortedRecordsCache.sort !== state.sort) {
      const ordered = [...cachedRecords];
      ordered.sort((a, b) => {
        if (state.sort === 'plays') return (Number.isSafeInteger(b.entry.sourceCopies) ? b.entry.sourceCopies : Number.isSafeInteger(b.entry.sourcePlays) ? b.entry.sourcePlays : -1) -
          (Number.isSafeInteger(a.entry.sourceCopies) ? a.entry.sourceCopies : Number.isSafeInteger(a.entry.sourcePlays) ? a.entry.sourcePlays : -1) || compare(a.entry.name, b.entry.name);
        if (state.sort === 'forum') return (forumActivity(b.entry) ?? -1) - (forumActivity(a.entry) ?? -1) || compare(a.entry.name, b.entry.name);
        if (state.sort === 'my-rating') return (b.rating ?? -1) - (a.rating ?? -1) || compare(a.entry.name, b.entry.name);
        if (state.sort === 'size-largest' || state.sort === 'size-smallest') {
          const aSize = Number.isSafeInteger(a.entry.sizeBytes) && a.entry.sizeBytes >= 0 ? a.entry.sizeBytes : null;
          const bSize = Number.isSafeInteger(b.entry.sizeBytes) && b.entry.sizeBytes >= 0 ? b.entry.sizeBytes : null;
          if (aSize === null || bSize === null) return aSize === bSize ? compare(a.entry.name, b.entry.name) : aSize === null ? 1 : -1;
          return (state.sort === 'size-largest' ? bSize - aSize : aSize - bSize) || compare(a.entry.name, b.entry.name);
        }
        if (state.sort === 'date-newest' || state.sort === 'date-oldest') {
          const aDate = Date.parse(a.entry.submittedAt || a.entry.codeModifiedAt), bDate = Date.parse(b.entry.submittedAt || b.entry.codeModifiedAt);
          if (!Number.isFinite(aDate) || !Number.isFinite(bDate)) return Number.isFinite(aDate) ? -1 : Number.isFinite(bDate) ? 1 : compare(a.entry.name, b.entry.name);
          return (state.sort === 'date-newest' ? bDate - aDate : aDate - bDate) || compare(a.entry.name, b.entry.name);
        }
        if (state.sort === 'author') return compare(displayAuthor(a.entry), displayAuthor(b.entry)) || compare(a.entry.name, b.entry.name);
        if (state.sort === 'recommended') return Number(b.entry.featuredSubmission === true) - Number(a.entry.featuredSubmission === true) || Number(text(b.entry.tier).toLowerCase() === 'curated') - Number(text(a.entry.tier).toLowerCase() === 'curated') || compare(a.entry.name, b.entry.name);
        return compare(a.entry.name, b.entry.name);
      });
      sortedRecordsCache = { records: cachedRecords, sort: state.sort, ordered };
    }
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
    let records = sortedRecordsCache.ordered.filter(({ entry, best, loaded, favorite, searchable, searchableWords }) => {
      const entryTags = Array.isArray(entry.tags) ? entry.tags.map(tag => text(tag)) : [];
      const matchesSearch = !query || searchable.includes(query) || queryTokens.length > 0 && queryTokens.every(token => searchableWords.has(token));
      // A curator can mark a track by tier or by the curated tag.
      const isCurated = text(entry.tier).toLocaleLowerCase() === 'curated' || entryTags.some(tag => tag.toLocaleLowerCase() === 'curated');
      return matchesSearch && (!state.source || entry.source === state.source) && (!state.favorites || favorite) &&
        state.tags.every(tag => entryTags.includes(tag)) && (!state.curated || isCurated) &&
        (!state.difficulty || difficulty(entry) === Number(state.difficulty)) &&
        (state.completion === 'all' || state.completion === 'completed' && best !== null ||
          state.completion === 'uncompleted' && best === null || state.completion === 'loaded' && loaded && best === null);
    });
    if (query) {
      records = records.map((record, index) => ({ record, index, relevance: searchRelevance(record, query, queryTokens) }))
        .sort((a, b) => a.relevance - b.relevance || a.index - b.index)
        .map(({ record }) => record);
    }
    const pages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
    page = Math.min(page, pages);
    count.textContent = `${records.length} of ${all.length} tracks`;
    list.replaceChildren();
    const visible = records.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    if (!visible.length) {
      const empty = make('div', 'sq-extra-empty', all.length ? 'No tracks match these filters.' : 'No extra tracks are available yet.');
      if (all.length) empty.append(button('Clear filters', 'sq-extra-clear', clearFilters));
      list.append(empty);
    }
    for (const { entry, best, loaded } of visible) list.append(card(entry, best, loaded));
    pagination.replaceChildren();
    const previous = button('Previous', '', () => { page--; render(); });
    previous.disabled = page <= 1;
    const next = button('Next', '', () => { page++; render(); });
    next.disabled = page >= pages;
    pagination.append(previous, make('span', '', `Page ${page} of ${pages}`), next);
  }

  function clearFilters() {
    Object.assign(state, { search: '', source: '', tags: [], difficulty: '', curated: false, favorites: false, completion: 'all', sort: 'recommended' });
    search.value = ''; sourceField.select.value = ''; difficultyField.select.value = '';
    completionField.select.value = 'all'; sortField.select.value = 'recommended'; curated.checked = false; favorites.checked = false;
    page = 1; render();
  }

  function close() {
    if (!opened || destroyed) return;
    opened = false;
    clearCardMenu();
    overlay.hidden = true;
    closeSubmission(false);
    closeReport(false);
    if (returnFocus?.focus) returnFocus.focus();
  }

  function closeSubmission(restoreFocus = true) {
    if (submissionModal.hidden) return;
    submissionGeneration++;
    submissionModal.hidden = true;
    if (restoreFocus) (submissionReturnFocus?.isConnected !== false ? submissionReturnFocus : submit)?.focus();
    submissionReturnFocus = null;
  }

  function closeReport(restoreFocus = true) {
    if (reportModal.hidden) return;
    reportGeneration++;
    reportModal.hidden = true;
    reportingEntry = null;
    if (restoreFocus) (reportReturnFocus?.isConnected !== false ? reportReturnFocus : search)?.focus();
    reportReturnFocus = null;
  }

  function open() {
    if (destroyed || opened) return;
    returnFocus = document.activeElement;
    opened = true;
    cachedRecords = null;
    submissionModal.hidden = true;
    reportModal.hidden = true;
    overlay.hidden = false;
    showStatus('');
    render();
    search.focus();
  }

  function onKeydown(event) {
    if (!opened) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (expandedCardMenu) clearCardMenu(true);
      else if (!reportModal.hidden) closeReport();
      else if (!submissionModal.hidden) closeSubmission();
      else close();
      return;
    }
    if (event.key === 'Tab' && expandedCardMenu) {
      const menuFocusables = [...expandedCardMenu.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href]')];
      const first = menuFocusables[0], last = menuFocusables.at(-1);
      if (document.activeElement === expandedCardTrigger && !event.shiftKey && first) {
        event.preventDefault(); first.focus(); return;
      }
      if (document.activeElement === first && event.shiftKey) {
        event.preventDefault(); expandedCardTrigger?.focus(); return;
      }
      if (document.activeElement === last && !event.shiftKey) {
        const pageFocusables = [...dialog.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href]')];
        const triggerIndex = pageFocusables.indexOf(expandedCardTrigger);
        clearCardMenu();
        event.preventDefault();
        (pageFocusables[triggerIndex + 1] || pageFocusables[0])?.focus();
        return;
      }
    }
    if ((!submissionModal.hidden || !reportModal.hidden) && event.key !== 'Tab') return;
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
    const focusRoot = !reportModal.hidden ? reportModal : !submissionModal.hidden ? submissionModal : dialog;
    const focusable = [...focusRoot.querySelectorAll('button:not([disabled]),input,textarea,select,a[href]')].filter(node => {
      for (let current = node; current; current = current.parentElement || current.parent) {
        if (current.hidden) return false;
        if (current === focusRoot) return true;
      }
      return false;
    });
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!focusRoot.contains(document.activeElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function positionCardMenu() {
    if (!expandedCardMenu?.getBoundingClientRect || !expandedCardTrigger?.getBoundingClientRect) return;
    const view = document.defaultView;
    const viewportWidth = view?.innerWidth || document.documentElement?.clientWidth || 0;
    const viewportHeight = view?.innerHeight || document.documentElement?.clientHeight || 0;
    if (!viewportWidth || !viewportHeight) return;
    const margin = 8;
    const trigger = expandedCardTrigger.getBoundingClientRect();
    const menu = expandedCardMenu.getBoundingClientRect();
    const left = Math.min(Math.max(margin, viewportWidth - menu.width - margin), Math.max(margin, trigger.right - menu.width));
    let top = trigger.bottom + 6;
    if (top + menu.height > viewportHeight - margin && trigger.top - menu.height - 6 >= margin) top = trigger.top - menu.height - 6;
    top = Math.min(Math.max(margin, top), Math.max(margin, viewportHeight - menu.height - margin));
    expandedCardMenu.style.left = `${Math.round(left)}px`;
    expandedCardMenu.style.top = `${Math.round(top)}px`;
  }

  function scheduleCardMenuPosition() {
    const view = document.defaultView;
    if (!expandedCardMenu || cardMenuPositionFrame !== null || !view?.requestAnimationFrame) return;
    cardMenuPositionFrame = view.requestAnimationFrame(() => {
      cardMenuPositionFrame = null;
      positionCardMenu();
    });
  }

  function focusCardMenu() {
    const focusable = expandedCardMenu?.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href]')[0];
    focusable?.focus({preventScroll: true});
  }

  function clearCardMenu(restoreFocus = false) {
    if (!expandedCardMenu) return;
    const menu = expandedCardMenu;
    const view = document.defaultView;
    if (cardMenuPositionFrame !== null) view?.cancelAnimationFrame?.(cardMenuPositionFrame);
    cardMenuPositionFrame = null;
    menu.hidden = true;
    menu.remove();
    expandedCardTrigger?.setAttribute('aria-expanded', 'false');
    const trigger = expandedCardTrigger;
    expandedCardMenu = null;
    expandedCardTrigger = null;
    if (restoreFocus && trigger?.isConnected) trigger.focus();
  }

  function onCardMenuOutside(event) {
    if (expandedCardMenu && !expandedCardMenu.contains(event.target) && !expandedCardTrigger?.contains(event.target)) clearCardMenu();
  }

  search.addEventListener('input', () => { state.search = search.value.trim(); page = 1; render(); });
  sourceField.select.addEventListener('change', () => { state.source = sourceField.select.value; page = 1; render(); });
  tagField.select.addEventListener('change', () => {
    const value = tagField.select.value;
    if (value && !state.tags.includes(value)) state.tags.push(value);
    tagField.select.value = ''; page = 1; render();
  });
  difficultyField.select.addEventListener('change', () => { state.difficulty = difficultyField.select.value; page = 1; render(); });
  completionField.select.addEventListener('change', () => { state.completion = completionField.select.value; page = 1; render(); });
  sortField.select.addEventListener('change', () => { state.sort = sortField.select.value; page = 1; render(); });
  curated.addEventListener('change', () => { state.curated = curated.checked; page = 1; render(); });
  favorites.addEventListener('change', () => { state.favorites = favorites.checked; page = 1; render(); });
  document.addEventListener('keydown', onKeydown, true);
  document.addEventListener('click', onCardMenuOutside, true);
  document.addEventListener('scroll', scheduleCardMenuPosition, true);
  document.defaultView?.addEventListener('resize', scheduleCardMenuPosition);
  render();
  return {
    open, close, refresh() { cachedRecords = null; render(); },
    destroy() {
      if (destroyed) return;
      close();
      destroyed = true;
      document.removeEventListener('keydown', onKeydown, true);
      document.removeEventListener('click', onCardMenuOutside, true);
      document.removeEventListener('scroll', scheduleCardMenuPosition, true);
      document.defaultView?.removeEventListener('resize', scheduleCardMenuPosition);
      overlay.remove();
    }
  };
}
