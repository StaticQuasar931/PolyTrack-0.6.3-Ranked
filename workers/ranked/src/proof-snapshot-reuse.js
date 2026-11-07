function timestampKey(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?Z$/.exec(value);
  if (!match || match[1].startsWith('0000-')) return null;
  const ms = Date.parse(match[1] + 'Z');
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== match[1]) return null;
  return match[1] + '.' + (match[2] || '').padEnd(9, '0') + 'Z';
}

// A fresh existing document last changed no later than the snapshot has the
// same contents at that snapshot. Missing documents cannot establish history.
export function proofVersionAtOrBefore(document, readTime) {
  const version = timestampKey(document?.updateTime), snapshot = timestampKey(readTime);
  return version !== null && snapshot !== null && version <= snapshot;
}
