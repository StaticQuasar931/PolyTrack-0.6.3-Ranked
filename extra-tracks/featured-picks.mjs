const {reviewedSummary} = await import(new URL(`review.mjs${new URL(import.meta.url).search}`, import.meta.url));
const DAY = 86400000;
function hash(value) {
  let result = 2166136261;
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619) >>> 0;
  return result;
}
function editorial(entry) {
  return String(entry.tier).toLowerCase() === 'curated' || Array.isArray(entry.tags) && entry.tags.includes('curated') || entry.featuredSubmission === true ||
    entry.source === 'Kodub weekly' && /^[a-f0-9]{64}$/.test(entry.codeHash || '') &&
    entry.dateProvenance === 'events/kodub/selections.json' && Number.isFinite(Date.parse(entry.weeklyEndsAt));
}

// Lexicographic evidence, not a weighted score: quality, editorial care, then reach.
export function recommendationOrder(a, b, counts = new Map(), review = reviewedSummary) {
  const quality = entry => {
    const value = review(entry)?.quality;
    return Number.isFinite(value) && value >= 1 && value <= 10 ? value : null;
  };
  const aq = quality(a), bq = quality(b);
  if (aq !== bq) return aq === null ? 1 : bq === null ? -1 : bq - aq;
  const care = Number(editorial(b)) - Number(editorial(a));
  if (care) return care;
  const count = entry => {
    const value = counts.get(entry.trackId);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const ac = count(a), bc = count(b);
  if (ac !== bc) return ac === null ? 1 : bc === null ? -1 : bc - ac;
  return 0;
}

// Published reviews and explicit editorial decisions are the only eligibility evidence.
export function featuredPicks(entries, counts = new Map(), now = Date.now(), review = reviewedSummary) {
  if (!Number.isFinite(now)) return [];
  const unique = new Map();
  for (const entry of entries) {
    if (entry?.ranked === false || !/^[a-f0-9]{64}$/.test(entry?.trackId || '') || !entry.trackPath) continue;
    if (!unique.has(entry.trackId) || String(entry.id) < String(unique.get(entry.trackId).id)) unique.set(entry.trackId, entry);
  }
  const all = [...unique.values()].sort((a, b) => a.trackId.localeCompare(b.trackId));
  const grades = new Map(all.map(entry => [entry.trackId, review(entry)?.quality ?? null]));
  const goodGrade = entry => Number.isFinite(grades.get(entry.trackId)) && grades.get(entry.trackId) >= 6;
  const worthy = entry => grades.get(entry.trackId) === null || goodGrade(entry);
  const curated = all.filter(entry => editorial(entry) && worthy(entry));
  const candidates = curated.length ? curated : all.filter(goodGrade);
  if (!candidates.length) return [];
  const countOf = entry => {
    const value = counts.get(entry.trackId);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const day = Math.floor(now / DAY), week = Math.floor((day + 3) / 7) * 7 - 3;
  const exact = candidates.filter(entry => countOf(entry) !== null).sort((a, b) => countOf(a) - countOf(b) || a.trackId.localeCompare(b.trackId));
  const threshold = exact.length ? countOf(exact[Math.ceil(exact.length / 4) - 1]) : null;
  const discoveryPool = exact.length ? exact.filter(entry => countOf(entry) <= threshold) : candidates.filter(goodGrade).length ? candidates.filter(goodGrade) : candidates;
  const weekly = discoveryPool[hash('weekly:' + week) % discoveryPool.length];
  const unused = candidates.filter(entry => entry.trackId !== weekly.trackId);
  const available = unused.length ? unused : candidates;
  const creatorPool = available.filter(goodGrade).length ? available.filter(goodGrade) : available;
  const daily = creatorPool[hash('daily:' + day) % creatorPool.length];
  const choices = [['daily', daily, day, day + 1], ['weekly', weekly, week, week + 7]];
  const remaining = () => candidates.filter(entry => !choices.some(choice => choice[1].trackId === entry.trackId));
  const critics = remaining().filter(goodGrade).sort((a, b) => grades.get(b.trackId) - grades.get(a.trackId) || a.trackId.localeCompare(b.trackId))[0] || remaining()[0];
  if (critics) choices.push(['critics', critics, week, week + 7]);
  const routes = remaining();
  if (routes.length) choices.push(['roulette', routes[hash('route:' + day) % routes.length], day, day + 1]);
  return choices.map(([kind, entry, start, end]) => ({
    kind, entry, startsAt: start * DAY, endsAt: end * DAY, players: countOf(entry), quality: grades.get(entry.trackId),
    pool: curated.length ? 'curated' : 'reviewed', underplayed: kind === 'weekly' && exact.length > 0,
    fallback: !curated.length || kind === 'weekly' && !exact.length,
    fallbackReason: kind === 'weekly' && !exact.length ? 'coverage-unavailable' : !curated.length ? 'reviewed-pool' : null
  }));
}
