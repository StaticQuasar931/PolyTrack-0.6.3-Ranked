import {normalizeGroupFilter, hasGroupFilters, filterGroupRows,prepareGroupFilterData} from './filter-groups.mjs';

export const GROUP_FILTER_KEY = 'polytrack-advanced-filter-current-v1';
const idOf = row => String(row?.accountId || row?.userId || row?.publicId || '');
const timeOf = row => Number(row?.timeMs ?? row?.frames ?? row?.raceTimeFrames ?? 0);
const cost = (rank, size) => size < 2 ? 50 : 50 + (size - 1) / (size + 5) * (100 * (rank - 1) / (size - 1) - 50);

// Recalculate a presentation copy. Published scores and cached cloud rows stay immutable.
export function groupScoreRows(rows, boards, selectedIds, trackWeights = []) {
  const selected = new Set(selectedIds);
  const overrides = trackWeights instanceof Map ? trackWeights : new Map(
    (Array.isArray(trackWeights) ? trackWeights : []).filter(item => item && typeof item.trackId === 'string')
      .map(item => [item.trackId, item.weight])
  );
  const finishes = new Map();
  const missingWeights=new Set();
  for (const board of boards) {
    const entries = (board.entries || []).filter(row => selected.has(idOf(row)) && timeOf(row) > 0)
      .sort((a, b) => timeOf(a) - timeOf(b) || idOf(a).localeCompare(idOf(b)));
    const seen = new Set();
    const unique = entries.filter(row => { const id = idOf(row); if (seen.has(id)) return false; seen.add(id); return true; });
    let rank = 0;
    unique.forEach((entry, index) => {
      if (!index || timeOf(entry) !== timeOf(unique[index - 1])) rank = index + 1;
      const id = idOf(entry), weight = Number(overrides.has(board.trackId) ? overrides.get(board.trackId) : board.weight ?? entry.weight);
      if (!Number.isFinite(weight) || weight < 0) {missingWeights.add(id);return;}
      if(weight===0)return;
      if (!finishes.has(id)) finishes.set(id, []);
      const placementCost=cost(rank,unique.length);
      finishes.get(id).push({trackId:board.trackId, rank, fieldSize:unique.length, weight,
        placementCost,contribution:(100-placementCost)*weight,improvementValue:placementCost*weight,
        timeMs:timeOf(entry),pbAt:entry.pbAt,type:board.type || 'custom',complete:board.complete===true});
    });
  }
  return rows.map(row => {
    const results = finishes.get(idOf(row)) || [];
    if (!results.length) return {...row, globalScore:row.score, groupScore:null, groupScoreIncomplete:true};
    const best = [...results].sort((a,b) => a.placementCost-b.placementCost || b.weight-a.weight).slice(0,10);
    const weighted = list => list.reduce((sum,f) => sum+f.weight,0);
    const skill = best.reduce((sum,f) => sum+f.placementCost*f.weight,0) / weighted(best);
    const costs = results.map(f => f.placementCost).sort((a,b) => a-b);
    const middle = (costs[Math.floor((costs.length-1)/2)]+costs[Math.floor(costs.length/2)])/2;
    const ceiling = Math.min(82,middle+24);
    const consistency = results.reduce((sum,f) => sum+Math.min(ceiling,Math.max(5,f.placementCost))*f.weight,0)/weighted(results);
    const coverage = 100*Math.exp(-results.length/10);
    const score = Math.max(1.000001,.68*skill+.20*coverage+.12*consistency);
    return {...row, globalScore:row.score, groupScore:score, groupSkillCost:skill,
      groupConsistencyCost:consistency, groupResults:results,
      groupScoreIncomplete:missingWeights.has(idOf(row))||results.some(finish=>!finish.complete)||results.length < Number(row.raceCount || row.tracksCompleted || 0)};
  });
}

export function createFilterRuntime({storage, getData = () => ({}), onChange = () => {}}) {
  let filter;
  try { filter = normalizeGroupFilter(JSON.parse(storage?.getItem(GROUP_FILTER_KEY) || '{}')); }
  catch { filter = normalizeGroupFilter({}); }
  let revision = 0, lastDataKey, dataCache;
  const results = new WeakMap();
  function data() {
    const current = getData();
    if (!dataCache || current.key !== lastDataKey) { dataCache={...current,...prepareGroupFilterData(current)};lastDataKey=current.key; }
    return dataCache;
  }
  function apply(rows, context = {}) {
    const source = Array.isArray(rows) ? rows : [];
    const active = filter.enabled && hasGroupFilters(filter) && (context.overall || filter.scope === 'all');
    if (!active) return {rows:source,active:false,available:true,filter,sourceCount:source.length,filteredCount:source.length};
    const shared=data();
    const key=`${revision}|${shared.key}|${context.trackId || ''}|${context.event ? 1 : 0}|${context.overall ? 1 : 0}|${context.category || ''}|${context.complete ? 1 : 0}`;
    const saved=results.get(source);
    if(saved?.key===key)return saved.value;
    const result=filterGroupRows(source, filter, {...context,profileIndex:shared.profileIndex,finishIndex:shared.finishIndex,
      complete:(trackId,kind)=>kind==='track'?(shared.boards||[]).some(board=>board.trackId===trackId&&board.complete===true):context.complete===true});
    let output=result.rows;
    if (context.overall && !context.event && filter.mode==='smart') {
      const weightOverrides = new Map(filter.trackRules.filter(rule => rule.weight !== null).map(rule => [rule.trackId, rule.weight]));
      for (const override of filter.trackWeights) weightOverrides.set(override.trackId, override.weight);
      output=groupScoreRows(output, shared.boards || [], output.map(idOf), weightOverrides);
      const supported=['overall','skill','consistency','average','competitiveAverage','wins','medals','podiumRate','tracks','weight'];
      if(supported.includes(context.category || 'overall')) {
        output=output.map(row=>{
          const fs=row.groupResults || [], eligible=fs.filter(f=>f.fieldSize>=5&&f.type!=='custom');
          const medals={gold:0,silver:0,bronze:0};
          for(const f of eligible)if(f.rank<=3)medals[f.rank===1?'gold':f.rank===2?'silver':'bronze']++;
          const byPlace=[...fs].sort((a,b)=>a.rank-b.rank||b.fieldSize-a.fieldSize),byContribution=[...fs].sort((a,b)=>b.contribution-a.contribution);
          return {...row,score:row.groupScore ?? row.score,skillCost:row.groupSkillCost ?? row.skillCost,
            consistencyCost:row.groupConsistencyCost ?? row.consistencyCost,medals,
            trackWins:medals.gold,podiumRate:eligible.length>=3?(medals.gold+medals.silver+medals.bronze)/eligible.length*100:0,
            podiumEligibleTracks:eligible.length,competitiveAveragePlacement:eligible.length?eligible.reduce((s,f)=>s+f.rank,0)/eligible.length:null,competitiveAverageEligibleTracks:eligible.length,
            averagePlacement:fs.length?fs.reduce((s,f)=>s+f.rank,0)/fs.length:null,
            raceCount:fs.length,weightedTracks:fs.reduce((s,f)=>s+f.weight,0),
            resultSamples:fs,bestTracks:byPlace.slice(0,2),weightedResults:byContribution.slice(0,2),strongestTrack:byContribution[0]||null,
            worstTrack:[...fs].sort((a,b)=>b.placementCost-a.placementCost)[0]||null,
            opportunityTracks:fs.filter(f=>f.rank>1).sort((a,b)=>b.improvementValue-a.improvementValue).slice(0,3),
            bestTrackId:byPlace[0]?.trackId,bestTrackRank:byPlace[0]?.rank,bestTrackField:byPlace[0]?.fieldSize,
            officialCount:fs.filter(f=>f.type==='official').length,communityCount:fs.filter(f=>f.type==='community').length,customCount:fs.filter(f=>f.type==='custom').length};
        });
        const field={overall:'groupScore',skill:'groupSkillCost',consistency:'groupConsistencyCost',average:'averagePlacement',competitiveAverage:'competitiveAveragePlacement',wins:'trackWins',podiumRate:'podiumRate',tracks:'raceCount',weight:'weightedTracks'}[context.category || 'overall'];
        const descending=['wins','medals','podiumRate','tracks','weight'].includes(context.category);
        output.sort((a,b)=>{
          const metric=row=>context.category==='medals'?row.medals.gold*9+row.medals.silver*3+row.medals.bronze:row[field];
          const x=metric(a),y=metric(b);
          if(x==null||y==null)return Number(x==null)-Number(y==null);
          return (descending?y-x:x-y)||idOf(a).localeCompare(idOf(b));
        });
        output=output.map(row=>({...row,groupRankingMetric:context.category==='medals'?row.medals.gold*9+row.medals.silver*3+row.medals.bronze:row[field]}));
      }
    }
    if(context.event && context.trackId && filter.mode==='smart' && Number(context.maxRp)>0){
      const fastest=Math.min(...output.map(timeOf).filter(time=>time>0));
      output=output.map(row=>({...row,globalRp:row.rp,groupRp:timeOf(row)>0?Math.min(Number(context.maxRp),Math.floor(Number(context.maxRp)*fastest/timeOf(row))):0}));
    }
    const groupGrading=filter.grading==='group';
    let rank=0;
    output=output.map((row,index)=>{
      const previous=output[index-1];
      const tie=(context.trackId && previous && timeOf(previous)===timeOf(row)) ||
        (context.overall&&context.event&&previous&&row.rp!=null&&row.rp===previous.rp) ||
        (context.overall&&filter.mode==='smart'&&previous&&row.groupRankingMetric!=null&&row.groupRankingMetric===previous.groupRankingMetric) ||
        (context.overall&&filter.mode==='normal'&&previous&&row.categoryRank!=null&&row.categoryRank===previous.categoryRank);
      if(!tie)rank=index+1;
      return {...row,globalRank:row.globalRank ?? row.rank ?? row.position ?? index+1,
        filteredRank:groupGrading?rank:null,filteredTotal:output.length,groupRank:rank,
        ...((context.trackId||context.event)?{rank:groupGrading?rank:(row.globalRank??row.rank??row.position??index+1),position:groupGrading?rank:(row.globalRank??row.rank??row.position??index+1)}:{})};
    });
    const value={...result,rows:output,available:true,active:true,filter,filteredCount:output.length,
      incomplete:result.incomplete || context.complete!==true || output.some(row=>row.groupScoreIncomplete),groupGrading,
      scoringUnavailable:filter.mode==='smart'&&context.event&&!context.trackId};
    results.set(source,{key,value});
    return value;
  }
  return {apply,getFilter:()=>filter,getRevision:()=>revision,
    setFilter(input){filter=normalizeGroupFilter({...input,createdAt:normalizeGroupFilter(input).createdAt ?? Date.now()});revision++;try{storage?.setItem(GROUP_FILTER_KEY,JSON.stringify(filter));}catch{}onChange(filter);return filter;},
    markLoaded(timestamp=Date.now()){filter=normalizeGroupFilter({...filter,loadedAt:timestamp});revision++;try{storage?.setItem(GROUP_FILTER_KEY,JSON.stringify(filter));}catch{}onChange(filter);return filter;},
    toggle(){return this.setFilter({...filter,enabled:!filter.enabled});},
    invalidate(){lastDataKey=undefined;dataCache=undefined;revision++;},
    active:()=>filter.enabled && hasGroupFilters(filter)};
}
