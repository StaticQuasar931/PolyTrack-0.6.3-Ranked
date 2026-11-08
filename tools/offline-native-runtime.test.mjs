import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {validateOfflineNativeRuntime} from './offline-native-runtime.mjs';
async function fixture(t,{version='1.62.1',executable=true}={}){
 const parent=await fs.mkdtemp(path.join(os.tmpdir(),'polytrack-runtime-'));
 t.after(()=>fs.rm(parent,{recursive:true,force:true}));
 const root=path.join(parent,'source'),module=path.join(parent,'pinned-playwright'),binary=path.join(parent,'chromium.exe');
 await fs.mkdir(path.join(root,'tools/verifier'),{recursive:true});await fs.mkdir(module);
 await fs.writeFile(path.join(root,'tools/verifier/package.json'),JSON.stringify({dependencies:{playwright:'1.62.1'}}));
 await fs.writeFile(path.join(module,'package.json'),JSON.stringify({version,main:'index.cjs'}));
 await fs.writeFile(path.join(module,'index.cjs'),'module.exports={chromium:{launch(){throw Error("Must not launch")},executablePath:()=>'+JSON.stringify(binary)+'}};');
 if(executable)await fs.writeFile(binary,'synthetic executable metadata only');
 return {root,module,binary,env:{VERIFIER_PLAYWRIGHT_MODULE:module}};
}
test('an explicit pinned external installation is checked without launching a browser',async t=>{
 const f=await fixture(t),value=await validateOfflineNativeRuntime(f);
 assert.equal(value.version,'1.62.1');assert.equal(value.executable,f.binary);assert.match(value.packageSha256,/^[a-f0-9]{64}$/);
 assert(value.executableBytes>0);
});
test('missing default installation fails before capture preparation',async t=>{
 const f=await fixture(t);await assert.rejects(validateOfflineNativeRuntime({root:f.root,env:{}}),/runtime is not ready/);
});
test('wrong version is refused before importing the installation entry point',async t=>{
 const f=await fixture(t,{version:'0.0.0'});await fs.writeFile(path.join(f.module,'index.cjs'),'throw Error("Untrusted entry executed");');
 await assert.rejects(validateOfflineNativeRuntime(f),/version differs/);
});
test('missing browser binary is refused even when the package is installed',async t=>{
 const f=await fixture(t,{executable:false});await assert.rejects(validateOfflineNativeRuntime(f),/runtime is not ready/);
});
test('source root must be explicit and absolute',async()=>{
 await assert.rejects(validateOfflineNativeRuntime({root:'relative'}),/absolute source root/);
});
test('the actual Chromium override is validated instead of an unused default binary',async t=>{
 const f=await fixture(t);await assert.rejects(validateOfflineNativeRuntime({...f,env:{...f.env,VERIFIER_CHROMIUM_PATH:path.join(f.root,'missing.exe')}}),/runtime is not ready/);
 await assert.rejects(validateOfflineNativeRuntime({...f,env:{...f.env,VERIFIER_CHROMIUM_PATH:'relative.exe'}}),/executable is missing/);
 const value=await validateOfflineNativeRuntime({...f,env:{...f.env,VERIFIER_CHROMIUM_PATH:f.binary}});assert.equal(value.executable,f.binary);
});
