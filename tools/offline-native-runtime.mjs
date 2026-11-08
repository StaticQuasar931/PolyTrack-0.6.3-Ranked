import fs from 'node:fs/promises';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';

/** Resolve the same explicit dependency path used by verify.cjs before copying
 * a capture. This checks installation only, never launches a browser or physics. */
export async function validateOfflineNativeRuntime({root,env=process.env}={}){
  if(!path.isAbsolute(root||''))throw Error('Offline native runtime requires an absolute source root');
  const packageFile=path.join(root,'tools/verifier/package.json'),require=createRequire(packageFile);
  try{
    const expected=JSON.parse(await fs.readFile(packageFile,'utf8')).dependencies?.playwright;
    const moduleName=env.VERIFIER_PLAYWRIGHT_MODULE||'playwright';
    const installedFile=require.resolve(moduleName+'/package.json'),bytes=await fs.readFile(installedFile);
    const actual=JSON.parse(bytes).version;
    if(typeof expected!=='string'||actual!==expected)throw Error('Playwright version differs from source pin');
    const executable=env.VERIFIER_CHROMIUM_PATH||require(moduleName).chromium?.executablePath?.();
    if(!path.isAbsolute(executable||''))throw Error('Chromium executable is missing');
    const stat=await fs.stat(executable);
    if(!stat.isFile()||stat.size<=0||stat.size>512*1024*1024)throw Error('Chromium executable is missing or oversized');
    return {version:actual,packageFile:installedFile,packageSha256:createHash('sha256').update(bytes).digest('hex'),
      executable,executableBytes:stat.size};
  }catch(error){throw Error('Offline native runtime is not ready: '+error.message,{cause:error});}
}
