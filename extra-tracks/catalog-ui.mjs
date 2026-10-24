const { normalizeSearchText, searchMatches, searchAliases } = await import(new URL(`../tools/search-text.mjs${new URL(import.meta.url).search}`, import.meta.url));
const { reviewedSummary, effectiveReviewTags, hasTagEdits, hasLocalReview, reviewTagOptions, tagLabel, reviewExportRow, hasReviewExportData } =
  await import(new URL(`review.mjs${new URL(import.meta.url).search}`, import.meta.url));

const SUBMIT_URL = 'https://docs.google.com/forms/d/e/1FAIpQLSel-vg-VwzQuA2dRTEPoKiLIUgDvJ4bCvjMI8u4hqB33gkvrQ/viewform';
const PAGE_SIZE = 12;
const SORT_ALIASES = {
  'size-largest': ['size', 'desc'], 'size-smallest': ['size', 'asc'],
  'date-newest': ['date', 'desc'], 'date-oldest': ['date', 'asc'],
  'edited-first': ['my-reviews', 'desc'], 'unedited-first': ['my-reviews', 'asc'],
  'review-quality-high': ['review-quality', 'desc'], 'review-quality-low': ['review-quality', 'asc'],
  'review-difficulty-high': ['review-difficulty', 'desc'], 'review-difficulty-low': ['review-difficulty', 'asc'],
  'review-votes-high': ['review-votes', 'desc'], 'review-votes-low': ['review-votes', 'asc']
};
const defaultDirection = metric => ['name', 'author'].includes(metric) ? 'asc' : 'desc';
const REVIEW_SORT_DESCRIPTIONS = {
  'review-quality-high': 'Published ratings, highest first (10 to 1)',
  'review-quality-low': 'Published ratings, lowest first (1 to 10)',
  'review-difficulty-high': 'Published difficulty, hardest first (10 to 1)',
  'review-difficulty-low': 'Published difficulty, easiest first (1 to 10)',
  'review-votes-high': 'Published net votes, highest first',
  'review-votes-low': 'Published net votes, lowest first'
};
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
  let viewGeneration = 0;
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
  let filtersExpanded = false;
  const state = { search: '', source: '', tags: [], difficulty: '', curated: false, favorites: false, completion: 'all', review: 'all', sort: 'recommended', direction: 'desc', reviewedQuality: '', reviewedDifficulty: '', reviewedVote: '' };
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
  dialog.setAttribute('tabindex', '-1');
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
  if (typeof onExportFeedback === 'function') {
    let exportPending = false;
    const exportButton = button('Export my picks', 'sq-extra-export', async () => {
      if (exportPending) return;
      exportPending = true;
      exportButton.disabled = true;
      exportButton.textContent = 'Exporting...';
      exportButton.setAttribute('aria-busy', 'true');
      try {
        await onExportFeedback();
        if (!destroyed) showStatus('Your track picks and saved progress were exported.');
      } catch {
        if (!destroyed) showStatus('The export could not be downloaded on this device.', true);
      } finally {
        exportPending = false;
        exportButton.disabled = false;
        exportButton.textContent = 'Export my picks';
        exportButton.removeAttribute('aria-busy');
      }
    });
    header.append(exportButton);
  }
  header.append(closeButton);
  dialog.append(header);
  const invitation = make('p', 'sq-extra-invite', 'Share a track with the community. Direct submissions get priority review; featuring is not guaranteed.');
  const submit = button('Submit a track', 'sq-extra-submit', () => {
    submissionReturnFocus = document.activeElement;
    submissionGeneration++;
    submissionModal.hidden = false;
    syncDialogModality();
    showStatus(submissionRequest ? SUBMISSION_PENDING_MESSAGE : pendingAction ? ACTION_PENDING_MESSAGE : '');
    syncSendControls();
    submitName.focus();
  });
  closeButton.remove();
  header.append(submit, closeButton);
  const gradingHelp = make('details', 'sq-extra-grading-help');
  gradingHelp.append(make('summary', '', 'About ratings & difficulty'));
  gradingHelp.append(make('p', '', 'Rating measures track quality; Difficulty measures challenge, both out of 10. Published grades stay separate from your ratings saved on this device. Thanks to Window Cleaner for help with track gradings.'));



  const controls = make('div', 'sq-extra-controls');
  const searchLabel = make('label', 'sq-extra-field', 'Search tracks');
  const search = make('input');
  search.type = 'search';
  search.placeholder = 'Name, author, source, tag';
  searchLabel.append(search);
  const advancedToggle = button('Filters', 'sq-extra-advanced-toggle', toggleAdvancedFilters);
  const advancedControls = make('div', 'sq-extra-advanced');
  advancedControls.id = `sq-extra-advanced-${mountNumber}`;
  advancedToggle.setAttribute('aria-controls', advancedControls.id);
  const selectField = (caption, choices) => {
    const label = make('label', 'sq-extra-field', caption);
    const select = make('select');
    select.setAttribute('aria-label', caption);
    select.setAttribute('data-sq-control', caption.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''));
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
  const tagField = selectField('Tag', [['', 'All tags']]);
  const selectedTags = make('div', 'sq-extra-selected-tags');
  selectedTags.setAttribute('aria-label', 'Selected tags');
  tagField.label.append(selectedTags);
  const difficultyField = selectField('Catalog level', [['', 'Any level'], ...DIFFICULTY_LABELS.slice(1).map((label, index) => [String(index + 1), label])]);
  const progressLabels = {all: 'All tracks', activity: 'Has my activity', untouched: 'No activity yet', completed: 'Completed', uncompleted: 'Not completed', loaded: 'Imported, not completed'};
  const completionField = selectField('Progress', Object.entries(progressLabels));
  const reviewField = selectField('Review status', [['all', 'All tracks'], ['edited', 'Reviewed by me'], ['not-edited', 'Not reviewed by me'], ['published', 'Has published ratings'], ['no-published', 'No published ratings']]);
  const baseSortChoices = [['recommended', 'Recommended'], ['name', 'Name'], ['author', 'Author']];
  const sortField = selectField('Sort', baseSortChoices);
  sortField.count.remove();
  let sortCapabilityKey = '';
  const curatedLabel = make('label', 'sq-extra-check');
  const curated = make('input');
  curated.type = 'checkbox';
  curatedLabel.append(curated, make('span', '', 'Curated only'));
  const favoritesLabel = make('label', 'sq-extra-check');
  const favorites = make('input'); favorites.type = 'checkbox';
  favoritesLabel.append(favorites, make('span', '', 'My favorites'));
  searchLabel.className += ' sq-extra-search-field';
  reviewField.label.className += ' sq-extra-review-field';
  const sortControls = make('div', 'sq-extra-sort-controls');
  const sortDirection = button('', 'sq-extra-sort-direction', () => {
    if (state.sort === 'recommended') return;
    state.direction = state.direction === 'asc' ? 'desc' : 'asc';
    page = 1;
    render();
  });
  sortControls.append(sortField.label, sortDirection);
  const quickFilters = make('div', 'sq-extra-quick-filters');
  quickFilters.append(favoritesLabel, curatedLabel, button('Reset filters', 'sq-extra-clear', clearFilters));
  advancedControls.append(sourceField.label, tagField.label, difficultyField.label, completionField.label, reviewField.label);
  const reviewedControls = make('div', 'sq-extra-reviewed-controls');
  const reviewedCaption = make('span', 'sq-extra-reviewed-caption', 'Published ratings');
  const qualityField = selectField('Rating', [['', 'Any score'], ...Array.from({length: 10}, (_, i) => [String(i + 1), `At least ${i + 1}/10`])]);
  const reviewedDifficultyField = selectField('Difficulty', [['', 'Any score'], ...DIFFICULTY_LABELS.slice(1).map((label, i) => [String(i + 1), `${i + 1}/10 - ${label}`])]);
  reviewedDifficultyField.select.setAttribute('aria-description', 'Published difficulty rounded to the nearest whole level.');
  const voteField = selectField('Votes', [['', 'Any votes'], ['positive', 'Net positive'], ['negative', 'Net negative'], ['voted', 'Has votes'], ['unvoted', 'No votes']]);
  reviewedControls.append(reviewedCaption, quickFilters, qualityField.label, reviewedDifficultyField.label, voteField.label);
  advancedControls.append(reviewedControls);
  controls.append(searchLabel, sortControls, advancedToggle, advancedControls);
  dialog.append(controls);

  const summary = make('div', 'sq-extra-summary');
  const count = make('p', 'sq-extra-count');
  count.id = `sq-extra-count-${mountNumber}`;
  count.setAttribute('role', 'status');
  count.setAttribute('aria-live', 'polite');
  search.setAttribute('aria-describedby', count.id);
  summary.append(count, gradingHelp);
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
  submission.append(submissionTitle, submissionClose, invitation);
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
  const submitTags = formField('Tags (optional, comma separated)', 'input', 120);
  const tagSuggestions = make('div', 'sq-extra-tag-suggestions');
  tagSuggestions.setAttribute('aria-label', 'Suggested tags');
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
  list.id = `sq-extra-results-${mountNumber}`;
  search.setAttribute('aria-controls', list.id);
  dialog.append(list);
  const cleanerReveal = make('figure', 'sq-extra-cleaner');
  let cleanerImageCreated = false;
  cleanerReveal.hidden = true;
  cleanerReveal.append(make('figcaption', '', 'Window Cleaner - thanks for helping with track gradings!'));
  const staticReveal = make('figure', 'sq-extra-static');
  staticReveal.hidden = true;
  let staticImageCreated = false;
  const staticCaption = make('figcaption');
  staticCaption.append(make('strong', 'sq-extra-static-name', 'Static'), make('p', '', 'I build and maintain Ranked. Thanks for playing.'));
  staticReveal.append(staticCaption);
  dialog.append(cleanerReveal, staticReveal);
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
    field.count.textContent = value === null ? '' : typeof value === 'number' ? value.toLocaleString() : value;
    field.count.hidden = value === null;
  }

  function syncSortChoices(all) {
    const choices = [...baseSortChoices];
    if (all.some(entry => Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes >= 0)) choices.push(['size', 'Track size']);
    if (all.some(entry => Number.isSafeInteger(entry.sourceCopies) && entry.sourceCopies >= 0 || Number.isSafeInteger(entry.sourcePlays) && entry.sourcePlays >= 0)) choices.push(['plays', 'Plays']);
    if (all.some(entry => forumActivity(entry) !== null)) choices.push(['forum', 'Forum activity']);
    if (typeof getLocalRating === 'function') choices.push(['my-rating', 'My rating']);
    choices.push(['my-reviews', 'My reviews']);
    if (all.some(entry => reviewedSummary(entry).count)) choices.push(
      ['review-quality', 'Rating'], ['review-difficulty', 'Difficulty'], ['review-votes', 'Votes']);
    if (all.some(entry => Number.isFinite(Date.parse(entry.submittedAt || entry.codeModifiedAt)))) choices.push(['date', 'Track date']);

    const capabilityKey = choices.map(([value]) => value).join('|');
    if (capabilityKey === sortCapabilityKey) return;

    const selected = choices.some(([value]) => value === state.sort) ? state.sort : 'recommended';
    sortField.select.replaceChildren();
    for (const [value, label] of choices) {
      const option = make('option', '', label);
      option.value = value;
      sortField.select.append(option);
    }
    sortField.select.value = selected;
    if (state.sort !== selected) state.direction = defaultDirection(selected);
    state.sort = selected;
    sortCapabilityKey = capabilityKey;
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
    if (destroyed) return;
    if (pendingAction) { showStatus(ACTION_PENDING_MESSAGE); return; }
    if (typeof callback !== 'function') {
      showStatus(`${kind === 'play' ? 'Play' : 'Save'} is unavailable.`, true);
      return;
    }
    const operationGeneration = viewGeneration;
    pendingAction = true;
    syncSendControls();
    showStatus(kind === 'play' ? 'Opening track...' : 'Saving track...');
    try {
      await callback(entry, { isCurrent: () => !destroyed && opened && viewGeneration === operationGeneration });
      if (destroyed || !opened || viewGeneration !== operationGeneration) return;
      if (kind === 'play') close();
      else showStatus('Track saved.');
    } catch {
      if (!destroyed && opened && viewGeneration === operationGeneration) showStatus(kind === 'play' ? 'Could not open this track. Please try again.' : 'Could not save this track. Please try again.', true);
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
    const imageUrl = safeUrl(document, entry.thumbnailUrl);
    const categoryFallback = make('span', 'sq-extra-tier sq-extra-category', text(entry.category, 'Custom track'));
    categoryFallback.hidden = Boolean(imageUrl);
    let visual = null;
    if (imageUrl) {
      visual = make('div', 'sq-extra-visual');
      visual.setAttribute('style', 'height:clamp(76px,14vw,132px);min-height:0;max-height:none;aspect-ratio:auto');
      const placeholder = make('span', 'sq-extra-placeholder', text(entry.category, 'Custom track').toUpperCase());
      visual.append(placeholder);
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
      image.addEventListener('error', () => {
        image.remove();
        visual.remove();
        categoryFallback.hidden = false;
      });
      image.src = imageUrl;
      visual.append(image);
      article.append(visual);
    }
    const body = make('div', 'sq-extra-card-body');
    body.append(categoryFallback);
    const tier = text(entry.tier);
    if (tier.toLowerCase() === 'curated') body.append(make('span', 'sq-extra-tier', 'Featured'));
    if (entry.featuredSubmission === true) body.append(make('span', 'sq-extra-tier sq-extra-tier-submitted', 'New from players'));
    if (entry.ranked === false) body.append(make('span', 'sq-extra-tier sq-extra-tier-unranked', 'Unranked challenge · no RP or verification'));
    if(entry.packName)body.append(make('span','sq-extra-pack-label',entry.packName));
    const titleRow = make('div', 'sq-extra-title-row');
    titleRow.append(make('h3', '', text(entry.name, 'Untitled track')));
    let feedback = {};
    try { feedback = getFeedback?.(entry) || {}; } catch { /* Device feedback is optional. */ }
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
    const trackDetails = make('div', 'sq-extra-track-details');
    const creditedAuthor = text(entry.author);
    const shownAuthor = displayAuthor(entry);
    body.append(make('p', 'sq-extra-author', `By ${shownAuthor}`));
    if (creditedAuthor && shownAuthor !== creditedAuthor && creditedAuthor.toLocaleLowerCase() !== shownAuthor.toLocaleLowerCase()) {
      body.append(make('p', 'sq-extra-source-credit', `Source credit: ${creditedAuthor}`));
    }
    if (entry.codeModifiedAt && Number.isFinite(Date.parse(entry.codeModifiedAt))) {
      trackDetails.append(make('p', 'sq-extra-code-date', `Modified ${new Date(entry.codeModifiedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}`));
    }
    if (entry.submittedAt && Number.isFinite(Date.parse(entry.submittedAt))) {
      trackDetails.append(make('p', 'sq-extra-code-date', `Submitted ${new Date(entry.submittedAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' })}`));
    }
    const tags = effectiveReviewTags(entry, feedback);
    if (tags.length) {
      const tagList = make('div', 'sq-extra-tags');
      const added = new Set(feedback.addedTags || []);
      const visibleTags = [...tags.filter(tag => added.has(tag)), ...tags.filter(tag => !added.has(tag))];
      for (const tag of visibleTags.slice(0, 3)) tagList.append(make('span', '', tagLabel(tag)));
      if (visibleTags.length > 3) {
        const remaining = make('span', '', `+${visibleTags.length - 3}`);
        remaining.title = visibleTags.slice(3).map(tagLabel).join(', ');
        tagList.append(remaining);
      }
      body.append(tagList);
    }
    const reviewed = reviewedSummary(entry);
    if (reviewed.count) {
      const opinions = make('div', 'sq-extra-reviewed');
      const label = 'Published rating and difficulty';
      opinions.setAttribute('aria-label', label);
      opinions.title = label;
      const number = value => Number.isInteger(value) ? String(value) : value.toFixed(1);
      if (reviewed.quality !== null) opinions.append(make('span', 'sq-extra-reviewed-quality', `Rating ${number(reviewed.quality)}/10`));
      if (reviewed.difficulty !== null) opinions.append(make('span', 'sq-extra-reviewed-difficulty', `Difficulty ${number(reviewed.difficulty)}/10`));
      body.append(opinions);
    }
    const mine = make('p', 'sq-extra-my-review');
    const mineValues = [];
    if (Number.isInteger(feedback.rating) && feedback.rating >= 1 && feedback.rating <= 10) mineValues.push(`My rating ${feedback.rating}/10`);
    if (Number.isInteger(feedback.difficultyRating) && feedback.difficultyRating >= 1 && feedback.difficultyRating <= 10) mineValues.push(`My difficulty ${feedback.difficultyRating}/10`);
    if (feedback.vote === 1 || feedback.vote === -1) mineValues.push(feedback.vote === 1 ? 'My vote: helpful' : 'My vote: not for me');
    if (mineValues.length) { mine.textContent = mineValues.join(' · '); body.append(mine); }
    const level = difficulty(entry);
    if (!reviewed.difficultyCount && level !== null) body.append(make('p', 'sq-extra-difficulty', `Catalog level ${level}/10 · ${DIFFICULTY_LABELS[level]}`));
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
    if (Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes >= 0) trackDetails.append(make('span', 'sq-extra-size', `${(entry.sizeBytes / 1000).toFixed(1)} KB code`));
    body.append(facts);
    const actions = make('div', 'sq-extra-actions');
    actions.append(button('Import and play', 'sq-extra-play', () => runAction('play', onPlay, entry)));
    const more = button('', 'sq-extra-more', () => {
      if (expandedCardMenu?.entryId === text(entry.id)) { clearCardMenu(true); return; }
      if (expandedCardMenu) clearCardMenu();
      cardMenuLayer.append(moreMenu);
      moreMenu.hidden = false;
      more.setAttribute('aria-expanded', 'true');
      expandedCardMenu = moreMenu;
      expandedCardTrigger = more;
      moreMenu.__positioned = false;
      positionCardMenu(true);
      focusCardMenu();
    });
    more.setAttribute('aria-label', `More actions for ${text(entry.name, 'this track')}`);
    more.entryId = text(entry.id);
    more.setAttribute('aria-expanded', 'false');
    more.setAttribute('aria-haspopup', 'dialog');
    const moreIcon = make('span', 'sq-extra-more-icon');
    moreIcon.setAttribute('aria-hidden', 'true');
    moreIcon.innerHTML = '<svg viewBox="0 0 24 24" focusable="false"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
    more.append(moreIcon);
    const moreMenu = make('div', 'sq-extra-more-menu');
    moreMenu.id = `sq-extra-card-menu-${mountNumber}-${++cardMenuNumber}`;
    moreMenu.entryId = text(entry.id);
    more.setAttribute('aria-controls', moreMenu.id);
    moreMenu.hidden = true;
    moreMenu.setAttribute('role', 'dialog');
    moreMenu.setAttribute('aria-label', `Track preferences for ${text(entry.name, 'this track')}`);
    const menuHeader = make('div', 'sq-extra-review-header');
    menuHeader.append(make('strong', '', text(entry.name, 'Track review')), button('Done', 'sq-extra-review-done', () => clearCardMenu(true)));
    moreMenu.append(menuHeader);
    if (typeof onFeedback === 'function') {
      let syncTagPicker = () => {};
      const toggle = (field, value) => {
        try {
          const change = { [field]: feedback[field] === value ? 0 : value };
          onFeedback(entry, change);
          feedback = { ...feedback, ...change };
          cachedRecords = null;
          render();
          up.className = `sq-extra-pick${feedback.vote === 1 ? ' selected' : ''}`;
          down.className = `sq-extra-pick${feedback.vote === -1 ? ' selected' : ''}`;
          up.setAttribute('aria-pressed', String(feedback.vote === 1));
          down.setAttribute('aria-pressed', String(feedback.vote === -1));
        }
        catch { showStatus('Could not save your picks on this device.', true); }
      };
      const menuFavorite = button(feedback.favorite ? 'Remove from favorites' : 'Add to favorites', 'sq-extra-menu-favorite', () => {
        try {
          const favoriteValue = feedback.favorite !== true;
          onFeedback(entry, { favorite: favoriteValue });
          feedback = { ...feedback, favorite: favoriteValue };
          menuFavorite.textContent = feedback.favorite ? 'Remove from favorites' : 'Add to favorites';
          menuFavorite.setAttribute('aria-pressed', String(feedback.favorite));
          cachedRecords = null;
          render();
        } catch { showStatus('Could not save your picks on this device.', true); }
      });
      menuFavorite.setAttribute('aria-pressed', String(feedback.favorite === true));
      const picks = make('div', 'sq-extra-picks');
      const up = button('Helpful', 'sq-extra-pick' + (feedback.vote === 1 ? ' selected' : ''), () => toggle('vote', 1));
      const down = button('Not for me', 'sq-extra-pick' + (feedback.vote === -1 ? ' selected' : ''), () => toggle('vote', -1));
      for (const [control, name, flipped] of [[up, 'Helpful', false], [down, 'Not for me', true]]) {
        control.textContent = '';
        control.setAttribute('aria-label', name);
        control.title = name;
        const icon = make('span', 'sq-extra-vote-icon');
        icon.setAttribute('aria-hidden', 'true');
        icon.innerHTML = `<svg viewBox="0 0 24 24" focusable="false"${flipped ? ' style="transform:rotate(180deg)"' : ''}><path d="M7 10H3v11h4V10Zm3 11h8a2 2 0 0 0 2-1.6l1.3-7A2 2 0 0 0 19.3 10H15l.6-4.4A2.3 2.3 0 0 0 13.3 3L9 10v10a1 1 0 0 0 1 1Z"/></svg>`;
        control.append(icon);
      }
      up.setAttribute('aria-pressed', String(feedback.vote === 1)); down.setAttribute('aria-pressed', String(feedback.vote === -1));
      const ratingLabel = make('label', 'sq-extra-rating sq-extra-rating-quality', 'My rating');
      const rating = make('select');
      rating.setAttribute('aria-label', `My rating for ${text(entry.name, 'this track')}`);
      for (let n = 0; n <= 10; n++) { const option = make('option', '', n ? `${n}/10${n === 1 ? ' - Poor' : n === 10 ? ' - Excellent' : ''}` : 'Not rated'); option.value = String(n); rating.append(option); }
      rating.value = String(Number(feedback.rating) || 0);
      const saveRating = value => {
        try {
          onFeedback(entry, { rating: value });
          feedback = { ...feedback, rating: value };
          rating.value = String(value);
          cachedRecords = null;
          render();
        }
        catch { showStatus('Could not save your rating on this device.', true); }
      };
      rating.addEventListener('change', () => saveRating(Number(rating.value)));
      rating.setAttribute('data-quick-rating', 'true');
      const ratingHelp = make('span', 'sq-extra-rating-help', 'Saved on this device. Keys: 1-9; 0 = 10.');
      ratingLabel.append(rating, ratingHelp); picks.append(up, down); moreMenu.append(picks);
      const difficultyLabel = make('label', 'sq-extra-rating sq-extra-difficulty-rating sq-extra-rating-difficulty', 'My difficulty');
      const difficultyRating = make('select');
      difficultyRating.setAttribute('aria-label', `My difficulty rating for ${text(entry.name, 'this track')}`);
      difficultyRating.setAttribute('data-quick-rating', 'true');
      difficultyRating.setAttribute('data-rating-kind', 'difficulty');
      for (let n = 0; n <= 10; n++) {
        const option = make('option', '', n ? `${n}/10 - ${DIFFICULTY_LABELS[n]}` : 'Not rated');
        option.value = String(n); difficultyRating.append(option);
      }
      difficultyRating.value = String(Number(feedback.difficultyRating) || 0);
      const saveDifficulty = value => {
        try {
          onFeedback(entry, { difficultyRating: value });
          feedback = { ...feedback, difficultyRating: value };
          difficultyRating.value = String(value);
          cachedRecords = null;
          render();
        } catch { showStatus('Could not save your difficulty rating on this device.', true); }
      };
      difficultyRating.addEventListener('change', () => saveDifficulty(Number(difficultyRating.value)));
      difficultyLabel.append(difficultyRating, make('span', 'sq-extra-rating-help', 'How hard is it? 1 = Beginner; 10 = Master.'));
      const ratings = make('div', 'sq-extra-review-ratings');
      ratings.append(ratingLabel, difficultyLabel); moreMenu.append(ratings);
      moreMenu.append(menuFavorite);
      const picker = make('details', 'sq-extra-tag-picker');
      const pickerSummary = make('summary', '', 'Edit tags');
      picker.append(pickerSummary);
      picker.addEventListener('toggle', positionCardMenu);
      const pickerNote = make('p', 'sq-extra-tag-note', 'Local suggestions. These changes stay on this device.');
      picker.append(pickerNote);
      let pickerBuilt = false;
      pickerSummary.addEventListener('click', () => {
        if (pickerBuilt) return;
        pickerBuilt = true;
        const catalogTags = effectiveReviewTags(entry, {});
        const tagSearch = make('input', 'sq-extra-tag-search');
        tagSearch.type = 'search';
        tagSearch.placeholder = 'Search tags';
        tagSearch.setAttribute('aria-label', 'Search tags to add or remove');
        picker.append(tagSearch);
        const tagList = make('div', 'sq-extra-tag-options');
        const choiceButtons = [];
        const emptyTags = make('p', 'sq-extra-tag-note', 'No matching tags.');
        emptyTags.hidden = true;
        const filterTagChoices = () => {
          const query = tagSearch.value.trim().toLocaleLowerCase();
          let matches = 0;
          for (const { tag, choice } of choiceButtons) {
            choice.hidden = !tagLabel(tag).toLocaleLowerCase().includes(query);
            if (!choice.hidden) matches++;
          }
          emptyTags.hidden = matches > 0;
        };
        tagSearch.addEventListener('input', filterTagChoices);
        tagSearch.addEventListener('keydown', event => {
          if (event.key !== 'Enter' || event.isComposing) return;
          const matches = choiceButtons.filter(({ choice }) => !choice.hidden);
          if (matches.length === 1) { event.preventDefault(); matches[0].choice.click(); }
        });
        let reviewCount;
        const syncTagChoices = () => {
          const currentTags = effectiveReviewTags(entry, feedback);
          for (const { tag, choice } of choiceButtons) {
            const present = currentTags.includes(tag);
            choice.textContent = `${present ? 'Remove' : 'Add'} ${tagLabel(tag)}`;
            choice.className = `sq-extra-tag-choice${present ? ' selected' : ''}`;
            choice.setAttribute('aria-pressed', String(present));
          }
          reviewCount.textContent = `${currentTags.length} tags · ${hasTagEdits(entry, feedback) ? 'Locally edited' : 'Not edited'}`;
        };
        syncTagPicker = syncTagChoices;
        for (const tag of reviewTagOptions(currentEntries())) {
          const present = effectiveReviewTags(entry, feedback).includes(tag);
          const choice = button(`${present ? 'Remove' : 'Add'} ${tagLabel(tag)}`, `sq-extra-tag-choice${present ? ' selected' : ''}`, () => {
            try {
              const addedTags = [...new Set(feedback.addedTags || [])];
              const removedTags = [...new Set(feedback.removedTags || [])];
              const currentlyPresent = effectiveReviewTags(entry, feedback).includes(tag);
              if (currentlyPresent) {
                const addedIndex = addedTags.indexOf(tag);
                if (addedIndex !== -1) addedTags.splice(addedIndex, 1);
                if (catalogTags.includes(tag)) {
                  if (!removedTags.includes(tag)) removedTags.push(tag);
                }
              } else if (catalogTags.includes(tag)) {
                const index = removedTags.indexOf(tag);
                if (index !== -1) removedTags.splice(index, 1);
              } else if (!addedTags.includes(tag)) addedTags.push(tag);
              const editedAt = Date.now();
              onFeedback(entry, { addedTags, removedTags, editedAt });
              feedback = { ...feedback, addedTags, removedTags, editedAt };
              cachedRecords = null;
              render();
              syncTagChoices();
              picker.open = true;
            } catch { showStatus('Could not save your tag suggestions on this device.', true); }
          });
          choice.setAttribute('aria-pressed', String(present));
          tagList.append(choice);
          choiceButtons.push({ tag, choice });
        }
        picker.append(tagList);
        picker.append(emptyTags);
        reviewCount = make('p', 'sq-extra-review-count', `${effectiveReviewTags(entry, feedback).length} tags · ${hasTagEdits(entry, feedback) ? 'Locally edited' : 'Not edited'}`);
        picker.append(reviewCount);
      });
      moreMenu.__quickRate = saveRating;
      moreMenu.__quickDifficulty = saveDifficulty;
      moreMenu.append(picker);
      let resetPending = false;
      const resetReview = button('Reset review', 'sq-extra-review-reset', () => {
        if (!resetPending) {
          resetPending = true;
          resetReview.textContent = 'Confirm reset review';
          resetReview.title = 'Clears favorites, votes, both ratings and tag suggestions. Keeps imports and personal bests.';
          return;
        }
        try {
          const defaults = {favorite: false, vote: 0, rating: 0, difficultyRating: 0, addedTags: [], removedTags: [], editedAt: null};
          onFeedback(entry, defaults);
          feedback = defaults;
          rating.value = '0'; difficultyRating.value = '0';
          menuFavorite.textContent = 'Add to favorites'; menuFavorite.setAttribute('aria-pressed', 'false');
          for (const control of [up, down]) { control.className = 'sq-extra-pick'; control.setAttribute('aria-pressed', 'false'); }
          syncTagPicker();
          cachedRecords = null; render();
          resetPending = false; resetReview.textContent = 'Reset review';
        } catch { showStatus('Could not reset your review on this device.', true); }
      });
      resetReview.title = 'Reset this track review to default. Imports and personal bests are kept.';
      moreMenu.append(resetReview);
    }
    if (trackDetails.children.length) moreMenu.append(trackDetails);
    moreMenu.append(button('Report track', 'sq-extra-report-button', () => {
      const trigger = expandedCardTrigger || more;
      clearCardMenu();
      moreMenu.hidden = true; trigger.setAttribute('aria-expanded', 'false');
      reportReturnFocus = trigger;
      reportGeneration++;
      reportingEntry = entry; reportEntry.textContent = text(entry.name, 'Untitled track');
      reportStatus.textContent = reportRequest ? REPORT_PENDING_MESSAGE : pendingAction ? ACTION_PENDING_MESSAGE : '';
      reportStatus.hidden = !reportRequest && !pendingAction;
      reportStatus.className = 'sq-extra-report-status';
      syncSendControls();
      for (const choice of reportChoices.children) choice.children[0].checked = false;
      reportModal.hidden = false;
      syncDialogModality();
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
    syncSortChoices(all);
    const reviewKey = state.sort + (state.direction === 'asc' ? '-low' : '-high');
    const description = REVIEW_SORT_DESCRIPTIONS[reviewKey] || '';
    sortField.select.title = description;
    if (description) sortField.select.setAttribute('aria-description', description);
    else sortField.select.removeAttribute('aria-description');
    sortDirection.disabled = state.sort === 'recommended';
    sortDirection.textContent = state.direction === 'asc' ? '\u2191' : '\u2193';
    const directionLabel = state.direction === 'asc' ? 'ascending' : 'descending';
    const nextDirection = state.direction === 'asc' ? 'descending' : 'ascending';
    const metricLabel = Array.from(sortField.select.children).find(option => option.value === state.sort)?.textContent || 'Sort';
    sortDirection.setAttribute('aria-label', sortDirection.disabled ? 'Recommended order (fixed)' : metricLabel + ': ' + directionLabel + '. Switch to ' + nextDirection);
    sortDirection.title = sortDirection.getAttribute('aria-label');
    const sourceCounts = new Map(), difficultyCounts = new Map();
    for (const entry of all) if (text(entry.source)) sourceCounts.set(entry.source, (sourceCounts.get(entry.source) || 0) + 1);
    for (const entry of all) { const level = difficulty(entry); if (level !== null) difficultyCounts.set(String(level), (difficultyCounts.get(String(level)) || 0) + 1); }
    const sources = [...sourceCounts.keys()].sort((a, b) => a.localeCompare(b));
    const tags = reviewTagOptions(all);
    const tagCounts = new Map();
    const feedbackById = new Map();
    for (const entry of all) {
      let feedback = {};
      try { feedback = getFeedback?.(entry) || {}; } catch { /* Device feedback is optional. */ }
      feedbackById.set(entry.id, feedback);
      for (const tag of new Set(effectiveReviewTags(entry, feedback))) tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }
    options(sourceField.select, sources, 'All sources', state.source, sourceCounts);
    options(tagField.select, tags, `Add a tag (${tags.length} tags)`, '');
    for (const option of tagField.select.children) if (option.value) {
      option.textContent = `${tagLabel(option.value)} (${tagCounts.get(option.value) || 0})`;
      if (!tagCounts.get(option.value)) option.disabled = true;
    }
    options(difficultyField.select, DIFFICULTY_LABELS.slice(1).map((_, index) => String(index + 1)), 'Any level', state.difficulty, difficultyCounts);
    // The native select stays keyboard-accessible; the count is visually aligned at its right edge.
    for (const option of difficultyField.select.children) if (option.value) option.textContent = `${option.value} · ${DIFFICULTY_LABELS[Number(option.value)]} (${difficultyCounts.get(option.value) || 0})`;
    filterCount(sourceField, state.source ? sourceCounts.get(state.source) || 0 : all.length);
    const tagMatches = state.tags.length ? all.filter(entry => state.tags.every(tag => effectiveReviewTags(entry, feedbackById.get(entry.id)).includes(tag))).length : null;
    filterCount(tagField, tagMatches === null ? `${tags.length} Tags` : `${tagMatches} tracks`);
    filterCount(difficultyField, state.difficulty ? difficultyCounts.get(state.difficulty) || 0 : all.length);
    syncAdvancedFilters();
    tagSuggestions.replaceChildren();
    for (const tag of [...tagCounts].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
      tagSuggestions.append(button(tagLabel(tag[0]), '', () => {
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
      remove.setAttribute('aria-label', `Remove ${tag.replaceAll('-', ' ')} tag`);
      selectedTags.append(remove);
    }
    const query = normalizeSearchText(state.search);
    const queryTokens = [...searchWords(query)];
    if (!cachedRecords) cachedRecords = all.map(entry => {
      let best = null, loaded = false, rating = null, favorite = false;
      try { best = personalBest(typeof getPersonalBest === 'function' ? getPersonalBest(entry) : null); } catch { /* A missing PB must not break the catalog. */ }
      try { loaded = typeof isLoaded === 'function' && Boolean(isLoaded(entry)); } catch { /* Local imports are optional. */ }
      try { rating = typeof getLocalRating === 'function' ? Number(getLocalRating(entry)) : null; } catch { /* Local ratings are optional. */ }
      try { favorite = getFeedback?.(entry)?.favorite === true; } catch { /* Device storage is optional. */ }
      const searchName = normalizeSearchText(text(entry.name, 'Untitled track'));
      const feedback = feedbackById.get(entry.id) || {};
      const effectiveTags = effectiveReviewTags(entry, feedback);
      const searchValues = [entry.name, entry.author, entry.codeName, entry.codeAuthor, entry.source, entry.description, ...effectiveTags];
      // Cache alias expansion alongside device feedback, not on each keystroke.
      const searchable = searchValues.flatMap(value => [value, ...searchAliases(value)]).map(normalizeSearchText).join(' ');
      return {
        entry, best, loaded, favorite, effectiveTags, edited: hasLocalReview(entry, feedback),
        activity: hasReviewExportData(reviewExportRow(entry, {feedback, imported: loaded, personalBestMs: best})),
        rating: Number.isFinite(rating) && rating >= 1 && rating <= 10 ? rating : null,
        searchValues, searchName, searchNameWords: searchWords(searchName), searchable, searchableWords: searchWords(searchable)
      };
    });
    const compare = (a, b) => nameCollator.compare(text(a), text(b));
    if (!sortedRecordsCache || sortedRecordsCache.records !== cachedRecords || sortedRecordsCache.sort !== state.sort || sortedRecordsCache.direction !== state.direction) {
      const ordered = [...cachedRecords];
      const numeric = (av, bv, a, b) => {
        // Unknown metrics stay last in both directions; equal values keep name order.
        if (av === null || bv === null) return av === bv ? compare(a.entry.name, b.entry.name) : av === null ? 1 : -1;
        return (state.direction === 'asc' ? av - bv : bv - av) || compare(a.entry.name, b.entry.name);
      };
      const metric = record => {
        const entry = record.entry;
        if (state.sort.startsWith('review-')) {
          const review = reviewedSummary(entry);
          return state.sort === 'review-quality' ? review.quality : state.sort === 'review-difficulty' ? review.difficulty : review.votes ? review.up - review.down : null;
        }
        if (state.sort === 'my-rating') return record.rating;
        if (state.sort === 'my-reviews') return Number(record.edited);
        if (state.sort === 'forum') return forumActivity(entry);
        if (state.sort === 'date') {
          const date = Date.parse(entry.submittedAt || entry.codeModifiedAt);
          return Number.isFinite(date) ? date : null;
        }
        if (state.sort === 'size') return Number.isSafeInteger(entry.sizeBytes) && entry.sizeBytes >= 0 ? entry.sizeBytes : null;
        return Number.isSafeInteger(entry.sourceCopies) && entry.sourceCopies >= 0 ? entry.sourceCopies : Number.isSafeInteger(entry.sourcePlays) && entry.sourcePlays >= 0 ? entry.sourcePlays : null;
      };
      ordered.sort((a, b) => {
        if (state.sort === 'recommended') return Number(b.entry.featuredSubmission === true) - Number(a.entry.featuredSubmission === true) || ((a.entry.featuredSubmission === true && b.entry.featuredSubmission === true) ? (Number(a.entry.submissionOrder) || 0) - (Number(b.entry.submissionOrder) || 0) : 0) || Number(text(b.entry.tier).toLowerCase() === 'curated') - Number(text(a.entry.tier).toLowerCase() === 'curated') || compare(a.entry.name, b.entry.name);
        if (state.sort === 'name') return (state.direction === 'asc' ? 1 : -1) * compare(a.entry.name, b.entry.name);
        if (state.sort === 'author') return (state.direction === 'asc' ? 1 : -1) * compare(displayAuthor(a.entry), displayAuthor(b.entry)) || compare(a.entry.name, b.entry.name);
        return numeric(metric(a), metric(b), a, b);
      });
      sortedRecordsCache = { records: cachedRecords, sort: state.sort, direction: state.direction, ordered };
    }
    const progressCounts = new Map([['all', cachedRecords.length], ['completed', 0], ['uncompleted', 0], ['loaded', 0], ['activity', 0], ['untouched', 0]]);
    for (const record of cachedRecords) {
      progressCounts.set(record.best === null ? 'uncompleted' : 'completed', progressCounts.get(record.best === null ? 'uncompleted' : 'completed') + 1);
      if (record.loaded && record.best === null) progressCounts.set('loaded', progressCounts.get('loaded') + 1);
      const activityKey = record.activity ? 'activity' : 'untouched';
      progressCounts.set(activityKey, progressCounts.get(activityKey) + 1);
    }
    for (const option of completionField.select.children) {
      const name = progressLabels[option.value];
      option.textContent = `${name} (${progressCounts.get(option.value) || 0})`;
    }
    filterCount(completionField, progressCounts.get(state.completion) || 0);
    const reviewCounts = new Map([['all', cachedRecords.length], ['edited', 0], ['not-edited', 0], ['published', cachedRecords.filter(record => reviewedSummary(record.entry).count).length], ['no-published', cachedRecords.filter(record => !reviewedSummary(record.entry).count).length]]);
    for (const record of cachedRecords) reviewCounts.set(record.edited ? 'edited' : 'not-edited', reviewCounts.get(record.edited ? 'edited' : 'not-edited') + 1);
    for (const option of reviewField.select.children) {
      const name = option.value === 'edited' ? 'Reviewed by me' : option.value === 'not-edited' ? 'Not reviewed by me' : option.value === 'published' ? 'Has published ratings' : option.value === 'no-published' ? 'No published ratings' : 'All tracks';
      option.textContent = `${name} (${reviewCounts.get(option.value) || 0})`;
    }
    filterCount(reviewField, reviewCounts.get(state.review) || 0);
    let records = sortedRecordsCache.ordered.filter(({ entry, best, loaded, favorite, searchable, effectiveTags, edited, activity }) => {
      const review = reviewedSummary(entry);
      const matchesSearch = !query || searchMatches(query, searchable);
      // A curator can mark a track by tier or by the curated tag.
      const isCurated = text(entry.tier).toLocaleLowerCase() === 'curated' ||
        (Array.isArray(entry.tags) && entry.tags.some(tag => text(tag).toLocaleLowerCase() === 'curated'));
      return matchesSearch && (!state.source || entry.source === state.source) && (!state.favorites || favorite) &&
        state.tags.every(tag => effectiveTags.includes(tag)) && (!state.curated || isCurated) &&
        (state.review === 'all' || state.review === 'edited' && edited || state.review === 'not-edited' && !edited || state.review === 'published' && review.count > 0 || state.review === 'no-published' && !review.count) &&
        (!state.reviewedQuality || review.quality !== null && review.quality >= Number(state.reviewedQuality)) &&
        (!state.reviewedDifficulty || review.difficulty !== null && Math.round(review.difficulty) === Number(state.reviewedDifficulty)) &&
        (!state.reviewedVote || state.reviewedVote === 'positive' && review.up > review.down || state.reviewedVote === 'negative' && review.down > review.up || state.reviewedVote === 'voted' && review.votes > 0 || state.reviewedVote === 'unvoted' && !review.votes) &&
        (!state.difficulty || difficulty(entry) === Number(state.difficulty)) &&
        (state.completion === 'all' || state.completion === 'activity' && activity || state.completion === 'untouched' && !activity || state.completion === 'completed' && best !== null ||
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
    for (const [field, value, predicate] of [
      [qualityField, state.reviewedQuality, (r, v) => r.quality !== null && r.quality >= Number(v)],
      [reviewedDifficultyField, state.reviewedDifficulty, (r, v) => r.difficulty !== null && Math.round(r.difficulty) === Number(v)],
      [voteField, state.reviewedVote, (r, v) => v === 'positive' ? r.up > r.down : v === 'negative' ? r.down > r.up : v === 'voted' ? r.votes > 0 : !r.votes]
    ]) {
      for (const option of field.select.children) {
        const optionCount = option.value ? all.filter(entry => predicate(reviewedSummary(entry), option.value)).length : all.length;
        const label = option.textContent.replace(/ \(\d+\)$/, '');
        option.textContent = `${label} (${optionCount})`;
      }
      filterCount(field, `${value ? all.filter(entry => predicate(reviewedSummary(entry), value)).length : all.length} tracks`);
    }
    const showCredits = query === 'credits';
    const showCleaner = showCredits || ['window cleaner', 'windowcleaner'].includes(query);
    const showStatic = showCredits || query === 'static';
    staticReveal.hidden = !showStatic;
    cleanerReveal.hidden = !showCleaner;
    if (showStatic && !staticImageCreated) {
      const logo = make('img', 'sq-extra-static-logo');
      logo.alt = '';
      logo.width = 64;
      logo.height = 64;
      logo.decoding = 'async';
      logo.referrerPolicy = 'no-referrer';
      logo.addEventListener('error', () => { logo.hidden = true; }, {once: true});
      logo.src = 'https://cdn.jsdelivr.net/gh/StaticQuasar931/Images@main/squarestaticquasar931logo.jpg';
      staticReveal.append(logo);
      staticImageCreated = true;
    }
    if (showCleaner && !cleanerImageCreated) {
      const cat = make('img');
      cat.src = 'https://cdn.jsdelivr.net/gh/StaticQuasar931/Images@main/Window_Cleaner_Cat.jpg';
      cat.alt = 'Window Cleaner cat';
      cat.loading = 'lazy';
      cat.referrerPolicy = 'no-referrer';
      cleanerReveal.append(cat);
      cleanerImageCreated = true;
    }
    list.replaceChildren();
    const visible = records.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    if (!visible.length && !showCleaner && !showStatic) {
      const empty = make('div', 'sq-extra-empty');
      empty.setAttribute('role', 'status');
      empty.setAttribute('aria-live', 'polite');
      empty.append(make('h3', '', all.length ? 'No matching tracks' : 'No extra tracks are available'));
      empty.append(make('p', '', all.length
        ? 'Try a different search or adjust your filters.'
        : 'The catalog is empty right now. Check back later.'));
      if (all.length) empty.append(button('Clear filters', 'sq-extra-clear', clearFilters));
      list.append(empty);
    }
    for (const { entry, best, loaded } of visible) list.append(card(entry, best, loaded));
    if (expandedCardMenu) {
      const findTrigger = nodes => {
        for (const node of nodes) {
          if (typeof node.className === 'string' && node.className.split(' ').includes('sq-extra-more') && node.entryId === expandedCardMenu.entryId) return node;
          const nested = findTrigger(node.children || []);
          if (nested) return nested;
        }
        return null;
      };
      const replacement = findTrigger(list.children);
      if (replacement) {
        expandedCardTrigger?.setAttribute('aria-expanded', 'false');
        expandedCardTrigger = replacement;
        replacement.setAttribute('aria-expanded', 'true');
        replacement.setAttribute('aria-controls', expandedCardMenu.id);
        positionCardMenu();
      }
    }
    pagination.replaceChildren();
    const changePage = (offset, focusButton = false) => {
      page += offset;
      render();
      list.scrollIntoView?.({ block: 'start' });
      if (focusButton) {
        const controls = [...pagination.children].filter(child => child.tagName === 'BUTTON' && !child.disabled);
        const replacement = controls.find(child => child.textContent === (offset < 0 ? 'Previous' : 'Next')) || controls[0];
        replacement?.focus({ preventScroll: true });
      }
    };
    const previous = button('Previous', '', () => changePage(-1, true));
    previous.disabled = page <= 1;
    const next = button('Next', '', () => changePage(1, true));
    next.disabled = page >= pages;
    pagination.append(previous, make('span', '', `Page ${page} of ${pages}`), next);
    if (expandedCardMenu) scheduleCardMenuPosition();
  }

  function clearFilters() {
    Object.assign(state, { search: '', source: '', tags: [], difficulty: '', curated: false, favorites: false, completion: 'all', review: 'all', sort: 'recommended', direction: 'desc', reviewedQuality: '', reviewedDifficulty: '', reviewedVote: '' });
    qualityField.select.value = ''; reviewedDifficultyField.select.value = ''; voteField.select.value = '';
    search.value = ''; sourceField.select.value = ''; difficultyField.select.value = '';
    completionField.select.value = 'all'; reviewField.select.value = 'all'; sortField.select.value = 'recommended'; curated.checked = false; favorites.checked = false;
    page = 1; render();
    search.focus({preventScroll: true});
  }

  function activeAdvancedFilterGroups() {
    return Number(Boolean(state.source)) + Number(state.tags.length > 0) + Number(Boolean(state.difficulty)) +
      Number(state.curated) + Number(state.favorites) + Number(state.completion !== 'all') +
      Number(state.review !== 'all') + Number(Boolean(state.reviewedQuality)) + Number(Boolean(state.reviewedDifficulty)) + Number(Boolean(state.reviewedVote));
  }

  function syncAdvancedFilters() {
    const expanded = filtersExpanded;
    advancedControls.hidden = !expanded;
    advancedControls.inert = !expanded;
    advancedToggle.hidden = false;
    advancedToggle.setAttribute('aria-expanded', String(expanded));
    const activeCount = activeAdvancedFilterGroups();
    advancedToggle.textContent = activeCount ? `Filters (${activeCount})` : 'Filters';
    if (!expanded && advancedControls.contains(document.activeElement)) advancedToggle.focus({preventScroll: true});
  }

  function toggleAdvancedFilters() {
    filtersExpanded = !filtersExpanded;
    syncAdvancedFilters();
  }

  function close() {
    if (!opened || destroyed) return;
    opened = false;
    viewGeneration++;
    clearCardMenu();
    overlay.hidden = true;
    closeSubmission(false);
    closeReport(false);
    syncDialogModality();
    if (returnFocus?.isConnected !== false) returnFocus?.focus?.();
    returnFocus = null;
  }

  function syncDialogModality() {
    const nestedModalOpen = !submissionModal.hidden || !reportModal.hidden;
    dialog.inert = nestedModalOpen;
    dialog.setAttribute('aria-modal', String(!nestedModalOpen));
  }

  function closeSubmission(restoreFocus = true) {
    if (submissionModal.hidden) return;
    submissionGeneration++;
    submissionModal.hidden = true;
    syncDialogModality();
    if (restoreFocus) (submissionReturnFocus?.isConnected !== false ? submissionReturnFocus : submit)?.focus();
    submissionReturnFocus = null;
  }

  function closeReport(restoreFocus = true) {
    if (reportModal.hidden) return;
    reportGeneration++;
    reportModal.hidden = true;
    reportingEntry = null;
    syncDialogModality();
    if (restoreFocus) (reportReturnFocus?.isConnected !== false ? reportReturnFocus : search)?.focus();
    reportReturnFocus = null;
  }

  function open() {
    if (destroyed || opened) return;
    viewGeneration++;
    returnFocus = document.activeElement;
    opened = true;
    cachedRecords = null;
    submissionModal.hidden = true;
    reportModal.hidden = true;
    syncDialogModality();
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
      // The review popup is outside dialog; let native Tab move within it.
      return;
    }
    if ((!submissionModal.hidden || !reportModal.hidden) && event.key !== 'Tab') return;
    const activeTag = document.activeElement?.tagName;
    const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeTag);
    const activeRating = document.activeElement?.getAttribute?.('data-quick-rating') === 'true';
    const quickDigit = !event.repeat && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey &&
      (/^([0-9])$/.exec(event.key) || /^(?:Digit|Numpad)([0-9])$/.exec(event.code || ''));
    const rateDigit = quickDigit && (activeRating || expandedCardMenu && !editing) && expandedCardMenu?.__quickRate
      ? (quickDigit[1] ?? quickDigit[2]) : null;
    if (rateDigit !== null && typeof expandedCardMenu.__quickRate === 'function') {
      const rate = activeRating && document.activeElement.getAttribute('data-rating-kind') === 'difficulty'
        ? expandedCardMenu.__quickDifficulty : expandedCardMenu.__quickRate;
      rate(rateDigit === '0' ? 10 : Number(rateDigit));
      event.preventDefault();
      return;
    }
    if (!editing && !expandedCardMenu) {
      const digit = /^Digit([0-9])$/.exec(event.code || '');
      if (!expandedCardMenu && event.shiftKey && digit) {
        const requested = digit[1] === '0' ? 10 : Number(digit[1]);
        // The render path clamps against the filtered result count.
        page = requested; event.preventDefault(); render(); list.scrollIntoView?.({ block: 'start' }); return;
      }
      if (['ArrowRight', 'ArrowLeft', 'a', 'A', 'd', 'D'].includes(event.key)) {
        page += ['ArrowRight', 'd', 'D'].includes(event.key) ? 1 : -1;
        page = Math.max(1, page);
        event.preventDefault(); render(); list.scrollIntoView?.({ block: 'start' }); return;
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

  function positionCardMenu(reanchor = false) {
    if (!expandedCardMenu?.getBoundingClientRect || !expandedCardTrigger?.getBoundingClientRect) return;
    const view = document.defaultView;
    const viewportWidth = view?.innerWidth || document.documentElement?.clientWidth || 0;
    const viewportHeight = view?.innerHeight || document.documentElement?.clientHeight || 0;
    if (!viewportWidth || !viewportHeight) return;
    const margin = 8, gap = 6;
    const trigger = expandedCardTrigger.getBoundingClientRect();
    const viewportRoom = Math.max(44, viewportHeight - margin * 2);
    expandedCardMenu.style.maxHeight = `${viewportRoom}px`;
    expandedCardMenu.style.minHeight = '0px';
    expandedCardMenu.style.overflowY = 'auto';
    const natural = expandedCardMenu.getBoundingClientRect();
    const anchored = reanchor === true || !expandedCardMenu.__positioned;
    const above = Math.max(0, Math.min(viewportRoom, trigger.top - gap - margin));
    const below = Math.max(0, Math.min(viewportRoom, viewportHeight - margin - trigger.bottom - gap));
    const side = anchored ? (natural.height <= below ? 'below' : above > below ? 'above' : 'below') : expandedCardMenu.__placement;
    const left = Math.min(Math.max(margin, anchored ? trigger.right - natural.width : parseFloat(expandedCardMenu.style.left)), Math.max(margin, viewportWidth - natural.width - margin));
    let top = anchored ? 0 : parseFloat(expandedCardMenu.style.top);
    // Preserve the popup's position during edits, but never grow it over its trigger.
    const room = side === 'above'
      ? anchored ? above : Math.min(above, trigger.top - gap - top)
      : anchored ? below : viewportHeight - margin - top;
    expandedCardMenu.style.maxHeight = `${Math.max(44, room)}px`;
    const menu = expandedCardMenu.getBoundingClientRect();
    if (anchored) top = side === 'above' ? trigger.top - menu.height - gap : trigger.bottom + gap;
    top = Math.min(Math.max(margin, top), Math.max(margin, viewportHeight - menu.height - margin));
    expandedCardMenu.style.left = `${Math.round(left)}px`;
    expandedCardMenu.style.top = `${Math.round(top)}px`;
    expandedCardMenu.__placement = side;
    expandedCardMenu.__positioned = true;
  }

  function scheduleCardMenuPosition(event) {
    const view = document.defaultView;
    if (event?.target && expandedCardMenu?.contains(event.target)) return;
    if (!expandedCardMenu || cardMenuPositionFrame !== null || !view?.requestAnimationFrame) return;
    cardMenuPositionFrame = view.requestAnimationFrame(() => {
      // Rebuilt cards may settle their content-visibility sizes after the first layout.
      cardMenuPositionFrame = view.requestAnimationFrame(() => {
        cardMenuPositionFrame = null;
        positionCardMenu(Boolean(event) && expandedCardTrigger?.isConnected !== false);
      });
    });
  }

  function focusCardMenu() {
    const focusable = expandedCardMenu?.querySelector?.('button[aria-label="Helpful"]') || expandedCardMenu?.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),a[href]')[0];
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
    if (restoreFocus) (trigger?.isConnected ? trigger : search).focus({preventScroll: true});
  }

  function onCardMenuOutside(event) {
    const path = event.composedPath?.() || [];
    if (expandedCardMenu && !expandedCardMenu.contains(event.target) && !expandedCardTrigger?.contains(event.target) &&
        !path.includes(expandedCardMenu) && !path.includes(expandedCardTrigger)) clearCardMenu();
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
  reviewField.select.addEventListener('change', () => { state.review = reviewField.select.value; page = 1; render(); });
  sortField.select.addEventListener('change', () => {
    // Normalize legacy directional keys without exposing duplicate metric options.
    const [metric, direction] = SORT_ALIASES[sortField.select.value] || [sortField.select.value, defaultDirection(sortField.select.value)];
    state.sort = metric;
    state.direction = direction;
    sortField.select.value = metric;
    page = 1;
    render();
  });
  for (const [field, key] of [[qualityField, 'reviewedQuality'], [reviewedDifficultyField, 'reviewedDifficulty'], [voteField, 'reviewedVote']]) {
    field.select.addEventListener('change', () => { state[key] = field.select.value; page = 1; render(); });
  }
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
