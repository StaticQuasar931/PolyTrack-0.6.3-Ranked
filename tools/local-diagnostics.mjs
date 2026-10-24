// Export known game-owned structures only, never browser storage or profile credentials.
const HASH=/^[a-f0-9]{64}$/;
const PREFIX='polytrack_v5_prod_';
export async function collectLocalDiagnostics({storage,hashToken,localRows=[],trackInfo=()=>({}),practiceRows=()=>[],profileInfo=()=>({}),activeId=''}={}){
 const profiles=new Map(),tracks=new Map(),nativeProfiles=[];let blockedReads=0;
 const read=key=>{try{return JSON.parse(storage.getItem(key)||'null');}catch{blockedReads++;return null;}};
 let keys=[];try{keys=Object.keys(storage);}catch{blockedReads++;}
 const ensure=id=>{if(!HASH.test(id||''))return null;if(!profiles.has(id)){const info=profileInfo(id)||{};profiles.set(id,{publicId:id,name:info.name||info.nickname||'',carColors:info.carColors||'',carStyle:info.carStyle||'',cosmetics:info.profileCosmetics||null,playtimeMs:Number(info.totalPlaytimeMs)||0,personalBests:[]});}return profiles.get(id);};
 const rememberTrack=id=>{if(!HASH.test(id||''))return;const info=trackInfo(id)||{};tracks.set(id,{trackId:id,name:info.name||'',author:info.author||'',source:info.type||'custom',official:info.type==='official'});};
 const rememberPb=(profile,row)=>{const ms=Number(row.timeMs||row.frames)||0;if(!profile||!HASH.test(row.trackId||'')||ms<=0)return;rememberTrack(row.trackId);const info=trackInfo(row.trackId)||{};const pb={trackId:row.trackId,trackName:info.name||'',timeMs:ms,frames:Number(row.frames)||ms,achievedAt:Number(row.pbAt||row.createdAt)||0,mode:row.mode||'default'};const existing=profile.personalBests.find(p=>p.trackId===pb.trackId&&p.mode===pb.mode);if(!existing)profile.personalBests.push(pb);else if(pb.timeMs<existing.timeMs)Object.assign(existing,pb);};
 for(const key of keys.filter(k=>/^polytrack_v5_prod_user_\d+$/.test(k))){
  const row=read(key);if(!row||!HASH.test(row.token||'')||typeof hashToken!=='function')continue;
  let id='';try{id=await hashToken(row.token);}catch{blockedReads++;}const profile=ensure(id);if(!profile)continue;
  Object.assign(profile,{name:String(row.nickname||profile.name),carStyle:String(row.carStyle||profile.carStyle),countryCode:String(row.countryCode||'')});
  nativeProfiles.push({slot:Number(key.slice((PREFIX+'user_').length)),id});
 }
 ensure(activeId);
 for(const row of localRows){const id=String(row.accountId||row.userId||'');const profile=ensure(id);if(profile){if(!profile.name)profile.name=String(row.nickname||row.name||'');profile.playtimeMs=Math.max(profile.playtimeMs,Number(row.totalPlaytimeMs)||0);rememberPb(profile,row);}}
 for(const key of keys){const match=/^polytrack_v5_prod_record_(\d+)_(default|undeterministic)_([a-f0-9]{64})$/.exec(key);if(!match)continue;const record=read(key),owner=nativeProfiles.find(p=>p.slot===Number(match[1]));if(!record||!owner||record.tokenHash!==owner.id)continue;rememberPb(ensure(owner.id),{trackId:match[3],frames:record.frames,mode:match[2]});}
 const savedTracks=[];
 for(const key of keys.filter(k=>k.startsWith(PREFIX+'track_'))){
  const value=read(key);
  if(value&&typeof value.data==='string')savedTracks.push({name:key.slice((PREFIX+'track_').length),data:value.data,savedAt:Number(value.saveTime)||0,bytes:new TextEncoder().encode(value.data).length});
 }
 const practice=[];for(const profile of profiles.values())for(const row of practiceRows(profile.publicId)||[]){rememberTrack(row.trackId);practice.push({...row,publicId:profile.publicId,trackName:trackInfo(row.trackId)?.name||''});}
 return {profiles:[...profiles.values()],tracks:[...tracks.values()],practice,savedTracks,collection:{blockedReads,nativeProfiles:nativeProfiles.length,profileCount:profiles.size,pbCount:[...profiles.values()].reduce((sum,p)=>sum+p.personalBests.length,0),savedTrackCount:savedTracks.length,savedTrackBytes:savedTracks.reduce((sum,row)=>sum+row.bytes,0),scope:'Known game profiles, native PB summaries, local practice and saved tracks only; credentials and replay payloads excluded'}};
}
