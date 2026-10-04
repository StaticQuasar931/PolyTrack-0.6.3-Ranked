export function mergeKodubHistory(history, ...selections) {
  const records=new Map();
  for(const value of [...(Array.isArray(history)?history:[]),...selections]){
    if(!/^[a-f0-9]{64}$/.test(value?.trackId||'')||typeof value.name!=='string'||!value.name||value.name.length>200||!/^assets\/[a-f0-9]{64}\.webp$/.test(value.thumbnailUrl||''))continue;
    records.set(value.trackId,{trackId:value.trackId,name:value.name,thumbnailUrl:value.thumbnailUrl});
  }
  return [...records.values()].slice(-520);
}
