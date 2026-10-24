import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const fields=['id','trackId','kind','startsAt','endsAt','graceMs','maxRp','label','author','trackName','entrantLimit','targetMs','targetPolicy','scoringVersion','racerCount'];
function valid(period){
  return /^[A-Za-z0-9_-]{1,64}$/.test(period?.id||'')&&/^[a-f0-9]{64}$/.test(period?.trackId||'')&&
    ['daily','weekly','kodub','custom'].includes(period.kind)&&Number.isSafeInteger(period.startsAt)&&period.startsAt>=0&&
    Number.isSafeInteger(period.endsAt)&&period.endsAt>period.startsAt;
}
function publicPeriod(period){
  return Object.fromEntries(fields.filter(key=>typeof period[key]==='string'?period[key].length<=256:Number.isFinite(period[key])).map(key=>[key,period[key]]));
}
export function mergeFrozenEventCatalog(catalog,boards,previousCatalog=null){
  if(!Array.isArray(catalog?.periods)||!Array.isArray(catalog.archives))throw Error('Invalid event catalog');
  if(previousCatalog && (!Array.isArray(previousCatalog.periods)||!Array.isArray(previousCatalog.archives)||previousCatalog.archives.length>5000))
    throw Error('Invalid saved event catalog');
  // Retain frozen history before the recent Worker catalog can replace the file.
  const archives=new Map((previousCatalog?.archives||[]).filter(valid).map(period=>[period.id,{...publicPeriod(period),archived:true}]));
  for(const period of catalog.archives.filter(valid))archives.set(period.id,period);
  for(const board of boards){
    const period=board?.period;
    if(board?.archived!==true||!Array.isArray(board.entries)||!valid(period)||board.id&&board.id!==period.id)continue;
    archives.set(period.id,{...archives.get(period.id),...publicPeriod(period),archived:true});
  }
  if(archives.size>5000)throw Error('Archive catalog exceeds bounded history capacity');
  return {...catalog,archives:[...archives.values()].sort((a,b)=>b.endsAt-a.endsAt||a.id.localeCompare(b.id))};
}
export async function mergeSavedArchiveFiles({staging=new URL('../local-reports/snapshot-staging/',import.meta.url),output=new URL('../events/public-catalog.json',import.meta.url)}={}){
  const directory=staging instanceof URL?fileURLToPath(staging):path.resolve(staging);
  const destination=output instanceof URL?fileURLToPath(output):path.resolve(output);
  const catalog=JSON.parse(await fs.readFile(destination,'utf8'));
  // Catalog-only runs have no hydrated staging directory. Saved history is still valid.
  let files;
  try{files=await fs.readdir(path.join(directory,'events'));}
  catch(error){if(error.code!=='ENOENT')throw error;files=[];}
  const names=files.filter(name=>/^[A-Za-z0-9_-]{1,64}\.json$/.test(name));
  if(names.length>5000)throw Error('Too many event snapshot files');
  const boards=[];
  for(const name of names){const bytes=await fs.readFile(path.join(directory,'events',name));if(bytes.length>16*1024*1024)throw Error('Event snapshot too large');boards.push(JSON.parse(bytes));}
  const merged=mergeFrozenEventCatalog(catalog,boards),text=JSON.stringify(merged,null,2)+'\n';
  if(text!==await fs.readFile(destination,'utf8')){await fs.writeFile(destination+'.tmp',text);await fs.rename(destination+'.tmp',destination);}
  return merged;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){
  const catalog=await mergeSavedArchiveFiles();console.log('Indexed '+catalog.archives.length+' saved archived events. No Firebase requests.');
}
