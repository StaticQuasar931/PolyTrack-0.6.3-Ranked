import {VERIFICATION_COLLECTION,EXTRA_VERIFICATION_COLLECTION} from '../../workers/ranked/src/verification.js';
const ALLOWED=new Set(['0.6.2_race_results',VERIFICATION_COLLECTION,EXTRA_VERIFICATION_COLLECTION]);

// Capture-only, read-only snapshot. Never use this adapter for publication or across a write.
export function createCaptureHydrationCache(db,{maxDocuments=10000}={}){
  if(!Number.isSafeInteger(maxDocuments)||maxDocuments<1||maxDocuments>20000)throw Error('Invalid hydration cache limit');
  const reads=new Map();let canonicalReads=0,queueReads=0,hits=0;
  return {get:async(collection,id)=>{
    if(!ALLOWED.has(collection)||typeof id!=='string'||!/^[A-Za-z0-9_-]{1,256}$/.test(id))throw Error('Invalid capture hydration path');
    const key=collection+'/'+id;
    if(!reads.has(key)){
      if(reads.size>=maxDocuments)throw Error('Capture hydration document limit');
      if(collection==='0.6.2_race_results')canonicalReads++;else queueReads++;
      reads.set(key,Promise.resolve().then(()=>db.get(collection,id)));
    }else hits++;
    return structuredClone(await reads.get(key));
  },stats:()=>({canonicalReads,queueReads,hits,documents:reads.size})};
}
