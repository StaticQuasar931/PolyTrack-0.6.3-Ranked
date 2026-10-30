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

// One actual transport call only, never a pre-transport attempt. This returns no
// references to inputs and intentionally excludes paths, bodies and error text.
export function describeFirestoreOperation({path, init = {}, method = init?.method || 'GET', payload, failed = false} = {}) {
  const audit = createFirestoreAudit();
  // Collection names such as __proto__ must behave as data in the old counters.
  audit.collections = Object.create(null);
  audit.writeCollections = Object.create(null);
  const verb = typeof method === 'string' ? method.toUpperCase() : '';
  const cleanPath = typeof path === 'string' ? path.split(/[?#]/)[0] : '';
  const action = cleanPath.match(/:(runQuery|batchGet|commit)$/)?.[1];
  const operationKind = action || ({GET:'get', PATCH:'patch', DELETE:'delete'}[verb]) || 'unknown';
  let requestedDocumentCount = null, returnedDocumentCount = null, minimumEmptyQuery = null;
  let valid = operationKind !== 'unknown', safePath = '', body, safeBody;
  try {
    if (action) {
      body = JSON.parse(init?.body || '{}');
      safePath = ':' + action;
      if (action === 'runQuery') {
        const from = body.structuredQuery?.from;
        if (!Array.isArray(from) || from.length !== 1) throw Error();
        body = {structuredQuery:{from:[{collectionId:auditCollectionName(from[0]?.collectionId)}]}};
        safeBody = body;
        if (!failed) {
          if (!Array.isArray(payload) || payload.some(row => !row || typeof row !== 'object' || row.error)) throw Error();
          returnedDocumentCount = payload.filter(row => row.document).length;
          minimumEmptyQuery = returnedDocumentCount === 0;
        }
      } else if (action === 'batchGet') {
        if (!Array.isArray(body.documents)) throw Error();
        body = {documents:body.documents.map(auditDocumentName)};
        safeBody = body;
        requestedDocumentCount = body.documents.length;
        if (!failed) {
          if (!Array.isArray(payload) || payload.some(row => !row || (!row.found && !row.missing) || row.error)) throw Error();
          if (payload.length !== requestedDocumentCount) throw Error();
          returnedDocumentCount = payload.filter(row => row.found).length;
        }
      } else {
        if (!Array.isArray(body.writes)) throw Error();
        body = {writes:body.writes.map(write => {
          if (typeof write?.delete === 'string') return {delete:auditDocumentName(write.delete)};
          if (typeof write?.update?.name === 'string') return {update:{name:auditDocumentName(write.update.name)}};
          if (typeof write?.transform?.document === 'string') return {transform:{document:auditDocumentName(write.transform.document)}};
          throw Error();
        })};
      }
    } else if (valid) {
      safePath = '/' + auditDocumentName(cleanPath).split('/documents/')[1];
      requestedDocumentCount = verb === 'GET' ? 1 : null;
      returnedDocumentCount = !failed && verb === 'GET' ? (payload == null ? 0 : 1) : null;
    }
    const safeInit = {method:verb, ...(body ? {body:JSON.stringify(body)} : {})};
    if (failed) recordFirestoreFailure(audit, safePath, safeInit);
    else recordFirestoreReads(audit, safePath, safeInit,
      action === 'runQuery' ? Array.from({length:returnedDocumentCount}, () => ({document:{}})) : null);
  } catch {
    valid = false;
    requestedDocumentCount = returnedDocumentCount = minimumEmptyQuery = null;
  }
  if (!valid) {
    // Unparseable operations cannot safely be called free. Keep unrelated costs
    // at zero when the operation type still tells us which dimension is unknown.
    const reads = ['get','runQuery','batchGet','unknown'].includes(operationKind);
    const writes = ['patch','commit','unknown'].includes(operationKind);
    const deletes = ['delete','commit','unknown'].includes(operationKind);
    audit.documentReadEstimate = reads ? null : 0;
    audit.writeEstimate = writes ? null : 0;
    audit.deleteEstimate = deletes ? null : 0;
    audit.unknownReadRequests = reads ? 1 : 0;
    audit.unknownWriteRequests = writes || deletes ? 1 : 0;
    audit.collections = Object.create(null);
    audit.writeCollections = Object.create(null);
    // A malformed response still has a known target when its request was valid.
    if (safePath && safeBody && ['runQuery','batchGet'].includes(action)) {
      try { recordFirestoreFailure(audit, safePath, {method:verb, body:JSON.stringify(safeBody)}); } catch {}
      audit.unknownReadRequests = 1;
    }
  }
  return {schemaVersion:1, operationKind, outcome:failed || !valid ? 'unknown' : 'success', failed:Boolean(failed),
    requestedDocumentCount, returnedDocumentCount, minimumEmptyQuery,
    documentReadEstimate:audit.documentReadEstimate, collections:{...audit.collections},
    writeEstimate:audit.writeEstimate, deleteEstimate:audit.deleteEstimate, writeCollections:{...audit.writeCollections},
    unknownReadRequests:audit.unknownReadRequests, unknownWriteRequests:audit.unknownWriteRequests,
    billingEstimateOnly:true};
}

function auditCollectionName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,128}$/.test(value)) throw Error();
  return value;
}

function auditDocumentName(value) {
  if (typeof value !== 'string') throw Error();
  const relative = value.split('/documents/')[1] ?? value.replace(/^\//, '');
  const parts = relative.split('/');
  if (parts.length < 2 || parts.length % 2 || parts.some(part => !part)) throw Error();
  const collection = auditCollectionName(decodeURIComponent(parts.at(-2)));
  return 'projects/_/databases/_/documents/' + collection + '/_';
}
