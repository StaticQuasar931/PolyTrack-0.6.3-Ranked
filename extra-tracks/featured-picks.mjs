const {reviewedSummary} = await import(new URL(`review.mjs${new URL(import.meta.url).search}`, import.meta.url));
const DAY = 86400000;
function hash(value) {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619) >>> 0;
  return result;
}

function curated(entry) {
  return String(entry.tier).toLowerCase() === 'curated' || Array.isArray(entry.tags) && entry.tags.includes('curated') || entry.featuredSubmission === true ||
    entry.source === 'Kodub weekly' && /^[a-f0-9]{64}$/.test(entry.codeHash || '') &&
    entry.dateProvenance === 'events/kodub/selections.json' && Number.isFinite(Date.parse(entry.weeklyEndsAt));
}

// Selection stays within the explicit editorial pool; counts alone cannot curate a track.
export function featuredPicks(entries, counts = new Map(), now = Date.now(), review = reviewedSummary) {
  if (!Number.isFinite(now)) return [];
  const unique = new Map();
  for (const entry of entries) {
    if (entry?.ranked === false || !/^[a-f0-9]{64}$/.test(entry?.trackId || '') || !entry.trackPath) continue;
    if (!unique.has(entry.trackId) || String(entry.id) < String(unique.get(entry.trackId).id)) unique.set(entry.trackId, entry);
  }
  const all = [...unique.values()].sort((a, b) => a.trackId.localeCompare(b.trackId));
  if (!all.length) return [];
  const editorial = all.filter(curated);
  const candidates = editorial.length ? editorial : all;
  const grades = new Map(candidates.map(entry => [entry.trackId, review(entry)?.quality ?? null]));
  const goodGrade = entry => Number.isFinite(grades.get(entry.trackId)) && grades.get(entry.trackId) >= 6;
  const covered = entry => counts.has(entry.trackId) && counts.get(entry.trackId) > 0;
  const day = Math.floor(now / DAY);
  const week = Math.floor((day + 3) / 7) * 7 - 3;
  const chosen = new Set();
  return [['weekly', week, week + 7], ['daily', day, day + 1]].map(([kind, start, end]) => {
    const unused = candidates.filter(entry => !chosen.has(entry.trackId));
    const available = unused.length ? unused : candidates;
    const pool = [available.filter(entry => goodGrade(entry) && covered(entry)),
      available.filter(goodGrade), available.filter(covered), available].find(rows => rows.length);
    const entry = pool[hash(kind + ':' + start) % pool.length];
    chosen.add(entry.trackId);
    return {kind, entry, startsAt: start * DAY, endsAt: end * DAY,
      players: counts.get(entry.trackId) ?? null, quality: grades.get(entry.trackId),
      pool: editorial.length ? 'curated' : 'catalog', fallback: !editorial.length};
  }).reverse();
}
