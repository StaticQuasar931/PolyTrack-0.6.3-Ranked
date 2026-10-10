import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {connect, decode} from './verifier/firestore.mjs';

export const RACE_RESULTS_COLLECTION = '0.6.2_race_results';
export const MAX_LIMIT = 1000;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function assertOutputOutsideRepo(outputDir, repoRoot = REPO_ROOT) {
  const target = path.resolve(outputDir);
  const repo = path.resolve(repoRoot);
  const isInside = (base, candidate) => {
    const relative = path.relative(base, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  let ancestor = target;
  const suffix = [];
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    suffix.unshift(path.basename(ancestor));
    ancestor = parent;
  }
  const physicalTarget = path.resolve(fs.realpathSync(ancestor), ...suffix);
  const insideRepo = isInside(repo, target) || isInside(fs.realpathSync(repo), physicalTarget);
  if (insideRepo) throw Error('Report output must be outside the repository.');
  return target;
}

export function parseLimit(value) {
  if (value === undefined || value === null || !/^\d+$/.test(String(value))) throw Error('An explicit integer --limit from 1 to 1000 is required.');
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw Error('An explicit integer --limit from 1 to 1000 is required.');
  return limit;
}

export function queryForLimit(limit) {
  return {
    structuredQuery: {
      from: [{collectionId: RACE_RESULTS_COLLECTION}],
      select: {fields: [{fieldPath: 'source'}]},
      limit: parseLimit(limit)
    }
  };
}

export function sourceHostname(source) {
  if (typeof source !== 'string' || !source || source.trim() !== source) return 'unknown';
  try {
    const url = new URL(source);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) return 'unknown';
    if (url.origin !== source || url.pathname !== '/' || url.search || url.hash) return 'unknown';
    return url.hostname.toLowerCase();
  } catch {
    return 'unknown';
  }
}

export function aggregateSources(rows, limit) {
  const safeLimit = parseLimit(limit);
  if (!Array.isArray(rows) || rows.length > safeLimit) throw Error('Query returned more documents than its requested limit.');
  const counts = new Map();
  for (const row of rows) {
    const hostname = sourceHostname(row?.source);
    counts.set(hostname, (counts.get(hostname) || 0) + 1);
  }
  const domains = [...counts].map(([hostname, documents]) => ({hostname, documents}))
    .sort((a, b) => a.hostname.localeCompare(b.hostname));
  return {
    title: 'PolyTrack deployment-domain report',
    metric: 'latest-retained-personal-best-documents',
    scannedDocuments: rows.length,
    requestedLimit: safeLimit,
    mayBeTruncated: rows.length === safeLimit,
    domains
  };
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
}

export function renderHtml(report) {
  const entries = report.domains.map(({hostname, documents}) => `<tr><td>${escapeHtml(hostname)}</td><td>${documents}</td></tr>`).join('');
  const truncation = report.mayBeTruncated ? '<p class="notice">The requested limit was reached. This sample may be incomplete.</p>' : '';
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(report.title)}</title>
<style>body{font:16px system-ui,sans-serif;max-width:760px;margin:3rem auto;padding:0 1rem;color:#18212b}h1{font-size:1.6rem}table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:.55rem;border-bottom:1px solid #ccd3da}.notice{padding:.8rem;background:#fff0c2}small{color:#52606d}</style>
<h1>${escapeHtml(report.title)}</h1><p>Counted ${report.scannedDocuments} canonical PB documents from a bounded query (limit ${report.requestedLimit}).</p>${truncation}
<table><thead><tr><th>Deployment hostname</th><th>Retained PB documents</th></tr></thead><tbody>${entries}</tbody></table>
<p><small>One document per player and track is retained. This is not a count of visits or all submitted runs. Missing or unsupported source values are grouped as unknown.</small></p></html>`;
}

function parseArgs(args) {
  let limitValue;
  let outputDir;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--limit') limitValue = args[++index];
    else if (arg.startsWith('--limit=')) limitValue = arg.slice('--limit='.length);
    else if (arg === '--out-dir') outputDir = args[++index];
    else if (arg.startsWith('--out-dir=')) outputDir = arg.slice('--out-dir='.length);
    else throw Error(`Unknown argument: ${arg}`);
  }
  if (limitValue === undefined) throw Error('An explicit --limit is required.');
  return {limit: parseLimit(limitValue), outputDir};
}

export async function runReport({db, limit, outputDir, repoRoot = REPO_ROOT}) {
  const safeLimit = parseLimit(limit);
  const directory = assertOutputOutsideRepo(outputDir, repoRoot);
  const result = await db.call(':runQuery', queryForLimit(safeLimit));
  if (!Array.isArray(result)) throw Error('Invalid Firestore query response.');
  const rows = result.filter(item => item?.document).map(item => {
    const fields = decode({mapValue: {fields: item.document.fields || {}}});
    return {source: fields.source};
  });
  const report = aggregateSources(rows, safeLimit);
  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, 'deployment-domains.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(directory, 'deployment-domains.html'), renderHtml(report), 'utf8');
  return {report, directory};
}

async function main() {
  const {limit, outputDir} = parseArgs(process.argv.slice(2));
  const targetDir = assertOutputOutsideRepo(outputDir || path.join(REPO_ROOT, '..', 'recovery-reports'));
  const raw = process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT;
  if (!raw) throw Error('Set FIREBASE_VERIFIER_SERVICE_ACCOUNT for this private admin report.');
  delete process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT;
  const {report, directory} = await runReport({db: await connect(raw), limit, outputDir: targetDir});
  process.stdout.write(`Wrote private deployment-domain HTML and JSON reports to ${directory}${report.mayBeTruncated ? ' (sample may be incomplete at the requested limit)' : ''}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`deployment-domain report failed: ${String(error.message || error).replace(/[\r\n].*/s, '')}\n`);
    process.exitCode = 1;
  });
}
