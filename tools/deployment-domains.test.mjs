import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {aggregateSources, assertOutputOutsideRepo, parseLimit, queryForLimit, renderHtml, runReport, sourceHostname} from './deployment-domains.mjs';

test('actual patch helper stores only a safe HTTP(S) origin or unknown', () => {
  const source = fs.readFileSync(new URL('../polytrack_062_patch.js', import.meta.url), 'utf8');
  const helper = source.match(/function deploymentSourceOrigin\(\)\{[\s\S]*?\n  \}/)?.[0];
  assert.ok(helper, 'helper should exist in the actual client patch');
  const invoke = origin => vm.runInNewContext(`${helper}\ndeploymentSourceOrigin()`, {
    window: {location: {origin}},
    URL
  });
  assert.equal(invoke('https://user:secret@play.example:8443/race?token=private#part'), 'https://play.example:8443');
  assert.equal(invoke('https://play.example/path?q=private'), 'https://play.example');
  assert.equal(invoke('javascript:alert(1)'), 'unknown');
  assert.equal(invoke('null'), 'unknown');
});

test('groups canonical origin strings by hostname and leaves old endpoint URLs unknown', () => {
  const report = aggregateSources([
    {source: 'https://play.example:8443'},
    {source: 'https://play.example'},
    {source: 'https://api.example/v1/leaderboards?token=secret'},
    {source: undefined},
    {source: 'not a URL'}
  ], 10);
  assert.deepEqual(report.domains, [
    {hostname: 'play.example', documents: 2},
    {hostname: 'unknown', documents: 3}
  ]);
  assert.equal(report.metric, 'latest-retained-personal-best-documents');
  assert.equal(report.mayBeTruncated, false);
});

test('rejects limits missing, malformed, zero, and above the hard cap', () => {
  for (const value of [undefined, '', '1.5', '0', '1001', '-1']) assert.throws(() => parseLimit(value));
  assert.equal(parseLimit('1000'), 1000);
  assert.equal(queryForLimit(12).structuredQuery.limit, 12);
  assert.deepEqual(queryForLimit(12).structuredQuery.select.fields, [{fieldPath: 'source'}]);
});

test('marks a full bounded sample as potentially truncated', () => {
  assert.equal(aggregateSources([{source: 'https://play.example'}], 1).mayBeTruncated, true);
});

test('malicious and path-bearing source values do not become HTML or source hostnames', () => {
  const malicious = '<img src=x onerror=alert(1)>';
  assert.equal(sourceHostname(malicious), 'unknown');
  assert.equal(sourceHostname('https://trusted.example/path'), 'unknown');
  const html = renderHtml(aggregateSources([{source: malicious}], 5));
  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /<td>unknown<\/td>/);
  const escaped = renderHtml({title: 'report', scannedDocuments: 1, requestedLimit: 5, mayBeTruncated: false,
    domains: [{hostname: malicious, documents: 1}]});
  assert.doesNotMatch(escaped, /<img src=x/);
  assert.match(escaped, /&lt;img src=x onerror=alert\(1\)&gt;/);
});

test('report query is one bounded projected call and writes only the aggregate', async () => {
  let query;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'polytrack-domain-report-test-'));
  const reportDir = path.join(out, 'report');
  const db = {call: async (path, body) => {
    assert.equal(path, ':runQuery');
    query = body;
    return [{document: {fields: {source: {stringValue: 'https://play.example'}}}}];
  }};
  const result = await runReport({db, limit: 7, outputDir: reportDir});
  assert.equal(query.structuredQuery.limit, 7);
  assert.deepEqual(query.structuredQuery.select.fields, [{fieldPath: 'source'}]);
  assert.deepEqual(result.report.domains, [{hostname: 'play.example', documents: 1}]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(reportDir, 'deployment-domains.json'), 'utf8')).scannedDocuments, 1);
  assert.match(fs.readFileSync(path.join(reportDir, 'deployment-domains.html'), 'utf8'), /Retained PB documents/);
  fs.rmSync(out, {recursive: true, force: true});
});

test('runReport rejects repository output before making a query', async () => {
  let queried = false;
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'polytrack-report-repo-'));
  assert.throws(() => assertOutputOutsideRepo(path.join(repoRoot, 'reports'), repoRoot), /outside the repository/);
  await assert.rejects(runReport({db: {call: async () => { queried = true; return []; }}, limit: 2,
    outputDir: path.join(repoRoot, 'reports'), repoRoot}), /outside the repository/);
  assert.equal(queried, false);
  fs.rmSync(repoRoot, {recursive: true, force: true});
});
