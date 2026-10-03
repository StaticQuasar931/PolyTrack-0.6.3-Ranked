export function utcEventCandidates(at, officialIds, allIds) {
  if (!Number.isSafeInteger(at) || at < 0 || !officialIds.length || !allIds.length) throw Error('Invalid event registry/clock');
  const day = Math.floor(at / 86400000) * 86400000;
  const monday = day - ((new Date(day).getUTCDay() + 6) % 7) * 86400000;
  const key = ms => new Date(ms).toISOString().slice(0, 10).replaceAll('-', '');
  const hash = value => { let result = 2166136261; for (let i = 0; i < value.length; i++) result = Math.imul(result ^ value.charCodeAt(i), 16777619); return result >>> 0; };
  const rotation = ids => [...new Set(ids)].sort((a, b) => hash(a) - hash(b) || (a < b ? -1 : a > b ? 1 : 0));
  const official = rotation(officialIds);
  const community = rotation(allIds.filter(id => !officialIds.includes(id)));
  const dailyIndex = Math.floor(day / 86400000);
  const weeklyIndex = Math.floor(monday / 604800000);
  return [
    ...(community.length ? [{ id: 'd_' + key(day), kind: 'daily', startsAt: day, endsAt: day + 86400000, maxRp: 100, trackId: community[dailyIndex % community.length] }] : []),
    { id: 'w_' + key(monday), kind: 'weekly', startsAt: monday, endsAt: monday + 7 * 86400000, maxRp: 500, trackId: official[weeklyIndex % official.length] }
  ];
}

export function scheduledCatalog(registry, published, at=Date.now()) {
  const candidates=utcEventCandidates(at,registry.officialIds,registry.allIds);
  const periods=(Array.isArray(published?.periods)?published.periods:[])
    .filter(p=>p&&Number.isSafeInteger(p.startsAt)&&Number.isSafeInteger(p.endsAt)&&p.startsAt<=at&&at<p.endsAt);
  for(const candidate of candidates)if(!periods.some(p=>p.id===candidate.id))periods.push({
    ...candidate,graceMs:86400000,entrantLimit:200,scheduleOnly:true,
    label:`${candidate.kind==='daily'?'Daily':'Weekly'} ${new Date(candidate.startsAt).toISOString().slice(0,10)}`
  });
  return {periods,archives:Array.isArray(published?.archives)?published.archives:[],
    updatedAt:Number(published?.updatedAt)||at,scheduleVersion:registry.version};
}
