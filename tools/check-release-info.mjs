import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {parseReleasePreparedAt} from './release-info.mjs';

const botTitles = new Set(['Sync public ranked snapshots', 'Sync Kodub weekly fallback']);
export function isCaptureCommit(commit) {
  return commit.name === 'github-actions[bot]' &&
    commit.email === '41898282+github-actions[bot]@users.noreply.github.com' && botTitles.has(commit.title);
}
export function manualReleaseNumber(title) {
  const match = /^(\d+)\s*[-:]\s*\S/.exec(title || '');
  return match ? Number(match[1]) : null;
}
export function parseReleaseInfo(source) {
  const match = /const releaseInfo = (\{[\s\S]*?\});/.exec(source);
  if (!match) throw new Error('Missing central release-info record');
  return JSON.parse(match[1]);
}
export function validateReleaseInfo(info, {manual, previousInfo, expectedNext, revision, now = Date.now()} = {}) {
  const errors = [];
  if (!Number.isSafeInteger(info?.number) || info.number < 1) errors.push('Missing positive manual release number.');
  if (!Number.isSafeInteger(info?.revision) || info.revision < 1) errors.push('Missing positive client revision.');
  if (typeof info?.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(info.version)) errors.push('Missing game version.');
  if (!Array.isArray(info?.notes) || !info.notes.length || info.notes.some(note => typeof note !== 'string' || !note.trim() || /\b(?:TODO|TBD|placeholder)\b/i.test(note))) errors.push('Release notes must be nonempty, finished plain text.');
  if (info?.commit !== undefined || info?.commitConfirmed !== undefined) errors.push('Do not store a prospective or fabricated commit hash in release info.');
  const prepared = parseReleasePreparedAt(info?.preparedAt);
  if ((info?.number >= 225 || info?.preparedAt !== undefined) && prepared === null) errors.push('Record the actual release preparation timestamp in canonical UTC with prepare-release-info.mjs.');
  if (prepared !== null && prepared > now) errors.push('Release preparation timestamp cannot be in the future.');
  const previousPrepared = parseReleasePreparedAt(previousInfo?.preparedAt);
  if (prepared !== null && previousPrepared !== null && prepared <= previousPrepared) errors.push('Each manual release needs a later preparation timestamp; never reuse a previous release date.');
  const latest = manualReleaseNumber(manual?.title);
  if (latest === null) errors.push('Latest non-capture commit needs a numbered manual Git title, such as 224-Help and Release Safety.');
  if (expectedNext !== undefined) {
    if (!Number.isSafeInteger(expectedNext) || expectedNext !== latest + 1) errors.push('Precommit release must be the next numbered manual release.');
    if (info?.number !== expectedNext) errors.push('Central notes do not match the expected next manual release.');
  } else if (info?.number !== latest) errors.push('Central notes are stale or ahead of the latest numbered manual Git title.');
  if (previousInfo && JSON.stringify(info?.notes) === JSON.stringify(previousInfo.notes)) errors.push('Update Help notes for every manual commit; changing only the number is not enough.');
  if (revision !== undefined && info?.revision !== revision) errors.push('Central client revision does not match site-version.json.');
  return errors;
}
export function checkReleaseInfo({root = fileURLToPath(new URL('../', import.meta.url)), expectedNext, read = file => readFileSync(resolve(root, file), 'utf8'), runGit} = {}) {
  const git = runGit || ((...args) => {
    const result = spawnSync('git', args, {cwd:root, encoding:'utf8', maxBuffer:16 * 1024 * 1024});
    if (result.status !== 0) throw new Error('Local Git check failed: ' + args.join(' '));
    return result.stdout;
  });
  // No limit: a long run of capture commits must not hide the last manual release.
  const commits = git('log', '--format=%H%x00%an%x00%ae%x00%s').trim().split('\n').filter(Boolean).map(line => {
    const [hash,name,email,title] = line.split('\0'); return {hash,name,email,title};
  }).filter(commit => !isCaptureCommit(commit));
  const manual = commits[0];
  if (!manual) throw new Error('No manual release commit found.');
  const previous = expectedNext === undefined ? commits[1] : manual;
  let previousInfo;
  if (previous && git('ls-tree', '--name-only', previous.hash, '--', 'tools/release-info.mjs').trim()) previousInfo = parseReleaseInfo(git('show', previous.hash + ':tools/release-info.mjs'));
  const info = parseReleaseInfo(read('tools/release-info.mjs'));
  const manifest = JSON.parse(read('site-version.json'));
  const errors = validateReleaseInfo(info, {manual,previousInfo,expectedNext,revision:manifest.revision});
  const patch = read('polytrack_062_patch.js');
  if (!patch.includes('release-info.mjs') || !/release:\s*(?:\{\s*\.\.\.\s*)?(?:\w+\.)?RELEASE_INFO\b/.test(patch)) errors.push('Help must receive the central RELEASE_INFO record, not inline notes.');
  const metadataImports = [...patch.matchAll(/release-info\.mjs\?v=(\d+)/g)];
  if (!metadataImports.length || metadataImports.some(match => Number(match[1]) !== info.revision)) errors.push('Central release-info import cache key must match the client revision.');
  if (Number(/installSiteUpdates\(\{\s*revision:\s*(\d+)/.exec(patch)?.[1]) !== info.revision) errors.push('Loaded client revision is not stamped to the central revision.');
  const index = read('index.html');
  if (!index.includes('polytrack_062_patch.js?v=' + info.revision + '"') && !index.includes("polytrack_062_patch.js?v=" + info.revision + "'")) errors.push('Entry point cache revision does not match central client revision.');
  if (expectedNext === undefined && (!git('ls-tree', '--name-only', 'HEAD', '--', 'tools/release-info.mjs').trim() || git('diff', '--name-only', 'HEAD', '--', 'tools/release-info.mjs', 'polytrack_062_patch.js', 'index.html', 'site-version.json').trim())) errors.push('Commit the checked release metadata and stamped entry files before the pre-push check.');
  return {info,manual,errors};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length && !(args.length === 2 && args[0] === '--precommit' && /^\d+$/.test(args[1]))) throw new Error('Usage: node tools/check-release-info.mjs [--precommit 224]');
    const result = checkReleaseInfo({expectedNext:args.length ? Number(args[1]) : undefined});
    for (const error of result.errors) console.error(error);
    if (result.errors.length) process.exitCode = 1;
    else console.log(`Help release ${result.info.number}, client revision ${result.info.revision}: local release safety passed.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
