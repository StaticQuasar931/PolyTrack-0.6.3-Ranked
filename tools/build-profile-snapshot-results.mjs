import fs from 'node:fs/promises';
import path from 'node:path';
import {publicDisplayName} from './public-display-name.mjs';
import {fileURLToPath} from 'node:url';

const ID=/^[a-f0-9]{64}$/;
const fields=['trackId','rank','position','fieldSize','weight','competition','timeMs','frames','raceTimeFrames','timingVersion','pbAt','createdAt','updatedAt','runVerified','verified','verifiedState','integrityVerified','uploadId','replayHash'];
async function optional(file){try{return JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function names(dir){try{return await fs.readdir(dir);}catch(error){if(error.code==='ENOENT')return [];throw error;}}

// Derive compact public per-racer indexes from already captured files: no cloud reads.
export async function buildProfileSnapshotResults(directory){
  const racers=new Map();
  const overall=await optional(path.join(directory,'overall.json'));
  const manifest=await optional(path.join(directory,'manifest.json'));
  const summary=await optional(path.join(directory,'public-export-summary.json'));
  const published=new Map((overall?.entries||[]).map(row=>[row.userId||row.accountId,row]));
  const identities=new Map();
  const identityFields=['name','nickname','countryCode','carStyle','carId','carColors','profileCosmetics'];
  const cosmeticFields=['version','theme','accent','finish','plate','edge','stage','stageTint','stripe','stageEffect','emblem','emblem2','emblem3','emblemBackdrop','nameFont','nameSize','nameWeight','nameColor','baseSecondary','title','badge','favoriteTrackId','overridePodium'];
  function rememberIdentity(accountId,row,updatedAt){
    if(!ID.test(accountId||''))return;
    const at=Math.max(0,Number(row?.identityUpdatedAt)||Number(row?.profileUpdatedAt)||Number(row?.updatedAt)||Number(updatedAt)||0);
    const previous=identities.get(accountId)||{updatedAt:0};
    const incoming=Object.fromEntries(identityFields.filter(key=>row?.[key]!==undefined).map(key=>[key,
      ['name','nickname'].includes(key)?publicDisplayName(row[key]):key==='profileCosmetics'?
        Object.fromEntries(cosmeticFields.filter(field=>['string','number','boolean'].includes(typeof row[key]?.[field])).map(field=>[field,row[key][field]])):row[key]]));
    identities.set(accountId,at>=previous.updatedAt?{...previous,...incoming,updatedAt:at}:{...incoming,...previous});
  }
  // A board rebuild time is not a profile edit time.
  for(const [id,row]of published)rememberIdentity(id,row,row.profileUpdatedAt||row.identityUpdatedAt||row.latestPbAt);
  const ensure=id=>{if(!ID.test(id||''))return null;if(!racers.has(id))racers.set(id,new Map());return racers.get(id);};
  for(const id of published.keys())ensure(id);
  for(const file of await names(path.join(directory,'profiles')))if(ID.test(file.replace(/\.json$/,'')))ensure(file.replace(/\.json$/,''));
  let boards=0;
  for(const file of await names(path.join(directory,'tracks'))){
    const trackId=file.replace(/\.json$/,'');if(!ID.test(trackId)||!file.endsWith('.json'))continue;
    const board=await optional(path.join(directory,'tracks',file));
    if(board?.trackId!==trackId||!Array.isArray(board.entries))throw Error('Invalid captured track board: '+trackId);
    boards++;
    for(const row of board.entries){
      rememberIdentity(row.accountId||row.userId,row,Number(row.pbAt)||Number(row.createdAt)||0);
      const results=ensure(row.accountId||row.userId);if(!results||!(Number(row.timeMs)>0))continue;
      const finish=Object.fromEntries(fields.filter(key=>row[key]!==undefined).map(key=>[key,row[key]]));
      finish.trackId=trackId;finish.fieldSize=Math.max(Number(row.rank)||0,Number(row.fieldSize)||board.entries.length);
      finish.cachedAt=Number(board.updatedAt)||0;finish.complete=board.complete===true;
      const checkedAt=Number(manifest?.tracks?.[trackId]?.checkedAt);
      if(Number.isSafeInteger(checkedAt)&&checkedAt>0)finish.snapshotCapturedAt=checkedAt;
      results.set(trackId,finish);
    }
  }
  for(const trackId of await names(path.join(directory,'canonical'))){
    if(!ID.test(trackId))continue;
    for(const file of await names(path.join(directory,'canonical',trackId))){
      const accountId=file.replace(/\.json$/,'');if(!ID.test(accountId)||!file.endsWith('.json'))continue;
      const row=await optional(path.join(directory,'canonical',trackId,file));
      if(row?.accountId!==accountId||row.trackId!==trackId||!(Number(row.timeMs)>0))throw Error('Invalid captured canonical result');
      const results=ensure(accountId),previous=results.get(trackId);
      if(previous&&Number(previous.timeMs)<=Number(row.timeMs))continue;
      const finish=Object.fromEntries(fields.filter(key=>row[key]!==undefined).map(key=>[key,row[key]]));
      // Never transfer a placement from a different PB or infer a missing field.
      finish.rank=Number(row.rank)>0?Number(row.rank):null;
      finish.fieldSize=Number(row.fieldSize)>0?Number(row.fieldSize):null;
      finish.cachedAt=Number(row.updatedAt)||0;finish.complete=false;
      results.set(trackId,finish);
    }
  }
  // Event-only racers need their public identity too, without counting event PBs as normal finishes.
  for(const file of await names(path.join(directory,'events'))){
    if(!/^[A-Za-z0-9_-]{1,64}\.json$/.test(file))continue;
    const board=await optional(path.join(directory,'events',file));
    for(const row of board?.entries||[]){
      const id=row.accountId||row.userId;if(!ID.test(id||''))continue;
      rememberIdentity(id,row,Number(row.runAt)||Number(row.pbAt)||0);ensure(id);
    }
  }
  const extraCatalog=await optional(fileURLToPath(new URL('../extra-tracks/catalog.json',import.meta.url)));
  const extraIds=new Set((Array.isArray(extraCatalog)?extraCatalog:extraCatalog?.tracks||[]).filter(row=>row.unranked!==true).map(row=>row.trackId));
  const output=path.join(directory,'profile-results');await fs.mkdir(output,{recursive:true});
  let resultCount=0;const cosmeticEntries={};let cosmeticUpdatedAt=0;
  for(const [accountId,results]of racers){
    const finishes=[...results.values()].sort((a,b)=>a.trackId.localeCompare(b.trackId));resultCount+=finishes.length;
    const publicStatus=published.get(accountId);
    const publicProfile=await optional(path.join(directory,'profiles',accountId+'.json'))||
      (publicStatus?{accountId}:null);
    if(publicProfile)rememberIdentity(accountId,publicProfile,0);
    if(publicProfile&&publicStatus)for(const key of ['profileCosmetics','cosmeticUnlocks','serverAchievements','badges','rankTier','rankSince'])
      if(!Object.hasOwn(publicProfile,key)&&Object.hasOwn(publicStatus,key))publicProfile[key]=publicStatus[key];
    const identity=identities.get(accountId);
    const profileAt=Math.max(Number(publicProfile?.identityUpdatedAt)||0,Number(publicProfile?.updatedAt)||0);
    // Reuse newer already-captured public identity; no additional profile reads.
    if(publicProfile&&identity&&identity.updatedAt>profileAt){
      for(const key of identityFields)if(Object.hasOwn(identity,key))publicProfile[key]=identity[key];
      publicProfile.identityUpdatedAt=identity.updatedAt;
    }
    const eligible=finishes.filter(row=>row.runVerified===true&&row.integrityVerified===true&&row.fieldSize>=2);
    const metric=(key,fallback=0)=>{const value=Number(publicStatus?.[key]??publicProfile?.[key]??fallback);return Number.isSafeInteger(value)&&value>=0?value:0;};
    const cosmeticContext={rank:metric('rank'),raceCount:metric('raceCount',eligible.length),
      pbCount:metric('pbCount'),totalPlaytimeMs:metric('totalPlaytimeMs'),
      extraCount:metric('extraCount',eligible.filter(row=>extraIds.has(row.trackId)).length),
      trackWins:metric('trackWins',eligible.filter(row=>row.rank===1&&row.fieldSize>=5).length),
      ...((publicStatus?.badges??publicProfile?.badges)?.betaTester===true?{badges:{betaTester:true}}:{}),
      ...(Array.isArray(publicStatus?.cosmeticUnlocks??publicProfile?.cosmeticUnlocks)?{cosmeticUnlocks:(publicStatus?.cosmeticUnlocks??publicProfile?.cosmeticUnlocks).filter(id=>typeof id==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,63}:[A-Za-z0-9_-]{1,64}$/.test(id)).slice(0,32)}:{})};
    if(identity)identities.set(accountId,{...identity,cosmeticContext});
    const value={accountId,updatedAt:Math.max(Number(overall?.updatedAt)||0,...finishes.map(row=>Number(row.cachedAt)||0)),
      capturedAt:summary?.capturedAt||null,results:finishes,expectedEligibleTracks:Number(published.get(accountId)?.raceCount)||0,
      coverage:{boardsPresent:boards,boardsKnown:Number(manifest?.trackIdsKnown)||boards,allTracksCaptured:boards>=Number(manifest?.trackIdsKnown||Infinity)},
      publicProfile};
    if(value.publicProfile?.profileCosmetics){const at=Math.max(Number(value.publicProfile.identityUpdatedAt)||0,Number(value.publicProfile.updatedAt)||0);cosmeticEntries[accountId]={at,value:value.publicProfile.profileCosmetics};cosmeticUpdatedAt=Math.max(cosmeticUpdatedAt,at);}
    const body=JSON.stringify(value)+'\n';if(Buffer.byteLength(body)>2*1024*1024)throw Error('Profile results exceed client limit');
    await fs.writeFile(path.join(output,accountId+'.json'),body);
  }
  const cosmetics=JSON.stringify({updatedAt:cosmeticUpdatedAt,entries:cosmeticEntries})+'\n';
  if(Buffer.byteLength(cosmetics)>2*1024*1024)throw Error('Snapshot cosmetic directory exceeds client limit');
  await fs.writeFile(path.join(directory,'cosmetic-directory.json'),cosmetics);
  const totalsPath=path.join(directory,'event-totals.json'),totals=await optional(totalsPath);
  if(totals&&Array.isArray(totals.entries)){
    const enriched={...totals,entries:totals.entries.map(row=>{
      const identity=identities.get(row.accountId||row.userId);if(!identity)return row;
      return {...row,...Object.fromEntries(identityFields.filter(key=>Object.hasOwn(identity,key)).map(key=>[key,identity[key]])),identityUpdatedAt:identity.updatedAt};
    })};
    await fs.writeFile(totalsPath,JSON.stringify(enriched)+'\n');
  }
  const racerDirectory=JSON.stringify({updatedAt:Math.max(0,...[...identities.values()].map(row=>row.updatedAt)),entries:Object.fromEntries(identities)})+'\n';
  if(Buffer.byteLength(racerDirectory)>2*1024*1024)throw Error('Snapshot racer directory exceeds client limit');
  await fs.writeFile(path.join(directory,'racer-directory.json'),racerDirectory);
  return {profiles:racers.size,results:resultCount,boards};
}
