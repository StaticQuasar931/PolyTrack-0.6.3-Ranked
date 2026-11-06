import {createHash} from 'node:crypto';
export function createCatchUpReadFence({fetchImpl=fetch,maxDocumentReads=2000,maxWorkerRequests=320,onUsage=()=>{}}={}){
 if(!Number.isSafeInteger(maxDocumentReads)||maxDocumentReads<1||maxDocumentReads>2000||!Number.isSafeInteger(maxWorkerRequests)||maxWorkerRequests<1||maxWorkerRequests>320)throw Error('Invalid catch-up budget');
 let documentReads=0,workerRequests=0,stopped=false;const seen=new Set();
 const usage=()=>({documentReads,workerRequests,maxDocumentReads,maxWorkerRequests,stopped,documentWrites:0});
 const fail=message=>{stopped=true;onUsage(usage());throw Error(message);};
 return {usage,fetch:async(input,options={})=>{
  if(stopped)throw Error('Catch-up transport stopped');const url=new URL(String(input));
  if(url.origin==='https://firestore.googleapis.com'){
   if(options.method!=='POST'||!['/v1/projects/polytrack-052/databases/(default)/documents:batchGet','/v1/projects/polytrack-052/databases/(default)/documents:runQuery'].includes(url.pathname))return fail('Catch-up forbids database writes and unknown paths');
   const body=JSON.parse(options.body);const count=url.pathname.endsWith(':batchGet')?body.documents?.length:body.structuredQuery?.limit;
   if(!Number.isSafeInteger(count)||count<1||count>100||documentReads+count>maxDocumentReads)return fail('Catch-up document read budget exceeded');
   const key=createHash('sha256').update(url.href+' '+options.body).digest('hex');if(seen.has(key))return fail('Duplicate catch-up document request');seen.add(key);documentReads+=count;
  }else if(url.origin==='https://polytrack-ranked-worker.staticquasar931.workers.dev'){
   if((options.method||'GET')!=='GET'||++workerRequests>maxWorkerRequests)return fail('Catch-up Worker request budget exceeded');
  }else if(url.href!=='https://oauth2.googleapis.com/token'||options.method!=='POST')return fail('Unknown catch-up transport');
  onUsage(usage());try{const response=await fetchImpl(input,options);if([401,403,429].includes(response.status)){stopped=true;onUsage(usage());}return response;}catch(error){stopped=true;onUsage(usage());throw error;}
 }};
}
