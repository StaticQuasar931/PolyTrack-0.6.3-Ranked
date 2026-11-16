import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url),{chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const source=fs.readFileSync(new URL('./verify.cjs',import.meta.url),'utf8');
const start=source.indexOf('async function simulate('),end=source.indexOf('\nasync function verifyBatch(',start);
const simulate=Function(source.slice(start,end)+';return simulate;')();

test('real Worker cleanup errors after VerifyResult cannot produce a positive verdict',{timeout:30000},async()=>{
 const browser=await chromium.launch({headless:true,chromiumSandbox:process.platform==='linux'});
 try{
  const page=await browser.newPage();await page.route('**/*',route=>route.abort());await page.setContent('<title>Offline cleanup regression</title>');
  await page.evaluate(()=>{
   globalThis.__workers=[];globalThis.__nativeWorkerError=false;globalThis.__trustedInit={trackParts:[]};
   globalThis.__tracks=new Map([['track',{getId:()=> 'track'}]]);
   const program=`onmessage=e=>{if(e.data==='verify'){postMessage(true);throw Error('native cleanup failed');}else postMessage(true);};`;
   globalThis.workerUrl=URL.createObjectURL(new Blob([program],{type:'text/javascript'}));
   class Validator{
    constructor(){this.pending=[];this.worker=new Worker(workerUrl);__workers.push(this.worker);
     this.worker.addEventListener('error',()=>{globalThis.__nativeWorkerError=true;});
     this.worker.onmessage=e=>this.pending.shift()?.(e.data);
    }
    request(kind){return new Promise(resolve=>{this.pending.push(resolve);this.worker.postMessage(kind);});}
    testDeterminism(){return this.request('determinism');}
    validate(){return this.request('verify');}
    dispose(){this.worker.terminate();}
   }
   globalThis.__vrRequire=id=>({A:id===5220?Validator:id===1754?{deserialize:()=>({})}:class Time{}});
  });
  for(let i=0;i<8;i++){
   await page.evaluate(()=>{globalThis.__nativeWorkerError=false;});
   await assert.rejects(simulate({page},{trackId:'track',timeMs:1000,replay:'fixture'}),/native_worker_not_clean/);
   assert.equal(await page.evaluate(()=>globalThis.__batchValidator),null);
  }
  await page.evaluate(()=>URL.revokeObjectURL(workerUrl));
 }finally{await browser.close();}
});
