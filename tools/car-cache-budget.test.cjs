const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(new URL('../polytrack_062_patch.js','file://'+__filename.replaceAll('\\','/')),'utf8');
const fn=source.match(/  function rememberOverallCarRender\([\s\S]*?\n  \}/)[0];
function fixture(){const cache=new Map(),context=vm.createContext({overallCarRenderCache:cache});vm.runInContext(fn,context);return {cache,store:context.rememberOverallCarRender};}
test('thumbnail strings obey both the 8 MiB and 256-entry bounds',()=>{
 const f=fixture(),large='x'.repeat(1024*1024);
 for(let i=0;i<5;i++)assert.equal(f.store(String(i),large),true);
 assert.equal(f.cache.size,4);assert.equal(f.cache.has('0'),false);
 assert.ok([...f.cache.values()].reduce((sum,v)=>sum+v.length*2,0)<=8*1024*1024);
 assert.equal(f.store('oversized','x'.repeat(4*1024*1024+1)),false);
 const tiny=fixture();for(let i=0;i<300;i++)tiny.store(String(i),'small');assert.equal(tiny.cache.size,256);
});
test('same racer/style updates replace one entry instead of accumulating images',()=>{
 const f=fixture();f.store('same-user|same-style','first');f.store('same-user|same-style','second');
 assert.equal(f.cache.size,1);assert.equal(f.cache.get('same-user|same-style'),'second');assert.equal(f.store('same-user|same-style',null),false);assert.equal(f.cache.get('same-user|same-style'),'second');
});
