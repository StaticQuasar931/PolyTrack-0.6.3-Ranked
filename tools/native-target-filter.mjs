export function nativeTargetTrackIds(targetScope, value) {
  if (value === undefined) return undefined;
  if (!['events','all','normal'].includes(targetScope) || !Array.isArray(value) || value.length < 1 || value.length > 512 ||
      value.some(id => typeof id !== 'string' || !/^[a-f0-9]{64}$/.test(id)) || new Set(value).size !== value.length)
    throw Error('Native target filter: unique exact event track IDs required');
  return Object.freeze([...value].sort());
}
