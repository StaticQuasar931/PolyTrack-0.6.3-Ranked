import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { gzip, gunzip } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_DECODED_BYTES = 2 * 1024 * 1024;
export const SNAPSHOT_XOR_KEY = 0xa7;
export const SNAPSHOT_CODEC = Object.freeze({
  name: 'gzip-xor-a7-v1',
  version: 1,
  compression: 'gzip',
  xorByte: '0xA7',
  obfuscation: 'single-byte XOR; reversible and not encryption',
  security: 'non-security cosmetic obfuscation only',
});

function xorBytes(bytes) {
  const result = Buffer.from(bytes);
  for (let i = 0; i < result.length; i += 1) result[i] ^= SNAPSHOT_XOR_KEY;
  return result;
}

function jsonBytes(value) {
  const json = typeof value === 'string' ? value : JSON.stringify(value);
  if (json === undefined) throw new TypeError('Snapshot value must be JSON-serializable');
  return Buffer.from(json, 'utf8');
}

export async function encodeSnapshot(value) {
  const decoded = jsonBytes(value);
  if (decoded.byteLength > MAX_DECODED_BYTES) throw new RangeError(`Decoded snapshot exceeds ${MAX_DECODED_BYTES} bytes`);
  const encoded = xorBytes(await gzipAsync(decoded, { level: 9, mtime: 0 }));
  if (encoded.byteLength > MAX_FILE_BYTES) throw new RangeError(`Encoded snapshot exceeds ${MAX_FILE_BYTES} bytes`);
  return new Uint8Array(encoded);
}

export async function decodeSnapshot(encoded) {
  return new Uint8Array(await gunzipAsync(xorBytes(encoded), { maxOutputLength: MAX_DECODED_BYTES }));
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeRelativePath(value) {
  const normalized = value.split(path.sep).join('/');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`Unsafe snapshot path: ${value}`);
  }
  return normalized;
}

async function collectJsonFiles(directory) {
  const entries = [];
  async function walk(current, relative = '') {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const fullPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Snapshot staging cannot contain symlinks: ${nextRelative}`);
      if (entry.isDirectory()) await walk(fullPath, nextRelative);
      else if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'export-progress.json') {
        const logicalPath = safeRelativePath(nextRelative);
        const bytes = await fs.readFile(fullPath);
        if (bytes.byteLength > MAX_DECODED_BYTES) throw new RangeError(`${logicalPath} exceeds decoded limit (${MAX_DECODED_BYTES} bytes)`);
        try { JSON.parse(bytes.toString('utf8')); } catch (error) { throw new Error(`${logicalPath} is not valid JSON`, { cause: error }); }
        entries.push({ logicalPath, bytes });
      }
    }
  }
  await walk(directory);
  entries.sort((a, b) => a.logicalPath.localeCompare(b.logicalPath, 'en'));
  if (!entries.length) throw new Error('Staging directory contains no JSON snapshots');
  return entries;
}

async function readIndex(directory) {
  try {
    const bytes = await fs.readFile(path.join(directory, 'index.json'));
    if (bytes.byteLength > MAX_FILE_BYTES) return null;
    const index = JSON.parse(bytes.toString('utf8'));
  return index?.schemaVersion === 1 && index.files && typeof index.files === 'object' ? index : null;
  } catch { return null; }
}

async function matchesPublished(entries, index, directory) {
  if (index.encoding !== 'gzip-xor-a7-v1' || Object.keys(index.files).length !== entries.length) return false;
  for (const { logicalPath, bytes } of entries) {
    const item = index.files[logicalPath];
    if (!item || item.decodedBytes !== bytes.byteLength) return false;
    const expectedHash = sha256(xorBytes(await gzipAsync(bytes, { level: 9, mtime: 0 })));
    if (item.sha256 !== expectedHash || item.path !== `${expectedHash}.bin`) return false;
    try {
      const published = await fs.readFile(path.join(directory, item.path));
      if (sha256(published) !== item.sha256) return false;
    } catch { return false; }
  }
  return true;
}

async function archiveGeneration(sourceDirectory, historyDirectory, generation) {
  const indexBytes = await fs.readFile(path.join(sourceDirectory, 'index.json'));
  if (indexBytes.byteLength > MAX_FILE_BYTES) throw new RangeError('Published index exceeds file limit');
  const index = JSON.parse(indexBytes.toString('utf8'));
  const files = {};
  for (const [logicalPath, item] of Object.entries(index.files)) {
    const payloadName = path.basename(item.path);
    if (payloadName !== item.path || !payloadName.endsWith('.bin')) throw new Error('Published index contains an unsafe payload name');
    const bytes = await fs.readFile(path.join(sourceDirectory, payloadName));
    if (bytes.byteLength > MAX_FILE_BYTES) throw new RangeError(`${payloadName} exceeds file limit`);
    if (sha256(bytes) !== item.sha256) throw new Error(`Published payload hash mismatch: ${logicalPath}`);
    files[payloadName] = bytes.toString('base64');
  }
  const archive = await gzipAsync(Buffer.from(JSON.stringify({ schemaVersion: 1, generation, index, files }), 'utf8'), { level: 9, mtime: 0 });
  await fs.mkdir(historyDirectory, { recursive: true });
  const target = path.join(historyDirectory, `generation-${generation}.snapshot.gz`);
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, archive, { flag: 'wx' });
  await fs.rename(temporary, target);
  return target;
}

export async function restoreSnapshotArchive(archivePath, destinationDirectory) {
  const contents = JSON.parse((await gunzipAsync(await fs.readFile(archivePath))).toString('utf8'));
  if (contents.schemaVersion !== 1 || !contents.index?.files || typeof contents.index.files !== 'object') throw new Error('Invalid snapshot history archive');
  await fs.mkdir(destinationDirectory, { recursive: true });
  await fs.writeFile(path.join(destinationDirectory, 'index.json'), JSON.stringify(contents.index, null, 2));
  for (const item of Object.values(contents.index.files)) {
    const name = path.basename(item.path);
    if (name !== item.path || !Object.hasOwn(contents.files, name)) throw new Error('Invalid payload in snapshot history archive');
    const bytes = Buffer.from(contents.files[name], 'base64');
    if (bytes.byteLength > MAX_FILE_BYTES) throw new RangeError(`${name} exceeds file limit`);
    await fs.writeFile(path.join(destinationDirectory, name), bytes, { flag: 'wx' });
  }
  return contents.index;
}

export async function publishSnapshot({ root, stagingDirectory, historyDirectory = path.join(root, 'local-reports', 'snapshot-history') }) {
  if (!root || !stagingDirectory) throw new TypeError('root and stagingDirectory are required');
  const absoluteRoot = path.resolve(root);
  const entries = await collectJsonFiles(path.resolve(stagingDirectory));
  const contentDigest = sha256(Buffer.from(entries.map(({ logicalPath, bytes }) => `${logicalPath}\0${sha256(bytes)}`).join('\n')));
  const pointerPath = path.join(absoluteRoot, 'snapshot-current.json');
  let current = null;
  try { current = JSON.parse(await fs.readFile(pointerPath, 'utf8')); } catch {}
  const currentDirectory = typeof current?.currentdir === 'string' && /^public-snapshots[1-9]\d*$/.test(current.currentdir)
    ? current.currentdir
    : null;
  const currentIndex = currentDirectory ? await readIndex(path.join(absoluteRoot, currentDirectory)) : null;
  if (currentIndex && await matchesPublished(entries, currentIndex, path.join(absoluteRoot, currentDirectory))) {
    return { changed: false, generation: currentIndex.generation, directory: currentDirectory, contentDigest };
  }

  let maxGeneration = Number.isSafeInteger(current?.generation) ? current.generation : 0;
  for (const name of await fs.readdir(absoluteRoot).catch(() => [])) {
    const match = /^public-snapshots([1-9]\d*)$/.exec(name);
    if (match) maxGeneration = Math.max(maxGeneration, Number(match[1]));
  }
  const generation = maxGeneration + 1;
  const directoryName = `public-snapshots${generation}`;
  const finalDirectory = path.join(absoluteRoot, directoryName);
  const stagingPublish = path.join(absoluteRoot, `.${directoryName}.${process.pid}.tmp`);
  const files = {};
  try {
    await fs.mkdir(stagingPublish, { recursive: false });
    for (let i = 0; i < entries.length; i += 1) {
      const { logicalPath, bytes } = entries[i];
      const payload = `snapshot-${String(i + 1).padStart(4, '0')}.bin`;
      const encoded = xorBytes(await gzipAsync(bytes, { level: 9, mtime: 0 }));
      if (encoded.byteLength > MAX_FILE_BYTES) throw new RangeError(`${logicalPath} encoded file exceeds ${MAX_FILE_BYTES} bytes`);
      await fs.writeFile(path.join(stagingPublish, payload), encoded, { flag: 'wx' });
      const payloadHash = sha256(encoded);
      const payloadName = `${payloadHash}.bin`;
      await fs.rename(path.join(stagingPublish, payload), path.join(stagingPublish, payloadName));
      files[logicalPath] = { path: payloadName, sha256: payloadHash, decodedBytes: bytes.byteLength };
    }
    const index = { schemaVersion: 1, generation, encoding: 'gzip-xor-a7-v1', files };
    const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, 'utf8');
    if (indexBytes.byteLength > MAX_FILE_BYTES) throw new RangeError(`index.json exceeds ${MAX_FILE_BYTES} bytes`);
    await fs.writeFile(path.join(stagingPublish, 'index.json'), indexBytes, { flag: 'wx' });

    let archivePath = null;
    if (currentDirectory && currentIndex) {
      const previousPath = path.join(absoluteRoot, currentDirectory);
      archivePath = await archiveGeneration(previousPath, path.resolve(historyDirectory), currentIndex.generation);
    }
    await fs.rename(stagingPublish, finalDirectory);
    const pointer = Buffer.from(`${JSON.stringify({ currentdir: directoryName }, null, 2)}\n`, 'utf8');
    const pointerTemp = `${pointerPath}.${process.pid}.tmp`;
    await fs.writeFile(pointerTemp, pointer, { flag: 'wx' });
    await fs.rename(pointerTemp, pointerPath);
    return { changed: true, generation, directory: directoryName, contentDigest, archivePath };
  } catch (error) {
    await fs.rm(stagingPublish, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
