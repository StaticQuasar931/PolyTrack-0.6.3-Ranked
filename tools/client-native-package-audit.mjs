import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
const root=new URL('../',import.meta.url);

// Test-only accessors into the actual closure, not extracted/reimplemented logic.
export async function installActualClientAuditBindings(page){
  const source=await fs.readFile(new URL('polytrack_062_patch.js',root),'utf8');
  const marker='  async function getTrackEntries(';
  if(source.split(marker).length!==2)throw Error('Native audit binding marker changed');
  const binding=`  window.__ptClientAudit={
    snapshot:()=>({selection:getTrackEntries.selection,state:currentTrackLoadState,cache:readTrackSnapshotCache(currentTrackLoadState?.trackId)}),
    refreshPackage:()=>readPublicSnapshotBackup('track-statistics','','',{refresh:true})
  };\n`;
  await page.route(url=>url.pathname.endsWith('/polytrack_062_patch.js'),route=>route.fulfill({status:200,contentType:'text/javascript',body:source.replace(marker,binding+marker)}));
}

export async function installNextPackageAudit(page,snapshot){
  const html=await fs.readFile(new URL('index.html',root),'utf8');
  const directory=html.match(/name="polytrack-snapshot" content="\.\/(public-snapshots\d+)\/"/)?.[1];
  if(!directory)throw Error('Native audit package location changed');
  const next='public-snapshots'+(Number(directory.match(/\d+$/)[0])+1);
  const base=new URL(directory+'/',root),files=new Map();
  const compact=JSON.parse(await fs.readFile(new URL('bootstrap-fast.json',base),'utf8'));
  const full=JSON.parse(await fs.readFile(new URL('index.json',base),'utf8'));
  const normalize=index=>{
    index.generation=Number(next.match(/\d+$/)[0]);delete index.compactIndexVersion;
    index.files=Object.fromEntries(Object.entries(index.files).map(([key,row])=>[key,Array.isArray(row)?{path:row[0]+'.bin',sha256:row[0],decodedBytes:row[1]}:row]));
    return index;
  };
  normalize(compact);normalize(full);
  const statsRecord=compact.files['track-statistics.json'];
  const statistics=JSON.parse(gunzipSync((await fs.readFile(new URL(statsRecord.path,base))).map(byte=>byte^0xa7)).toString());
  const id=snapshot.state.trackId,cache=snapshot.cache,updatedAt=Date.now();
  const entries=structuredClone(cache.entries);
  const oldTime=entries[0].timeMs,newTime=Math.max(1,oldTime-500);
  Object.assign(entries[0],{timeMs:newTime,frames:newTime,raceTimeFrames:newTime});
  const board={trackId:id,entries,updatedAt,builtAt:updatedAt,revision:cache.revision+1,sourceRevision:cache.revision+1,schemaVersion:cache.schemaVersion,algorithmVersion:cache.algorithmVersion,complete:cache.complete,totalEntries:entries.length,sourceComplete:cache.complete};
  statistics.tracks[id]={...statistics.tracks[id],updatedAt,revision:board.revision,capturedAt:new Date(updatedAt).toISOString()};
  const put=(logical,value)=>{
    const decoded=Buffer.from(JSON.stringify(value)),bytes=gzipSync(decoded).map(byte=>byte^0xa7),hash=createHash('sha256').update(bytes).digest('hex');
    const record={path:hash+'.bin',sha256:hash,decodedBytes:decoded.length};
    compact.files[logical]=record;full.files[logical]=record;files.set(record.path,bytes);return record.path;
  };
  const trackPath=put('tracks/'+id+'.json',board);put('track-statistics.json',statistics);
  let release,requested;const gate=new Promise(resolve=>{release=resolve;}),held=new Promise(resolve=>{requested=resolve;});
  const events=[];
  await page.route(url=>url.pathname==='/snapshot-current.json',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({currentdir:next})}));
  await page.route(url=>url.pathname.startsWith('/'+next+'/'),async route=>{
    const name=new URL(route.request().url()).pathname.slice(next.length+2);
    events.push({name,at:Date.now()});
    if(name===trackPath){requested();await gate;}
    if(['bootstrap-fast.json','bootstrap-index.json','index.json'].includes(name))return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(name==='index.json'?full:compact)});
    if(files.has(name))return route.fulfill({status:200,contentType:'application/octet-stream',body:files.get(name)});
    if(!/^(?:[a-f0-9]{64}\.bin|lookup-shards\/[a-f0-9]{2}\.json)$/.test(name))return route.fulfill({status:404,body:''});
    try{
      let body=await fs.readFile(new URL(name,base));
      if(name.endsWith('.json')){const value=JSON.parse(body);value.generation=full.generation;body=Buffer.from(JSON.stringify(value));}
      return route.fulfill({status:200,contentType:name.endsWith('.json')?'application/json':'application/octet-stream',body});
    }catch{return route.fulfill({status:404,body:''});}
  });
  return {id,oldTime,newTime,revision:board.revision,directory:next,events,release,waitForRequest:async()=>{
    let timer;try{await Promise.race([held,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Updated track request was not issued')),15000);})]);}finally{clearTimeout(timer);}
  }};
}
