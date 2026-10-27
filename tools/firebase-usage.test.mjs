import test from 'node:test';
import assert from 'node:assert/strict';
import {wrapFirestoreUsage,FIREBASE_USAGE_COVERAGE} from './firebase-usage.mjs';

globalThis.fetch=()=>{throw Error('OFFLINE_SDK_USAGE_TEST');};
function fixture(observer,clockOverride){
 const events=[],refs=new WeakSet(),calls=[],context={callback:'native context'};
 let metadata={fromCache:false},queryDocs=[],failure=null,queuedFailure=false,commitFailure=false,attempts=1,callbackReturns=[];
 const resultValue={native:'return value'};
 class Document{
  #id;#last;
  constructor(id){this.#id=id;refs.add(this);}
  get id(){return this.#id;}
  get firestore(){return database;}
  get(){calls.push('doc.get');if(failure)throw failure;this.#last=Promise.resolve({metadata});return this.#last;}
  last(){return this.#last;}
  set(data){calls.push(['set',this.#id,data]);if(failure)throw failure;this.#last=Promise.resolve(resultValue);return this.#last;}
  update(...args){return this.set(args);}
  delete(){calls.push('delete');return failure?Promise.reject(failure):Promise.resolve(resultValue);}
  collection(){this.#id;return new Query();}
  isEqual(other){return refs.has(other)&&other.#id===this.#id;}
  needsRaw(ref,data){this.#id;assert.ok(refs.has(ref));assert.ok(refs.has(data.nested.link));return data;}
 }
 class Query{
  #brand=true;#last;
  doc(id='generated'){this.#brand;return new Document(id);}
  where(_field,_operator,ref){this.#brand;assert.ok(refs.has(ref));return this;}
  orderBy(){this.#brand;return this;}
  limit(){this.#brand;return this;}
  get(){this.#brand;calls.push('query.get');return Promise.resolve({metadata,docs:queryDocs});}
  add(data){this.#brand;calls.push(['add',data]);if(data?.link)assert.ok(refs.has(data.link));this.#last=failure?Promise.reject(failure):Promise.resolve(new Document('created-native-reference'));return this.#last;}
  last(){this.#brand;return this.#last;}
  onSnapshot(...args){this.#brand;const listener=args.find(value=>typeof value==='function'||value&&typeof value.next==='function');
   if(typeof listener==='function')assert.equal(listener.call(context,{marker:'unchanged snapshot'}),'callback-return');
   else assert.equal(listener.next.call(listener,{marker:'unchanged snapshot'}),'callback-return');
   return unsubscribe;
  }
 }
 class Writer{
  #brand=true;
  get(ref){this.#brand;assert.ok(refs.has(ref));calls.push('tx.get');return Promise.resolve({metadata});}
  set(ref,data){this.#brand;assert.ok(refs.has(ref));if(queuedFailure)throw new Error('queued rejected');if(data?.link)assert.ok(refs.has(data.link));return this;}
  update(ref,data){return this.set(ref,data);}
  delete(ref){this.#brand;assert.ok(refs.has(ref));if(queuedFailure)throw new Error('queued rejected');return this;}
  commit(){this.#brand;calls.push('batch.commit');return commitFailure?Promise.reject(resultValue):Promise.resolve(resultValue);}
 }
 const unsubscribe=()=> 'native unsubscribe';
 class Database{
  #brand=true;
  doc(id){this.#brand;return new Document(id);}
  collection(){this.#brand;return new Query();}
  collectionGroup(){this.#brand;return new Query();}
  batch(){this.#brand;return new Writer();}
  settings(value){this.#brand;return value;}
  runTransaction(callback){this.#brand;const transaction=new Writer();
   return (async()=>{let value;for(let i=0;i<attempts;i++){value=callback.call(context,transaction,i);callbackReturns.push(value);value=await value;}if(commitFailure)throw resultValue;return value;})();
  }
 }
 const database=new Database();let clock=0;
 const wrapped=wrapFirestoreUsage(database,{observeUsage:observer||((value)=>events.push(value)),now:clockOverride||(()=>++clock)});
 return {database,wrapped,events,calls,context,resultValue,callbackReturns,unsubscribe,refs,
  setMetadata:value=>{metadata=value;},setDocs:value=>{queryDocs=value;},setFailure:value=>{failure=value;},
  setQueuedFailure:value=>{queuedFailure=value;},setCommitFailure:value=>{commitFailure=value;},setAttempts:value=>{attempts=value;}};
}

test('native private fields/getters, stable proxy identity, method binding and reference unwrapping are preserved',async()=>{
 const f=fixture(),d=f.wrapped.doc('private-id'),q=f.wrapped.collection('private-collection');
 assert.equal(d.id,'private-id');assert.equal(d.firestore,f.wrapped);
 assert.equal(wrapFirestoreUsage(f.wrapped,{observeUsage(){throw Error();}}),f.wrapped);
 assert.equal(d.get,d.get);assert.equal(d.isEqual(d),true);assert.equal(q.where('field','==',d),q);
 assert.equal(q.orderBy('field').limit(1),q);
 const data=Object.freeze({nested:Object.freeze({link:d})});const raw=d.needsRaw(d,data);
 assert.equal(data.nested.link,d);assert.ok(f.refs.has(raw.nested.link));
 await d.set({link:d});assert.equal(f.refs.has(f.calls.find(c=>Array.isArray(c))[2].link),true);
 assert.deepEqual(Object.keys(f.events[0]).sort(),['durationMs','reads','source','writes']);
 assert.doesNotMatch(JSON.stringify(f.events),/private-id|private-collection|field/);
});
test('document and query server/cache/unknown metadata estimates do not equate HTTP with document reads',async()=>{
 const f=fixture(),d=f.wrapped.doc('x'),q=f.wrapped.collection('x');
 const promise=d.get();assert.equal(promise,d.last());await promise;
 await q.get();f.setDocs([{},{}]);await q.get();
 assert.deepEqual(f.events.map(e=>e.reads),[1,1,2]);
 f.setMetadata({fromCache:true});await q.get();assert.equal(f.events.at(-1).source,'cache');assert.equal(f.events.at(-1).reads,0);
 f.setMetadata(undefined);await d.get();assert.equal(f.events.at(-1).source,'firestore');assert.equal(Object.hasOwn(f.events.at(-1),'reads'),false);
 assert.equal(f.calls.filter(c=>c==='doc.get').length,2);
});
test('direct set/update/delete count only successful acknowledgments',async()=>{
 const f=fixture(),d=f.wrapped.doc('x');
 const p=d.set({a:1});assert.equal(p,d.last());assert.equal(await p,f.resultValue);await d.update({a:2});
 assert.deepEqual(f.events.map(e=>e.writes),[1,1]);
 await d.delete();assert.equal(f.events.at(-1).writes,1);
 const error=new Error('native throw');f.setFailure(error);
 assert.throws(()=>d.set({a:3}),value=>value===error);assert.equal(Object.hasOwn(f.events.at(-1),'writes'),false);
 await assert.rejects(d.delete(),value=>value===error);assert.equal(Object.hasOwn(f.events.at(-1),'writes'),false);
});
test('collection add counts one write only after acknowledgment and preserves promise and resolved reference identity',async()=>{
 const f=fixture(),collection=f.wrapped.collection('multiplayer'),ref=f.wrapped.doc('target');
 const promise=collection.add({link:ref});assert.equal(promise,collection.last());assert.equal(f.events.length,0);
 const result=await promise;assert.ok(f.refs.has(result),'resolved SDK reference stays raw, not a replacement proxy');
 assert.equal(f.events.length,1);assert.equal(f.events[0].writes,1);assert.equal(f.events[0].reads,0);
 const error=new Error('native add failed');f.setFailure(error);
 const rejected=collection.add({});assert.equal(rejected,collection.last());assert.equal(f.events.length,1);
 await assert.rejects(rejected,value=>value===error);assert.equal(Object.hasOwn(f.events.at(-1),'writes'),false);
});
test('batch queues emit nothing; failed queued mutations and failed commits do not count acknowledged writes',async()=>{
 const f=fixture(),d=f.wrapped.doc('x'),batch=f.wrapped.batch();
 assert.equal(batch.set(d,{link:d}).update(d,{a:1}),batch);assert.equal(f.events.length,0);
 f.setQueuedFailure(true);assert.throws(()=>batch.set(d,{}),/queued rejected/);f.setQueuedFailure(false);
 assert.equal(await batch.commit(),f.resultValue);assert.equal(f.events.at(-1).writes,2);
 f.setCommitFailure(true);const failed=f.wrapped.batch().set(d,{});await assert.rejects(failed.commit(),e=>e===f.resultValue);
 assert.equal(Object.hasOwn(f.events.at(-1),'writes'),false);
 f.setCommitFailure(false);await f.wrapped.batch().set(d,{}).delete(d).commit();assert.equal(f.events.at(-1).writes,2);
});
test('transaction retries count each attempt read, but only successful final-attempt writes; callback this/result remain native',async()=>{
 const f=fixture(),d=f.wrapped.doc('x');f.setAttempts(2);
 const result=await f.wrapped.runTransaction(function(tx,index){assert.equal(this,f.context);
  return tx.get(d).then(()=>{tx.set(d,{});if(index===0)tx.update(d,{});return index===0?'first attempt':f.resultValue;});
 });
 assert.equal(result,f.resultValue);assert.equal(f.callbackReturns.length,2);
 assert.equal(f.events.filter(e=>e.reads===1).length,2);assert.equal(f.events.at(-1).writes,1);
 assert.equal(f.events.at(-1).reads,0);assert.equal(f.calls.filter(c=>c==='tx.get').length,2);
});
test('failed transaction does not emit queued writes as acknowledged',async()=>{
 const f=fixture(),d=f.wrapped.doc('x');f.setAttempts(2);f.setCommitFailure(true);
 await assert.rejects(f.wrapped.runTransaction(async tx=>{await tx.get(d);tx.set(d,{});return 7;}),e=>e===f.resultValue);
 assert.equal(f.events.filter(e=>e.reads===1).length,2);
 assert.equal(f.events.some(e=>e.writes>0),false);assert.equal(Object.hasOwn(f.events.at(-1),'writes'),false);
});

test('delete batches count successful queued mutations, not rejected queues or commits',async()=>{
 const f=fixture(),d=f.wrapped.doc('x'),batch=f.wrapped.batch();
 f.setQueuedFailure(true);assert.throws(()=>batch.delete(d),/queued rejected/);
 f.setQueuedFailure(false);assert.equal(batch.delete(d).set(d,{}),batch);
 assert.equal(f.events.length,0);await batch.commit();assert.equal(f.events.at(-1).writes,2);
 f.setCommitFailure(true);await assert.rejects(f.wrapped.batch().delete(d).commit());
 assert.equal(Object.hasOwn(f.events.at(-1),'writes'),false);
 f.setCommitFailure(false);await f.wrapped.batch().commit();assert.equal(f.events.at(-1).writes,0);
});

test('mixed delete transactions count only final acknowledged attempt mutations',async()=>{
 const f=fixture(),d=f.wrapped.doc('x');f.setAttempts(2);
 await f.wrapped.runTransaction((tx,index)=>{tx.delete(d);if(index===0)tx.set(d,{});});
 assert.equal(f.events.length,1);assert.equal(f.events[0].writes,1);
 f.setCommitFailure(true);
 await assert.rejects(f.wrapped.runTransaction(tx=>tx.delete(d)));
 assert.equal(Object.hasOwn(f.events.at(-1),'writes'),false);
});
test('synchronous callback return and exceptions are not changed',async()=>{
 const f=fixture();assert.equal(await f.wrapped.runTransaction(()=>7),7);assert.equal(f.callbackReturns[0],7);
 const error=new Error('callback failure');await assert.rejects(f.wrapped.runTransaction(()=>{throw error;}),value=>value===error);
});
test('observer/clock failures cannot change native operation returns or create unhandled instrumentation rejections',async()=>{
 for(const observer of [()=>{throw Error('observer');},()=>Promise.reject(Error('async observer'))]){
  const f=fixture(observer),d=f.wrapped.doc('x');assert.equal(await d.set({}),f.resultValue);await d.get();
 }
 let event;const f=fixture(value=>{event=value;},()=>{throw Error('clock');});
 await f.wrapped.doc('native').get();assert.equal(event.reads,1);assert.equal(Object.hasOwn(event,'durationMs'),false);
});
test('listeners are intentionally uninstrumented and preserve callbacks, receiver and exact unsubscribe',()=>{
 const f=fixture(),q=f.wrapped.collection('private');
 const callback=function(value){assert.equal(this,f.context);assert.equal(value.marker,'unchanged snapshot');return 'callback-return';};
 assert.equal(q.onSnapshot({includeMetadataChanges:true},callback),f.unsubscribe);
 const observer={next(value){assert.equal(this,observer);assert.equal(value.marker,'unchanged snapshot');return 'callback-return';}};
 assert.equal(q.onSnapshot(observer),f.unsubscribe);assert.equal(f.events.length,0);
});
test('custom thenable identity and consumer then return values are preserved',()=>{
 const sentinel={},thenable={then(success){success({metadata:{fromCache:false}});return sentinel;}};
 const database={doc(){return {get(){return thenable;}};}};const events=[];
 const wrapped=wrapFirestoreUsage(database,{observeUsage:e=>events.push(e),now:()=>0});
 const result=wrapped.doc().get();assert.equal(result,thenable);assert.equal(result.then(()=>7),sentinel);assert.equal(events[0].reads,1);
});
test('coverage metadata explicitly marks listeners, uninstrumented activity and server/billing metrics unknown',()=>{
 assert.ok(Object.isFrozen(FIREBASE_USAGE_COVERAGE));
 assert.match(FIREBASE_USAGE_COVERAGE.listeners,/Uninstrumented/);
 assert.match(FIREBASE_USAGE_COVERAGE.uninstrumented,/not automatically instrumented/);
 assert.match(FIREBASE_USAGE_COVERAGE.serverProjectUsage,/Unknown/);
 assert.match(FIREBASE_USAGE_COVERAGE.billedUsage,/Unavailable/);
 assert.match(FIREBASE_USAGE_COVERAGE.deletes,/Acknowledged/);
 assert.doesNotMatch(JSON.stringify(FIREBASE_USAGE_COVERAGE),/https:|accountId|credential|Bearer/);
});
