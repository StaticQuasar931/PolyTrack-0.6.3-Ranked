const HASH=/^[a-f0-9]{64}$/;
const PERIOD_ID=/^[a-zA-Z0-9_-]{1,128}$/;
const ROLLING_ID='permanent-rolling-hills';
const ROLLING_TRACK='fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
export const EVENT_HIGHLIGHT_LIMITS=Object.freeze({accounts:10000,boards:1024,rowsPerBoard:10000,totalRows:1000000});
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const hash=value=>typeof value==='string'&&HASH.test(value);
const name=value=>typeof value==='string'?value.replace(/[<>\u0000-\u001f\u007f]/g,'').trim().slice(0,120):'';

function metadata(board,key){
  if(board.period!==undefined&&(!board.period||typeof board.period!=='object'||Array.isArray(board.period)))return null;
  const period=board?.period||board;
  if(!period||typeof period.id!=='string'||!PERIOD_ID.test(period.id)||!hash(period.trackId)||
    !['permanent','kodub','weekly','daily','custom'].includes(period.kind)||
    key!==undefined&&key!==period.id||
    ['id','trackId','kind'].some(field=>board[field]!==undefined&&board[field]!==period[field])||
    period.maxRp!==undefined&&!integer(period.maxRp))return null;
  if(period.id===ROLLING_ID||period.kind==='permanent'){
    if(period.id!==ROLLING_ID||period.kind!=='permanent'||period.trackId!==ROLLING_TRACK)return null;
  }else if(!board.period||!integer(period.startsAt)||!integer(period.endsAt)||period.endsAt<=period.startsAt)return null;
  return period;
}

function verified(row){
  return ['pending','playbackPending','needsReview','reviewHold'].every(field=>row?.[field]===undefined||row[field]===false)&&
    ['verified','runVerified','integrityVerified','physicsVerified','replayIntegrityVerified','eventRpEligible'].every(field=>row?.[field]===undefined||row[field]===true)&&
    !['status','verificationStatus'].some(field=>row?.[field]!==undefined&&row[field]!=='verified');
}

function validEntry(row,period){
  return row&&hash(row.accountId)&&(row.userId===undefined||row.userId===row.accountId)&&Number.isSafeInteger(row.timeMs)&&row.timeMs>0&&row.timeMs<=300000&&
    integer(row.rp)&&(!integer(period.maxRp)||row.rp<=period.maxRp)&&
    ['periodId','eventId'].every(field=>row[field]===undefined||row[field]===period.id)&&
    (row.trackId===undefined||row.trackId===period.trackId)&&
    ['runId','replayHash'].every(field=>row[field]===undefined||hash(row[field]))&&
    ['frames','raceTimeFrames'].every(field=>row[field]===undefined||row[field]===row.timeMs);
}

function exactCoverage(board){
  const pages=board.pagination;
  return board.complete===true&&(board.sourceComplete===undefined||board.sourceComplete===true)&&
    (board.publicationPending===undefined||board.publicationPending===false)&&
    (board.totalEntries===undefined||board.totalEntries===board.entries.length)&&
    (pages===undefined||!!pages&&typeof pages==='object'&&!Array.isArray(pages)&&
      (pages.hasMore===undefined||pages.hasMore===false)&&(pages.complete===undefined||pages.complete===true)&&
      (pages.totalEntries===undefined||pages.totalEntries===board.entries.length));
}

function rollingMatchesTotal(row,entry){
  return ['permanentRollingHillsRp','rollingHillsEventRpContribution'].every(field=>row[field]===undefined||row[field]===entry.rp)&&
    (row.rollingHillsTimeMs===undefined||row.rollingHillsTimeMs===entry.timeMs);
}

function eventRpBudget(total,rolling=null){
  const finite=total.finiteEventRp,components=[total.permanentRollingHillsRp,total.rollingHillsEventRpContribution].filter(value=>value!==undefined);
  if(!integer(total.rp)||finite!==undefined&&!integer(finite)||components.some(value=>!integer(value))||
    components.some(value=>value!==components[0]))return null;
  const knownRolling=components[0]??rolling?.eventRp;
  if(knownRolling!==undefined&&knownRolling>total.rp||finite!==undefined&&finite>total.rp||
    knownRolling!==undefined&&finite!==undefined&&finite>total.rp-knownRolling)return null;
  return {rollingLimit:total.rp-(finite??0),finiteLimit:finite!==undefined?finite:
    knownRolling!==undefined?total.rp-knownRolling:null};
}

const finiteOrder=(a,b)=>b.eventRp-a.eventRp||Number(b.kind==='kodub')-Number(a.kind==='kodub')||
  a.periodId.localeCompare(b.periodId)||a.trackId.localeCompare(b.trackId);

/**
 * buildEventRpHighlights({totalsRows, boards}) -> Map<accountId, Highlight[]>.
 * boards is an array of captured public event boards, or Map<periodId, board>.
 * Each finite board has period:{id,kind,trackId,startsAt,endsAt,trackName?}.
 * Rolling Hills may instead use its published top-level id/kind/trackId.
 * entries is the published verified lane, including legacy rows without flags;
 * explicit negative proof/status flags and all pendingPlaybacks are excluded.
 *
 * Highlight has ONLY {kind,periodId,trackId,name,eventRp,rank,fieldSize}.
 * At most two: Rolling Hills first when bound, then the highest saved finite ERP.
 * Without Rolling Hills, use the best two finite events. Kodub wins equal ERP only.
 * Rank is competition rank in the complete verified field, not all entrants.
 * Partial/uncertain boards return rank:null,fieldSize:null, never a guessed field.
 * ERP is copied from a saved row, never calculated or added to totals. No I/O.
 * Highlights must fit the aggregate and finite ERP budgets together. Known RH
 * contributions remain reserved even without its board. finiteEventRp is used
 * when present; otherwise finite budget is rp minus the known RH contribution.
 * Without either component evidence or a bound RH result, finite budget is
 * unknown and finite highlights are omitted, not funded by assuming RH is zero.
 * Invalid/duplicate board identities are omitted, never merged across captures.
 * Limits are exported; oversized input throws rather than silently truncating.
 * Arrays and highlights are frozen; inputs are never modified. Render names as text.
 */
export function buildEventRpHighlights({totalsRows=[],boards=[]}={}){
  if(!Array.isArray(totalsRows)||!(Array.isArray(boards)||boards instanceof Map))throw new TypeError('Invalid event highlight inputs');
  if(totalsRows.length>EVENT_HIGHLIGHT_LIMITS.accounts||boards.size>EVENT_HIGHLIGHT_LIMITS.boards||boards.length>EVENT_HIGHLIGHT_LIMITS.boards)
    throw new RangeError('Event highlight input limit exceeded');
  const totals=new Map(),duplicateAccounts=new Set();
  for(const row of totalsRows){
    const accountId=row?.accountId||row?.userId;
    if(!hash(accountId)||row.accountId&&row.userId&&row.accountId!==row.userId||!integer(row.rp))continue;
    if(totals.has(accountId))duplicateAccounts.add(accountId);
    totals.set(accountId,row);
  }
  for(const accountId of duplicateAccounts)totals.delete(accountId);
  const candidates=new Map(),duplicates=new Set();let totalRows=0;
  for(const [key,board] of boards instanceof Map?boards:boards.map(board=>[undefined,board])){
    if(!board||!Array.isArray(board.entries))continue;
    totalRows+=board.entries.length;
    if(board.entries.length>EVENT_HIGHLIGHT_LIMITS.rowsPerBoard||totalRows>EVENT_HIGHLIGHT_LIMITS.totalRows)
      throw new RangeError('Event highlight row limit exceeded');
    const period=metadata(board,key);if(!period)continue;
    if(candidates.has(period.id)){duplicates.add(period.id);continue;}
    candidates.set(period.id,{board,period});
  }
  const found=new Map([...totals.keys()].map(accountId=>[accountId,{rolling:null,finite:[]}]));
  for(const [periodId,{board,period}] of candidates){
    if(duplicates.has(periodId))continue;
    const entries=[],seen=new Set();let exact=exactCoverage(board),duplicate=false;
    for(const row of board.entries){
      if(!verified(row))continue;
      if(!validEntry(row,period)){exact=false;continue;}
      if(seen.has(row.accountId)){duplicate=true;break;}
      seen.add(row.accountId);entries.push(row);
    }
    if(duplicate)continue;
    entries.sort((a,b)=>a.timeMs-b.timeMs||a.accountId.localeCompare(b.accountId));
    let rank=0;
    for(const [index,row] of entries.entries()){
      if(!index||row.timeMs!==entries[index-1].timeMs)rank=index+1;
      const total=totals.get(row.accountId);if(!total||integer(total.rp)&&row.rp>total.rp)continue;
      const rolling=periodId===ROLLING_ID;
      if(rolling){const budget=eventRpBudget(total);if(!budget||row.rp>budget.rollingLimit||!rollingMatchesTotal(total,row))continue;}
      const highlight=Object.freeze({kind:period.kind,periodId,trackId:period.trackId,
        name:rolling?'Rolling Hills Racer':name(period.trackName)||name(period.label)||({kodub:'Kodub weekly',weekly:'Weekly event',daily:'Daily event',custom:'Event'}[period.kind]),
        eventRp:row.rp,rank:exact?rank:null,fieldSize:exact?entries.length:null});
      const account=found.get(row.accountId);
      if(rolling)account.rolling=highlight;
      else account.finite.push(highlight);
    }
  }
  return new Map([...found].map(([accountId,{rolling,finite}])=>{
    const budget=eventRpBudget(totals.get(accountId),rolling),selected=[];
    if(budget){
      if(rolling)selected.push(rolling);
      let remaining=budget.finiteLimit;
      if(remaining!==null)for(const highlight of finite.sort(finiteOrder)){
        if(highlight.eventRp>remaining)continue;
        selected.push(highlight);remaining-=highlight.eventRp;if(selected.length===2)break;
      }
    }
    return [accountId,Object.freeze(selected)];
  }));
}
