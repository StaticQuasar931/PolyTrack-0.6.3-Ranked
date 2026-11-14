import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {projectLocalOverall} from './overall-local-projection.mjs';
import {computeOverall, trackWeightParts} from '../workers/ranked/src/index.js';
import {EXTRA_TRACK_IDS} from '../workers/ranked/src/extra-track-ids.js';

const source = (await readFile(new URL('../workers/ranked/src/index.js', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
function functionText(text, name) {
  const start = text.search(new RegExp('^(?:export )?function ' + name + '\\(', 'm'));
  assert.ok(start >= 0, name);
  return text.slice(start, text.indexOf('\n}', start) + 2).replace(/^export /, '');
}
const ctx = vm.createContext({trackWeightParts});
vm.runInContext(['raceTime','median','competition','rankTrustedTrackEntries'].map(name => functionText(source, name)).join('\n'), ctx);
const rank = (rows, id) => JSON.parse(JSON.stringify(ctx.rankTrustedTrackEntries(rows, id)));
const official = JSON.parse(source.match(/^const OFFICIAL_IDS = new Set\((.*)\);/m)[1]);
const extra = [...EXTRA_TRACK_IDS][0];
const clone = value => JSON.parse(JSON.stringify(value));
const generation = 43;
const metadata = {generation, algorithmVersion:'participation-v8-s1', schemaVersion:6, sourceRevision:4912, builtRevision:4912, updatedAt:100000};
function board(trackId, rows) {
  return {...metadata, trackId, sourceComplete:true, totalEntriesExact:true, totalEntries:rows.length,
    entries:rank(rows.map(([accountId,timeMs,verified=true]) => ({accountId,userId:accountId,trackId,timeMs,pbAt:100,
      runVerified:verified,integrityVerified:verified})), trackId)};
}
function fixture(boards = official.slice(0,3).map((id, i) => board(id,[['a',10000+i*100],['b',12000+i*100],['c',14000+i*100]]))) {
  const entries = computeOverall(boards,[],new Set(),{includePlannerResults:true});
  return {accountId:'b',generation,tracks:boards,
    overall:{...metadata,sourceComplete:true,totalEntriesExact:true,totalEntries:entries.length,entries:clone(entries),trackCatalog:boards.map(row=>({trackId:row.trackId,updatedAt:row.updatedAt}))},
    results:{...metadata,resultBundleComplete:true,resultBoardLimitReached:false,resultBoardCount:boards.length,
      entries:entries.map(row=>({userId:row.userId,resultSamples:clone(row.resultSamples)}))},acceptedPbs:[]};
}
const receipt = (trackId, timeMs, rest={}) => ({accountId:'b',generation,trackId,timeMs,accepted:true,acceptedAt:200,...rest});
function assertOracle(input) {
  const expectedBoards=clone(input.tracks), best=new Map();
  for(const row of input.acceptedPbs) if(!best.has(row.trackId)||best.get(row.trackId).timeMs>row.timeMs) best.set(row.trackId,row);
  for(const [id,pb] of best) {
    const b=expectedBoards.find(item=>item.trackId===id), old=b.entries.find(item=>item.accountId===input.accountId);
    if(old&&(old.timeMs<pb.timeMs||old.timeMs===pb.timeMs&&old.runVerified&&old.integrityVerified))continue;
    b.entries=rank([...b.entries.filter(item=>item.accountId!==input.accountId),{...old,accountId:input.accountId,userId:input.accountId,
      trackId:id,timeMs:pb.timeMs,pbAt:pb.acceptedAt,runVerified:true,integrityVerified:true}],id);
  }
  const expected=computeOverall(expectedBoards,input.overall.entries,new Set(),{includePlannerResults:true});
  const actual=projectLocalOverall(input);
  assert.equal(actual.status,'projected',actual.reason);
  assert.equal(actual.racers.length,expected.length);
  for(const row of expected) {
    const got=actual.racers.find(item=>item.userId===row.userId);
    assert.equal(got.score,row.score);
    assert.equal(got.projectedRank,row.rank||null);
    assert.equal(got.raceCount,row.raceCount);
    assert.deepEqual(got.trackResults,row.resultSamples.map(({rank,...sample})=>({...sample,projectedRank:rank})));
  }
  return actual;
}

test('all mirrored scoring functions, catalogs and policy constants match the authoritative Worker',async()=>{
  const mirror=await readFile(new URL('./overall-local-projection.mjs',import.meta.url),'utf8');
  for(const name of ['safeText','raceTime','trackType','median','competition','trackWeightParts','extraWeightCap','placementCost','rankTitle','sanitizeProfileCosmetics','rankTrustedTrackEntries','finishSummary','computeOverall']) {
    assert.equal(functionText(mirror,name),functionText(source,name),name);
  }
  for(const name of ['ALGORITHM_VERSION','AVERAGE_PLACEMENT_VERSION','PROFILE_COSMETICS_VERSION','MIN_RANKED_TRACKS','PODIUM_MIN_FIELD','LEGACY_COMMUNITY_IDS','OFFICIAL_IDS','COMMUNITY_IDS']) {
    const regex=new RegExp('^const '+name+' = .*;','m');
    assert.equal(mirror.match(regex)?.[0],source.match(regex)?.[0],name);
  }
  const options=text=>{const start=text.indexOf('const PROFILE_COSMETIC_OPTIONS =');return text.slice(start,text.indexOf('\n});',start)+4);};
  assert.equal(options(mirror),options(source));
  const achievement=await readFile(new URL('../workers/ranked/src/server-achievements.js',import.meta.url),'utf8');
  assert.equal(mirror.match(/^const SPECIAL_ROLLING_HILLS_TRACK_ID = .*;/m)[0],achievement.match(/^export const SPECIAL_ROLLING_HILLS_TRACK_ID = .*;/m)[0].replace(/^export /,''));
});

test('an accepted improvement recalculates every racer and exactly matches the Worker',()=>{
  const input=fixture();input.acceptedPbs=[receipt(official[0],9000)];
  const output=assertOracle(input);
  assert.notEqual(output.racers.find(row=>row.userId==='a').score,input.overall.entries.find(row=>row.userId==='a').score);
  assert.equal(output.localPending,true);assert.equal(output.publicRank,null);
  assert.match(output.assumption,/verification/);
});
test('duplicate, out of order and slower accepted PBs coalesce to the best time',()=>{
  const input=fixture();input.acceptedPbs=[receipt(official[0],11000),receipt(official[0],9000),receipt(official[0],13000),receipt(official[0],9000)];
  assertOracle(input);
  assert.deepEqual(projectLocalOverall(input),projectLocalOverall({...input,acceptedPbs:[receipt(official[0],9000)]}));
});
test('equal or slower PBs, including receipts already in a newer snapshot, do not replace rows',()=>{
  const input=fixture();input.acceptedPbs=[receipt(official[0],12000),receipt(official[1],15000)];
  assert.equal(projectLocalOverall(input).status,'unchanged');
});
test('adding a participant changes the field size, competition and weights for every racer',()=>{
  const input=fixture();input.accountId='new';input.acceptedPbs=[receipt(official[0],11000,{accountId:'new'})];
  const result=assertOracle(input);
  assert.equal(result.projection.trackResults[0].fieldSize,4);
  assert.notEqual(result.racers.find(row=>row.userId==='a').trackResults[0].weight,input.results.entries.find(row=>row.userId==='a').resultSamples[0].weight);
});
test('a singleton track becomes eligible when the second racer joins',()=>{
  const input=fixture([board(official[0],[['a',10000]])]);input.acceptedPbs=[receipt(official[0],11000)];
  const result=assertOracle(input);assert.equal(result.racers.length,2);assert.equal(result.projection.projectedRank,null);
});
test('new participant on strongest official board changes Extra cap and every affected Extra score',()=>{
  const input=fixture([board(official[0],[['a',10000],['b',12000]]),board(official[1],[['c',10000],['d',20000]]),board(extra,[['a',10000],['b',12000],['c',14000]])]);
  input.accountId='new';input.acceptedPbs=[receipt(official[0],11000,{accountId:'new'})];
  const result=assertOracle(input);
  assert.notEqual(result.racers.find(row=>row.userId==='c').score,input.overall.entries.find(row=>row.userId==='c').score);
});
test('ties use exact Worker account ordering rather than shared competition ranks',()=>{
  const input=fixture();input.acceptedPbs=[receipt(official[0],10000)];
  const result=assertOracle(input);
  assert.equal(result.projection.trackResults[0].projectedRank,2);
});
test('pending snapshot rows remain excluded from Overall and hypothetical PBs never export verified flags',()=>{
  const input=fixture([board(official[0],[['a',10000],['b',12000],['pending',9000,false]])]);
  input.acceptedPbs=[receipt(official[0],9500)];const result=assertOracle(input);
  assert.equal(result.racers.some(row=>row.userId==='pending'),false);
  assert.doesNotMatch(JSON.stringify(result),/"(?:rank|runVerified|integrityVerified|badges|profileCosmetics)":/);
});
test('an accepted PB already published at the same time as pending is not promoted',()=>{
  const input=fixture([board(official[0],[['a',10000],['b',12000,false],['c',14000]])]);
  input.acceptedPbs=[receipt(official[0],12000)];
  const result=projectLocalOverall(input);assert.equal(result.status,'unchanged');
  assert.equal(input.tracks[0].entries.find(row=>row.accountId==='b').runVerified,false);
  assert.equal(input.tracks[0].entries.find(row=>row.accountId==='b').integrityVerified,false);
});
test('equal local run is not promoted when its snapshot row is explicitly unverified',()=>{
  const input=fixture([board(official[0],[['a',10000],['b',12000,false],['c',14000]])]);
  input.localPbs=[{accountId:'b',generation,trackId:official[0],timeMs:12000,observedAt:200}];
  const result=projectLocalOverall(input);assert.equal(result.status,'unchanged');
  assert.equal(input.tracks[0].entries.find(row=>row.accountId==='b').runVerified,false);
  assert.equal(input.tracks[0].entries.find(row=>row.accountId==='b').integrityVerified,false);
});
test('strictly faster local PB estimates past an older pending row without changing snapshot verification',()=>{
  const input=fixture([board(official[0],[['a',10000],['b',12000,false],['c',14000]])]);
  input.localPbs=[{accountId:'b',generation,trackId:official[0],timeMs:11000,observedAt:200}];
  const result=projectLocalOverall(input);assert.equal(result.status,'projected');
  assert.equal(result.localPbsApplied,true);assert.match(result.assumption,/provisional estimates/);
  assert.equal(result.projection.trackResults[0].timeMs,11000);
  assert.equal(input.tracks[0].entries.find(row=>row.accountId==='b').timeMs,12000);
  assert.equal(input.tracks[0].entries.find(row=>row.accountId==='b').runVerified,false);
  assert.equal(input.tracks[0].entries.find(row=>row.accountId==='b').integrityVerified,false);
  assert.doesNotMatch(JSON.stringify(result),/"(?:runVerified|integrityVerified)"\s*:\s*true/);
});
test('slower local PB never replaces a faster snapshot row regardless of snapshot flags',()=>{
  const input=fixture([board(official[0],[['a',10000],['b',11000,false],['c',14000]])]);
  input.localPbs=[{accountId:'b',generation,trackId:official[0],timeMs:12000,observedAt:200}];
  const result=projectLocalOverall(input);assert.equal(result.status,'unchanged');
  assert.equal(input.tracks[0].entries.find(row=>row.accountId==='b').timeMs,11000);
  assert.equal(input.tracks[0].entries.find(row=>row.accountId==='b').runVerified,false);
  assert.equal(input.tracks[0].entries.find(row=>row.accountId==='b').integrityVerified,false);
});
test('frozen caller objects are not mutated; no fetch or storage is used',()=>{
  const input=fixture();input.acceptedPbs=[receipt(official[0],9000)];const before=JSON.stringify(input);
  function freeze(value){if(value&&typeof value==='object'){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
  const oldFetch=globalThis.fetch;globalThis.fetch=()=>{throw Error('No network permitted');};
  try {assert.equal(projectLocalOverall(freeze(input)).status,'projected');}finally{globalThis.fetch=oldFetch;}
  assert.equal(JSON.stringify(input),before);
});
test('packed seven-field result tuples are supported without trusting summary-only finishes',()=>{
  const input=fixture();input.acceptedPbs=[receipt(official[0],9000)];
  const expected=projectLocalOverall(input),resultTracks=input.tracks.map(row=>row.trackId);
  input.results.resultTracks=resultTracks;
  input.results.entries=input.results.entries.map(row=>({userId:row.userId,resultData:JSON.stringify(row.resultSamples.map(sample=>[resultTracks.indexOf(sample.trackId),sample.rank,sample.fieldSize,sample.weight,sample.competition,sample.timeMs,sample.pbAt]))}));
  assert.deepEqual(projectLocalOverall(input),expected);
});
test('legacy complete track snapshots need no invented totalEntriesExact field',()=>{
  const input=fixture();input.acceptedPbs=[receipt(official[0],9000)];
  for(const board of input.tracks){delete board.totalEntriesExact;delete board.sourceComplete;board.complete=true;}
  assertOracle(input);
});
test('a bounded planner sidecar is sufficient when complete track rows validate every Overall racer',()=>{
  const input=fixture();input.acceptedPbs=[receipt(official[0],9000)];
  const expected=projectLocalOverall(input);input.results.entries=input.results.entries.slice(0,1);
  assert.deepEqual(projectLocalOverall(input),expected);
});

const failures=[
  ['other account receipt',i=>{i.acceptedPbs[0].accountId='other';},'receipt_account_mismatch'],
  ['old generation receipt',i=>{i.acceptedPbs[0].generation=42;},'receipt_generation_mismatch'],
  ['mixed track generation',i=>{i.tracks[0].generation=42;},'generation_mismatch'],
  ['mixed Overall generation',i=>{i.overall.generation=42;},'generation_mismatch'],
  ['unconfirmed local save',i=>{i.acceptedPbs[0].accepted=false;},'unconfirmed_receipt'],
  ['missing receipt time',i=>{i.acceptedPbs[0].acceptedAt=0;},'unconfirmed_receipt'],
  ['deleted run',i=>{i.acceptedPbs[0].deleted=true;},'unsupported_receipt_operation'],
  ['unbound result bundle',i=>{i.results.sourceRevision++;},'result_binding_mismatch'],
  ['unsupported algorithm',i=>{i.overall.algorithmVersion='future';},'unsupported_model'],
  ['unavailable planner bundle',i=>{i.results.resultBundleComplete=false;},'incomplete_track_catalog'],
  ['partial Overall board',i=>{i.overall.totalEntries++;},'incomplete_overall'],
  ['missing track',i=>{i.tracks.pop();},'incomplete_track_catalog'],
  ['missing source bindings',i=>{delete i.overall.trackCatalog;},'incomplete_track_bindings'],
  ['mixed track publication within one package',i=>{i.tracks[0].updatedAt++;},'track_binding_mismatch'],
  ['truncated source scan',i=>{i.results.resultBoardLimitReached=true;},'incomplete_track_catalog'],
  ['partial track board',i=>{i.tracks[0].totalEntries++;},'incomplete_track'],
  ['explicitly incomplete legacy board',i=>{i.tracks[0].sourceComplete=false;i.tracks[0].complete=true;},'incomplete_track'],
  ['duplicate account row',i=>{i.tracks[0].entries[1].accountId='a';i.tracks[0].entries[1].userId='a';},'incomplete_track'],
  ['invalid time',i=>{i.tracks[0].entries[0].timeMs=NaN;},'invalid_track_rows'],
  ['forged weight',i=>{i.tracks[0].entries[0].weight++;},'track_weight_mismatch'],
  ['unknown accepted track',i=>{i.acceptedPbs[0].trackId='unknown';},'missing_accepted_track'],
  ['foreign user results',i=>{i.results.entries[0].userId='foreign';},'invalid_results'],
  ['incomplete user finishes',i=>{i.results.entries[0].resultSamples.pop();},'baseline_mismatch'],
  ['stale public score',i=>{i.overall.entries[0].score++;},'baseline_mismatch'],
  ['stale finish timestamp',i=>{i.results.entries[0].resultSamples[0].pbAt++;},'baseline_mismatch'],
  ['duplicate source track',i=>{i.tracks[1]=clone(i.tracks[0]);},'invalid_track_catalog']
];
for(const [name,change,reason] of failures)test('unavailable: '+name,()=>{
  const input=fixture();input.acceptedPbs=[receipt(official[0],9000)];change(input);
  const result=projectLocalOverall(input);assert.equal(result.status,'unavailable');assert.equal(result.reason,reason);
  assert.equal(result.projection,null);assert.deepEqual(result.racers,[]);assert.equal(result.publicRank,null);
});
test('deterministic varied multi-track populations agree with the authoritative Worker',()=>{
  for(let seed=1;seed<=40;seed++) {
    const boards=[...official.slice(0,4),extra].map((id,t)=>board(id,Array.from({length:2+(seed+t)%8},(_,p)=>['u'+p,10000+((p*917+seed*73+t*631)%9000)])));
    const input=fixture(boards);input.accountId='u1';input.acceptedPbs=boards.map(b=>receipt(b.trackId,9000+seed,{accountId:'u1'}));
    assertOracle(input);
  }
});

test('Rolling Hills local PBs match the Worker whether they pass a racer or keep the same place',()=>{
  const rolling='fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
  for(const timeMs of [11000,9000]){
    const input=fixture([board(rolling,[['a',10000],['b',12000],['c',14000]]),
      ...official.slice(0,2).map(id=>board(id,[['a',10000],['b',12000],['c',14000]]))]);
    input.acceptedPbs=[receipt(rolling,timeMs)];
    const oracle=assertOracle(input);
    const local=projectLocalOverall({...input,acceptedPbs:[],localPbs:[{accountId:'b',generation,trackId:rolling,timeMs,observedAt:200}],includeCasual:false});
    assert.equal(local.status,'projected');assert.equal(local.projection.score,oracle.projection.score);
    assert.equal(local.projection.trackResults.find(row=>row.trackId===rolling).projectedRank,timeMs<10000?1:2);
    assert.equal(local.localPbsApplied,true);assert.equal(local.publicRank,null);
    assert.equal(local.casualIncluded,false);assert.ok(local.racers.every(row=>row.casualProjection===null));
    assert.deepEqual(local.racers.map(({casualProjection,...row})=>row),oracle.racers.map(({casualProjection,...row})=>row));
  }
});


test('local cosmetic normalization preserves current shop designs and Community badge',async()=>{
  const mirror=await readFile(new URL('./overall-local-projection.mjs',import.meta.url),'utf8');
  const options=mirror.match(/const PROFILE_COSMETIC_OPTIONS = Object\.freeze\(\{[\s\S]*?\n\}\);/)[0];
  const context=vm.createContext({OFFICIAL_IDS:new Set(official),COMMUNITY_IDS:new Set(),LEGACY_COMMUNITY_IDS:new Set(),EXTRA_TRACK_IDS:new Set()});
  vm.runInContext('const PROFILE_COSMETICS_VERSION=7;\n'+options+'\n'+functionText(mirror,'safeText')+'\n'+functionText(mirror,'sanitizeProfileCosmetics'),context);
  const design={version:7,theme:'classic',stage:'apex-observatory',plate:'pitlane-ticket',stripe:'vector-ribbon',badge:'community'};
  const actual=JSON.parse(JSON.stringify(context.sanitizeProfileCosmetics(design)));
  for(const slot of ['stage','plate','stripe','badge'])assert.equal(actual[slot],design[slot]);
  assert.equal(context.sanitizeProfileCosmetics({...design,badge:'administrator'}).badge,'auto');
});
