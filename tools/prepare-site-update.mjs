import {readFile, writeFile} from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('site-version.json', root), 'utf8'));
const revision = process.argv[2] === undefined ? manifest.revision + 1 : Number(process.argv[2]);
if (!Number.isSafeInteger(revision) || revision <= manifest.revision) {
  throw new Error('The new site revision must be an integer greater than the published revision.');
}
const patchPath = new URL('polytrack_062_patch.js', root);
const indexPath = new URL('index.html', root);
let patch = await readFile(patchPath, 'utf8');
let index = await readFile(indexPath, 'utf8');
if (!patch.includes('installSiteUpdates({revision:') || !/polytrack_062_patch\.js\?v=\d+/.test(index)) {
  throw new Error('Release anchors are missing. No files were changed.');
}
patch = patch.replace(/installSiteUpdates\(\{revision:\d+/, `installSiteUpdates({revision:${revision}`)
  .replace(/(filter-(?:runtime|menu|groups)\.(?:mjs|css)|site-updates\.mjs)\?v=\d+/g, `$1?v=${revision}`);
index = index.replace(/polytrack_062_patch\.js\?v=\d+/, `polytrack_062_patch.js?v=${revision}`);
await writeFile(patchPath, patch);
await writeFile(indexPath, index);
await writeFile(new URL('site-version.json', root), JSON.stringify({revision}, null, 2) + '\n');
console.log(`Prepared website revision ${revision}. Review and commit these files together.`);
