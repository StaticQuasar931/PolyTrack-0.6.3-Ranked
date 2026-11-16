import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';

// Encoding is independent per file. Preserve input order and drain every worker
// before returning or throwing, so publication cleanup cannot race active writes.
export async function writeSnapshotPayloads({entries,directory,encode,maxEncodedBytes,concurrency=4}){
  if(!Array.isArray(entries)||entries.length>100000||!path.isAbsolute(directory||'')||typeof encode!=='function'||
    !Number.isSafeInteger(maxEncodedBytes)||maxEncodedBytes<1||maxEncodedBytes>20*1024*1024||
    !Number.isSafeInteger(concurrency)||concurrency<1||concurrency>8)throw Error('Invalid snapshot payload writer');
  const output=new Array(entries.length),published=new Map(),failures=[];let next=0,stopped=false;
  const workers=await Promise.allSettled(Array.from({length:Math.min(concurrency,entries.length)},async()=>{
    let currentIndex=-1;
    try{while(!stopped&&next<entries.length){
      const index=next++;currentIndex=index;const {logicalPath,bytes}=entries[index];
      const encoded=await encode(bytes);
      if(!Buffer.isBuffer(encoded)||encoded.length>maxEncodedBytes)throw new RangeError(`${logicalPath} encoded file exceeds ${maxEncodedBytes} bytes`);
      if(stopped)return;
      const temporary=path.join(directory,`snapshot-${String(index+1).padStart(4,'0')}.bin`);
      await fs.writeFile(temporary,encoded,{flag:'wx'});
      const sha256=createHash('sha256').update(encoded).digest('hex'),name=sha256+'.bin';
      const existing=published.get(name);
      if(existing){await existing;await fs.unlink(temporary);}
      else{
        const publication=fs.rename(temporary,path.join(directory,name));
        published.set(name,publication);await publication;
      }
      output[index]={logicalPath,path:name,sha256,decodedBytes:bytes.byteLength,encodedBytes:encoded.length};
    }}catch(error){stopped=true;failures.push({index:currentIndex,error});throw error;}
  }));
  if(failures.length)throw failures.sort((a,b)=>a.index-b.index)[0].error;
  const failed=workers.find(value=>value.status==='rejected');if(failed)throw failed.reason;
  return output;
}
