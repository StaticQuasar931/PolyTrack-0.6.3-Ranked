// Diagnostic estimates, not a billing meter: excludes index entries and Rules reads.
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
      audit.collections[key] = (audit.collections[key] || 0) + 1;
      audit.documentReadEstimate++;
    }
    return;
  } else if (path.startsWith('/') && (!init.method || init.method === 'GET')) {
    collection = decodeURIComponent(path.split('/')[1]);
    reads = 1;
  }
  if (reads) {
    audit.collections[collection] = (audit.collections[collection] || 0) + reads;
    audit.documentReadEstimate += reads;
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
  audit.writeEstimate ||= 0;
  audit.deleteEstimate ||= 0;
  for (const name of writeNames) {
    const collection = collectionForDocument(name);
    if (!collection) continue;
    audit.writeCollections[collection] ||= {writes: 0, deletes: 0};
    audit.writeCollections[collection].writes++;
    audit.writeEstimate++;
  }
  for (const name of deletes) {
    const collection = collectionForDocument(name);
    if (!collection) continue;
    audit.writeCollections[collection] ||= {writes: 0, deletes: 0};
    audit.writeCollections[collection].deletes++;
    audit.deleteEstimate++;
  }
}

function collectionForDocument(name) {
  const relative = String(name).split('/documents/')[1] || String(name).replace(/^\//, '');
  const parts = relative.split('/').filter(Boolean);
  if (parts.length < 2) return '';
  try { return decodeURIComponent(parts.at(-2)); }
  catch { return parts.at(-2); }
}
