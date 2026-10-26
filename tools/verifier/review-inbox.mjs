import {reviewRecord, REVIEW_COLLECTION} from '../../workers/ranked/src/review-inbox.js';
export {reviewRecord, REVIEW_COLLECTION};

// Keep the original finding and any administrator decision unchanged on retries.
export async function reviewInboxWrite(db, auditId, job, verdict, evidence) {
  const data=reviewRecord(auditId,job,verdict,evidence);
  if(!data) return null;
  const existing=await db.get(REVIEW_COLLECTION,auditId);
  return existing?null:db.write(REVIEW_COLLECTION,auditId,data,null);
}
