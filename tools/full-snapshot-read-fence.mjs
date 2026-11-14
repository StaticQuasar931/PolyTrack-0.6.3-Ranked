export async function boundedFirestoreResponse(response,{maxBytes=16*1024*1024}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>16*1024*1024)throw Error('Invalid bounded Firestore response limit');
 if(Number(response.headers?.get('content-length')||0)>maxBytes){await response.body?.cancel();throw Error('Full snapshot source response exceeds bound');}
 if(!response.body)return response;
 const reader=response.body.getReader(),chunks=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();throw Error('Full snapshot source response exceeds bound');}chunks.push(value);}}finally{reader.releaseLock();}
 const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
 return new Response(bytes,{status:response.status,statusText:response.statusText,headers:response.headers});
}

export function createFullSnapshotReadFence({fetchImpl=fetch,maxDirectReservations=40000,maxWorkerRequests=1024,initialDirectReservations=0,initialWorkerRequests=0}={}){
 if(maxDirectReservations!==40000||maxWorkerRequests!==1024)throw Error('Fixed full snapshot transport bounds required');
 if(!Number.isSafeInteger(initialDirectReservations)||initialDirectReservations<0||initialDirectReservations>maxDirectReservations||!Number.isSafeInteger(initialWorkerRequests)||initialWorkerRequests<0||initialWorkerRequests>maxWorkerRequests)throw Error('Invalid prior capture accounting');
 let directReservations=initialDirectReservations,workerRequests=initialWorkerRequests,oauthRequests=0,stopped=false;
 const report=()=>({directDocumentReadReservations:directReservations,workerRequests,priorDirectReservations:initialDirectReservations,priorWorkerRequests:initialWorkerRequests,oauthRequests,maxDirectReservations,maxWorkerRequests,stopped,documentWrites:0,scope:'Transport attempts and conservative direct reservations; Worker requests are not billed document counts.'});
 const fail=message=>{stopped=true;throw Error(message);};
 return {report,fetch:async(input,options={})=>{
  if(stopped)throw Error('Full snapshot transport stopped');const url=new URL(String(input));
  if(url.origin==='https://firestore.googleapis.com'){
   if(options.method!=='POST'||!['/v1/projects/polytrack-052/databases/(default)/documents:runQuery','/v1/projects/polytrack-052/databases/(default)/documents:batchGet'].includes(url.pathname))return fail('Full snapshot forbids database writes and unknown endpoints');
   let body;try{body=JSON.parse(options.body);}catch{return fail('Invalid capture body');}
   const count=url.pathname.endsWith(':batchGet')?body.documents?.length:body.structuredQuery?.limit;
   if(!Number.isSafeInteger(count)||count<1||count>100||directReservations+count>maxDirectReservations)return fail('Full snapshot direct read budget exceeded');directReservations+=count;
  }else if(url.origin==='https://polytrack-ranked-worker.staticquasar931.workers.dev'){
   if((options.method||'GET')!=='GET'||workerRequests+1>maxWorkerRequests)return fail('Full snapshot Worker budget exceeded');workerRequests++;
  }else if(url.href==='https://oauth2.googleapis.com/token'){
   if(options.method!=='POST'||++oauthRequests>12)return fail('Full snapshot authentication budget exceeded');
  }
  try{const response=await fetchImpl(input,options);if([401,403,429].includes(response.status))stopped=true;return url.origin==='https://firestore.googleapis.com'?await boundedFirestoreResponse(response):response;}catch(error){stopped=true;throw error;}
 }};
}
