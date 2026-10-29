import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const patchSource=fs.readFileSync(path.join(root,'polytrack_062_patch.js'),'utf8');
const workerSource=fs.readFileSync(path.join(root,'workers/ranked/src/index.js'),'utf8');

function extractFunction(name){
  const match=patchSource.match(new RegExp(`  (?:async )?function ${name}\\([^\\n]*\\)\\{[\\s\\S]*?\\n  \\}`));
  assert.ok(match,`expected ${name} in the patch`);
  return match[0];
}

function localProgress({rows=[],known={},rankedIds=[],unrankedIds=[],active='me'}={}){
  const context={
    cleanUserId:value=>String(value||'').toLowerCase(),
    activeRankedAccountId:()=>active,
    extraTrackIds:()=>known,
    extraTrackInfoById:new Map(rankedIds.map(id=>[id,{}])),
    unrankedExtraTrackIds:new Set(unrankedIds),
    localRaceGeneration:0,
    localExtraProgressCache:{key:'',count:0},
    readLocalRaceRows:()=>rows,
    canonicalRaceTimeMs:row=>Number(row?.timeMs||row?.recordTimeMs||0)
  };
  return vm.runInNewContext(`${extractFunction('localExtraTrackCount')}\nlocalExtraTrackCount(entry)`,{...context,entry:{userId:active}});
}

function normalize(entries){
  const context={
    safeServerNumber:value=>value===null||value===undefined||value===''?null:Number.isFinite(Number(value))&&Number(value)>=0?Number(value):null,
    safeServerInteger:value=>Number.isSafeInteger(value)&&value>=0?value:null,
    TOTAL_TRACKS:254,
    normalizeCarColorId:value=>value,
    extractCarId:()=>'',
    normalizeFinishSummary:()=>null,
    fallbackMedals:()=>({gold:0,silver:0,bronze:0}),
    fallbackAverageFinish:()=>0,
    fallbackPodiumRate:()=>0,
    SERVER_COSMETIC_UNLOCK_IDS:new Set(),
    sanitizeServerAchievements:()=>null,
    MIN_RANKED_TRACKS:8,
    sanitizeProfileCosmetics:()=>({}),
    __pt062NormalizeStyle:()=>'',
    __pt062GetRememberedStyle:()=>''
  };
  return vm.runInNewContext(`${extractFunction('normalizeEntries')}\nnormalizeEntries(entries)`,{...context,entries});
}

test('local Extra cosmetics require a saved timed run, not import alone',()=>{
  const trackA='a'.repeat(64),trackB='b'.repeat(64);
  const known={first:trackA,second:trackB};
  assert.equal(localProgress({known,rankedIds:[trackA,trackB],rows:[]}),0);
  assert.equal(localProgress({known,rankedIds:[trackA,trackB],rows:[{accountId:'me',trackId:trackA,timeMs:0}]}),0);
  assert.equal(localProgress({known,rankedIds:[trackA,trackB],rows:[{accountId:'me',trackId:trackA,timeMs:NaN}]}),0);
});

test('local Extra progress counts distinct saved ranked-track proofs for the active racer only',()=>{
  const trackA='a'.repeat(64),trackB='b'.repeat(64),challenge='c'.repeat(64),unlisted='d'.repeat(64);
  const known={first:trackA,second:trackB,challenge};
  const rows=[
    {accountId:'me',trackId:trackA,timeMs:12000},
    {accountId:'me',trackId:trackA,timeMs:11900},
    {userId:'me',trackId:trackB,recordTimeMs:15100},
    {accountId:'me',trackId:challenge,timeMs:9000},
    {accountId:'me',trackId:unlisted,timeMs:8000},
    {accountId:'other',trackId:trackB,timeMs:7000}
  ];
  assert.equal(localProgress({known,rankedIds:[trackA,trackB,challenge],unrankedIds:[challenge],rows}),2);
  assert.equal(localProgress({known,rankedIds:[trackA,trackB],rows,active:'other'}),1);
});

test('local Extra progress scans saved rows once per generation and import mapping',()=>{
  const trackA='a'.repeat(64),trackB='b'.repeat(64);
  const state={known:{one:trackA},rows:[{userId:'me',trackId:trackB,timeMs:14000}],scanCount:0};
  const context={
    cleanUserId:value=>String(value||''),activeRankedAccountId:()=> 'me',
    extraTrackIds:()=>state.known,extraTrackInfoById:new Map([[trackA,{}],[trackB,{}]]),
    unrankedExtraTrackIds:new Set(),localRaceGeneration:0,localExtraProgressCache:{key:'',count:0},
    readLocalRaceRows:()=>{state.scanCount++;return state.rows},canonicalRaceTimeMs:row=>Number(row.timeMs||0),state
  };
  const count=vm.runInNewContext(`${extractFunction('localExtraTrackCount')}\nconst first=localExtraTrackCount({userId:'me'});const second=localExtraTrackCount({userId:'me'});state.known={one:'${trackA}',two:'${trackB}'};const imported=localExtraTrackCount({userId:'me'});localRaceGeneration++;const refreshed=localExtraTrackCount({userId:'me'});({first,second,imported,refreshed,scans:state.scanCount})`,context);
  assert.deepEqual({...count},{first:0,second:0,imported:1,refreshed:1,scans:3});
});

test('server extraCount and local proof are combined for preview unlocks',()=>{
  const local=extractFunction('localExtraTrackCount');
  const unlocked=extractFunction('cosmeticUnlocked');
  const track='a'.repeat(64);
  const context={
    cleanUserId:value=>String(value||''),
    activeRankedAccountId:()=> 'me',
    extraTrackIds:()=>({one:track}),
    extraTrackInfoById:new Map([[track,{}]]),
    unrankedExtraTrackIds:new Set(),
    localRaceGeneration:0,
    localExtraProgressCache:{key:'',count:0},
    readLocalRaceRows:()=>[{userId:'me',trackId:track,timeMs:12000}],
    canonicalRaceTimeMs:row=>Number(row.timeMs||0)
  };
  const source=`${local}\n${unlocked}\ncosmeticUnlocked`;
  const cosmeticUnlocked=vm.runInNewContext(source,context);
  assert.equal(cosmeticUnlocked('extra:1',{userId:'me',extraCount:0}),true);
  assert.equal(cosmeticUnlocked('extra:3',{userId:'me',extraCount:2}),false);
  assert.equal(cosmeticUnlocked('extra:3',{userId:'me',extraCount:3}),true);
});

test('normalization preserves finite nonnegative server Extra progress and rejects invalid values',()=>{
  const rows=normalize([{userId:'me',extraCount:2},{userId:'zero',extraCount:0},{userId:'bad',extraCount:-1},{userId:'infinite',extraCount:Infinity}]);
  assert.deepEqual(rows.map(row=>row.extraCount),[2,0,null,null]);
  assert.match(extractFunction('normalizeEntries'),/extraCount:\s*safeServerNumber\(entry\.extraCount\)/);
});

test('local preview remains device-local while the Worker validates publication',()=>{
  assert.match(extractFunction('resolveCosmeticsForEntry'),/readJsonStorage\(PROFILE_COSMETICS_KEY,null\)/);
  assert.match(extractFunction('saveRankedProfileCosmetics'),/queueCosmeticPublish\(safeId,user\.uid,cosmetics\)/);
  assert.match(extractFunction('flushPendingCosmeticPublishes'),/\/v1\/profile\/cosmetics/);
  const propagation=workerSource.slice(workerSource.indexOf('async function propagateProfileCosmetics('),workerSource.indexOf('async function processProfileJob('));
  const handler=workerSource.slice(workerSource.indexOf('async function updateProfileCosmetics('),workerSource.indexOf('async function completeCosmeticJob('));
  assert.match(propagation,/if\s*\(!profileCosmeticsUnlocked\(cosmetics,\s*entry,\s*betaTester\)\)\s*return false/);
  assert.match(handler,/if\s*\(!await propagateProfileCosmetics\(env,\s*accountId,\s*profile,\s*cosmetics,\s*issuedBeta\)\)\s*return json\(origin,\s*env,\s*403,\s*\{\s*error:\s*'cosmetic_locked'\s*\}\)/);
});

test('the ranked Extra catalog IDs and Worker registry remain aligned',()=>{
  const catalog=JSON.parse(fs.readFileSync(path.join(root,'extra-tracks/catalog.json'),'utf8'));
  const registry=fs.readFileSync(path.join(root,'workers/ranked/src/extra-track-ids.js'),'utf8');
  const registered=new Set([...registry.matchAll(/[a-f0-9]{64}/g)].map(match=>match[0]));
  const ranked=catalog.filter(entry=>entry.ranked!==false);
  assert.equal(ranked.length,254);
  assert.deepEqual(ranked.filter(entry=>!registered.has(entry.trackId)).map(entry=>entry.id),[]);
  assert.deepEqual([...registered].filter(id=>!ranked.some(entry=>entry.trackId===id)),[]);
});

test('Racer Studio tab and Name choice labels allow responsive wrapping',()=>{
  assert.match(patchSource,/\.studio-tab\{[^}]*white-space:normal[^}]*word-break:normal[^}]*overflow-wrap:anywhere/s);
  assert.match(patchSource,/\.studio-panel\[data-studio-panel="name"\] \.profile-cosmetic-choice>b\{[^}]*overflow-wrap:break-word/s);
  assert.match(patchSource,/@media\(max-width:600px\)\{\.studio-panel\[data-studio-panel="name"\] \.profile-cosmetic-group>div\{grid-template-columns:repeat\(2,minmax\(0,1fr\)\)!important\}/);
});

test('Overall normalization retains every public racer beyond the former 200-row preview',()=>{
 const entries=Array.from({length:531},(_,i)=>({userId:'racer-'+i,name:'Racer',rank:i+1,score:100+i,raceCount:8}));
 const normalized=normalize(entries);assert.equal(normalized.length,531);assert.equal(normalized.at(-1).userId,'racer-530');
});
