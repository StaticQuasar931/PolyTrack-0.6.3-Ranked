import fs from 'node:fs/promises';
import path from 'node:path';

const LOGICAL_PATH = /^[A-Za-z0-9._/-]+\.json$/;
const demand = (value, message) => { if (!value) throw Error('Hydrated writer: ' + message); };

/** Called only after ALL payload hashes, decoded JSON and paging checks pass.
 * Buffers remain caller-owned and immutable until settlement. On I/O failure,
 * drain writers and leave partial staging for the caller, never prune it here.
 */
export async function writeHydratedFiles(stagingDirectory, hydrated) {
  const root = path.resolve(stagingDirectory);
  demand(Array.isArray(hydrated), 'validated entry array required');
  const names = new Map();
  const entries = hydrated.map(({logicalPath, decoded}) => {
    demand(typeof logicalPath === 'string' && LOGICAL_PATH.test(logicalPath) &&
      logicalPath !== 'export-progress.json' &&
      logicalPath.split('/').every(part => part && part !== '.' && part !== '..'), 'unsafe logical path');
    demand(Buffer.isBuffer(decoded), 'decoded Buffer required');
    const target = path.resolve(root, ...logicalPath.split('/'));
    demand(target.startsWith(root.endsWith(path.sep) ? root : root + path.sep), 'path escaped staging');
    const parts = logicalPath.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const name = parts.slice(0, i).join('/'), key = name.toLowerCase(), file = i === parts.length;
      const prior = names.get(key);
      demand(!prior || (!file && !prior.file && prior.name === name), 'duplicate or conflicting path');
      names.set(key, {name, file});
    }
    return {target, decoded};
  });

  // Cache both in-flight and completed directory promises. Ancestors are checked
  // once, not once per file; the caller must exclusively own this private tree.
  const directories = new Map();
  let mkdirCalls = 0;
  function ensureDirectory(directory) {
    if (!directories.has(directory)) directories.set(directory, (async () => {
      const parent = path.dirname(directory);
      if (parent !== directory) await ensureDirectory(parent);
      let stat;
      try { stat = await fs.lstat(directory); }
      catch (error) {
        if (error.code !== 'ENOENT') throw error;
        mkdirCalls++;
        try { await fs.mkdir(directory); }
        catch (created) { if (created.code !== 'EEXIST') throw created; }
        stat = await fs.lstat(directory);
      }
      demand(stat.isDirectory() && !stat.isSymbolicLink(), 'directory link or non-directory');
    })());
    return directories.get(directory);
  }
  await ensureDirectory(root);
  let next = 0, stopped = false, active = 0, maxActiveWrites = 0, written = 0;
  const workers = await Promise.allSettled(Array.from({length: Math.min(8, entries.length)}, async () => {
    try {
      while (!stopped && next < entries.length) {
        const {target, decoded} = entries[next++];
        await ensureDirectory(path.dirname(target));
        if (stopped) return;
        active++;
        maxActiveWrites = Math.max(maxActiveWrites, active);
        try { await fs.writeFile(target, decoded, {flag: 'wx'}); }
        finally { active--; }
        written++;
      }
    } catch (error) { stopped = true; throw error; }
  }));
  const failed = workers.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  return {files: written, maxActiveWrites, mkdirCalls};
}
