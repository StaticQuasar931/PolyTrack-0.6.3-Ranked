'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { snapshot } = require('./assets.cjs');

if (require.main === module) {
  if (process.argv.length !== 3) throw Error('Usage: node pin-engine.cjs TRUSTED_ASSET_ROOT');
  const engine = snapshot(process.argv[2]);
  const manifest = { schema: 2, source: 'Trusted worktree snapshot; no Git writes', normalization: 'UTF-8 .js/.json/.svg/.track: CRLF and CR to LF; other bytes unchanged', algorithm: 'sha256(JSON.stringify(files)); files sorted by ASCII path', engineDigest: engine.engineFingerprint, files: engine.manifest, tracks: engine.tracks };
  fs.writeFileSync(path.join(__dirname, 'engine-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ engineDigest: manifest.engineDigest, files: Object.keys(manifest.files).length, tracks: Object.keys(manifest.tracks).length }));
}
