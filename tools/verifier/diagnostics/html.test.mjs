import test from 'node:test';
import assert from 'node:assert/strict';
import {renderHtmlReport} from './html.mjs';

test('HTML report escapes malicious identifiers and remains self-contained', () => {
  const html = renderHtmlReport({
    generatedAt: '2026-09-20T12:00:00.000Z',
    scope: {queueDocuments: 1, auditRecordsRead: 1, eventRuns: 0, truncated: false},
    summary: {verified: 1, waiting: 0, published: 1, people: 1, tracks: 1,
      verificationLatencyMs: {averageMs: 2500}, waitingAgeMs: {averageMs: 0}},
    runs: [{kind: 'normal', accountId: '<img src=x onerror=alert(1)>', resultId: '" onclick="alert(2)',
      trackId: 'track', trackName: '</td><script>alert(3)</script>', status: 'verified', place: {rank: 1, fieldSize: 4},
      waitAgeMs: 4000, submittedAt: '2026-09-20T11:59:00.000Z', verifiedAt: '2026-09-20T12:00:00.000Z',
      verificationLatencyMs: 60000, replay: 'secret replay must not render', reason: 'private native detail'}]
  });
  assert.match(html, /id="search"/);
  assert.match(html, /addEventListener\('input'/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;\/td&gt;&lt;script&gt;alert\(3\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<img src=x|<\/td><script>|secret replay|private native detail/);
  assert.doesNotMatch(html, /<script src=|https?:\/\//);
  assert.match(html, /Wait duration/);
  assert.match(html, /#1\/4/);
});
