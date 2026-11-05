import {eventDecode,eventEncode} from './events-store.js';
import {EventError} from './events.js';
import {samePublicationState} from './event-publication-retry.js';

const BATCH_PAGES=32,BATCH_BYTES=6000000,BATCHES_PER_PASS=4;
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).byteLength;

export function inlineEventPublicationFits(runtime,paged) {
  // Final publication uses at most four other writes. The store caps each of
  // those documents at 800 kB, leaving this payload below the commit limit.
  if(paged.documents.length>12)return false;
  let total=0;
  for(const doc of paged.documents){
    const size=bytes({update:{name:`projects/${runtime.projectId}/databases/(default)/documents/${doc.collection}/${doc.id}`,
      fields:eventEncode(doc.data).mapValue.fields},currentDocument:{exists:false}});
    if(size>800000||(total+=size)>4000000)return false;
  }
  return true;
}

export function eventPublicationStaged(state,paged) {
  const saved=state.staged;
  return saved?.version===1&&saved.generation===paged.pagination.generation&&
    saved.pageCount===paged.documents.length&&saved.nextPage===paged.documents.length;
}

// Pages and their progress receipt share one atomic commit, guarded by the job
// version. This receipt is not verification authority: callers recompute the
// content generation from inputs and still fence current sources at publication.
export async function stageEventPublication(runtime,jobPath,state,paged) {
  const base=`projects/${runtime.projectId}/databases/(default)/documents/`;
  const write=(path,data)=>({update:{name:base+path,fields:eventEncode(data).mapValue.fields}});
  const saved=state.staged;
  let offset=saved?.version===1&&saved.generation===paged.pagination.generation&&
    saved.pageCount===paged.documents.length&&Number.isSafeInteger(saved.nextPage)&&
    saved.nextPage>=0&&saved.nextPage<=paged.documents.length?saved.nextPage:0;
  for(let batch=0;offset<paged.documents.length&&batch<BATCHES_PER_PASS;batch++) {
    const current=await runtime.request('/'+jobPath);
    if(!current?.updateTime||!samePublicationState(eventDecode({mapValue:{fields:current.fields||{}}}),state))
      throw new EventError('event_publication_conflict',409);
    const writes=[];let size=0,next=offset;
    while(next<paged.documents.length&&writes.length<BATCH_PAGES) {
      const doc=paged.documents[next],entry=write(doc.collection+'/'+doc.id,doc.data),length=bytes(entry);
      if(length>BATCH_BYTES)throw Error('EVENT_PUBLICATION_STAGE_BYTES');
      if(size+length>BATCH_BYTES)break;
      writes.push(entry);size+=length;next++;
    }
    const checkpoint={...state,staged:{version:1,generation:paged.pagination.generation,
      pageCount:paged.documents.length,nextPage:next}};
    const receipt={...write(jobPath,checkpoint),currentDocument:{updateTime:current.updateTime}};
    if(bytes(receipt)>800000)throw Error('EVENT_PUBLICATION_CHECKPOINT_BYTES');
    writes.push(receipt);
    await runtime.request(':commit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({writes})});
    state=checkpoint;offset=next;
  }
  return {state,complete:offset===paged.documents.length};
}
