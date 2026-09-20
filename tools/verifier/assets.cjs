'use strict';

const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { LIMITS, sha256 } = require('./replay.cjs');

const HOOK = '5220:(e,t,n)=>{"use strict";';
const PAGE = '<!doctype html><html><head><meta charset="utf-8"></head><body><canvas id="screen"></canvas><div id="ui"></div><div id="transition-layer"></div><script src="/main.bundle.js"></script></body></html>';
const allowed = name => /^(?:\d+|main|simulation_worker)\.bundle\.js$/.test(name)
  || name === 'polytrack_physics.wasm'
  || /^forced_square\.(?:json|ttf|woff2?)$/.test(name)
  || /^(?:models|images|audio|tracks|lib)\/[A-Za-z0-9_./ -]+\.(?:glb|png|jpg|jpeg|svg|webp|ogg|mp3|track|js|wasm)$/.test(name);

function canonicalBytes(name, raw) {
  if (!/\.(?:js|json|svg|track)$/.test(name)) return raw;
  return Buffer.from(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw).replace(/\r\n?/g, '\n'), 'utf8');
}

function snapshot(root) {
  root = fs.realpathSync(root);
  const entries = [];
  function walk(relative = '', depth = 0) {
    if (depth > 8) throw Error('asset_directory_limit');
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory() && (relative || /^(models|images|audio|tracks|lib)$/.test(name))) walk(name, depth + 1);
      else if (allowed(name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw Error('non_regular_asset');
        entries.push(name);
        if (entries.length > LIMITS.assetFiles) throw Error('asset_file_limit');
      }
    }
  }
  walk();
  let total = 0;
  const files = new Map();
  for (const name of entries.sort()) {
    const absolute = fs.realpathSync(path.join(root, name));
    if (!absolute.startsWith(root + path.sep)) throw Error('unsafe_asset_path');
    const stat = fs.statSync(absolute);
    total += stat.size;
    if (stat.size > LIMITS.assetBytes || total > LIMITS.snapshotBytes) throw Error('asset_size_limit');
    const bytes = canonicalBytes(name, fs.readFileSync(absolute));
    if (bytes.length > LIMITS.assetBytes) throw Error('asset_size_limit');
    files.set(name, { bytes, hash: sha256(bytes) });
  }
  for (const required of ['main.bundle.js', 'simulation_worker.bundle.js', 'polytrack_physics.wasm', 'lib/polytrack_physics.js', 'models/car.glb', 'models/road.glb']) {
    if (!files.has(required)) throw Error('missing_engine_asset');
  }
  const manifest = Object.fromEntries([...files].filter(([name]) => !name.startsWith('tracks/')).map(([name, file]) => [name, file.hash]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  const engineFingerprint = sha256(JSON.stringify(manifest));
  const tracks = Object.fromEntries([...files].filter(([name]) => name.startsWith('tracks/')).map(([name, file]) => [name, file.hash]));
  const original = files.get('main.bundle.js').bytes.toString('utf8');
  if (original.split(HOOK).length !== 2) throw Error('module_5220_hook_missing_or_ambiguous');
  const hooked = original.replace(HOOK, HOOK + 'globalThis.__vrRequire=n;');
  // Hashed canonical bytes are exactly the served bytes, apart from this fixed exposure hook.
  return { files, manifest, tracks, engineFingerprint, hooked };
}

async function serve(snapshot) {
  const contentTypes = { '.js': 'application/javascript', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.json': 'application/json', '.woff2': 'font/woff2' };
  let origin;
  let requests = 0;
  const server = http.createServer((request, response) => {
    if (++requests > 10000) { response.writeHead(429).end(); return; }
    if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405).end(); return; }
    if (`http://${request.headers.host}` !== origin) { response.writeHead(403).end(); return; }
    let url;
    try { url = new URL(request.url, origin); } catch { response.writeHead(400).end(); return; }
    if (url.origin !== origin || url.search || url.hash || /%|\\|\.\./.test(request.url)) { response.writeHead(403).end(); return; }
    const name = url.pathname.slice(1);
    let bytes;
    if (name === '') bytes = Buffer.from(PAGE);
    else if (name === 'main.bundle.js') bytes = Buffer.from(snapshot.hooked);
    else bytes = snapshot.files.get(name)?.bytes;
    if (!bytes) { response.writeHead(404).end(); return; }
    response.writeHead(200, {
      'Content-Type': name === '' ? 'text/html' : contentTypes[path.extname(name)] || 'application/octet-stream',
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; media-src 'self' blob:; font-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.maxConnections = 64;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}

module.exports = { snapshot, serve, HOOK, canonicalBytes };
