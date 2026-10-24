// Reviewed data is separate from source metadata and device-local preferences.
export function reviewTag(value) {
  if (typeof value !== 'string') return '';
  const key = value.trim().toLowerCase().replace(/[\s_]+/g, '-');
  return key.length <= 40 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(key)
    && !['slide', 'easy', 'medium', 'hard', 'expert', 'throwback', 'curated'].includes(key)
    && !key.startsWith('difficulty-') ? key : '';
}

export function summarizeReviews(entry, dataset) {
  const rows = Object.values(dataset?.reviewers || {}).map(reviewer => reviewer[entry?.trackId]).filter(Boolean);
  const average = index => {
    const values = rows.map(row => row[index]).filter(value => Number.isInteger(value) && value >= 1 && value <= 10);
    return {value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, count: values.length};
  };
  const quality = average(0), difficulty = average(1);
  const up = rows.filter(row => row[2] === 1).length, down = rows.filter(row => row[2] === -1).length;
  const additions = new Map(), removals = new Map();
  for (const row of rows) {
    for (const tag of row[3] || []) additions.set(tag, (additions.get(tag) || 0) + 1);
    for (const tag of row[4] || []) removals.set(tag, (removals.get(tag) || 0) + 1);
  }
  // Only explicit tag opinions vote. Ties preserve the source tag state.
  const addedTags = [...additions].filter(([tag, count]) => count > (removals.get(tag) || 0)).map(([tag]) => tag).sort();
  const removedTags = [...removals].filter(([tag, count]) => count > (additions.get(tag) || 0)).map(([tag]) => tag).sort();
  return {count: rows.length, quality: quality.value, qualityCount: quality.count,
    difficulty: difficulty.value, difficultyCount: difficulty.count, up, down, votes: up + down, addedTags, removedTags};
}

export function reviewedTags(entry, summary) {
  const source = (Array.isArray(entry?.tags) ? entry.tags : []).map(reviewTag).filter(Boolean);
  return [...new Set([...source.filter(tag => !summary.removedTags.includes(tag)), ...summary.addedTags])];
}
