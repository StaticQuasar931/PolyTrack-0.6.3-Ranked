const DAY = 86400000;

// These are the exact IDs and settlement windows produced by the provisioners.
// Unknown/custom IDs fail closed instead of looking up an archive in Firestore.
export function liveEventWindow(id, now) {
  if (!Number.isSafeInteger(now) || now < 0) return false;
  let start, end;
  const dated = /^([dw])_(\d{4})(\d{2})(\d{2})$/.exec(id);
  if (dated) {
    start = Date.parse(`${dated[2]}-${dated[3]}-${dated[4]}T00:00:00Z`);
    if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10).replaceAll('-', '') !== dated.slice(2).join('') ||
        dated[1] === 'w' && new Date(start).getUTCDay() !== 1) return false;
    end = start + (dated[1] === 'd' ? DAY : 7 * DAY);
  } else {
    const kodub = /^kodub_([1-9]\d{0,15})$/.exec(id);
    if (!kodub) return false;
    end = Number(kodub[1]);
    if (!Number.isSafeInteger(end)) return false;
    start = end - 7 * DAY;
  }
  return start >= 0 && now >= start && now < end + DAY;
}

export function staticEventRead(pathname, now = Date.now()) {
  const month = /^\/v1\/events\/archives\/(\d{6})$/.exec(pathname);
  if (month) return {month: month[1]};
  const event = /^\/v1\/events\/([A-Za-z0-9_-]{1,64})\/(snapshot(?:\/page)?|replays\/[a-f0-9]{64}|playbacks\/[a-f0-9]{64}|track|receipt|runs\/[a-f0-9]{64})$/.exec(pathname);
  if (!event || event[1] === 'permanent-rolling-hills' && event[2] === 'snapshot') return null;
  if (event[2] !== 'track' && liveEventWindow(event[1], now)) return null;
  return {periodId: event[1]};
}
