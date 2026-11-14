// Wire stays within the existing snapshot cap. Only this directory's verified
// optional details may expand further; legacy readers retain every identity.
export const RACER_DIRECTORY_WIRE_BYTES=2*1024*1024;
export const RACER_DIRECTORY_EXPANDED_BYTES=4*1024*1024;
const identityFields=['updatedAt','name','nickname','countryCode'];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const bytes=value=>new TextEncoder().encode(JSON.stringify(value));
const hash=async value=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',value))].map(n=>n.toString(16).padStart(2,'0')).join('');
function projection(entries){
  return Object.fromEntries(Object.entries(entries).map(([id,row])=>[id,Object.fromEntries(identityFields.filter(key=>Object.hasOwn(row,key)).map(key=>[key,row[key]]))]));
}
async function bounded(stream,limit){
  const reader=stream.getReader(),chunks=[];let total=0;
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>limit)throw Error('Racer directory details exceed expanded limit');chunks.push(value);}
  }finally{await reader.cancel().catch(()=>{});}
  const output=new Uint8Array(total);let at=0;for(const chunk of chunks){output.set(chunk,at);at+=chunk.length;}return output;
}
export async function encodeRacerDirectory(value,{forceCompact=false}={}){
  const original=bytes(value);
  if(!forceCompact&&original.length+1<=RACER_DIRECTORY_WIRE_BYTES)return value;
  if(original.length>RACER_DIRECTORY_EXPANDED_BYTES)throw Error('Racer directory details exceed expanded limit');
  const compressed=await bounded(new Blob([original]).stream().pipeThrough(new CompressionStream('gzip')),RACER_DIRECTORY_WIRE_BYTES);
  let binary='';for(let at=0;at<compressed.length;at+=32768)binary+=String.fromCharCode(...compressed.subarray(at,at+32768));
  const wire={schemaVersion:1,updatedAt:value.updatedAt,entries:projection(value.entries),details:{
    encoding:'gzip-base64-v1',decodedBytes:original.length,sha256:await hash(original),data:btoa(binary)
  }};
  if(bytes(wire).length+1>RACER_DIRECTORY_WIRE_BYTES)throw Error('Snapshot racer directory exceeds client limit');
  return wire;
}
export async function expandRacerDirectory(value){
  if(!object(value)||!Object.hasOwn(value,'details'))return value;
  if(bytes(value).length+1>RACER_DIRECTORY_WIRE_BYTES)throw Error('Snapshot racer directory exceeds client limit');
  const details=value.details;
  if(value.schemaVersion!==1||!object(value.entries)||!object(details)||details.encoding!=='gzip-base64-v1'||
    Object.keys(details).some(key=>!['encoding','decodedBytes','sha256','data'].includes(key))||
    !Number.isSafeInteger(details.decodedBytes)||details.decodedBytes<1||details.decodedBytes>RACER_DIRECTORY_EXPANDED_BYTES||
    !/^[a-f0-9]{64}$/.test(details.sha256||'')||typeof details.data!=='string'||details.data.length>RACER_DIRECTORY_WIRE_BYTES||
    details.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(details.data))throw Error('Invalid racer directory details');
  const binary=atob(details.data),compressed=Uint8Array.from(binary,char=>char.charCodeAt(0));
  const original=await bounded(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip')),details.decodedBytes);
  if(original.length!==details.decodedBytes||await hash(original)!==details.sha256)throw Error('Racer directory details integrity mismatch');
  const full=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(original));
  if(!object(full)||!object(full.entries)||Object.hasOwn(full,'details')||full.updatedAt!==value.updatedAt)throw Error('Invalid expanded racer directory');
  const expected=projection(full.entries),ids=Object.keys(expected);
  if(ids.length!==Object.keys(value.entries).length||ids.some(id=>{
    const row=value.entries[id],canonical=expected[id];
    return !object(row)||Object.keys(row).length!==Object.keys(canonical).length||Object.keys(canonical).some(key=>!Object.hasOwn(row,key)||row[key]!==canonical[key]);
  }))throw Error('Racer directory legacy identity mismatch');
  return full;
}
