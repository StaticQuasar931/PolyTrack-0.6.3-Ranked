import {readPublishedCasual} from './casual-rp-model.mjs';
import {EXTRA_TRACK_IDS} from '../workers/ranked/src/extra-track-ids.js';
export const SCOPED_AVERAGE_EXTRA_TRACK_IDS=Object.freeze([...EXTRA_TRACK_IDS]);

export const ROLLING_HILLS_ID='fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
export function rankedMetricState(entry,{category,scope='total',finishes=[],complete=false,
  officialTrackIds=[],recognizedTrackIds=[],communityTrackIds=[],extraTrackIds=[],casualProjection=null}={}){
  const unknown={known:false,value:null,reason:'complete_scoped_data_unavailable'};
  if(category==='average'){
    if(!['total','official','community','extra'].includes(scope))return unknown;
    if(scope==='total')return Number(entry?.averagePlacementVersion)>=2&&Number.isFinite(entry?.averagePlacement)&&entry.averagePlacement>0
      ?{known:true,value:entry.averagePlacement,count:entry.raceCount,reason:'published_average'}:unknown;
    if(complete!==true||entry?.sourceComplete===false||entry?.localOnly||Array.isArray(entry?.groupResults)||
      !Number.isSafeInteger(entry?.raceCount)||entry.raceCount<0||!Array.isArray(finishes)||finishes.length!==entry.raceCount||
      finishes.some(f=>!f?.trackId||!Number.isSafeInteger(f.rank)||f.rank<1||!Number.isSafeInteger(f.fieldSize)||f.fieldSize<Math.max(2,f.rank)||
        ['local','localPending','pending'].some(key=>f[key]===true)||
        ['sourceComplete','complete','ranksExact','totalEntriesExact','runVerified','integrityVerified'].some(key=>f[key]===false))||
      new Set(finishes.map(f=>f.trackId)).size!==finishes.length)return unknown;
    const ids=new Set(scope==='official'?officialTrackIds:scope==='community'?communityTrackIds:extraTrackIds);
    const eligible=finishes.filter(f=>f.fieldSize>=5&&ids.has(f.trackId));
    if(!eligible.length)return {...unknown,count:0,reason:'no_eligible_scoped_results'};
    return {known:true,value:eligible.reduce((sum,f)=>sum+f.rank,0)/eligible.length,count:eligible.length,reason:'complete_scoped_average'};
  }
  if(!['wins','casual'].includes(category)||!['total','official'].includes(scope))return unknown;
  const official=new Set(officialTrackIds),recognized=new Set(recognizedTrackIds);
  if(category==='casual'){
    if(Array.isArray(entry?.groupResults)&&casualProjection?.groupScoped!==true)return unknown;
    if(casualProjection?.known===true){
      const value=scope==='official'?casualProjection.officialCasualRp:casualProjection.casualRp;
      const count=scope==='official'?casualProjection.officialCasualCompletionCount:casualProjection.casualCompletionCount;
      return typeof value==='number'&&Number.isFinite(value)&&value>=0&&Number.isSafeInteger(count)&&count>=0
        ?{known:true,value,count,localPending:casualProjection.localPending!==false,reason:casualProjection.localPending===false?'snapshot_scoped_calculation':'local_counterfactual'}:unknown;
    }
    return scope==='total'?readPublishedCasual(entry):unknown;
  }
  if(scope==='total'&&!Array.isArray(entry?.groupResults)&&Number.isSafeInteger(entry?.trackWins)&&entry.trackWins>=0)return {known:true,value:entry.trackWins,reason:'published_total'};
  if(complete!==true||!Array.isArray(finishes)||finishes.some(f=>!f?.trackId||!Number.isSafeInteger(f.rank)||f.rank<1||
    !Number.isSafeInteger(f.fieldSize)||f.fieldSize<f.rank)||new Set(finishes.map(f=>f.trackId)).size!==finishes.length)return unknown;
  const value=finishes.filter(f=>f.rank===1&&f.fieldSize>=5&&recognized.has(f.trackId)&&
    (scope==='total'||official.has(f.trackId))).length;
  return {known:true,value,reason:'complete_scoped_finishes'};
}

export function compareRankedMetrics(left,right,leftState,rightState){
  if(leftState.known!==rightState.known)return leftState.known?-1:1;
  if(leftState.known&&leftState.value!==rightState.value)return rightState.value-leftState.value;
  return (Number(left.rank)||Infinity)-(Number(right.rank)||Infinity)||String(left.userId||left.accountId||'').localeCompare(String(right.userId||right.accountId||''));
}

export function rankingScopeMarkup(category,scope='total'){
  if(!['wins','casual','average'].includes(category))return '';
  const choices=category==='average'?[['total','All'],['official','Official'],['community','Community'],['extra','Extra']]:[['total','Total'],['official','Official only']];
  return '<div id="overallRankingScope" class="overall-track-scope" role="group" aria-label="Ranking track scope">'+
    choices.map(([key,label])=>'<button type="button" data-ranking-scope="'+key+
      '" aria-pressed="'+String(scope===key)+'" class="'+(scope===key?'active':'')+'">'+label+'</button>').join('')+'</div>';
}
