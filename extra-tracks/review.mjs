const {default: reviewedData} = await import(new URL(`reviewed-data.mjs${new URL(import.meta.url).search}`, import.meta.url));
const {summarizeReviews, reviewedTags} = await import(new URL(`reviewed.mjs${new URL(import.meta.url).search}`, import.meta.url));
const reviewSummaries = new WeakMap();
export function reviewedSummary(entry) {
  if (!entry || typeof entry !== 'object') return summarizeReviews({}, reviewedData);
  if (!reviewSummaries.has(entry)) reviewSummaries.set(entry, summarizeReviews(entry, reviewedData));
  return reviewSummaries.get(entry);
}

const HIDDEN_TAGS = new Set(['slide', 'easy', 'medium', 'hard', 'expert', 'throwback', 'curated']);
const NEW_TAGS = ['scenic', 'elite-track', 'kacky', 'mini', 'other-route'];

function tagKey(value) {
  if (typeof value !== 'string') return '';
  const key = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return key.length <= 40 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)
    && !key.startsWith('difficulty-') && !HIDDEN_TAGS.has(key) ? key : '';
}

function tags(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.slice(0, 128).map(tagKey).filter(Boolean))].slice(0, 64);
}

export function tagLabel(tag) {
  return tagKey(tag).split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

export function reviewTagOptions(entries = []) {
  const options = new Set(NEW_TAGS);
  for (const entry of entries) for (const tag of [...tags(entry?.tags), ...reviewedTags(entry, reviewedSummary(entry))]) options.add(tag);
  return [...options]
    .sort((a, b) => tagLabel(a).localeCompare(tagLabel(b)));
}

export function normalizeReviewFeedback(entry, value, summary = reviewedSummary(entry)) {
  const data = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const sourceTags = new Set(tags(entry?.tags));
  const original = new Set([...sourceTags, ...reviewedTags(entry, summary)]);
  const published = new Set(reviewedTags(entry, summary));
  const addedTags = tags(data.addedTags).filter(tag => !sourceTags.has(tag) || !published.has(tag));
  const removedTags = tags(data.removedTags).filter(tag => original.has(tag));
  return {
    favorite: data.favorite === true,
    vote: data.vote === 1 || data.vote === -1 ? data.vote : 0,
    rating: Number.isInteger(data.rating) && data.rating >= 1 && data.rating <= 10 ? data.rating : 0,
    difficultyRating: Number.isInteger(data.difficultyRating) && data.difficultyRating >= 1 && data.difficultyRating <= 10 ? data.difficultyRating : 0,
    addedTags, removedTags,
    editedAt: (addedTags.length || removedTags.length) && Number.isSafeInteger(data.editedAt)
      && data.editedAt > 0 && data.editedAt <= 4102444800000 ? data.editedAt : null
  };
}

export function effectiveReviewTags(entry, value, summary = reviewedSummary(entry)) {
  const review = normalizeReviewFeedback(entry, value, summary);
  return [...new Set([...reviewedTags(entry, summary).filter(tag => !review.removedTags.includes(tag)), ...review.addedTags])];
}

export function hasTagEdits(entry, value) {
  const review = normalizeReviewFeedback(entry, value);
  return review.addedTags.length > 0 || review.removedTags.length > 0;
}

export function hasLocalReview(entry, value) {
  const review = normalizeReviewFeedback(entry, value);
  return review.vote !== 0 || review.rating > 0 || review.difficultyRating > 0
    || review.addedTags.length > 0 || review.removedTags.length > 0;
}

export function reviewExportRow(entry, {feedback, imported = false, personalBestMs = null} = {}) {
  const review = normalizeReviewFeedback(entry, feedback);
  const best = Number.isFinite(personalBestMs) && personalBestMs > 0 ? personalBestMs : null;
  return {
    name: entry.name, author: entry.codeAuthor || entry.author,
    imported: imported === true, played: best !== null, personalBestMs: best,
    ...review, catalogTags: tags(entry.tags), effectiveTags: effectiveReviewTags(entry, review),
    locallyEdited: hasTagEdits(entry, review)
  };
}

export function hasReviewExportData(row) {
  return row.imported === true || row.played === true || row.favorite === true
    || row.vote !== 0 || row.rating > 0 || row.difficultyRating > 0
    || row.addedTags.length > 0 || row.removedTags.length > 0;
}
