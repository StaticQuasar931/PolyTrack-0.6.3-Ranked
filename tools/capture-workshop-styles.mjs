import fs from 'node:fs/promises';
import path from 'node:path';
import {readWorkshopStyle,WORKSHOP_STYLE_COLLECTION} from './public-workshop-style.mjs';

export const WORKSHOP_CAPTURE_LIMIT=50;
export const WORKSHOP_DOCUMENTS='projects/polytrack-052/databases/(default)/documents/';
const PREFIX=WORKSHOP_DOCUMENTS+WORKSHOP_STYLE_COLLECTION+'/';
const ID=/^[a-f0-9]{64}$/;
export function workshopCaptureQuery(cursor=null,limit=WORKSHOP_CAPTURE_LIMIT){
 if(!Number.isSafeInteger(limit)||limit<1||limit>WORKSHOP_CAPTURE_LIMIT)throw Error('Invalid Workshop capture limit');
 const orderBy=['updatedAt','__name__'].map(fieldPath=>({field:{fieldPath},direction:'ASCENDING'}));
 const structuredQuery={from:[{collectionId:WORKSHOP_STYLE_COLLECTION}],select:{fields:['updatedAt','workshopStyle','__name__'].map(fieldPath=>({fieldPath}))},orderBy,limit};
 if(cursor){
  if(!ID.test(cursor.id)||!Number.isSafeInteger(cursor.at)||cursor.at<1)throw Error('Invalid Workshop capture cursor');
  structuredQuery.startAt={values:[{integerValue:String(cursor.at)},{referenceValue:PREFIX+cursor.id}],before:false};
 }
 return {structuredQuery};
}
export async function captureWorkshopStyles(directory,fetchImpl){
 const file=path.join(directory,'workshop-styles.json');
 let prior={version:1,cursor:null,entries:{}};
 try{prior=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
 const {cursor,entries}=prior;
 if(prior.version!==1||!entries||Array.isArray(entries)||Object.entries(entries).some(([id,value])=>!ID.test(id)||!value||readWorkshopStyle(value)===undefined))throw Error('Invalid saved Workshop styles');
 const response=await fetchImpl('https://firestore.googleapis.com/v1/'+WORKSHOP_DOCUMENTS.slice(0,-1)+':runQuery',{
  method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(workshopCaptureQuery(cursor)),signal:AbortSignal.timeout(12000)
 });
 if(!response?.ok)throw Error('Workshop capture unavailable');
 const text=await response.text();
 if(Buffer.byteLength(text)>128*1024)throw Error('Workshop page too large');
 const page=JSON.parse(text);
 if(!Array.isArray(page)||page.length>WORKSHOP_CAPTURE_LIMIT)throw Error('Invalid Workshop capture page');
 let last=cursor,read=0;
 for(const row of page){
  if(!row.document&&typeof row.readTime==='string')continue;
  const {name,fields}=row.document||{},id=name?.slice(PREFIX.length),raw=fields?.updatedAt?.integerValue,at=Number(raw);
  const style=readWorkshopStyle(fields?.workshopStyle?.stringValue);
  if(!name?.startsWith(PREFIX)||!ID.test(id||'')||!/^[1-9][0-9]*$/.test(raw||'')||!Number.isSafeInteger(at)||
   at>Date.parse(row.readTime||new Date().toISOString())||style===undefined||
   last&&(at<last.at||at===last.at&&id<=last.id))throw Error('Invalid Workshop capture row');
  if(style)entries[id]=style;else delete entries[id];
  last={at,id};read++;
 }
 if(read){
  const value=JSON.stringify({version:1,cursor:last,entries})+'\n',temp=file+'.next-'+process.pid;
  if(Buffer.byteLength(value)>2*1024*1024)throw Error('Workshop snapshot exceeds size limit');
  await fs.writeFile(temp,value,{flag:'wx'});
  try{await fs.rename(temp,file);}catch(error){await fs.unlink(temp).catch(()=>{});throw error;}
 }
 return {updated:read,documentReads:Math.max(1,read),writes:0,more:read===WORKSHOP_CAPTURE_LIMIT};
}
