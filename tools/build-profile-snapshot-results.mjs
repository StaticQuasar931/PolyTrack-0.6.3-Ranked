import fs from 'node:fs/promises';
import path from 'node:path';

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
      const results=ensure(row.accountId||row.userId);if(!results||!(Number(row.timeMs)>0))continue;
      const finish=Object.fromEntries(fields.filter(key=>row[key]!==undefined).map(key=>[key,row[key]]));
      finish.trackId=trackId;finish.fieldSize=Math.max(Number(row.rank)||0,Number(row.fieldSize)||board.entries.length);
      finish.cachedAt=Number(board.updatedAt)||0;finish.complete=board.complete===true;
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
  const output=path.join(directory,'profile-results');await fs.mkdir(output,{recursive:true});
  let resultCount=0;const cosmeticEntries={};let cosmeticUpdatedAt=0;
  for(const [accountId,results]of racers){
    const finishes=[...results.values()].sort((a,b)=>a.trackId.localeCompare(b.trackId));resultCount+=finishes.length;
    const value={accountId,updatedAt:Math.max(Number(overall?.updatedAt)||0,...finishes.map(row=>Number(row.cachedAt)||0)),
      capturedAt:summary?.capturedAt||null,results:finishes,expectedEligibleTracks:Number(published.get(accountId)?.raceCount)||0,
      coverage:{boardsPresent:boards,boardsKnown:Number(manifest?.trackIdsKnown)||boards,allTracksCaptured:boards>=Number(manifest?.trackIdsKnown||Infinity)},
      publicProfile:await optional(path.join(directory,'profiles',accountId+'.json'))};
    if(value.publicProfile?.profileCosmetics){const at=Number(value.publicProfile.updatedAt)||0;cosmeticEntries[accountId]={at,value:value.publicProfile.profileCosmetics};cosmeticUpdatedAt=Math.max(cosmeticUpdatedAt,at);}
    const body=JSON.stringify(value)+'\n';if(Buffer.byteLength(body)>2*1024*1024)throw Error('Profile results exceed client limit');
    await fs.writeFile(path.join(output,accountId+'.json'),body);
  }
  const cosmetics=JSON.stringify({updatedAt:cosmeticUpdatedAt,entries:cosmeticEntries})+'\n';
  if(Buffer.byteLength(cosmetics)>2*1024*1024)throw Error('Snapshot cosmetic directory exceeds client limit');
  await fs.writeFile(path.join(directory,'cosmetic-directory.json'),cosmetics);
  return {profiles:racers.size,results:resultCount,boards};
}
