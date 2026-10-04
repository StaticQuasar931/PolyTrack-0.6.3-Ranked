import test from 'node:test';
import assert from 'node:assert/strict';
import {recordFirestoreReads} from '../src/firestore-read-cost.js';
test('read diagnostics count documents, empty queries and batch misses, not HTTP calls or writes', () => {
  const audit={collections:{},documentReadEstimate:0};
  const query={body:JSON.stringify({structuredQuery:{from:[{collectionId:'boards'}]}})};
  recordFirestoreReads(audit,':runQuery',query,[{document:{}},{document:{}}]);
  recordFirestoreReads(audit,':runQuery',query,[]);
  recordFirestoreReads(audit,'/meta/current',{},null);
  recordFirestoreReads(audit,':batchGet',{body:JSON.stringify({documents:['projects/p/databases/(default)/documents/profiles/a','projects/p/databases/(default)/documents/profiles/b']})},[{found:{}},{missing:'b'}]);
  recordFirestoreReads(audit,':commit',{method:'POST'},{});
  assert.equal(audit.documentReadEstimate,6);
  assert.deepEqual(audit.collections,{boards:3,meta:1,profiles:2});
});
