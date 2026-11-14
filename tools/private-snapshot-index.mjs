import fs from 'node:fs/promises';
import path from 'node:path';

// Private package metadata only. Payload, public wire and ordinary JSON caps do not change.
export const PRIVATE_SNAPSHOT_INDEX_BYTES = 20 * 1024 * 1024;
export async function readPrivateSnapshotIndex(file) {
  if (!path.isAbsolute(file || '') || path.basename(file) !== 'index.json') throw Error('Private snapshot index path required');
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > PRIVATE_SNAPSHOT_INDEX_BYTES) throw Error('Unsafe or oversized private snapshot index');
  const bytes = await fs.readFile(file), after = await fs.lstat(file);
  if (bytes.length !== before.size || bytes.length > PRIVATE_SNAPSHOT_INDEX_BYTES || !after.isFile() || after.isSymbolicLink() ||
      after.size !== before.size || after.ino !== before.ino || after.dev !== before.dev || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw Error('Private snapshot index changed while reading');
  return bytes;
}
