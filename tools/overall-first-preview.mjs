// Validated transport slices still need the normal client's scoring-model fence.
export function prepareOverallFirstPreview(value,normalize,{model,schema,averageFinish,averagePlacement}){
  if(value?.kind!=='overall-preview'||value.previewSize!==15||value.offset!==0||value.ranksExact!==true||
    value.algorithmVersion!==model||!Number.isSafeInteger(value.schemaVersion)||value.schemaVersion<schema||!Array.isArray(value.entries)||!value.entries.length||
    value.entries.length>15||value.count!==value.entries.length||!Number.isSafeInteger(value.publishedEntries)||
    value.publishedEntries<value.entries.length||!Number.isSafeInteger(value.updatedAt)||value.updatedAt<0)return null;
  const ids=value.entries.map(row=>row?.userId||row?.accountId);
  if(ids.some(id=>typeof id!=='string'||!id)||new Set(ids).size!==ids.length||value.entries.some(row=>
    row.rankModel!==model||!Number.isSafeInteger(row.rank)||row.rank<1||!Number.isFinite(row.score)||row.score<1||
    !(row.averageFinishVersion>=averageFinish)||!(row.averagePlacementVersion>=averagePlacement)))return null;
  const entries=normalize(value.entries);
  if(entries.length!==value.entries.length||entries.some((row,i)=>row.userId!==ids[i]||row.rank!==value.entries[i].rank||row.score!==value.entries[i].score))return null;
  // This is deliberately not persisted or passed through the full-board loader.
  return {entries,meta:{status:'loading',preview:true,message:'First racers loaded; loading remaining standings',
    fetchedAt:value.updatedAt,serverUpdatedAt:value.updatedAt,sourceRevision:value.sourceRevision,
    complete:false,totalEntries:value.totalEntries,totalEntriesExact:value.totalEntriesExact===true,
    publishedEntries:value.publishedEntries,ranksExact:true}};
}
