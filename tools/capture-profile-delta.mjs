import fs from 'node:fs/promises';
import path from 'node:path';
import {decode} from './verifier/firestore.mjs';
import {projectCapturedPublicProfile} from './public-profile-replay-export.mjs';
const PREFIX='projects/polytrack-052/databases/(default)/documents/0.6.2_profiles_public/';
const FIELDS=['name','nickname','countryCode','profileCosmetics','accountCreatedAt','totalPlaytimeMs','pbCount','latestPbAt','updatedAt','carStyle','carColors','__name__'];
export async function captureProfileDelta({db,directory,since,readTime=null,maxDocuments=2000}={}){
 if(!db||typeof db.call!=='function'||!path.isAbsolute(directory||'')||!Number.isSafeInteger(since)||since<0||!Number.isSafeInteger(maxDocuments)||maxDocuments<1||maxDocuments>5000||readTime!==null&&!Number.isFinite(Date.parse(readTime)))throw Error('Invalid profile delta capture');
 let cursor=null,complete=false,pages=0,charged=0;const profiles=[],seen=new Set();
 while(charged<maxDocuments){
  const limit=Math.min(100,maxDocuments-charged),query={from:[{collectionId:'0.6.2_profiles_public'}],select:{fields:FIELDS.map(fieldPath=>({fieldPath}))},where:{fieldFilter:{field:{fieldPath:'updatedAt'},op:'GREATER_THAN',value:{integerValue:String(since)}}},orderBy:[{field:{fieldPath:'updatedAt'},direction:'ASCENDING'},{field:{fieldPath:'__name__'},direction:'ASCENDING'}],limit};
  if(cursor)query.startAt={values:[{integerValue:String(cursor.updatedAt)},{referenceValue:cursor.name}],before:false};
  const response=await db.call(':runQuery',{structuredQuery:query,...(readTime?{readTime}:{})});pages++;
  if(!Array.isArray(response)||response.some(r=>r.error||r.skippedResults||!r.document&&typeof r.readTime!=='string'))throw Error('Invalid profile delta response');
  readTime||=response.at(-1)?.readTime;if(!Number.isFinite(Date.parse(readTime)))throw Error('Profile frozen read point missing');
  if(response.some(r=>r.readTime&&r.readTime!==readTime))throw Error('Profile capture read point changed');
  const docs=response.filter(r=>r.document).map(r=>r.document);if(docs.length>limit)throw Error('Profile page exceeds budget');charged+=Math.max(1,docs.length);
  for(const doc of docs){const id=doc.name?.slice(PREFIX.length);if(!doc.name?.startsWith(PREFIX)||!/^[a-f0-9]{64}$/.test(id)||seen.has(id))throw Error('Invalid profile cursor or identity');const value=decode({mapValue:{fields:doc.fields||{}}});if(!Number.isSafeInteger(value.updatedAt)||value.updatedAt<=since||value.updatedAt>Date.parse(readTime)||cursor&&(value.updatedAt<cursor.updatedAt||value.updatedAt===cursor.updatedAt&&doc.name<=cursor.name))throw Error('Invalid profile watermark ordering');seen.add(id);profiles.push(projectCapturedPublicProfile(id,value));cursor={updatedAt:value.updatedAt,name:doc.name};}
  if(docs.length<limit){complete=true;break;}
 }
 if(!complete)throw Error('Profile delta document budget reached before complete capture');
 const root=await fs.realpath(directory),folder=path.join(root,'profiles');await fs.mkdir(folder,{recursive:true});const stat=await fs.lstat(folder);if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('Unsafe profile folder');
 const originals=new Map();try{for(const profile of profiles){const file=path.join(folder,profile.accountId+'.json');let old=null;try{const stat=await fs.lstat(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>2*1024*1024)throw Error('Unsafe profile file');old=await fs.readFile(file);}catch(e){if(e.code!=='ENOENT')throw e;}originals.set(file,old);await fs.writeFile(file,JSON.stringify(profile)+'\n');}}catch(error){for(const [file,bytes] of originals){if(bytes)await fs.writeFile(file,bytes);else await fs.unlink(file).catch(()=>{});}throw error;}
 return {complete:true,since,readTime,profilesUpdated:profiles.length,pages,estimatedDocumentReads:charged,backendWrites:0};
}
