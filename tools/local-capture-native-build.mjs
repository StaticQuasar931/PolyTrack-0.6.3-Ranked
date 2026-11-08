import {spawn} from 'node:child_process';
import {createHash,randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const NATIVE_SOURCE_SHA256='99197d719c7fdfa781b80e1b345c1710b9f4f93e009d5794b0f1c438a451fb8d';
export const NATIVE_TOOLCHAIN=Object.freeze({
  'csc.exe':'eca02e6b15cde93009a59a3d129d5a77fb5008f2e1cf62cf573b6737c747ecc3',
  'csc.exe.config':'2d4610ade011e530d817dd3ba4fc787e5dc0c2297cc520c30a643b8fb13f9093',
  'mscorlib.dll':'94715f6991e2b9dc7481532c05aa99e74a5fff4ee147be541bca27f99e003fc7',
  'System.dll':'09787b4f38f4f020c6b8a3894146085d4df7b8ae337577ed42d9acf1419660e8',
  'System.Core.dll':'d1bafee1a4dd7e7bd9adf6859e7b1b654d1b4e0d031a38795e33ba040508c09d'
});
const BUILD_VERSION=1,MAX_FILES=32,MAX_BINARY=1024*1024;
const ACL_TOOL_SHA256='d8f182560210d43baaf767d482ad1dc1207372522e91413b9d5e515a875e552d';
const SWITCHES=Object.freeze(['/nologo','/noconfig','/nostdlib+','/target:exe','/platform:x64','/optimize+','/debug-']);
const hash=value=>createHash('sha256').update(value).digest('hex');
const TOOLCHAIN_KEY=hash(JSON.stringify({version:BUILD_VERSION,toolchain:NATIVE_TOOLCHAIN,switches:SWITCHES}));
const CACHE_KEY=NATIVE_SOURCE_SHA256+'-'+TOOLCHAIN_KEY;
const fail=code=>Object.assign(Error(code),{code});

// This fixed script only creates/reviews private artifact directories. It never
// compiles code, changes an existing ACL, or changes execution policy.
const PRIVATE_DIRECTORY_SCRIPT=String.raw`$ErrorActionPreference='Stop'
try {
  $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
  $system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
  function Check-Path([string]$value) {
    $cursor=[IO.Path]::GetFullPath($value)
    while($cursor){if([IO.Directory]::Exists($cursor) -or [IO.File]::Exists($cursor)){if(([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse path'}};$next=[IO.Path]::GetDirectoryName($cursor);if($next -eq $cursor){break};$cursor=$next}
  }
  function Check-Acl([string]$value,[bool]$directory) {
    Check-Path $value
    $acl=Get-Acl -LiteralPath $value
    if($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'Unexpected owner'}
    if($directory -and -not $acl.AreAccessRulesProtected){throw 'Unprotected directory'}
    foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){
      if($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin @($sid.Value,$system.Value)){throw 'Unexpected access'}
    }
  }
  function Ensure-Private([string]$value) {
    Check-Path $value
    if(-not [IO.Directory]::Exists($value)){
      $acl=[Security.AccessControl.DirectorySecurity]::new();$acl.SetOwner($sid);$acl.SetAccessRuleProtection($true,$false)
      $inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
      foreach($principal in @($sid,$system)){$acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($principal,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow))}
      [IO.Directory]::CreateDirectory($value,$acl)|Out-Null
    }
    Check-Acl $value $true
  }
  $root=[IO.Path]::GetFullPath($env:CAPTURE_CACHE_ROOT);$artifact=[IO.Path]::GetFullPath($env:CAPTURE_ARTIFACT_DIR)
  if(-not $artifact.StartsWith($root+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Outside cache'}
  Ensure-Private $root
  if($env:CAPTURE_CACHE_ACTION -eq 'create'){
    if([IO.Directory]::Exists($artifact) -or [IO.File]::Exists($artifact)){throw 'Stage already exists'}
    Ensure-Private $artifact
  }
  elseif($env:CAPTURE_CACHE_ACTION -eq 'validate'){
    Check-Acl $artifact $true
    foreach($name in @('broker.cs','broker.exe','manifest.json')){Check-Acl ([IO.Path]::Combine($artifact,$name)) $false}
  }else{throw 'Invalid action'}
  [Console]::Out.WriteLine('PRIVATE_ARTIFACT_OK');exit 0
}catch{[Console]::Error.WriteLine('PRIVATE_ARTIFACT_REJECTED');exit 1}
`;

function remaining(deadline,started,budget){return Math.floor(Math.min(deadline-Date.now(),budget-(performance.now()-started)));}
export function runNativeBuildCommand({file,args,options,deadline,signal,spawnImpl=spawn}={}) {
  const started=performance.now(),budget=deadline-Date.now();
  if(!Number.isSafeInteger(deadline)||budget<=5000||signal?.aborted)return Promise.reject(Object.assign(fail('NATIVE_BUILD_DEADLINE'),{directProcessClosed:true}));
  return new Promise((resolve,reject)=>{
    let child,timer,closeTimer,settled=false,problem=null,bytes=0,output='',directProcessClosed=true;
    const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);clearTimeout(closeTimer);signal?.removeEventListener('abort',abort);if(error){error.directProcessClosed=directProcessClosed;reject(error);}else resolve(result);};
    const stop=error=>{
      if(settled||problem)return;problem=error;clearTimeout(timer);
      try{child.kill();}catch{}
      closeTimer=setTimeout(()=>finish(Object.assign(fail('NATIVE_BUILD_CLOSE_UNCONFIRMED'),{cleanupConfirmed:false})),Math.max(1,Math.min(5000,remaining(deadline,started,budget))));
    };
    const abort=()=>stop(fail('NATIVE_BUILD_ABORTED'));
    try{child=spawnImpl(file,args,{...options,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']});directProcessClosed=false;}
    catch{finish(fail('NATIVE_BUILD_SPAWN_FAILED'));return;}
    signal?.addEventListener('abort',abort,{once:true});
    child.once('error',()=>{if(!child.pid){directProcessClosed=true;finish(fail('NATIVE_BUILD_SPAWN_FAILED'));}else stop(fail('NATIVE_BUILD_SPAWN_FAILED'));});
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{
      bytes+=chunk.length;if(bytes>16384){stop(fail('NATIVE_BUILD_OUTPUT_LIMIT'));return;}
      if(stream===child.stdout)output+=chunk.toString('utf8');
    });
    child.once('close',(code,signalCode)=>{directProcessClosed=true;finish(problem||((code!==0||signalCode)?fail('NATIVE_BUILD_FAILED'):null),{output});});
    timer=setTimeout(()=>stop(fail('NATIVE_BUILD_DEADLINE')),Math.max(1,remaining(deadline,started,budget)-5000));
    if(signal?.aborted)abort();
  });
}

async function noLinks(file) {
  for(let cursor=path.resolve(file);;cursor=path.dirname(cursor)){
    try{if((await fs.lstat(cursor)).isSymbolicLink())throw fail('NATIVE_ARTIFACT_REPARSE');}catch(error){if(error.code!=='ENOENT')throw error;}
    if(path.dirname(cursor)===cursor)break;
  }
}
const sameIdentity=(a,b)=>a.dev===b.dev&&a.ino===b.ino;
async function stageDirectory(directory) {
  await noLinks(directory);const stat=await fs.lstat(directory,{bigint:true});
  if(!stat.isDirectory())throw fail('NATIVE_STAGE_IDENTITY');return stat;
}
async function checkOwnedStage({cacheRoot,stage,rootIdentity,stageIdentity}) {
  if(path.dirname(stage)!==cacheRoot||!/^stage-[a-f0-9]{32}$/.test(path.basename(stage)))throw fail('NATIVE_STAGE_PATH');
  if(!sameIdentity(await stageDirectory(cacheRoot),rootIdentity)||!sameIdentity(await stageDirectory(stage),stageIdentity))throw fail('NATIVE_STAGE_IDENTITY');
}
async function removeOwnedStage({cacheRoot,stage,rootIdentity,stageIdentity}) {
  const check=()=>checkOwnedStage({cacheRoot,stage,rootIdentity,stageIdentity});
  await check();const names=await fs.readdir(stage);if(names.length>MAX_FILES)throw fail('NATIVE_STAGE_CONTENTS');
  const entries=[];
  for(const name of names){
    if(path.basename(name)!==name||/[\\/:\0]/.test(name))throw fail('NATIVE_STAGE_PATH');
    const file=path.join(stage,name);await noLinks(file);const stat=await fs.lstat(file,{bigint:true});
    if(!stat.isFile()||stat.nlink!==1n)throw fail('NATIVE_STAGE_CONTENTS');entries.push({file,stat});
  }
  // Flat unlink only: never follow a link or recurse into a compiler-created tree.
  for(const {file,stat} of entries){
    await check();await noLinks(file);const current=await fs.lstat(file,{bigint:true});
    if(!current.isFile()||current.nlink!==1n||!sameIdentity(current,stat))throw fail('NATIVE_STAGE_IDENTITY');
    await fs.unlink(file);
  }
  await check();await fs.rmdir(stage);
}

// Trusted test seams exercise stage ownership without compiling or launching a
// process. Closure here covers direct pinned bootstrap processes, not a proven
// descendant tree. Compiler descendants have not been demonstrated or attested.
export async function withNativeBuildStage({cacheRoot,artifact,privateDirectory,build,isClosed,check=()=>{},validate=validateNativeArtifact,renameStage=fs.rename}={}) {
  if(!path.isAbsolute(cacheRoot)||path.resolve(cacheRoot)!==cacheRoot||path.dirname(artifact)!==cacheRoot||
    !/^[a-f0-9]{64}-[a-f0-9]{64}$/.test(path.basename(artifact)))throw fail('NATIVE_STAGE_PATH');
  await noLinks(cacheRoot);
  const stage=path.join(cacheRoot,'stage-'+randomBytes(16).toString('hex'));let ownership,published=false,primary;
  try{
    await privateDirectory(stage,'create');
    ownership={cacheRoot,stage,rootIdentity:await stageDirectory(cacheRoot),stageIdentity:await stageDirectory(stage)};
    check();
    if((await fs.readdir(cacheRoot)).length>MAX_FILES)throw fail('NATIVE_CACHE_RESOURCE_BOUND');
    await build(stage);check();if(isClosed()!==true)throw fail('NATIVE_BUILD_CLOSE_UNCONFIRMED');await checkOwnedStage(ownership);
    let winner=false;try{await fs.lstat(artifact);winner=true;}catch(error){if(error.code!=='ENOENT')throw error;}
    if(winner)await privateDirectory(artifact,'validate');
    else try{await renameStage(stage,artifact);published=true;}catch(error){
      if(!['EEXIST','ENOTEMPTY','EPERM'].includes(error.code))throw error;
      await privateDirectory(artifact,'validate');
    }
    const result=await validate(artifact);check();return result;
  }catch(error){primary=error;throw error;}
  finally{
    if(ownership&&!published&&isClosed()===true){
      try{await removeOwnedStage(ownership);}catch(error){
        if(primary)primary.stageCleanup={preserved:true,code:error.code||'NATIVE_STAGE_CLEANUP_FAILED'};else throw error;
      }
    }
  }
}
async function boundedFile(file,maxBytes) {
  await noLinks(file);const handle=await fs.open(file,'r');
  try{
    const stat=await handle.stat({bigint:true});
    if(!stat.isFile()||stat.nlink!==1n||stat.size<1n||stat.size>BigInt(maxBytes))throw fail('NATIVE_ARTIFACT_FILE_INVALID');
    const data=Buffer.alloc(Number(stat.size)+1);let used=0;
    while(used<data.length){const {bytesRead}=await handle.read(data,used,data.length-used,used);if(!bytesRead)break;used+=bytesRead;}
    if(used!==Number(stat.size))throw fail('NATIVE_ARTIFACT_SIZE_CHANGED');
    return {data:data.subarray(0,used),identity:{device:String(stat.dev),file:String(stat.ino)}};
  }finally{await handle.close();}
}
function sourceBytes(data){return Buffer.from(data.toString('utf8').replace(/\r\n?/g,'\n'));}
export function validateNativeManifest(manifest,{sourceSha256=NATIVE_SOURCE_SHA256,toolchainKey=TOOLCHAIN_KEY,binarySha256,identity}={}) {
  if(!manifest||manifest.version!==BUILD_VERSION||manifest.sourceSha256!==sourceSha256||manifest.toolchainKey!==toolchainKey||
    !/^[a-f0-9]{64}$/.test(manifest.binarySha256||'')||manifest.binarySha256!==binarySha256||
    manifest.identity?.device!==identity?.device||manifest.identity?.file!==identity?.file||
    JSON.stringify(manifest.toolchain)!==JSON.stringify(NATIVE_TOOLCHAIN)||JSON.stringify(manifest.switches)!==JSON.stringify(SWITCHES))throw fail('NATIVE_ARTIFACT_BINDING_MISMATCH');
  return true;
}
export async function validateNativeArtifact(directory) {
  const names=(await fs.readdir(directory)).sort();
  if(JSON.stringify(names)!==JSON.stringify(['broker.cs','broker.exe','manifest.json']))throw fail('NATIVE_ARTIFACT_INVENTORY');
  const source=await boundedFile(path.join(directory,'broker.cs'),65536),binary=await boundedFile(path.join(directory,'broker.exe'),MAX_BINARY);
  if(hash(sourceBytes(source.data))!==NATIVE_SOURCE_SHA256||binary.data.length<1024||binary.data.subarray(0,2).toString()!=='MZ')throw fail('NATIVE_ARTIFACT_CONTENT');
  let manifest;try{manifest=JSON.parse((await boundedFile(path.join(directory,'manifest.json'),8192)).data);}catch{throw fail('NATIVE_ARTIFACT_MANIFEST');}
  validateNativeManifest(manifest,{binarySha256:hash(binary.data),identity:binary.identity});
  return {executable:path.join(directory,'broker.exe'),sourceSha256:NATIVE_SOURCE_SHA256,binarySha256:manifest.binarySha256,toolchainKey:TOOLCHAIN_KEY};
}
function projectRoot() {
  for(let current=path.dirname(fileURLToPath(import.meta.url));;current=path.dirname(current)){
    if(path.basename(current).toLowerCase()==='ranked-0.6.3'&&path.basename(path.dirname(current)).toLowerCase()==='projects'&&
      path.basename(path.dirname(path.dirname(current))).toLowerCase()==='polytrack')return current;
    if(path.dirname(current)===current)throw fail('NATIVE_PROJECT_ROOT_REQUIRED');
  }
}
let building=null;
export function prepareNativeBroker({deadline=Date.now()+30000,signal}={}) {
  if(building)return building;
  building=prepareArtifact({deadline,signal}).finally(()=>{building=null;});return building;
}
async function prepareArtifact({deadline,signal}) {
  const started=performance.now(),budget=Math.min(30000,deadline-Date.now());
  if(process.platform!=='win32'||process.arch!=='x64')throw fail('NATIVE_PLATFORM_UNSUPPORTED');
  const check=()=>{if(signal?.aborted||remaining(deadline,started,budget)<=0)throw fail('NATIVE_BUILD_DEADLINE');};check();
  const source=sourceBytes((await boundedFile(fileURLToPath(new URL('./local-capture-native-broker.cs',import.meta.url)),65536)).data);
  if(hash(source)!==NATIVE_SOURCE_SHA256)throw fail('NATIVE_SOURCE_PIN_MISMATCH');
  // This capture host is intentionally pinned. An OS/toolchain change requires
  // review, not an environment-provided replacement compiler or ACL utility.
  const systemRoot='C:\\Windows';
  if(path.resolve(process.env.SystemRoot||systemRoot).toLowerCase()!==systemRoot.toLowerCase())throw fail('NATIVE_SYSTEM_ROOT_INVALID');
  const framework=path.join(systemRoot,'Microsoft.NET','Framework64','v4.0.30319');
  for(const [name,expected] of Object.entries(NATIVE_TOOLCHAIN)){
    check();const file=path.join(framework,name);await noLinks(file);
    const stat=await fs.stat(file);if(!stat.isFile()||stat.size>32*1024*1024||hash(await fs.readFile(file))!==expected)throw fail('NATIVE_TOOLCHAIN_PIN_MISMATCH');
  }
  const aclTool=path.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');await noLinks(aclTool);
  const aclStat=await fs.stat(aclTool);if(!aclStat.isFile()||aclStat.size>32*1024*1024||hash(await fs.readFile(aclTool))!==ACL_TOOL_SHA256)throw fail('NATIVE_ACL_TOOL_PIN_MISMATCH');
  check();const parent=path.join(projectRoot(),'local-reports');await noLinks(parent);await fs.mkdir(parent,{recursive:true});
  const cacheRoot=path.join(parent,'native-supervisor-v1'),artifact=path.join(cacheRoot,CACHE_KEY);
  const environment={SystemRoot:systemRoot,WINDIR:systemRoot,PATH:path.join(systemRoot,'System32')};
  let directProcessesClosed=true;
  const execute=async options=>{
    try{return await runNativeBuildCommand(options);}catch(error){if(error.directProcessClosed!==true)directProcessesClosed=false;throw error;}
  };
  const privateDirectory=async(directory,action)=>{
    check();const {output}=await execute({file:aclTool,
      args:['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(PRIVATE_DIRECTORY_SCRIPT,'utf16le').toString('base64')],
      options:{env:{...environment,CAPTURE_CACHE_ROOT:cacheRoot,CAPTURE_ARTIFACT_DIR:directory,CAPTURE_CACHE_ACTION:action}},deadline:Math.min(deadline,Date.now()+remaining(deadline,started,budget)),signal});
    if(output.trim()!=='PRIVATE_ARTIFACT_OK')throw fail('NATIVE_ARTIFACT_PRIVACY_UNCONFIRMED');if(action!=='create')check();
  };
  let exists=false;try{await fs.lstat(artifact);exists=true;}catch(error){if(error.code!=='ENOENT')throw error;}
  if(exists){await privateDirectory(artifact,'validate');const result=await validateNativeArtifact(artifact);check();return result;}
  try{if((await fs.readdir(cacheRoot)).length>=MAX_FILES)throw fail('NATIVE_CACHE_RESOURCE_BOUND');}catch(error){if(error.code!=='ENOENT')throw error;}
  return withNativeBuildStage({cacheRoot,artifact,privateDirectory,check,isClosed:()=>directProcessesClosed,build:async stage=>{
    await fs.writeFile(path.join(stage,'broker.cs'),source,{flag:'wx'});check();
    const output=path.join(stage,'broker.exe');
    const args=[...SWITCHES,...['mscorlib.dll','System.dll','System.Core.dll'].map(name=>'/reference:'+path.join(framework,name)),
      '/out:'+output,path.join(stage,'broker.cs')];
    await execute({file:path.join(framework,'csc.exe'),args,options:{cwd:stage,env:{...environment,TEMP:stage,TMP:stage}},
      deadline:Math.min(deadline,Date.now()+remaining(deadline,started,budget)),signal});check();
    const binary=await boundedFile(output,MAX_BINARY);
    await fs.writeFile(path.join(stage,'manifest.json'),JSON.stringify({version:BUILD_VERSION,sourceSha256:NATIVE_SOURCE_SHA256,
      toolchainKey:TOOLCHAIN_KEY,toolchain:NATIVE_TOOLCHAIN,switches:SWITCHES,binarySha256:hash(binary.data),identity:binary.identity},null,2),{flag:'wx'});
    await privateDirectory(stage,'validate');await validateNativeArtifact(stage);check();
  }});
}
