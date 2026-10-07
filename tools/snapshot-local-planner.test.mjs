import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';

const patch=await readFile(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
function functionSource(name){
  const start=patch.indexOf(`function ${name}(`);
  assert.notEqual(start,-1,`missing ${name}`);
  const brace=patch.indexOf('{',start);let depth=0,quote='',escape=false;
  for(let i=brace;i<patch.length;i++){
    const c=patch[i];
    if(quote){if(escape)escape=false;else if(c==='\\')escape=true;else if(c===quote)quote='';continue;}
    if(c==='"'||c==="'"||c==='`'){quote=c;continue;}
    if(c==='{')depth++;else if(c==='}'&&!--depth)return patch.slice(start,i+1);
  }
  throw new Error(`unterminated function ${name}`);
}
function makeHarness({snapshots,localRows,active='self',savedResults=new Map()}){
  const cleanUserId=value=>String(value||'').trim();
  const canonicalRaceTimeMs=row=>Number(row?.timeMs||0);
  const functions='const profileSnapshotResults=deps.savedResults;\n'+['localTrackDisplayEntries','visibleTrackEntries','localPlannerProfileEntry','cachedProfileFinishes'].map(functionSource).join('\n');
  const init=new Function('deps',`const {cleanUserId,canonicalRaceTimeMs,trackSnapshotStore,readLocalRaceRows,safeRecordingId,buildRecordingId,entryTimeMs,pbTimestamp,knownFinishWeight,overallLoadState,readOverallSnapshotCache,activeRankedAccountId,sortProfileFinishes,getLastKnownName}=deps;${functions};return {localPlannerProfileEntry,cachedProfileFinishes};`);
  return init({savedResults,cleanUserId,canonicalRaceTimeMs,trackSnapshotStore:()=>snapshots,readLocalRaceRows:()=>localRows,safeRecordingId:value=>value||'',buildRecordingId:()=> 'local-id',entryTimeMs:canonicalRaceTimeMs,pbTimestamp:row=>row.createdAt||0,knownFinishWeight:({rank,fieldSize})=>rank?fieldSize/rank:0,overallLoadState:{},readOverallSnapshotCache:()=>null,activeRankedAccountId:()=>active,sortProfileFinishes:rows=>rows,getLastKnownName:()=>''});
}

test('profile index supplies every saved finish without opening track boards',()=>{
  const results=Array.from({length:26},(_,i)=>({trackId:'track'+i,rank:2,fieldSize:20,timeMs:10000+i}));
  const h=makeHarness({snapshots:{},localRows:[],savedResults:new Map([['self',{updatedAt:100,results}]])});
  const finishes=h.cachedProfileFinishes('self',{raceCount:22});
  assert.equal(finishes.length,26);assert.ok(finishes.every(row=>row.rank>0&&row.fieldSize>=2));
});

test('older loaded board cannot downgrade indexed PB or placement',()=>{
  const h=makeHarness({snapshots:{track:{serverUpdatedAt:50,entries:[{accountId:'self',timeMs:20000,rank:1}]}},localRows:[],savedResults:new Map([['self',{updatedAt:100,results:[{trackId:'track',rank:2,fieldSize:20,timeMs:19000}]}]])});
  const [finish]=h.cachedProfileFinishes('self',{});assert.equal(finish.timeMs,19000);assert.equal(finish.fieldSize,20);
});
test('projects the active local PB into a loaded field and computes its current rank and weight',()=>{
  const h=makeHarness({snapshots:{track:{complete:true,serverUpdatedAt:10,entries:[{accountId:'rival',timeMs:21000,rank:1},{accountId:'self',timeMs:22000,rank:2}]}},localRows:[{accountId:'self',trackId:'track',timeMs:19000,createdAt:20}]});
  const result=h.cachedProfileFinishes('self',{});
  assert.equal(result.length,1);
  assert.deepEqual({rank:result[0].rank,fieldSize:result[0].fieldSize,timeMs:result[0].timeMs,weight:result[0].weight,local:result[0].local},{rank:1,fieldSize:2,timeMs:19000,weight:2,local:true});
});
test('new account local finish receives loaded placement without a cloud profile',()=>{
  const h=makeHarness({snapshots:{track:{complete:true,entries:[{accountId:'rival',timeMs:18000,rank:1}]}},localRows:[{accountId:'self',trackId:'track',timeMs:19000,createdAt:20}]});
  const profile=h.localPlannerProfileEntry('self');
  assert.equal(profile.localOnly,true);assert.equal(profile.resultSamples[0].rank,2);
  assert.equal(profile.resultSamples[0].fieldSize,2);assert.equal(profile.score,undefined);
});
test('saved overall summary cannot overwrite faster local placement',()=>{
  const h=makeHarness({snapshots:{track:{complete:true,entries:[{accountId:'rival',timeMs:21000,rank:1},{accountId:'self',timeMs:22000,rank:2}]}},localRows:[{accountId:'self',trackId:'track',timeMs:19000,createdAt:20}]});
  const [finish]=h.cachedProfileFinishes('self',{resultSamples:[{trackId:'track',timeMs:22000,rank:2,fieldSize:2}]});
  assert.equal(finish.rank,1);assert.equal(finish.timeMs,19000);
});
test('creates a synthetic profile only for the active account and labels it local-only',()=>{
  const h=makeHarness({snapshots:{},localRows:[]});
  assert.equal(h.localPlannerProfileEntry('rival'),null);
  assert.deepEqual(h.localPlannerProfileEntry('self'),{userId:'self',accountId:'self',name:'You',localOnly:true,resultSamples:[],raceCount:0});
});
