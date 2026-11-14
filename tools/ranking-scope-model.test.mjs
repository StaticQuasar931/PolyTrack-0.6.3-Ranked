import test from 'node:test';
import assert from 'node:assert/strict';
import {rankedMetricState,compareRankedMetrics,rankingScopeMarkup,ROLLING_HILLS_ID} from './ranking-scope-model.mjs';
const options={officialTrackIds:['official',ROLLING_HILLS_ID],recognizedTrackIds:['official',ROLLING_HILLS_ID,'community']};
const finishes=[{trackId:'official',rank:1,fieldSize:5},{trackId:ROLLING_HILLS_ID,rank:1,fieldSize:5},
  {trackId:'community',rank:1,fieldSize:5},{trackId:'custom',rank:1,fieldSize:100},{trackId:'small',rank:1,fieldSize:4}];

test('Total versus Official-only wins preserve eligibility, including established RHR official scope',()=>{
  assert.equal(rankedMetricState({}, {...options,category:'wins',scope:'total',finishes,complete:true}).value,3);
  assert.equal(rankedMetricState({}, {...options,category:'wins',scope:'official',finishes,complete:true}).value,2);
  assert.equal(rankedMetricState({trackWins:5},{...options,category:'wins',scope:'total'}).value,5);
  assert.equal(rankedMetricState({trackWins:5},{...options,category:'wins',scope:'official'}).value,null);
});
test('missing official samples remain N/A rather than sample count or a fabricated zero',()=>{
  assert.equal(rankedMetricState({}, {...options,category:'wins',scope:'official',finishes:finishes.slice(0,1),complete:false}).known,false);
  assert.equal(rankedMetricState({}, {...options,category:'wins',scope:'official',finishes:[],complete:true}).value,0);
});
test('all categories x scopes x complete/partial x group/public contexts remain isolated',()=>{
  let combinations=0;
  const categories=['events','overall','casual','skill','consistency','pbs','playtime','veterans','rising','wins','medals','tracks','weight','average','competitiveAverage','podiumRate','topTracks','official','community'];
  for(const category of categories)for(const scope of ['total','official'])for(const complete of [false,true])for(const group of [false,true]){
    const entry={trackWins:3,serverAchievements:{casual:{scoringVersion:2,rp:0,count:0}},...(group?{groupResults:finishes.slice(0,1)}:{})};
    const opts={...options,category,scope,finishes:group?finishes.slice(0,1):finishes,complete};
    const state=rankedMetricState(entry,opts);
    if(!['wins','casual'].includes(category))assert.equal(state.known,false);
    else if(group&&category==='casual')assert.equal(state.known,false);
    else if(scope==='total'&&(!group||complete))assert.equal(state.known,true);
    else if(category==='casual'||!complete)assert.equal(state.known,false);
    else assert.equal(state.value,group?1:2);
    const markup=rankingScopeMarkup(category,scope);
    assert.equal(Boolean(markup),['wins','casual','average'].includes(category));
    if(markup){assert.match(markup,category==='average'?/All/:/Total/);assert.match(markup,category==='average'?/Community/:/Official only/);assert.equal((markup.match(/aria-pressed="true"/g)||[]).length,1);}
    combinations++;
  }
  assert.equal(combinations,152);
});
test('official Casual RP uses only complete scoped projection; zero and missing sort differently',()=>{
  const projection={known:true,casualRp:12,casualCompletionCount:2,officialCasualRp:0,officialCasualCompletionCount:0};
  const state=rankedMetricState({}, {...options,category:'casual',scope:'official',casualProjection:projection});
  assert.equal(state.value,0);assert.equal(state.localPending,true);
  assert.ok(compareRankedMetrics({rank:50},{rank:1},state,{known:false,value:null})<0);
  assert.equal(compareRankedMetrics({rank:1},{rank:2},{known:true,value:5},{known:true,value:10}),5);
});
