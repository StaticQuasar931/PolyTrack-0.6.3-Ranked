import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connect, decode} from './verifier/firestore.mjs';
import {assertOutputOutsideRepo} from './deployment-domains.mjs';

export async function mismatchCount(db) {
  const rows = await db.call(':runAggregationQuery', {structuredAggregationQuery: {
    structuredQuery: {from: [{collectionId: '0.6.2_s1_verification_audit'}],
      where: {fieldFilter: {field: {fieldPath: 'status'}, op: 'EQUAL', value: {stringValue: 'mismatch'}}}},
    aggregations: [{alias: 'mismatches', count: {}}]
  }});
  const field = rows?.[0]?.result?.aggregateFields?.mismatches;
  const count = field ? decode(field) : null;
  if (!Number.isSafeInteger(count) || count < 0) throw Error('Invalid mismatch aggregation response');
  return {checkedAt: new Date().toISOString(), auditMismatchRecords: count,
    meaning: 'Mismatch audit records, not proven cheaters or unique racers'};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4 || process.argv[2] !== '--out-dir') throw Error('Use --out-dir <private folder outside repository>');
  const directory = assertOutputOutsideRepo(process.argv[3]);
  const raw = process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT;
  if (!raw) throw Error('FIREBASE_VERIFIER_SERVICE_ACCOUNT is required');
  delete process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT;
  const report = await mismatchCount(await connect(raw));
  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, 'verification-count.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(directory, 'verification-count.html'), `<!doctype html><html lang="en"><meta charset="utf-8"><title>PolyTrack Verification Summary</title><style>body{font:20px/1.6 Georgia,serif;max-width:760px;margin:60px auto;padding:20px;color:#172739}strong{font-size:48px;color:#226b62}</style><h1>Verification Summary</h1><strong>${report.auditMismatchRecords}</strong><p>Mismatch audit records across the audit collection.</p><p>A mismatch is not automatic proof of cheating. Waiting and resource-limited runs are not included. This is a count of records, not unique players.</p><p>Checked: ${report.checkedAt}</p><p>One manual aggregate query; no replay or player records downloaded. Aggregation index reads can be billed. There is no automatic polling.</p></html>`);
  console.log(`Saved private verification summary in ${directory}`);
}
