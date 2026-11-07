const positive = n => typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0;
const day = 86400000;
const date = (n, at) => positive(n) && n <= at ? n : 0;

/** Device-local prompts, never an ability estimate or a promise of points. */
export function localPracticeSuggestions(rows = [], {
  at = Date.now(), results = [], routes = [], limit = 3
} = {}) {
  if (!Array.isArray(rows) || !Number.isFinite(at)) return [];
  const suggestions = [];
  const bestKnown = new Map(), lastPb = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    if (!result?.trackId || !positive(result.timeMs)) continue;
    bestKnown.set(result.trackId, Math.min(bestKnown.get(result.trackId) || Infinity, result.timeMs));
    lastPb.set(result.trackId, Math.max(lastPb.get(result.trackId) || 0, date(result.pbAt, at)));
  }
  const routeByTrack = new Map();
  for (const route of Array.isArray(routes) ? routes : []) {
    if (route?.simulationComplete !== true || !positive(route.value) ||
      !Number.isSafeInteger(route.targetRank) || route.targetRank < 1) continue;
    const prior = routeByTrack.get(route.trackId);
    if (!prior || route.value > prior.value || route.value === prior.value && route.targetRank > prior.targetRank)
      routeByTrack.set(route.trackId, route);
  }
  for (const row of rows) {
    if (!row?.trackId || !(row.attempts >= 3) || !(row.activeMs >= 60000)) continue;
    const best = Math.min(...[row.bestMs, row.trackedBestMs, bestKnown.get(row.trackId)].filter(positive));
    const last = Math.max(date(row.lastPlayedAt, at), date(row.lastPbAt, at), lastPb.get(row.trackId) || 0);
    const recent = (Array.isArray(row.recentFinishes) ? row.recentFinishes : [])
      .filter(run => positive(run?.timeMs) && run.timingNote !== true &&
        date(run.at, at) > at - 30 * day).sort((a,b) => a.at - b.at || a.timeMs - b.timeMs).slice(-8);
    const route = routeByTrack.get(row.trackId);
    if (!positive(row.finishes) && !Number.isFinite(best) && !recent.length && route) {
      suggestions.push({trackId: row.trackId, kind: 'unfinished', factor: 1,
        priority: 3, value: route.value, targetRank: route.targetRank,
        text: 'No local finish yet; aim for #' + route.targetRank + ' to reach the saved points target.'});
    } else if (last && at - last >= 7 * day) {
      const days = Math.floor((at - last) / day);
      suggestions.push({trackId: row.trackId, kind: 'stale', factor: 1.1, priority: 2, value: days,
        text: 'Last practised ' + days + ' days ago; try a baseline run before chasing a PB.'});
    } else if (recent.length >= 4 && new Set(recent.map(run => run.at)).size >= 4 && Number.isFinite(best)) {
      const times = recent.map(run => run.timeMs).sort((a,b) => a-b);
      const median = times[Math.floor(times.length / 2)];
      if ((times.at(-1) - times[0]) / median <= .02 && median - best >= Math.max(10, best * .002)) {
        suggestions.push({trackId: row.trackId, kind: 'consistent', factor: 1, priority: 1, value: median - best,
          text: 'Consistent finishes above your known PB; compare one section with your best run.'});
      }
    }
  }
  const unique = new Map();
  for (const suggestion of suggestions.sort((a,b) => b.priority-a.priority || b.value-a.value ||
    String(a.trackId).localeCompare(String(b.trackId)) || a.text.localeCompare(b.text))) {
    if (!unique.has(suggestion.trackId)) unique.set(suggestion.trackId, suggestion);
  }
  return [...unique.values()].slice(0, Number.isSafeInteger(limit) && limit >= 0 ? limit : 3);
}
