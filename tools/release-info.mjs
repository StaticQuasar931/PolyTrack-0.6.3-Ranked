const releaseInfo = {
  "number": 238,
  "version": "0.6.3",
  "revision": 207,
  "notes": [
    "Official tracks stay visible when a saved search has no official matches; other tabs keep filtering.",
    "Ranking search supports score, rank and playtime comparisons, combined with racer names.",
    "Search focus and clear buttons use cleaner native styling.",
    "Help and Release use more room, larger text and clearer control groups.",
    "Update notices use native buttons; no-update snapshot checks shake without adding visible text.",
    "Search and quick filters operate on loaded snapshots without additional Firebase reads.",
    "Repeated missing-page lookups and redundant cosmetic retry writes are reduced."
  ],
  "preparedAt": "2026-10-29T05:02:08.229Z"
};
Object.freeze(releaseInfo.notes);
export const RELEASE_INFO = Object.freeze(releaseInfo);

// This is a recorded preparation instant, never an inferred Git publication date.
export function parseReleasePreparedAt(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0 && new Date(time).toISOString() === value ? time : null;
}

export function releaseAge(preparedAt, now = Date.now()) {
  const time = parseReleasePreparedAt(preparedAt);
  if (time === null || !Number.isFinite(now)) return {text:'Preparation time not recorded', nextUpdateMs:null};
  const elapsed = now - time;
  if (elapsed < 0) return {text:'Device clock is before preparation time', nextUpdateMs:Math.min(-elapsed, 60000)};
  const unit = elapsed >= 604800000 ? ['week',604800000] : elapsed >= 86400000 ? ['day',86400000] : elapsed >= 3600000 ? ['hour',3600000] : ['minute',60000];
  const count = Math.floor(elapsed / unit[1]);
  return {text:count ? `${count} ${unit[0]}${count === 1 ? '' : 's'} ago` : 'Less than a minute ago', nextUpdateMs:Math.min(unit[1] - elapsed % unit[1], 60000)};
}
