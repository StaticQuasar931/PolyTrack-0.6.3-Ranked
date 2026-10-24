export function mergeWeeklySelections(history, ...candidates) {
  const records = new Map();
  for (const value of [...(Array.isArray(history) ? history : []), ...candidates]) {
    if (!/^[a-f0-9]{64}$/.test(value?.trackId || '') || !Number.isFinite(Date.parse(value.endTime)) ||
        typeof value.name !== 'string' || !value.name.trim() || value.name.length > 256 ||
        !/^assets\/[a-f0-9]{64}\.track$/.test(value.trackUrl || '')) continue;
    const key = value.endTime;
    if (records.has(key) && records.get(key).trackId !== value.trackId) throw Error('Conflicting captured weekly selection.');
    const fields = ['trackId','name','author','lastModified','environment','endTime','trackUrl','thumbnailUrl','coverUrl'];
    records.set(key, Object.fromEntries(fields.filter(field => value[field] !== undefined).map(field => [field,value[field]])));
  }
  if (records.size > 520) throw Error('Weekly selection history exceeds capacity; preserve it before continuing.');
  return [...records.values()].sort((a,b) => Date.parse(a.endTime)-Date.parse(b.endTime));
}
