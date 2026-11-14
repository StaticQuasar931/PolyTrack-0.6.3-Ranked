import {decodeProjectionResults} from './overall-projection-bundle.mjs';

// These are the published scoring lanes, not normal-board or locally estimated ranks.
export async function buildPlannerScoringSource(overall, packed) {
  return buildScoringIndex(overall, packed, await decodeProjectionResults(packed));
}

// The bound manifest and complete compact results replace all Overall page downloads.
export async function buildPlannerScoringSourceFromManifest(manifest, packed) {
  const metadata=manifest?.boardMetadata;
  if(manifest?.kind!=='overall-manifest'||manifest.complete!==true||manifest.sourceComplete!==true||
    manifest.ranksExact!==true||manifest.totalEntriesExact!==true||!Number.isSafeInteger(manifest.totalEntries)||
    !metadata||metadata.totalEntries!==manifest.totalEntries||metadata.complete!==true||metadata.ranksExact!==true||['algorithmVersion','schemaVersion','sourceRevision','updatedAt'].some(key=>manifest[key]!==metadata[key]))
    throw Error('Incomplete planner manifest');
  const decoded=await decodeProjectionResults(packed);
  if(decoded.entries.length!==manifest.totalEntries)throw Error('Missing scoring profiles');
  const entries=decoded.entries.map(row=>{
    const tuples=typeof row.resultData==='string'?JSON.parse(row.resultData):null;
    if(!Array.isArray(tuples))throw Error('Missing scoring results');
    return {userId:row.userId,raceCount:tuples.length};
  });
  return buildScoringIndex({...metadata,entries},packed,decoded);
}

function buildScoringIndex(overall, packed, decoded) {
  if(overall?.complete!==true||overall.sourceComplete===false||overall.totalEntriesExact===false||overall.ranksExact!==true||
    !Array.isArray(overall.entries)||overall.entries.length>10000||
    !['algorithmVersion','schemaVersion','sourceRevision','builtRevision','updatedAt'].every(k=>overall[k]===packed?.[k]))
    throw Error('Planner scoring source is incomplete or mixed');
  const tracks=decoded.resultTracks;
  if(new Set(tracks).size!==tracks.length||tracks.some(id=>typeof id!=='string'||!id))throw Error('Invalid scoring tracks');
  const packedRows=new Map(decoded.entries.map(row=>[row.userId,row]));
  if(packedRows.size!==decoded.entries.length)throw Error('Duplicate scoring profile');
  const profiles=new Map(), boards=new Map();
  for(const entry of overall.entries){
    const id=entry.userId||entry.accountId;
    if(typeof id!=='string'||!id||profiles.has(id)||!Number.isSafeInteger(entry.raceCount)||entry.raceCount<0)throw Error('Invalid scoring profile');
    const data=packedRows.get(id)?.resultData;
    const tuples=data===undefined&&entry.raceCount===0?[]:typeof data==='string'?JSON.parse(data):null;
    if(!Array.isArray(tuples)||tuples.length!==entry.raceCount||tuples.length>500)throw Error('Missing complete scoring results');
    const seen=new Set(), finishes=[];
    for(const tuple of tuples){
      if(!Array.isArray(tuple)||tuple.length!==7)throw Error('Invalid scoring result');
      const [index,rank,fieldSize,weight,competition,timeMs,pbAt]=tuple,trackId=tracks[index];
      if(!Number.isSafeInteger(index)||!trackId||seen.has(trackId)||!Number.isSafeInteger(rank)||rank<1||
        !Number.isSafeInteger(fieldSize)||fieldSize<Math.max(2,rank)||![weight,competition].every(v=>Number.isFinite(v)&&v>0)||!Number.isSafeInteger(timeMs)||timeMs<1||
        !Number.isSafeInteger(pbAt)||pbAt<0)throw Error('Invalid scoring result');
      seen.add(trackId);
      const finish={trackId,rank,fieldSize,weight,competition,timeMs,pbAt,cachedAt:overall.updatedAt};
      finishes.push(finish);
      let board=boards.get(trackId);
      if(!board){board={trackId,complete:true,sourceComplete:true,ranksExact:true,totalEntriesExact:true,totalEntries:fieldSize,updatedAt:overall.updatedAt,entries:[]};boards.set(trackId,board);}
      if(board.totalEntries!==fieldSize||(board.entries.length>0&&(board.entries[0].weight!==weight||board.entries[0].competition!==competition)))throw Error('Mixed scoring field');
      board.entries.push({...finish,accountId:id,runVerified:true,integrityVerified:true});
    }
    profiles.set(id,finishes);
  }
  const fields=[];
  for(const board of boards.values()){
    board.entries.sort((a,b)=>a.rank-b.rank);
    if(board.entries.some((row,i)=>i>0&&(row.timeMs<board.entries[i-1].timeMs||
      row.timeMs===board.entries[i-1].timeMs&&row.accountId.localeCompare(board.entries[i-1].accountId)<0)))
      throw Error('Contradictory scoring placement');
    if(board.entries.length!==board.totalEntries||board.entries.some((row,i)=>row.rank!==i+1))throw Error('Incomplete scoring field');
    fields.push({trackId:board.trackId,fieldSize:board.totalEntries,weight:board.entries[0].weight,competition:board.entries[0].competition,updatedAt:overall.updatedAt});
  }
  return {profiles,boards,fields};
}
