'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'verify.cjs'),'utf8');
const start=source.indexOf('async function simulate('),end=source.indexOf('\nasync function verifyBatch(',start);
assert(start>=0&&end>start);

function fixture({determinations=[],validations=[],workerError=false,disposeError=false}={}){
  const state={created:0,disposed:0,checks:0,validated:0};let context;
  class Validator{
    constructor(){state.created++;}
    async testDeterminism(){state.checks++;return determinations.length?determinations.shift():true;}
    async validate(){state.validated++;const value=validations.length?validations.shift():true;if(value instanceof Error)throw value;if(workerError)context.__nativeWorkerError=true;return value;}
    dispose(){state.disposed++;if(disposeError)throw Error('dispose failed');}
  }
  const trackId='a'.repeat(64),track={getId:()=>trackId};
  context=vm.createContext({__tracks:new Map([[trackId,track]]),__trustedInit:{trackParts:[]},__workers:[],__nativeWorkerError:false,
    __vrRequire:id=>({A:id===5220?Validator:id===1754?{deserialize:()=>({})}:class Time{constructor(value){this.value=value;}}})});
  const simulate=vm.runInContext(source.slice(start,end)+';simulate;',context);
  const run=()=>simulate({page:{evaluate:(fn,args)=>fn(args)}},{trackId,replay:'saved bytes',timeMs:1000});
  return {state,context,run};
}
test('batch-local validator is reused but every replay executes native validation and two determinism checks',async()=>{
  const f=fixture();assert.equal((await f.run()).status,'verified');assert.equal((await f.run()).status,'verified');
  assert.deepEqual(f.state,{created:1,disposed:0,checks:4,validated:2});
});
test('a mismatch does not contaminate a subsequent exact replay',async()=>{
  const f=fixture({validations:[false,true]});assert.equal((await f.run()).status,'mismatch');assert.equal((await f.run()).status,'verified');
  assert.equal(f.state.created,1);assert.equal(f.state.validated,2);
});
test('failed initial determinism disposes the worker and requires fresh validation state',async()=>{
  const f=fixture({determinations:[false,true,true]});assert.equal((await f.run()).reason,'determinism_failed');assert.equal(f.context.__batchValidator,null);
  assert.equal((await f.run()).status,'verified');assert.equal(f.state.created,2);assert.equal(f.state.disposed,1);
});
test('post-result cleanup failure cannot return a positive proof or retain a validator',async()=>{
  for(const options of [{determinations:[true,false]},{workerError:true},{validations:['invalid']},{validations:[Error('native failed')]}]){
    const f=fixture(options);await assert.rejects(f.run());assert.equal(f.context.__batchValidator,null);assert.equal(f.state.disposed,1);
  }
});
test('a throwing disposer still clears the cached instance',async()=>{
  const f=fixture({validations:[Error('native failed')],disposeError:true});await assert.rejects(f.run(),/dispose failed/);assert.equal(f.context.__batchValidator,null);
});
test('Worker error and messageerror are tracked without changing trusted Init capture',async()=>{
  let script;
  const page={on(){},async addInitScript(fn){script=fn;throw Error('captured bootstrap');}};
  const context={async route(){},async routeWebSocket(){},async newPage(){return page;}};
  await assert.rejects(require('./verify.cjs')._internals.initialize({browser:{async newContext(){return context;}}},{},'http://127.0.0.1'),/captured bootstrap/);
  class NativeWorker{constructor(){this.listeners={};}addEventListener(name,fn){this.listeners[name]=fn;}postMessage(){} }
  const sandbox=vm.createContext({Worker:NativeWorker});vm.runInContext('('+script.toString()+')()',sandbox);
  const worker=vm.runInContext("new Worker('simulation_worker.bundle.js')",sandbox);
  assert.equal(sandbox.__workers.length,1);worker.postMessage({messageType:0,trackParts:['trusted']});assert.deepEqual([...sandbox.__trustedInit.trackParts],['trusted']);
  worker.listeners.error();assert.equal(sandbox.__nativeWorkerError,true);sandbox.__nativeWorkerError=false;worker.listeners.messageerror();assert.equal(sandbox.__nativeWorkerError,true);
});
test('render suspension follows trusted Init and remains outside the native worker simulation',()=>{
  const ready=source.indexOf('await page.waitForFunction'),pause=source.indexOf('globalThis.requestAnimationFrame = () => 0');
  assert(ready>=0&&pause>ready&&pause<start);assert(!source.slice(start,end).includes('requestAnimationFrame'));
  assert(source.includes('await terminate(session, { graceful: !session.dead });'));
});
test('the lifecycle audit pins the actual code and leaves the seven other verifier inputs unchanged',()=>{
 const crypto=require('node:crypto'),audit=JSON.parse(fs.readFileSync(path.join(__dirname,'validator-lifecycle-audit.json')));
 assert.equal(require('./verify.cjs').verifierFingerprint,audit.currentFingerprint);
 assert.equal(audit.previousFingerprint,'3fd07e5bdf54fec2e699e88e6e507c9cff77eb4f152ce4afd429e0e728625553');
 assert.deepEqual(audit.changedInputs,['verify.cjs']);
 for(const [file,hash]of Object.entries(audit.after)){
  const actual=crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname,file),'utf8').replace(/\r\n?/g,'\n')).digest('hex');
  assert.equal(actual,hash);if(file!=='verify.cjs')assert.equal(hash,audit.before[file]);
 }
});
