import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeSnapshot, MAX_DECODED_BYTES, MAX_FILE_BYTES } from './snapshot-package.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_SOURCE = path.join(ROOT, 'public-snapshots1');
const DEFAULT_OUTPUT = 'C:/Users/Static/Documents/Codexstorage/PolyTrack-private-snapshots';

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeLogicalPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.startsWith('/') || /^[a-z]:/i.test(value)) {
    throw new Error(`Unsafe snapshot path: ${value}`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..') || !value.endsWith('.json')) {
    throw new Error(`Unsafe snapshot path: ${value}`);
  }
  return parts.join(path.sep);
}

function category(logicalPath) {
  const first = logicalPath.split('/')[0];
  if (first === 'canonical') return 'Canonical profile records';
  if (first === 'recordings') return 'Recordings';
  if (first === 'profiles') return 'Profiles';
  if (first === 'tracks') return 'Tracks';
  if (first === 'events') return 'Event boards';
  if (first === 'event-replays') return 'Event replays';
  if (first === 'archives') return 'Archives';
  return 'Snapshot summaries';
}

function brief(value) {
  if (Array.isArray(value)) return `Array with ${value.length} item${value.length === 1 ? '' : 's'}`;
  if (!value || typeof value !== 'object') return `${typeof value} value`;
  const keys = Object.keys(value);
  const count = Object.values(value).find(Array.isArray)?.length;
  const label = [value.nickname || value.name, value.label, value.trackName].filter(item => typeof item === 'string' && item.trim()).map(item => item.slice(0, 80)).join(' · ');
  return `${label ? label + ' | ' : ''}${keys.slice(0, 5).join(', ') || 'Empty object'}${keys.length > 5 ? ', ...' : ''}${count === undefined ? '' : `; ${count} listed items`}`;
}

export function viewerHtml(catalog, snapshot) {
  const embedded = JSON.stringify({ snapshot, catalog }).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026');
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PolyTrack private snapshot viewer</title>
<style>
:root{color-scheme:light;--ink:#172b32;--muted:#62777b;--paper:#f2f0e7;--card:#fffdf7;--line:#d7ded7;--accent:#a43d24;--teal:#16706c}*{box-sizing:border-box}body{margin:0;background:radial-gradient(ellipse at 90% 0,#e4d4b7 0,transparent 36%),var(--paper);color:var(--ink);font:16px/1.5 Georgia,serif}header{padding:34px clamp(18px,5vw,72px) 25px;border-bottom:1px solid var(--line)}h1{font-size:clamp(30px,5vw,58px);line-height:1;margin:4px 0 12px;letter-spacing:-.04em}p{margin:7px 0;color:var(--muted)}.eyebrow{font:700 11px/1.3 system-ui,sans-serif;letter-spacing:.16em;text-transform:uppercase;color:var(--accent)}main{max-width:1400px;margin:auto;padding:24px clamp(14px,4vw,52px)}.bar{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}.bar input,.bar select,.bar button{font:14px system-ui,sans-serif;padding:11px 13px;border:1px solid var(--line);border-radius:4px;background:var(--card);color:var(--ink)}#search{flex:1;min-width:190px}button{cursor:pointer}.note{font:13px/1.5 system-ui,sans-serif;background:#e1ebe5;padding:11px 14px;border-left:3px solid var(--teal);margin:14px 0}.layout{display:grid;grid-template-columns:minmax(250px,.75fr) minmax(0,1.5fr);gap:16px}.panel{background:var(--card);border:1px solid var(--line);padding:17px;min-width:0}.panel h2{font-size:20px;margin:0 0 12px}.groups{display:grid;gap:8px}.group{display:flex;justify-content:space-between;gap:8px;text-align:left;width:100%;font:14px system-ui,sans-serif;background:transparent;border:0;border-bottom:1px solid var(--line);padding:9px 2px;color:var(--ink)}.group[aria-pressed=true]{color:var(--accent);font-weight:700}.count{color:var(--muted);font-variant-numeric:tabular-nums}table{width:100%;border-collapse:collapse;font:13px/1.4 system-ui,sans-serif}th{text-align:left;color:var(--muted);font-size:11px;letter-spacing:.08em;text-transform:uppercase}td,th{padding:9px 7px;border-bottom:1px solid var(--line);vertical-align:top}td:first-child{overflow-wrap:anywhere}td button{padding:0;border:0;background:none;color:var(--teal);font:inherit;text-align:left;text-decoration:underline;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:60vh;overflow:auto;background:#f1f2eb;padding:14px;font:12px/1.5 ui-monospace,Consolas,monospace}.table-wrap{max-height:68vh;overflow:auto}#status{font:13px system-ui,sans-serif;color:var(--muted)}@media(max-width:760px){.layout{grid-template-columns:1fr}.table-wrap{max-height:none}header{padding-top:25px}}
</style>
<header><div class="eyebrow">Private local archive · offline</div><h1>PolyTrack snapshots</h1><p id="summary"></p></header>
<main><div class="note">This viewer makes no network requests. Use “Choose archive folder” and select the exported folder to enable record details. Names and JSON are displayed as text, never interpreted as HTML. The archive is unencrypted and should be treated as sensitive.</div>
<div class="bar"><input id="search" type="search" placeholder="Search logical paths and record summaries"><select id="filter"><option value="">All groups</option></select><label class="bar"><input id="folder" type="file" webkitdirectory multiple hidden><button type="button" id="choose">Choose archive folder</button></label></div><p id="status" role="status"></p>
<div class="layout"><section class="panel"><h2>Browse by group</h2><div class="groups" id="groups"></div></section><section class="panel"><h2>Snapshot records</h2><div class="table-wrap"><table><thead><tr><th>Logical file</th><th>Overview</th><th>Size</th><th>Details</th></tr></thead><tbody id="rows"></tbody></table></div><pre id="detail" hidden></pre></section></div></main>
<script>
'use strict';
const data=${embedded};
const groups=new Map();for(const item of data.catalog){groups.set(item.group,(groups.get(item.group)||0)+1)}
const $=id=>document.getElementById(id), filter=$('filter'), rows=$('rows');let selected='', loaded=new Map();
$('summary').textContent=data.catalog.length.toLocaleString()+' files · generation '+data.snapshot.generation+' · '+data.snapshot.totalBytes.toLocaleString()+' decoded bytes';
for(const [name,count] of groups){const option=document.createElement('option');option.value=name;option.textContent=name+' ('+count+')';filter.append(option);const button=document.createElement('button');button.className='group';button.type='button';button.setAttribute('aria-pressed','false');const label=document.createElement('span'), number=document.createElement('span');label.textContent=name;number.className='count';number.textContent=count.toLocaleString();button.append(label,number);button.addEventListener('click',()=>{selected=selected===name?'':name;filter.value=selected;render()});$('groups').append(button)}
function render(){rows.replaceChildren();const term=$('search').value.trim().toLocaleLowerCase();for(const item of data.catalog){if(selected&&item.group!==selected)continue;if(filter.value&&item.group!==filter.value)continue;if(term&&!(' '+item.path+' '+item.overview+' '+item.group).toLocaleLowerCase().includes(term))continue;const tr=document.createElement('tr');for(const value of [item.path,item.overview,item.bytes.toLocaleString()+' B']){const td=document.createElement('td');td.textContent=value;tr.append(td)}const td=document.createElement('td'),button=document.createElement('button');button.type='button';button.textContent='Open';button.addEventListener('click',()=>show(item));td.append(button);tr.append(td);rows.append(tr)}for(const button of $('groups').children)button.setAttribute('aria-pressed',String(button.firstChild.textContent===filter.value&&!!filter.value));}
async function show(item){$('detail').hidden=false;let text=loaded.get(item.path);if(!text){const file=loaded.get('__files')?.get(item.path);if(!file){$('status').textContent='Choose the exported folder to load full JSON details.';return}text=await file.text();loaded.set(item.path,text)}$('detail').textContent=item.path+'\\n\\n'+text}
$('choose').addEventListener('click',()=>$('folder').click());$('folder').addEventListener('change',event=>{const files=new Map();for(const file of event.target.files){const marker='/data/';const at=file.webkitRelativePath.indexOf(marker);if(at>=0)files.set(file.webkitRelativePath.slice(at+marker.length),file)}loaded.set('__files',files);$('status').textContent='Loaded '+files.size.toLocaleString()+' files for on-demand details.'});$('search').addEventListener('input',render);filter.addEventListener('change',()=>{selected=filter.value;render()});render();
</script></html>`;
}

export async function exportReadableSnapshot({ sourceDirectory = DEFAULT_SOURCE, outputDirectory = DEFAULT_OUTPUT } = {}) {
  const source = path.resolve(sourceDirectory);
  const output = path.resolve(outputDirectory);
  if (source === output || output.startsWith(`${source}${path.sep}`)) throw new Error('Output directory must be outside the encoded snapshot source');
  const indexPath = path.join(source, 'index.json');
  const indexBytes = await fs.readFile(indexPath);
  if (indexBytes.byteLength > MAX_FILE_BYTES) throw new RangeError('Snapshot index exceeds file limit');
  const index = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(indexBytes));
  if (index.schemaVersion !== 1 || index.encoding !== 'gzip-xor-a7-v1' || !index.files || typeof index.files !== 'object' || Array.isArray(index.files)) {
    throw new Error('Unsupported or invalid snapshot index');
  }
  try { await fs.access(output); throw new Error(`Output already exists: ${output}. Choose another path; the exporter will not overwrite it.`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }

  const records = [];
  const totalBytes = Object.values(index.files).reduce((sum, item) => sum + (Number(item?.decodedBytes) || 0), 0);
  for (const [logicalPath, item] of Object.entries(index.files)) {
    const relative = safeLogicalPath(logicalPath);
    if (!item || typeof item.path !== 'string' || path.basename(item.path) !== item.path || !/^[a-f0-9]{64}\.bin$/.test(item.path)) {
      throw new Error(`Unsafe payload entry for ${logicalPath}`);
    }
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || item.path !== `${item.sha256}.bin`) throw new Error(`Invalid payload hash metadata: ${logicalPath}`);
    if (!Number.isSafeInteger(item.decodedBytes) || item.decodedBytes < 0 || item.decodedBytes > MAX_DECODED_BYTES) throw new RangeError(`${logicalPath} exceeds decoded limit`);
    const encoded = await fs.readFile(path.join(source, item.path));
    if (encoded.byteLength > MAX_FILE_BYTES) throw new RangeError(`${item.path} exceeds encoded file limit`);
    if (sha256(encoded) !== item.sha256) throw new Error(`Payload hash mismatch: ${logicalPath}`);
    const decoded = Buffer.from(await decodeSnapshot(encoded));
    if (decoded.byteLength !== item.decodedBytes) throw new Error(`Decoded byte count mismatch: ${logicalPath}`);
    const jsonText = new TextDecoder('utf-8', { fatal: true }).decode(decoded);
    let value;
    try { value = JSON.parse(jsonText); } catch (error) { throw new Error(`Invalid JSON in ${logicalPath}`, { cause: error }); }
    records.push({ logicalPath, relative, decoded, group: category(logicalPath), overview: brief(value) });
  }

  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output, { recursive: false });
  try {
    for (const record of records) {
      const destination = path.join(output, 'data', record.relative);
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.writeFile(destination, record.decoded, { flag: 'wx' });
    }
    const catalog = records.map(({ logicalPath, decoded, group, overview }) => ({ path: logicalPath, bytes: decoded.byteLength, group, overview }));
    const manifest = { schemaVersion: 1, generation: index.generation, encoding: 'plain UTF-8 JSON; no encryption', sourceEncoding: index.encoding, fileCount: records.length, totalBytes, files: catalog };
    await fs.writeFile(path.join(output, 'index.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    await fs.writeFile(path.join(output, 'index.html'), viewerHtml(catalog, { generation: index.generation, totalBytes }), { flag: 'wx' });
    return { outputDirectory: output, fileCount: records.length, totalBytes, generation: index.generation };
  } catch (error) {
    throw new Error(`Export stopped after creating partial output at ${output}; inspect and remove that new folder before retrying. ${error.message}`, { cause: error });
  }
}

function parseArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--source' || args[i] === '--output') {
      if (!args[i + 1]) throw new Error(`Expected path after ${args[i]}`);
      options[args[i] === '--source' ? 'sourceDirectory' : 'outputDirectory'] = args[++i];
    } else throw new Error(`Unknown argument: ${args[i]}`);
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  exportReadableSnapshot(parseArgs(process.argv.slice(2))).then((result) => {
    console.log(`Exported ${result.fileCount} files (${result.totalBytes} decoded bytes), generation ${result.generation}.`);
    console.log(result.outputDirectory);
  }).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
