import { verificationKey, verifiedVerdict, VERIFIER_VERSION, VERIFIER_ENGINE_DIGEST } from '../src/verification.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import { rebuildOverall, mergeCanonicalResultIntoTrack, computeOverall, computeTrackEntries, handleRequest, migrateExtraVerificationQueues, profileCosmeticsUnlocked, reconcileCanonicalChanges, sanitizeProfileCosmetics, trackSnapshotIsCurrent, trackWeightParts } from '../src/index.js';
import {EXTRA_TRACK_IDS} from '../src/extra-track-ids.js';

const TRACK = '5803f9e963625804e3de3246d043dc7dde847aa32e991f7f7326b0453f1fa038';
const COMMUNITY_TRACK = '5159a8dac6a1f397407a7b5233ad570613531f6609f7dc897490c28c9f2c7a4e';
const CUSTOM_TRACK = 'f'.repeat(64);
const validRun = (row) => ({ replay: 'structural-replay', replayHash: 'a'.repeat(64), raceTimeFrames: row.timeMs, uploadId: 123, integrityVerified: true, runVerified: true, ...row });
const acceptedVerdict = row => ({key:verificationKey(row),status:'verified',verifierVersion:VERIFIER_VERSION,engineDigest:VERIFIER_ENGINE_DIGEST});
const verifiedEntries = (rows, trackId) => computeTrackEntries(rows, trackId, {}, Object.fromEntries(rows.map(row => [row.accountId, acceptedVerdict(row)])));

test('solo tracks have zero weight and populated official tracks gain weight', () => {
  assert.equal(trackWeightParts(TRACK, 1).finalWeight, 0);
  assert.ok(trackWeightParts(TRACK, 20).finalWeight > trackWeightParts(TRACK, 10).finalWeight);
});

test('profile cosmetics are sanitized and unlocks are server enforced', () => {
  assert.deepEqual(sanitizeProfileCosmetics({ theme: 'script', stage: 'night', stripe: 'cyan', badge: 'admin' }), {
    version: 4, theme: 'classic', accent: 'cyan', finish: 'gradient', plate: 'block', edge: 'accent', stage: 'night', stageTint: 'natural', stripe: 'cyan', emblem: 'none', title: 'auto', badge: 'auto', favoriteTrackId: '', overridePodium: false
  });
  assert.equal(profileCosmeticsUnlocked({ version: 2, theme: 'ocean', stage: 'aqua', stripe: 'cyan', badge: 'auto' }, { raceCount: 0 }), true);
  assert.equal(profileCosmeticsUnlocked({ version: 2, theme: 'ice', stage: 'slate', stripe: 'apex', badge: 'auto' }, { raceCount: 0 }), true);
  assert.equal(profileCosmeticsUnlocked({ version: 2, theme: 'neon', stage: 'dunes', stripe: 'split', badge: 'auto' }, { raceCount: 3 }), true);
  assert.equal(profileCosmeticsUnlocked({ version: 2, theme: 'forest', stage: 'night', stripe: 'circuit', badge: 'none' }, { raceCount: 7 }), false);
  assert.equal(profileCosmeticsUnlocked({ version: 2, theme: 'forest', stage: 'night', stripe: 'circuit', badge: 'none', overridePodium: true }, { raceCount: 8 }), true);
  assert.equal(profileCosmeticsUnlocked({ version: 2, theme: 'beta', stage: 'garage', stripe: 'beta', badge: 'betaTester' }, { raceCount: 1 }, false), false);
  assert.equal(profileCosmeticsUnlocked({ version: 2, theme: 'beta', stage: 'garage', stripe: 'beta', badge: 'betaTester' }, { raceCount: 1 }, true), true);
  assert.equal(profileCosmeticsUnlocked({version:4,emblem:'target'},{raceCount:100}),false);
  assert.equal(profileCosmeticsUnlocked({version:4,emblem:'target'},{cosmeticUnlocks:['emblem:target']}),true);
  const fullDesign={version:4,theme:'forest',accent:'violet',finish:'carbon',plate:'bar',edge:'dashed',stage:'storm',stageTint:'pink',stripe:'circuit',emblem:'flame',title:'trackGrinder',badge:'none',favoriteTrackId:TRACK,overridePodium:false};
  assert.equal(profileCosmeticsUnlocked(fullDesign,{raceCount:7}),false);
  assert.equal(profileCosmeticsUnlocked(fullDesign,{raceCount:8}),true);
  assert.equal(sanitizeProfileCosmetics({...fullDesign,favoriteTrackId:CUSTOM_TRACK}).favoriteTrackId,'');
  assert.equal(profileCosmeticsUnlocked({...fullDesign,plate:'bar',edge:'accent'},{raceCount:8}),true);
  assert.equal(profileCosmeticsUnlocked({...fullDesign,plate:'bar'},{raceCount:3}),false);
  assert.equal(sanitizeProfileCosmetics({plate:'admin',edge:'</style>'}).plate,'block');
});

test('unchanged track signatures are rewritten when schema or algorithm is obsolete', () => {
  const signature = 'same-content';
  assert.equal(trackSnapshotIsCurrent({ signature, schemaVersion: 4, algorithmVersion: 'participation-v8-s1' }, signature), false);
  assert.equal(trackSnapshotIsCurrent({ signature, schemaVersion: 5, algorithmVersion: 'old-algorithm' }, signature), false);
  assert.equal(trackSnapshotIsCurrent({ signature, schemaVersion: 6, algorithmVersion: 'participation-v8-s1',entries:[],complete:true,totalEntries:0 }, signature), true);
});

test('track types use the exact registry instead of treating every hash as community', () => {
  const official = trackWeightParts(TRACK, 10);
  const community = trackWeightParts(COMMUNITY_TRACK, 10);
  const custom = trackWeightParts(CUSTOM_TRACK, 10);

  assert.equal(official.type, 'official');
  assert.equal(community.type, 'community');
  assert.equal(custom.type, 'custom');
  assert.ok(official.finalWeight > community.finalWeight);
  assert.ok(community.finalWeight > custom.finalWeight);
});

test('every catalog track has a pinned reduced-RP native ID', () => {
  const catalog=JSON.parse(readFileSync(new URL('../../../extra-tracks/catalog.json',import.meta.url),'utf8'));
  const ids=catalog.map(row=>row.trackId);
  assert.equal(new Set(ids).size,catalog.length);
  assert.deepEqual(new Set(ids),EXTRA_TRACK_IDS);
  for(const id of ids){
    const parts=trackWeightParts(id,500,1.15);
    assert.equal(parts.type,'extra');
    assert.equal(parts.base,0.6);
    assert.ok(parts.finalWeight > 0.06);
    assert.equal(trackWeightParts(id,1).finalWeight,0);
  }
  assert.equal(trackWeightParts(CUSTOM_TRACK,500,1.15).base,0.6);
});

test('Extra contribution caps at one fifth of the strongest verified normal track', () => {
  const extraId=[...EXTRA_TRACK_IDS][0];
  const makeEntries=trackId=>verifiedEntries(Array.from({length:8},(_,index)=>validRun({accountId:index===0?'leader':`opponent-${index}`,trackId,timeMs:20000+index*1000,createdAt:index+1})),trackId);
  const normal=makeEntries(TRACK),extra=makeEntries(extraId);
  const leader=computeOverall([{trackId:TRACK,entries:normal},{trackId:extraId,entries:extra}],[],new Set(),{includePlannerResults:true}).find(row=>row.userId==='leader');
  assert.ok(leader);
  const normalFinish=leader.resultSamples.find(row=>row.trackId===TRACK);
  const extraFinish=leader.resultSamples.find(row=>row.trackId===extraId);
  assert.ok(extraFinish.weight<=normalFinish.weight/5+0.0001);
  assert.ok(extraFinish.weight>0.06);
});

test('Rolling Hills is permanent-weighted in normal Overall RP without changing community scoring', () => {
  const rolling = 'fb769ac2ea77e8f19a21a9dd3071742f2342bd49c41e4748d7e8c7903d4f0778';
  const makeBoard = trackId => verifiedEntries(Array.from({ length: 5 }, (_, index) => validRun({
    accountId: index === 2 ? 'racer' : `opponent-${index}`,
    trackId,
    timeMs: 20000 + index * 1000,
    createdAt: index + 1
  })), trackId);
  const rollingEntries = makeBoard(rolling), communityEntries = makeBoard(COMMUNITY_TRACK);
  assert.equal(rollingEntries[2].weight, Number((communityEntries[2].weight * 1.6).toFixed(3)));

  const racer = computeOverall([
    { trackId: rolling, entries: rollingEntries },
    { trackId: COMMUNITY_TRACK, entries: communityEntries }
  ]).find(entry => entry.userId === 'racer');
  assert.equal(racer.communityCount, 1);
  assert.deepEqual(racer.weightedResults.map(result => result.type).sort(), ['community', 'permanent']);
});

test('track entries retain one fastest PB per account without cloning racers', () => {
  const rows = [
    validRun({ accountId: 'a', trackId: TRACK, ownerUid: 'one', timeMs: 30000, createdAt: 1 }),
    validRun({ accountId: 'a', trackId: TRACK, ownerUid: 'one', timeMs: 29000, createdAt: 2 }),
    validRun({ accountId: 'b', trackId: TRACK, ownerUid: 'two', timeMs: 29500, createdAt: 3 })
  ];
  const entries = computeTrackEntries(rows, TRACK, { BETA_CUTOFF_MS: '10' });
  assert.deepEqual(entries.map((entry) => [entry.accountId, entry.timeMs]), [['a', 29000], ['b', 29500]]);
  assert.equal(entries[0].fieldSize, 2);
  assert.equal(entries[0].uploadId, 123);
  assert.equal(entries[0].id, 123);
});

test('overall rank is deterministic and preserves rank duration only when unchanged', () => {
  const board = { trackId: TRACK, entries: verifiedEntries([
    validRun({ accountId: 'a', trackId: TRACK, timeMs: 29000, createdAt: 1 }),
    validRun({ accountId: 'b', trackId: TRACK, timeMs: 29500, createdAt: 2 }),
    validRun({ accountId: 'c', trackId: TRACK, timeMs: 31000, createdAt: 3 })
  ], TRACK) };
  const first = computeOverall([board]);
  const second = computeOverall([board], first);
  assert.deepEqual(second.map((entry) => entry.userId), first.map((entry) => entry.userId));
  assert.equal(second[0].rankSince, first[0].rankSince);
});

test('rank titles require breadth even when three finishes are strong', () => {
  const boards = ['track-a','track-b','track-c'].map((trackId) => ({
    trackId,
    entries: Array.from({ length: 20 }, (_, index) => ({
      accountId: index === 0 ? 'specialist' : `${trackId}-${index}`,
      name: index === 0 ? 'Specialist' : `Racer ${index}`,
      rank: index + 1,
      weight: 1,
      timeMs: 20000 + index
      ,integrityVerified: true, runVerified: true
    }))
  }));
  const specialist = computeOverall(boards).find((entry) => entry.userId === 'specialist');
  assert.equal(specialist.raceCount, 3);
  assert.match(specialist.rankTier, /^Bronze/);
});

test('maximum snapshots stay below a conservative Firestore document budget', () => {
  const boards = Array.from({ length: 78 }, (_, trackIndex) => ({
    trackId: `track-${trackIndex}`,
    entries: Array.from({ length: 500 }, (_, racerIndex) => ({
      accountId: `racer-${racerIndex}`,
      name: `Racer ${racerIndex}`,
      rank: racerIndex + 1,
      weight: 4.5,
      timeMs: 20000 + racerIndex,
      pbAt: 1780000000000,
      integrityVerified: true, runVerified: true
    }))
  }));
  const entries = computeOverall(boards);
  assert.equal(entries.length, 200);
  assert.ok(Buffer.byteLength(JSON.stringify({ entries })) < 850000);
});

test('rejects an untrusted origin before touching Firestore', async () => {
  let touched = false;
  const response = await handleRequest(new Request('https://ranked.example/v1/status', { headers: { Origin: 'https://attacker.example' } }), {
    ALLOWED_ORIGINS: 'https://staticquasar931.github.io',
    __TEST_FIRESTORE: async () => { touched = true; }
  });
  assert.equal(response.status, 403);
  assert.equal(touched, false);
});

test('profile notify preflight allows the configured school game origin and required headers', async () => {
  const origin = 'https://school-game.example';
  const response = await handleRequest(new Request('https://ranked.example/v1/profile/notify', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type'
    }
  }), { ALLOWED_ORIGINS: origin });

  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), origin);
  assert.equal(response.headers.get('Access-Control-Allow-Methods'), 'GET, POST, OPTIONS');
  assert.equal(response.headers.get('Access-Control-Allow-Headers'), 'Authorization, Content-Type, X-Admin-Token');
  assert.equal(response.headers.get('Access-Control-Max-Age'), '600');
});

test('Extra track submission is authenticated, private, and limited to one per day', async () => {
  const origin='https://staticquasar931.github.io';
  const input={name:'New track',author:'Creator',description:'Fast corners',code:'PolyTrack'+'A'.repeat(40),difficulty:4,tags:['racing'],sourceUrl:'',permissionGranted:true};
  let committed=null;
  const env={ALLOWED_ORIGINS:origin,__TEST_UID:'test-uid',__TEST_FIRESTORE:async(path,init={})=>{
    if(path===':commit'){committed=JSON.parse(init.body).writes;return {writeResults:[{}]};}
    return null;
  }};
  const send=()=>handleRequest(new Request('https://ranked.example/v1/extra-tracks/submissions',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(input)}),env);
  const response=await send();
  assert.equal(response.status,201);
  assert.equal(committed.length,1);
  assert.match(committed[0].update.name,/0\.6\.2_extra_track_submissions\/test-uid_/);
  assert.deepEqual(committed[0].currentDocument,{exists:false});
  env.__TEST_FIRESTORE=async(path)=>path.includes('extra_track_submissions')?{fields:{ownerUid:{stringValue:'test-uid'}}}:null;
  assert.equal((await send()).status,409);
});

test('canonical reconciliation endpoint requires the private admin token', async () => {
  let touched=false;
  const response=await handleRequest(new Request('https://ranked.example/v1/admin/reconcile',{
    method:'POST',headers:{Origin:'https://staticquasar931.github.io'}
  }),{
    ALLOWED_ORIGINS:'https://staticquasar931.github.io',['ADMIN_'+'REBUILD_TOKEN']:'unit-test-value',
    __TEST_FIRESTORE:async()=>{touched=true;return null;}
  });
  assert.equal(response.status,403);
  assert.equal(touched,false);
});

test('rejects notification for a result owned by another Firebase user', async () => {
  const response = await handleRequest(new Request('https://ranked.example/v1/pb/notify', {
    method: 'POST',
    headers: { Origin: 'https://staticquasar931.github.io', 'Content-Type': 'application/json' },
    body: JSON.stringify({ resultId: `racer_${TRACK}` })
  }), {
    ALLOWED_ORIGINS: 'https://staticquasar931.github.io',
    __TEST_UID: 'signed-in-user',
    __TEST_FIRESTORE: async (path) => path.includes('race_results') ? { fields: {
      ownerUid: { stringValue: 'different-user' }, accountId: { stringValue: 'racer' }, trackId: { stringValue: TRACK }
    } } : null
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'result_not_owned' });
});

test('cosmetic saves update the public overall snapshot before background propagation', async () => {
  let overallWrite='',entitlementFields=null;const guardedPaths=[];
  const accountId='cosmetic-racer';
  const response=await handleRequest(new Request('https://ranked.example/v1/profile/cosmetics',{
    method:'POST',
    headers:{Origin:'https://staticquasar931.github.io','Content-Type':'application/json'},
    body:JSON.stringify({accountId,cosmetics:{version:2,theme:'forest',stage:'night',stripe:'circuit',badge:'auto',overridePodium:true}})
  }),{
    ALLOWED_ORIGINS:'https://staticquasar931.github.io',
    __TEST_UID:'signed-in-user',
    __TEST_FIRESTORE:async(path,init={})=>{
      if(path===':commit'){for(const write of JSON.parse(init.body).writes){guardedPaths.push(write.currentDocument.updateTime);if(write.update.name.includes('cosmetic_entitlements'))entitlementFields=write.update.fields;if(write.update.name.includes('s1_leaderboards_overall'))overallWrite=JSON.stringify(write.update);}return {writeResults:[{updateTime:'2026-09-09T00:00:00Z'}]};}
      if(init.method==='PATCH'){
        if(path.includes('profiles_public')||path.includes('s1_leaderboards_overall'))guardedPaths.push(path);
        if(path.includes('s1_leaderboards_overall'))overallWrite=String(init.body||'');
        return {};
      }
      if(path===':runQuery')return [];
      if(path.includes('cosmetic_entitlements'))return entitlementFields?{updateTime:'2026-09-09T00:00:00Z',fields:entitlementFields}:null;
      if(path.includes('profiles_public'))return {updateTime:'2026-09-05T00:00:00Z',fields:{accountId:{stringValue:accountId},ownerUid:{stringValue:'signed-in-user'},name:{stringValue:'Racer'},nickname:{stringValue:'Racer'},carStyle:{stringValue:'style'},isVerifier:{booleanValue:false},updatedAt:{integerValue:'1'}}};
      if(path.includes('s1_leaderboards_overall'))return {updateTime:'2026-09-05T00:00:00Z',fields:{
        revision:{integerValue:'7'},
        entries:{arrayValue:{values:[{mapValue:{fields:{
          userId:{stringValue:accountId},raceCount:{integerValue:'8'},rank:{integerValue:'4'}
        }}}]}}
      }};
      return null;
    }
  });
  assert.equal(response.status,202);
  const payload=await response.json();
  assert.equal(payload.accepted,true);
  assert.equal(payload.betaEntitlement.source,'open-beta-release');
  assert.match(overallWrite,/profileCosmetics/);
  assert.match(overallWrite,/circuit/);
  assert.deepEqual(guardedPaths,[undefined,'2026-09-05T00:00:00Z','2026-09-05T00:00:00Z']);
});

test('accepts an owned hash mismatch as pending without granting integrity verification', async () => {
  const response = await handleRequest(new Request('https://ranked.example/v1/pb/notify', {
    method: 'POST',
    headers: { Origin: 'https://staticquasar931.github.io', 'Content-Type': 'application/json' },
    body: JSON.stringify({ resultId: `racer_${TRACK}` })
  }), {
    ALLOWED_ORIGINS: 'https://staticquasar931.github.io',
    __TEST_UID: 'signed-in-user',
    __TEST_FIRESTORE: async (path, init) => {
      if(path.includes('race_results'))return { fields: {
        ownerUid: { stringValue: 'signed-in-user' }, accountId: { stringValue: 'racer' }, trackId: { stringValue: TRACK },
        timeMs: { integerValue: '20000' }, raceTimeFrames: { integerValue: '1200' }, replay: { stringValue: 'recording' }, replayHash: { stringValue: '0'.repeat(64) }
      } };
      if(init?.method==='PATCH')return {};
      if(path.includes('s1_leaderboards_track'))return {fields:{algorithmVersion:{stringValue:'participation-v8-s1'},entries:{arrayValue:{values:[]}},revision:{integerValue:'1'}}};
      if(path.includes('s1_release_meta'))return {fields:{revision:{integerValue:'1'},builtRevision:{integerValue:'1'},dirty:{booleanValue:false}}};
      return null;
    }
  });
  assert.equal(response.status, 200);
  const payload=await response.json();
  assert.equal(payload.accepted,true);
  assert.equal(payload.integrityVerified,false);
  assert.equal(payload.validationState,'pending');
});

test('serves a complete public snapshot from the Worker API', async () => {
  const response = await handleRequest(new Request('https://ranked.example/v1/snapshot/overall', {
    headers: { Origin: 'https://staticquasar931.github.io' }
  }), {
    ALLOWED_ORIGINS: 'https://staticquasar931.github.io',
    __TEST_FIRESTORE: async (path) => path.includes('leaderboards_overall') ? { fields: {
      revision: { integerValue: '7' }, entries: { arrayValue: { values: [] } }, trackSummaries: { arrayValue: { values: [] } }
    } } : null
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).revision, 7);
  assert.match(response.headers.get('Cache-Control'), /^public/);
});

test('replay integrity alone never grants run verification at the API boundary', async () => {
  const response = await handleRequest(new Request(`https://ranked.example/v1/snapshot/track?trackId=${TRACK}`, {
    headers: { Origin: 'https://staticquasar931.github.io' }
  }), {
    ALLOWED_ORIGINS: 'https://staticquasar931.github.io',
    __TEST_FIRESTORE: async (path) => path.includes('leaderboards_track') ? { fields: {
      revision: { integerValue: '8' },
      entries: { arrayValue: { values: [{ mapValue: { fields: {
        accountId: { stringValue: 'legacy-racer' },
        integrityVerified: { booleanValue: true },
        verifiedState: { integerValue: '0' }
      } } }] } }
    } } : null
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.integrityStateVersion, 1);
  assert.equal(payload.entries[0].verifiedState, 0);
});

test('structurally invalid runs are excluded from track snapshots', () => {
  const entries = computeTrackEntries([
    { accountId: 'missing-replay', trackId: TRACK, timeMs: 20000, raceTimeFrames: 1200 },
    validRun({ accountId: 'valid', trackId: TRACK, timeMs: 21000, createdAt: 2 })
  ], TRACK);
  assert.deepEqual(entries.map((entry) => entry.accountId), ['valid']);
  assert.equal(entries[0].verified, false);
  assert.equal(entries[0].verifiedState, 0);
  assert.equal(entries[0].validationState, 'integrity');
});

test('pending runs remain visible per track but cannot affect Overall RP', () => {
  const rows=[
    validRun({accountId:'verified',trackId:TRACK,timeMs:21000,createdAt:1}),
    validRun({accountId:'verified-two',trackId:TRACK,timeMs:22000,createdAt:1}),
    validRun({accountId:'pending',trackId:TRACK,timeMs:20000,createdAt:2,integrityVerified:false})
  ];
  const entries=computeTrackEntries(rows,TRACK,{}, {verified:acceptedVerdict(rows[0]),'verified-two':acceptedVerdict(rows[1])});
  assert.deepEqual(entries.map((entry)=>entry.accountId),['pending','verified','verified-two']);
  assert.equal(entries[0].validationState,'pending');
  assert.equal(entries[0].verifiedState,0);
  assert.equal(entries[1].verifiedState,1);
  const overall=computeOverall([{trackId:TRACK,entries}]);
  assert.equal(overall.some((entry)=>entry.userId==='pending'),false);
  assert.deepEqual(overall.map(entry=>entry.userId).sort(),['verified','verified-two']);
});

test('average placement is the literal mean finishing place', () => {
  const firstTrack=verifiedEntries([
    validRun({accountId:'average-racer',trackId:TRACK,timeMs:20000,createdAt:1}),
    validRun({accountId:'other-a',trackId:TRACK,timeMs:21000,createdAt:2})
  ],TRACK);
  const secondTrack=verifiedEntries([
    validRun({accountId:'other-b',trackId:COMMUNITY_TRACK,timeMs:19000,createdAt:3}),
    validRun({accountId:'other-c',trackId:COMMUNITY_TRACK,timeMs:20000,createdAt:4}),
    validRun({accountId:'average-racer',trackId:COMMUNITY_TRACK,timeMs:21000,createdAt:5})
  ],COMMUNITY_TRACK);
  const racer=computeOverall([{trackId:TRACK,entries:firstTrack},{trackId:COMMUNITY_TRACK,entries:secondTrack}]).find((entry)=>entry.userId==='average-racer');
  assert.equal(racer.averagePlacement,2);
  assert.equal(racer.averagePlacementVersion,2);
});

test('competitive average excludes custom and fields smaller than five', () => {
  const populated = (trackId, racerRank, size = 5) => ({
    trackId,
    entries: Array.from({ length: size }, (_, index) => ({
      accountId: index === racerRank - 1 ? 'average-racer' : `${trackId}-${index}`,
      rank: index + 1,
      weight: 2,
      timeMs: 20000 + index,
      integrityVerified: true, runVerified: true,
    })),
  });
  const racer = computeOverall([
    populated(TRACK, 3, 5),
    populated(COMMUNITY_TRACK, 1, 4),
    populated(CUSTOM_TRACK, 1, 8),
  ]).find((entry) => entry.userId === 'average-racer');
  assert.equal(racer.averagePlacement, 1.67);
  assert.equal(racer.competitiveAveragePlacement, 3);
  assert.equal(racer.competitiveAverageEligibleTracks, 1);
  assert.equal(racer.trackWins, 0);
});

test('track wins count every eligible recognized first place', () => {
  const populated = (trackId, winner) => ({
    trackId,
    entries: Array.from({ length: 5 }, (_, index) => ({
      accountId: index === 0 ? winner : `${trackId}-opponent-${index}`,
      rank: index + 1,
      weight: 2,
      timeMs: 20000 + index,
      integrityVerified: true, runVerified: true,
    })),
  });
  const racer = computeOverall([
    populated(TRACK, 'winner'),
    populated(COMMUNITY_TRACK, 'winner'),
  ]).find((entry) => entry.userId === 'winner');
  assert.equal(racer.trackWins, 2);
  assert.equal(racer.medals.gold, 2);
});

test('scheduled reconciliation discovers canonical PBs without a client Worker notification', async () => {
  const canonical={
    ownerUid:'owner',accountId:'blocked-client',trackId:TRACK,timeMs:20500,raceTimeFrames:1230,
    replay:'recording',replayHash:'0'.repeat(64),uploadId:321,createdAt:200,updatedAt:200
  };
  let wroteTrack=false;
  const env={
    ALGORITHM_VERSION:'participation-v8-s1',
    __TEST_FIRESTORE:async(path,init={})=>{
      if(path===':commit'){const writes=JSON.parse(init.body).writes;if(writes[0]?.update?.name.includes('/0.6.2_s1_worker_jobs/')){assert.equal(writes[0].currentDocument.exists,false);return {};}if(writes[0]?.update?.name.includes('/0.6.2_s1_verification/')){assert.equal(writes.length,1);assert.equal(writes[0].currentDocument.exists,false);return {};}assert.equal(writes.length,2);assert.ok(writes.every(w=>w.currentDocument));wroteTrack=writes.some(w=>w.update.name.includes('s1_leaderboards_track'));return {};}
      if(init.method==='PATCH'){
        if(path.includes('s1_leaderboards_track'))wroteTrack=true;
        return {};
      }
      if(path===':runQuery'){
        const query=JSON.parse(init.body).structuredQuery;
        const collection=query.from?.[0]?.collectionId;
        if(collection!=='0.6.2_race_results')return [];
        return [{document:{name:`projects/test/databases/(default)/documents/0.6.2_race_results/blocked-client_${TRACK}`,fields:Object.fromEntries(Object.entries(canonical).map(([key,value])=>[key,typeof value==='number'?{integerValue:String(value)}:{stringValue:value}])),updateTime:'2026-09-01T12:00:00Z'}}];
      }
      if(path.includes('s1_release_meta'))return {fields:{lastPbAt:{integerValue:'100'},revision:{integerValue:'1'},builtRevision:{integerValue:'1'}}};
      return null;
    }
  };
  const result=await reconcileCanonicalChanges(env);
  assert.equal(result.scanned,2);
  assert.equal(result.rebuilt,1);
  assert.equal(wroteTrack,true);
});

test('idle canonical reconciliation performs no recurring Firestore write', async () => {
  let writes=0;
  const result=await reconcileCanonicalChanges({
    __TEST_FIRESTORE:async(path,init={})=>{
      if(init.method==='PATCH'){writes++;return {};}
      if(path.includes('canonical_reconcile'))return {fields:{backfillComplete:{booleanValue:true},cursorIngestedAt:{stringValue:'2026-09-09T00:00:00.000000123Z'},pendingTrackIds:{arrayValue:{values:[]}}}};
      if(path===':runQuery')return [];
      return null;
    }
  });
  assert.equal(result.unchanged,true);
  assert.equal(writes,0);
});

test('synthetic ranking sizes remain capped and deterministic', () => {
  for (const size of [1, 3, 15, 200, 500, 1000]) {
    const rows = Array.from({ length: size }, (_, index) => validRun({ accountId: `racer-${index}`, trackId: TRACK, timeMs: 20000 + index, createdAt: index + 1 }));
    const entries = computeTrackEntries(rows, TRACK);
    assert.equal(entries.length, Math.min(size, 500));
    assert.deepEqual(entries.map((entry) => entry.rank), Array.from({ length: entries.length }, (_, index) => index + 1));
  }
});


test('canonical cursor resumes after timestamp AND document ID',async()=>{
 let query;
 await reconcileCanonicalChanges({__TEST_FIRESTORE:async(path,init={})=>{
 if(path.includes('canonical_reconcile'))return {fields:{backfillComplete:{booleanValue:true},cursorIngestedAt:{stringValue:'2026-09-09T00:00:00.000000123Z'},cursorDocumentId:{stringValue:'last-id'},pendingTrackIds:{arrayValue:{values:[]}}},updateTime:'2026-09-01T00:00:00Z'};
 if(path===':runQuery'){query=JSON.parse(init.body).structuredQuery;return [];}
 return null;
 }});
 assert.equal(query.where.fieldFilter.op,'GREATER_THAN_OR_EQUAL');
 assert.equal(query.orderBy[1].field.fieldPath,'__name__');
 assert.equal(query.startAt.before,false);
 assert.equal(query.startAt.values[0].timestampValue,'2026-09-09T00:00:00.000000123Z');
 assert.equal(query.orderBy[0].field.fieldPath,'ingestedAt');
 assert.match(query.startAt.values[1].referenceValue,/0.6.2_race_results\/last-id$/);
});

test('snapshot and dirty metadata are one guarded commit; conflict keeps track queued',async()=>{
 const canonical=validRun({ownerUid:'owner',accountId:'racer',trackId:TRACK,timeMs:20500,updatedAt:200});
 let commit,job;
 const result=await reconcileCanonicalChanges({__TEST_FIRESTORE:async(path,init={})=>{
 if(path===':runQuery')return [{document:{name:'projects/test/databases/(default)/documents/results/racer',fields:Object.fromEntries(Object.entries(canonical).map(([k,v])=>[k,typeof v==='number'?{integerValue:String(v)}:typeof v==='boolean'?{booleanValue:v}:{stringValue:v}]))}}];
 if(path===':commit'){const next=JSON.parse(init.body);if(next.writes[0]?.update?.name.includes('/0.6.2_s1_worker_jobs/')){job=next.writes[0].update;assert.equal(next.writes[0].currentDocument.exists,false);return {};}if(next.writes[0]?.update?.name.includes('/0.6.2_s1_verification/'))return {};commit=next;throw Error('FIRESTORE_409');}
 if(init.method==='PATCH'){job=JSON.parse(init.body);return {};}
 if(path.includes('s1_leaderboards_track'))return {fields:{revision:{integerValue:'4'}},updateTime:'2026-09-01T00:00:00Z'};
 if(path.includes('s1_release_meta'))return {fields:{revision:{integerValue:'6'}},updateTime:'2026-09-01T00:00:01Z'};
 return null;
 }});
 assert.equal(result.rebuilt,0);assert.equal(result.pending,1);
 assert.equal(commit.writes.length,2);
 assert.equal(commit.writes[0].currentDocument.updateTime,'2026-09-01T00:00:00Z');
 assert.equal(commit.writes[1].currentDocument.updateTime,'2026-09-01T00:00:01Z');
 assert.match(commit.writes[0].update.name,/^projects\/polytrack-052\/databases\/\(default\)\/documents\//);
 assert.equal(job.fields.pendingTrackIds.arrayValue.values[0].stringValue,TRACK);
});


test('late same-racer notification cannot regress a faster published PB',async()=>{
 let writes=0;
 const env={__TEST_FIRESTORE:async(_path,init={})=>{if(init.method){writes++;return {}};return {fields:{algorithmVersion:{stringValue:'participation-v8-s1'},revision:{integerValue:'2'},entries:{arrayValue:{values:[{mapValue:{fields:{accountId:{stringValue:'racer'},timeMs:{integerValue:'20000'},uploadId:{integerValue:'222'}}}}]}}},updateTime:'2026-09-09T00:00:00Z'};}};
 const result=await mergeCanonicalResultIntoTrack(env,TRACK,validRun({ownerUid:'owner',accountId:'racer',trackId:TRACK,timeMs:25000,updatedAt:1}),true);
 assert.equal(result.changed,false);assert.equal(result.entries[0].timeMs,20000);assert.equal(writes,0);
});


function wire(value){
 if(Array.isArray(value))return {arrayValue:{values:value.map(wire)}};
 if(value===null)return {nullValue:null};
 if(typeof value==='object')return {mapValue:{fields:Object.fromEntries(Object.entries(value).map(([k,v])=>[k,wire(v)]))}};
 if(typeof value==='boolean')return {booleanValue:value};
 if(typeof value==='number')return {doubleValue:value};
 return {stringValue:String(value)};
}
function unwire(value){
 if(value?.mapValue)return Object.fromEntries(Object.entries(value.mapValue.fields||{}).map(([key,item])=>[key,unwire(item)]));
 if(value?.arrayValue)return (value.arrayValue.values||[]).map(unwire);
 if(value&&'integerValue'in value)return Number(value.integerValue);
 if(value&&'doubleValue'in value)return Number(value.doubleValue);
 if(value&&'booleanValue'in value)return value.booleanValue;
 if(value&&'nullValue'in value)return null;
 return value?.stringValue;
}
test('Extra queue backfill moves legacy slots atomically in bounded batches',async()=>{
  const ids=Array.from({length:5},(_,i)=>String(i+1).repeat(64));
  const state=new Map(ids.map(id=>['0.6.2_s1_verification/'+id,{trackId:id,slots:{racer:{key:'original-'+id,status:'waiting',attempts:2}}}]));
  const commits=[];
  const env={__TEST_FIRESTORE:async(path,init={})=>{
    if(path===':commit'){
      const writes=JSON.parse(init.body).writes;commits.push(writes);
      for(const write of writes){
        const name=write.delete||write.update.name;
        const key=name.slice(name.indexOf('/documents/')+'/documents/'.length);
        if(write.delete)state.delete(key);
        else state.set(key,unwire({mapValue:{fields:write.update.fields}}));
      }
      return {};
    }
    const key=path.slice(1);
    const value=state.get(key);
    return value?{fields:wire(value).mapValue.fields,updateTime:'2026-09-09T00:00:00Z'}:null;
  }};
  assert.deepEqual(await migrateExtraVerificationQueues(env,ids),{moved:4,processed:4,complete:false});
  assert.deepEqual(await migrateExtraVerificationQueues(env,ids),{moved:1,processed:5,complete:true});
  assert.deepEqual(await migrateExtraVerificationQueues(env,ids),{moved:0,processed:5,complete:true});
  assert.equal(commits.length,2);
  assert.equal(commits[0].filter(write=>write.delete).length,4);
  for(const id of ids){
    assert.equal(state.has('0.6.2_s1_verification/'+id),false);
    assert.equal(state.get('0.6.2_s1_extra_verification/'+id).slots.racer.attempts,2);
  }
});

test('default backfill scans the complete registered catalog before marking migration complete',async()=>{
  const state=new Map(),commits=[];
  const env={__TEST_FIRESTORE:async(path,init={})=>{
    if(path===':commit'){
      const writes=JSON.parse(init.body).writes;commits.push(writes);
      for(const write of writes){
        const key=write.update.name.split('/documents/')[1];
        state.set(key,unwire({mapValue:{fields:write.update.fields}}));
      }
      return {};
    }
    const value=state.get(path.slice(1));
    return value?{fields:wire(value).mapValue.fields,updateTime:'2026-09-09T00:00:00Z'}:null;
  }};
  let result;
  do { result=await migrateExtraVerificationQueues(env); } while(!result.complete);
  assert.equal(result.processed,EXTRA_TRACK_IDS.size);
  assert.equal(commits.length,Math.ceil(EXTRA_TRACK_IDS.size/4));
  const marker=state.get('0.6.2_s1_worker_jobs/extra_verification_queue_migration_v1');
  assert.equal(marker.complete,true);
  assert.equal(marker.registry,[...EXTRA_TRACK_IDS].sort().join(','));
});

test('Extra queue backfill refuses overlapping slots without deleting legacy work',async()=>{
  const id='a'.repeat(64),writes=[];
  const env={__TEST_FIRESTORE:async(path,init={})=>{
    if(path===':commit'){writes.push(JSON.parse(init.body));return {};}
    if(path.includes('extra_verification_queue_migration_v1'))return null;
    if(path.endsWith('/'+id))return {fields:wire({trackId:id,slots:{racer:{key:'proof',status:'verified'}}}).mapValue.fields,updateTime:'t1'};
    return null;
  }};
  await assert.rejects(migrateExtraVerificationQueues(env,[id]),/EXTRA_QUEUE_SLOT_CONFLICT/);
  assert.equal(writes.length,0);
});
test('200-racer entitlement initialization uses one atomic batch within the Free request budget',async()=>{
 let requests=0,commit;
 const boards=[TRACK,COMMUNITY_TRACK,'7eac4fee1111152cfba4d3737410264ca0f22c7f5a2211e79f0099589b8b48c0'].map(trackId=>({trackId,entries:Array.from({length:200},(_,i)=>({accountId:'racer-'+i,rank:i+1,timeMs:20000+i,weight:3,integrityVerified:true,runVerified:true}))}));
 const result=await rebuildOverall({__TEST_FIRESTORE:async(path,init={})=>{
  requests++;
  if(path===':commit'){commit=JSON.parse(init.body);return {};}
  if(path===':runQuery')return boards.map(b=>({document:{fields:wire(b).mapValue.fields}}));
  if(path.includes('s1_release_meta'))return {fields:wire({dirty:true,revision:10}).mapValue.fields,updateTime:'2026-09-09T00:00:00Z'};
  return null;
 }},true);
  assert.equal(result.racers,200);assert.equal(commit.writes.length,203);assert.equal(requests,6);
 assert.ok(commit.writes.slice(0,200).every(w=>w.update.name.includes('cosmetic_entitlements')&&!w.currentDocument));
 assert.equal(commit.writes.at(-1).currentDocument.updateTime,'2026-09-09T00:00:00Z');
 assert.ok(JSON.stringify(commit).length<10*1024*1024);
});
test('permanently failing tracks rotate behind healthy reconciliation work',async()=>{
 let job={backfillComplete:true,cursorIngestedAt:'2026-09-09T00:00:00Z',pendingTrackIds:['fail1','fail2','fail3','fail4',TRACK]},healthyWritten=false;
 const env={__TEST_FIRESTORE:async(path,init={})=>{
  if(path===':commit'){
   const writes=JSON.parse(init.body).writes;
   const state=writes.find(w=>w.update.name.endsWith('/canonical_reconcile_v2'));
   if(state)job.pendingTrackIds=state.update.fields.pendingTrackIds.arrayValue.values.map(v=>v.stringValue);
   if(writes.some(w=>w.update.name.includes('s1_leaderboards_track/'+TRACK)))healthyWritten=true;
   return {};
  }
  if(path.includes('canonical_reconcile_v2'))return {fields:wire(job).mapValue.fields,updateTime:'2026-09-09T00:00:00Z'};
  if(path.includes('s1_leaderboards_track/fail'))throw Error('permanent capacity failure');
  if(path===':runQuery')return [];
  return null;
 }};
 await reconcileCanonicalChanges(env);assert.equal(job.pendingTrackIds[0],TRACK);
 await reconcileCanonicalChanges(env);assert.equal(healthyWritten,true);assert.ok(!job.pendingTrackIds.includes(TRACK));
});


test('finishing the final queued track persists an empty queue instead of repeating it forever',async()=>{
 let queueSaved=false;
 const result=await reconcileCanonicalChanges({__TEST_FIRESTORE:async(path,init={})=>{
  if(path===':commit'){
   const write=JSON.parse(init.body).writes.find(w=>w.update.name.endsWith('/canonical_reconcile_v2'));
   if(write){assert.deepEqual(write.update.fields.pendingTrackIds.arrayValue.values,[]);queueSaved=true;}
   return {};
  }
  if(path.includes('canonical_reconcile_v2'))return {fields:wire({backfillComplete:true,cursorIngestedAt:'2026-09-09T00:00:00Z',pendingTrackIds:[TRACK]}).mapValue.fields,updateTime:'2026-09-09T00:00:00Z'};
  if(path===':runQuery')return [];
  return null;
 }});
 assert.equal(result.rebuilt,1);assert.equal(result.pending,0);assert.equal(queueSaved,true);
});


test('equal PB replay repair rebuilds from canonical data without granting verification',async()=>{
 const replay='repaired-replay';const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(replay))).toString('hex');
 const canonical=validRun({accountId:'racer',trackId:TRACK,timeMs:20000,replay,replayHash:hash});
 let queries=0,commits=0;
 const env={__TEST_FIRESTORE:async(path,init={})=>{
  if(path===':runQuery'){queries++;return [{document:{name:'projects/test/databases/(default)/documents/results/racer',fields:wire(canonical).mapValue.fields}}];}
  if(path===':commit'){commits++;return {};}
  if(path.includes('s1_leaderboards_track'))return {fields:wire({algorithmVersion:'participation-v8-s1',revision:2,entries:[{...canonical,replayHash:'a'.repeat(64),integrityVerified:false}]}).mapValue.fields,updateTime:'2026-09-09T00:00:00Z'};
  return null;
 }};
 const result=await mergeCanonicalResultIntoTrack(env,TRACK,canonical,true);
 assert.equal(result.changed,true);assert.equal(queries,1);assert.equal(commits,2);
 assert.equal(result.entries[0].timeMs,20000);assert.equal(result.entries[0].integrityVerified,true);assert.equal(result.entries[0].runVerified,false);
});


test('server verification binds exact replay, account, track, time, frames and upload',()=>{
 const row=validRun({accountId:'racer',trackId:TRACK,timeMs:20000});const verdict={key:verificationKey(row),status:'verified',verifierVersion:VERIFIER_VERSION,engineDigest:VERIFIER_ENGINE_DIGEST};
 assert.equal(verifiedVerdict(row,verdict),true);
 for(const change of [{accountId:'other'},{trackId:COMMUNITY_TRACK},{timeMs:19999},{raceTimeFrames:19999},{uploadId:124},{replayHash:'b'.repeat(64)},{integrityVerified:false}])assert.equal(verifiedVerdict({...row,...change},verdict),false);
 assert.equal(verifiedVerdict(row,{...verdict,status:'mismatch'}),false);assert.equal(verifiedVerdict(row,{...verdict,engineDigest:''}),false);
});
test('a caller boolean alone cannot promote a run but a bound server verdict can',()=>{
 const row=validRun({accountId:'racer',trackId:TRACK,timeMs:20000,runVerified:true});
 assert.equal(computeTrackEntries([row],TRACK)[0].runVerified,false);
 const verdict={key:verificationKey(row),status:'verified',verifierVersion:VERIFIER_VERSION,engineDigest:VERIFIER_ENGINE_DIGEST};
 assert.equal(computeTrackEntries([row],TRACK,{}, {racer:verdict})[0].runVerified,true);
});

test('first reconciliation creation cannot overwrite a concurrent verifier wake-up',async()=>{let guarded=false;await assert.rejects(reconcileCanonicalChanges({__TEST_FIRESTORE:async(path,init={})=>{if(path===':runQuery')return [];if(path===':commit'){const w=JSON.parse(init.body).writes[0];guarded=w.currentDocument.exists===false;throw Error('FIRESTORE_409');}return null;}}),/409/);assert.equal(guarded,true);});


test('diamond is free and twin stars require eight Ranked tracks',()=>{
 assert.equal(profileCosmeticsUnlocked({version:4,emblem:'diamond'},{raceCount:0}),true);
 assert.equal(profileCosmeticsUnlocked({version:4,emblem:'twinStars'},{raceCount:7}),false);
 assert.equal(profileCosmeticsUnlocked({version:4,emblem:'twinStars'},{raceCount:8}),true);
 assert.equal(sanitizeProfileCosmetics({version:4,emblem:'twinStars'}).emblem,'twinStars');
});


import {bootstrapSnapshotVerification} from '../src/index.js';
import {bootstrapSlots, pendingSlot, VERIFICATION_BOOTSTRAP_ID} from '../src/verification.js';

test('bootstrap preserves current bindings, retries and unrelated slots without trusting snapshot approval', () => {
  const row = validRun({accountId: 'racer', trackId: TRACK, timeMs: 20000});
  const waiting = {...pendingSlot(row), status: 'unavailable', retryAt: 999999, attempts: 2};
  const newer = pendingSlot({...row, timeMs: 19000});
  const terminal = {...pendingSlot(row), status: 'verified', engineDigest: VERIFIER_ENGINE_DIGEST};
  for (const existing of [waiting, terminal]) {
    const slots = bootstrapSlots(TRACK, [row], {racer: existing, other: pendingSlot({...row, accountId: 'other'})});
    assert.equal(slots.racer, existing);
    assert.ok(slots.other);
  }
  const stale = bootstrapSlots(TRACK, [row], {racer: {...newer, status: 'verified'}}).racer;
  assert.equal(stale.key, verificationKey(row));
  assert.equal(stale.status, 'waiting');
  const snapshot = {...row, replay: undefined, runVerified: true};
  assert.equal(bootstrapSlots(TRACK, [snapshot]).racer.status, 'waiting');
  const obsolete = {...terminal, key: JSON.stringify(['old-engine'])};
  assert.equal(bootstrapSlots(TRACK, [snapshot], {racer: obsolete}).racer.status, 'waiting');
  assert.equal(bootstrapSlots(TRACK, [snapshot], {racer: {...waiting, reason: 'canonical_missing'}}).racer.status, 'waiting');
});

test('bootstrap rejects malformed bindings and never prunes partial snapshots to satisfy the cap', () => {
  const row = validRun({accountId: 'racer', trackId: TRACK, timeMs: 20000});
  assert.equal(Object.keys(bootstrapSlots(TRACK, [{...row, trackId: COMMUNITY_TRACK}, {...row, accountId: '../bad'}, {...row, timeMs: 0}])).length, 0);
  const existing = Object.fromEntries(Array.from({length: 500}, (_, i) => ['r'+i, pendingSlot({...row, accountId: 'r'+i})]));
  assert.throws(() => bootstrapSlots(TRACK, [row], existing), /VERIFICATION_TRACK_CAP/);
  assert.equal(Object.keys(existing).length, 500);
});

function bootstrapFixture(count, conflict = false) {
  const base = 'projects/test/databases/(default)/documents/';
  const boards = Array.from({length: count}, (_, i) => {
    const trackId = String(i).padStart(64, '0');
    return {name: base+'0.6.2_s1_leaderboards_track/'+trackId, fields: wire({trackId,
      entries: [{accountId: 'racer', trackId, timeMs: 20000, raceTimeFrames: 20000}]}).mapValue.fields};
  });
  const docs = new Map();
  const calls = [];
  let fail = conflict, sequence = 0;
  const env = {__TEST_FIRESTORE: async (p, init = {}) => {
    calls.push(p);
    if (p === ':runQuery') {
      const q = JSON.parse(init.body).structuredQuery;
      assert.equal(q.limit, 4);
      assert.equal(q.from[0].collectionId, '0.6.2_s1_leaderboards_track');
      assert.equal(q.orderBy[0].field.fieldPath, '__name__');
      if (q.startAt) assert.equal(q.startAt.before, false);
      return boards.filter(b => !q.startAt || b.name > q.startAt.values[0].referenceValue).slice(0, q.limit).map(document => ({document}));
    }
    if (p === ':commit') {
      const writes = JSON.parse(init.body).writes;
      assert.ok(writes.at(-1).update.name.endsWith('/'+VERIFICATION_BOOTSTRAP_ID));
      for (const w of writes) {
        const old = docs.get('/'+w.update.name.split('/documents/')[1]);
        assert.deepEqual(w.currentDocument, old ? {updateTime: old.updateTime} : {exists: false});
      }
      if (fail) {fail = false; throw Error('FIRESTORE_409');}
      for (const w of writes) docs.set('/'+w.update.name.split('/documents/')[1], {...w.update, updateTime: 'revision-'+(++sequence)});
      return {};
    }
    assert.ok(!p.includes('0.6.2_race_results'));
    return docs.get(p) || null;
  }};
  return {env, docs, calls};
}

test('snapshot bootstrap pages four boards, atomically checkpoints and is idle after completion', async () => {
  const f = bootstrapFixture(5);
  assert.deepEqual(await bootstrapSnapshotVerification(f.env), {scanned: 4, complete: false});
  assert.equal(f.calls.length, 7);
  assert.equal(f.docs.size, 5);
  assert.deepEqual(await bootstrapSnapshotVerification(f.env), {scanned: 1, complete: true});
  const before = f.calls.length;
  assert.deepEqual(await bootstrapSnapshotVerification(f.env), {scanned: 0, complete: true});
  assert.equal(f.calls.length-before, 1);
  assert.equal(f.docs.size, 6);
});

test('bootstrap conflict cannot advance cursor or partially seed queues', async () => {
  const f = bootstrapFixture(4, true);
  await assert.rejects(bootstrapSnapshotVerification(f.env), /409/);
  assert.equal(f.docs.size, 0);
  assert.deepEqual(await bootstrapSnapshotVerification(f.env), {scanned: 4, complete: false});
  assert.deepEqual(await bootstrapSnapshotVerification(f.env), {scanned: 0, complete: true});
});

test('empty bootstrap completes without scanning canonical results', async () => {
  const f = bootstrapFixture(0);
  assert.deepEqual(await bootstrapSnapshotVerification(f.env), {scanned: 0, complete: true});
  assert.equal(f.calls.length, 3);
});


test('200-racer 78-track indexed planner envelope exceeds one Firestore document without removing existing summaries', t => {
  const boards = Array.from({length: 78}, (_, i) => ({trackId: i.toString(16).padStart(64, '0'),
    entries: Array.from({length: 200}, (_, r) => ({accountId: 'racer-'+r, name: 'Racer '+r,
      timeMs: 20000+r, pbAt: 1780000000000, integrityVerified: true, runVerified: true}))}));
  const entries = computeOverall(boards);
  const resultTracks = boards.map(b => b.trackId).sort();
  const envelope = {resultTracks, entries: entries.map(entry => {
    const sample = entry.weightedResults[0];
    return {...entry, resultData: JSON.stringify(resultTracks.map((_, i) =>
      [i, sample.rank, sample.fieldSize, sample.weight, sample.competition, sample.timeMs, sample.pbAt]))};
  })};
  // Firestore value storage: strings include a terminator; numbers use eight bytes.
  // Omits document name and trackSummaries, so this is a lower bound for main.
  function storageBytes(value) {
    if (value === null || typeof value === 'boolean') return 1;
    if (typeof value === 'number') return 8;
    if (typeof value === 'string') return Buffer.byteLength(value)+1;
    if (Array.isArray(value)) return value.reduce((sum, item) => sum+storageBytes(item), 0);
    return 32+Object.entries(value).reduce((sum, [key, item]) => sum+Buffer.byteLength(key)+1+storageBytes(item), 0);
  }
  const bytes = storageBytes(envelope);
  assert.equal(envelope.entries.length, 200);
  assert.ok(envelope.entries.every(e => JSON.parse(e.resultData).length === 78));
  assert.ok(bytes > 1048576);
  t.diagnostic('Indexed planner envelope lower-bound storage bytes: '+bytes);
});


import {packPlannerResults, plannerDocumentBytes, PLANNER_DOCUMENT_BUDGET} from '../src/planner-results.js';
import worker from '../src/index.js';

async function unpackPlanner(bundle) {
  const bytes = Uint8Array.from(atob(bundle.resultBundle), c => c.charCodeAt(0));
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text());
}

test('unchanged canonical PB repairs its missing verification slot with no board query or snapshot write', async () => {
  const row = validRun({accountId: 'racer', trackId: TRACK, timeMs: 20000});
  let reads = 0, writes = 0;
  const env = {__TEST_FIRESTORE: async (p, init = {}) => {
    if (p === ':commit') {
      const w = JSON.parse(init.body).writes;
      assert.equal(w.length, 1);
      assert.ok(w[0].update.name.includes('/0.6.2_s1_verification/'));
      assert.equal(w[0].currentDocument.exists, false);
      writes++; return {};
    }
    assert.notEqual(p, ':runQuery');
    reads++;
    if (p.includes('s1_leaderboards_track')) return {fields: wire({algorithmVersion: 'participation-v8-s1', revision: 2,
      entries: [row]}).mapValue.fields, updateTime: 'v1'};
    return null;
  }};
  const result = await mergeCanonicalResultIntoTrack(env, TRACK, row, true);
  assert.equal(result.changed, false);
  assert.equal(reads, 2);
  assert.equal(writes, 1);
});

function overallFixture(boards) {
  let failCommit = false;
  const commits = [];
  const documents = new Map();
  const calls = [];
  let snapshot;
  const env = {__TEST_FIRESTORE: async (p, init = {}) => {
    calls.push(p);
    if (p === ':runQuery') {
      const q = JSON.parse(init.body).structuredQuery;
      assert.equal(q.from[0].collectionId, '0.6.2_s1_leaderboards_track');
      assert.ok(q.limit===100||q.limit===1);
      assert.equal(q.orderBy[0].field.fieldPath,'__name__');
      const base='projects/test/databases/(default)/documents/0.6.2_s1_leaderboards_track/';
      return boards.map(board=>({document:{name:base+board.trackId,fields:wire(board).mapValue.fields}}))
        .filter(item=>!q.startAt||item.document.name>q.startAt.values[0].referenceValue)
        .sort((a,b)=>a.document.name.localeCompare(b.document.name)).slice(0,q.limit);
    }
    if (p === ':commit') {
      commits.push(JSON.parse(init.body).writes);
      if (failCommit) throw Error('FIRESTORE_409');
      for (const w of JSON.parse(init.body).writes) {
        if (w.update.name.endsWith('/0.6.2_s1_leaderboards_overall/main')) snapshot = w.update.fields;
        documents.set('/'+w.update.name.split('/documents/')[1], {...w.update, updateTime: 'v1'});
      }
      return {};
    }
    return documents.get(p) || null;
  }};
  return {env, calls, commits, documents, setFailCommit: value => {failCommit = value;}, snapshot: () => snapshot,
    sidecar: () => documents.get('/0.6.2_s1_leaderboards_overall/main_results')?.fields};
}

test('overall completeness reports the exact full racer count when only publication is truncated', async () => {
  const boards=[{trackId:TRACK,complete:true,entries:Array.from({length:250},(_,index)=>({accountId:`racer-${index}`,
    timeMs:20000+index,integrityVerified:true,runVerified:true}))}];
  const f=overallFixture(boards);
  await rebuildOverall(f.env,true);
  const saved=unwire({mapValue:{fields:f.snapshot()}});
  assert.equal(saved.entries.length,200);
  assert.equal(saved.publishedEntries,200);
  assert.equal(saved.totalEntries,250);
  assert.equal(saved.totalEntriesExact,true);
  assert.equal(saved.complete,false);
  const meta=unwire({mapValue:{fields:f.documents.get('/0.6.2_s1_release_meta/current').fields}});
  assert.equal(meta.dirty,false);
  assert.equal(meta.overallIncompleteReason,'publication-limit');
  assert.equal(meta.overallRetryPending,false);
});

test('source-incomplete overall gets one delayed retry per revision, then stops retrying', async () => {
  const boards=[{trackId:TRACK,complete:false,entries:Array.from({length:200},(_,index)=>({accountId:`racer-${index}`,
    timeMs:20000+index,integrityVerified:true,runVerified:true}))}];
  const f=overallFixture(boards);
  await rebuildOverall(f.env,true);
  const saved=unwire({mapValue:{fields:f.snapshot()}});
  assert.equal(saved.complete,false);
  assert.equal(saved.totalEntries,200);
  assert.equal(saved.totalEntriesExact,false);
  const metaPath='/0.6.2_s1_release_meta/current';
  let metaDocument=f.documents.get(metaPath);
  let meta=unwire({mapValue:{fields:metaDocument.fields}});
  assert.equal(meta.dirty,true);
  assert.equal(meta.overallIncompleteReason,'source-track-incomplete');
  assert.equal(meta.overallIncompleteObservations,1);
  assert.equal(meta.overallRetryPending,true);
  assert.equal(meta.overallRetryExhausted,false);

  metaDocument.fields.lastOverallBuildAt=wire(0);
  await rebuildOverall(f.env,false);
  metaDocument=f.documents.get(metaPath);
  meta=unwire({mapValue:{fields:metaDocument.fields}});
  assert.equal(meta.dirty,false);
  assert.equal(meta.overallIncompleteObservations,2);
  assert.equal(meta.overallRetryPending,false);
  assert.equal(meta.overallRetryExhausted,true);

  const commitsAfterRetry=f.commits.length;
  assert.deepEqual(await rebuildOverall(f.env,false),{rebuilt:false,reason:'clean',revision:0});
  assert.equal(f.commits.length,commitsAfterRetry);
});

test('a prior server beta badge is retained with immutable source metadata without restarting migration', async () => {
  const boards=[{trackId:TRACK,entries:[
    {accountId:'beta-racer',timeMs:20000,integrityVerified:true,runVerified:true},
    {accountId:'other',timeMs:21000,integrityVerified:true,runVerified:true}
  ]}];
  let commit;
  const prior={entries:[{userId:'beta-racer',badges:{betaTester:true}}],revision:4,sourceRevision:4,updatedAt:1700000000000};
  const env={__TEST_FIRESTORE:async(path,init={})=>{
    if(path===':runQuery')return boards.map(board=>({document:{fields:wire(board).mapValue.fields}}));
    if(path===':batchGet')return [];
    if(path===':commit'){commit=JSON.parse(init.body);return {};}
    if(path.includes('s1_leaderboards_overall/main'))return {fields:wire(prior).mapValue.fields,updateTime:'v1'};
    if(path.includes('s1_release_meta'))return {fields:wire({dirty:true,revision:5}).mapValue.fields,updateTime:'v1'};
    return null;
  }};
  await rebuildOverall(env,true);
  const main=commit.writes.find(write=>write.update.name.endsWith('/0.6.2_s1_leaderboards_overall/main'));
  const saved=unwire({mapValue:{fields:main.update.fields}});
  const beta=saved.entries.find(entry=>entry.userId==='beta-racer');
  assert.equal(beta.badges.betaTester,true);
  assert.deepEqual(beta.betaEntitlement,{id:'beta-tester',source:'ranked-overall-snapshot',sourceRevision:4,issuedAt:1700000000000,cutoffAt:0});
  const entitlement=commit.writes.find(write=>write.update.name.endsWith('/0.6.2_s1_cosmetic_entitlements/beta-racer'));
  assert.deepEqual(unwire({mapValue:{fields:entitlement.update.fields}}).serverIssued.beta,beta.betaEntitlement);
});

test('a legacy server entitlement retains beta for a returning racer absent from the prior top 200', async () => {
  const boards=[{trackId:TRACK,entries:[
    {accountId:'returning-beta',timeMs:20000,integrityVerified:true,runVerified:true},
    {accountId:'other',timeMs:21000,integrityVerified:true,runVerified:true}
  ]}];
  let commit;
  const env={__TEST_FIRESTORE:async(path,init={})=>{
    if(path===':runQuery')return boards.map(board=>({document:{fields:wire(board).mapValue.fields}}));
    if(path===':batchGet')return [{found:{name:'projects/test/databases/(default)/documents/0.6.2_s1_cosmetic_entitlements/returning-beta',
      fields:wire({badge:['auto','betaTester']}).mapValue.fields,updateTime:'2026-09-01T00:00:00Z'}}];
    if(path===':commit'){commit=JSON.parse(init.body);return {};}
    if(path.includes('s1_release_meta'))return {fields:wire({dirty:true,revision:5}).mapValue.fields,updateTime:'v1'};
    return null;
  }};
  await rebuildOverall(env,true);
  const main=commit.writes.find(write=>write.update.name.endsWith('/0.6.2_s1_leaderboards_overall/main'));
  const beta=unwire({mapValue:{fields:main.update.fields}}).entries.find(entry=>entry.userId==='returning-beta');
  assert.equal(beta.badges.betaTester,true);
  assert.equal(beta.betaEntitlement.source,'legacy-cosmetic-entitlement');
  assert.equal(beta.betaEntitlement.issuedAt,Date.parse('2026-09-01T00:00:00Z'));
});

test('open beta defaults on and server-issues beta to current racers without migration', async () => {
  const boards=[{trackId:TRACK,entries:[
    {accountId:'new-063-racer',timeMs:20000,integrityVerified:true,runVerified:true},
    {accountId:'other',timeMs:21000,integrityVerified:true,runVerified:true}
  ]}];
  let commit;
  const env={__TEST_FIRESTORE:async(path,init={})=>{
    if(path===':runQuery')return boards.map(board=>({document:{fields:wire(board).mapValue.fields}}));
    if(path===':batchGet')return [];
    if(path===':commit'){commit=JSON.parse(init.body);return {};}
    if(path.includes('s1_release_meta'))return {fields:wire({dirty:true,revision:7}).mapValue.fields,updateTime:'v1'};
    return null;
  }};
  await rebuildOverall(env,true);
  const main=commit.writes.find(write=>write.update.name.endsWith('/0.6.2_s1_leaderboards_overall/main'));
  const saved=unwire({mapValue:{fields:main.update.fields}});
  const beta=saved.entries.find(entry=>entry.userId==='new-063-racer');
  assert.equal(saved.betaPolicy.open,true);
  assert.equal(beta.badges.betaTester,true);
  assert.equal(beta.betaEntitlement.source,'open-beta-release');
  assert.equal(beta.betaEntitlement.sourceRevision,7);
  assert.ok(beta.betaEntitlement.issuedAt>0);
});

test('closing open beta excludes new racers but retains persisted server entitlement', async () => {
  const boards=[{trackId:TRACK,entries:[
    {accountId:'retained-beta',timeMs:20000,integrityVerified:true,runVerified:true},
    {accountId:'after-close',timeMs:21000,integrityVerified:true,runVerified:true}
  ]}];
  const persisted={id:'beta-tester',source:'open-beta-release',sourceRevision:6,issuedAt:1700000000000,cutoffAt:0};
  let commit;
  const env={OPEN_BETA_ENABLED:'false',__TEST_FIRESTORE:async(path,init={})=>{
    if(path===':runQuery')return boards.map(board=>({document:{fields:wire(board).mapValue.fields}}));
    if(path===':batchGet')return [{found:{name:'projects/test/databases/(default)/documents/0.6.2_s1_cosmetic_entitlements/retained-beta',
      fields:wire({serverIssued:{beta:persisted}}).mapValue.fields,updateTime:'2026-09-01T00:00:00Z'}}];
    if(path===':commit'){commit=JSON.parse(init.body);return {};}
    if(path.includes('s1_release_meta'))return {fields:wire({dirty:true,revision:8}).mapValue.fields,updateTime:'v1'};
    return null;
  }};
  await rebuildOverall(env,true);
  const main=commit.writes.find(write=>write.update.name.endsWith('/0.6.2_s1_leaderboards_overall/main'));
  const saved=unwire({mapValue:{fields:main.update.fields}});
  const retained=saved.entries.find(entry=>entry.userId==='retained-beta');
  const fresh=saved.entries.find(entry=>entry.userId==='after-close');
  assert.equal(saved.betaPolicy.open,false);
  assert.deepEqual(retained.betaEntitlement,persisted);
  assert.equal(retained.badges.betaTester,true);
  assert.equal(fresh.betaEntitlement,null);
  assert.equal(fresh.badges,null);
});

test('planner packs all finishes losslessly without changing rankings or persisting full arrays', async () => {
  const boards = [TRACK, COMMUNITY_TRACK, CUSTOM_TRACK].map((trackId, i) => ({trackId, entries:
    ['racer', 'other'].map((accountId, r) => ({accountId, name: accountId, timeMs: 20000+r+i, pbAt: 1780000000000+i, integrityVerified: true, runVerified: true}))}));
  const old = computeOverall(boards);
  const full = computeOverall(boards, old, new Set(), {includePlannerResults: true});
  const stripped = full.map(({resultSamples, ...entry}) => entry);
  assert.deepEqual(stripped, computeOverall(boards, old));
  const input = JSON.stringify(full);
  const packed = await packPlannerResults(full, {entries: stripped}, {boardCount: 3});
  assert.equal(packed.resultBundleVersion, 1);
  assert.equal(packed.resultBundleStatus, 'complete');
  assert.equal(packed.resultBundleComplete, true);
  const decoded = await unpackPlanner(packed);
  assert.deepEqual(decoded.resultTracks, [TRACK, COMMUNITY_TRACK, CUSTOM_TRACK].sort());
  for (const row of decoded.entries) {
    const expected = full.find(e => e.userId === row.userId).resultSamples;
    const tuples = JSON.parse(row.resultData);
    assert.equal(tuples.length, 3);
    for (const [index, rank, fieldSize, weight, competition, timeMs, pbAt] of tuples) {
      const sample = expected.find(s => s.trackId === decoded.resultTracks[index]);
      assert.deepEqual([rank,fieldSize,weight,competition,timeMs,pbAt],
        [sample.rank,sample.fieldSize,sample.weight,sample.competition,sample.timeMs,sample.pbAt]);
    }
  }
  assert.equal(JSON.stringify(full), input);
  const f = overallFixture(boards);
  await rebuildOverall(f.env, true);
  const stored = f.snapshot();
  assert.equal(stored.resultBundleVersion.integerValue, '1');
  assert.ok(stored.entries.arrayValue.values.every(e => !e.mapValue.fields.resultSamples && !e.mapValue.fields.resultData));
  assert.deepEqual(await unpackPlanner({resultBundle: stored.resultBundle.stringValue}), decoded);
});

test('overflow returns a complete sidecar bundle and invalid or unavailable data is explicit', async () => {
  const entry = {userId: 'racer', resultSamples: [{trackId: TRACK, rank: 1, fieldSize: 2,
    weight: 1.1, competition: 1, timeMs: 20000, pbAt: 1780000000000}]};
  const large = await packPlannerResults([entry], {padding: 'x'.repeat(900000)}, {boardCount: 100});
  assert.equal(large.resultBundleStatus, 'sidecar');
  assert.equal(large.resultBundleComplete, true);
  assert.equal(large.resultBoardLimitReached, true);
  assert.equal(large.resultCoverage, 'snapshot_boards');
  assert.equal(JSON.parse((await unpackPlanner(large)).entries[0].resultData).length, 1);
  const invalid = await packPlannerResults([{...entry, resultSamples: [...entry.resultSamples, ...entry.resultSamples]}], {});
  assert.equal(invalid.resultBundleStatus, 'invalid_results');
  assert.ok(!invalid.resultBundle);
  const empty = await packPlannerResults([], {});
  assert.deepEqual(await unpackPlanner(empty), {resultTracks: [], entries: []});
  const original = globalThis.CompressionStream;
  try {
    globalThis.CompressionStream = class {constructor() {throw Error('unavailable');}};
    const unavailable = await packPlannerResults([entry], {});
    assert.equal(unavailable.resultBundleStatus, 'compression_unavailable');
    assert.equal(unavailable.resultBundleComplete, false);
  } finally {globalThis.CompressionStream = original;}
});

function entropyBoards(seed) {
  let state = seed;
  const random = () => {state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0)/4294967296;};
  const token = length => Array.from({length}, () => '0123456789abcdef'[Math.floor(random()*16)]).join('');
  const users = Array.from({length: 200}, () => ({accountId: token(28), name: token(24)}));
  return Array.from({length: 78}, () => ({trackId: token(64), updatedAt: 1780000000000,
    entries: users.map(user => ({...user, countryCode: 'US', carStyle: 'standard',
      timeMs: 10000+Math.floor(random()*290000), pbAt: 1700000000000+Math.floor(random()*100000000000),
      totalPlaytimeMs: Math.floor(random()*1000000000), accountCreatedAt: 1600000000000,
      integrityVerified: true, runVerified: true}))}));
}

test('high-entropy 200 by 78 planner compression benchmark publishes every result inline or in one bounded sidecar', async t => {
  const measurements = [];
  for (const seed of [12345, 67890, 987654321]) {
    const boards = entropyBoards(seed);
    const full = computeOverall(boards, [], new Set(), {includePlannerResults: true});
    const f = overallFixture(boards);
    await rebuildOverall(f.env, true);
    // Decode the wire representation without using production credentials or network calls.
    function decode(v) {
      if (v.mapValue) return Object.fromEntries(Object.entries(v.mapValue.fields).map(([k,x]) => [k,decode(x)]));
      if (v.arrayValue) return v.arrayValue.values.map(decode);
      if ('integerValue' in v) return Number(v.integerValue);
      if ('doubleValue' in v) return v.doubleValue;
      if ('booleanValue' in v) return v.booleanValue;
      if ('nullValue' in v) return null;
      return v.stringValue;
    }
    const saved = decode({mapValue: {fields: f.snapshot()}});
    const base = Object.fromEntries(Object.entries(saved).filter(([key]) => !key.startsWith('result')));
    const packedAlone = await packPlannerResults(full, {}, {boardCount: 78});
    const inflated = await unpackPlanner(packedAlone);
    assert.equal(inflated.entries.length, 200);
    assert.ok(inflated.entries.every(row => JSON.parse(row.resultData).length === 78));
    const prospective = {...base, ...packedAlone};
    const bytes = plannerDocumentBytes(prospective);
    assert.equal(saved.resultBundleStatus, bytes < PLANNER_DOCUMENT_BUDGET ? 'complete' : 'sidecar');
    assert.equal(saved.resultBundleComplete, true);
    if (saved.resultBundle) assert.ok(plannerDocumentBytes(saved) < PLANNER_DOCUMENT_BUDGET);
    else {
      assert.equal(saved.resultBundleLocation, 'main_results');
      const sidecar = decode({mapValue: {fields: f.sidecar()}});
      assert.ok(plannerDocumentBytes(sidecar) < PLANNER_DOCUMENT_BUDGET);
      assert.ok(plannerDocumentBytes(saved) < 1048576);
      for (const key of ['sourceRevision','builtRevision','updatedAt','algorithmVersion','resultBundleVersion']) assert.equal(sidecar[key], saved[key]);
      assert.deepEqual(await unpackPlanner(sidecar), inflated);
    }
    measurements.push({seed, baseFirestoreBytes: plannerDocumentBytes(base), baseJsonBytes: Buffer.byteLength(JSON.stringify(base)),
      gzipBytes: atob(packedAlone.resultBundle).length, base64Bytes: packedAlone.resultBundle.length,
      combinedFirestoreBytes: bytes, mainFirestoreBytes: plannerDocumentBytes(saved),
      sidecarFirestoreBytes: f.sidecar() ? plannerDocumentBytes(decode({mapValue: {fields: f.sidecar()}})) : 0,
      location: saved.resultBundleLocation || 'inline'});
  }
  t.diagnostic(JSON.stringify(measurements));
});

test('cold recovery cron fits the fifty-subrequest budget with four bootstrap and four rebuild tracks plus overall', async () => {
  const base = 'projects/polytrack-052/databases/(default)/documents/';
  const tracks = Array.from({length:4}, (_, i) => String(i).padStart(64,'0'));
  const documents = new Map(tracks.map(trackId => ['/0.6.2_s1_leaderboards_track/'+trackId,
    {name: base+'0.6.2_s1_leaderboards_track/'+trackId, updateTime: 'v0', fields: wire({trackId,
      entries:[{accountId:'racer',trackId,timeMs:30000,raceTimeFrames:30000}]}).mapValue.fields}]));
  const results = tracks.map(trackId => ({name:base+'0.6.2_race_results/racer_'+trackId,
    fields: wire(validRun({accountId:'racer',trackId,timeMs:20000})).mapValue.fields}));
  let calls=0, sequence=0;
  const env = {__TEST_FIRESTORE: async (p, init={}) => {
    calls++;
    if (p === ':runQuery') {
      const q=JSON.parse(init.body).structuredQuery;
      if (q.from[0].collectionId === '0.6.2_s1_leaderboards_track') return tracks.map(id => ({document:documents.get('/0.6.2_s1_leaderboards_track/'+id)}));
      if (q.where?.fieldFilter?.field?.fieldPath === 'trackId') return results.filter(r => r.fields.trackId.stringValue===q.where.fieldFilter.value.stringValue).map(document => ({document}));
      return results.map(document => ({document}));
    }
    if (p === ':commit') {
      for (const w of JSON.parse(init.body).writes) documents.set('/'+w.update.name.split('/documents/')[1], {...w.update,updateTime:'v'+(++sequence)});
      return {};
    }
    return documents.get(p) || null;
  }};
  let completion;
  worker.scheduled({cron:'0-59/5 * * * *'}, env, {waitUntil: promise => {completion=promise;}});
  await completion;
  // One extra token request is needed with a cold service-token cache.
  assert.equal(calls+1, 41);
  assert.ok(calls+1 < 50);
});


test('overall pages beyond 100 boards without truncating normal RP or planner results',async()=>{
  const boards=Array.from({length:101},(_,i)=>({trackId:String(i).padStart(64,'0'),entries:
    ['racer','other'].map((accountId,r)=>({accountId,name:accountId,timeMs:20000+r,pbAt:1780000000000,integrityVerified:true,runVerified:true})),complete:true}));
  const f=overallFixture(boards);
  await rebuildOverall(f.env,true);
  const saved=f.snapshot();
  assert.equal(saved.resultBoardCount.integerValue,'101');
  assert.equal(saved.resultBoardLimit.integerValue,'500');
  assert.equal(saved.resultBoardLimitReached.booleanValue,false);
  assert.equal(saved.complete.booleanValue,true);
  assert.equal(saved.totalEntriesExact.booleanValue,true);
  assert.equal(saved.resultCoverage.stringValue,'snapshot_boards');
  const meta=unwire({mapValue:{fields:f.documents.get('/0.6.2_s1_release_meta/current').fields}});
  assert.equal(meta.dirty,false);
  assert.equal(meta.overallIncompleteReason,'');
  const decoded=await unpackPlanner({resultBundle:saved.resultBundle.stringValue});
  assert.equal(decoded.resultTracks.length,101);
  assert.ok(decoded.entries.every(row=>JSON.parse(row.resultData).length===101));
  assert.equal(f.calls.filter(p=>p===':runQuery').length,2);
});

test('overall distinguishes an exact 500-board set from a capped 501-board set',async()=>{
  const boards=Array.from({length:501},(_,i)=>({trackId:String(i).padStart(64,'0'),complete:true,entries:[]}));
  for(const [count,reached] of [[500,false],[501,true]]){
    const f=overallFixture(boards.slice(0,count));
    await rebuildOverall(f.env,true);
    const saved=unwire({mapValue:{fields:f.snapshot()}});
    assert.equal(saved.resultBoardCount,500);
    assert.equal(saved.resultBoardLimit,500);
    assert.equal(saved.resultBoardLimitReached,reached);
    assert.equal(saved.complete,!reached);
    assert.equal(saved.totalEntriesExact,!reached);
    assert.equal(f.calls.filter(p=>p===':runQuery').length,6);
  }
});


test('overflow sidecar, main and metadata commit atomically; conflict cannot publish a mismatched pair',async()=>{
  const f=overallFixture(entropyBoards(12345));
  await rebuildOverall(f.env,true);
  assert.equal(f.commits.length,1);
  const commit=f.commits[0];
  const sidecar=commit.find(w=>w.update.name.endsWith('/0.6.2_s1_leaderboards_overall/main_results'));
  const main=commit.find(w=>w.update.name.endsWith('/0.6.2_s1_leaderboards_overall/main'));
  const meta=commit.find(w=>w.update.name.endsWith('/0.6.2_s1_release_meta/current'));
  assert.ok(sidecar && main && meta);
  assert.equal(main.currentDocument.exists,false);
  assert.equal(meta.currentDocument.exists,false);
  assert.ok(!('currentDocument' in sidecar));
  assert.ok(!main.update.fields.resultBundle);
  assert.equal(main.update.fields.resultBundleLocation.stringValue,'main_results');
  const savedMain=JSON.stringify(f.snapshot()),savedSidecar=JSON.stringify(f.sidecar());
  f.setFailCommit(true);
  await assert.rejects(rebuildOverall(f.env,true),/409/);
  assert.equal(JSON.stringify(f.snapshot()),savedMain);
  assert.equal(JSON.stringify(f.sidecar()),savedSidecar);
  const failed=f.commits[1];
  assert.equal(failed.find(w=>w.update.name.endsWith('/0.6.2_s1_leaderboards_overall/main')).currentDocument.updateTime,'v1');
  assert.equal(failed.find(w=>w.update.name.endsWith('/0.6.2_s1_release_meta/current')).currentDocument.updateTime,'v1');
  assert.equal(f.calls.filter(p=>p.endsWith('/main_results')).length,0);
});

test('thirty racers stay inline without sidecar reads or writes, and shrinking a board removes the old location',async()=>{
  const boards=entropyBoards(2468);
  const f=overallFixture(boards);
  await rebuildOverall(f.env,true);
  assert.ok(f.snapshot().resultBundleLocation);
  const oldSidecar=JSON.stringify(f.sidecar());
  for(const board of boards)board.entries=board.entries.slice(0,30);
  await rebuildOverall(f.env,true);
  assert.ok(f.snapshot().resultBundle);
  assert.ok(!f.snapshot().resultBundleLocation);
  const decoded=await unpackPlanner({resultBundle:f.snapshot().resultBundle.stringValue});
  assert.equal(decoded.entries.length,30);
  assert.ok(decoded.entries.every(row=>JSON.parse(row.resultData).length===78));
  assert.ok(!f.commits[1].some(w=>w.update.name.endsWith('/main_results')));
  assert.equal(JSON.stringify(f.sidecar()),oldSidecar);
  assert.equal(f.calls.filter(p=>p.endsWith('/main_results')).length,0);
});

test('digest bootstrap wakes terminal NEVER queues despite completed old bootstrap, without due query',async()=>{
  const {PRE_EVENT_LAUNCH_ENGINE}=await import('../src/event-engine-compatibility.js');
  const {eventDecode}=await import('../src/events-store.js');
  const f=bootstrapFixture(2),base='projects/test/databases/(default)/documents/';
  const oldJobId=VERIFICATION_BOOTSTRAP_ID.replace(VERIFIER_ENGINE_DIGEST,PRE_EVENT_LAUNCH_ENGINE);
  assert.notEqual(oldJobId,VERIFICATION_BOOTSTRAP_ID);
  const oldJob={name:base+'0.6.2_s1_worker_jobs/'+oldJobId,fields:wire({complete:true}).mapValue.fields,updateTime:'old-complete'};
  f.docs.set('/0.6.2_s1_worker_jobs/'+oldJobId,oldJob);
  for(let i=0;i<2;i++) {
    const trackId=String(i).padStart(64,'0');
    const row={accountId:'racer',trackId,timeMs:20000,raceTimeFrames:20000};
    const key=JSON.parse(verificationKey(row));key[1]=PRE_EVENT_LAUNCH_ENGINE;
    const state={trackId,pending:false,notBefore:Number.MAX_SAFE_INTEGER,slots:{racer:{...pendingSlot(row),
      key:JSON.stringify(key),status:'verified',engineDigest:PRE_EVENT_LAUNCH_ENGINE,retryAt:Number.MAX_SAFE_INTEGER}}};
    f.docs.set('/0.6.2_s1_verification/'+trackId,{name:base+'0.6.2_s1_verification/'+trackId,
      fields:wire(state).mapValue.fields,updateTime:'old-terminal-'+i});
  }
  const before=Date.now();assert.deepEqual(await bootstrapSnapshotVerification(f.env),{scanned:2,complete:true});
  assert.equal(f.calls.length,5,'one new job read, one board page, two queues, one atomic commit');
  for(let i=0;i<2;i++) {
    const trackId=String(i).padStart(64,'0');
    const state=eventDecode({mapValue:{fields:f.docs.get('/0.6.2_s1_verification/'+trackId).fields}});
    assert.equal(state.pending,true);assert.equal(state.slots.racer.status,'waiting');
    assert.ok(state.notBefore>=before&&state.notBefore<=Date.now());
    assert.equal(JSON.parse(state.slots.racer.key)[1],VERIFIER_ENGINE_DIGEST);
  }
  assert.deepEqual(f.docs.get('/0.6.2_s1_worker_jobs/'+oldJobId),oldJob);
});

function previousGhostProof(row){
 const digest='895eeacbdfdd5f68b9db92c502af620709539c5211782809f610c1a76e60785d';
 const key=JSON.parse(verificationKey(row));key[1]=digest;
 return {...pendingSlot(row),key:JSON.stringify(key),status:'verified',engineDigest:digest,retryAt:Number.MAX_SAFE_INTEGER};
}
test('snapshot and equal-PB notification preserve exact previous approved proof without queue replacement',async()=>{
 const row=validRun({accountId:'racer',trackId:TRACK,timeMs:20000});const proof=previousGhostProof(row);
 assert.equal(computeTrackEntries([row],TRACK,{}, {racer:proof})[0].runVerified,true);
 assert.equal(computeTrackEntries([{...row,timeMs:19999,raceTimeFrames:19999}],TRACK,{}, {racer:proof})[0].runVerified,false);
 let writes=0;
 const env={__TEST_FIRESTORE:async(p,init={})=>{
  if(p===':commit'){writes++;return {};}
  if(p.includes('s1_leaderboards_track'))return {fields:wire({algorithmVersion:'participation-v8-s1',revision:2,entries:[row]}).mapValue.fields,updateTime:'v1'};
  if(p.includes('s1_verification'))return {fields:wire({trackId:TRACK,slots:{racer:proof},pending:false,notBefore:Number.MAX_SAFE_INTEGER}).mapValue.fields,updateTime:'v1'};
  throw Error('unexpected path '+p);
 }};
 const result=await mergeCanonicalResultIntoTrack(env,TRACK,row,true);
 assert.equal(result.changed,false);assert.equal(writes,0);
});
test('bounded digest bootstrap retains exact approved NEVER slot but wakes changed PB',async()=>{
 const {eventDecode}=await import('../src/events-store.js');const f=bootstrapFixture(2),base='projects/test/databases/(default)/documents/';
 for(let i=0;i<2;i++){
  const trackId=String(i).padStart(64,'0'),row={accountId:'racer',trackId,timeMs:20000,raceTimeFrames:20000};
  const proof=previousGhostProof(i===0?row:{...row,timeMs:20001,raceTimeFrames:20001});
  f.docs.set('/0.6.2_s1_verification/'+trackId,{name:base+'0.6.2_s1_verification/'+trackId,fields:wire({trackId,pending:false,notBefore:Number.MAX_SAFE_INTEGER,slots:{racer:proof}}).mapValue.fields,updateTime:'old'+i});
 }
 assert.deepEqual(await bootstrapSnapshotVerification(f.env),{scanned:2,complete:true});
 for(let i=0;i<2;i++){
  const state=eventDecode({mapValue:{fields:f.docs.get('/0.6.2_s1_verification/'+String(i).padStart(64,'0')).fields}});
  assert.equal(state.slots.racer.status,i===0?'verified':'waiting');assert.equal(state.pending,i!==0);
  if(i===0)assert.equal(state.notBefore,Number.MAX_SAFE_INTEGER);else assert.notEqual(state.notBefore,Number.MAX_SAFE_INTEGER);
 }
});
