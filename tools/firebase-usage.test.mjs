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
test('listeners preserve callbacks, receiver and exact unsubscribe with missing metadata unknown',()=>{
 const f=fixture(),q=f.wrapped.collection('private');
 const callback=function(value){assert.equal(this,f.context);assert.equal(value.marker,'unchanged snapshot');return 'callback-return';};
 assert.equal(q.onSnapshot({includeMetadataChanges:true},callback),f.unsubscribe);
 const observer={next(value){assert.equal(this,observer);assert.equal(value.marker,'unchanged snapshot');return 'callback-return';}};
 assert.equal(q.onSnapshot(observer),f.unsubscribe);assert.equal(f.events.length,2);
 assert.ok(f.events.every(e=>!Object.hasOwn(e,'reads')&&e.writes===0));
});
test('custom thenable identity and consumer then return values are preserved',()=>{
 const sentinel={},thenable={then(success){success({metadata:{fromCache:false}});return sentinel;}};
 const database={doc(){return {get(){return thenable;}};}};const events=[];
 const wrapped=wrapFirestoreUsage(database,{observeUsage:e=>events.push(e),now:()=>0});
 const result=wrapped.doc().get();assert.equal(result,thenable);assert.equal(result.then(()=>7),sentinel);assert.equal(events[0].reads,1);
});
test('coverage metadata explicitly marks listeners, uninstrumented activity and server/billing metrics unknown',()=>{
 assert.ok(Object.isFrozen(FIREBASE_USAGE_COVERAGE));
 assert.match(FIREBASE_USAGE_COVERAGE.listeners,/Partial/);
 assert.match(FIREBASE_USAGE_COVERAGE.listeners,/removals, reconnections, missing metadata/);
 assert.match(FIREBASE_USAGE_COVERAGE.uninstrumented,/not automatically instrumented/);
 assert.match(FIREBASE_USAGE_COVERAGE.serverProjectUsage,/Unknown/);
 assert.match(FIREBASE_USAGE_COVERAGE.billedUsage,/Unavailable/);
 assert.match(FIREBASE_USAGE_COVERAGE.deletes,/Acknowledged/);
 assert.doesNotMatch(JSON.stringify(FIREBASE_USAGE_COVERAGE),/https:|accountId|credential|Bearer/);
});

function listenerFixture(observeUsage){
 const events=[],subscriptions=[],context={native:true},result={callbackResult:true},failure={nativeFailure:true};
 const unsubscribe=function(){assert.equal(this,context);return result;};
 class Reference{
  #brand=true;
  onSnapshot(...args){
   assert.equal(this.#brand,true);
   const index=typeof args[0]==='function'||['next','error','complete'].some(key=>typeof args[0]?.[key]==='function')?0:1;
   const observer=args[index];
   subscriptions.push({args,
    next(...values){return typeof observer==='function'?observer.apply(context,values):observer.next.apply(observer,values);},
    error(...values){const fn=typeof observer==='function'?args[index+1]:observer.error;return fn?.apply(typeof observer==='function'?context:observer,values);},
    complete(...values){const fn=typeof observer==='function'?args[index+2]:observer.complete;return fn?.apply(typeof observer==='function'?context:observer,values);}
   });
   if(args[0]?.reject)throw failure;
   return unsubscribe;
  }
 }
 const database={doc:()=>new Reference(),collection:()=>new Reference()};
 const wrapped=wrapFirestoreUsage(database,{observeUsage:observeUsage||((e)=>events.push(e)),now:()=>0});
 return {wrapped,events,subscriptions,context,result,failure,unsubscribe};
}
const querySnapshot=(size=2,types=[],metadata={fromCache:false})=>({size,metadata,docChanges(){return types.map(type=>({type}));}});
const readCounts=events=>events.map(e=>Object.hasOwn(e,'reads')?e.reads:'unknown');

for(const kind of ['doc','collection'])for(const options of [false,true])for(const form of ['callback','observer']){
 test(`listener overload ${kind}, options=${options}, ${form} preserves arguments/receivers/results`,()=>{
  const f=listenerFixture(),snapshot=querySnapshot(),extra={extra:true},opts=Object.freeze({includeMetadataChanges:true});
  const callback=function(value,rest){assert.equal(this,f.context);assert.equal(value,snapshot);assert.equal(rest,extra);return f.result;};
  const error=function(value){assert.equal(this,f.context);assert.equal(value,f.failure);return f.result;};
  const complete=function(){assert.equal(this,f.context);return f.result;};
  class Observer{
   #result=f.result;
   next(value,rest){assert.equal(this,observer);assert.equal(value,snapshot);assert.equal(rest,extra);return this.#result;}
   error(value){assert.equal(value,f.failure);return this.#result;}
   complete(){return this.#result;}
  }
  const observer=Object.freeze(new Observer());
  const args=form==='callback'?[callback,error,complete]:[observer];if(options)args.unshift(opts);
  assert.equal(f.wrapped[kind]('private-path').onSnapshot(...args),f.unsubscribe);
  const subscription=f.subscriptions[0];
  if(options)assert.equal(subscription.args[0],opts);
  if(form==='callback'){
   assert.equal(subscription.args[options?2:1],error);
   assert.equal(subscription.args[options?3:2],complete);
  }
  assert.equal(subscription.next(snapshot,extra),f.result);
  assert.equal(subscription.error(f.failure),f.result);assert.equal(subscription.complete(),f.result);
  assert.deepEqual(readCounts(f.events),[kind==='doc'?1:2]);
  assert.equal(f.unsubscribe.call(f.context),f.result);
  assert.deepEqual(Object.keys(f.events[0]).sort(),['reads','source','writes']);
  assert.doesNotMatch(JSON.stringify(f.events),/private-path|callbackResult|nativeFailure|extra/);
 });
}

test('query listener cache-first, first server minimum and incremental/metadata sequence',()=>{
 const f=listenerFixture();f.wrapped.collection().onSnapshot({includeMetadataChanges:true},()=>{});
 const s=f.subscriptions[0];
 s.next(querySnapshot(3,['added','added','added'],{fromCache:true}));
 s.next(querySnapshot(3,[])); // Cache already supplied the docs: docChanges can be empty here.
 s.next(querySnapshot(4,['added','modified']));
 s.next(querySnapshot(4,[]));
 assert.deepEqual(readCounts(f.events),[0,3,2,0]);assert.equal(f.events[0].source,'cache');
 f.wrapped.collection().onSnapshot(()=>{});f.subscriptions[1].next(querySnapshot(0,[]));
 assert.equal(f.events.at(-1).reads,1);
 assert.ok(f.events.every(e=>e.writes===0));
});

test('listener removals preserve known changes separately from unknown reads; no empty-result minimum on updates',()=>{
 const f=listenerFixture();f.wrapped.collection().onSnapshot(()=>{});const s=f.subscriptions[0];
 s.next(querySnapshot(3));s.next(querySnapshot(3,['added','modified','removed']));
 s.next(querySnapshot(0,['removed']));s.next(querySnapshot(0,[]));
 assert.deepEqual(readCounts(f.events),[3,2,'unknown','unknown',0]);
});

test('cache/server transitions disclose reconnection uncertainty without resetting the initial estimate',()=>{
 const f=listenerFixture();f.wrapped.collection().onSnapshot(()=>{});const s=f.subscriptions[0];
 s.next(querySnapshot(5));s.next(querySnapshot(5,[],{fromCache:true}));s.next(querySnapshot(5,[]));
 s.next(querySnapshot(6,['added']));s.next(querySnapshot(6,[],{fromCache:true}));s.next(querySnapshot(7,['added']));
 assert.deepEqual(readCounts(f.events),[5,0,'unknown',1,0,1,'unknown']);
});

test('missing metadata never creates known reads and does not consume the first server result',()=>{
 const f=listenerFixture();f.wrapped.collection().onSnapshot(()=>{});const s=f.subscriptions[0];
 s.next({size:4});s.next(querySnapshot(4,[],{}));s.next(querySnapshot(4));
 s.next({size:4});s.next(querySnapshot(4,['modified']));
 assert.deepEqual(readCounts(f.events),['unknown','unknown',4,'unknown',1,'unknown']);
});

test('document listeners do not inspect or retain raw data and report subsequent events conservatively',()=>{
 const f=listenerFixture();f.wrapped.doc().onSnapshot(()=>{});const s=f.subscriptions[0];
 const doc=metadata=>({metadata,get data(){throw Error('must not inspect data');},get id(){throw Error('must not inspect IDs');}});
 s.next(doc({fromCache:true}));s.next(doc(undefined));s.next(doc({fromCache:false}));
 s.next(doc({fromCache:false}));s.next(doc({fromCache:true}));s.next(doc({fromCache:false}));
 assert.deepEqual(readCounts(f.events),[0,'unknown',1,'unknown',0,'unknown']);
});

test('pending local writes are not treated as known server document reads',()=>{
 const f=listenerFixture();f.wrapped.collection().onSnapshot(()=>{});const s=f.subscriptions[0];
 s.next(querySnapshot(2,['added'],{fromCache:false,hasPendingWrites:true}));
 s.next(querySnapshot(2));s.next(querySnapshot(3,['added'],{fromCache:false,hasPendingWrites:true}));
 s.next(querySnapshot(3,[]));
 assert.deepEqual(readCounts(f.events),['unknown',2,'unknown','unknown']);
});

test('malformed/throwing metadata and changes stay unknown without preventing delivery; inspection is bounded',()=>{
 const f=listenerFixture();let delivered=0;f.wrapped.collection().onSnapshot(()=>++delivered);const s=f.subscriptions[0];
 s.next({get metadata(){throw Error('bad metadata');}});
 s.next({metadata:{fromCache:false}}); // No size, still unknown.
 s.next({metadata:{fromCache:false},docChanges(){throw Error('bad changes');}});
 s.next({metadata:{fromCache:false},docChanges(){return null;}});
 const changes=new Array(10001);Object.defineProperty(changes,0,{get(){throw Error('must not iterate over cap');}});
 s.next({metadata:{fromCache:false},docChanges(){return changes;}});
 s.next(querySnapshot(2,['unexpected']));s.next(querySnapshot(2,[]));
 assert.equal(delivered,7);assert.deepEqual(readCounts(f.events),['unknown','unknown','unknown','unknown','unknown','unknown',0]);
});

test('query change inspection uses the snapshot receiver and default metadata filtering only',()=>{
 const f=listenerFixture();f.wrapped.collection().onSnapshot(()=>{});const s=f.subscriptions[0];
 s.next(querySnapshot(1));
 class Snapshot{
  #changes=[{type:'modified',get doc(){throw Error('do not inspect document');}}];
  metadata={fromCache:false};
  docChanges(...args){assert.equal(args.length,0);return this.#changes;}
 }
 s.next(new Snapshot());assert.deepEqual(readCounts(f.events),[1,1]);
});

test('listener state is independent per registration and registration errors remain identical',()=>{
 const f=listenerFixture(),q=f.wrapped.collection();q.onSnapshot(()=>{});q.onSnapshot(()=>{});
 f.subscriptions[0].next(querySnapshot(4));f.subscriptions[1].next(querySnapshot(4));f.subscriptions[0].next(querySnapshot(4,[]));
 assert.deepEqual(readCounts(f.events),[4,4,0]);
 const before=f.events.length;assert.throws(()=>q.onSnapshot({reject:true},()=>{}),e=>e===f.failure);
 assert.equal(f.events.length,before);
});

test('consumer next/error/complete exceptions and rejected next return values are untouched',async()=>{
 const f=listenerFixture(),failure=new Error('consumer');
 const throwing=()=>{throw failure;};
 f.wrapped.collection().onSnapshot(throwing,throwing,throwing);
 const s=f.subscriptions[0];
 assert.throws(()=>s.next(querySnapshot(1)),e=>e===failure);
 assert.throws(()=>s.error(f.failure),e=>e===failure);assert.throws(()=>s.complete(),e=>e===failure);
 assert.deepEqual(readCounts(f.events),[1]);
 const rejected=Promise.reject(failure);rejected.catch(()=>{});
 f.wrapped.doc().onSnapshot(()=>rejected);assert.equal(f.subscriptions[1].next(querySnapshot()),rejected);
 await assert.rejects(rejected,e=>e===failure);
 const observer=Object.freeze({next:throwing,error:throwing,complete:throwing});
 f.wrapped.doc().onSnapshot(observer);const o=f.subscriptions[2];
 assert.throws(()=>o.next(querySnapshot()),e=>e===failure);
 assert.throws(()=>o.error(f.failure),e=>e===failure);assert.throws(()=>o.complete(),e=>e===failure);
});

test('error-only observers are passed through unchanged and usage observer failures never affect listeners',async()=>{
 const f=listenerFixture(),observer=Object.freeze({error(){assert.equal(this,observer);return f.result;}});
 f.wrapped.doc().onSnapshot(observer);assert.equal(f.subscriptions[0].args[0],observer);
 assert.equal(f.subscriptions[0].error(f.failure),f.result);assert.equal(f.events.length,0);
 for(const observeUsage of [()=>{throw Error('usage observer');},()=>Promise.reject(Error('usage rejection'))]){
  const fixture=listenerFixture(observeUsage);
  fixture.wrapped.collection().onSnapshot(()=>fixture.result);
  assert.equal(fixture.subscriptions[0].next(querySnapshot()),fixture.result);
  fixture.subscriptions[0].next({});
 }
 await new Promise(resolve=>setImmediate(resolve));
});

test('frozen own observer methods preserve their original receiver without proxy invariant failures',()=>{
 const f=listenerFixture(),observer=Object.freeze({
  next(){assert.equal(this,observer);return f.result;},
  error(){assert.equal(this,observer);return f.result;},
  complete(){assert.equal(this,observer);return f.result;}
 });
 f.wrapped.doc().onSnapshot({includeMetadataChanges:true},observer);const s=f.subscriptions[0];
 assert.equal(s.next(querySnapshot()),f.result);assert.equal(s.error(f.failure),f.result);assert.equal(s.complete(),f.result);
});

test('synchronous native listener delivery preserves callback throws without relabeling them registration failures',()=>{
 const failure=new Error('next failure'),events=[],receiver={},unsubscribe=()=>{};
 const reference={onSnapshot(next){assert.equal(this,reference);assert.equal(next.call(receiver,querySnapshot(2)),7);return unsubscribe;}};
 const database={collection:()=>reference},q=wrapFirestoreUsage(database,{observeUsage:e=>events.push(e)}).collection();
 assert.equal(q.onSnapshot(function(){assert.equal(this,receiver);return 7;}),unsubscribe);
 assert.throws(()=>q.onSnapshot(()=>{throw failure;}),e=>e===failure);
 assert.deepEqual(readCounts(events),[2,2]);
 assert.equal(reference.onSnapshot.name,'onSnapshot');
});

test('invalid metadata flags and oversized initial estimates remain unknown',()=>{
 const f=listenerFixture();f.wrapped.collection().onSnapshot(()=>{});const s=f.subscriptions[0];
 for(const fromCache of [null,0,1,'false'])s.next(querySnapshot(1,[],{fromCache}));
 s.next(querySnapshot(1e9+1));
 assert.deepEqual(readCounts(f.events),['unknown','unknown','unknown','unknown','unknown']);
});
