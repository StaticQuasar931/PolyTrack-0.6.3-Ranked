export async function boundedFirestoreResponse(response,{maxBytes=16*1024*1024}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>16*1024*1024)throw Error('Invalid bounded Firestore response limit');
 if(Number(response.headers?.get('content-length')||0)>maxBytes){await response.body?.cancel();throw Error('Full snapshot source response exceeds bound');}
 if(!response.body)return response;
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw Error('Full snapshot source response exceeds bound');}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return new Response(bytes,{status:response.status,statusText:response.statusText,headers:response.headers});
}

export function workerCaptureReadCharge(input){
 // Cold-cache GETs, events-runtime retries:0. events.js reads catalog<=2,
 // totals<=2 plus Rolling root/pages<=101; snapshot<=4, replay<=5, playback<=2.
 // Both public page handlers read a manifest and one page. No cache discounts.
 const u=new URL(String(input)),p=u.pathname;
 if(u.origin!=='https://polytrack-ranked-worker.staticquasar931.workers.dev')throw Error('Unknown capture Worker origin');
 if(p==='/v1/capture-auth')return 0;
 if(p==='/v1/events/catalog')return 2;
 if(p==='/v1/events/totals')return 103;
 if(p==='/v1/events/permanent-rolling-hills/snapshot')return 101;
 if(p==='/v1/snapshot/track')return 1;
 if(p==='/v1/snapshot/track/page'||p==='/v1/events/totals/page'||/^\/v1\/events\/[A-Za-z0-9_-]{1,64}\/snapshot\/page$/.test(p))return 2;
 if(/^\/v1\/events\/[A-Za-z0-9_-]{1,64}\/snapshot$/.test(p))return 4;
 if(/^\/v1\/events\/[A-Za-z0-9_-]{1,64}\/replays\/[a-f0-9]{64}$/.test(p))return 5;
 if(/^\/v1\/events\/[A-Za-z0-9_-]{1,64}\/playbacks\/[A-Za-z0-9_-]{1,128}$/.test(p))return 2;
 throw Error('Unknown capture Worker route cost');
}

export function createFullSnapshotReadFence({fetchImpl=fetch,maxDirectReservations=40000,maxWorkerRequests=1024,initialDirectReservations=0,initialWorkerRequests=0,
 combinedReadLimit=null,initialCombinedReservations=0}={}){
 if(maxDirectReservations!==40000||maxWorkerRequests!==1024)throw Error('Fixed full snapshot transport bounds required');
 if(!Number.isSafeInteger(initialDirectReservations)||initialDirectReservations<0||initialDirectReservations>maxDirectReservations||!Number.isSafeInteger(initialWorkerRequests)||initialWorkerRequests<0||initialWorkerRequests>maxWorkerRequests)throw Error('Invalid prior capture accounting');
 if(combinedReadLimit!==null&&(!Number.isSafeInteger(combinedReadLimit)||combinedReadLimit<1||combinedReadLimit>33000||initialDirectReservations!==0||initialWorkerRequests!==0||
   !Number.isSafeInteger(initialCombinedReservations)||initialCombinedReservations<0||initialCombinedReservations>combinedReadLimit))throw Error('Invalid fresh combined read budget');
 let directReservations=initialDirectReservations,workerRequests=initialWorkerRequests,oauthRequests=0,stopped=false,
   combinedReservations=initialCombinedReservations,workerReadReservations=0,queryIndexReservations=0;
 const report=()=>({directDocumentReadReservations:directReservations,workerRequests,priorDirectReservations:initialDirectReservations,priorWorkerRequests:initialWorkerRequests,oauthRequests,maxDirectReservations,maxWorkerRequests,stopped,documentWrites:0,
   ...(combinedReadLimit===null?{}:{combinedReadLimit,combinedReadReservations:combinedReservations,workerReadReservations,queryIndexReservations,preflightReadReservations:initialCombinedReservations}),
   scope:'Transport attempts and conservative direct reservations; Worker requests are not billed document counts.'});
 const fail=message=>{stopped=true;throw Error(message);};
 const reserve=cost=>{if(combinedReadLimit!==null){if(combinedReservations+cost>combinedReadLimit)return fail('Combined capture read budget exceeded');combinedReservations+=cost;}};
 return {report,fetch:async(input,options={})=>{
  if(stopped)throw Error('Full snapshot transport stopped');const url=new URL(String(input));
  if(url.origin==='https://firestore.googleapis.com'){
   if(options.method!=='POST'||!['/v1/projects/polytrack-052/databases/(default)/documents:runQuery','/v1/projects/polytrack-052/databases/(default)/documents:batchGet'].includes(url.pathname))return fail('Full snapshot forbids database writes and unknown endpoints');
   let body;try{body=JSON.parse(options.body);}catch{return fail('Invalid capture body');}
   const count=url.pathname.endsWith(':batchGet')?body.documents?.length:body.structuredQuery?.limit;
   if(!Number.isSafeInteger(count)||count<1||count>100||directReservations+count>maxDirectReservations)return fail('Full snapshot direct read budget exceeded');
   const overhead=combinedReadLimit!==null&&url.pathname.endsWith(':runQuery')?1:0;
   reserve(count+overhead);directReservations+=count;queryIndexReservations+=overhead;
  }else if(url.origin==='https://polytrack-ranked-worker.staticquasar931.workers.dev'){
   if((options.method||'GET')!=='GET'||workerRequests+1>maxWorkerRequests)return fail('Full snapshot Worker budget exceeded');
   if(combinedReadLimit!==null){let cost;try{cost=workerCaptureReadCharge(url);}catch{return fail('Unknown capture Worker route cost');}
    reserve(cost);workerReadReservations+=cost;}
   workerRequests++;
  }else if(url.href==='https://oauth2.googleapis.com/token'){
   if(options.method!=='POST'||++oauthRequests>12)return fail('Full snapshot authentication budget exceeded');
  }else if(combinedReadLimit!==null)return fail('Unknown fresh capture transport origin');
  try{const response=await fetchImpl(input,options);if([401,403,429].includes(response.status))stopped=true;return url.origin==='https://firestore.googleapis.com'?await boundedFirestoreResponse(response):response;}catch(error){stopped=true;throw error;}
 }};
}
