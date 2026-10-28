import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import {stampClientRelease} from './site-release.mjs';
const patch=fs.readFileSync(new URL('../polytrack_062_patch.js',import.meta.url),'utf8');
const index=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const revision=JSON.parse(fs.readFileSync(new URL('../site-version.json',import.meta.url),'utf8')).revision;
const helper=patch.match(/  function rankedFetch\([\s\S]*?\r?\n  \}/)[0];
test('Ranked transport adds release without dropping auth, payload or cancellation',async()=>{
 let call;const ctx=vm.createContext({Headers,observedWorkerFetch:(...args)=>{call=args;return Promise.resolve('ok');}});
 vm.runInContext(helper,ctx);
 const signal=new AbortController().signal;
 const options={method:'POST',headers:{Authorization:'Bearer fixture','Content-Type':'application/json'},body:'{}',signal};
 assert.equal(await ctx.rankedFetch('https://fixture.example/v1/pb/notify',options),'ok');
 assert.equal(call[1].headers.get('Authorization'),'Bearer fixture');
 assert.equal(call[1].headers.get('X-PolyTrack-Revision'),String(revision));
 assert.equal(call[1].body,'{}');assert.equal(call[1].signal,signal);
 assert.equal(options.headers['X-PolyTrack-Revision'],undefined);
});
test('future release stamping advances explicit backend revision',()=>{
 const next=revision+1,result=stampClientRelease(patch,index,next);
 assert.ok(result.patch.includes("headers.set('X-PolyTrack-Revision', String("+next+"))"));
});
test('all directly addressed Ranked requests use revisioned transport',()=>{
 assert.doesNotMatch(patch,/\bfetch\(rankedBrokerUrl\(\)/);
 assert.match(patch,/completeRankedSnapshot\(payload,\{saved,kind,trackId,endpoint,fetchImpl:rankedFetch\}\)/);
 assert.match(patch,/trackId:id,endpoint:rankedBrokerUrl\(\),fetchImpl:rankedFetch/);
});

test('weekly feed revisions only Worker fallback, not same-origin static assets',async()=>{
 const calls=[];const context=vm.createContext({rankedBrokerUrl:()=> 'https://ranked.example',rankedFetch:(...args)=>{calls.push(['ranked',...args]);},fetch:(...args)=>{calls.push(['static',...args]);}});
 const helper=patch.match(/  function rankedWeeklyFetch\([\s\S]*?\r?\n  \}/)[0];vm.runInContext(helper,context);
 context.rankedWeeklyFetch(new URL('https://ranked.example/v1/kodub-weekly'),{});
 context.rankedWeeklyFetch(new URL('https://staticquasar931.github.io/PolyTrack-0.6.3-Ranked/events/kodub/current.json'),{});
 context.rankedWeeklyFetch('https://ranked.example.evil.test/v1/kodub-weekly',{});
 assert.deepEqual(calls.map(row=>row[0]),['ranked','static','static']);
 assert.equal((patch.match(/fetcher:rankedWeeklyFetch/g)||[]).length,2);
});
