import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const source=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
function extract(name){const at=source.search(new RegExp('^  (?:async )?function '+name+'\\(','m'));assert.ok(at>=0,name);const tail=source.slice(at),end=tail.indexOf('\n  }');return tail.slice(0,end+4);}
test('Worker boundaries observe exactly one logical attempt without URLs, identities or invented reads',async()=>{
 const events=[],response={status:200},failure=Error('private error');let calls=0;
 const ctx=vm.createContext({Promise,Headers,performance:{now:()=>10},noteDeveloperEvent:(...args)=>events.push(args),fetch:async(_url,options)=>{calls++;assert.equal(options.headers.get('X-PolyTrack-Revision'),String(JSON.parse(fs.readFileSync(new URL('../site-version.json',import.meta.url))).revision));if(calls===2)throw failure;return response;}});
 vm.runInContext(extract('observedWorkerFetch')+';'+extract('rankedFetch'),ctx);
 assert.equal(await ctx.rankedFetch('https://example.test/private?token=secret'),response);
 await assert.rejects(ctx.rankedFetch('private-token'),error=>error===failure);
 assert.equal(calls,2);assert.deepEqual(events,[['worker','WORKER_REQUEST',0,200],['worker','WORKER_REQUEST',0,0]]);
 assert.ok(!JSON.stringify(events).includes('private'));
});
test('the first database waits for instrumentation, shares its import and recovers after import failure',async()=>{
 let finish,loads=0,at=1000,fail=false;const database={},wrapped={};
 const module={wrapFirestoreUsage:value=>{assert.equal(value,database);return wrapped;}};
 const ctx=vm.createContext({Date:{now:()=>at},localInsights:null,firebaseUsageModule:null,firebaseUsageModulePromise:null,firebaseUsageRetryAt:0,withTimeout:p=>Promise.resolve(p),loadModule:()=>{loads++;return fail?Promise.reject(Error('blocked')):new Promise(resolve=>{finish=()=>resolve(module);});}});
 const code=extract('observeFirestore').replace(/import\(new URL\('[^']+',eventsModuleUrl\)\.href\)/,'loadModule()');vm.runInContext(code,ctx);
 await ctx.observeFirestore(null);let settled=false;const one=ctx.observeFirestore(database).then(v=>{settled=true;return v;}),two=ctx.observeFirestore(database);
 await Promise.resolve();assert.equal(settled,false);assert.equal(loads,1);finish();assert.equal(await one,wrapped);assert.equal(await two,wrapped);
 ctx.firebaseUsageModule=null;ctx.firebaseUsageModulePromise=null;fail=true;assert.equal(await ctx.observeFirestore(database),database);assert.equal(loads,2);
 assert.equal(await ctx.observeFirestore(database),database);assert.equal(loads,2,'failed imports back off without blocking saves');
 at+=60001;fail=false;const retry=ctx.observeFirestore(database);finish();assert.equal(await retry,wrapped);assert.equal(loads,3);
});
test('observer timeouts leave cloud operations available',async()=>{
 const database={};const ctx=vm.createContext({Date,localInsights:null,firebaseUsageModule:null,firebaseUsageModulePromise:Promise.resolve(null),firebaseUsageRetryAt:0,withTimeout:()=>Promise.reject(Error('timeout'))});
 vm.runInContext(extract('observeFirestore'),ctx);assert.equal(await ctx.observeFirestore(database),database);
});

test('memory hits remain separate from snapshot operations without inventing Firestore reads',()=>{
 const samples=[],ctx=vm.createContext({developerEvents:[],localStorage:{getItem:()=>null},localInsights:{observeUsage:sample=>samples.push(sample),measure(){}},console});
 vm.runInContext(extract('noteDeveloperEvent'),ctx);ctx.noteDeveloperEvent('cache','TRACK',1,200);ctx.noteDeveloperEvent('snapshot','TRACK',2,200);
 assert.equal(samples[0].source,'cache');assert.equal(samples[1].source,'snapshot');assert.equal(samples[0].reads,undefined);
 assert.ok(source.includes("onRead:metric=>noteDeveloperEvent(metric.source==='memory'?'cache':'snapshot'"));
});
