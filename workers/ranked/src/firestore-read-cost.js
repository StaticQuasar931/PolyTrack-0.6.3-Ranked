// Diagnostic estimates, not a billing meter: excludes index entries and Rules reads.
export function recordFirestoreReads(audit, path, init, payload) {
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
