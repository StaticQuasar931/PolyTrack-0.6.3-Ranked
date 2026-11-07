import fs from 'node:fs/promises';
import path from 'node:path';
import {constants} from 'node:fs';
import {createHash} from 'node:crypto';

const HARD={files:100000,directories:100000,bytes:256*1024*1024,fileBytes:16*1024*1024,pathLength:511,concurrency:8};
const demand=(ok,message)=>{if(!ok)throw Error('Bounded clone: '+message);};
const key=value=>path.resolve(value).toLowerCase();
const inside=(child,parent)=>{const relative=path.relative(key(parent),key(child));return relative===''||!path.isAbsolute(relative)&&relative!=='..'&&!relative.startsWith('..'+path.sep);};
const identity=stat=>[stat.dev,stat.ino].join(':');
const version=stat=>[stat.dev,stat.ino,stat.mode,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');

async function directoryChain(directory){
 const absolute=path.resolve(directory),base=path.parse(absolute).root;let current=base;
 for(const part of path.relative(base,absolute).split(path.sep).filter(Boolean)){
  current=path.join(current,part);const stat=await fs.lstat(current,{bigint:true});
  demand(stat.isDirectory()&&!stat.isSymbolicLink(),'directory link or non-directory');
 }
 demand(key(await fs.realpath(absolute))===key(absolute),'directory escapes its lexical path');
 return absolute;
}

async function inventory(root,limits){
 const files=[],directories=[],names=new Set();let bytes=0;
 async function visit(relative=''){
  for(const item of (await fs.readdir(path.join(root,relative),{withFileTypes:true})).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
   const logical=relative?relative+'/'+item.name:item.name;
   demand(logical.length<=limits.pathLength&&/^[A-Za-z0-9._/-]+$/.test(logical)&&
    logical.split('/').every(part=>part&&part!=='.'&&part!=='..'),'unsafe or oversized relative path');
   demand(!names.has(logical.toLowerCase()),'case-insensitive path collision');names.add(logical.toLowerCase());
   const stat=await fs.lstat(path.join(root,...logical.split('/')),{bigint:true});
   demand(!stat.isSymbolicLink(),'source link');
   if(stat.isDirectory()){
    demand(directories.length<limits.directories,'directory count bound');directories.push(logical);await visit(logical);
   }else{
    demand(stat.isFile(),'non-regular source');
    const size=Number(stat.size);
    demand(Number.isSafeInteger(size)&&size>=0&&size<=limits.fileBytes&&files.length<limits.files&&bytes+size<=limits.bytes,'file or byte bound');
    bytes+=size;files.push({path:logical,bytes:size,version:version(stat),identity:identity(stat),links:Number(stat.nlink)});
   }
  }
 }
 await visit();return {files,directories,bytes};
}

function settings(options){
 const limits={...HARD,...options};
 for(const name of Object.keys(limits))demand(Object.hasOwn(HARD,name)&&Number.isSafeInteger(limits[name])&&limits[name]>=1&&limits[name]<=HARD[name],'invalid limit');
 return limits;
}

/** Private exclusive destination only. This copies files; it grants no proof authority. */
export async function cloneBounded({source,destination,limits:options={}}={}){
 const started=performance.now(),limits=settings(options);
 demand(path.isAbsolute(source||'')&&path.isAbsolute(destination||''),'absolute paths required');
 source=await directoryChain(source);destination=path.resolve(destination);
 await directoryChain(path.dirname(destination));
 demand(!inside(destination,source)&&!inside(source,destination),'overlapping roots');
 try{await fs.lstat(destination);throw Error('Bounded clone: destination already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
 const sourceIdentity=identity(await fs.lstat(source,{bigint:true})),before=await inventory(source,limits);
 let ownedIdentity=null,stopped=false,next=0,copied=0,active=0,maxActive=0;
 try{
  await fs.mkdir(destination);ownedIdentity=identity(await fs.lstat(destination,{bigint:true}));
  for(const name of before.directories)await fs.mkdir(path.join(destination,...name.split('/')));
  const workers=await Promise.allSettled(Array.from({length:Math.min(limits.concurrency,before.files.length)},async()=>{
   try{while(!stopped&&next<before.files.length){
    const entry=before.files[next++],from=path.join(source,...entry.path.split('/')),to=path.join(destination,...entry.path.split('/'));
    await directoryChain(path.dirname(from));await directoryChain(path.dirname(to));
    const pre=await fs.lstat(from,{bigint:true});demand(pre.isFile()&&!pre.isSymbolicLink()&&version(pre)===entry.version,'source changed before copy');
    active++;maxActive=Math.max(maxActive,active);
    try{await fs.copyFile(from,to,constants.COPYFILE_EXCL);}finally{active--;}
    const post=await fs.lstat(from,{bigint:true}),output=await fs.lstat(to,{bigint:true});
    demand(post.isFile()&&!post.isSymbolicLink()&&version(post)===entry.version,'source changed during copy');
    demand(output.isFile()&&!output.isSymbolicLink()&&Number(output.size)===entry.bytes&&Number(output.nlink)===1&&identity(output)!==entry.identity,'invalid independent copy');
    copied++;
   }}catch(error){stopped=true;throw error;}
  }));
  const failed=workers.find(value=>value.status==='rejected');if(failed)throw failed.reason;
  await directoryChain(source);await directoryChain(destination);
  demand(identity(await fs.lstat(source,{bigint:true}))===sourceIdentity&&identity(await fs.lstat(destination,{bigint:true}))===ownedIdentity,'root replaced');
  const after=await inventory(source,limits),output=await inventory(destination,limits);
  demand(JSON.stringify(before)===JSON.stringify(after),'source inventory changed');
  demand(JSON.stringify(before.directories)===JSON.stringify(output.directories)&&before.files.length===output.files.length&&
   before.files.every((entry,i)=>entry.path===output.files[i].path&&entry.bytes===output.files[i].bytes),'destination inventory differs');
  return {authority:false,files:copied,directories:before.directories.length,bytes:before.bytes,maxActiveCopies:maxActive,
   sourceMetadataSha256:createHash('sha256').update(JSON.stringify(before)).digest('hex'),elapsedMs:Math.round(performance.now()-started)};
 }catch(error){
  if(ownedIdentity){
   try{
    await directoryChain(destination);
    demand(identity(await fs.lstat(destination,{bigint:true}))===ownedIdentity,'cleanup root replaced');
    demand(!inside(destination,source)&&!inside(source,destination),'unsafe cleanup overlap');
    await fs.rm(destination,{recursive:true,force:false});
   }catch(cleanup){throw new AggregateError([error,cleanup],'Bounded clone failed; output cleanup requires inspection');}
  }
  throw error;
 }
}
