// Offline, read-only audit. Output is aggregate-only: no names or account IDs.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {decodeSnapshot} from './snapshot-package.mjs';
import {moderatePublicName} from '../workers/ranked/src/public-name-policy.js';

const NAME_KEYS = new Set(['name','nickname','displayName','username','publicName']);
export function collectPublicNames(value, names = new Map()) {
  if (!value || typeof value !== 'object') return names;
  for (const [key, item] of Object.entries(value)) {
    if (NAME_KEYS.has(key) && typeof item === 'string' &&
        (value.accountId || value.userId || key !== 'name')) {
      names.set(item, (names.get(item) || 0) + 1);
    }
    if (item && typeof item === 'object') collectPublicNames(item, names);
  }
  return names;
}

export function summarizePublicNames(names, moderate = moderatePublicName) {
  let nameFields = 0, blockedFields = 0, blockedDistinct = 0;
  const reasons = {};
  for (const [name, count] of names) {
    nameFields += count;
    const decision = moderate(name);
    if (decision.blocked) {
      blockedFields += count;
      blockedDistinct++;
      reasons[decision.reason] = (reasons[decision.reason] || 0) + 1;
    }
  }
  return {nameFields, distinctNames:names.size, blockedFields, blockedDistinct, reasons};
}

export async function auditPublicNames(directory) {
  const base = path.resolve(directory);
  const index = JSON.parse(await fs.readFile(path.join(base,'index.json'),'utf8'));
  if (index.encoding !== 'gzip-xor-a7-v1') throw Error('Unsupported snapshot encoding');
  const names = new Map();
  let files = 0;
  for (const record of Object.values(index.files)) {
    const target = path.resolve(base, record.path);
    const relative = path.relative(base,target);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Snapshot path escapes directory');
    const encoded = await fs.readFile(target);
    if (createHash('sha256').update(encoded).digest('hex') !== record.sha256) throw Error('Snapshot payload digest mismatch');
    collectPublicNames(JSON.parse(Buffer.from(await decodeSnapshot(encoded)).toString('utf8')),names);
    files++;
  }
  return {snapshot:path.basename(base), generation:index.generation, files, ...summarizePublicNames(names)};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('Usage: node tools/audit-public-names.mjs <saved-snapshot-directory> [...]');
  for (const directory of process.argv.slice(2)) console.log(JSON.stringify(await auditPublicNames(directory)));
}
