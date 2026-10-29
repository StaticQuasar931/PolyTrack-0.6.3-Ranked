// Diagnostic estimates, not a billing meter: excludes index entries and Rules reads.
export function createFirestoreAudit() {
  return {operationAttempts:0, failedOperations:0, preTransportFailures:0,
    httpRequests:0, failedRequests:0, documentReadEstimate:0, collections:{},
    writeEstimate:0, deleteEstimate:0, writeCollections:{}, unknownReadRequests:0, unknownWriteRequests:0};
}

// A failed transport/response does not prove that the server did no billable work.
// Null is deliberately sticky: later successes cannot turn unknown cost into zero.
export function recordFirestoreFailure(audit, path, init = {}) {
  const method = String(init.method || 'GET').toUpperCase();
  if (path === ':runQuery' || path === ':batchGet' || path.startsWith('/') && method === 'GET') {
    audit.documentReadEstimate = null;
    audit.unknownReadRequests = (audit.unknownReadRequests || 0) + 1;
    try {
      const body = JSON.parse(init.body || '{}');
      const collections = path === ':runQuery' ? [body.structuredQuery?.from?.[0]?.collectionId || 'query'] :
        path === ':batchGet' ? (body.documents || []).map(collectionForDocument) : [collectionForDocument(path.split('?')[0])];
      for (const collection of collections) if (collection) audit.collections[collection] = null;
    } catch {}
  }
  if (path === ':commit' || method === 'PATCH' || method === 'DELETE') {
    let writes;
    try {
      writes = path === ':commit' ? JSON.parse(init.body || '{}').writes || [] :
        [method === 'DELETE' ? {delete:path} : {update:{name:path}}];
      if (!Array.isArray(writes)) throw Error('Invalid writes');
    } catch { writes = null; }
    if (writes?.length === 0) return;
    audit.unknownWriteRequests = (audit.unknownWriteRequests || 0) + 1;
    if (!writes) { audit.writeEstimate = null; audit.deleteEstimate = null; return; }
    audit.writeCollections ||= {};
    for (const write of writes) {
      const deleting = typeof write.delete === 'string';
      const collection = collectionForDocument(write.delete || write.update?.name || write.transform?.document || '');
      if (deleting) audit.deleteEstimate = null; else audit.writeEstimate = null;
      if (!collection) continue;
      audit.writeCollections[collection] ||= {writes:0, deletes:0};
      audit.writeCollections[collection][deleting ? 'deletes' : 'writes'] = null;
    }
  }
}

export function recordFirestoreReads(audit, path, init, payload) {
  recordFirestoreWrites(audit, path, init);
  let collection = '', reads = 0;
  if (path === ':runQuery') {
    const query = JSON.parse(init.body).structuredQuery;
    collection = query?.from?.[0]?.collectionId || 'query';
    reads = Math.max(1, (Array.isArray(payload) ? payload : []).filter(row => row.document).length);
  } else if (path === ':batchGet') {
    for (const name of JSON.parse(init.body).documents || []) {
      const key = name.split('/documents/')[1]?.split('/')[0] || 'batch';
      if (audit.collections[key] !== null) audit.collections[key] = (audit.collections[key] || 0) + 1;
      if (audit.documentReadEstimate !== null) audit.documentReadEstimate++;
    }
    return;
  } else if (path.startsWith('/') && (!init.method || init.method === 'GET')) {
    collection = decodeURIComponent(path.split('/')[1]);
    reads = 1;
  }
  if (reads) {
    if (audit.collections[collection] !== null) audit.collections[collection] = (audit.collections[collection] || 0) + reads;
    if (audit.documentReadEstimate !== null) audit.documentReadEstimate += reads;
  }
}

function recordFirestoreWrites(audit, path, init) {
  const method = String(init.method || 'GET').toUpperCase();
  let writeNames = [], deletes = [];
  if (path === ':commit') {
    let entries;
    try { entries = JSON.parse(init.body || '{}').writes || []; }
    catch { return; }
    if (!Array.isArray(entries)) return;
    for (const write of entries) {
      if (typeof write?.delete === 'string') deletes.push(write.delete);
      else {
        const name = write?.update?.name || write?.transform?.document;
        if (typeof name === 'string') writeNames.push(name);
      }
    }
  } else if (method === 'PATCH') writeNames = [path];
  else if (method === 'DELETE') deletes = [path];
  else return;

  if (!writeNames.length && !deletes.length) return;
  audit.writeCollections ||= {};
  if (audit.writeEstimate === undefined) audit.writeEstimate = 0;
  if (audit.deleteEstimate === undefined) audit.deleteEstimate = 0;
  for (const name of writeNames) {
    const collection = collectionForDocument(name);
    if (!collection) continue;
    audit.writeCollections[collection] ||= {writes: 0, deletes: 0};
    if (audit.writeCollections[collection].writes !== null) audit.writeCollections[collection].writes++;
    if (audit.writeEstimate !== null) audit.writeEstimate++;
  }
  for (const name of deletes) {
    const collection = collectionForDocument(name);
    if (!collection) continue;
    audit.writeCollections[collection] ||= {writes: 0, deletes: 0};
    if (audit.writeCollections[collection].deletes !== null) audit.writeCollections[collection].deletes++;
    if (audit.deleteEstimate !== null) audit.deleteEstimate++;
  }
}

function collectionForDocument(name) {
  const relative = String(name).split('/documents/')[1] || String(name).replace(/^\//, '');
  const parts = relative.split('/').filter(Boolean);
  if (parts.length < 2) return '';
  try { return decodeURIComponent(parts.at(-2)); }
  catch { return parts.at(-2); }
}
