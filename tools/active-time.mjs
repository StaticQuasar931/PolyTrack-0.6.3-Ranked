export function formatActiveTime(value) {
  const input = Number(value);
  const milliseconds = Number.isFinite(input) && input > 0 ? input : 0;
  if (milliseconds >= 100 * 60 * 60 * 1000) return (milliseconds / 86400000).toFixed(1) + 'd';
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours
    ? hours + 'h ' + minutes % 60 + 'm ' + seconds % 60 + 's'
    : minutes
      ? minutes + 'm ' + seconds % 60 + 's'
      : seconds + 's';
}
