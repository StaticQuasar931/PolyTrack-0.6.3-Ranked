const releaseInfo = {
  "number": 401,
  "version": "0.6.3",
  "revision": 343,
  "notes": [
    "Overall RP rank durations now use consecutive saved snapshot observations instead of reset rebuild timestamps.",
    "Rank history is compact, cached per snapshot and shared by rankings and racer profiles; local projected rank changes do not inherit old tenure.",
    "Kodub Track of the Week matches the other event card heights while fitting the full artwork horizontally.",
    "Installed dependencies are excluded from source changes. Existing snapshots, replay proofs and player saves are preserved.",
    "Release auditing now validates the exact release-394 geometry addition separately from the unchanged historical proof-review chain."
  ],
  "preparedAt": "2026-11-15T22:24:38.670Z",
  "committedAt": "2026-11-15T22:30:20.000Z"
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
