import fs from 'node:fs';
import path from 'node:path';
import {connect} from './firestore.mjs';
import {createDiagnosticReport} from './diagnostics/report.mjs';
import {renderHtmlReport} from './diagnostics/html.mjs';

function option(name, fallback = null) {
  const prefix = `--${name}=`;
  const argument = process.argv.find(value => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function flag(name) { return process.argv.includes(`--${name}`); }

function duration(value) {
  const ms = Number(value);
  if (!Number.isSafeInteger(ms) || ms < 0) throw Error('Invalid --now');
  return ms;
}

function formatAge(ms) {
  if (ms === null || ms === undefined) return '-';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function textReport(report) {
  const lines = [
    'PolyTrack verifier diagnostics (bounded, private)',
    `Scope: ${report.scope.queueDocuments} queue documents, ${report.summary.runs} runs, dueOnly=${report.scope.dueOnly}, truncated=${report.scope.truncated}`,
    `Summary: ${report.summary.verified} verified, ${report.summary.waiting} waiting, ${report.summary.published} published, ${report.summary.missingTrustedTracks} missing/untrusted track observations`,
    `Latency: ${formatAge(report.summary.verificationLatencyMs.averageMs)} average, ${formatAge(report.summary.verificationLatencyMs.maxMs)} maximum`,
    `Waiting age: ${formatAge(report.summary.waitingAgeMs.averageMs)} average, ${formatAge(report.summary.waitingAgeMs.maxMs)} maximum`,
    `Scheduler: ${report.scheduler.status}${report.scheduler.finding ? ` (${report.scheduler.finding})` : ''}`,
    '',
    'Runs: accountId | trackId | status | reason | place | wait age | verification latency'
  ];
  for (const row of report.runs) lines.push(`${row.accountId} | ${row.trackId} | ${row.status} | ${row.reason || '-'} | ${row.place?.rank ?? '-'}${row.place?.fieldSize ? `/${row.place.fieldSize}` : ''} | ${formatAge(row.waitAgeMs)} | ${formatAge(row.verificationLatencyMs)}`);
  return lines.join('\n');
}

async function main() {
  const htmlPath = option('html');
  if (htmlPath !== null && (!htmlPath || htmlPath.includes('://'))) throw Error('Invalid --html path; only local file paths are supported.');
  const raw = process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT;
  if (!raw) throw Error('Set FIREBASE_VERIFIER_SERVICE_ACCOUNT for this private admin diagnostic.');
  delete process.env.FIREBASE_VERIFIER_SERVICE_ACCOUNT;
  const summaryPath = option('summary');
  if (summaryPath && fs.statSync(summaryPath).size > 1024 * 1024) throw Error('Summary file exceeds 1 MiB diagnostic bound.');
  const summary = summaryPath ? JSON.parse(fs.readFileSync(summaryPath, 'utf8')) : null;
  const lastRun = summary?.drain || summary;
  const report = await createDiagnosticReport(await connect(raw), {
    now: option('now') === null ? Date.now() : duration(option('now')),
    trackId: option('track-id'),
    trackLimit: option('track-limit') || undefined,
    runLimit: option('run-limit') || undefined,
    historyLimit: option('history-limit') || undefined,
    eventLimit: option('event-limit') || undefined,
    dueOnly: flag('due-only'),
    lastRun
  });
  if (htmlPath !== null) {
    const target = path.resolve(htmlPath);
    fs.writeFileSync(target, renderHtmlReport(report), {encoding: 'utf8'});
    if (!flag('json')) process.stdout.write(`Wrote private HTML report to ${target}\n`);
  }
  if (flag('json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  else if (htmlPath === null) process.stdout.write(textReport(report) + '\n');
}

if (process.argv[1] && process.argv[1].endsWith('diagnose.mjs')) {
  main().catch(error => { process.stderr.write(`diagnostic failed: ${String(error.message || error).replace(/[\r\n].*/s, '')}\n`); process.exitCode = 1; });
}
