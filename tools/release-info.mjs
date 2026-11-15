const releaseInfo = {
  "number": 404,
  "version": "0.6.3",
  "revision": 346,
  "notes": [
    "Rank time is now one clear line, such as 2 days at #8 or Up 3 with the time at that rank. Removed first-observation and duplicate movement filler.",
    "Event cards load a small cached standings preview matched to the exact event period and PB. No stale rank is borrowed for a newer local time.",
    "Weekly PB time and placement share a row. Kodub details and typography remain readable across artwork shapes.",
    "Event previews regenerate with snapshot publication, retain recent complete boards within a bounded file, and never grant verification or Event RP."
  ],
  "preparedAt": "2026-11-15T23:27:53.212Z",
  "committedAt": "2026-11-15T23:29:52.000Z"
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
