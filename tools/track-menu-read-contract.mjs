export function trackMenuReadContract(source) {
  const start = source.indexOf('async function loadTrackEntries(');
  const end = source.indexOf('function computeOverallFromRaceRows(', start);
  if (start < 0 || end <= start) return ['Track menu read contract is missing.'];
  const loader = source.slice(start, end);
  const failures = [];
  if (!/\.collection\(COLLECTIONS\.leaderboardsTrack\)\.doc\(safeTrackId\)/.test(loader)) {
    failures.push('Blocked edge fallback is missing the one-document published track snapshot.');
  }
  if (/\bfetchCanonicalTrackEntries\s*\(|COLLECTIONS\.raceResults/.test(loader)) {
    failures.push('Track menu reads must not rebuild boards by downloading canonical race documents.');
  }
  return failures;
}
