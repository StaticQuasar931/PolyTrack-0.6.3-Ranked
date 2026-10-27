import fs from 'node:fs/promises';
import path from 'node:path';
import {buildOfflineOverall} from './offline-overall.mjs';
import {applyCapturedOverallProjection} from './capture-overall-projection.mjs';
const ID=/^[a-f0-9]{64}$/;
export async function rebuildSnapshotOverall({directory,now=Date.now}={}){
 const read=async name=>JSON.parse(await fs.readFile(path.join(directory,name),'utf8'));
 const manifest=await read('manifest.json'),previousOverall=await read('overall.json');
 let previousCalculation=null;try{previousCalculation=await read('overall-calculation.json');}catch(error){if(error.code!=='ENOENT')throw error;}
 const required=new Set((previousOverall.trackCatalog||[]).map(row=>row.trackId));
 const tracks=[];
 for(const [id,record] of Object.entries(manifest.tracks||{})){
  if(!ID.test(id))throw Error('Invalid snapshot track identifier');
  if(!record?.path){if(required.has(id))throw Error('Missing required snapshot track');continue;}
  if(record.path!=='tracks/'+id+'.json')throw Error('Invalid snapshot track path');
  const board=await read(record.path);
  if(board.trackId!==id||board.updatedAt!==record.updatedAt||record.sourceUpdatedAt!==undefined&&record.sourceUpdatedAt!==board.updatedAt||record.revision!==undefined&&record.revision!==Number(board.revision||board.sourceRevision||0))throw Error('Snapshot track binding mismatch');
  tracks.push(board);required.add(id);
 }
 const result=await buildOfflineOverall({tracks,previousOverall,previousCalculation,expectedTrackIds:[...required].sort(),now});
 const backendCapture=Object.hasOwn(manifest.overallCapture||{},'backendCapture')?manifest.overallCapture.backendCapture:manifest.overallCapture||null;
 const report={...result.report,publishedRevision:result.report.revision,projectionReason:null,calculatedAt:result.report.updatedAt,readTime:backendCapture?.readTime||null,
  sourceReadsReused:true,additionalFirestoreReads:0,additionalFirestoreWrites:0,backendCapture};
 await applyCapturedOverallProjection({directory,capture:{files:result.files,report}});
 const checked=await read('manifest.json');checked.overall.checkedAt=result.report.updatedAt;
 await fs.writeFile(path.join(directory,'manifest.json'),JSON.stringify(checked,null,2)+'\n');
 await fs.writeFile(path.join(directory,'overall-calculation.json'),JSON.stringify(result.calculation)+'\n');
 return report;
}
