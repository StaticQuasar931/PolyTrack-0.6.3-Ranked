import {decode} from './verifier/firestore.mjs';
const NAME='projects/polytrack-052/databases/(default)/documents/0.6.2_s1_worker_jobs/canonical_reconcile_v2';
const FIELDS=['backfillComplete','pendingTrackIds','pendingFullRebuildTrackIds','pendingResultIds','activeFullRebuildTrackId','failedFullRebuilds','lastScanAt','cursorIngestedAt','cursorDocumentId','backfillDocumentId','backfillQueuedTrackIds','backfillCatchupTrackIds'];
export async function captureBackendQueueDiagnostic(db){
 const rows=await db.call(':batchGet',{documents:[NAME],mask:{fieldPaths:FIELDS}});
 if(!Array.isArray(rows)||rows.length!==1)throw Error('Invalid backend queue diagnostic response');
 const row=rows[0];if(row.missing===NAME)return {status:'missing',documentReads:1,documentWrites:0};
 if(row.found?.name!==NAME||!row.found.fields)throw Error('Invalid backend queue diagnostic identity');
 const value=decode({mapValue:{fields:row.found.fields}}),list=value=>Array.isArray(value)?value.length:null,keys=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.keys(value).length:null;
 return {status:'captured',backfillComplete:typeof value.backfillComplete==='boolean'?value.backfillComplete:null,pendingTracks:list(value.pendingTrackIds),pendingFullRebuilds:list(value.pendingFullRebuildTrackIds),pendingResultIds:value.pendingResultIds&&typeof value.pendingResultIds==='object'?Object.values(value.pendingResultIds).reduce((n,ids)=>n+(Array.isArray(ids)?ids.length:0),0):null,failedRebuilds:keys(value.failedFullRebuilds),activeFullRebuild:typeof value.activeFullRebuildTrackId==='string'&&value.activeFullRebuildTrackId.length>0,hasChangedCursor:!!value.cursorDocumentId,hasBackfillCursor:!!value.backfillDocumentId,backfillDedupTracks:list(value.backfillQueuedTrackIds),backfillCatchupTracks:list(value.backfillCatchupTrackIds),lastScanAt:Number.isSafeInteger(value.lastScanAt)?value.lastScanAt:null,documentReads:1,documentWrites:0};
}
