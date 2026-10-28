import {readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseReleaseInfo} from './check-release-info.mjs';
import {parseReleasePreparedAt} from './release-info.mjs';

/** Explicit input makes retries byte-identical. Notes are owned by release finalization. */
export function prepareReleaseInfo(source, {number, revision, preparedAt}) {
  const info = parseReleaseInfo(source);
  if (!Number.isSafeInteger(number) || number < info.number || number > info.number + 1 ||
      !Number.isSafeInteger(revision) || revision < info.revision ||
      (number > info.number && revision <= info.revision)) throw new Error('Use the next release number and a higher client revision, or an identical retry.');
  if (parseReleasePreparedAt(preparedAt) === null) throw new Error('Provide the actual preparation instant as canonical UTC: YYYY-MM-DDTHH:mm:ss.sssZ.');
  if (number === info.number && (revision !== info.revision || preparedAt !== info.preparedAt)) throw new Error('An existing release preparation timestamp cannot be restamped.');
  if (info.preparedAt && number > info.number && parseReleasePreparedAt(preparedAt) <= parseReleasePreparedAt(info.preparedAt)) throw new Error('Preparation must be later than the previous release.');
  const next = {...info, number, revision, preparedAt};
  return source.replace(/const releaseInfo = (\{[\s\S]*?\});/, () => 'const releaseInfo = ' + JSON.stringify(next, null, 2) + ';');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [number, revision, preparedAt, ...extra] = process.argv.slice(2);
    if (extra.length || !/^\d+$/.test(number || '') || !/^\d+$/.test(revision || '') || !preparedAt) throw new Error('Usage: node tools/prepare-release-info.mjs RELEASE CLIENT_REVISION ACTUAL_PREPARATION_UTC');
    if (parseReleasePreparedAt(preparedAt) > Date.now()) throw new Error('Preparation time cannot be in the future.');
    const path = new URL('./release-info.mjs', import.meta.url);
    const source = readFileSync(path, 'utf8');
    const next = prepareReleaseInfo(source, {number:Number(number), revision:Number(revision), preparedAt});
    if (next !== source) writeFileSync(path, next);
    console.log(`Prepared release ${number}, client ${revision}. Notes preserved: finalize all release notes and run the precommit guard. This is not a Git publication timestamp.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
