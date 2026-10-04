import test from 'node:test';
import assert from 'node:assert/strict';
import {eventRunDate} from './client.mjs';
test('event run date uses accepted run time, not snapshot refresh or verification',()=>{
  const at=Date.now(),submittedAt=at-3*86400000;
  assert.equal(eventRunDate({submittedAt,updatedAt:at,verifiedAt:at},at).label,'3 days ago');
  assert.equal(eventRunDate({updatedAt:at,verifiedAt:at},at).label,'Date unavailable');
  assert.equal(eventRunDate({submittedAt:at+1000},at).label,'Date unavailable');
});
