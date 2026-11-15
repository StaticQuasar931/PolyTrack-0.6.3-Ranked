const releaseInfo = {
  "number": 405,
  "version": "0.6.3",
  "revision": 347,
  "notes": [
    "Snapshot publication validates payload hashes with eight bounded local readers instead of serial reads, preserving complete inventory and corruption checks.",
    "Failed reads stop new work and wait for all in-flight readers to finish. Identical payload bindings are checked once.",
    "This is preparation only: no snapshot acquisition, Firebase calls or replay verification was started.",
    "Retains the clear rank-duration line, cached event standings previews and same-row PB placement from release404."
  ],
  "preparedAt": "2026-11-15T23:31:22.275Z",
  "committedAt": "2026-11-15T23:33:51.000Z"
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
