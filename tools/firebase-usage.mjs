const databases=new WeakMap();
const originals=new WeakMap();
const queryMethods=new Set(['where','orderBy','limit','limitToLast','startAt','startAfter','endAt','endBefore']);
export const FIREBASE_USAGE_COVERAGE=Object.freeze({
 scope:'Observed instrumented compat SDK activity on this browser device only',
 documentReads:'Direct get, each transaction-attempt get and partial listener estimates; estimates require server/cache metadata',
 acknowledgedWrites:'Successful set/update/delete/add mutations; batches and final transaction attempts only after acknowledgment',
 listeners:'Partial compat onSnapshot estimates: first server result, cache zero, subsequent query added/modified changes and query metadata-only zero; removals, reconnections, missing metadata and subsequent document events remain unknown. Pending writes and query change lists over 10000 are unknown. No retained paths, IDs or document data',
 uninstrumented:'Other SDK operations and raw references returned by SDK promises or snapshots are not automatically instrumented',
 deletes:'Acknowledged delete mutations included; not a billed delete total',
 serverProjectUsage:'Unknown: backend fanout, rules/index charges, other clients and hidden SDK retries are not observed',
 billedUsage:'Unavailable; operation counts and estimates are not billed Firebase metrics'
});

function unwrap(value,seen=new WeakMap()){
 if(!value||typeof value!=='object')return value;
 if(originals.has(value))return originals.get(value);
 const prototype=Object.getPrototypeOf(value);
 if(!Array.isArray(value)&&prototype!==Object.prototype&&prototype!==null)return value;
 if(seen.has(value))return seen.get(value);
 const copy=Array.isArray(value)?[]:Object.create(prototype);seen.set(value,copy);let changed=false;
 const descriptors=Object.getOwnPropertyDescriptors(value);
 for(const key of Reflect.ownKeys(descriptors)){
  const descriptor=descriptors[key];
  if(Object.hasOwn(descriptor,'value')){const next=unwrap(descriptor.value,seen);changed||=next!==descriptor.value;descriptor.value=next;}
 }
 if(!changed){seen.set(value,value);return value;}
 Object.defineProperties(copy,descriptors);return copy;
}

// Local, partial operation estimates only. Never polls, changes SDK prototypes,
// or treats observed client traffic as billed usage.
export function wrapFirestoreUsage(database,{observeUsage,now=()=>performance.now()}={}){
 database=originals.get(database)||database;
 if(!database||typeof database!=='object')throw TypeError('Firestore database required');
 if(databases.has(database))return databases.get(database);
 const proxies=new WeakMap();
 const clock=()=>{try{const value=now();return Number.isFinite(value)?value:null;}catch{return null;}};
 const timing=start=>{const end=clock();return start!==null&&end!==null&&end>=start?{durationMs:end-start}:{};};
 const emit=value=>{
  try{
   const result=observeUsage?.(value);
   if(result&&typeof result.then==='function')result.then(undefined,()=>{});
  }catch{}
 };
 const observe=(result,success,failure)=>{
  try{
   if(result&&typeof result.then==='function')Reflect.apply(result.then,result,[value=>{try{success(value);}catch{}},()=>{try{failure();}catch{}}]);
   else success(result);
  }catch{}
  return result;
 };
 const readEvent=(snapshot,kind,start)=>{
  try{
   const cache=snapshot?.metadata?.fromCache;
   if(cache===true){emit({source:'cache',reads:0,writes:0,...timing(start)});return;}
   let reads;
   if(cache===false){
    if(kind==='doc'||kind==='transaction')reads=1;
    else if(Array.isArray(snapshot?.docs))reads=Math.max(1,snapshot.docs.length);
   }
   emit({source:'firestore',...(reads===undefined?{}:{reads}),writes:0,...timing(start)});
  }catch{emit({source:'firestore',writes:0,...timing(start)});}
 };
 const listenerArgs=(args,kind)=>{
  const isObserver=value=>value&&typeof value==='object'&&['next','error','complete'].some(key=>typeof value[key]==='function');
  const index=typeof args[0]==='function'||isObserver(args[0])?0:1;
  const listener=args[index],observer=isObserver(listener);
  const next=observer?listener.next:listener;
  if(typeof next!=='function')return args;
  let serverSeen=false,uncertain=false;
  const record=snapshot=>{
   const unknown=()=>emit({source:'firestore',writes:0});
   try{
    const cache=snapshot?.metadata?.fromCache;
    if(cache===true){if(serverSeen)uncertain=true;emit({source:'cache',reads:0,writes:0});return;}
    if(cache!==false||snapshot.metadata.hasPendingWrites===true){uncertain=true;unknown();return;}
    if(!serverSeen){
     serverSeen=true;
     // A cache-first delivery must not consume the initial server estimate.
     const size=kind==='doc'?1:snapshot.size??(Array.isArray(snapshot.docs)?snapshot.docs.length:undefined);
     if(Number.isSafeInteger(size)&&size>=0&&size<=1e9)emit({source:'firestore',reads:Math.max(1,size),writes:0});
     else unknown();
     uncertain=false;return;
    }
    if(kind==='doc'){unknown();return;}
    const changes=snapshot.docChanges();
    // Bound inspection without storing snapshots, document identities or data.
    if(!Array.isArray(changes)||changes.length>10000){uncertain=true;unknown();return;}
    let reads=0,ambiguous=uncertain;uncertain=false;
    for(const change of changes){
     if(change.type==='added'||change.type==='modified')reads++;
     else ambiguous=true; // A removal cannot distinguish deletion from a changed filter match.
    }
    if(reads||!ambiguous)emit({source:'firestore',reads,writes:0});
    if(ambiguous)unknown();
   }catch{uncertain=true;unknown();}
  };
  const wrapped=function(...values){record(values[0]);return Reflect.apply(next,observer?listener:this,values);};
  const result=args.slice();
  if(observer){
   // A facade avoids proxy invariants on frozen observers and preserves private-field receivers.
   const facade={next:wrapped};
   for(const key of ['error','complete']){
    const handler=listener[key];
    if(typeof handler==='function')facade[key]=function(...values){return Reflect.apply(handler,listener,values);};
   }
   result[index]=facade;
  }else result[index]=wrapped;
  return result;
 };
 function wrap(target,kind,state){
  if(!target||typeof target!=='object')return target;
  if(originals.has(target))return target;
  if(kind!=='transaction'&&proxies.has(target))return proxies.get(target);
  const methods=new Map();let proxy;
  const mutation=()=>state||{writes:0};
  proxy=new Proxy(target,{
   get(native,key){
    const value=Reflect.get(native,key,native);
    const locked=Object.getOwnPropertyDescriptor(native,key);
    if(locked&&!locked.configurable&&Object.hasOwn(locked,'value')&&!locked.writable)return value;
    if(typeof value!=='function'){
     if(key==='firestore'&&value===database)return wrap(database,'database');
     if(key==='parent'&&value&&typeof value==='object')return wrap(value,kind==='doc'?'query':'doc');
     return value;
    }
    if(methods.has(key)&&methods.get(key).original===value)return methods.get(key).wrapped;
    const invoke=function(...args){
     if((kind==='doc'||kind==='query')&&key==='onSnapshot')return Reflect.apply(value,native,listenerArgs(args,kind));
     const nativeArgs=args.map(value=>unwrap(value));
     const start=clock();
     if(kind==='database'&&key==='runTransaction'&&typeof args[0]==='function'){
      let lastAttempt=null;
      nativeArgs[0]=function(transaction,...rest){
       const attempt={writes:0};lastAttempt=attempt;
       return Reflect.apply(args[0],this,[wrap(transaction,'transaction',attempt),...rest]);
      };
      let result;try{result=Reflect.apply(value,native,nativeArgs);}catch(error){emit({source:'firestore',reads:0,...timing(start)});throw error;}
      return observe(result,()=>emit({source:'firestore',reads:0,...(lastAttempt?{writes:lastAttempt.writes}:{}),...timing(start)}),()=>emit({source:'firestore',reads:0,...timing(start)}));
     }
     const get=(kind==='doc'||kind==='query'||kind==='transaction')&&key==='get';
     const queued=(kind==='batch'||kind==='transaction')&&['set','update','delete'].includes(key);
     const direct=kind==='doc'&&['set','update','delete'].includes(key)||kind==='query'&&key==='add';
     const commit=kind==='batch'&&key==='commit';
     const writeCount=commit?mutation().writes:1;
     let result;
     try{result=Reflect.apply(value,native,nativeArgs);}
     catch(error){
      if(get)emit({source:'firestore',writes:0,...timing(start)});
      else if(direct||commit)emit({source:'firestore',reads:0,...timing(start)});
      throw error;
     }
     if(queued){mutation().writes++;return result===native?proxy:result;}
     if(get)return observe(result,snapshot=>readEvent(snapshot,kind,start),()=>emit({source:'firestore',writes:0,...timing(start)}));
     if(direct||commit)return observe(result,()=>emit({source:'firestore',reads:0,writes:writeCount,...timing(start)}),()=>emit({source:'firestore',reads:0,...timing(start)}));
     if(kind==='database'&&key==='batch')return wrap(result,'batch',{writes:0});
     if((kind==='database'||kind==='doc')&&key==='collection'||kind==='database'&&key==='collectionGroup')return wrap(result,'query');
     if((kind==='database'||kind==='query')&&key==='doc')return wrap(result,'doc');
     if(kind==='query'&&queryMethods.has(key)||key==='withConverter'&&(kind==='doc'||kind==='query'))return wrap(result,kind);
     return result===native?proxy:result;
    };
    methods.set(key,{original:value,wrapped:invoke});return invoke;
   },
   set(native,key,value){return Reflect.set(native,key,unwrap(value),native);}
  });
  originals.set(proxy,target);if(kind!=='transaction')proxies.set(target,proxy);return proxy;
 }
 const result=wrap(database,'database');databases.set(database,result);return result;
}
