export const CASUAL_RP_MIN_PER_TRACK = 10;
export const CASUAL_RP_MAX_PER_TRACK = 100;

// Exact canonical formula; parity-tested against the Worker, not a new RP policy.
export function casualRpForPlacement(rank, fieldSize, weight) {
  if (!Number.isSafeInteger(rank) || !Number.isSafeInteger(fieldSize) || rank < 1 || fieldSize < rank ||
      !Number.isFinite(weight) || weight < 0) return null;
  const percentile = fieldSize === 1 ? 0 : (fieldSize - rank) / (fieldSize - 1);
  return Number(((CASUAL_RP_MIN_PER_TRACK + (CASUAL_RP_MAX_PER_TRACK - CASUAL_RP_MIN_PER_TRACK) * percentile) * weight).toFixed(3));
}

export function readPublishedCasual(entry){
  const casual=entry?.serverAchievements?.casual;
  const valid=n=>typeof n==='number'&&Number.isFinite(n)&&n>=0;
  const rp=valid(entry?.casualRp)?entry.casualRp:valid(casual?.rp)?casual.rp:null;
  const count=Number.isSafeInteger(entry?.casualCompletionCount)&&entry.casualCompletionCount>=0?entry.casualCompletionCount:
    Number.isSafeInteger(casual?.count)&&casual.count>=0?casual.count:null;
  return casual?.scoringVersion===2&&rp!==null&&count!==null
    ?{known:true,value:rp,count,source:'published-v2'}:{known:false,value:null,count,source:'unavailable'};
}

export function projectCasualRp({accountId,boards,eligibleTrackIds,officialTrackIds,extraTrackIds=[],
  priorEntry=null,sourceComplete=false}={}){
  const unknown=reason=>({known:false,casualRp:null,officialCasualRp:null,casualCompletionCount:null,
    officialCasualCompletionCount:null,trackResults:[],localPending:true,publicRank:null,reason});
  if(!accountId||sourceComplete!==true||!Array.isArray(boards)||!Array.isArray(eligibleTrackIds)||!Array.isArray(officialTrackIds))return unknown('incomplete_source');
  const eligible=new Set(eligibleTrackIds),official=new Set(officialTrackIds),extra=new Set(extraTrackIds),seen=new Set();
  const trusted=r=>r?.runVerified===true&&r?.integrityVerified===true;
  let strongest=0;
  for(const board of boards){
    const complete=board?.sourceComplete===true||board?.sourceComplete===undefined&&board?.complete===true;
    if(!board?.trackId||seen.has(board.trackId)||!complete||board.totalEntriesExact===false||
      !Number.isSafeInteger(board.totalEntries)||!Array.isArray(board.entries)||board.entries.length!==board.totalEntries)return unknown('incomplete_board');
    seen.add(board.trackId);
    if(!extra.has(board.trackId))for(const row of board.entries.filter(trusted))if(typeof row.weight==='number'&&Number.isFinite(row.weight)&&row.weight>strongest)strongest=row.weight;
  }
  const trackResults=[];
  for(const board of boards){
    if(!eligible.has(board.trackId))continue;
    const best=new Map();
    for(const row of board.entries.filter(trusted)){
      const id=String(row.accountId||row.userId||'');
      if(!id||!Number.isSafeInteger(row.timeMs)||row.timeMs<=0)return unknown('invalid_trusted_placement');
      const previous=best.get(id);if(!previous||row.timeMs<previous.timeMs)best.set(id,row);
    }
    const field=[...best.entries()].sort((a,b)=>a[1].timeMs-b[1].timeMs||a[0].localeCompare(b[0]));
    const at=field.findIndex(([id])=>id===String(accountId));if(at<0)continue;
    const own=field[at][1],rank=field.findIndex(([,row])=>row.timeMs===own.timeMs)+1;
    // Missing/null weight is unavailable, while explicit numeric zero is a real zero award.
    const publishedWeight=typeof own.weight==='number'?own.weight:NaN;
    const weight=extra.has(board.trackId)?Math.min(strongest>0?strongest/5:.2,publishedWeight):publishedWeight;
    const rp=casualRpForPlacement(rank,field.length,weight);
    if(rp===null)return unknown('missing_weight');
    trackResults.push({trackId:board.trackId,projectedRank:rank,fieldSize:field.length,weight,rp,official:official.has(board.trackId)});
  }
  const prior=readPublishedCasual(priorEntry);
  const priorRp=priorEntry?.casualRp??priorEntry?.serverAchievements?.casual?.rp;
  const priorCount=priorEntry?.casualCompletionCount??priorEntry?.serverAchievements?.casual?.count;
  if(Number.isSafeInteger(priorCount)&&priorCount>trackResults.length||
    typeof priorRp==='number'&&Number.isFinite(priorRp)&&priorRp>0&&trackResults.length===0)return unknown('historical_completions_missing');
  // A positive published total with missing count is not enough to reconstruct a historical ledger.
  if(!prior.known&&typeof priorRp==='number'&&priorRp>0&&!Number.isSafeInteger(priorCount))return unknown('historical_count_unavailable');
  const sum=rows=>Number(rows.reduce((n,r)=>n+r.rp,0).toFixed(3)),officialRows=trackResults.filter(r=>r.official);
  return {known:true,casualRp:sum(trackResults),officialCasualRp:sum(officialRows),
    casualCompletionCount:trackResults.length,officialCasualCompletionCount:officialRows.length,
    trackResults,localPending:true,publicRank:null,reason:'snapshot_counterfactual_not_published'};
}
