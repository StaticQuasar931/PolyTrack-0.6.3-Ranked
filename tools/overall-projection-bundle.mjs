import {projectLocalOverall} from './overall-local-projection.mjs';

const BINDINGS=['algorithmVersion','schemaVersion','sourceRevision','builtRevision','updatedAt'];
const ID=/^[A-Za-z0-9_-]{1,128}$/;
const positive=value=>Number.isSafeInteger(value)&&value>0;
const count=value=>Number.isSafeInteger(value)&&value>=0;
const only=(value,keys)=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).every(key=>keys.includes(key));
const FIELDS=['accountId','timeMs','pbAt','weight','runVerified','integrityVerified','pbCount','totalPlaytimeMs','accountCreatedAt'];

// Scoring inputs only. No replay bytes, private source metadata, identities or cosmetics.
export function decodeOverallProjectionBundle(bundle,{overall,generation}={}){
  if(bundle&&typeof bundle==='object'&&!Array.isArray(bundle)){
    const transport=['_publicBackup','_dataSource','_snapshotCapturedAt'];
    if(Object.hasOwn(bundle,'_publicBackup')&&bundle._publicBackup!==true||
      Object.hasOwn(bundle,'_dataSource')&&!['snapshot','cached'].includes(bundle._dataSource)||
      Object.hasOwn(bundle,'_snapshotCapturedAt')&&!positive(bundle._snapshotCapturedAt))throw Error('Invalid projection transport metadata');
    bundle=Object.fromEntries(Object.entries(bundle).filter(([key])=>!transport.includes(key)));
  }
  if(!only(bundle,['version',...BINDINGS,'boards'])||bundle.version!==1||
      !BINDINGS.every(key=>bundle[key]===overall?.[key])||!positive(bundle.sourceRevision)||
      bundle.algorithmVersion!=='participation-v8-s1'||bundle.schemaVersion!==6||
      !Array.isArray(bundle.boards)||bundle.boards.length>512||!Array.isArray(overall.trackCatalog)||
      bundle.boards.length!==overall.trackCatalog.length)throw Error('Invalid Overall projection source');
  const catalog=new Map(overall.trackCatalog.map(row=>[row.trackId,row.updatedAt]));
  if(catalog.size!==bundle.boards.length)throw Error('Duplicate Overall projection source');
  const seen=new Set();let total=0;
  return bundle.boards.map(board=>{
    if(!Array.isArray(board)||board.length!==5||!ID.test(board[0])||seen.has(board[0])||
        !positive(board[1])||!count(board[2])||catalog.get(board[0])!==board[2]||
        !count(board[3])||!Array.isArray(board[4])||board[4].length!==board[3]||
        board[3]>10000||(total+=board[3])>100000)throw Error('Invalid Overall projection board');
    seen.add(board[0]);const accounts=new Set();
    const entries=board[4].map(tuple=>{
      if(!Array.isArray(tuple)||tuple.length!==FIELDS.length||!ID.test(tuple[0])||accounts.has(tuple[0])||
          !positive(tuple[1])||tuple[1]>36000000||!count(tuple[2])||typeof tuple[3]!=='number'||
          !Number.isFinite(tuple[3])||tuple[3]<0||typeof tuple[4]!=='boolean'||typeof tuple[5]!=='boolean'||
          tuple.slice(6).some(value=>!count(value)))throw Error('Invalid Overall projection row');
      accounts.add(tuple[0]);return {...Object.fromEntries(FIELDS.map((key,index)=>[key,tuple[index]])),trackId:board[0]};
    });
    return {algorithmVersion:bundle.algorithmVersion,schemaVersion:bundle.schemaVersion,
      trackId:board[0],sourceRevision:board[1],updatedAt:board[2],complete:true,sourceComplete:true,
      totalEntriesExact:true,totalEntries:entries.length,entries,generation};
  });
}

export async function decodeProjectionResults(packed){
  if(packed?.resultBundleVersion!==1||packed.resultBundleEncoding!=='gzip-base64-json-v1'||
      packed.resultBundleComplete!==true||typeof packed.resultBundle!=='string'||packed.resultBundle.length>1400000)throw Error('Invalid projection result bundle');
  const bytes=Uint8Array.from(atob(packed.resultBundle),character=>character.charCodeAt(0));
  const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>6*1024*1024)throw Error('Projection results too large');chunks.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  const plain=new Uint8Array(size);let offset=0;for(const chunk of chunks){plain.set(chunk,offset);offset+=chunk.length;}
  const data=JSON.parse(new TextDecoder().decode(plain));
  if(!Array.isArray(data.entries)||data.entries.length>100000||!Array.isArray(data.resultTracks)||data.resultTracks.length>512)throw Error('Invalid decoded projection results');
  return {...packed,entries:data.entries,resultTracks:data.resultTracks};
}

export async function createOverallProjectionBundle({overall,results,tracks}={}){
  if(!Array.isArray(tracks)||tracks.length>512)throw Error('Missing bound Overall source boards');
  const bundle={version:1,...Object.fromEntries(BINDINGS.map(key=>[key,overall?.[key]])),boards:tracks.map(board=>{
    if((board.sourceComplete!==true&&board.complete!==true)||board.totalEntries!==board.entries?.length)throw Error('Incomplete Overall source board');
    return [board.trackId,board.sourceRevision,board.updatedAt??board.builtAt??0,board.entries.length,board.entries.map(row=>
      [row.accountId||row.userId,row.timeMs,row.pbAt??0,row.weight,row.runVerified,row.integrityVerified,
        row.pbCount??0,row.totalPlaytimeMs??0,row.accountCreatedAt??0])];
  })};
  if(new TextEncoder().encode(JSON.stringify(bundle)).length>2*1024*1024)throw Error('Overall projection source exceeds snapshot file limit');
  const generation='bound-source-check',boards=decodeOverallProjectionBundle(bundle,{overall,generation});
  const decoded=await decodeProjectionResults(results);
  const check=projectLocalOverall({accountId:overall.entries?.[0]?.userId||overall.entries?.[0]?.accountId,
    generation,overall:{...overall,generation},results:{...decoded,generation},tracks:boards,acceptedPbs:[]});
  if(check.status!=='unchanged'||check.calculationExact!==true)throw Error('Overall projection baseline mismatch: '+(check.reason||check.status));
  return bundle;
}
